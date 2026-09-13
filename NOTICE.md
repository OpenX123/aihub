# 第三方素材与商标声明

Aihub 本体以 MIT 许可证开源（见 `LICENSE`）。但仓库里有几类**不属于本项目版权**的内容，
分发或二次使用时需要留意：

## 1. 各家 AI 服务的 logo（`assets/logos/`、`icons/`）

这些图形是 DeepSeek、ChatGPT（OpenAI）、Claude（Anthropic）、豆包（字节跳动）、Kimi（月之暗面）、
智谱 GLM、Gemini（Google）等**各自公司的商标**，版权和商标权属于对应公司。

本项目只是在标签栏、分栏菜单里用它们**标识对应的服务入口**（指示性使用），并不表示与这些公司
存在合作、赞助或背书关系。如果你要二次分发、修改或商用：

- 保留这些图标时，不要暗示官方关系，也不要改动图形本身；
- 拿不准就删掉 `icons/` 里对应的文件并在设置里手填服务 —— 缺少图标时应用会自动退回纯文字标签；
- 各家的品牌使用规范以官网为准（例如 [OpenAI Brand](https://openai.com/brand/)、
  [Anthropic](https://www.anthropic.com/legal/trademark-policy)、[Google Brand Resource Center](https://about.google/brand-resource-center/)）。

图标素材的**收集与整理**参考了开源项目 [cc-switch](https://github.com/farion1231/cc-switch)（MIT），
`assets/logos/_raw/` 保留了转换前的原始文件与来源清单，`assets/logos/manifest.json` 记录了每个图标的
来源服务。感谢原作者。

## 2. Aihub 自己的品牌素材（`assets/brand/`、`build/icon.*`）

本项目自己的名称 "Aihub" 与图形标记属于项目作者，随 MIT 许可证一并提供；
你在自己的 fork 里可以自由替换成自己的品牌。

## 3. 打包进来的 Electron 运行时

安装包里的 Electron、Chromium 及第三方依赖各自遵循其原许可证（MIT / BSD / Apache-2.0 等），
详见 `node_modules/<包名>/LICENSE`。`npm run dist` 生成的安装包不含本项目之外的私有代码。

---

**提醒**：本项目是"网页套壳"，它不修改也不绕过任何站点的服务条款（ToS）。
用多个账号登录同一站点、或把登录态导出到其他设备，是否被允许取决于对应站点的条款，
请自行确认后再使用。
