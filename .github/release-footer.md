<!-- 这段会追加到每次自动发布的 Release 说明后面（见 .github/workflows/build-tauri.yml） -->

## ⚠️ 从 v0.2.x 升级：要重新登录一次

v0.3.0 把运行时从 Electron 换成了 Tauri，用系统自带的 WebView2 代替打包进去的 Chromium。
**安装包从 113 MB 降到约 2 MB，装完占盘从 373 MB 降到 5 MB 左右。**

代价是**各站点要重新登录一次**：旧版的登录态存在 Chromium 的分区格式里，新版走 WebView2，
两者的 cookie 存储格式和加密方式都不同，没有可靠的转换路径。

| | |
| --- | --- |
| **能继承** | 服务列表（含你自己加的站点）、分屏布局、外观主题、全局快捷键、休眠设置 |
| **要重做** | 每个站点登录一次 |

配置文件还是同一个 `%APPDATA%\Aihub\config.json`，升级时会自动从 v3 迁到 v4，不用手动改任何东西。

## 下载

| 平台 | 文件 |
| --- | --- |
| Windows 10 / 11（x64） | `Aihub_<版本>_x64-setup.exe` —— 双击安装，不需要管理员权限 |
| macOS（Apple Silicon，**需要 macOS 14+**） | `Aihub_<版本>_aarch64.dmg` —— 拖进「应用程序」 |

> **Windows 需要 WebView2 运行时**：Win11 自带，Win10 基本随 Edge 装过了。
> 极少数精简版 / LTSC 系统上，安装器会自动去微软下载（需要联网，约 1 分钟）。
> 这就是包能缩到 2 MB 的原因——运行时不再由应用携带。
>
> **macOS 最低版本从 13 抬到了 14**：每站独立登录态在 mac 上依赖 `data_store_identifier`，
> 这个 API 只有 macOS 14+ 才有。13 及以下装上会出现登录态互串，所以直接挡住了。

## 首次打开会被系统拦一下（这个版本还没有代码签名）

**Windows**：SmartScreen 提示「已保护你的电脑」→ 点「更多信息」→「仍要运行」。
`%APPDATA%\Aihub` 里的登录态和配置在卸载后不会被删。

**macOS**：Gatekeeper 提示「无法验证开发者」→ 二选一：
① 在「应用程序」里 **右键点 Aihub → 打开 → 仍要打开**（只需要做一次）；
② 或者在终端执行 `xattr -dr com.apple.quarantine /Applications/Aihub.app`。

## 校验

- 安装包在本仓库的 GitHub Actions 里自动构建，产物可在对应工作流运行的 **Artifacts** 里核对
- `latest.json` 是自动更新的更新源，每个包都带配套的 `.sig` 签名文件
