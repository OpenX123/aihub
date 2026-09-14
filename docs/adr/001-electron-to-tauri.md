# ADR-001：从 Electron 迁移到 Tauri

- 状态：已采纳
- 日期：2026-09-14

## 背景

Electron 版的 Windows 安装包 113.6 MB，装完占盘 373 MB。其中 99.8% 是 Electron
自带的 Chromium + Node 运行时——应用自己的代码（main.js + index.html + preload.js）
加起来只有约 270 KB。

实测构成：

| 文件 | 体积 |
|---|---|
| `Aihub.exe`（Chromium 主体） | 235 MB |
| `locales/`（55 种语言） | 49 MB |
| `dxcompiler.dll` | 25 MB |
| `LICENSES.chromium.html` | 20 MB |
| `resources.pak` | 12 MB |
| `icudtl.dat` | 11 MB |

## 决策

迁到 Tauri v2，用系统自带的 WebView2 代替打包进去的 Chromium。

## 代价（都是不可回退的）

### 1. 登录态必须重新登录一次

**这是最疼的一条。** Electron 把每个站点的登录态存在
`userData/Partitions/<id>`（Chromium 分区格式），Tauri 走 WebView2 的用户数据目录，
两者的 cookie 存储格式和加密方式都不同，没有可靠的转换路径。

所以 Tauri 版刻意把数据目录换成 `%APPDATA%/Aihub/WebViews/<id>`，
和 Electron 的 `Partitions/` 分开——放一起只会互相污染。

`config.json` 是同一个文件、同一套字段，所以**服务列表、分屏布局、主题、快捷键
全部能继承**，用户只需要重新登录。

### 2. 分屏踩在 unstable 特性上

一个窗口挂多个 webview 在 Tauri 里仍然锁在 `features = ["unstable"]` 后面
（截至 tauri 2.11.5）。已知未修的 bug：

- [tauri#10420](https://github.com/tauri-apps/tauri/issues/10420) webview 定位错乱
- [tauri#10131](https://github.com/tauri-apps/tauri/issues/10131) 反复缩放后宽度不跟手
- [tauri#11170](https://github.com/tauri-apps/tauri/issues/11170) 最大化还原后位置丢失

**缓解措施**：不依赖 `auto_resize`，每个窗口事件都用 `compute_geometry()`
重算一遍绝对坐标压回去（见 `src-tauri/src/lib.rs` 的 resize 处理）。
布局几何是纯函数且有 11 个单测锁着，升级 Tauri 后先跑 `cargo test`。

### 3. macOS 最低版本抬到 14.0

`data_directory`（每站独立登录态的根基）在 WKWebView 上不存在，macOS 要用
`data_store_identifier`，而它**只支持 macOS ≥ 14**。macOS 13 及以下会失去会话隔离，
所以直接把 `minimumSystemVersion` 设成 14.0，不让它们装上一个登录态会串的版本。

### 4. macOS 渲染引擎从 Chromium 换成 WKWebKit

ChatGPT / Claude / Gemini 都是重前端 SPA，渲染差异无法在应用侧修复——那是系统的 webview。
Windows 上反而是收益：WebView2 的 UA 本来就是 Edge，Electron 版
`stripElectronUA()` 那个 hack 可以删掉，被站点风控的概率更低。

### 5. 两个能力暂时缺失

- **登录态导出/导入**：命令还在，但会明确抛错说「尚未迁移」，而不是静默失败
- **原生右键菜单**：返回 `{ok:false, fallback:'html'}`，前端退回自绘菜单

## 收益

| | 安装包 | 装完占盘 |
|---|---|---|
| Electron | 113.6 MB | 373 MB |
| Tauri（`downloadBootstrapper`） | 约 6~12 MB | 约 15~25 MB |

代价是 WebView2 运行时不再由应用携带，靠系统那份。Win11 自带，Win10 靠 Edge 铺过去了，
但国内精简版 / LTSC 机器不保证有——那些机器会在首次安装时去微软下载。
**本质是把 100 MB 的成本从安装包转移到了用户的操作系统上。**

想彻底不依赖网络得用 `offlineInstaller`（+127 MB），那比 Electron 版还大，不采纳。

## 架构上的一条硬纪律

`Window::add_child` 的实现是「把任务派到主线程 + 阻塞 `rx.recv()` 等结果」。
**从主线程调用它就是自己等自己，永久死锁。** 迁移过程中真实踩到过这个坑：
`setup()` 里同步调 `relayout()`，应用启动后卡在白屏。

因此：

1. 所有布局都从一条**专用后台线程**驱动（`LayoutQueue`），主线程只投单子
2. `apply_layout` 拆成 `plan_layout`（持锁纯计算）+ `execute_plan`（放锁后碰窗口）

新增任何会创建 / 移动 webview 的代码，都必须遵守这两条。
