// 检查打包产物里到底带了哪些文件（尤其是 icons/ 有没有漏进安装包）
//
// 用法：npm run dist 之后执行  node tools/check-package.js
// 原理：直接读 dist/win-unpacked/resources/app.asar 的头部索引，不依赖任何依赖包。
// 背景：package.json 的 build.files 是白名单，新增的渲染层资源（比如 icons/）忘了加进去，
//       开发时一切正常、装完之后图标全没了——这个脚本就是盯这个坑的。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asar)) {
  console.error('没找到', asar);
  console.error('先跑 npm run dist 或 npm run dist:dir');
  process.exit(1);
}

const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
// asar = [uint32 = 4][uint32 头长度][uint32 头字符串长度][头 JSON]，头后面按 4 字节对齐再放数据
const headerSize = head.readUInt32LE(8) || head.readUInt32LE(4);
const buf = Buffer.alloc(headerSize + 8);
fs.readSync(fd, buf, 0, buf.length, 16);
fs.closeSync(fd);

const text = buf.toString('utf8');
const header = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));

const walk = (node, prefix, out) => {
  for (const [name, value] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (value.files) walk(value, p, out);
    else out.push({ path: p, size: value.size || 0 });
  }
};
const files = [];
walk(header, '', files);

const top = {};
for (const f of files) {
  const key = f.path.includes('/') ? `${f.path.split('/')[0]}/` : f.path;
  top[key] = (top[key] || 0) + 1;
}

const icons = files.filter((f) => f.path.startsWith('icons/'));
const iconBytes = icons.reduce((a, b) => a + b.size, 0);

console.log('安装包内容（app.asar）：');
for (const [key, count] of Object.entries(top).sort()) {
  console.log(`  ${key.padEnd(18)} ${count} 个文件`);
}
console.log(`\nicons/ 共 ${icons.length} 个、${Math.round(iconBytes / 1024)} KB`);

const problems = [];
if (!files.some((f) => f.path === 'icons.js')) problems.push('缺少 icons.js（标签栏读不到图标表）');
if (icons.length < 50) problems.push(`icons/ 只有 ${icons.length} 个文件，像是没打进包`);
for (const need of ['icons/deepseek.svg', 'icons/chatgpt.svg', 'icons/claude.svg', 'icons/doubao.svg', 'icons/kimi.svg', 'icons/chatglm.svg', 'icons/gemini.svg']) {
  if (!files.some((f) => f.path === need)) problems.push(`缺少 ${need}`);
}
// 主题变体和原生菜单用的 PNG 也必须进包，否则反白/压深和分屏菜单的 logo 会不见
for (const need of ['icons/dark/kimi.svg', 'icons/light/chatgpt.svg', 'icons/menu/dark/deepseek.png', 'icons/menu/light/chatgpt.png']) {
  if (!files.some((f) => f.path === need)) problems.push(`缺少 ${need}（主题变体 / 菜单图标没进包）`);
}
const menuIcons = icons.filter((f) => f.path.startsWith('icons/menu/'));
if (menuIcons.length < 100) problems.push(`icons/menu 只有 ${menuIcons.length} 个，原生菜单会缺 logo（跑 npm run menu-icons）`);
// 托盘图标：窗口收进后台后的兜底入口，缺了的话打包版就没有托盘（快捷键唤出仍在）
if (!files.some((f) => f.path === 'build/icon.png')) {
  problems.push('缺少 build/icon.png（托盘图标 + 窗口图标会缺失）');
}
for (const f of files) {
  if (/^(assets|tools|dist)\//.test(f.path)) problems.push(`不该打包的目录进了包：${f.path}`);
}

if (problems.length) {
  console.log('\n✗ 有问题：');
  problems.forEach((p) => console.log('  -', p));
  process.exit(1);
}
console.log('\n✓ 打包内容正常：图标和图标表都在，assets/tools 没有被带进包');
