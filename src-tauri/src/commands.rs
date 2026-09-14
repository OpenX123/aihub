//! 前端能调的所有命令。
//!
//! 名字和 Electron 版的 IPC 通道一一对应（`tab:activate` -> `tab_activate`），
//! 由 src-ui/api-shim.js 负责转接，所以 index.html 里的 `window.api.*` 调用没动过。
//!
//! ## 锁的纪律
//! 任何要碰窗口的命令，都必须先把配置从锁里拷出来再 drop guard。
//! `add_child` / `set_bounds` 内部会阻塞等主线程，握着锁过去就死锁。
//! 本文件里的 `mutate()` 辅助函数把这件事收口了——用它，别自己 lock。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{self, Config};
use crate::layout::{self, MAX_PANES};
use crate::services::Service;
use crate::views::{self, view_label, MAIN_WINDOW};
use crate::{broadcast, request_layout, AppState};

type CmdResult<T> = Result<T, String>;

/// 改配置的统一入口：拿锁 -> 改 -> 存盘 -> 放锁 -> 重排 -> 广播。
///
/// 关键在于 guard 在碰窗口**之前**就被 drop 掉了（见模块头）。
fn mutate<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&mut Config) -> R,
{
    let out = {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().expect("config 锁中毒");
        let out = f(&mut cfg);
        if let Err(err) = config::save(&cfg) {
            eprintln!("[aihub] 配置存盘失败: {err}");
        }
        out
    }; // <- guard 在这里放掉
    request_layout(app);
    broadcast(app);
    out
}

/// 只改配置、不需要重排的轻量版（比如切主题）。
fn mutate_quiet<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&mut Config) -> R,
{
    let out = {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().expect("config 锁中毒");
        let out = f(&mut cfg);
        if let Err(err) = config::save(&cfg) {
            eprintln!("[aihub] 配置存盘失败: {err}");
        }
        out
    };
    broadcast(app);
    out
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 给外壳的完整状态快照，字段名对齐 Electron 版 buildState()。
pub fn state_payload(app: &AppHandle, config: &Config) -> serde_json::Value {
    let state = app.state::<AppState>();
    let mgr = state.views.lock().expect("views 锁中毒");
    let hibernated: Vec<&String> = config
        .services
        .iter()
        .map(|s| &s.id)
        .filter(|id| mgr.is_hibernated(id))
        .collect();

    serde_json::json!({
        "services": config.services,
        "activeId": config.active_id,
        "panes": config.panes,
        "weights": config.weights,
        "maxPanes": MAX_PANES,
        "preload": config.preload,
        "hibernate": {
            "enabled": config.hibernate.enabled,
            "minutes": config.hibernate.minutes,
        },
        "theme": config.theme,
        "hotkey": config.hotkey,
        "hibernated": hibernated,
        // v4 新增
        "alwaysOnTop": config.always_on_top,
        "tabBarVisible": config.tab_bar_visible,
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
    })
}

#[tauri::command]
pub fn app_get_state(app: AppHandle) -> serde_json::Value {
    let config = app.state::<AppState>().snapshot();
    state_payload(&app, &config)
}

#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tab_activate(app: AppHandle, id: String) {
    mutate(&app, |cfg| {
        if cfg.get_service(&id).is_none() {
            return;
        }
        cfg.active_id = id.clone();
        if !cfg.panes.contains(&id) {
            // 单栏模式下点标签 = 换掉当前这栏；多栏下换掉焦点那栏
            if cfg.panes.len() <= 1 {
                cfg.panes = vec![id.clone()];
                cfg.weights = layout::normalize_weights(None, 1);
            } else if let Some(slot) = cfg.panes.iter().position(|p| p == &cfg.active_id) {
                cfg.panes[slot] = id.clone();
            } else {
                let last = cfg.panes.len() - 1;
                cfg.panes[last] = id.clone();
            }
        }
    });
}

#[tauri::command]
pub fn tab_reload(app: AppHandle, id: String) {
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if let Some(view) = window.get_webview(&view_label(&id)) {
            let _ = view.eval("location.reload()");
        }
    }
}

#[tauri::command]
pub fn tab_reload_hard(app: AppHandle, id: String) {
    // 硬刷新：绕过缓存重新拉一遍
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if let Some(view) = window.get_webview(&view_label(&id)) {
            let _ = view.eval("location.reload(true)");
        }
    }
}

#[tauri::command]
pub fn tab_home(app: AppHandle, id: String) {
    let config = app.state::<AppState>().snapshot();
    let Some(svc) = config.get_service(&id) else { return };
    let home = svc.url.clone();
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if let Some(view) = window.get_webview(&view_label(&id)) {
            if let Ok(url) = home.parse() {
                let _ = view.navigate(url);
            }
        }
    }
}

#[tauri::command]
pub fn tab_devtools(app: AppHandle, id: String) {
    #[cfg(debug_assertions)]
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if let Some(view) = window.get_webview(&view_label(&id)) {
            view.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, id);
    }
}

#[tauri::command]
pub fn tab_zoom(app: AppHandle, delta: f64, id: Option<String>) {
    let config = app.state::<AppState>().snapshot();
    let id = id.unwrap_or(config.active_id.clone());
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        if let Some(view) = window.get_webview(&view_label(&id)) {
            // WebView2 没有直接的 setZoomLevel 暴露到 Tauri，
            // 用页面自己的 zoom 样式顶上——对这些站点够用。
            let js = format!(
                "(()=>{{const d=document.documentElement;\
                 const z=parseFloat(d.style.zoom||'1')||1;\
                 d.style.zoom=String(Math.min(3,Math.max(0.5,z+({delta}))));}})()"
            );
            let _ = view.eval(js);
        }
    }
}

// ---------------------------------------------------------------------------
// 分屏布局
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn layout_get(app: AppHandle) -> serde_json::Value {
    let config = app.state::<AppState>().snapshot();
    let state = app.state::<AppState>();
    let mgr = state.views.lock().expect("views 锁中毒");
    let geo = mgr.last_geometry.clone();
    serde_json::json!({
        "panes": geo.as_ref().map(|g| g.panes.clone()).unwrap_or_default(),
        "dividers": geo.as_ref().map(|g| g.dividers.clone()).unwrap_or_default(),
        "tabBarHeight": config.content_top(),
        "tabBarVisible": config.tab_bar_visible,
        "activeId": config.active_id,
    })
}

#[tauri::command]
pub fn layout_set_panes(app: AppHandle, ids: Vec<String>) -> CmdResult<serde_json::Value> {
    if ids.len() > MAX_PANES {
        return Err(format!("最多同时显示 {MAX_PANES} 栏"));
    }
    mutate(&app, |cfg| {
        let mut next: Vec<String> = Vec::new();
        for id in &ids {
            if cfg.get_service(id).is_some() && !next.contains(id) {
                next.push(id.clone());
            }
        }
        if next.is_empty() {
            return Err("至少要留一栏".to_string());
        }
        if !next.contains(&cfg.active_id) {
            cfg.active_id = next[0].clone();
        }
        cfg.weights = layout::normalize_weights(None, next.len());
        cfg.panes = next;
        Ok(serde_json::json!({ "ok": true }))
    })
}

#[tauri::command]
pub fn layout_single(app: AppHandle, id: String) {
    mutate(&app, |cfg| {
        if cfg.get_service(&id).is_none() {
            return;
        }
        cfg.panes = vec![id.clone()];
        cfg.weights = layout::normalize_weights(None, 1);
        cfg.active_id = id.clone();
    });
}

/// 交换两个格子里的服务（拖一个格子到另一个格子上）。
///
/// 只换内容不动布局：格子的位置和大小都不变，就是里面的服务对调。
/// 这是田字格里最常用的操作——「我想让这两个换个位置」。
#[tauri::command]
pub fn layout_swap(app: AppHandle, a: usize, b: usize) -> CmdResult<serde_json::Value> {
    mutate(&app, move |cfg| {
        let n = cfg.panes.len();
        if a >= n || b >= n {
            return Err("格子编号超出范围".to_string());
        }
        if a == b {
            return Ok(serde_json::json!({ "ok": true }));
        }
        cfg.panes.swap(a, b);
        // 权重跟着一起换，否则两栏宽度会对调，看起来像是布局炸了
        if cfg.weights.len() == n {
            cfg.weights.swap(a, b);
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

/// 把某个服务放进指定格子。
///
/// index 等于当前栏数时表示「追加一个新格子」，小于栏数则是替换那一格。
/// 拖拽分屏统一走这一个命令，前端不用自己算 panes 数组怎么拼。
#[tauri::command]
pub fn layout_place(app: AppHandle, id: String, index: usize) -> CmdResult<serde_json::Value> {
    mutate(&app, move |cfg| {
        if cfg.get_service(&id).is_none() {
            return Err("找不到这个服务".to_string());
        }
        let n = cfg.panes.len();
        let dup = cfg.panes.iter().position(|p| p == &id);

        if index < n {
            // 放进已有格子
            if dup == Some(index) {
                return Ok(serde_json::json!({ "ok": true })); // 原地放回
            }
            match dup {
                // 已经在别的格子里 = 两格互换，而不是让它占两格
                Some(from) => cfg.panes.swap(from, index),
                None => cfg.panes[index] = id.clone(),
            }
        } else {
            // 追加新格子
            if dup.is_none() && n >= MAX_PANES {
                return Err(format!("最多同时显示 {MAX_PANES} 栏"));
            }
            if let Some(from) = dup {
                // 已经在屏幕上了，挪到最后一格而不是新增
                let svc = cfg.panes.remove(from);
                cfg.panes.push(svc);
            } else {
                cfg.panes.push(id.clone());
            }
            let count = cfg.panes.len();
            cfg.weights = layout::normalize_weights(None, count);
        }
        cfg.active_id = id.clone();
        Ok(serde_json::json!({ "ok": true, "panes": cfg.panes.clone() }))
    })
}

/// 把某个格子从布局里移除（缩回更少的栏数）。
#[tauri::command]
pub fn layout_remove_pane(app: AppHandle, index: usize) -> CmdResult<serde_json::Value> {
    mutate(&app, move |cfg| {
        if cfg.panes.len() <= 1 {
            return Err("至少要留一栏".to_string());
        }
        if index >= cfg.panes.len() {
            return Err("格子编号超出范围".to_string());
        }
        cfg.panes.remove(index);
        let count = cfg.panes.len();
        cfg.weights = layout::normalize_weights(None, count);
        if !cfg.panes.contains(&cfg.active_id) {
            cfg.active_id = cfg.panes[0].clone();
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

#[tauri::command]
pub fn layout_equalize(app: AppHandle) {
    mutate(&app, |cfg| {
        cfg.weights = layout::normalize_weights(None, cfg.panes.len());
    });
}

/// 拖动分隔条。高频调用：只重排、不存盘、不广播（松手时才落盘）。
#[tauri::command]
pub fn layout_drag(app: AppHandle, index: usize, x: f64) {
    let width = {
        let Some(window) = app.get_window(MAIN_WINDOW) else { return };
        let Ok(size) = window.inner_size() else { return };
        let scale = window.scale_factor().unwrap_or(1.0);
        (size.width as f64 / scale).round() as i32
    };
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().expect("config 锁中毒");
        let Some(next) = layout::drag_divider(width, &cfg.weights, index, x) else {
            return;
        };
        cfg.weights = next;
    } // 放锁再去碰窗口
    request_layout(&app);
}

#[tauri::command]
pub fn layout_drag_end(app: AppHandle) {
    mutate(&app, |_cfg| {});
}

#[tauri::command]
pub fn pane_focus(app: AppHandle, id: String) {
    mutate_quiet(&app, |cfg| {
        if cfg.panes.contains(&id) {
            cfg.active_id = id.clone();
        }
    });
}

// ---------------------------------------------------------------------------
// 服务管理
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ServiceInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
}

fn slugify(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { format!("svc{}", std::process::id()) } else { s }
}

#[tauri::command]
pub fn services_add(app: AppHandle, input: ServiceInput) -> CmdResult<serde_json::Value> {
    let url = input.url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("网址必须以 http:// 或 https:// 开头".into());
    }
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    mutate(&app, move |cfg| {
        let base = slugify(&name);
        let mut id = base.clone();
        let mut n = 2;
        while cfg.services.iter().any(|s| s.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        cfg.services.push(Service {
            id: id.clone(),
            name,
            url,
            color: input.color,
            icon: input.icon,
            custom: true,
            hidden: false,
        });
        Ok(serde_json::json!({ "ok": true, "id": id }))
    })
}

#[tauri::command]
pub fn services_update(app: AppHandle, input: ServiceInput) -> CmdResult<serde_json::Value> {
    let Some(id) = input.id.clone() else {
        return Err("缺少 id".into());
    };
    mutate(&app, move |cfg| {
        let Some(svc) = cfg.services.iter_mut().find(|s| s.id == id) else {
            return Err("找不到这个服务".to_string());
        };
        let name = input.name.trim();
        if !name.is_empty() {
            svc.name = name.to_string();
        }
        let url = input.url.trim();
        if url.starts_with("http") {
            svc.url = url.to_string();
        }
        if !input.color.is_empty() {
            svc.color = input.color.clone();
        }
        if !input.icon.is_empty() {
            svc.icon = input.icon.clone();
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

#[tauri::command]
pub fn services_remove(app: AppHandle, id: String, wipe: Option<bool>) -> CmdResult<serde_json::Value> {
    // 先把视图拆掉（要碰窗口，所以在拿配置锁之前做）
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        views::destroy(&window, &mut mgr, &id);
    }
    let wipe = wipe.unwrap_or(false);
    mutate(&app, move |cfg| {
        if cfg.services.len() <= 1 {
            return Err("至少要留一个服务".to_string());
        }
        cfg.services.retain(|s| s.id != id);
        cfg.panes.retain(|p| p != &id);
        cfg.last_urls.remove(&id);
        if wipe && !cfg.pending_wipe.contains(&id) {
            // 目录正被 WebView2 占着，删不掉；记下来，下次启动时清
            cfg.pending_wipe.push(id.clone());
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

#[tauri::command]
pub fn services_set_hidden(app: AppHandle, id: String, hidden: bool) -> CmdResult<serde_json::Value> {
    mutate(&app, move |cfg| {
        if hidden && cfg.visible_services().len() <= 1 {
            return Err("标签栏上至少要留一个".to_string());
        }
        if let Some(svc) = cfg.services.iter_mut().find(|s| s.id == id) {
            svc.hidden = hidden;
        }
        if hidden {
            cfg.panes.retain(|p| p != &id);
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

#[tauri::command]
pub fn services_reorder(app: AppHandle, ids: Vec<String>) -> CmdResult<serde_json::Value> {
    mutate(&app, move |cfg| {
        let mut ordered: Vec<Service> = Vec::with_capacity(cfg.services.len());
        for id in &ids {
            if let Some(svc) = cfg.services.iter().find(|s| &s.id == id) {
                ordered.push(svc.clone());
            }
        }
        // 没出现在新顺序里的（被收起的那些）按原顺序接在后面，一个都不能丢
        for svc in &cfg.services {
            if !ordered.iter().any(|s| s.id == svc.id) {
                ordered.push(svc.clone());
            }
        }
        cfg.services = ordered;
        Ok(serde_json::json!({ "ok": true }))
    })
}

// ---------------------------------------------------------------------------
// 偏好
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn config_set_preload(app: AppHandle, on: bool) -> serde_json::Value {
    mutate_quiet(&app, |cfg| cfg.preload = on);
    serde_json::json!({ "ok": true, "preload": on })
}

#[tauri::command]
pub fn config_get_preload(app: AppHandle) -> bool {
    app.state::<AppState>().snapshot().preload
}

#[derive(Deserialize)]
pub struct HibernateInput {
    pub enabled: Option<bool>,
    pub minutes: Option<u32>,
}

#[tauri::command]
pub fn config_set_hibernate(app: AppHandle, input: HibernateInput) -> serde_json::Value {
    mutate_quiet(&app, |cfg| {
        if let Some(on) = input.enabled {
            cfg.hibernate.enabled = on;
        }
        if let Some(m) = input.minutes {
            if config::HIBERNATE_CHOICES.contains(&m) {
                cfg.hibernate.minutes = m;
            }
        }
    });
    let cfg = app.state::<AppState>().snapshot();
    serde_json::json!({ "ok": true, "enabled": cfg.hibernate.enabled, "minutes": cfg.hibernate.minutes })
}

#[tauri::command]
pub fn config_set_theme(app: AppHandle, theme: String) -> serde_json::Value {
    let ok = ["dark", "light", "system"].contains(&theme.as_str());
    if ok {
        mutate_quiet(&app, |cfg| cfg.theme = theme.clone());
    }
    serde_json::json!({ "ok": ok })
}

#[derive(Deserialize)]
pub struct HotkeyInput {
    pub enabled: Option<bool>,
    pub accelerator: Option<String>,
    pub action: Option<String>,
    #[serde(rename = "pinTop")]
    pub pin_top: Option<bool>,
    #[serde(rename = "closeToTray")]
    pub close_to_tray: Option<bool>,
    pub tray: Option<bool>,
}

#[tauri::command]
pub fn config_set_hotkey(app: AppHandle, input: HotkeyInput) -> serde_json::Value {
    mutate_quiet(&app, |cfg| {
        if let Some(v) = input.enabled { cfg.hotkey.enabled = v; }
        if let Some(v) = &input.accelerator {
            if !v.trim().is_empty() { cfg.hotkey.accelerator = v.trim().to_string(); }
        }
        if let Some(v) = &input.action {
            if ["toggle", "show"].contains(&v.as_str()) { cfg.hotkey.action = v.clone(); }
        }
        if let Some(v) = input.pin_top { cfg.hotkey.pin_top = v; }
        if let Some(v) = input.close_to_tray { cfg.hotkey.close_to_tray = v; }
        if let Some(v) = input.tray { cfg.hotkey.tray = v; }
    });
    let cfg = app.state::<AppState>().snapshot();
    // 改完立刻重新注册，否则设置里改了键位却还是老的在生效。
    // 注册失败的原因要回传给前端显示——被别的程序占用是很常见的情况。
    let error = crate::register_hotkey(&app, &cfg.hotkey.accelerator, cfg.hotkey.enabled);
    serde_json::json!({ "ok": error.is_none(), "hotkey": cfg.hotkey, "error": error })
}

#[tauri::command]
pub fn config_get_hotkey(app: AppHandle) -> serde_json::Value {
    serde_json::json!(app.state::<AppState>().snapshot().hotkey)
}

// ---------------------------------------------------------------------------
// 功能 1：常驻置顶
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_set_always_on_top(app: AppHandle, on: bool) -> serde_json::Value {
    mutate_quiet(&app, |cfg| cfg.always_on_top = on);
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        // Windows 上这条走 SetWindowPos(HWND_TOPMOST)，是系统层面的置顶
        let _ = window.set_always_on_top(on);
    }
    serde_json::json!({ "ok": true, "alwaysOnTop": on })
}

// ---------------------------------------------------------------------------
// 功能 2：标签栏收起 / 显示
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_set_tab_bar(app: AppHandle, visible: bool) -> serde_json::Value {
    // 改完要重排：站点视图的顶边从 44 变成 0（或反过来）
    mutate(&app, |cfg| cfg.tab_bar_visible = visible);
    serde_json::json!({ "ok": true, "tabBarVisible": visible })
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_summon(app: AppHandle) {
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn window_hide(app: AppHandle) {
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
}

/// 设置面板开合：打开时所有站点视图让位，外壳整窗露出来。
#[tauri::command]
pub fn ui_overlay(app: AppHandle, open: bool) {
    {
        let state = app.state::<AppState>();
        let mut mgr = state.views.lock().expect("views 锁中毒");
        mgr.overlay_open = open;
    }
    request_layout(&app);
}

// ---------------------------------------------------------------------------
// 功能 3：更新
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateInfo {
    let current = app.package_info().version.to_string();
    use tauri_plugin_updater::UpdaterExt;
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => UpdateInfo {
                available: true,
                current,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
                error: None,
            },
            Ok(None) => UpdateInfo { available: false, current, version: None, notes: None, error: None },
            Err(err) => UpdateInfo {
                available: false, current, version: None, notes: None,
                error: Some(err.to_string()),
            },
        },
        Err(err) => UpdateInfo {
            available: false, current, version: None, notes: None,
            error: Some(err.to_string()),
        },
    }
}

/// 强制更新：下载 -> 亲手拆掉所有 webview -> 安装 -> 重启。
///
/// 这就是用户截图里那个「Aihub 无法关闭，请手动关闭它」要解决的问题。
/// Electron 版的死法是：NSIS 起来时进程还活着，安装器只能弹框求用户自己关。
/// 这里的顺序是反过来的——**先把自己拆干净，再让安装器上场**：
///   1. 关掉每一个站点 webview（它们各自带着 WebView2 子进程）
///   2. 关主窗口
///   3. 再调 install()，此时已经没有东西占着安装目录了
#[tauri::command]
pub async fn update_install(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "当前已是最新版本".to_string())?;

    let _ = app.emit("update:progress", serde_json::json!({ "phase": "downloading" }));
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("下载失败：{e}"))?;

    let _ = app.emit("update:progress", serde_json::json!({ "phase": "closing" }));
    close_everything(&app);

    update.install(bytes).map_err(|e| format!("安装失败：{e}"))?;
    app.restart();
}

/// 把所有 webview 和窗口拆干净，让安装器能独占安装目录。
///
/// `close()` 只是发出关闭请求，WebView2 的子进程（msedgewebview2.exe）是异步退出的。
/// 如果不等它们真的死掉就调 install()，NSIS 会发现目标目录仍被占用，
/// 于是弹出「Aihub 无法关闭。请手动关闭它，然后单击重试以继续。」
/// —— 这正是这次要修掉的那个对话框。
fn close_everything(app: &AppHandle) {
    if let Some(window) = app.get_window(MAIN_WINDOW) {
        let config = app.state::<AppState>().snapshot();
        for svc in &config.services {
            if let Some(view) = window.get_webview(&view_label(&svc.id)) {
                let _ = view.close();
            }
        }
        if let Some(shell) = window.get_webview(views::SHELL_LABEL) {
            let _ = shell.close();
        }
        let _ = window.close();
    }

    // 等 WebView2 子进程真的退干净。轮询而不是死等一个固定时长：
    // 站点少的时候几百毫秒就好了，没必要让每个用户都卡满 5 秒。
    wait_for_webviews_to_exit(std::time::Duration::from_secs(5));
}

/// 轮询等待 WebView2 子进程退出，最多等 timeout。
///
/// 超时也继续往下走：装不上会由安装器自己报错，总好过卡在这里不动。
#[cfg(windows)]
fn wait_for_webviews_to_exit(timeout: std::time::Duration) {
    use std::time::Instant;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let still_running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq msedgewebview2.exe", "/NH"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains("msedgewebview2"))
            .unwrap_or(false);
        if !still_running {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("[aihub] WebView2 子进程在超时前没退干净，仍继续安装");
}

#[cfg(not(windows))]
fn wait_for_webviews_to_exit(timeout: std::time::Duration) {
    // macOS 的 WKWebView 跟进程绑在一起，窗口关掉就没了，给它一点时间即可
    std::thread::sleep(timeout.min(std::time::Duration::from_millis(500)));
}

/// 内置站点目录里，当前还没加到标签栏上的那些。
///
/// 「添加 AI」面板用它填列表。判重按 id：用户自己删掉过的内置站点
/// 会重新出现在这里，这是对的——删了之后应该能再加回来。
#[tauri::command]
pub fn services_available(app: AppHandle) -> Vec<Service> {
    let config = app.state::<AppState>().snapshot();
    crate::services::default_services()
        .into_iter()
        .filter(|def| !config.services.iter().any(|s| s.id == def.id))
        .collect()
}

/// 把内置目录里的某个站点加到标签栏上。
#[tauri::command]
pub fn services_add_builtin(app: AppHandle, id: String) -> CmdResult<serde_json::Value> {
    let Some(def) = crate::services::default_services().into_iter().find(|s| s.id == id) else {
        return Err("这不是一个内置站点".into());
    };
    mutate(&app, move |cfg| {
        if let Some(existing) = cfg.services.iter_mut().find(|s| s.id == def.id) {
            // 之前被「从标签栏收起」了，放回来即可，别建第二份（登录态还在）
            existing.hidden = false;
        } else {
            cfg.services.push(def.clone());
        }
        Ok(serde_json::json!({ "ok": true, "id": def.id }))
    })
}

/// 调试用：在外壳 webview 里执行一段 JS。
///
/// 只在 debug 构建里存在。用来在真机上驱动前端逻辑做验证——
/// 合成鼠标事件（mouse_event）触发不了 Chromium 的 HTML5 拖放，
/// 靠模拟输入没法自动化测拖拽分屏，只能这样直接调函数。
#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_eval(app: AppHandle, js: String, target: Option<String>) -> CmdResult<String> {
    use std::sync::mpsc::channel;

    let window = app.get_window(MAIN_WINDOW).ok_or("没有主窗口")?;
    // 默认打外壳；传 target 就打那个站点的 webview（验证站点侧的行为时要用）
    let label = target
        .map(|id| views::view_label(&id))
        .unwrap_or_else(|| views::SHELL_LABEL.to_string());
    let shell = window
        .get_webview(&label)
        .ok_or_else(|| format!("找不到 webview: {label}"))?;

    let (tx, rx) = channel();
    shell
        .eval_with_callback(js, move |res| { let _ = tx.send(res); })
        .map_err(|e| e.to_string())?;
    // 留足时间给异步脚本跑完（拖拽测试里有 await）
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "脚本没有在 10 秒内回传结果".to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// 尚未迁移的能力：明说，不要静默失败
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn login_export(_password: String) -> CmdResult<serde_json::Value> {
    Err("登录态导出尚未迁移到 Tauri 版：WebView2 的 cookie 存储格式与 Electron 不同，需要重做".into())
}

#[tauri::command]
pub fn login_import(_options: serde_json::Value) -> CmdResult<serde_json::Value> {
    Err("登录态导入尚未迁移到 Tauri 版：WebView2 的 cookie 存储格式与 Electron 不同，需要重做".into())
}

#[tauri::command]
pub fn ui_split_menu(_point: serde_json::Value) -> CmdResult<serde_json::Value> {
    // 原生右键菜单待接 Tauri 的 menu API；先让前端退回自绘菜单
    Ok(serde_json::json!({ "ok": false, "fallback": "html" }))
}

#[tauri::command]
pub fn ui_shell_menu(_point: serde_json::Value) -> CmdResult<serde_json::Value> {
    Ok(serde_json::json!({ "ok": false, "fallback": "html" }))
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_get_state, app_open_external, app_quit, app_version,
        tab_activate, tab_reload, tab_reload_hard, tab_home, tab_devtools, tab_zoom,
        layout_get, layout_set_panes, layout_single, layout_equalize,
        layout_swap, layout_place, layout_remove_pane,
        layout_drag, layout_drag_end, pane_focus,
        services_add, services_update, services_remove, services_set_hidden, services_reorder,
        config_set_preload, config_get_preload, config_set_hibernate,
        config_set_theme, config_set_hotkey, config_get_hotkey,
        services_available, services_add_builtin,
        #[cfg(debug_assertions)]
        debug_eval,
        window_set_always_on_top, window_set_tab_bar,
        window_summon, window_hide, ui_overlay,
        update_check, update_install,
        login_export, login_import, ui_split_menu, ui_shell_menu,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_makes_safe_ids() {
        assert_eq!(slugify("My Bot"), "my-bot");
        assert_eq!(slugify("ChatGPT!!!"), "chatgpt");
        assert_eq!(slugify("  Foo  Bar "), "foo--bar");
    }

    #[test]
    fn slugify_never_returns_empty() {
        // 纯中文名会被全部替换成分隔符，不能塌成空串——否则会生成一个没有 id 的服务
        assert!(!slugify("智谱").is_empty());
        assert!(!slugify("---").is_empty());
        assert!(!slugify("").is_empty());
    }
}
