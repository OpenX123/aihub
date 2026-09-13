// 从 cc-switch 源码导出全部厂商 logo，整理成「一家一张图」+ 原始素材留档
const fs = require('fs');
const path = require('path');

const srcDir = process.argv[2];
const outDir = process.argv[3];

const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
const metaText = fs.readFileSync(path.join(srcDir, 'metadata.ts'), 'utf8');

// ---- 1. import 映射（去掉 ?url 之类的查询串） ----
const importMap = new Map();
for (const m of index.matchAll(/import\s+(_\w+)\s+from\s+"\.\/([^"]+)"/g)) {
  importMap.set(m[1], m[2].split('?')[0]);
}

// ---- 2. 内联 SVG ----
const inlineIcons = new Map();
const iconsBlock = index.split(/export const icons[^=]*=\s*\{/)[1]?.split(/\n\};/)[0] || '';
for (const m of iconsBlock.matchAll(/^\s{2}"?([\w.-]+)"?:\s*`(<svg[\s\S]*?)`,?\s*$/gm)) {
  inlineIcons.set(m[1], m[2]);
}

// ---- 3. 注册的文件图标 ----
const fileIcons = new Map();
const urlsBlock = index.split(/export const iconUrls[^=]*=\s*\{/)[1]?.split(/\n\};/)[0] || '';
for (const m of urlsBlock.matchAll(/^\s{2}"?([\w.-]+)"?:\s*(_\w+),?\s*$/gm)) {
  const file = importMap.get(m[2]);
  if (file) fileIcons.set(m[1], file);
}

// ---- 4. metadata（用花括号配对解析，关键词数组是多行的） ----
const meta = new Map();
const metaBlock = metaText.split(/export const iconMetadata[^=]*=\s*\{/)[1] || '';
const entryStart = /^\s{2}"?([\w.-]+)"?:\s*\{/gm;
let match;
while ((match = entryStart.exec(metaBlock))) {
  let depth = 0;
  let i = match.index + match[0].length - 1;
  for (; i < metaBlock.length; i += 1) {
    if (metaBlock[i] === '{') depth += 1;
    else if (metaBlock[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = metaBlock.slice(match.index, i + 1);
  const displayName = /displayName:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] || match[1];
  const category = /category:\s*"([^"]*)"/.exec(body)?.[1] || '';
  const defaultColor = /defaultColor:\s*"([^"]*)"/.exec(body)?.[1] || '';
  const keywords = [...body.matchAll(/"([^"]+)"/g)]
    .map((k) => k[1])
    .filter((k) => k !== displayName && k !== category && k !== defaultColor && k !== match[1]);
  meta.set(match[1], { displayName, category, defaultColor, keywords: [...new Set(keywords)].slice(0, 10) });
}

// ---- 5. 目录里按约定命名、没被注册表引用的矢量文件 ----
const allFiles = fs.readdirSync(srcDir).filter((n) => /\.(svg|png|jpe?g|webp)$/i.test(n));
const registered = new Set([...fileIcons.values()].map((n) => n.toLowerCase()));
const convention = new Map();
const aliasSkipped = [];
for (const name of allFiles) {
  const base = path.basename(name, path.extname(name));
  // 这个文件已经被某个注册名认领了（例如 a6-icon.png 属于 a6api），就不再单列一条别名
  if (registered.has(name.toLowerCase())) {
    aliasSkipped.push(`${base} → 已由注册名认领`);
    continue;
  }
  convention.set(base, name);
}

// 5b. 另一个图标目录：src/assets/icons（chatgpt.svg 等只在这里有）
const assetsIconDir = path.resolve(srcDir, '..', '..', 'assets', 'icons');
const extraFiles = fs.existsSync(assetsIconDir)
  ? fs.readdirSync(assetsIconDir).filter((n) => /\.(svg|png|jpe?g|webp)$/i.test(n))
  : [];
const extraConvention = new Map();
for (const name of extraFiles) {
  const base = path.basename(name, path.extname(name));
  if (base === 'app-icon') continue; // cc-switch 自己的应用图标，不是厂商 logo
  if (convention.has(base)) continue;
  extraConvention.set(base, path.join(assetsIconDir, name));
}

// ---- 6. 合并成「一家一条」 ----
const keys = new Set([...inlineIcons.keys(), ...fileIcons.keys(), ...convention.keys(), ...extraConvention.keys(), ...meta.keys()]);
const entries = [];
for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
  const canonical = inlineIcons.has(key)
    ? { kind: 'svg', source: 'inline', content: inlineIcons.get(key), ext: '.svg' }
    : convention.has(key)
      ? { kind: 'file', source: 'convention', from: path.join(srcDir, convention.get(key)), ext: path.extname(convention.get(key)).toLowerCase() }
      : extraConvention.has(key)
        ? { kind: 'file', source: 'assets-icons', from: extraConvention.get(key), ext: path.extname(extraConvention.get(key)).toLowerCase() }
        : fileIcons.has(key)
          ? { kind: 'file', source: 'registry', from: path.join(srcDir, fileIcons.get(key)), ext: path.extname(fileIcons.get(key)).toLowerCase() }
          : null;
  entries.push({ key, canonical, ...(meta.get(key) || { displayName: key, category: '', defaultColor: '', keywords: [] }) });
}

const withArt = entries.filter((e) => e.canonical);
const withoutArt = entries.filter((e) => !e.canonical);

// ---- 7. 落盘：一家一张图 ----
const logoDir = path.join(outDir, 'logos');
const rawSvgDir = path.join(outDir, '_raw', 'svg');
const rawFileDir = path.join(outDir, '_raw', 'files');
const rawAssetsDir = path.join(outDir, '_raw', 'assets-icons');
fs.mkdirSync(logoDir, { recursive: true });
fs.mkdirSync(rawSvgDir, { recursive: true });
fs.mkdirSync(rawFileDir, { recursive: true });
fs.mkdirSync(rawAssetsDir, { recursive: true });

const manifest = [];
const seenOut = new Set();
for (const entry of withArt) {
  const { canonical } = entry;
  const outName = `${entry.key}${canonical.ext}`;
  if (canonical.kind === 'svg') {
    fs.writeFileSync(path.join(logoDir, outName), `${canonical.content.trim()}\n`, 'utf8');
  } else {
    fs.copyFileSync(canonical.from, path.join(logoDir, outName));
  }
  seenOut.add(outName);
  // 备选素材：同一家有多种来源时都留一份，方便挑
  const alternates = [];
  if (inlineIcons.has(entry.key) && canonical.kind !== 'svg') alternates.push(`_raw/svg/${entry.key}.svg`);
  const canonicalBase = canonical.from ? path.basename(canonical.from) : '';
  for (const [map, prefix] of [[convention, '_raw/files/'], [extraConvention, '_raw/assets-icons/']]) {
    const from = map.get(entry.key);
    if (from && path.basename(from) !== canonicalBase) alternates.push(`${prefix}${path.basename(from)}`);
  }
  if (fileIcons.has(entry.key) && fileIcons.get(entry.key) !== canonicalBase) {
    alternates.push(`_raw/files/${fileIcons.get(entry.key)}`);
  }
  manifest.push({
    key: entry.key,
    displayName: entry.displayName,
    category: entry.category || '',
    defaultColor: entry.defaultColor || '',
    keywords: entry.keywords,
    file: `logos/${outName}`,
    kind: canonical.kind,
    source: canonical.source,
    alternates,
  });
}

// codex 在上游是用 OpenAI 的标记渲染的（BrandIcons.tsx 里 CodexIcon 直接引用 openai.svg），
// 这里补一个同图别名，方便按 key 取图
const codexAlias = { key: 'codex', displayName: 'Codex', category: 'tool', defaultColor: '',
  keywords: ['codex', 'openai', 'cli'], file: 'logos/codex.svg', kind: 'svg', source: 'alias',
  alternates: ['logos/openai.svg'], aliasOf: 'openai' };
if (!seenOut.has('codex.svg')) {
  fs.copyFileSync(path.join(logoDir, 'openai.svg'), path.join(logoDir, 'codex.svg'));
  manifest.push(codexAlias);
}

// 原始素材全部留档
let rawSvgCount = 0;
for (const [key, svg] of inlineIcons) {
  fs.writeFileSync(path.join(rawSvgDir, `${key}.svg`), `${svg.trim()}\n`, 'utf8');
  rawSvgCount += 1;
}
let rawFileCount = 0;
for (const name of allFiles) {
  fs.copyFileSync(path.join(srcDir, name), path.join(rawFileDir, name));
  rawFileCount += 1;
}
for (const name of extraFiles) {
  fs.copyFileSync(path.join(assetsIconDir, name), path.join(rawAssetsDir, name));
}
fs.copyFileSync(path.join(srcDir, 'index.ts'), path.join(outDir, '_raw', 'index.ts'));
fs.copyFileSync(path.join(srcDir, 'metadata.ts'), path.join(outDir, '_raw', 'metadata.ts'));

// ---- 8. 中文名与「国内知名」标记 ----
const cn = {
  deepseek: ['DeepSeek 深度求索', true], kimi: ['Kimi 月之暗面', true], moonshot: ['月之暗面', true],
  zhipu: ['智谱 AI', true], chatglm: ['智谱 GLM', true], glm: ['智谱 GLM', true],
  qwen: ['通义千问 阿里', true], qianwenai: ['通义千问', true], qwencloud: ['通义云', true],
  alibaba: ['阿里巴巴 / 阿里云', true], bailian: ['阿里云百炼', true],
  doubao: ['豆包 字节跳动', true], bytedance: ['字节跳动', true], huoshan: ['火山引擎', true],
  volcengine: ['火山引擎', true], minimax: ['MiniMax 稀宇科技', true],
  hunyuan: ['腾讯混元', true], tencent: ['腾讯', true],
  wenxin: ['文心一言 百度', true], baidu: ['百度', true], ernie: ['文心 ERNIE', true],
  huawei: ['华为', true], xiaomimimo: ['小米 MiMo', true], stepfun: ['阶跃星辰', true],
  longcat: ['美团 LongCat', true], yi: ['零一万物', true], zeroone: ['零一万物', true],
  siliconflow: ['硅基流动', true], modelscope: ['魔搭 ModelScope', true],
  ppio: ['PPIO 派欧云', true], ucloud: ['UCloud 优刻得', true], qiniu: ['七牛云', true],
  shengsuanyun: ['胜算云', true], aihubmix: ['AiHubMix', true], apinebula: ['APINebula 星云', true],
  packycode: ['PackyCode', true], sudocode: ['SudoCode', true], xycai: ['小云雀 AI', true],
  openai: ['OpenAI', false], chatgpt: ['ChatGPT', false], anthropic: ['Anthropic', false],
  claude: ['Claude', false], gemini: ['Google Gemini', false], google: ['Google', false],
  googlecloud: ['Google Cloud', false], gemma: ['Google Gemma', false], gemini2: ['Gemini', false],
  grok: ['xAI Grok', false], xai: ['xAI', false], meta: ['Meta Llama', false], mistral: ['Mistral', false],
  perplexity: ['Perplexity', false], cohere: ['Cohere', false], nvidia: ['NVIDIA', false],
  huggingface: ['Hugging Face', false], ollama: ['Ollama', false], openrouter: ['OpenRouter', false],
  midjourney: ['Midjourney', false], stability: ['Stability AI', false], vercel: ['Vercel', false],
  notion: ['Notion', false], github: ['GitHub', false], githubcopilot: ['GitHub Copilot', false],
  copilot: ['Copilot', false], mcp: ['MCP 协议', false], aws: ['AWS', false], azure: ['Azure', false],
  cloudflare: ['Cloudflare', false], palm: ['Google PaLM', false], novita: ['Novita AI', false],
  opencode: ['OpenCode', false], cherryin: ['CherryIn', false], pipellm: ['PipeLLM', false],
  byteplus: ['BytePlus 字节跳动海外', true], unity2: ['Unity2', false], atlascloud: ['AtlasCloud', false],
  ccsub: ['CCSub', false], claudeapi: ['Claude API 中转', false], claudecn: ['Claude 国内中转', true],
  code0: ['Code0', false], eflowcode: ['EFlowCode', false], etok: ['Etok', false], fenno: ['Fenno', false],
  hermes: ['Hermes', false], lioncc: ['LionCC', false], micu: ['MiCu', false], newapi: ['New API', true],
  nekocode: ['NekoCode', false], pateway: ['Pateway', false], relaxcode: ['RelaxCode', false],
  runapi: ['RunAPI', true], sssaicode: ['SSSAICode', false], subrouter: ['SubRouter', false],
  teamorouter: ['TeamoRouter', false], zetaapi: ['ZetaAPI', false], a6api: ['A6API', false],
  aicodemirror: ['AICodeMirror', false], aicodewith: ['AICodeWith', false], aicoding: ['AICoding', true],
  aigocode: ['AiGoCode', true], algocode: ['AlgoCode', false], amux: ['Amux', false],
  apikeyfun: ['APIKEY.FUN', false], catcoder: ['CatCoder', false], claw: ['Claw', false],
  crazyrouter: ['CrazyRouter', false], cubence: ['Cubence', false], dmx: ['DMXAPI', true],
};

const table = manifest.map((item) => {
  const [name, domestic] = cn[item.key] || ['', false];
  return { ...item, cnName: name, domestic };
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ source: 'https://github.com/farion1231/cc-switch', license: 'MIT', count: table.length, items: table }, null, 2)}\n`, 'utf8');

console.log('内联 SVG:', inlineIcons.size, ' 注册图片:', fileIcons.size, ' 按约定命名:', convention.size, ' 元数据:', meta.size);
console.log('跳过的同图别名:', aliasSkipped.length, aliasSkipped.join(' | '));
console.log('总条目:', entries.length, ' 有图:', withArt.length, ' 只有元数据没图:', withoutArt.length);
console.log('没图的条目:', withoutArt.map((e) => e.key).join(', '));
console.log('原始素材: svg', rawSvgCount, '个 / files', rawFileCount, '个');
console.log('国内知名条目:', table.filter((t) => t.domestic).length);
module.exports = { table };
