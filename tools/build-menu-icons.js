'use strict';

/**
 * 把图标光栅化成 32×32 的 PNG，给 Windows 原生菜单当条目图标用。
 *
 * 为什么需要这一步：原生菜单（Menu.popup）只认位图，不认 SVG，
 * 而仓库里的 logo 绝大多数是 SVG。所以打包前跑一次这个脚本，
 * 把 icons/ 下每个 key 都出一份 icons/menu/<tone>/<key>.png。
 *
 * tone 两套是因为原生菜单的底色跟着系统/应用主题走：
 *   dark  -> 用 icons/dark 那套反白变体（黑 logo 才看得见）
 *   light -> 用 icons/light 那套压深变体（白 logo 才看得见）
 *
 * 用法：node_modules\.bin\electron tools\build-menu-icons.js
 *      node tools\build-menu-icons.js --check   （只检查是否齐全，不重新生成）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'icons');
const OUT = path.join(ICONS, 'menu');
const SIZE = 32;
// --check 只对文件系统做检查，可以用普通 node 跑（打包前的校验链路里会用到）
const CHECK_ONLY = process.argv.includes('--check');
const electron = CHECK_ONLY ? null : require('electron');

function readTable() {
  const code = fs.readFileSync(path.join(ROOT, 'icons.js'), 'utf8');
  const fake = {};
  new Function('window', code)(fake);
  if (!fake.AIHUB_ICONS) throw new Error('icons.js 里没有 AIHUB_ICONS');
  return fake.AIHUB_ICONS;
}

/** 从 SVG 里猜一个宽高比，SVG 没写 width/height 时用它兜底 */
function aspectOf(file) {
  if (!/\.svg$/i.test(file)) return 1;
  const text = fs.readFileSync(file, 'utf8');
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return parts[2] / parts[3];
  }
  const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(text);
  const h = /\bheight\s*=\s*["']([\d.]+)/i.exec(text);
  if (w && h && Number(h[1]) > 0) return Number(w[1]) / Number(h[1]);
  return 1;
}

function toneJobs(table) {
  const jobs = [];
  for (const key of Object.keys(table.files || {})) {
    const variant = (table.variants || {})[key] || {};
    for (const tone of ['dark', 'light']) {
      const rel = tone === 'dark' ? (variant.dark || table.files[key]) : (variant.light || table.files[key]);
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) continue;
      jobs.push({ tone, key, rel, src, out: path.join(OUT, tone, `${key}.png`) });
    }
  }
  return jobs;
}

function missing(jobs) {
  return jobs.filter((job) => !fs.existsSync(job.out) || fs.statSync(job.out).size === 0);
}

function report(jobs, wrote) {
  const miss = missing(jobs);
  const counts = { dark: 0, light: 0 };
  for (const job of jobs) if (fs.existsSync(job.out)) counts[job.tone] += 1;
  const total = jobs.reduce((sum, job) => sum + (fs.existsSync(job.out) ? fs.statSync(job.out).size : 0), 0);
  console.log(`菜单图标: ${jobs.length} 个（dark ${counts.dark} / light ${counts.light}），${(total / 1024).toFixed(0)} KB`);
  if (wrote) console.log(`  本次生成/更新 ${wrote} 个 -> icons/menu/`);
  if (miss.length) {
    console.log(`  ✗ 缺 ${miss.length} 个：${miss.slice(0, 8).map((m) => `${m.tone}/${m.key}`).join(' ')}${miss.length > 8 ? ' …' : ''}`);
    return false;
  }
  console.log('  ✓ 每个图标都有菜单用的 PNG');
  return true;
}

async function main() {
  const table = readTable();
  const jobs = toneJobs(table);
  if (CHECK_ONLY) {
    process.exit(report(jobs, 0) ? 0 : 1);
  }
  const { app, BrowserWindow } = electron;

  fs.rmSync(OUT, { recursive: true, force: true });
  for (const tone of ['dark', 'light']) fs.mkdirSync(path.join(OUT, tone), { recursive: true });

  // 页面放在临时目录，图片用 data: 内联，这样画到 canvas 上不会污染画布
  const html = ['<!DOCTYPE html><meta charset="utf-8"><body style="margin:0">'];
  for (const job of jobs) {
    const b64 = fs.readFileSync(job.src).toString('base64');
    const mime = /\.svg$/i.test(job.src) ? 'image/svg+xml' : 'image/png';
    const ratio = aspectOf(job.src);
    const w = ratio >= 1 ? SIZE : Math.max(1, Math.round(SIZE * ratio));
    const h = ratio >= 1 ? Math.max(1, Math.round(SIZE / ratio)) : SIZE;
    html.push(`<img id="i${job.index || 0}" data-out="${job.tone}/${job.key}" width="${w}" height="${h}" src="data:${mime};base64,${b64}">`);
  }
  html.push('</body>');
  const page = path.join(os.tmpdir(), `aihub-menu-icons-${process.pid}.html`);
  fs.writeFileSync(page, html.join(''), 'utf8');

  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
  await win.loadFile(page);
  const dataUrls = JSON.parse(await win.webContents.executeJavaScript(`(async () => {
    const imgs = [...document.querySelectorAll('img[data-out]')];
    await Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
    const out = {};
    for (const im of imgs) {
      const w = im.naturalWidth || im.width || 32;
      const h = im.naturalHeight || im.height || 32;
      if (!w || !h) { out[im.dataset.out] = ''; continue; }
      const c = document.createElement('canvas');
      c.width = ${SIZE}; c.height = ${SIZE};
      const ctx = c.getContext('2d');
      const ratio = Math.min(${SIZE} / w, ${SIZE} / h);
      const dw = Math.max(1, Math.round(w * ratio));
      const dh = Math.max(1, Math.round(h * ratio));
      ctx.drawImage(im, Math.round((${SIZE} - dw) / 2), Math.round((${SIZE} - dh) / 2), dw, dh);
      out[im.dataset.out] = c.toDataURL('image/png');
    }
    return JSON.stringify(out);
  })()`));

  let wrote = 0;
  for (const job of jobs) {
    const url = dataUrls[`${job.tone}/${job.key}`];
    if (!url || !url.startsWith('data:image/png;base64,')) continue;
    fs.writeFileSync(job.out, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
    wrote += 1;
  }

  try { win.destroy(); } catch { /* 忽略 */ }
  try { fs.rmSync(page, { force: true }); } catch { /* 忽略 */ }
  app.exit(report(jobs, wrote) ? 0 : 1);
}

bootstrap();

function bootstrap() {
  if (CHECK_ONLY) {
    // 纯 Node 路径：只检查 icons/menu 是否与 icons.js 对得上
    try {
      main();
    } catch (err) {
      console.error('检查菜单图标失败:', err.message);
      process.exit(1);
    }
    return;
  }
  // 生成路径必须在 Electron 里跑（要靠 Chromium 把 SVG 画到 canvas 上）
  const { app } = electron;
  app.disableHardwareAcceleration();
  app.whenReady().then(() => main().catch((err) => {
    console.error('生成菜单图标失败:', err);
    app.exit(1);
  }));
}
