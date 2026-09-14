//! 站点 webview 的生命周期：创建、摆位、休眠、回收。
//!
//! 对应 Electron 版 main.js 里的 ensureView / layout / hibernate 那一套。
//!
//! ## 两条必须守住的纪律
//!
//! 1. **不要握着锁调 `add_child`。**
//!    `Window::add_child` 内部是 `run_on_main_thread` + channel 阻塞等结果。
//!    如果此时主线程正卡在我们这把 Mutex 上，就是一个死锁。
//!    所以所有函数都遵循「先把需要的数据从锁里拷出来 → drop guard → 再碰窗口」。
//!
//! 2. **webview 是 unstable 特性。**
//!    多 webview 挂在 `tauri = { features = ["unstable"] }` 后面，Tauri 小版本升级
//!    可能改 API。升级前先跑 `cargo test` 和真机分屏拖拽。

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window, Wry};

use crate::config::{partition_dir, Config};
use crate::layout::{compute_grid, GridShape, Geometry, MIN_SANE_HEIGHT, MIN_SANE_WIDTH};

pub const SHELL_LABEL: &str = "shell";
pub const MAIN_WINDOW: &str = "main";

/// 站点 webview 的 label 加前缀，免得和外壳的 "shell" 撞车，
/// 也免得用户自建服务取个叫 "main" 的 id 把窗口 label 顶掉。
pub fn view_label(id: &str) -> String {
    format!("svc-{id}")
}

#[derive(Default)]
pub struct ViewManager {
    /// 当前活着的站点 webview。休眠掉的会从这里移除。
    live: HashSet<String>,
    /// 上次活跃时间，休眠扫描用。
    last_active: HashMap<String, Instant>,
    /// 已经被休眠的（UI 上要打休眠标记）。
    hibernated: HashSet<String>,
    /// 设置面板打开时，所有站点视图让位给外壳。
    pub overlay_open: bool,
    pub last_geometry: Option<Geometry>,
}

impl ViewManager {
    pub fn touch(&mut self, id: &str) {
        self.last_active.insert(id.to_string(), Instant::now());
        self.hibernated.remove(id);
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.live.contains(id)
    }

    pub fn is_hibernated(&self, id: &str) -> bool {
        self.hibernated.contains(id)
    }

    /// 登记一个刚建出来的视图（execute_plan 之后由调用方补登记）。
    pub fn register(&mut self, id: &str) {
        self.live.insert(id.to_string());
        self.hibernated.remove(id);
    }

    pub fn forget(&mut self, id: &str) {
        self.live.remove(id);
        self.last_active.remove(id);
        self.hibernated.remove(id);
    }

    /// 闲置超过 limit_minutes 且不在当前布局里的服务 id。
    /// 看得见的那几栏永远算活跃——不该在用户眼前被回收。
    pub fn idle_candidates(&self, visible: &[String], limit_minutes: u32) -> Vec<String> {
        let limit = std::time::Duration::from_secs(limit_minutes as u64 * 60);
        let now = Instant::now();
        self.live
            .iter()
            .filter(|id| !visible.contains(id))
            .filter(|id| {
                self.last_active
                    .get(*id)
                    .map(|t| now.duration_since(*t) >= limit)
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }
}

/// 站点 webview 的起始地址：优先用上次停留的页面，否则回到站点首页。
fn start_url(config: &Config, id: &str) -> String {
    config
        .last_urls
        .get(id)
        .filter(|u| u.starts_with("http"))
        .cloned()
        .unwrap_or_else(|| {
            config.get_service(id).map(|s| s.url.clone()).unwrap_or_default()
        })
}

/// 建一个站点 webview。
///
/// 调用方必须已经放开配置锁（见模块头的纪律 1）。
pub fn create_view(
    window: &Window,
    id: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> tauri::Result<Webview<Wry>> {
    let parsed: tauri::Url = url.parse().map_err(|_| {
        tauri::Error::WebviewNotFound
    })?;

    let app = window.app_handle().clone();
    let builder = WebviewBuilder::new(view_label(id), WebviewUrl::External(parsed))
        // 每个站点一个独立的 WebView2 用户数据目录 —— 这就是 Electron 版
        // persist:<id> 分区的等价物，登录态互不干扰的根基。
        .data_directory(partition_dir(id))
        // 第三方登录 / 扫码登录弹窗的策略，对齐 Electron 版 handleWindowOpen：
        // http(s) 放行（WebView2 自己开的弹窗天然同 profile，登录态会写回同一个标签，
        // 且保留 window.opener，OAuth 回调才能通信）；其余协议交给系统。
        .on_new_window(move |url, _features| {
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" {
                NewWindowResponse::Allow
            } else {
                // mailto: / weixin: / alipays: 之类
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_url(url.as_str(), None::<&str>);
                NewWindowResponse::Deny
            }
        });

    window.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(w, h),
    )
}

/// 外壳（标签栏 + 设置面板）。铺满整个窗口，站点视图叠在它上面。
/// 设置面板打开时站点视图全部移走，外壳就整窗露出来——和 Electron 版同构。
pub fn create_shell(window: &Window, w: f64, h: f64) -> tauri::Result<Webview<Wry>> {
    let mut builder = WebviewBuilder::new(SHELL_LABEL, WebviewUrl::App("index.html".into()));

    // 调试构建里把图片加载失败的真实 URL 打出来。
    // 迁移时踩过一次：标签栏 logo 全是破图，光看代码分不清是文件没搬过去
    // 还是 CSP 挡了，必须看到浏览器实际请求的那个地址。
    #[cfg(debug_assertions)]
    {
        builder = builder.initialization_script(
            r#"window.addEventListener('error', (e) => {
                 if (e.target && e.target.tagName === 'IMG') {
                   console.error('[img-fail]', e.target.src);
                 }
               }, true);"#,
        );
    }

    window.add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(w, h))
}

/// 一次布局要对窗口做的事。
///
/// 刻意把「算」和「做」分开：计算阶段要读 ViewManager（需要锁），
/// 执行阶段要调 add_child（会阻塞等主线程）。两件事必须发生在锁的两侧，
/// 否则就是死锁——主线程卡在等我们放锁，我们卡在等主线程干活。
/// 一个 webview 该摆在哪儿。
/// 田字格之后位置是二维的，原来那个 (id, x, width) 三元组不够用了。
#[derive(Debug, Clone)]
pub struct PanePlace {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct LayoutPlan {
    pub geometry: Geometry,
    pub top: i32,
    pub body_height: f64,
    pub window_size: (f64, f64),
    /// 要藏起来的（进程还在，点回来是瞬时的）
    pub to_hide: Vec<String>,
    /// 已经存在、只需要挪位置的
    pub to_move: Vec<PanePlace>,
    /// 还不存在、需要新建的（摆放位置 + 起始地址）
    pub to_create: Vec<(PanePlace, String)>,
}

/// 第一阶段：纯计算。**必须**在持有 views 锁时调用，不碰任何会阻塞的窗口 API。
pub fn plan_layout(
    width: i32,
    height: i32,
    config: &Config,
    mgr: &mut ViewManager,
) -> Option<LayoutPlan> {
    // 窗口最小化时 Windows 会返回退化的客户区尺寸。照着它算会把视图压成 0 宽，
    // 所以直接跳过，等 restore/resize 带着正常尺寸再算一遍。
    if width < MIN_SANE_WIDTH || height < MIN_SANE_HEIGHT {
        return None;
    }

    let top = config.content_top();
    let body_height = (height - top).max(0) as f64;

    let visible: Vec<String> = if mgr.overlay_open {
        Vec::new()
    } else {
        config.panes.iter().filter(|id| config.get_service(id).is_some()).cloned().collect()
    };

    let to_hide: Vec<String> = mgr.live.iter().filter(|id| !visible.contains(id)).cloned().collect();

    // 按栏数挑形状：1 整屏 / 2 左右 / 3 左一右二 / 4 田字格。
    // body_height 是内容区真实高度（已经扣掉标签栏），二维布局要靠它。
    let shape = GridShape::for_count(visible.len());
    let geometry = compute_grid(width, body_height as i32, &visible, &config.weights, shape);
    let mut to_move = Vec::new();
    let mut to_create = Vec::new();

    for pane in &geometry.panes {
        // 摆在屏幕上的那几栏永远算活跃：看得见的东西不该在你眼前被回收
        mgr.touch(&pane.id);
        if mgr.live.contains(&pane.id) {
            to_move.push(PanePlace {
                id: pane.id.clone(),
                x: pane.x as f64,
                y: pane.y as f64,
                w: pane.width as f64,
                h: pane.height as f64,
            });
        } else {
            let url = start_url(config, &pane.id);
            if !url.is_empty() {
                to_create.push((
                    PanePlace {
                        id: pane.id.clone(),
                        x: pane.x as f64,
                        y: pane.y as f64,
                        w: pane.width as f64,
                        h: pane.height as f64,
                    },
                    url,
                ));
            }
        }
    }

    mgr.last_geometry = Some(geometry.clone());
    Some(LayoutPlan {
        geometry,
        top,
        body_height,
        window_size: (width as f64, height as f64),
        to_hide,
        to_move,
        to_create,
    })
}

/// 第二阶段：执行。**必须**在放开所有锁之后调用（add_child 会阻塞等主线程）。
///
/// 返回这次真正建出来的 id，调用方拿回去补登记到 ViewManager。
pub fn execute_plan(window: &Window, plan: &LayoutPlan) -> Vec<String> {
    // 外壳始终铺满整窗（站点视图叠在它上面）
    if let Some(shell) = window.get_webview(SHELL_LABEL) {
        let _ = shell.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = shell.set_size(LogicalSize::new(plan.window_size.0, plan.window_size.1));
    }

    for id in &plan.to_hide {
        if let Some(v) = window.get_webview(&view_label(id)) {
            let _ = v.hide();
        }
    }

    for place in &plan.to_move {
        if let Some(view) = window.get_webview(&view_label(&place.id)) {
            // y 要加上标签栏高度：几何是相对内容区算的，摆位要的是窗口坐标
            let _ = view.set_position(LogicalPosition::new(place.x, plan.top as f64 + place.y));
            let _ = view.set_size(LogicalSize::new(place.w, place.h));
            let _ = view.show();
        }
    }

    let mut created = Vec::new();
    for (place, url) in &plan.to_create {
        match create_view(
            window, &place.id, url,
            place.x, plan.top as f64 + place.y, place.w, place.h,
        ) {
            Ok(_) => created.push(place.id.clone()),
            Err(err) => eprintln!("[aihub] 建视图失败 {}: {err}", place.id),
        }
    }
    created
}

/// 休眠一个后台标签：真的把 webview 关掉，渲染进程还给系统。
/// 点回来时 apply_layout 会按上次停留的地址重建。
pub fn hibernate(window: &Window, mgr: &mut ViewManager, id: &str) -> bool {
    let label = view_label(id);
    let Some(view) = window.get_webview(&label) else {
        return false;
    };
    if view.close().is_err() {
        return false;
    }
    mgr.live.remove(id);
    mgr.hibernated.insert(id.to_string());
    mgr.last_active.remove(id);
    true
}

/// 彻底销毁（删服务时用），不打休眠标记。
pub fn destroy(window: &Window, mgr: &mut ViewManager, id: &str) {
    if let Some(view) = window.get_webview(&view_label(id)) {
        let _ = view.close();
    }
    mgr.forget(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_labels_are_namespaced() {
        assert_eq!(view_label("claude"), "svc-claude");
        assert_ne!(view_label("shell"), SHELL_LABEL, "自建 id 叫 shell 也不能顶掉外壳");
        assert_ne!(view_label("main"), MAIN_WINDOW, "自建 id 叫 main 也不能顶掉窗口");
    }

    #[test]
    fn visible_panes_are_never_hibernation_candidates() {
        let mut mgr = ViewManager::default();
        mgr.live.insert("claude".into());
        mgr.live.insert("kimi".into());
        // 两个都标成很久以前活跃过
        let long_ago = Instant::now() - std::time::Duration::from_secs(3600);
        mgr.last_active.insert("claude".into(), long_ago);
        mgr.last_active.insert("kimi".into(), long_ago);

        let idle = mgr.idle_candidates(&["claude".to_string()], 30);
        assert_eq!(idle, vec!["kimi".to_string()], "屏幕上的 claude 不该被回收");
    }

    #[test]
    fn freshly_touched_views_are_not_idle() {
        let mut mgr = ViewManager::default();
        mgr.live.insert("kimi".into());
        mgr.touch("kimi");
        assert!(mgr.idle_candidates(&[], 30).is_empty(), "刚活跃过不该被判定闲置");
    }

    #[test]
    fn views_without_timestamp_are_not_reaped() {
        let mut mgr = ViewManager::default();
        mgr.live.insert("ghost".into()); // 没有 last_active 记录
        assert!(
            mgr.idle_candidates(&[], 30).is_empty(),
            "没有活跃记录时宁可不回收，也不要误杀"
        );
    }

    #[test]
    fn touch_clears_the_hibernated_flag() {
        let mut mgr = ViewManager::default();
        mgr.hibernated.insert("kimi".into());
        assert!(mgr.is_hibernated("kimi"));
        mgr.touch("kimi");
        assert!(!mgr.is_hibernated("kimi"), "被点回来之后休眠标记要摘掉");
    }

    #[test]
    fn forget_wipes_every_trace() {
        let mut mgr = ViewManager::default();
        mgr.live.insert("gone".into());
        mgr.touch("gone");
        mgr.hibernated.insert("gone".into());
        mgr.forget("gone");
        assert!(!mgr.is_live("gone"));
        assert!(!mgr.is_hibernated("gone"));
        assert!(mgr.idle_candidates(&[], 0).is_empty());
    }

    #[test]
    fn start_url_prefers_last_visited() {
        let mut cfg = Config::default();
        cfg.last_urls.insert("claude".into(), "https://claude.ai/chat/abc".into());
        assert_eq!(start_url(&cfg, "claude"), "https://claude.ai/chat/abc");
    }

    #[test]
    fn start_url_ignores_junk_and_falls_back_home() {
        let mut cfg = Config::default();
        cfg.last_urls.insert("claude".into(), "about:blank".into());
        assert_eq!(
            start_url(&cfg, "claude"),
            "https://claude.ai/",
            "非 http 的残留地址应退回站点首页"
        );
    }

    #[test]
    fn hibernated_views_are_not_scanned_again() {
        let mut mgr = ViewManager::default();
        mgr.live.insert("kimi".into());
        mgr.last_active.insert("kimi".into(), Instant::now() - std::time::Duration::from_secs(7200));
        // 第一次扫到它
        assert_eq!(mgr.idle_candidates(&[], 30), vec!["kimi".to_string()]);
        // 休眠之后它就不在 live 里了，不该被反复扫到
        mgr.live.remove("kimi");
        mgr.hibernated.insert("kimi".into());
        assert!(mgr.idle_candidates(&[], 30).is_empty(), "已休眠的不该再进候选");
        assert!(mgr.is_hibernated("kimi"), "但要保留休眠标记给 UI 打角标");
    }

    #[test]
    fn register_makes_a_view_live_and_clears_hibernation() {
        let mut mgr = ViewManager::default();
        mgr.hibernated.insert("glm".into());
        mgr.register("glm");
        assert!(mgr.is_live("glm"), "建出来之后应登记为活的");
        assert!(!mgr.is_hibernated("glm"), "重建即唤醒，休眠标记要摘掉");
    }

    #[test]
    fn zero_minute_limit_reaps_everything_offscreen() {
        // 「不休眠」在 UI 上是单独一档（hibernate.enabled=false），
        // 不是靠 minutes=0 表达的。但万一配置被手改成 0，行为也该是确定的：
        // 立刻回收所有不在屏幕上的，而不是 panic 或者反而不回收。
        let mut mgr = ViewManager::default();
        mgr.live.insert("a".into());
        mgr.live.insert("b".into());
        mgr.touch("a");
        mgr.touch("b");
        let idle = mgr.idle_candidates(&["a".to_string()], 0);
        assert_eq!(idle, vec!["b".to_string()], "0 分钟应立刻回收屏幕外的");
    }

    #[test]
    fn overlay_open_hides_every_site_view() {
        // 设置面板打开时所有站点视图让位给外壳
        let mut cfg = Config::default();
        cfg.panes = vec!["claude".into(), "kimi".into()];
        cfg.weights = crate::layout::normalize_weights(None, 2);
        let mut mgr = ViewManager::default();
        mgr.live.insert("claude".into());
        mgr.live.insert("kimi".into());
        mgr.overlay_open = true;

        let plan = plan_layout(1280, 820, &cfg, &mut mgr).expect("尺寸正常应出计划");
        assert!(plan.geometry.panes.is_empty(), "浮层打开时不该有站点栏上屏");
        assert_eq!(plan.to_hide.len(), 2, "两个活着的视图都该被藏起来");
        assert!(plan.to_create.is_empty(), "浮层打开时不该新建视图");
    }

    #[test]
    fn plan_skips_degenerate_window_size() {
        let cfg = Config::default();
        let mut mgr = ViewManager::default();
        // 最小化时 Windows 会给出退化尺寸，照着算会把视图压成 0 宽
        assert!(plan_layout(0, 0, &cfg, &mut mgr).is_none());
        assert!(plan_layout(100, 800, &cfg, &mut mgr).is_none(), "宽度低于下限应跳过");
    }

    #[test]
    fn tab_bar_hidden_moves_views_to_the_top_edge() {
        let mut cfg = Config::default();
        cfg.panes = vec!["claude".into()];
        cfg.weights = crate::layout::normalize_weights(None, 1);
        let mut mgr = ViewManager::default();

        let with_bar = plan_layout(1280, 820, &cfg, &mut mgr).unwrap();
        assert_eq!(with_bar.top, crate::layout::TAB_BAR_HEIGHT);

        cfg.tab_bar_visible = false;
        let no_bar = plan_layout(1280, 820, &cfg, &mut mgr).unwrap();
        assert_eq!(no_bar.top, 0, "标签栏收起后站点应从窗口顶边开始");
        assert!(
            no_bar.body_height > with_bar.body_height,
            "收起标签栏应该换来更高的可视区域"
        );
    }
}
