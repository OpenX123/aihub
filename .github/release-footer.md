<!-- 这段会追加到每次自动发布的 Release 说明后面（见 .github/workflows/build.yml） -->

## 下载

| 平台 | 文件 |
| --- | --- |
| Windows 10 / 11（x64） | `Aihub-<版本>-setup.exe` —— 双击安装，一键完成，不需要管理员权限 |
| macOS（Apple Silicon / M 系列，需要 macOS 13+） | `Aihub-<版本>-mac-arm64.dmg` —— 拖进「应用程序」；`.zip` 是同内容的备用包 |

## 首次打开会被系统拦一下（这个版本还没有代码签名）

**Windows**：SmartScreen 提示「已保护你的电脑」→ 点「更多信息」→「仍要运行」。
一键装、装完桌面和开始菜单都有快捷方式；`%APPDATA%\Aihub` 里的登录态和配置在卸载后不会被删。

**macOS**：Gatekeeper 提示「无法验证开发者」→ 二选一：
① 在「应用程序」里 **右键点 Aihub → 打开 → 仍要打开**（只需要做一次）；
② 或者在终端执行 `xattr -dr com.apple.quarantine /Applications/Aihub.app`。

> 打包时会给 `.app` 补一次 ad-hoc 签名（Apple Silicon 上没有签名根本起不来），
> 但没有做 Apple 公证；想要双击直接打开需要一个 Apple 开发者账号，暂时没有。

## 校验

- 安装包在本仓库的 GitHub Actions 里自动构建，产物可在对应工作流运行的 **Artifacts** 里核对
- 应用的完整功能自检（会真的开窗口加载各家站点，259 项）在本地跑：`npm start` 前设 `AIHUB_SMOKE=1`
