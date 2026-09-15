//! macOS 专用的窗口修正：把内容区拉回系统标题栏下方。
//!
//! ## 为什么要这么干
//!
//! Tauri 在 macOS 上建窗口走 `TitleBarStyle::Visible`，而 tauri-runtime-wry
//! 在这一支里顺手打开了 `NSWindowStyleMaskFullSizeContentView`
//! （为了绕开 tauri#3914：开着 devtools 缩放窗口会渲染错位）。
//!
//! 打开之后，窗口的**内容视图是铺满整个窗口框的**，可系统标题栏还是那条
//! 不透明的：它直接压在窗口内容顶上。本应用因此有两个症状（Windows 上
//! 内容区本来就在标题栏下方，所以只有 mac 会这样）：
//!
//! - 外壳那条 44px 的标签栏从窗口顶边开始画，顶上约 28px 被标题栏盖住，
//!   整条只露出最下面十几 px；
//! - 收起标签栏之后站点页面从 y=0 开始，页面自己的顶栏同样被盖掉 28px，
//!   而且那 28px 的点击全被标题栏吃掉。
//!
//! ## 修法
//!
//! 窗口建好、webview 还没建之前，把这一位从 styleMask 里摘掉。AppKit 随即
//! 把内容视图缩到标题栏下方，窗口在屏幕上占的框大小不变——那 28px 本来也
//! 不属于内容区（被标题栏盖着），现在只是账对上了：标签栏完整露出来，
//! 页面顶部 44px 里也不再有「看着在、点不到」的死区。
//!
//! 代价：tauri#3914 那个「开着 devtools 缩放错位」的老问题会回来。
//! 只在开着 devtools 时才有，日常使用无感；要调页面时把下面这个调用
//! 临时注掉即可。

use objc2_app_kit::{NSWindow, NSWindowStyleMask};

/// 摘掉窗口的 FullSizeContentView 位。
///
/// 返回 `true` 表示确实摘了（原来带着这一位）。没带就是无事发生。
pub fn pin_content_below_titlebar(window: &tauri::Window) -> tauri::Result<bool> {
    // ns_window() 给的是窗口存活期间有效的 NSWindow 指针。AppKit 的对象只能
    // 在主线程碰，而这个函数是在 setup 里调的——Tauri 保证 setup 跑在主线程上。
    let ns_window = window.ns_window()? as *mut NSWindow;
    // SAFETY: 主线程 + 窗口此刻一定还活着（刚 build 出来）。
    let ns_window = unsafe { &*ns_window };

    let mask = ns_window.styleMask();
    if !mask.contains(NSWindowStyleMask::FullSizeContentView) {
        return Ok(false);
    }
    ns_window.setStyleMask(mask & !NSWindowStyleMask::FullSizeContentView);
    Ok(true)
}
