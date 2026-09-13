# AI 厂商 Logo 合集

从 [farion1231/cc-switch](https://github.com/farion1231/cc-switch)（MIT 许可）源码里同步出来的图标素材，共 **116** 个厂商 / 品牌。
导出目录：`assets/logos`。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `logos/` | **一家一张图**，文件名就是厂商 key（90 个 SVG + 26 个位图） |
| `_raw/svg/` | 上游源码里内联的 SVG 原文，未做任何改动 |
| `_raw/files/` | 上游源码里的原始图片文件（保留原始文件名） |
| `_raw/assets-icons/` | 上游另一个图标目录 `src/assets/icons` 的原始文件 |
| `_raw/index.ts` / `_raw/metadata.ts` | 上游的图标注册表与元数据（显示名、分类、默认品牌色、关键词），方便回溯 |
| `manifest.json` | 清单：key、显示名、分类、默认色、关键词、文件路径、是否国内知名、备用素材 |
| `preview.html` | 用浏览器打开，一页看完所有 logo（带搜索框） |

优先级：源码里手工整理的内联 SVG 优先，其次按 `名字.svg` 约定的矢量文件，最后才是位图。
同一品牌有多种素材时，其余版本放在 `_raw/` 里并在 `manifest.json` 的 `alternates` 字段标出。
`codex` 是别名：上游用 OpenAI 的标记渲染 Codex（`src/components/BrandIcons.tsx`），所以它就是 `openai.svg`。

## 国内知名（40 个）

| 文件 | 厂商 | 格式 |
| --- | --- | --- |
| `aicoding.svg` | AICoding | 矢量 SVG |
| `aigocode.svg` | AiGoCode | 矢量 SVG |
| `aihubmix.svg` | AiHubMix | 矢量 SVG |
| `alibaba.svg` | 阿里巴巴 / 阿里云 | 矢量 SVG |
| `apinebula.png` | APINebula 星云 | PNG |
| `baidu.svg` | 百度 | 矢量 SVG |
| `bailian.svg` | 阿里云百炼 | 矢量 SVG |
| `bytedance.svg` | 字节跳动 | 矢量 SVG |
| `byteplus.png` | BytePlus（字节海外） | PNG |
| `chatglm.svg` | 智谱 GLM | 矢量 SVG |
| `claudecn.png` | Claude 国内中转 | PNG |
| `deepseek.svg` | DeepSeek 深度求索 | 矢量 SVG |
| `doubao.svg` | 豆包（字节跳动） | 矢量 SVG |
| `huawei.svg` | 华为 | 矢量 SVG |
| `hunyuan.svg` | 腾讯混元 | 矢量 SVG |
| `huoshan.png` | 火山引擎 | PNG |
| `kimi.svg` | Kimi 月之暗面 | 矢量 SVG |
| `longcat.svg` | 美团 LongCat | 矢量 SVG |
| `minimax.svg` | MiniMax 稀宇科技 | 矢量 SVG |
| `modelscope.svg` | 魔搭 ModelScope | 矢量 SVG |
| `newapi.svg` | New API 中转 | 矢量 SVG |
| `packycode.svg` | PackyCode | 矢量 SVG |
| `ppio.svg` | PPIO 派欧云 | 矢量 SVG |
| `qianwenai.svg` | 通义千问 | 矢量 SVG |
| `qiniu.png` | 七牛云 | PNG |
| `qwen.svg` | 通义千问（阿里） | 矢量 SVG |
| `qwencloud.svg` | 通义云 | 矢量 SVG |
| `runapi.jpg` | RunAPI | JPG |
| `shengsuanyun.svg` | 胜算云 | SVG |
| `siliconflow.svg` | 硅基流动 | 矢量 SVG |
| `stepfun.svg` | 阶跃星辰 | 矢量 SVG |
| `sudocode.png` | SudoCode | PNG |
| `tencent.svg` | 腾讯 | 矢量 SVG |
| `ucloud.svg` | UCloud 优刻得 | 矢量 SVG |
| `wenxin.svg` | 文心一言（百度） | 矢量 SVG |
| `xiaomimimo.svg` | 小米 MiMo | 矢量 SVG |
| `xycai.png` | 小云雀 AI | PNG |
| `yi.svg` | 零一万物 | 矢量 SVG |
| `zeroone.svg` | 零一万物 | 矢量 SVG |
| `zhipu.svg` | 智谱 AI | 矢量 SVG |

## 海外主流与工具（76 个）

| 文件 | 厂商 | 格式 |
| --- | --- | --- |
| `9527code.svg` | 9527CODE | 矢量 SVG |
| `a6api.png` | A6API | PNG |
| `aicodemirror.svg` | aicodemirror | 矢量 SVG |
| `aicodewith.svg` | AICodeWith | 矢量 SVG |
| `aihubmix-color.svg` | aihubmix-color | SVG |
| `algocode.svg` | algocode | SVG |
| `amux.svg` | Amux | 矢量 SVG |
| `amuxapi-icon.svg` | amuxapi-icon | SVG |
| `anthropic.svg` | Anthropic | 矢量 SVG |
| `apikeyfun.png` | APIKEY.FUN | PNG |
| `atlascloud.png` | AtlasCloud | PNG |
| `aws.svg` | AWS | 矢量 SVG |
| `azure.svg` | Azure | 矢量 SVG |
| `catcoder.svg` | catcoder | 矢量 SVG |
| `ccsub.svg` | CCSub | SVG |
| `chatgpt.svg` | ChatGPT | SVG |
| `cherryin.png` | CherryIN | PNG |
| `claude.svg` | Claude | 矢量 SVG |
| `claudeapi.png` | ClaudeAPI | PNG |
| `claw.svg` | claw | SVG |
| `cloudflare.svg` | Cloudflare | 矢量 SVG |
| `code0.png` | Code0 | PNG |
| `cohere.svg` | Cohere | 矢量 SVG |
| `copilot.svg` | Copilot | 矢量 SVG |
| `crazyrouter.svg` | crazyrouter | 矢量 SVG |
| `cubence.svg` | Cubence | 矢量 SVG |
| `eflowcode.png` | E-FlowCode | PNG |
| `etok.png` | ETok | PNG |
| `fenno.webp` | FennoAI | WEBP |
| `gemini.svg` | Google Gemini | 矢量 SVG |
| `gemma.svg` | Google Gemma | 矢量 SVG |
| `github.svg` | GitHub | 矢量 SVG |
| `githubcopilot.svg` | GitHub Copilot | 矢量 SVG |
| `google.svg` | Google | 矢量 SVG |
| `googlecloud.svg` | Google Cloud | 矢量 SVG |
| `grok.svg` | xAI Grok | 矢量 SVG |
| `hermes.png` | Hermes | PNG |
| `huggingface.svg` | Hugging Face | 矢量 SVG |
| `jiekou.svg` | JieKou AI | 矢量 SVG |
| `lioncc.svg` | LionCC | 矢量 SVG |
| `longcat-color.svg` | longcat-color | SVG |
| `mcp.svg` | MCP 协议 | 矢量 SVG |
| `meta.svg` | Meta Llama | 矢量 SVG |
| `micu.svg` | micu | 矢量 SVG |
| `midjourney.svg` | Midjourney | 矢量 SVG |
| `mistral.svg` | Mistral AI | 矢量 SVG |
| `modelscope-color.svg` | modelscope-color | SVG |
| `nekocode.png` | NekoCode | PNG |
| `notion.svg` | Notion | 矢量 SVG |
| `novita.svg` | Novita AI | 矢量 SVG |
| `nvidia.svg` | NVIDIA | 矢量 SVG |
| `ollama.svg` | Ollama | 矢量 SVG |
| `openai.svg` | OpenAI | 矢量 SVG |
| `openclaw.svg` | OpenClaw | 矢量 SVG |
| `opencode.svg` | opencode | 矢量 SVG |
| `opencode-logo-light.svg` | opencode-logo-light | SVG |
| `openrouter.svg` | OpenRouter | 矢量 SVG |
| `palm.svg` | Google PaLM | 矢量 SVG |
| `pateway.jpg` | PatewayAI | JPG |
| `perplexity.svg` | Perplexity | 矢量 SVG |
| `pi.svg` | pi | 矢量 SVG |
| `pipellm.png` | PIPELLM | PNG |
| `rc.svg` | rc | 矢量 SVG |
| `relaxcode.png` | RelaxyCode | PNG |
| `soleapi.svg` | SoleAPI | 矢量 SVG |
| `sssaicode.svg` | sssaicode | 矢量 SVG |
| `stability.svg` | Stability AI | 矢量 SVG |
| `subrouter.svg` | SubRouter | SVG |
| `sudocode-us.png` | SudoCode.us | PNG |
| `teamorouter.png` | TeamoRouter | PNG |
| `unity2.png` | Unity2.ai | PNG |
| `vercel.svg` | Vercel | 矢量 SVG |
| `xai.svg` | xAI | 矢量 SVG |
| `zenmux.svg` | ZenMux | 矢量 SVG |
| `zetaapi.png` | ZetaAPI | PNG |
| `codex.svg` | Codex | 矢量 SVG |

## 拿来做什么

- **矢量优先**：SVG 可以直接改颜色（把 `fill` 换成 `currentColor` 就能跟随主题），适合放进标签栏、下拉菜单、状态页。
- **位图**：PNG/JPG/WebP 是有些厂商只提供了位图，注意它们没有透明通道或尺寸偏大。
- 图标版权归各厂商所有，这里只是识别用途的素材副本；对外分发时请自行确认各家的商标使用政策。

## 怎么更新这份素材

导出脚本留在了项目里：`tools/export-cc-switch-logos.js`。

```powershell
# 1. 只把要用的目录拉下来（上游仓库很大，用稀疏检出避免全量下载）
git clone --depth 1 --filter=blob:none --sparse https://github.com/farion1231/cc-switch.git "$env:TEMP\cc-switch-src"
cd "$env:TEMP\cc-switch-src"; git sparse-checkout set src/icons src/config src/components src/assets/icons

# 2. 重新导出
node tools/export-cc-switch-logos.js "$env:TEMP\cc-switch-src\src\icons\extracted" "assets/logos"
```

上游的图标有两处来源：`src/icons/extracted/`（图片文件 + `index.ts` 里内联的 SVG）和
`src/assets/icons/`（chatgpt.svg 在这里）。内联 SVG 里的渐变 id 带 `lobe-icons-` 前缀，
说明这批矢量图源自 [Lobe Icons](https://github.com/lobehub/lobe-icons)（MIT），
所以**这份合集之外如果还缺某个厂商**（例如扣子 Coze、腾讯元宝、秘塔），可以从 Lobe Icons 再补。
上游只声明了图标引用、没提供图片的是 `together`（Together AI），它在上游走的是首字母兜底头像。
