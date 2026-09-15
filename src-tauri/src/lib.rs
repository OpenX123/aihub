//! Aihub —— 把常用 AI 聊天站点聚合到一个窗口里。
//!
//! 从 Electron 迁过来的 Tauri 版。架构与 Electron 版同构：
//!   - 一个 Window，里面挂 N+1 个 webview
//!   - "shell"（index.html）铺满整窗，负责标签栏和设置面板
//!   - 每个站点一个 webview，叠在 shell 上面，从 content_top 往下摆
//!   - 每个站点一个独立的 WebView2 用户数据目录 => 登录态互不干扰
//!
//! 前端完全不知道自己换了运行时：src-ui/api-shim.js 用同一套 `window.api`
//! 方法名把调用转成 Tauri 的 invoke，所以 index.html 几乎没改。

pub mod commands;
pub mod config;
pub mod layout;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod services;
pub mod views;

use std::sync::Mutex;

use tauri::{Emitter, Manager, WindowEvent};

use crate::config::Config;
use crate::views::{ViewManager, MAIN_WINDOW};

pub struct AppState {
    pub config: Mutex<Config>,
    pub views: Mutex<ViewManager>,
}

impl AppState {
    /// 读一份配置快照。
    ///
    /// 刻意返回克隆而不是 guard：调用方拿到它之后往往要去碰窗口
    /// （add_child 会阻塞等主线程），握着锁过去就是死锁。
    pub fn snapshot(&self) -> Config {
        self.config.lock().expect("config 锁中毒").clone()
    }
}

/// 把当前状态广播给外壳（对齐 Electron 版的 broadcast()）。
pub fn broadcast(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let config = state.snapshot();
    let payload = commands::state_payload(app, &config);
    let _ = app.emit("state:changed", payload);
}

/// 重新布局 + 把几何广播给外壳（外壳靠它画分隔条）。
///
/// 严格分三段，中间不跨锁：
///   1. 拿窗口尺寸（不需要锁）
///   2. 持锁算出一份 LayoutPlan（纯计算，不碰窗口）
///   3. 放锁后执行 plan（add_child 会阻塞等主线程，握着锁过去必死锁）
pub fn relayout(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        return;
    };
    let Ok(size) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = (size.width as f64 / scale).round() as i32;
    let height = (size.height as f64 / scale).round() as i32;

    let config = app.state::<AppState>().snapshot();

    // --- 第 2 段：持锁只做计算 ---
    let plan = {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        views::plan_layout(width, height, &config, &mut mgr)
    }; // <- 锁在这里放掉

    let Some(plan) = plan else {
        // 最小化时 Windows 会给出退化尺寸，跳过是正常行为，不用喊
        return;
    };

    // --- 第 3 段：无锁执行 ---
    let created = views::execute_plan(&window, &plan);
    if !created.is_empty() {
        eprintln!("[aihub] 新建站点视图: {created:?}");
    }

    if !created.is_empty() {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        for id in created {
            mgr.register(&id);
        }
    }

    let _ = app.emit(
        "layout:changed",
        serde_json::json!({
            "panes": plan.geometry.panes,
            "dividers": plan.geometry.dividers,
            "usable": plan.geometry.usable,
            "tabBarHeight": plan.top,
            "tabBarVisible": config.tab_bar_visible,
            "activeId": config.active_id,
            "weights": config.weights,
        }),
    );
}

/// 布局请求的发送端。
///
/// 所有布局都必须从后台线程驱动（add_child 会阻塞等主线程，见 relayout 的注释），
/// 而 resize 事件又很密集——每次开一个线程会瞬间炸出几百个。
/// 所以起**一条**长期存活的布局线程，所有请求排到它身上串行执行。
pub struct LayoutQueue(pub std::sync::mpsc::Sender<()>);

/// 启动布局线程，返回它的发送端。
fn spawn_layout_thread(app: tauri::AppHandle) -> std::sync::mpsc::Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 把积压的请求一次性吃掉：连续拖动时只按最后一次状态排一遍就够了
            while rx.try_recv().is_ok() {}
            relayout(&app);
        }
    });
    tx
}

/// 请求一次重排（非阻塞，可以安全地从主线程调用）。
pub fn request_layout(app: &tauri::AppHandle) {
    if let Some(queue) = app.try_state::<LayoutQueue>() {
        let _ = queue.0.send(());
    }
}

/// 注册全局快捷键（老板键）。
///
/// Electron 用 `globalShortcut.register`，Tauri 走 global-shortcut 插件。
/// 加速键字符串两边语法基本一致（`Alt+Space`、`Ctrl+Shift+A`），所以配置能直接继承。
///
/// 返回注册失败的原因，供设置面板显示——**注册失败必须让用户看见**：
/// 快捷键被别的程序占了是很常见的事，静默失败会让人以为是应用坏了。
pub fn register_hotkey(app: &tauri::AppHandle, accelerator: &str, enabled: bool) -> Option<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = app.global_shortcut();
    let _ = shortcut.unregister_all();
    if !enabled || accelerator.trim().is_empty() {
        return None;
    }

    let handle = app.clone();
    let acc = accelerator.to_string();
    match shortcut.on_shortcut(accelerator, move |_app, _sc, event| {
        // 只认按下，不然按一次会触发两回（按下 + 抬起）
        if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
            return;
        }
        toggle_window(&handle);
    }) {
        Ok(()) => None,
        Err(err) => {
            let msg = format!("快捷键 {acc} 注册失败（多半是被别的程序占用了）：{err}");
            eprintln!("[aihub] {msg}");
            Some(msg)
        }
    }
}

/// 老板键的行为：在前台就收起，不在前台就唤到最前。
fn toggle_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else { return };
    let config = app.state::<AppState>().snapshot();

    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    if config.hotkey.action == "toggle" && visible && focused {
        let _ = window.hide();
        return;
    }

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    // 唤出时临时置顶：用最高层级压过别的置顶窗口。
    // 注意这跟常驻置顶（config.always_on_top）是两件事——
    // 常驻置顶已经开着时不用管，没开才需要临时抬一下，并在失焦时放下。
    if config.hotkey.pin_top && !config.always_on_top {
        let _ = window.set_always_on_top(true);
    }
}

/// 托盘图标：窗口收进后台之后仍然有一个能点回来的入口。
///
/// 左键点图标 = 唤出/收起，右键菜单里有「显示」「显示 / 隐藏标签栏」「退出」。
/// 退出必须在这里给一条明路——`close_to_tray` 开着时点关闭按钮只是隐藏，
/// 没有托盘菜单的话用户就只能去任务管理器杀进程了。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示 Aihub", true, None::<&str>)?;
    // 标签栏收起来之后，外壳整块被站点页面盖住，设置面板再也点不开——
    // 托盘菜单是唯一还能把标签栏放回来的入口（macOS 上就是菜单栏图标）。
    let toggle_bar = MenuItem::with_id(app, "toggle-bar", "显示 / 隐藏标签栏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle_bar, &quit])?;

    TrayIconBuilder::with_id("aihub-tray")
        .icon(app.default_window_icon().cloned().ok_or(tauri::Error::WebviewNotFound)?)
        .tooltip("Aihub")
        .menu(&menu)
        // 左键点击不要弹菜单，让它走下面的 on_tray_icon_event 去唤窗口
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_window(MAIN_WINDOW) {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "toggle-bar" => commands::toggle_tab_bar(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 这一刻托盘图标是不是必须存在。
///
/// 单独抽出来是为了能单测：这条不变式一破，用户就会掉进「什么都点不到」的状态。
fn tray_needed(config: &Config) -> bool {
    config.hotkey.tray || config.hotkey.close_to_tray || !config.tab_bar_visible
}

/// 托盘图标的开关要跟着「有没有东西被藏起来」走，而不是只跟着用户那个设置。
///
/// 托盘是唯一一条常驻的回头路：标签栏收起来之后外壳被站点页面整块盖住，
/// 设置面板点不开；`close_to_tray` 开着时点关闭只是把窗口藏了。
/// 这两件事只要有一件成立就得有托盘图标，否则用户会掉进一个
/// 「什么都点不到、只能去杀进程」的状态——macOS 上收起标签栏回不去就是这一类。
///
/// 用 `hotkey.tray` 这个设置决定「没藏东西时要不要常驻」；藏了东西时即使
/// 用户把那个设置关了也会临时把图标挂出来，东西放回去就还给用户。
pub fn ensure_tray(app: &tauri::AppHandle) {
    let cfg = app.state::<AppState>().snapshot();
    let needed = tray_needed(&cfg);
    let exists = app.tray_by_id("aihub-tray").is_some();

    match (needed, exists) {
        (true, false) => match build_tray(app) {
            // 这条日志是「回头路还在不在」的凭据：收起标签栏时它必须打出来。
            Ok(()) => eprintln!("[aihub] 托盘图标已就绪"),
            Err(err) => eprintln!("[aihub] 托盘图标创建失败: {err}"),
        },
        (false, true) => {
            app.remove_tray_by_id("aihub-tray");
            eprintln!("[aihub] 托盘图标已收起（没有东西藏着，用户也把常驻关了）");
        }
        _ => {}
    }
}

/// 后台标签休眠的扫描线程。
///
/// 闲置久了就把后台标签的 webview 关掉，把渲染进程还给系统；点回去时
/// apply_layout 会按 last_urls 里记的地址重建。对齐 Electron 版的 sweepIdle()。
///
/// 和布局一样跑在后台线程上：关 webview 同样要经过主线程。
fn spawn_hibernate_thread(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));

        let config = app.state::<AppState>().snapshot();
        if !config.hibernate.enabled {
            continue;
        }

        // 屏幕上正显示的那几栏永远不回收——不该在用户眼前把页面弄没
        let visible: Vec<String> = config.panes.clone();
        let idle = {
            let state = app.state::<AppState>();
            let mgr = state.views.lock().expect("views 锁中毒");
            mgr.idle_candidates(&visible, config.hibernate.minutes)
        }; // 放锁再去碰窗口

        if idle.is_empty() {
            continue;
        }
        let Some(window) = app.get_window(MAIN_WINDOW) else { continue };

        for id in idle {
            // 输入框里有没发出去的草稿就别动它——这是 Electron 版就有的保护，
            // 睡掉一个写了一半的提问比省那点内存糟糕得多。
            if has_unsent_draft(&window, &id) {
                continue;
            }
            let hibernated = {
                let state = app.state::<AppState>();
                let mut mgr = state.views.lock().expect("views 锁中毒");
                views::hibernate(&window, &mut mgr, &id)
            };
            if hibernated {
                eprintln!("[aihub] 休眠后台标签: {id}");
                let _ = app.emit("tab:status", serde_json::json!({
                    "id": id, "hibernated": true, "loading": false, "error": null,
                }));
            }
        }
        broadcast(&app);
    });
}

/// 这个标签的输入框里有没有没发出去的内容。
///
/// Tauri 的 `eval()` 是 fire-and-forget 拿不到返回值，要用带 callback 的变体。
/// Windows 上 JS 异常会被吞掉，所以脚本自己包一层 try/catch。
fn has_unsent_draft(window: &tauri::Window, id: &str) -> bool {
    use std::sync::mpsc::channel;

    let Some(view) = window.get_webview(&views::view_label(id)) else {
        return false;
    };
    let (tx, rx) = channel();
    let js = r#"(() => { try {
        const sel = 'textarea, [contenteditable="true"], input[type="text"]';
        for (const el of document.querySelectorAll(sel)) {
            const v = (el.value !== undefined ? el.value : el.innerText) || '';
            if (v.trim().length > 0) return true;
        }
        return false;
    } catch (e) { return false; } })()"#;

    if view.eval_with_callback(js, move |res| { let _ = tx.send(res); }).is_err() {
        return false;
    }
    // 拿不到答复时保守处理：当作有草稿，不回收。
    // 宁可多留一个进程，也不要弄丢用户写了一半的东西。
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(v) => v.trim() == "true",
        Err(_) => true,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut config = config::load();
    // 上次删服务时勾了「清除登录数据」的，现在目录没被占用，可以真的删了
    if !config.pending_wipe.is_empty() {
        config.pending_wipe = config::wipe_pending(&config.pending_wipe);
    }
    // normalize() 只在内存里补齐字段。启动时立刻回写一次，把升级结果落盘：
    // 否则老用户装上新版却什么都不改，配置文件会一直停在 v3，
    // 每次启动都要重算一遍迁移，而且文件内容和实际生效的状态对不上。
    if let Err(err) = config::save(&config) {
        eprintln!("[aihub] 启动时回写配置失败: {err}");
    }
    let always_on_top = config.always_on_top;

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动就把已经在跑的那个唤到前面来，而不是开第二个窗口
            if let Some(window) = app.get_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            config: Mutex::new(config),
            views: Mutex::new(ViewManager::default()),
        })
        .invoke_handler(commands::handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            let window = tauri::window::WindowBuilder::new(app, MAIN_WINDOW)
                .title("Aihub")
                .inner_size(1280.0, 820.0)
                .min_inner_size(880.0, 560.0)
                .center()
                // 功能 1：常驻置顶，默认开启。
                // Windows 上 Tauri 走的是 SetWindowPos(HWND_TOPMOST)，
                // 也就是系统层面的置顶，不是应用内的 z-order。
                .always_on_top(always_on_top)
                .build()?;

            // macOS 上内容视图默认铺满整个窗口框（系统标题栏压在内容顶上），
            // 44px 的标签栏会被盖掉大半。必须在建 webview 之前摘掉：内容区由此
            // 从标题栏下方开始，下面 create_shell 拿到的尺寸才是对的。
            #[cfg(target_os = "macos")]
            match macos::pin_content_below_titlebar(&window) {
                Ok(true) => eprintln!("[aihub] 已把内容区拉回系统标题栏下方"),
                Ok(false) => {}
                Err(err) => {
                    eprintln!("[aihub] 摘 FullSizeContentView 失败，标签栏会被标题栏压住: {err}")
                }
            }

            let size = window.inner_size()?;
            let scale = window.scale_factor().unwrap_or(1.0);
            let w = size.width as f64 / scale;
            let h = size.height as f64 / scale;
            eprintln!("[aihub] 窗口就绪 {w}x{h} scale={scale}");

            // 内外尺寸差是「内容区有没有被系统标题栏压住」的信号，故意留在日志里：
            // macOS 上两者相等 = 内容视图铺满整个窗口框，系统标题栏压在内容顶上，
            // 顶部 44px 的标签栏会被吃掉一大截（见 macos.rs）。一眼就能看出来。
            if let (Ok(outer), Ok(outer_pos), Ok(inner_pos)) =
                (window.outer_size(), window.outer_position(), window.inner_position())
            {
                eprintln!(
                    "[aihub] 窗口几何 inner={}x{} outer={}x{} outerPos=({},{}) innerPos=({},{})",
                    size.width, size.height, outer.width, outer.height,
                    outer_pos.x, outer_pos.y, inner_pos.x, inner_pos.y
                );
            }
            match views::create_shell(&window, w, h) {
                Ok(_) => eprintln!("[aihub] 外壳 webview 已创建"),
                Err(err) => {
                    eprintln!("[aihub] 外壳创建失败: {err}");
                    return Err(err.into());
                }
            }

            // 窗口尺寸一变就重排所有站点视图。
            // multiwebview 是 unstable 特性，已知在反复 resize / 最大化还原之后
            // 子 webview 位置会飘（tauri#10131 / #11170），所以这里不依赖
            // auto_resize，每次事件都用几何重算一遍绝对坐标压回去。
            //
            // 这个回调跑在主线程上，所以只能往布局线程投一张单子，不能直接排版。
            let resize_handle = handle.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    request_layout(&resize_handle);
                }
                WindowEvent::Focused(false) => {
                    // 快捷键唤出时临时抬起的置顶，失焦就放下——不能一直压着别人。
                    // 用户明确开了常驻置顶的话不动它。
                    let cfg = resize_handle.state::<AppState>().snapshot();
                    if cfg.hotkey.pin_top && !cfg.always_on_top {
                        if let Some(w) = resize_handle.get_window(MAIN_WINDOW) {
                            let _ = w.set_always_on_top(false);
                        }
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // 「点关闭收进后台」：拦下来只隐藏，留着让快捷键随时唤回。
                    // 真正退出走托盘菜单或设置里的退出。
                    let cfg = resize_handle.state::<AppState>().snapshot();
                    if cfg.hotkey.close_to_tray {
                        api.prevent_close();
                        if let Some(w) = resize_handle.get_window(MAIN_WINDOW) {
                            let _ = w.hide();
                        }
                    }
                }
                _ => {}
            });

            // 全局快捷键（老板键）。注册失败的原因要能传到设置面板上。
            {
                let cfg = handle.state::<AppState>().snapshot();
                register_hotkey(&handle, &cfg.hotkey.accelerator, cfg.hotkey.enabled);
                ensure_tray(&handle);
            }

            // 布局必须从后台线程驱动（add_child 会阻塞等主线程），
            // 起一条串行的布局线程收口所有请求。
            app.manage(LayoutQueue(spawn_layout_thread(handle.clone())));

            let boot = handle.clone();
            std::thread::spawn(move || {
                relayout(&boot);
                broadcast(&boot);
            });

            // 后台标签休眠的扫描线程
            spawn_hibernate_thread(handle.clone());

            // 自检：AIHUB_SELFTEST=<脚本路径> 时，等外壳就绪后在里面跑一遍那个脚本。
            // 脚本的返回值回不来（WKWebView 的 evaluateJavaScript 不等 promise），
            // 所以结论由脚本调 debug_note 打到 stderr。
            // 现在拖拽分屏也走这条链路（tools/tauri-drag-selftest.js）。
            #[cfg(debug_assertions)]
            if let Ok(path) = std::env::var("AIHUB_SELFTEST") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    match std::fs::read_to_string(&path) {
                        Ok(js) => match commands::debug_eval(h, js, None) {
                            Ok(out) => println!("[selftest] {out}"),
                            Err(err) => println!("[selftest] 失败: {err}"),
                        },
                        Err(err) => println!("[selftest] 读不到脚本 {path}: {err}"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Aihub 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_tab_bar_always_leaves_a_way_back() {
        let mut cfg = Config::default();
        cfg.hotkey.tray = false;
        cfg.hotkey.close_to_tray = false;
        assert!(!tray_needed(&cfg), "什么都没藏起来时，托盘图标该听用户设置");

        // 收起标签栏之后，外壳整块被站点页面盖住，设置面板再也点不开——
        // 这时候没有托盘图标就等于没有回头路（macOS 上真实踩到过）。
        cfg.tab_bar_visible = false;
        assert!(tray_needed(&cfg), "收起标签栏后必须有托盘图标，否则没有入口放回来");
    }

    #[test]
    fn close_to_tray_also_requires_the_tray() {
        let mut cfg = Config::default();
        cfg.hotkey.tray = false;
        cfg.hotkey.close_to_tray = true;
        assert!(tray_needed(&cfg), "点关闭只隐藏时，托盘是唯一能把窗口找回来的入口");
    }

    #[test]
    fn explicit_tray_setting_is_respected() {
        let cfg = Config::default();
        assert!(cfg.hotkey.tray, "托盘图标默认开着");
        assert!(tray_needed(&cfg));
    }
}
