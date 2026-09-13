# Aihub

[![CI](https://github.com/OpenX123/aihub/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenX123/aihub/actions/workflows/ci.yml)
[![Build](https://github.com/OpenX123/aihub/actions/workflows/build.yml/badge.svg)](https://github.com/OpenX123/aihub/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20·%20macOS%20(Apple%20Silicon)-0078d4.svg)](#0-安装)
[![Electron](https://img.shields.io/badge/Electron-44-47848f.svg)](https://www.electronjs.org/)

<img src="assets/brand/logo.png" alt="Aihub" width="420" />

把 DeepSeek、ChatGPT、Claude、豆包、Kimi、智谱 GLM、Gemini 等网页版 AI 应用聚合到一个窗口里，
用顶部标签切换，**每个服务的登录态各自独立保存、下次启动保持登录**，
最后可以打包成双击即装的 Windows `.exe`，或者 macOS（Apple Silicon）的 `.dmg`。

内置站点：**DeepSeek / ChatGPT / Claude / 豆包 / Kimi / 智谱 GLM / Gemini**，
每个都自带一份本地 logo（不依赖网站 favicon，也不用点开才显示），
想加别家（通义、元宝、文心、Grok、Mistral……）在设置里「填名字 + 网址」就行，
常见站点会自动配上对应的内置图标。

技术路线是「网页套壳」：不使用官方 API，直接嵌入各家网页，所以功能、界面永远和官网一致，
也不需要自己维护模型适配。

<img width="2237" height="1550" alt="image" src="https://github.com/user-attachments/assets/d41b897d-a8af-4bc9-9881-bea3b2b0b1b5" />

> 每个站点都是独立加载的原生视图（不是把网页塞进同一个页面里渲染），
> 所以各家的登录态、Cookie、缓存天生就是隔开的。

> 开源（MIT）。内置的各家 logo 是各自公司的商标，本项目只用于标识服务入口，见 [NOTICE.md](NOTICE.md)。

---

## 0. 安装

**方式一：直接装（推荐）**

到 [Releases](https://github.com/OpenX123/aihub/releases) 下载对应平台的安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `Aihub-x.y.z-setup.exe` | 一键安装，不需要管理员权限，装完桌面和开始菜单都有快捷方式 |
| macOS（Apple Silicon / M 系列） | `Aihub-x.y.z-mac-arm64.dmg` | 拖进「应用程序」即可；另有 `.zip` 版备用 |

> **Windows**：没有代码签名证书，SmartScreen 可能提示「已保护你的电脑」——
> 点「更多信息 → 仍要运行」即可。
>
> **macOS**：同样没有签名和公证，首次打开会被 Gatekeeper 拦下。
> 两种办法任选：① 在「应用程序」里 **右键点 Aihub → 打开 → 仍要打开**（只需一次）；
> ② 或者执行 `xattr -dr com.apple.quarantine /Applications/Aihub.app`。
> 打包脚本会补一次 ad-hoc 签名（Apple Silicon 上不加签名的 app 根本起不来），
> 但去公证需要 Apple 开发者账号，暂时没有做。

**方式二：从源码跑**

```bash
git clone https://github.com/OpenX123/aihub.git
cd aihub
npm install          # 安装依赖
npm start            # 启动

npm run dist         # Windows：打成 NSIS 安装包（产物在 dist/）
npm run dist:mac     # macOS：打成 dmg + zip（arm64，必须在 macOS 上跑）
```

**方式三：让 GitHub 帮你构建**

推送到 `main` 或提 PR 时，[Build 工作流](.github/workflows/build.yml) 会自动同时构建
Windows x64 和 macOS arm64 两个平台，产物挂在这次运行的 **Artifacts** 里（保留 30 天）。

想发一个正式版本：把 `package.json` 里的 `version` 改好，然后推一个同名的标签：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

两个平台的安装包会自动构建并挂到对应的 Release 上（已存在同名 Release 则覆盖其中的文件）。

---

## 1. 快速开始

```powershell
npm install          # 安装依赖
npm start            # 启动
```

> **首次 `npm start` 会先下载 Electron 二进制（约 100MB）。**
> Electron 从 44 版起不再通过 `postinstall` 自动下载，而是在第一次运行 `electron .` 时按需下载。
> 国内网络直连 GitHub 容易失败（报 `fetch failed`），先设置镜像再启动：
>
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> npm start
> ```
>
> 想提前手动装好二进制，也可以执行 `npx install-electron --no`。

---

## 2. 常用操作

| 操作 | 方式 |
| --- | --- |
| **唤出 / 收起窗口（全局）** | **`Alt+Space`**：系统级快捷键，任何程序在前面时按下都能把窗口拉到最前（连别的程序的全屏也压得住）；窗口已经在前面时再按一次收进后台。可在 ⚙ 里改成别的组合键或关掉 |
| 切换标签 | 点击标签，或 `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 直达第 N 个标签 | `Ctrl+1` ~ `Ctrl+9` |
| 刷新当前标签 | `F5`（`Shift+F5` 强制刷新，忽略缓存） |
| 返回该服务首页 | 标签栏右侧 ⌂ |
| 打开开发者工具 | `F12`（独立窗口，排查登录问题很有用） |
| 打开设置面板 | `Ctrl+,`（或标签栏右侧 ⚙） |
| 页面缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| 添加 / 删除服务 | 标签栏右侧 ⚙，「填名字 + 网址」即可 |
| 标签 logo | 每个标签自带内置 logo，**不用点开也有**；没内置图的站点用网站的 favicon 或彩色圆点 |
| 启动时预加载 | 默认开启：启动后把所有标签的页面依次加载，标题和 logo 自己出现。⚙ 设置里可关掉（省内存/流量） |
| 加入 / 移出分屏 | 标签栏右侧 ⇔ 勾选服务，或**右键点标签**切换 |
| 换外观主题 | ⚙ 设置 →「外观主题」→ 深色 / 浅色 / 跟随系统（只影响本应用的标签栏和设置面板） |
| 调整两栏宽度 | **直接拖动两栏之间的分隔条**（鼠标移到缝隙会变成左右箭头） |
| 两栏宽度均分 | **双击分隔条**，或 ⇔ 菜单里的「均分所有栏宽度」 |
| 回到单栏 | ⇔ 菜单里的「只显示当前标签」，或把其他栏的勾去掉 |
| 切换当前焦点栏 | 点击已在布局中的标签；或直接点某栏里的页面 |
| 导出登录信息 | ⚙ 设置 →「账号迁移」→「导出登录信息」，得到一个 JSON 文件 |
| 导入登录信息 | ⚙ 设置 →「账号迁移」→ 填上密码（如果导出时设了）→「导入登录信息」 |
| 中键点击标签 | 重新加载该标签 |
| 网页里右键 | 复制 / 粘贴 / 复制链接 / 复制图片 / 在浏览器打开 / 刷新 / 检查元素（服务页面里也能正常右键了） |
| 标签栏空白处右键 | 刷新、回到首页、切预加载、隐藏到后台、设置、开发者工具（菜单里也会写明当前唤出快捷键） |

标签栏右侧会显示当前页面的域名，方便确认登录时到底停在哪个站点。
已经在分屏里的标签会带上「第几栏」的小角标，⇔ 按钮上会显示当前栏数。
**选中的标签不加底色、不加侧边色条**，只把文字提亮加粗，标签栏整体保持干净。

### 右键菜单

Electron 默认**一个右键菜单都不给**，所以在服务页面里右键会像坏掉一样（复制、粘贴、
粘贴纯文本、检查元素全都没有）。这里给两层都补上了原生菜单（`Menu.popup`，和 ⇔ 菜单同一套做法）：

- **服务页面**：挂 `webContents.on('context-menu')`，按右键位置给对应动作 ——
  输入框里给撤销/重做/剪切/复制/粘贴/全选，选区给复制 + 搜索，链接给「浏览器打开 / 复制链接」，
  图片给「复制图片 / 打开图片」，最后永远有刷新、强制刷新、检查元素。
- **应用自己这一层**（标签栏 / 空白处）：渲染层发 `ui:shell-menu`，主进程弹
  「刷新 / 回到首页 / 启动时预加载（勾选）/ 外观主题 / 设置 / 开发者工具」。
  输入框里的右键不拦，交给同一套原生编辑菜单。
- **标签本身**的右键仍然是「加入 / 移出分屏」（这个监听里 `stopPropagation`，不会和上面冲突）。

### 外观主题（深色 / 浅色 / 跟随系统）

1. 设置面板里选主题，存在 `config.json` 的 `theme` 字段（`dark` / `light` / `system`）。
2. 主进程把它交给 Electron 的 `nativeTheme.themeSource`，于是窗口标题栏、滚动条、
   以及窗口页面里的 `prefers-color-scheme` 全都跟着变——所以渲染层只要用媒体查询写配色即可，
   不需要额外的主题类名，也没有「设置里切了但页面没跟上」这种同步问题。
3. 窗口页面（`index.html`）和加载失败页（`error.html`）的配色**全部走 CSS 变量**，
   浅色主题在 `@media (prefers-color-scheme: light)` 里覆盖一遍。标签栏、设置面板、
   分屏分隔条、Toast 都在内。
4. 服务页面本身的深浅色**不受这个开关控制**：那是各家网站自己的事情，
   它们各自跟随系统或自己的设置。所以「浅色主题」只让本应用的边框和面板变亮。
5. 主题切换时，服务视图的首帧底色也会跟着换（深色 `#12141a` / 浅色 `#ffffff`），
   免得出现大面积白闪或黑闪。
6. 浅色主题下面板、卡片、输入框一律**纯白（`#ffffff`）不透明**：半透明会透出后面的滚动内容，
   看着发灰。

### 动效规范（苹果那套「短、跟手、可打断」的节奏）

所有动效集中在一组令牌里，写在 `index.html` 的 `:root`，不允许在别处现编数值：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--dur-1` | `120ms` | 按压 / 悬浮反馈 |
| `--dur-2` | `180ms` | 小元素进出（提示条、淡入） |
| `--dur-3` | `240ms` | 面板、弹层 |
| `--dur-exit` | `150ms` | 退出（永远比进入短，感觉更跟手） |
| `--ease-out` | `cubic-bezier(.23, 1, .32, 1)` | 进入与退出 |
| `--ease-in-out` | `cubic-bezier(.77, 0, .175, 1)` | 原地形变 |
| `--ease-drawer` | `cubic-bezier(.32, .72, 0, 1)` | iOS 抽屉曲线（滑块、面板落位） |

几条硬规矩（自检会逐条断言，见「开发自检」）：

1. **只动 `transform` / `opacity`**：跳过布局与重绘，走 GPU 合成。绝不 `transition: width/height/top/left`，
   也绝不 `transition: all`。分隔条变粗用 `scaleX`，主题滑块用等宽格子 + `translateX`。
2. **UI 上永远不用 `ease-in`**：它起步慢，正好拖在你盯着的那一刻。
3. **进出同路**：设置面板从下方淡入、也向下方淡出；提示条从下方进来、也从下方出去。
4. **标签栏点得频繁，所以几乎不动画**：只有近乎察觉不到的颜色过渡和按压回弹（`scale(.97)`），
   不做位移。
5. **标签栏就地更新，不整条重建**：标题 / favicon / 加载状态来得非常频繁，
   整条重建会重排 + 重放动画，看起来就是卡顿 + 闪。`renderTabs()` 现在按 id 复用节点。
6. **尊重系统设置**：`prefers-reduced-motion: reduce` 下保留淡入淡出、去掉位移与缩放；
   `prefers-reduced-transparency: reduce` 下遮罩改不透明。
7. 悬浮类动效统一包在 `@media (hover: hover) and (pointer: fine)` 里。

---

## 3. 项目结构

```
aihub/
├── package.json          # 项目配置 + electron-builder 打包配置
├── main.js               # 主进程：窗口、各服务视图、session 隔离、快捷键、IPC
├── preload.js            # 只向标签栏页面暴露"切换标签/管理服务"，不暴露 Node
├── index.html            # 顶部标签栏 UI + 设置面板 + 分屏分隔条
├── error.html            # 页面加载失败时的兜底页（网络错误、证书错误等）
├── icons.js              # 【自动生成】图标索引：服务 -> 本地 logo 文件、域名 -> 图标
├── icons/                # 【自动生成】内置 logo（116 个，来自 cc-switch，MIT）
│   ├── dark/ light/      # 【自动生成】深/浅主题下需要换色的那部分（黑 logo 反白、白 logo 压深）
│   └── menu/             # 【自动生成】原生菜单用的 32×32 PNG（原生菜单不认 SVG）
├── assets/
│   └── logos/            # logo 原始素材 + manifest + 预览页（不参与打包）
├── build/
│   ├── icon.ico          # 打包用图标（256x256）
│   └── icon.png          # 备用图标（512x512）
├── tools/
│   ├── make-icon.js      # 零依赖图标生成脚本：npm run icon
│   ├── build-icons.js    # 从 assets/logos 生成 icons/ 与 icons.js（--check 只校验不写盘）
│   ├── build-menu-icons.js # 把 SVG 光栅化成原生菜单用的 PNG（--check 同上）
│   ├── check-package.js  # 检查安装包里有没有漏带图标等资源
│   ├── smoke.js          # 开发自检脚本：跑一遍核心流程并逐项断言
│   └── layout-dump.js    # 开发用：导出分屏几何坐标（供真实鼠标拖拽测试）
└── README.md
```

### 它是怎么工作的

1. 窗口本身是一个普通网页（`index.html`），只负责画顶部 44px 的标签栏。
2. 每个 AI 服务是一个独立的 **`WebContentsView`**（Chromium 里的独立渲染视图），
   挂到 `BrowserWindow.contentView` 上，位置正好从标签栏下方开始。
3. 每个服务绑定自己的 `session partition`（`persist:deepseek`、`persist:chatgpt`……），
   所以 **Cookie / localStorage / 登录态互相隔离**，并且会写到磁盘、下次启动保持。
4. **启动时预加载**：默认开启，启动后每隔 350ms 建一个服务的视图，把所有标签的页面都加载起来
   （视图**不挂到窗口上**，所以不占显示区域、也不影响分屏），这样标题和 favicon 不用点开就会出现。
   关掉预加载（⚙ 设置里的开关）后回到**懒创建**：没点开的标签不占一个渲染进程，点过才创建。
5. 没有 `iframe`，所以 `X-Frame-Options`、CSP 的 `frame-ancestors` 都拦不住它——
   这也正是不能直接用 `<iframe>` 的原因。

### 标签上的 logo 是怎么来的

内置站点**自带本地 logo**，不依赖网站把 favicon 传回来，所以：

1. `tools/build-icons.js` 把 `assets/logos`（来源 cc-switch，MIT）里的图标复制到 `icons/`，
   并生成 `icons.js`：服务 icon 字段 → 文件、域名 → 图标、key 别名三张表。
2. `icons.js` 和 `icons/` 都在 `package.json` 的 `build.files` 白名单里，会一起打进安装包，
   窗口页面用相对路径 `icons/deepseek.svg` 就能读到（`file:` 协议，不走网络）。
3. 渲染层的取值顺序是「服务自带的 icon 字段 → key 别名 → 域名匹配 → 名字匹配」；
   命中就用本地图，没命中才退回网站 favicon，再没有就用服务颜色的小圆点。
   这样一来：**不用点开、不用等网站响应，标签栏一上来就是各家 logo**，
   而且换 favicon 风格时也不会忽大忽小。
4. **不给 logo 垫白底**。纯黑 / `currentColor` 的 logo（Kimi、ChatGPT、Grok 这类）
   在深色标签栏上会看不见，纯白 / 浅灰的在浅色主题下会糊掉。
   `tools/build-icons.js` 会按每个 SVG 的颜色（亮度 + 饱和度）判断：
   会看不见的才生成一份反白 / 压深变体，放在 `icons/dark/`、`icons/light/`；
   带品牌色的（DeepSeek 蓝、Claude 橙、豆包、智谱、Gemini）原样保留。
   渲染层按 `prefers-color-scheme` 自动挑对应那一套，主题一变就换图。
5. 原生分屏菜单的条目图标是另一套：原生菜单只认位图，所以
   `tools/build-menu-icons.js` 会把每张图光栅化成 32×32 的 PNG，放在 `icons/menu/dark|light/`。

> 给用户自己加的服务配图：`addService` 会按网址自动认一遍内置图标表，
> 例如加 `https://yuanbao.tencent.com/chat` 会拿到元宝的图标；认不出就留空用圆点。
> 想换图标，把 `icon` 字段写成图标 key（如 `qwen`、`grok`、`mistral`）即可。

> 计划书里写的是 `BrowserView`。`BrowserView` 自 Electron 30 起已被官方废弃，
> 本项目用的是它的官方替代品 **`WebContentsView`**（用法几乎一一对应：
> `win.addBrowserView(view)` → `win.contentView.addChildView(view)`）。

### 分屏是怎么做出来的（多栏 + 拖拽）

这是本项目最需要解释的一块，因为原生视图会盖住窗口自己的网页：

1. 布局是一个「权重模型」：`panes: [服务 id…]`（最多 `MAX_PANES = 4` 栏）
   加 `weights: […]`（水平占比，和为 1），存在 `config.json` 里。
2. **主进程算几何**：按权重把客户区宽度切成 N 栏，栏与栏之间留 `SPLIT_GAP = 4` 的缝隙
   （只有一条细线那么宽，整块界面看起来才是一体的），
   再把每一栏交给对应的 `WebContentsView.setBounds()`。最后一栏直接吃掉取整误差，
   保证右边缘严格贴合窗口。
3. **缝隙就是拖拽手柄**：这条 4px 的缝隙里没有任何视图，所以窗口自己的页面能收到鼠标事件。
   页面按主进程广播的几何把分隔条 `<div>` 摆上去。缝隙只有 4px，鼠标很难压准，
   所以几何里额外带了 `hitX` / `hitWidth`：拖动热区比缝隙两侧各宽出 5px（共 14px），
   视觉上仍然是中间那条细线，拖动时把指针的 x 坐标通过 IPC 发回主进程，
   主进程重新算权重并立刻改视图边界
   （一次拖动只走轻量的 `layout:changed` 通道，不会重建标签栏，所以是跟手的）。
4. 拖动时只调整相邻两栏、两者之和不变，且两栏都不小于 `MIN_PANE_WIDTH = 260`；
   双击分隔条把相邻两栏拉回等分。
5. 点击标签的语义：**已在布局里的服务 → 只切换焦点；不在布局里的 → 在当前焦点栏里打开它**
   （单栏时就是普通的切换标签，行为没有变化）。
6. **分屏菜单走 Windows 原生菜单**（主进程 `Menu.popup`）。原因：服务页面是独立的原生视图，
   永远画在窗口页面之上，所以窗口页面里画的下拉菜单会被整块挡住（表现为「点 ⇔ 没反应」）。
   曾经试过「打开菜单时把视图整体往下推」，结果是页面被挤了一下，很难看；现在直接用原生菜单：
   它是独立的弹出窗口，浮在所有视图之上，**布局一点都不用动**。
   菜单每项都带各家的 logo：原生菜单只认位图，所以 `tools/build-menu-icons.js`
   会把 SVG 预光栅化成 `icons/menu/<tone>/*.png`（tone 按当前明暗主题取），不用彩色圆点。

> 踩过的坑：拖动更新原本用 `requestAnimationFrame` 节流，但窗口被别的窗口遮挡时
> Chromium 会停止出帧，rAF 不再触发，拖拽直接卡死；现在改成时间戳 + `setTimeout` 节流。

> 分隔条两端刻意用了「硬边界」（到 `MIN_PANE_WIDTH` 就停住）而不是橡皮筋回弹：
> 多栏布局是会被直接提交的，视觉上再晃一下反而让人以为宽度没生效。
> 真要回弹，就需要一套带速度传递的弹簧（见动效规范那节），眼下这点收益不值这个复杂度。

### 换电脑怎么把登录状态带过去

每个服务是独立的 session partition，登录态由两部分组成，导出/导入就是分别搬运这两部分：

1. **Cookie**：通过 `session.cookies.get({})` 读取，**HttpOnly 的会话令牌也能读到、也能写回**
   （`document.cookie` 拿不到这些，所以这个功能必须放在主进程做），
   而且是整个分区所有域名一起导出，第三方登录留下的 Cookie 也会跟着走。
2. **页面本地存储**（localStorage / sessionStorage）：只能在该服务的页面里用 JS 读写，
   所以导出时会给没打开过的服务临时建一个视图（已验证：未挂载到窗口上的 `WebContentsView`
   一样能加载页面并执行 JS），读完立刻销毁，不让它常驻内存。

导入的顺序是「先写 Cookie → 再写本地存储 → 刷新视图」，同名项覆盖、不影响没导出的服务。
导入前会先解析文件并弹一个确认块，列出每个服务有多少条数据，确认后才真正写入。

**服务怎么对上号**：文件里每个服务都带 id 和网址，匹配优先级是
「id + 完整网址都一样 → 完整网址一样 → id 一样 → 同域名」。
最后那条「同域名」的兜底很关键：同一个站点完全可能被加成两个标签（比如同一域名的两个路径），
只按域名匹配会把数据写进另一个服务的分区，所以一个服务只接受一条导入记录，
测试里专门放了一个同域名的「诱饵服务」来盯这个回归。

**文件等于明文密码**，所以加了一层可选加密：填了密码就用 `scrypt` 派生密钥 + `AES-256-GCM`
加密整个负载（密码错误时 GCM 校验直接失败，不会写入半截数据）。不填密码就是明文 JSON，
方便自己看一眼里面是什么。

> 不含 IndexedDB 和 Service Worker 缓存：这几个站点的登录态都在 Cookie 和 localStorage 里，
> 缓存属于可再生的内容，搬过去没有意义。真遇到只在 IndexedDB 里存令牌的站点，这个功能搬不动它。

---

## 4. 数据保存在哪里

| 内容 | 位置 |
| --- | --- |
| 服务列表 / 上次打开的标签 / 分屏布局（栏位与宽度）/ 各标签上次的网址 / 预加载开关 | `%APPDATA%\Aihub\config.json` |
| 各服务的 Cookie、localStorage 等登录态 | `%APPDATA%\Aihub\Partitions\<服务 id>\` |

想彻底重置某个服务的登录态：⚙ 设置 → 对应服务 → 删除 → 选择「删除并清除登录数据」。
（`%APPDATA%` 通常是 `C:\Users\<你>\AppData\Roaming`。设置面板底部也会显示实际路径。）
清除登录数据时会立即清空 Cookie / 本地存储，分区目录本身留到下次启动再删（原因见第 9 节排错表）。

> 迁移提示：换电脑时把「导出登录信息」得到的 JSON 拷过去，在新设备上先装好本应用、
> 确认服务列表一致（七个内置站点默认就有），再「导入登录信息」即可，不用重新登录。
> 导入不需要两边版本完全一致，但服务网址要能对上（按网址同源匹配，其次按服务 id）。
> 改名成 Aihub 之前导出的文件（`format` 是旧值 `ai-multi-hub-login`）也能直接导入。

> **从旧版本升级上来**：应用以前叫「AI Multi Hub」，数据目录在 `%APPDATA%\AI Multi Hub`。
> 改名后第一次启动时会自动迁移：把旧目录里的 `config.json`、`Partitions\`（各站点的登录态）、
> `Local Storage` 等**逐个搬到新目录** `%APPDATA%\Aihub`，所以登录状态和分栏布局都原样保留，
> 不需要重新登录。同盘搬移用的是改名操作，几乎是瞬时的。
>
> 两个细节：① 新目录里已经有 `config.json`（说明新版本已经用过）时不会覆盖，只会跳过；
> ② 旧目录里剩下的是 Chromium 缓存，可以放心手动删掉。自检里有 4 项专门盯这套迁移
> （含「Electron 提前把新目录建好了也要照搬」这个曾经踩过的坑）。

### 老配置怎么升级（内置站点换版）

内置站点列表带一个版本号（`SERVICES_VERSION`）。老版本的 `config.json` 一读进来就会自动升级：

- 最初那版内置的 **Coze（扣子）会被豆包取代**：`panes`、`activeId`、`lastUrls` 里的 `coze`
  一起改名成 `doubao`，并把它原来的分区目录排进待清理队列（替换掉的站点，登录数据不再有意义）。
- 补上新增的内置站点：**豆包、Kimi、智谱 GLM、Gemini**，并给每个内置服务补上 `icon` 字段。
- 顺序会整理成「内置站点按默认顺序在前，用户自己加的服务按原顺序在后」。
- **只动内置服务**：用户自己加的服务、以及被改过网址的内置服务都不会被删或改地址。
  自检里专门有 8 项盯这套迁移（含「已是最新版时不重复改动」和「用户自建的 coze 不动」）。

升级只在启动时做一次，之后把 `servicesVersion` 写回配置，所以不会反复搬动。

---

## 5. 打包成安装包

```powershell
npm run icon      # 可选：重新生成应用图标（改了配色/图案时）
npm run icons     # 重新生成 icons/ 与 icons.js（改了 assets/logos 时）
npm run menu-icons # 重新光栅化原生菜单用的 PNG（改了上面的图标时）
npm run dist      # 生成 Windows 一键安装包（会自动先跑 icons + menu-icons）
```

打包前想确认图标这一摊没漏（比如 `icons.js` 是不是比磁盘上的文件新）：

```powershell
npm run check:icons
```

`icons/`、`icons/dark`、`icons/light`、`icons/menu` 都是**生成物**，不要手改；
`tools/build-icons.js` 和 `tools/build-menu-icons.js` 都支持 `--check`，只校验、绝不写盘。

产物在 `dist\Aihub-0.1.0-setup.exe`，双击即装、装完自动启动，
不需要选择安装路径、不需要点下一步（`nsis.oneClick: true`）。

国内网络下 electron-builder 需要额外下载打包工具链，如果卡住可以设置：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

只想快速验证打包流程（只产出免安装目录，不生成安装包，快很多）：

```powershell
npm run dist:dir
```

打完想确认「图标这些新增资源真的进包了」（`build.files` 是白名单，忘了加就会装完之后没图标）：

```powershell
node tools/check-package.js
```

它会列出 `app.asar` 里的实际内容，并逐个检查内置 logo（含深/浅变体与菜单 PNG）是否齐全、
`assets/` `tools/` 有没有被误打包。

### 关于 SmartScreen

未签名的安装包第一次运行会被 Windows 提示「已保护你的电脑 / 未知发布者」，
点「更多信息 → 仍要运行」即可，功能不受影响。要彻底消除这个提示需要购买代码签名证书
（一年几百到上千元），个人/内部使用没必要。

---

## 6. 自检（改完代码后跑一遍）

```powershell
$env:AIHUB_SMOKE='1'; npm start
```

它会真的打开窗口，依次切换每个标签、真实加载各站点，然后断言：预加载（不点开也有视图）、
标签 logo 真的画出来了（含「内置图没被 CSP 拦掉」「图标文件连深/浅变体都进了打包白名单」）、
选中标签没有底色与侧边色条、外观主题三档切换后页面与 logo 变体都跟着变、
视图铺满区域、分屏几何（双栏/三栏、权重和为 1、不重叠、右边缘贴合、最小栏宽限制、拖拽与均分、
缝隙 4px 且拖动热区更宽）、
分隔条能否收到指针事件并驱动 IPC、设置面板走真实链路打开时视图让位、增删服务的增删改与落盘、
分屏菜单的结构（每项带 logo、勾选状态与布局一致、栏满不让加）以及**弹菜单不会改变布局**、
右键菜单两层都有（服务视图挂上 `context-menu`、应用菜单含刷新/设置/开发者工具）、
动效规范逐条落地（时长令牌都在 300ms 以内、曲线来自规范表、没有 `transition: all`、
没有动画去动 width、面板只过渡 transform/opacity、滑块精确停在当前主题那一格、
有 `prefers-reduced-motion` 与 `(hover:hover)` 分支、标签栏重绘是就地更新不重建节点）、
设置面板浅色下纯白且没有颜色选择器、
内置站点列表升级（扣子→豆包、补站点、不碰用户自建服务）、图标识别与预加载开关的前后行为、
登录信息导出/导入的完整往返（含 HttpOnly/Secure/SameSite 属性、本地存储、加密与错误密码）、
session 隔离与 UA 伪装、标签栏页面无 JS 报错。最后打印 `SMOKE_PASS x/x` 或 `SMOKE_FAIL`，
退出码 0/1，可接 CI。（当前 259 项。）

> 自检碰真实账号的部分**只读**（只导出、只做「不减少」的断言）；
> 清空 Cookie、写本地存储这类破坏性验证只在临时服务上做，做完连分区一起删掉，
> 不会动你实际的登录态。

想让它在结束时顺便把标签栏 UI 截几张图（存到 `%TEMP%\aihub-shots`，含分屏状态）：

```powershell
$env:AIHUB_SMOKE='1'; $env:AIHUB_SMOKE_SHOTS='1'; npm start
```

注意：这会真实访问七个站点，并且会改变 `config.json` 里的「上次打开的标签」、分屏布局和外观主题
（为了截浅色那几张图会切到浅色）。
跑之前先退出正在运行的应用：应用是单实例的，已有实例在跑时自检会直接报
`SMOKE_FAIL：已有实例在运行`（而不是假装通过）。

### 用真实鼠标验证拖拽（可选）

合成事件测不出「点击到底落在哪个原生视图上」，所以另有一个走真实鼠标注入的脚本：

```powershell
$env:AIHUB_LAYOUT_DUMP="$env:TEMP\hub-layout.json"   # 让应用导出分隔条的屏幕坐标
$env:AIHUB_TEST_TOPMOST='1'                          # 测试期间把窗口置顶并激活
npm start
```

`tools/layout-dump.js` 会把每栏几何、分隔条中心点的物理像素坐标写进这个文件；
再用 `SendInput` 在那些坐标上按下、移动、抬起，就能验证「拖拽真的改变了权重并落盘」。

---

## 7. 已知限制（务必先看）

- **不能"一次提问同步发给所有模型"**：这是套壳方案的天然限制。要实现得针对每个网站写注入脚本
  模拟「填输入框 + 点发送」，各家网页改版频繁，维护成本高，本项目不做。
- **分屏只解决"同时看"**，每一栏仍要分别手动输入。
- **导出文件等于账号凭证**：别丢到网盘公开目录、别发给别人；建议导出时设个密码。
  另外平台侧的风控可能把"同一账号从两台设备/两个 IP 同时在线"当作异常，
  迁移后建议在旧设备上退出登录。
- **不迁移 IndexedDB / Service Worker 缓存**（见上文「换电脑怎么把登录状态带过去」）。
- **导入不修改服务列表**：文件里对不上的服务会被跳过并提示，需要自己先添加同样的服务。
- **最多同时 4 栏**（`main.js` 里的 `MAX_PANES` 可改）。一栏最小 260px（`MIN_PANE_WIDTH`），
  窗口拉得不够宽时再加栏会被拒绝，而不是把栏挤成一条缝。
- **栏数越多越吃内存**：每栏都是一个完整的 Chromium 渲染进程。
- **预加载会同时加载所有站点**（默认开启，为了「不用点开也有标题和 logo」）：
  启动后每个标签都是一个真实的渲染进程 + 一次真实的页面请求。机器吃紧或者只想用其中一两个站点，
  就在 ⚙ 里把预加载关掉，回到「点到才加载」。
- **内存占用高**：每个标签都是一个完整的 Chromium 渲染进程，相当于同时开着好几个浏览器标签页。
  预加载（默认开启）会把所有内置站点都加载起来，所以启动后内存更高、也会产生对应的网络请求；
  不想要就在 ⚙ 里关掉预加载，或把不用的服务删掉。
- **第三方登录（Google / 微信扫码）**：已在主进程放行 `window.open` 类登录弹窗，
  弹窗与标签共用同一个 session，登录态会写回对应标签。但 **Google 登录仍可能提示
  "此浏览器或应用可能不安全"**——这是 Google 对嵌入式浏览器的策略，属于上游限制，
  改用「邮箱密码登录」或手机验证码即可绕过。
- **未签名安装包会触发 SmartScreen 警告**，功能不受影响。

---

## 8. Roadmap 进度

- [x] **1. 跑通套壳原型**：四个标签独立登录、切换、保持登录态
- [x] **2. 完善标签栏体验**：图标/标题、记住上次打开的标签、记住各标签上次的网址、
      图形化「增删服务」设置面板（填名字+网址即可，不用改代码重新打包）、每标签加载状态
- [x] **3. 登录与弹窗边界情况**：OAuth 弹窗共用 session、外部协议交给系统、
      权限白名单（麦克风/通知/剪贴板）、加载失败兜底页、渲染进程崩溃兜底、UA 去 Electron 标记
- [x] **4. 分屏对比**：可拖拽分隔条调宽度、最多 4 栏同时显示、双击均分、栏位与宽度都记住
- [x] **5. electron-builder 打包**：`dist` 脚本 + nsis 一键安装
- [ ] **6. 处理 SmartScreen**：见上文，需要签名证书（可选）
- [ ] **7. 自动更新**：接入 `electron-updater` + GitHub Releases（可选）
- [x] **8. 打包分发**：`npm run dist` 产出 `.exe`，发给别人双击安装即可
- [x] **9. 登录信息迁移**：一键导出/导入各服务登录态（Cookie + 本地存储，可加密），方便换电脑
- [x] **10. 站点与图标体验**：内置站点扩到 7 个（扣子换成豆包，新增 Kimi / 智谱 GLM / Gemini），
      每个标签自带本地 logo（不用点开也有），启动时预加载所有标签（可在 ⚙ 里关）、
      老配置自动升级内置站点列表
- [x] **11. 观感与可用性**：选中标签不再有底色和侧边色条、logo 不再垫白底（改按明暗自动换变体）、
      外观主题可选 深色 / 浅色 / 跟随系统、修好「点 ⇔ 分栏没反应」（下拉菜单被原生视图挡住）
- [x] **12. 跨平台 + 自动构建**：macOS（Apple Silicon）可打包运行（托盘、Dock、
      `Command` 修饰键提示、应用菜单都按平台走），GitHub Actions 自动出
      Windows x64 与 macOS arm64 两个平台的安装包，推 `v*` 标签自动发 Release
- [ ] **13. 签名与公证**：Windows 代码签名 + Apple 开发者签名/公证（需要证书，可选）

---

## 9. 排错

| 现象 | 原因 / 做法 |
| --- | --- |
| `npm start` 报 `fetch failed` 或 `Electron failed to install correctly` | Electron 二进制没下下来，设置 `ELECTRON_MIRROR` 后重跑（见第 1 节） |
| 某个标签显示「加载失败」页 | 网络/代理问题，不是客户端缺陷；页面上有重试按钮，也可 `F12` 看详细错误 |
| 某个服务一直登录不上 | 该标签按 `F12` 打开开发者工具，看 Network / Console；或在设置里删掉它并「删除并清除登录数据」后重来 |
| 想换某个服务的网址 | ⚙ → 对应行改网址 → 保存（会自动重新加载） |
| 标签栏乱了 / 想恢复默认七个服务 | 退出应用，删掉 `%APPDATA%\Aihub\config.json`，重启 |
| 标签上没有 logo（只有圆点），或装完之后图标全没了 | 前者说明该站点不在内置图标表里（网站 favicon 也没给），可以在设置里把 `icon` 字段填成图标 key；后者是打包白名单漏了 `icons/`，跑 `node tools/check-package.js` 确认 |
| 加了新服务，但标签上仍然没有 logo | 图标表按域名匹配，认不出的就退回彩色圆点；想让它有图，把服务配置里的 `icon` 写成图标 key（`icons/` 里有什么用什么） |
| 启动后内存/流量比之前高 | 这是预加载（默认开启）的代价：所有标签的页面都会真实加载一遍。不想这样就到 ⚙ 里关掉「启动时预加载所有标签」 |
| 跑自检时提示「已有实例在运行」 | 应用是单实例的，先退出正在运行的窗口再跑自检；否则本次自检等于没执行（现在会明确报错而不是假装通过） |
| 点 ⇔ 分栏按钮没反应 | 早期版本里菜单画在窗口页面里，会被服务页面挡住（原生视图永远在最上层）。现在改成了 Windows 原生菜单，浮在所有页面之上，点 ⇔ 就能看到「勾选服务（带 logo）/ 均分 / 只显示当前标签」，而且不会再挤压页面 |
| 分屏菜单里的 logo 不显示 | 原生菜单只认位图，logo 由 `npm run menu-icons` 生成的 `icons/menu/` 提供。重新跑一次 `npm run icons && npm run menu-icons`，或者用 `npm run check:icons` 看缺哪些 |
| 切成浅色主题后，服务页面还是深色 | 这是预期的：主题只控制本应用自己的标签栏、设置面板和加载失败页；各家网站自己的深浅色由它们自己决定 |
| 某个 logo 在浅色主题下几乎看不见 | 纯白/浅灰的 logo 会自动换用 `icons/light` 那套变体，纯黑的用 `icons/dark` 那套（`tools/build-icons.js` 按颜色亮度+饱和度判定）。如果遇到漏判的，可以在 `assets/logos` 里换一张图，或者给服务手填 `icon` 指向合适的 key |
| 升级后「扣子」不见了，多出「豆包」 | 内置站点列表升级：扣子由豆包取代（登录数据也一起清了）。想留扣子，在设置里按原来的网址自己加一个即可 |
| 分屏加不进更多栏 | 窗口太窄，一栏最小 260px；拉宽窗口或先减少栏数 |
| 导入登录信息后还是未登录 | 先按 F5 刷新那个标签；仍然不行就说明该站点把令牌放在 IndexedDB 里（见「已知限制」），只能重新登录一次 |
| 导入提示「请先填写导出时设置的密码」 | 导出时设了密码，在同一个输入框里填上再点导入 |
| 导入提示「服务对不上」 | 目标设备上还没有这些服务，先在 ⚙ 里添加同样的服务（网址同源即可） |
| 删了服务，磁盘上还有同名目录 | 勾选「删除并清除登录数据」时，内容会立刻清掉、目录会在**下次启动**时删除（运行期间 Chromium 占着文件句柄，实测删不掉）；残留的只是缓存空壳，不含登录数据 |
| 配置文件报错后服务列表变回默认四个 | 配置解析失败（比如手改坏了）。应用会把坏文件备份成 `config.json.bad` 再退回默认值，可以照着它手动恢复 |
| 窗口里显示「preload 脚本未加载」 | 直接用浏览器打开了 `index.html`。必须用 `npm start` 启动 |
| 网页里右键没有任何菜单 | Electron 默认不给任何右键菜单，本项目用 `webContents.on('context-menu')` 自己补了（复制/粘贴/链接/图片/刷新/检查元素）。如果某个站点完全没有菜单，看日志里有没有 `右键菜单失败` |
| 操作时感觉有点卡 / 标签栏在闪 | 标签栏以前每当标题或 favicon 更新就把整条重建一次（会重排并重放动画）。现在 `renderTabs()` 按 id 就地更新，只改变化了的那几个属性；动效也只动 `transform`/`opacity`。可以跑自检验证这两条 |
| 设置面板看起来是灰的 / 半透明 | 早期版本的 CSS 变量在自己引用自己（`--panel-bg: var(--panel-bg)`），属性会判定为无效而变透明。现在浅色下面板、卡片、输入框都是纯白 `#ffffff`；自检里有专门一项盯这个 |
| 想让动效更"安静"或更快的整体调整 | 动效数值只在 `index.html` 的 `:root` 里（`--dur-1/2/3`、`--dur-exit`、`--ease-out/in-out/drawer`），改这一处即可全局生效；系统开了「减少动态效果」时会自动只保留淡入淡出 |

改完 `main.js` / `index.html` 不需要重新打包，`npm start` 重启即可看到效果。

> **开发提示（踩过的坑）**：Windows PowerShell 5.1 的文本 cmdlet（`Get-Content -Raw` +
> `Set-Content` / `[IO.File]::WriteAllText`）默认按系统 ANSI 码页读写，直接拿它改写本项目的
> UTF-8 源码会把中文注释写坏（表现为乱码 + 换行被吞掉）。要么别用 PowerShell 改源码，
> 要么显式指定编码：`Get-Content -Raw -Encoding UTF8` / `[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))`。
> `tools/*.ps1` 这类辅助脚本也建议只用 ASCII 字符。

## 10. 许可证与致谢

本项目以 **MIT** 许可证开源，见 [LICENSE](LICENSE)。可以自由使用、修改、商用，保留版权声明即可。

第三方素材的边界（**重要**）：内置的各家 AI logo 是各自公司的商标，本项目只用来标识服务入口，
与这些公司没有合作或背书关系；图标素材的收集整理参考了 [cc-switch](https://github.com/farion1231/cc-switch)（MIT）。
详细说明见 [NOTICE.md](NOTICE.md)。

欢迎提 Issue / PR：

- 想加站点：优先在 `assets/logos/` 里补一张 logo，再在 `main.js` 的 `DEFAULT_SERVICES` 里加一条；
- 改完代码请跑一遍自检（见第 6 节），它覆盖了标签栏、分屏几何、设置面板、动效规范、账号迁移这些容易回归的地方；
- CI 会跑 `npm run lint` 和 `npm run check:icons`（图标表、深浅变体、打包白名单是否对得上）。

