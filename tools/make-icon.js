'use strict';

/**
 * 生成品牌素材（无第三方依赖，靠 Electron 自带的 Chromium 解码/缩放 + canvas 取像素）。
 *
 *   npm run icon          # 生成
 *   npm run icon -- --check   # 只检查产物是不是最新（CI 用，不写盘）
 *
 * 源图：assets/brand/logo-source.png（设计稿原图，完整锁版：图形 + Aihub 字标）
 *
 * 产物：
 *   build/icon.ico              多分辨率图标（16/32/48/64/128/256，BMP 条目，兼容性最好）
 *   build/icon.png              1024x1024 图形（打包用：Windows 图标 + macOS 的 icns 来源）
 *   build/tray.png              32x32 托盘/菜单栏图标
 *   build/tray@2x.png           64x64 高分屏版本（macOS 会自己找同名 @2x 文件）
 *   assets/brand/logo.png       裁掉多余留白的完整锁版（README 用）
 *   assets/brand/logo-mark.png  512x512 图形（正方形，居中留边）
 *
 * 关键点：源图是「图形在上、字标在下」的锁版，直接缩成方图当图标，字会糊成一团。
 * 所以这里先用 alpha 通道把图形那一段切出来（顶部连续非空行），再裁成正方形加留白。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron');
const { app, BrowserWindow } = electron;

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'brand', 'logo-source.png');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');
const BUILD_DIR = path.join(ROOT, 'build');

const CHECK_ONLY = process.argv.includes('--check');

// 图标里每一档都要有：小尺寸给任务栏/资源管理器，大尺寸给高分屏
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
// 1024 是 macOS 图标的标准尺寸（electron-builder 用它现场转 icns，所以不能小于 512）
const ICON_PNG = 1024;   // build/icon.png
const LOCKUP_MAX = 1024; // assets/brand/logo.png 的长边上限
const MARK_PNG = 512;    // assets/brand/logo-mark.png
const TRAY_PNG = 32;     // build/tray.png（Windows 托盘 / macOS 菜单栏）
const MARGIN = 1.22;     // 图形外面留多少边（1.16 = 图形占画布约 86%）
const INK_ALPHA = 60;    // 高于这个 alpha 才算「真的有内容」（低于它多半是去背残留）
const MIN_ROW_RATIO = 0.004; // 一行/一列里至少要有这么多比例的像素有内容才算数
// 去背参数。设计稿的背景是「带噪点的浅灰」（不是纯色，也不是真透明），
// 而图形本身是高饱和蓝 / 深藏青，所以判据是「接近无彩 且 很亮」= 背景。
const SAT_TOL = 20;      // 饱和度低于它就往「无彩」靠
const SAT_RAMP = 12;     // 无彩判定过渡带
const BG_LUM = 120;      // 亮度高于它才开始算背景
const BG_RAMP = 30;      // 亮度过渡带（到 BG_LUM + BG_RAMP 就是纯背景）

// ---------------------------------------------------------------------------
// ICO 编码：32 位 BMP 条目（Windows 全版本都认，比 PNG 条目兼容性好）
// ---------------------------------------------------------------------------

function encodeIcoBmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);              // biSize
  header.writeInt32LE(size, 4);             // biWidth
  header.writeInt32LE(size * 2, 8);         // biHeight：XOR + AND 两张图
  header.writeUInt16LE(1, 12);              // biPlanes
  header.writeUInt16LE(32, 14);             // biBitCount
  header.writeUInt32LE(0, 16);              // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  // XOR 位图：BGRA，自下而上
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  // AND 掩码：1bpp，行按 4 字节对齐，全 0（透明度交给 alpha 通道）
  const maskStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, xor, and]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = [];
  const images = [];
  let offset = 6 + entries.length * 16;
  for (const entry of entries) {
    const image = encodeIcoBmpEntry(entry.size, entry.rgba);
    const item = Buffer.alloc(16);
    item.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);
    item.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);
    item.writeUInt8(0, 2);          // 调色板数量
    item.writeUInt8(0, 3);          // reserved
    item.writeUInt16LE(1, 4);       // planes
    item.writeUInt16LE(32, 6);      // bit count
    item.writeUInt32LE(image.length, 8);
    item.writeUInt32LE(offset, 12);
    offset += image.length;
    directory.push(item);
    images.push(image);
  }

  return Buffer.concat([header, ...directory, ...images]);
}

// ---------------------------------------------------------------------------
// 渲染进程里做图像处理（Chromium 的缩放质量比自己写重采样好）
// ---------------------------------------------------------------------------

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; img-src data:;" />
</head><body><script>
const DATA_URL = __DATA_URL__;

/** Uint8ClampedArray -> base64（分块，避免一次展开上百万个参数爆栈） */
function toBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 在离屏 canvas 上按源矩形绘到目标尺寸，返回原始 RGBA */
function renderPixels(img, sx, sy, sw, sh, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

function renderPng(img, sx, sy, sw, sh, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return c.toDataURL('image/png');
}

window.__run = async () => {
  const img = new Image();
  img.src = DATA_URL;
  await img.decode();
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const px = sctx.getImageData(0, 0, W, H).data;

  // 0) 去背。
  //    设计稿导出时常常把「透明棋盘格」直接烤进像素里（这里就是：背景是 251/197 两种
  //    近白灰，alpha 全是 255），直接缩成图标会得到一个带格子的方块。
  //    这里按「接近无彩 + 很亮」判定为背景，并留一条渐变带，边缘不会出现硬锯齿。
  let keyed = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]; const g = px[i + 1]; const b = px[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx - mn;                       // 0 = 完全无彩
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const neutral = Math.max(0, Math.min(1, (__SAT_TOL__ - sat) / __SAT_RAMP__)); // 越无彩越像背景
    const light = Math.max(0, Math.min(1, (lum - __BG_LUM__) / __BG_RAMP__));
    const backgroundness = neutral * light;
    if (backgroundness > 0) {
      const a = px[i + 3] * (1 - backgroundness);
      if (a !== px[i + 3]) keyed += 1;
      px[i + 3] = a;
    }
  }
  sctx.putImageData(new ImageData(px, W, H), 0, 0);
  // 后面所有裁剪都从这张去过背的图上取
  const clean = src;

  // 1) 每行统计「真的有内容」的像素数。
  //    注意不能只看「有没有一个透明像素」：细小的杂色噪点会让每一行都算有内容，
  //    图形和字标就切不开了。
  const INK_ALPHA = __INK_ALPHA__;
  const MIN_ROW_INK = Math.max(2, Math.round(W * __MIN_ROW_RATIO__));
  const rowInk = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    const base = y * W * 4;
    let n = 0;
    for (let x = 0; x < W; x++) {
      if (px[base + x * 4 + 3] > INK_ALPHA) n += 1;
    }
    rowInk[y] = n;
  }

  // 2) 图形 / 字标的分界 = 下半部分第一段「足够长的连续空行」
  const GAP_ROWS = 8;
  let gapStart = -1;
  let runStart = -1;
  for (let y = Math.round(H * 0.3); y < H; y++) {
    if (rowInk[y] < MIN_ROW_INK) {
      if (runStart < 0) runStart = y;
      if (y - runStart + 1 >= GAP_ROWS) { gapStart = runStart; break; }
    } else {
      runStart = -1;
    }
  }

  let usedFallback = false;
  let markTop = 0;
  let markBottom = H - 1;
  if (gapStart > 0) {
    markBottom = gapStart - 1;
  } else {
    usedFallback = true;
    markBottom = Math.round(H * 0.62);
  }
  while (markBottom > 0 && rowInk[markBottom] < MIN_ROW_INK) markBottom -= 1;
  while (markTop < markBottom && rowInk[markTop] < MIN_ROW_INK) markTop += 1;

  // 3) 在图形这一段里求左右边界（按列统计，避免一两像素的杂色把边界撑开）
  const MIN_COL_INK = Math.max(2, Math.round((markBottom - markTop + 1) * __MIN_ROW_RATIO__));
  let left = -1;
  let right = -1;
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = markTop; y <= markBottom; y++) {
      if (px[(y * W + x) * 4 + 3] > INK_ALPHA) n += 1;
    }
    if (n >= MIN_COL_INK) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (right < 0) throw new Error('图形部分没有找到不透明像素');

  // 4) 裁成正方形：以图形的中心为中心，边长 = 长边 * 留边系数
  const markW = right - left + 1;
  const markH = markBottom - markTop + 1;
  const side = Math.min(Math.max(markW, markH) * __MARGIN__, Math.min(W, H));
  const cx = left + markW / 2;
  const cy = markTop + markH / 2;
  let sx = Math.round(cx - side / 2);
  let sy = Math.round(cy - side / 2);
  sx = Math.max(0, Math.min(W - side, sx));
  sy = Math.max(0, Math.min(H - side, sy));
  const sSide = Math.round(side);

  // 4) 只要「图形」这一块：方形裁剪的边长按图形的长边算，
  //    竖直方向必然会伸到字标里去（图标底部会露出 "Aihub" 的顶端），所以这里把
  //    图形上下之外的内容直接清掉，再拿去缩各种尺寸。
  const markCanvas = document.createElement('canvas');
  markCanvas.width = W; markCanvas.height = H;
  const mctx = markCanvas.getContext('2d', { willReadFrequently: true });
  mctx.drawImage(clean, 0, 0);
  if (markTop > 0) mctx.clearRect(0, 0, W, markTop);
  if (markBottom + 1 < H) mctx.clearRect(0, markBottom + 1, W, H - markBottom - 1);

  // 5) 每一档图标都要原始像素（Node 侧编码成 ICO）。都从「只有图形」的画布上取。
  const sizes = {};
  for (const size of __ICO_SIZES__) {
    sizes[size] = toBase64(renderPixels(markCanvas, sx, sy, sSide, sSide, size));
  }

  // 6) README / 文档用的两张图（锁版要带字标，所以用 clean）
  const lockupW = Math.min(W, __LOCKUP_MAX__);
  const lockup = renderPng(clean, 0, markTop, W, H - markTop, lockupW,
    Math.round((H - markTop) * lockupW / W));
  const markPng = renderPng(markCanvas, sx, sy, sSide, sSide, __MARK_PNG__, __MARK_PNG__);
  const iconPng = renderPng(markCanvas, sx, sy, sSide, sSide, __ICON_PNG__, __ICON_PNG__);
  // 托盘：小尺寸直接从小画布重采样，别拿 1024 硬缩，边缘会发灰。
  // 而且托盘 / 菜单栏要的是「图形尽量占满」，所以这里用贴合图形的裁剪（留边 1.02），
  // 不用图标那套 1.22 的留白——否则在 16px 的菜单栏里会显得又小又空。
  const traySide = Math.round(Math.max(markW, markH) * 1.02);
  let tsx = Math.round(cx - traySide / 2);
  let tsy = Math.round(cy - traySide / 2);
  tsx = Math.max(0, Math.min(W - traySide, tsx));
  tsy = Math.max(0, Math.min(H - traySide, tsy));
  const trayPng = renderPng(markCanvas, tsx, tsy, traySide, traySide, __TRAY_PNG__, __TRAY_PNG__);
  const tray2xPng = renderPng(markCanvas, tsx, tsy, traySide, traySide, __TRAY_PNG__ * 2, __TRAY_PNG__ * 2);

  return {
    source: { width: W, height: H },
    keyed,
    mark: { top: markTop, bottom: markBottom, left, right, width: markW, height: markH },
    crop: { x: sx, y: sy, side: sSide },
    usedFallback,
    sizes,
    lockup,
    markPng,
    iconPng,
    trayPng,
    tray2xPng,
  };
};
</script></body></html>`;

function html() {
  // 注意用 replaceAll：同一个占位符在页面里出现多次（比如 __MARK_PNG__ 用了两处），
  // String.replace 只换第一处，剩下的会变成 "xxx is not defined"。
  return PAGE
    .replaceAll('__DATA_URL__', JSON.stringify(
      'data:image/png;base64,' + fs.readFileSync(SOURCE).toString('base64'),
    ))
    .replaceAll('__ICO_SIZES__', JSON.stringify(ICO_SIZES))
    .replaceAll('__MARGIN__', String(MARGIN))
    .replaceAll('__INK_ALPHA__', String(INK_ALPHA))
    .replaceAll('__MIN_ROW_RATIO__', String(MIN_ROW_RATIO))
    .replaceAll('__SAT_TOL__', String(SAT_TOL))
    .replaceAll('__SAT_RAMP__', String(SAT_RAMP))
    .replaceAll('__BG_LUM__', String(BG_LUM))
    .replaceAll('__BG_RAMP__', String(BG_RAMP))
    .replaceAll('__LOCKUP_MAX__', String(LOCKUP_MAX))
    .replaceAll('__MARK_PNG__', String(MARK_PNG))
    .replaceAll('__ICON_PNG__', String(ICON_PNG))
    .replaceAll('__TRAY_PNG__', String(TRAY_PNG));
}

// ---------------------------------------------------------------------------

function dataUrlToBuffer(url) {
  return Buffer.from(String(url).split(',')[1], 'base64');
}

function writeIfChanged(file, buffer) {
  if (CHECK_ONLY) {
    const same = fs.existsSync(file) && fs.readFileSync(file).equals(buffer);
    return { file, changed: !same, bytes: buffer.length };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return { file, changed: true, bytes: buffer.length };
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    // 设计稿原图不进仓库（2 MB，只在本地用来生成素材），生成出来的图都已提交，
    // 所以克隆下来没有源图是正常的：跳过，不要让 CI 挂在这一步。
    console.log('没有设计稿源图（' + path.relative(ROOT, SOURCE).replace(/\\/g, '/') + '），跳过。');
    console.log('已提交的图标就是最终产物；需要重新生成时把原图放回该路径即可。');
    app.exit(0);
    return;
  }

  // 页面本身写成临时文件再加载：源图 2 MB，塞进 data: URL 会超过 Chromium 的长度上限。
  // 图片仍然用 data: URL（file:// 的图会污染 canvas，getImageData 会被安全策略拦下）。
  const pagePath = path.join(os.tmpdir(), 'aihub-make-icon.html');
  fs.writeFileSync(pagePath, html(), 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(pagePath);
  const result = await win.webContents.executeJavaScript('window.__run()');
  win.destroy();
  try {
    fs.unlinkSync(pagePath);
  } catch {
    /* 临时文件删不掉不影响结果 */
  }

  const entries = ICO_SIZES.map((size) => ({ size, rgba: Buffer.from(result.sizes[size], 'base64') }));
  const results = [];
  results.push(writeIfChanged(path.join(BUILD_DIR, 'icon.ico'), encodeIco(entries)));
  results.push(writeIfChanged(path.join(BUILD_DIR, 'icon.png'), dataUrlToBuffer(result.iconPng)));
  results.push(writeIfChanged(path.join(BUILD_DIR, 'tray.png'), dataUrlToBuffer(result.trayPng)));
  results.push(writeIfChanged(path.join(BUILD_DIR, 'tray@2x.png'), dataUrlToBuffer(result.tray2xPng)));
  results.push(writeIfChanged(path.join(BRAND_DIR, 'logo.png'), dataUrlToBuffer(result.lockup)));
  results.push(writeIfChanged(path.join(BRAND_DIR, 'logo-mark.png'), dataUrlToBuffer(result.markPng)));

  const mark = result.mark;
  console.log(`源图 ${result.source.width}x${result.source.height}，` +
    `去背处理了 ${result.keyed} 个像素`);
  console.log(`图形部分 ${mark.width}x${mark.height}（y ${mark.top}–${mark.bottom}）`);
  if (result.usedFallback) {
    console.log('  提示：图形和字标之间没有找到空行，按上 62% 估算的图形范围');
  }
  console.log(`裁成正方形 ${result.crop.side}x${result.crop.side}（留边 ${MARGIN} 倍）`);
  for (const item of results) {
    const rel = path.relative(ROOT, item.file).replace(/\\/g, '/');
    console.log(`  ${CHECK_ONLY && item.changed ? '✗ 需要重新生成 ' : '✓ '}${rel}  ${(item.bytes / 1024).toFixed(1)} KB`);
  }

  if (CHECK_ONLY && results.some((r) => r.changed)) {
    console.error('\n图标不是最新的，跑一次 npm run icon');
    app.exit(1);
    return;
  }
  app.exit(0);
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('生成图标失败:', err && err.message);
    app.exit(1);
  });
});
