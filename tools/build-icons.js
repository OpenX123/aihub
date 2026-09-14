// 把 assets/logos 里的 logo 打包进应用（供标签栏/设置面板使用），并生成图标索引
//
// 用法：node tools/build-icons.js
//   assets/logos/logos/*  ->  icons/*
//   assets/logos/manifest.json -> icons.js（文件名索引 + 域名索引，供渲染层使用）
//
// 说明：index.html 是窗口自身页面，用相对路径 icons/xxx.svg 就能读到；
// 这些文件通过 package.json 的 build.files 白名单一起进安装包。
//
// 另外会按需生成两套变体，免得在标签栏上给 logo 垫白底（那样很难看）：
//   icons/dark/xxx.svg  纯黑 / currentColor 的 logo -> 改白，深色主题下可见
//   icons/light/xxx.svg 纯白 / 浅灰的 logo        -> 改深，浅色主题下可见

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'assets', 'logos', 'logos');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'logos', 'manifest.json'), 'utf8'));
const outDir = path.join(root, 'icons');

// 浅色主题下，"太浅" 的 logo 换成这个深色；深色主题下黑的换成纯白
const INK = '#1f2329';
const WHITE = '#ffffff';

// 网站域名 -> 图标 key（用户自己加的服务也能自动配上 logo）
const HOSTS = {
  'chat.deepseek.com': 'deepseek', 'platform.deepseek.com': 'deepseek', 'deepseek.com': 'deepseek',
  'chatgpt.com': 'chatgpt', 'chat.openai.com': 'chatgpt', 'openai.com': 'openai', 'platform.openai.com': 'openai',
  'claude.ai': 'claude', 'anthropic.com': 'anthropic', 'console.anthropic.com': 'anthropic',
  'www.doubao.com': 'doubao', 'doubao.com': 'doubao',
  'www.kimi.com': 'kimi', 'kimi.com': 'kimi', 'kimi.moonshot.cn': 'kimi', 'platform.moonshot.cn': 'kimi',
  'chatglm.cn': 'chatglm', 'www.chatglm.cn': 'chatglm', 'z.ai': 'chatglm', 'chat.z.ai': 'chatglm',
  'open.bigmodel.cn': 'zhipu', 'bigmodel.cn': 'zhipu', 'zhipuai.cn': 'zhipu',
  'gemini.google.com': 'gemini', 'aistudio.google.com': 'google', 'ai.google.dev': 'google',
  'grok.com': 'grok', 'x.ai': 'xai', 'chat.x.ai': 'grok',
  'tongyi.aliyun.com': 'qwen', 'chat.qwen.ai': 'qwen', 'qwen.ai': 'qwen', 'bailian.console.aliyun.com': 'bailian',
  'yuanbao.tencent.com': 'hunyuan', 'hunyuan.tencent.com': 'hunyuan',
  'yiyan.baidu.com': 'wenxin', 'wenxin.baidu.com': 'wenxin',
  'chat.minimax.io': 'minimax', 'minimax.io': 'minimax', 'hailuoai.com': 'minimax',
  'cloud.siliconflow.cn': 'siliconflow', 'siliconflow.cn': 'siliconflow',
  'www.modelscope.cn': 'modelscope', 'modelscope.cn': 'modelscope',
  'chat.mistral.ai': 'mistral', 'www.perplexity.ai': 'perplexity', 'perplexity.ai': 'perplexity',
  'github.com': 'github', 'copilot.microsoft.com': 'copilot',
  'openrouter.ai': 'openrouter', 'ollama.com': 'ollama', 'huggingface.co': 'huggingface',
  'chat.qwenlm.ai': 'qwen', 'lmarena.ai': 'other',
};

// key 的别名：服务配置里写 icon 时可以用更顺手的名字
const ALIASES = {
  openai: 'chatgpt', gpt: 'chatgpt', 'gpt-4': 'chatgpt',
  anthropic: 'claude',
  glm: 'chatglm', zhipu: 'chatglm', bigmodel: 'chatglm', 智谱: 'chatglm',
  moonshot: 'kimi', 月之暗面: 'kimi',
  豆包: 'doubao', coze: 'doubao', 扣子: 'doubao',
  google: 'gemini', bard: 'gemini',
  qianwenai: 'qwen', qwencloud: 'qwen', 通义: 'qwen',
  hunyuan: 'hunyuan', yuanbao: 'hunyuan', 元宝: 'hunyuan',
  baidu: 'wenxin', ernie: 'wenxin', 文心: 'wenxin',
  deepseek: 'deepseek', 深度求索: 'deepseek',
};

// --check：不写任何文件，只验证「仓库里的 icons/ 和 icons.js 是否与 manifest 对得上」
// （防止出现「icons.js 说有 116 个，磁盘上只有 110 个」这种被中途打断的产物）
const CHECK_ONLY = process.argv.includes('--check');

if (!CHECK_ONLY) {
  fs.mkdirSync(outDir, { recursive: true });
  // 清掉旧文件，避免改名后留下垃圾（注意：--check 绝不能走到这里，否则会把图标全删掉）
  //
  // menu/ 要留着：那 232 个托盘/菜单图标是 build-menu-icons.js 出的，
  // 而那个脚本必须在 Electron 里跑。在这里连它一起删，等于让每次 npm run icons
  // 都悄悄毁掉一批不属于自己的产物——踩过一次了。
  for (const name of fs.readdirSync(outDir)) {
    if (name === 'menu') continue;
    fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 颜色分析 + 主题变体
// ---------------------------------------------------------------------------

/** #rgb / #rrggbb / #rrggbbaa -> 0~1 的相对亮度（拿不到返回 null） */
function luminance(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'white' || v === '#fff' || v === '#ffffff') return 1;
  if (v === 'black' || v === '#000' || v === '#000000') return 0;
  const m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 0~1 的饱和度：用来区分「黑灰色」和「深蓝/深紫这种有牌面色的深色」 */
function saturation(value) {
  const v = String(value || '').trim().toLowerCase();
  const m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (!m) return 0;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return 0;
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  return max === 0 ? 0 : (max - min) / max;
}

// 只有「又暗又灰」才算在深色背景上看不见；深蓝、深紫这类有饱和度的是品牌色，不能动
const isInk = (v) => {
  const l = luminance(v);
  return l !== null && l < 0.45 && saturation(v) < 0.3;
};
// 只有「又亮又灰」才算在浅色背景上糊掉
const isPaper = (v) => {
  const l = luminance(v);
  return l !== null && l > 0.75 && saturation(v) < 0.3;
};

const COLOR_RE = /(fill|stroke|stop-color|color)\s*:\s*(#[0-9a-fA-F]{3,8}|white|black|currentColor)|(fill|stroke|stop-color)\s*=\s*"(#[0-9a-fA-F]{3,8}|white|black|currentColor)"/g;

/** 读出一个 SVG 用到的颜色，判断它在深/浅主题下需不需要换色 */
function analyzeSvg(text) {
  const colors = new Set();
  let usesCurrentColor = false;
  let re = new RegExp(COLOR_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    const value = (m[2] || m[4] || '').toLowerCase();
    if (!value) continue;
    if (value === 'currentcolor') usesCurrentColor = true;
    else colors.add(value);
  }
  const lums = [...colors].map(luminance).filter((v) => v !== null);
  // 没有 fill 的元素会继承根节点；根节点也没写就默认黑
  const rootTag = text.slice(0, text.indexOf('>') + 1);
  const rootHasFill = /fill\s*=/.test(rootTag) || /fill\s*:/.test(rootTag);
  const inheritsBlack = !rootHasFill && /<(path|circle|rect|polygon|g|ellipse|line|polyline)\b(?![^>]*fill=)/.test(text);
  const darkest = lums.length ? Math.min(...lums) : null;
  const lightest = lums.length ? Math.max(...lums) : null;
  const values = [...colors];
  return {
    colors: values,
    usesCurrentColor,
    inheritsBlack,
    darkest,
    lightest,
    // 深色主题下会看不见（黑 / currentColor / 没写颜色 / 明确的深灰）
    needDark: usesCurrentColor || inheritsBlack || values.some(isInk),
    // 浅色主题下会看不见：整个 logo 都是浅灰白（只要有一处品牌色就不动）
    needLight: !usesCurrentColor && !inheritsBlack && values.length > 0 && values.every(isPaper),
  };
}

/** 生成一套变体：把命中的颜色整体换成 target */
function recolor(text, target, pick) {
  let out = text.replace(COLOR_RE, (whole, p1, v1, p3, v3) => {
    const value = (v1 || v3 || '').toLowerCase();
    if (value === 'currentcolor' || (value && pick(value))) {
      return whole.replace(/currentColor|#[0-9a-fA-F]{3,8}|white|black/, target);
    }
    return whole;
  });
  // 根节点没写 fill 时补一个，覆盖那些「靠继承变黑」的路径
  if (!/fill\s*=/.test(out.slice(0, out.indexOf('>') + 1))) {
    out = out.replace(/<svg\b/, `<svg fill="${target}"`);
  }
  return out;
}

const files = {};
const variants = {};
const stats = { dark: 0, light: 0, skipped: 0 };
let copied = 0;
for (const item of manifest.items) {
  const from = path.join(root, 'assets', 'logos', item.file);
  if (!fs.existsSync(from)) continue;
  const name = path.basename(item.file);
  if (!CHECK_ONLY) fs.copyFileSync(from, path.join(outDir, name));
  files[item.key] = `icons/${name}`;
  copied += 1;

  if (!name.toLowerCase().endsWith('.svg')) continue; // 位图不动
  const text = fs.readFileSync(from, 'utf8');
  const info = analyzeSvg(text);
  const made = {};
  if (info.needDark) {
    if (!CHECK_ONLY) {
      const dir = path.join(outDir, 'dark');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), recolor(text, WHITE, isInk), 'utf8');
    }
    made.dark = `icons/dark/${name}`;
    stats.dark += 1;
  }
  if (info.needLight) {
    if (!CHECK_ONLY) {
      const dir = path.join(outDir, 'light');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), recolor(text, INK, isPaper), 'utf8');
    }
    made.light = `icons/light/${name}`;
    stats.light += 1;
  }
  if (Object.keys(made).length) variants[item.key] = made;
  else stats.skipped += 1;

  if (process.argv.includes('--debug')) {
    console.log(
      '  ' + item.key.padEnd(16) + name.padEnd(20),
      JSON.stringify({ colors: info.colors, current: info.usesCurrentColor, inheritBlack: info.inheritsBlack, dark: info.needDark, light: info.needLight }),
    );
  }
}

const banner = `// 由 tools/build-icons.js 自动生成，请不要手改。
// 图标来源：https://github.com/farion1231/cc-switch（MIT）下的 assets/logos（详见 assets/logos/README.md）。
`;

const body = `${banner}
window.AIHUB_ICONS = {
  // 服务 icon 字段 / 域名匹配用的图标表：key -> 相对路径
  files: ${JSON.stringify(files, null, 2)},
  // 深/浅主题下需要换色的图标（避免给 logo 垫白底）
  variants: ${JSON.stringify(variants, null, 2)},
  // 域名 -> key，用户自己加的服务也能自动配上 logo
  hosts: ${JSON.stringify(HOSTS, null, 2)},
  // key 别名
  aliases: ${JSON.stringify(ALIASES, null, 2)},
};
`;

if (CHECK_ONLY) {
  // 期望值 vs 现状：文件齐不齐、icons.js 是不是最新的
  const expected = [...Object.values(files)];
  for (const made of Object.values(variants)) expected.push(...Object.values(made));
  const missing = expected.filter((rel) => !fs.existsSync(path.join(root, rel)));
  const onDisk = fs.readFileSync(path.join(root, 'icons.js'), 'utf8');
  const stale = onDisk.trim() !== body.trim();
  const leaked = fs.existsSync(path.join(outDir, 'menu'))
    ? expected.filter((rel) => rel.startsWith('icons/menu/'))
    : [];
  console.log(`图标检查: manifest ${copied} 个 -> icons/，变体 深 ${stats.dark} / 浅 ${stats.light}`);
  if (missing.length) console.log(`  ✗ 缺文件 ${missing.length} 个：${missing.slice(0, 6).join(' ')}`);
  if (stale) console.log('  ✗ icons.js 与 manifest 不一致（重新跑 npm run icons）');
  if (leaked.length) console.log(`  ✗ 有 ${leaked.length} 个文件混进了 icons/ 顶层`);

  // Tauri 前端目录也得有一份，否则标签栏上全是破图。
  // 这条是补上一次真实事故：迁移时只搬了 html/js，忘了 icons/ 和 build/icon.png。
  const uiDir = path.join(root, 'src-ui');
  const uiMissing = fs.existsSync(uiDir)
    ? expected
        .filter((rel) => !fs.existsSync(path.join(uiDir, rel)))
        .concat(fs.existsSync(path.join(uiDir, 'build', 'icon.png')) ? [] : ['build/icon.png'])
    : [];
  if (uiMissing.length) {
    console.log(`  ✗ src-ui/ 里缺 ${uiMissing.length} 个：${uiMissing.slice(0, 6).join(' ')}（跑 npm run icons 同步）`);
  }

  if (!missing.length && !stale && !leaked.length && !uiMissing.length) {
    console.log('  ✓ icons/、icons.js、src-ui/ 都是最新的');
  }
  process.exit(missing.length || stale || leaked.length || uiMissing.length ? 1 : 0);
}

fs.writeFileSync(path.join(root, 'icons.js'), body, 'utf8');

// Tauri 版的前端根目录是 src-ui/，图标按相对路径 icons/xxx.svg 加载，
// 所以生成完要同步一份过去——不然标签栏上全是破图占位符。
// （Electron 版从仓库根加载，用的是根目录那份，两边都得有。）
syncToFrontend();

console.log('图标文件:', copied, '个 ->', path.relative(root, outDir));
console.log('主题变体: 深色', stats.dark, '个 / 浅色', stats.light, '个 / 无需变体', stats.skipped, '个');
console.log('icons.js:', (body.length / 1024).toFixed(1), 'KB，域名映射', Object.keys(HOSTS).length, '条');

/** 把 icons/ 和 icons.js 同步到 Tauri 前端目录 src-ui/ */
function syncToFrontend() {
  const uiDir = path.join(root, 'src-ui');
  if (!fs.existsSync(uiDir)) return; // 没有 Tauri 那套就算了

  const uiIcons = path.join(uiDir, 'icons');
  fs.rmSync(uiIcons, { recursive: true, force: true });
  fs.cpSync(outDir, uiIcons, { recursive: true });
  fs.copyFileSync(path.join(root, 'icons.js'), path.join(uiDir, 'icons.js'));

  // 设置面板头部的品牌图标走 build/icon.png
  const brand = path.join(root, 'build', 'icon.png');
  if (fs.existsSync(brand)) {
    fs.mkdirSync(path.join(uiDir, 'build'), { recursive: true });
    fs.copyFileSync(brand, path.join(uiDir, 'build', 'icon.png'));
  }
  console.log('已同步到 src-ui/（Tauri 前端根目录）');
}
