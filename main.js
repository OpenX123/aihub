'use strict';

/**
 * Aihub — 主进程
 *
 * 设计要点：
 *  1. 窗口自身是一个普通网页（index.html），只负责渲染顶部标签栏。
 *  2. 每个 AI 服务是一个独立的 WebContentsView，绑定独立的 session partition
 *     （persist:<id>），所以登录态互不干扰、重启后保持登录。
 *  3. 视图按需懒创建：没点开的标签不会占用一个 Chromium 渲染进程。
 *  4. 用 WebContentsView 而不是 BrowserView：后者自 Electron 30 起已废弃。
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { randomUUID } = crypto;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const TAB_BAR_HEIGHT = 44; // 与 index.html 里 #bar 的高度保持一致
// 栏与栏之间留出的缝隙。它同时是分隔条的可点区域（这块区域不被任何视图覆盖，
// 所以标签栏页面能收到鼠标事件），别调得太小。
const SPLIT_GAP = 4; // 两栏之间的缝隙（视觉上就是一条细线，越窄越像一整块界面）
const DIVIDER_HIT_PAD = 5; // 拖动热区在缝隙两侧各外扩这么多，鼠标不用精确压在 4px 上
const MIN_PANE_WIDTH = 260; // 单栏最小宽度（拖动分隔条时的下限）
const MAX_PANES = 4; // 最多同时显示几栏
const CONFIG_VERSION = 2;

// 客户区小于这个尺寸时认为窗口处于最小化等异常状态，不做布局
const MIN_SANE_WIDTH = 200;
const MIN_SANE_HEIGHT = 150;

const DEFAULT_SERVICES = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', color: '#4d6bfe', icon: 'deepseek' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f', icon: 'chatgpt' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/', color: '#d97757', icon: 'claude' },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', color: '#2f7cf6', icon: 'doubao' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', color: '#1f2329', icon: 'kimi' },
  { id: 'glm', name: '智谱 GLM', url: 'https://chatglm.cn/', color: '#3b5bfd', icon: 'chatglm' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', color: '#4285f4', icon: 'gemini' },
];

// 内置站点列表的版本：数字变了就会在下次启动时把新增的内置站点补给老配置
//   1 -> 最初的 4 个（deepseek / chatgpt / claude / coze）
//   2 -> 扣子换成豆包，新增 Kimi、智谱 GLM、Gemini，并带上内置 logo
const SERVICES_VERSION = 2;

// 预加载时相邻两个服务的间隔，避免启动瞬间一起抢带宽
const PRELOAD_STAGGER = 350;

// ---------------------------------------------------------------------------
// 全局快捷键（老板键）
// ---------------------------------------------------------------------------
//
// 这是系统级注册（Windows 下就是 RegisterHotKey），所以：
//   · 不管当前前台是哪个程序、哪怕在别的程序的全屏窗口里，按键都会被系统交给本应用；
//   · 它比页面里的 before-input-event（应用内快捷键）优先级更高，也不需要窗口有焦点。
// 代价是这个组合键会被本应用独占，注册失败（被别的程序占了）时要明确告诉用户，
// 否则表现就是「按了没反应」，很难查。

const HOTKEY_DEFAULT = 'Alt+Space';
const HOTKEY_ACTIONS = ['toggle', 'show']; // toggle：再按一次收起；show：只唤出

// 修饰键别名 -> Electron 认识的名字（Ctrl / Alt / Shift / Command / Super）
function modifierName(alias) {
  switch (alias) {
    case 'ctrl':
    case 'control':
      return 'Ctrl';
    case 'cmdorctrl':
    case 'commandorcontrol':
      return isMac ? 'Command' : 'Ctrl';
    case 'alt':
    case 'option':
      return 'Alt';
    case 'shift':
      return 'Shift';
    case 'cmd':
    case 'command':
      return 'Command';
    case 'super':
    case 'meta':
    case 'win':
    case 'windows':
      return 'Super';
    default:
      return null;
  }
}

// 主键别名 -> Electron 认识的名字
const HOTKEY_KEYS = new Map([
  ['space', 'Space'], ['spacebar', 'Space'], ['空格', 'Space'],
  ['esc', 'Escape'], ['escape', 'Escape'],
  ['return', 'Enter'], ['enter', 'Enter'],
  ['tab', 'Tab'], ['backspace', 'Backspace'], ['delete', 'Delete'], ['del', 'Delete'],
  ['insert', 'Insert'], ['ins', 'Insert'], ['home', 'Home'], ['end', 'End'],
  ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['pgup', 'PageUp'], ['pgdn', 'PageDown'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['plus', '+'], ['minus', '-'], ['comma', ','], ['period', '.'], ['slash', '/'],
]);

// 允许做全局快捷键的符号键（Electron 的 accelerator 认这些字符）
const HOTKEY_PUNCT = new Set([
  ')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '+', '=', '<', ',',
  '_', '-', '.', '>', '/', '?', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'",
]);

// 这些组合键被系统或常识占着，注册了只会把别人弄坏
const HOTKEY_BLOCKED = new Map([
  ['Alt+F4', 'Alt+F4 是用来关窗口的，全局占用会把所有程序都弄坏'],
  ['Ctrl+Alt+Delete', 'Ctrl+Alt+Delete 是系统保留组合键，寄存器里注册不了'],
]);

const HOTKEY_ORDER = ['Ctrl', 'Command', 'CommandOrControl', 'Alt', 'Shift', 'Super'];

const PALETTE = [
  '#4d6bfe', '#10a37f', '#d97757', '#7c5cff', '#f0a020',
  '#2fb6d9', '#e0526b', '#8fbd3f', '#b06bd9', '#6b7a90',
];

// 允许网页主动申请的权限（语音输入、通知、剪贴板等），其余一律拒绝
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
]);

const isMac = process.platform === 'darwin';

function log(...args) {
  if (!app.isPackaged) console.log('[aihub]', ...args);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 配置持久化（userData/config.json）
// ---------------------------------------------------------------------------

let config = {
  version: CONFIG_VERSION,
  servicesVersion: SERVICES_VERSION,
  services: [],
  activeId: null, // 当前聚焦的那一栏（键盘、工具栏操作的目标）
  panes: [], // 分屏布局里的服务 id，有序，1 ~ MAX_PANES 个
  weights: [], // 与 panes 等长，水平占比，和为 1
  lastUrls: {},
  pendingWipe: [], // 需要在下次启动时删除的分区目录
  preload: true, // 启动时就把所有标签的页面加载好，标题和图标不用点也有
  theme: 'system', // dark / light / system：只看本应用自己的标签栏与设置面板
  hotkey: {
    enabled: true, // 是否注册全局快捷键
    accelerator: HOTKEY_DEFAULT, // 默认 Alt+Space
    action: 'toggle', // toggle：再按一次收起；show：只唤出
    pinTop: true, // 唤出时强制置顶（最高优先级），窗口切到后台时自动取消
    closeToTray: true, // 点关闭按钮收进后台，而不是退出（快捷键/托盘还能唤回）
    tray: true, // 托盘图标：窗口收起后的兜底入口
  },
};

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function normalizeUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

function pickColor(index) {
  return PALETTE[index % PALETTE.length];
}

/**
 * 把用户填的组合键整理成 Electron accelerator 的规范写法。
 * 认不出来返回 null（调用方负责提示），认出来则保证：
 *   · 修饰键按固定顺序排（Ctrl / Command / Alt / Shift / Super），同一个修饰键不重复；
 *   · 除 F1~F24 外必须带至少一个修饰键 —— 单独的字母或空格做全局热键会把整个系统吃掉。
 */
function normalizeAccelerator(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  const mods = [];
  let key = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const mod = modifierName(lower);
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    if (key) return null; // 出现了两个主键
    if (HOTKEY_KEYS.has(lower)) key = HOTKEY_KEYS.get(lower);
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) key = lower.toUpperCase();
    else if (/^key[a-z]$/.test(lower)) key = lower.slice(3).toUpperCase();
    else if (/^[a-z]$/.test(lower)) key = lower.toUpperCase();
    else if (/^[0-9]$/.test(lower)) key = lower;
    else if (HOTKEY_PUNCT.has(part)) key = part;
    else return null;
  }
  if (!key) return null;

  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (!mods.length && !isFunctionKey) return null;
  if (!mods.length && isFunctionKey) return key;

  mods.sort((a, b) => HOTKEY_ORDER.indexOf(a) - HOTKEY_ORDER.indexOf(b));
  const accelerator = mods.concat(key).join('+');
  const blocked = HOTKEY_BLOCKED.get(accelerator);
  return blocked ? null : accelerator;
}

/** 组合键被拒的原因（给用户看的文案，能说清就说清） */
function acceleratorHint(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '请按下一个组合键';
  const canonical = normalizeAccelerator(text);
  if (canonical) return '';
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  const blocked = HOTKEY_BLOCKED.get(parts.map((part) => (
    modifierName(part.toLowerCase()) || part.toUpperCase()
  )).join('+'));
  if (blocked) return blocked;
  if (parts.length === 1) {
    return `至少要带一个修饰键（${isMac ? '⌘ / ⌥ / ⇧' : 'Ctrl / Alt / Shift'}），或者单用一个 F1~F24`;
  }
  return isMac
    ? '这个组合键认不出来，请用「修饰键 + 按键」的写法（例如 Command+Shift+Space、⌘+Shift+K）'
    : '这个组合键认不出来，请用「修饰键 + 按键」的写法（例如 Alt+Space、Ctrl+Shift+K）';
}

/** 配置里的快捷键字段：缺字段、写坏了都退回默认值，不让手改配置把功能弄哑 */
function normalizeHotkeyConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    accelerator: normalizeAccelerator(source.accelerator) || HOTKEY_DEFAULT,
    action: HOTKEY_ACTIONS.includes(source.action) ? source.action : 'toggle',
    pinTop: source.pinTop !== false,
    closeToTray: source.closeToTray !== false,
    tray: source.tray !== false,
  };
}

function newServiceId(name, existing) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const base = /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : `svc-${randomUUID().slice(0, 8)}`;
  let id = base;
  let n = 2;
  while (existing.some((s) => s.id === id)) id = `${base}-${n++}`;
  return id;
}

function loadConfig() {
  const file = configFile();
  let raw = null;
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null; // 首次运行没有配置文件
  }
  if (text != null) {
    try {
      // 记事本等编辑器会写入 BOM，直接 JSON.parse 会失败
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      raw = null;
      // 解析失败时先留一份备份再退回默认值，避免把用户的服务列表悄悄覆盖掉
      try {
        fs.renameSync(file, `${file}.bad`);
        console.error('[aihub] 配置文件无法解析，已备份为 config.json.bad:', err.message);
      } catch {
        // 备份失败就算了，继续用默认配置
      }
    }
  }

  const source = raw && Array.isArray(raw.services) && raw.services.length
    ? raw.services
    : DEFAULT_SERVICES;

  const services = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 40);
    const url = normalizeUrl(item.url);
    if (!name || !url) continue;
    let id = typeof item.id === 'string' && item.id ? item.id : newServiceId(name, services);
    if (services.some((s) => s.id === id)) id = newServiceId(name, services);
    const icon = typeof item.icon === 'string' && /^[\w-]{1,40}$/.test(item.icon) ? item.icon : '';
    services.push({
      id,
      name,
      url,
      color: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : pickColor(services.length),
      custom: Boolean(item.custom),
      icon: icon || iconForService({ id, url, name }),
    });
  }

  if (!services.length) {
    services.push(...DEFAULT_SERVICES.map((s) => ({ ...s, custom: false })));
  }

  // 内置站点列表升级（扣子换豆包、补 Kimi/GLM/Gemini），只动内置服务，不碰用户自己加的
  const migrated = migrateServices(services, raw && raw.servicesVersion);
  const finalServices = migrated.services;
  // 被替换掉的服务 id（例如 coze -> doubao）在配置别处也要跟着改名
  const remapId = (value) => (migrated.remap[value] ? migrated.remap[value] : value);

  const lastUrls = {};
  const rawLastUrls = raw && typeof raw.lastUrls === 'object' && raw.lastUrls ? raw.lastUrls : {};
  for (const svc of finalServices) {
    const remembered = normalizeUrl(rawLastUrls[svc.id]);
    if (remembered) lastUrls[svc.id] = remembered;
  }
  // 注意：被替换掉的服务（coze -> doubao）不继承「上次访问的地址」——
  // 那是另一个站点，继承过来会让新标签一打开就跳到旧站。

  const rawActive = raw && typeof raw.activeId === 'string' ? remapId(raw.activeId) : null;
  const activeId = finalServices.some((s) => s.id === rawActive) ? rawActive : finalServices[0].id;

  // 分屏布局：v1 只有 activeId + splitId（双栏），v2 起是 panes + weights（最多 MAX_PANES 栏）
  let panes = [];
  let weights = [];
  if (raw && Array.isArray(raw.panes) && raw.panes.length) {
    panes = sanitizePanes(raw.panes.map(remapId), finalServices);
    weights = normalizeWeights(raw.weights, panes.length);
  } else {
    panes = [activeId];
    if (raw && typeof raw.splitId === 'string') {
      const second = finalServices.find((s) => s.id === remapId(raw.splitId));
      if (second && second.id !== activeId) panes.push(second.id);
    }
    weights = normalizeWeights(null, panes.length);
  }
  // 聚焦的那一栏必须在布局里
  if (!panes.includes(activeId)) {
    if (panes.length < MAX_PANES) panes.push(activeId);
    else panes[panes.length - 1] = activeId;
    weights = normalizeWeights(null, panes.length);
  }

  // 待清理的分区目录（删除服务时勾了「清除登录数据」），下次启动时真正删掉
  const pendingWipe = [];
  if (raw && Array.isArray(raw.pendingWipe)) {
    for (const id of raw.pendingWipe) {
      if (typeof id === 'string' && id && !pendingWipe.includes(id)) pendingWipe.push(id);
    }
  }
  // 内置服务被替换后，它原来的分区目录也该清掉
  for (const from of migrated.removedIds) {
    if (!pendingWipe.includes(from)) pendingWipe.push(from);
  }

  config = {
    version: CONFIG_VERSION,
    servicesVersion: SERVICES_VERSION,
    services: finalServices,
    activeId,
    panes,
    weights,
    lastUrls,
    pendingWipe,
    preload: raw ? raw.preload !== false : true,
    theme: ['dark', 'light', 'system'].includes(raw && raw.theme) ? raw.theme : 'system',
    hotkey: normalizeHotkeyConfig(raw && raw.hotkey),
  };
  if (migrated.notes.length) migrated.notes.forEach((note) => log('内置站点已更新:', note));
}

/**
 * 把老配置里的内置站点升级到当前的 DEFAULT_SERVICES。
 * 只动「内置且没被用户改过」的服务，用户自己加的一律保持原样。
 * 返回新的服务数组、被替换掉的 id 映射（coze -> doubao）以及给日志用的说明。
 */
function migrateServices(services, fromVersion) {
  const version = Number(fromVersion) || 1;
  const notes = [];
  const remap = {};
  const removedIds = [];
  if (version >= SERVICES_VERSION) return { services, notes, remap, removedIds };

  const builtinIds = new Set(DEFAULT_SERVICES.map((s) => s.id));
  const isBuiltin = (svc) => builtinIds.has(svc.id) && !svc.custom;

  // 1) 内置的「扣子」在新版里由「豆包」取代
  const list = services.filter((svc) => {
    if (svc.id !== 'coze' || svc.custom) return true;
    if (!/(^|\.)coze\.(cn|com)$/i.test(hostOfUrl(svc.url))) return true; // 用户改成别的地址了就留着
    removedIds.push(svc.id);
    remap[svc.id] = 'doubao';
    notes.push('扣子 Coze -> 豆包');
    return false;
  });

  // 2) 补齐新增的内置站点（豆包 / Kimi / 智谱 GLM / Gemini）
  const have = new Set(list.map((s) => s.id));
  const missing = DEFAULT_SERVICES.filter((s) => !have.has(s.id));
  if (missing.length) notes.push('新增内置站点: ' + missing.map((s) => s.name).join('、'));

  // 3) 顺序：内置站点按默认顺序排前面，用户自己加的服务排在后面保持相对顺序
  const byId = new Map();
  for (const svc of list) {
    if (isBuiltin(svc) && builtinIds.has(svc.id)) byId.set(svc.id, svc);
  }
  const builtins = DEFAULT_SERVICES.map((def) => {
    const existing = byId.get(def.id);
    if (!existing) return { ...def, custom: false };
    // 保留用户可能改过的网址/颜色，只补上图标这类新字段
    return { ...existing, icon: existing.icon || def.icon, color: existing.color || def.color };
  });
  const customs = list.filter((svc) => !(isBuiltin(svc) && builtinIds.has(svc.id)));
  const next = [...builtins, ...customs];

  // 4) 老配置里的内置服务如果没带 icon，在这里补上
  for (const svc of next) {
    if (!svc.icon) svc.icon = iconForService(svc);
  }

  return { services: next, notes, remap, removedIds };
}

/** 网址/名字 -> 内置图标 key（拿不准就返回空，渲染层会退回彩色圆点） */
function iconForService(svc) {
  const host = hostOfUrl(svc.url).replace(/^www\./, '');
  if (!host) return '';
  const known = {
    'chat.deepseek.com': 'deepseek', 'deepseek.com': 'deepseek',
    'chatgpt.com': 'chatgpt', 'openai.com': 'openai',
    'claude.ai': 'claude', 'anthropic.com': 'anthropic',
    'doubao.com': 'doubao',
    'kimi.com': 'kimi', 'moonshot.cn': 'kimi',
    'chatglm.cn': 'chatglm', 'z.ai': 'chatglm', 'bigmodel.cn': 'chatglm', 'zhipuai.cn': 'zhipu',
    'gemini.google.com': 'gemini', 'aistudio.google.com': 'google', 'google.com': 'google',
    'grok.com': 'grok', 'x.ai': 'xai',
    'qwen.ai': 'qwen', 'tongyi.aliyun.com': 'qwen', 'aliyun.com': 'alibaba',
    'yuanbao.tencent.com': 'hunyuan', 'tencent.com': 'tencent',
    'yiyan.baidu.com': 'wenxin', 'baidu.com': 'baidu',
    'minimax.io': 'minimax', 'hailuoai.com': 'minimax',
    'siliconflow.cn': 'siliconflow', 'modelscope.cn': 'modelscope',
    'mistral.ai': 'mistral', 'perplexity.ai': 'perplexity', 'openrouter.ai': 'openrouter',
    'github.com': 'github', 'huggingface.co': 'huggingface', 'ollama.com': 'ollama',
  };
  if (known[host]) return known[host];
  // 退一步：域名里带厂商名字就认（chat.moonshot.cn、api.deepseek.com 这类）
  const flat = host.replace(/[^a-z0-9]/g, '');
  for (const key of ['deepseek', 'chatgpt', 'claude', 'doubao', 'kimi', 'chatglm', 'zhipu', 'gemini', 'grok', 'qwen', 'minimax', 'hunyuan', 'wenxin', 'siliconflow', 'modelscope', 'openrouter', 'perplexity', 'mistral', 'ollama', 'copilot']) {
    if (flat.includes(key)) return key;
  }
  return '';
}

function hostOfUrl(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 去掉不存在的服务 id、去重；cap 用于限制栏数（Infinity = 不限制，交给调用方判断） */
function sanitizePanes(ids, services, cap = MAX_PANES) {
  const list = services || config.services;
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string') continue;
    if (!list.some((s) => s.id === id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** 补齐长度、剔除非法值、归一化到和为 1；无有效值时均分 */
function normalizeWeights(weights, count) {
  const n = Math.max(1, count | 0);
  let list = Array.isArray(weights) ? weights.slice(0, n).map(Number) : [];
  while (list.length < n) list.push(0);
  list = list.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = list.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return new Array(n).fill(1 / n);
  return list.map((w) => w / sum);
}

let saveTimer = null;

function saveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushConfig, 400);
}

/** 取消还没落盘的延迟写入（自检结束要还原配置时用得上） */
function cancelPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/**
 * 把 config 换成另一份（原地替换键，保持各处的引用有效）并立刻落盘。
 * 自检会大改配置（加服务、改分栏、换主题……），跑完必须原样还回去，
 * 否则用户下一次打开应用看到的是自检留下的布局。
 */
function replaceConfig(next) {
  cancelPendingSave();
  for (const key of Object.keys(config)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) delete config[key];
  }
  Object.assign(config, JSON.parse(JSON.stringify(next)));
  flushConfig();
  return true;
}

function flushConfig() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const file = configFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[aihub] 写入配置失败:', err.message);
  }
}

function getService(id) {
  return config.services.find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// 分屏几何：weights -> 每一栏的 x / width，以及它们之间分隔条的位置
// ---------------------------------------------------------------------------

/** 可用宽度 = 总宽 - 所有缝隙 */
function usableWidth(width, count) {
  return Math.max(0, width - Math.max(0, count - 1) * SPLIT_GAP);
}

function computeGeometry(width) {
  const panes = config.panes.filter((id) => getService(id));
  const n = Math.max(1, panes.length);
  const usable = usableWidth(width, n);
  const list = [];
  let x = 0;
  let used = 0;
  panes.forEach((id, index) => {
    const last = index === n - 1;
    // 最后一栏直接吃掉舍入误差，保证右边缘严格贴合窗口
    const w = last ? Math.max(0, usable - used) : Math.max(0, Math.round(usable * (config.weights[index] || 0)));
    list.push({ id, index, x, width: w });
    x += w + SPLIT_GAP;
    used += w;
  });
  const dividers = list.slice(0, -1).map((pane, index) => ({
    index,
    x: pane.x + pane.width, // 缝隙左边缘
    width: SPLIT_GAP,       // 缝隙宽度（服务视图之间的真实空隙）
    // 拖动热区：元素比缝隙宽，居中压在缝隙上，视觉线仍是中间那条细线
    hitX: pane.x + pane.width - DIVIDER_HIT_PAD,
    hitWidth: SPLIT_GAP + DIVIDER_HIT_PAD * 2,
  }));
  return { panes: list, dividers, usable };
}

/**
 * 拖动第 index 条分隔条到客户区坐标 x。
 * 只调整相邻两栏的占比，两者之和不变；两侧都不小于 MIN_PANE_WIDTH。
 */
function dragDivider(index, clientX) {
  const n = config.panes.length;
  if (!mainWindow || mainWindow.isDestroyed() || n < 2) return false;
  const i = Math.max(0, Math.min(n - 2, index | 0));
  const [width] = mainWindow.getContentSize();
  const usable = usableWidth(width, n);
  if (!(usable > 0)) return false;

  const weights = config.weights.slice();
  const before = weights.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = weights[i] + weights[i + 1];
  // 这一对栏的左边界（含前面所有栏与缝隙）
  const pairLeft = usable * before + i * SPLIT_GAP;
  const minRatio = Math.min(pair / 2, MIN_PANE_WIDTH / usable);

  let leftRatio = (Number(clientX) - pairLeft) / usable;
  if (!Number.isFinite(leftRatio)) return false;
  leftRatio = Math.min(pair - minRatio, Math.max(minRatio, leftRatio));

  weights[i] = leftRatio;
  weights[i + 1] = pair - leftRatio;
  config.weights = weights;
  layout();
  return true;
}

/** 相邻两栏回到等分（双击分隔条） */
function equalizeDivider(index) {
  const n = config.panes.length;
  if (n < 2) return false;
  const i = Math.max(0, Math.min(n - 2, index | 0));
  const weights = config.weights.slice();
  const pair = weights[i] + weights[i + 1];
  weights[i] = pair / 2;
  weights[i + 1] = pair / 2;
  config.weights = weights;
  saveConfig();
  layout();
  broadcast();
  return true;
}

function equalizeAll() {
  config.weights = normalizeWeights(null, config.panes.length);
  saveConfig();
  layout();
  broadcast();
}

/** 焦点栏：只切换键盘/工具栏的目标，不动布局 */
function focusPane(id) {
  if (!config.panes.includes(id) || config.activeId === id) return;
  config.activeId = id;
  saveConfig();
  broadcast();
}

/**
 * 设置分屏布局。
 * 新增的栏分到 1/n 的宽度，原有栏按比例让出空间（保留用户拖过的比例）；
 * 删除栏时剩余栏按比例放大，同样保留比例。
 */
function setPanes(ids) {
  // 这里不截断：栏数超限要明确拒绝，不能悄悄少给几栏
  const next = sanitizePanes(ids, config.services, Infinity);
  if (!next.length) return { ok: false, error: '至少要保留一栏' };
  if (next.length > MAX_PANES) return { ok: false, error: `最多同时显示 ${MAX_PANES} 栏` };

  if (mainWindow && !mainWindow.isDestroyed()) {
    const [width] = mainWindow.getContentSize();
    const usable = usableWidth(width, next.length);
    if (usable / next.length < MIN_PANE_WIDTH && next.length > config.panes.length) {
      return { ok: false, error: '窗口太窄了，先拉宽窗口或减少几栏' };
    }
  }

  const prevIds = config.panes.slice();
  const prevWeights = config.weights.slice();
  const share = 1 / next.length;
  const newcomers = next.filter((id) => !prevIds.includes(id)).length;
  const keptSum = next
    .filter((id) => prevIds.includes(id))
    .reduce((sum, id) => sum + (prevWeights[prevIds.indexOf(id)] || 0), 0);
  const keptBudget = Math.max(0, 1 - newcomers * share);
  const scale = keptSum > 0 ? keptBudget / keptSum : 0;

  const raw = next.map((id) => {
    const prev = prevIds.indexOf(id);
    if (prev === -1) return share;
    return (prevWeights[prev] || 0) * (newcomers ? scale : 1);
  });

  config.panes = next;
  config.weights = normalizeWeights(raw, next.length);
  if (!next.includes(config.activeId)) config.activeId = next[0];
  next.forEach((id) => ensureView(getService(id)));
  saveConfig();
  layout();
  broadcast();
  return { ok: true, state: publicState() };
}

/** 把某个服务加入 / 移出分屏布局（分屏菜单勾选时走这里） */
function togglePaneInLayout(id) {
  const svc = getService(id);
  if (!svc) return { ok: false, error: '服务不存在' };
  const next = config.panes.includes(id)
    ? config.panes.filter((paneId) => paneId !== id)
    : config.panes.concat(id);
  return setPanes(next);
}

// ---------------------------------------------------------------------------
// 运行时状态// ---------------------------------------------------------------------------

let mainWindow = null;
const views = new Map(); // id -> WebContentsView
const attached = new Set(); // 当前已挂到窗口上的 view id
const popups = new Set(); // 第三方登录弹窗
const hardenedSessions = new Set(); // 已配置过策略的 partition
let overlayOpen = false; // 设置面板打开时，隐藏所有视图让位给窗口自身页面
let dragging = false; // 正在拖动分隔条（此时只走轻量的 layout 通道，不广播完整状态）
let quitting = false;

function publicState() {
  return {
    services: config.services.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      color: s.color,
      icon: s.icon || '',
      custom: Boolean(s.custom),
    })),
    activeId: config.activeId,
    panes: config.panes.slice(),
    weights: config.weights.slice(),
    maxPanes: MAX_PANES,
    minPaneWidth: MIN_PANE_WIDTH,
    preload: Boolean(config.preload),
    theme: config.theme,
    hotkey: {
      enabled: Boolean(config.hotkey.enabled),
      accelerator: config.hotkey.accelerator,
      action: config.hotkey.action,
      pinTop: Boolean(config.hotkey.pinTop),
      closeToTray: Boolean(config.hotkey.closeToTray),
      tray: Boolean(config.hotkey.tray),
      registered: Boolean(hotkeyState.registered),
      error: hotkeyState.error || '',
      defaultAccelerator: HOTKEY_DEFAULT,
    },
    version: app.getVersion(),
    userData: app.getPath('userData'),
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', publicState());
  }
}

/**
 * 只广播几何（分隔条位置）。拖动过程中每帧都会走这里，
 * 所以刻意和 state:changed 分开：页面收到后只挪动分隔条，不重建标签栏。
 */
let lastGeometry = { panes: [], dividers: [], usable: 0 };

function sendLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('layout:changed', {
    panes: lastGeometry.panes,
    dividers: lastGeometry.dividers,
    gap: SPLIT_GAP,
    minPaneWidth: MIN_PANE_WIDTH,
    top: TAB_BAR_HEIGHT,
    overlay: overlayOpen,
  });
}

function sendTabStatus(id, patch) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tab:status', { id, ...patch });
  }
}

// ---------------------------------------------------------------------------
// session 加固：UA 伪装、权限白名单
// ---------------------------------------------------------------------------

function appUaNames() {
  const names = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    names.add(value);
    names.add(value.replace(/\s+/g, '')); // Chromium 会去掉产品名里的空格
    names.add(value.replace(/\s+/g, '-'));
    names.add(value.replace(/\s+/g, '_'));
  };
  add(app.getName());
  try {
    const pkg = require('./package.json');
    add(pkg.name);
    add(pkg.productName);
  } catch {
    /* package.json 一定存在，读不到就算了 */
  }
  return Array.from(names);
}

function stripElectronUA(userAgent) {
  let out = String(userAgent || '').replace(/\s*Electron\/[\d.]+/i, '');
  for (const name of appUaNames()) {
    out = out.replace(new RegExp(`\\s*${escapeRegExp(name)}\\/[\\d.]+`, 'gi'), '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

function hardenSession(partition) {
  const ses = session.fromPartition(partition);
  if (hardenedSessions.has(partition)) return ses;
  hardenedSessions.add(partition);

  // 部分站点会拒绝在 “Electron/xxx” UA 下工作，去掉非标准标记后按普通 Chrome 处理
  ses.setUserAgent(stripElectronUA(ses.getUserAgent()));

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  try {
    const available = ses.availableSpellCheckerLanguages || [];
    const wanted = ['zh-CN', 'en-US', 'en-GB'].filter((lang) => available.includes(lang));
    if (wanted.length) ses.setSpellCheckerLanguages(wanted);
  } catch (err) {
    log('设置拼写检查语言失败（可忽略）:', err.message);
  }
  return ses;
}

function partitionOf(id) {
  return `persist:${id}`;
}

/** 分区在磁盘上的目录：userData/Partitions/<id> */
function partitionDir(id) {
  return path.join(app.getPath('userData'), 'Partitions', id);
}

/**
 * 删除分区目录：clearStorageData 只清内容，目录和缓存会留下（每个约 4MB）。
 * 应用运行期间 Chromium 一直占着这些文件的句柄（实测 EPERM 删不掉），
 * 所以删除动作要等到下次启动、任何 session 打开它之前再做，
 * 由 config.pendingWipe 记录待删列表。
 */
function removePartitionDirNow(id) {
  const dir = partitionDir(id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    return fs.existsSync(dir) ? false : true;
  }
}

function flushPendingWipes() {
  const list = Array.isArray(config.pendingWipe) ? config.pendingWipe.slice() : [];
  if (!list.length) return;
  const remaining = [];
  for (const id of list) {
    // 服务还在（比如用户又加回来了）就别删
    if (config.services.some((s) => s.id === id)) continue;
    if (removePartitionDirNow(id)) log('已清理分区目录:', id);
    else remaining.push(id);
  }
  if (remaining.length !== list.length) {
    config.pendingWipe = remaining;
    saveConfig();
  }
}

// ---------------------------------------------------------------------------
// 视图创建与事件接线
// ---------------------------------------------------------------------------

function rememberUrl(id, url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  if (config.lastUrls[id] === normalized) return;
  config.lastUrls[id] = normalized;
  saveConfig();
}

function openExternal(url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(String(url || ''))) return;
  shell.openExternal(url).catch((err) => log('openExternal 失败:', err.message));
}

function handleWindowOpen(svc, url) {
  if (!/^https?:/i.test(String(url || ''))) {
    // mailto: / weixin: / alipays: 之类交给系统处理
    openExternal(url);
    return { action: 'deny' };
  }
  // 第三方登录、扫码登录等弹窗：放行，但强制共用同一个 partition，
  // 这样登录态会写回同一个标签；同时保留 window.opener，OAuth 回调才能通信。
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 520,
      height: 720,
      minWidth: 380,
      minHeight: 480,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      title: `${svc.name} 登录`,
      webPreferences: {
        partition: partitionOf(svc.id),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  };
}

function showErrorPage(svc, code, desc, url) {
  const view = views.get(svc.id);
  if (!view || view.webContents.isDestroyed()) return;
  const query = new URLSearchParams({
    name: svc.name,
    url: url || svc.url,
    code: String(code),
    desc: String(desc || ''),
  }).toString();
  const file = pathToFileURL(path.join(__dirname, 'error.html')).href;
  view.webContents.loadURL(`${file}?${query}`).catch(() => {});
}

function wireServiceContents(svc, view) {
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => handleWindowOpen(svc, url));

  // 右键：给原生菜单（复制 / 粘贴 / 打开链接 / 检查元素…），否则右键像坏了一样
  wc.on('context-menu', (_event, params) => {
    try {
      popupViewContextMenu(wc, params);
    } catch (err) {
      log('右键菜单失败:', err.message);
    }
  });

  wc.on('did-create-window', (win) => {
    popups.add(win);
    win.on('closed', () => popups.delete(win));
    const popupWc = win.webContents;
    if (popupWc) {
      popupWc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(String(url || ''))) return { action: 'allow' };
        openExternal(url);
        return { action: 'deny' };
      });
    }
  });

  wc.on('page-title-updated', (_event, title) => sendTabStatus(svc.id, { title }));
  wc.on('page-favicon-updated', (_event, icons) => {
    if (Array.isArray(icons) && icons.length) {
      sendTabStatus(svc.id, { favicon: icons[icons.length - 1] });
    }
  });
  wc.on('did-start-loading', () => sendTabStatus(svc.id, { loading: true, error: null }));
  wc.on('did-stop-loading', () => sendTabStatus(svc.id, { loading: false }));
  wc.on('did-navigate', (_event, url) => {
    rememberUrl(svc.id, url);
    sendTabStatus(svc.id, { url });
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    rememberUrl(svc.id, url);
    sendTabStatus(svc.id, { url });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED（用户主动打断）
    log('加载失败:', svc.id, errorCode, errorDescription, validatedURL);
    sendTabStatus(svc.id, {
      loading: false,
      url: validatedURL,
      error: { code: errorCode, desc: errorDescription },
    });
    showErrorPage(svc, errorCode, errorDescription, validatedURL || config.lastUrls[svc.id] || svc.url);
  });
  wc.on('render-process-gone', (_event, details) => {
    log('渲染进程退出:', svc.id, details.reason);
    sendTabStatus(svc.id, {
      loading: false,
      error: { code: 0, desc: `页面进程已退出（${details.reason}）` },
    });
    showErrorPage(svc, 0, `页面进程已退出（${details.reason}）`, wc.getURL() || svc.url);
  });
  wc.on('unresponsive', () => sendTabStatus(svc.id, { loading: false, unresponsive: true }));
  wc.on('responsive', () => sendTabStatus(svc.id, { unresponsive: false }));

  // 点进某一栏的页面里时，把焦点切到那一栏（标签栏高亮、快捷键目标都跟着走）
  wc.on('focus', () => focusPane(svc.id));
}

function ensureView(svc) {
  const existing = views.get(svc.id);
  if (existing && !existing.webContents.isDestroyed()) return existing;

  hardenSession(partitionOf(svc.id));

  const view = new WebContentsView({
    webPreferences: {
      partition: partitionOf(svc.id),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // 深色底色，避免远程页面首帧前的白闪（浅色主题下用白底）
  try {
    if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor(viewBackground());
  } catch (err) {
    log('setBackgroundColor 失败（可忽略）:', err.message);
  }

  wireServiceContents(svc, view);
  views.set(svc.id, view);

  const startUrl = config.lastUrls[svc.id] || svc.url;
  log('创建视图:', svc.id, '->', startUrl);
  view.webContents.loadURL(startUrl).catch(() => {
    // 失败细节由 did-fail-load 统一处理
  });

  return view;
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  if (mainWindow && !mainWindow.isDestroyed() && attached.has(id)) {
    try {
      mainWindow.contentView.removeChildView(view);
    } catch (err) {
      log('removeChildView 失败:', err.message);
    }
  }
  attached.delete(id);
  views.delete(id);
  try {
    view.webContents.close();
  } catch {
    try {
      view.webContents.destroy();
    } catch (err) {
      log('销毁视图失败:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 预加载：启动后按顺序把每个标签的页面都加载好
// 这样标题和 favicon 不用点开也能出现在标签栏上（视图不挂到窗口上，不额外占显存）
// ---------------------------------------------------------------------------

let preloadTimer = null;

function stopPreload() {
  if (preloadTimer) {
    clearTimeout(preloadTimer);
    preloadTimer = null;
  }
}

function preloadAll({ force = false } = {}) {
  stopPreload();
  if (!config.preload && !force) return;
  const ids = config.services.map((s) => s.id);
  let index = 0;

  const step = () => {
    preloadTimer = null;
    if (!config.preload && !force) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    while (index < ids.length) {
      const id = ids[index++];
      const svc = getService(id);
      if (!svc) continue;
      if (views.has(id)) continue; // 已经建过的跳过
      ensureView(svc);
      log('预加载标签:', id);
      preloadTimer = setTimeout(step, PRELOAD_STAGGER);
      return;
    }
    // 全部建完后再等一会儿广播一次，确保标题/图标都推到了页面
    preloadTimer = setTimeout(() => {
      preloadTimer = null;
      broadcast();
    }, 1200);
  };

  step();
}

function setPreload(on) {
  const next = Boolean(on);
  if (config.preload === next) return { ok: true, preload: next };
  config.preload = next;
  saveConfig();
  if (next) preloadAll();
  else stopPreload();
  broadcast();
  return { ok: true, preload: next };
}

// ---------------------------------------------------------------------------
// 分屏菜单
//
// 这里用 Windows 原生菜单（Menu.popup），而不是在窗口页面里画一个 div。
// 原因：服务页面是独立的原生视图，永远画在窗口页面之上；页面里画的下拉菜单
// 会被整块挡住。之前的补丁是「打开菜单时把视图整体往下推」，看着像页面被挤了一下，
// 很难看。原生菜单是独立的弹出窗口，浮在所有视图之上，布局完全不用动。
//
// 菜单条目也用 logo（原生菜单只认位图，所以走 tools/build-menu-icons.js
// 生成的 icons/menu/<tone>/*.png），不再用服务色圆点。
// ---------------------------------------------------------------------------

let iconTableCache = null;
let menuPopups = 0; // 自检用：弹过几次分屏菜单

/** 读 icons.js 生成的图标表（和渲染层用的是同一份数据） */
function iconTable() {
  if (iconTableCache) return iconTableCache;
  iconTableCache = { files: {}, variants: {}, hosts: {}, aliases: {} };
  try {
    const code = fs.readFileSync(path.join(__dirname, 'icons.js'), 'utf8');
    const fake = {};
    new Function('window', code)(fake);
    if (fake.AIHUB_ICONS) iconTableCache = fake.AIHUB_ICONS;
  } catch (err) {
    log('读取图标表失败（菜单图标会退化成纯文字）:', err.message);
  }
  return iconTableCache;
}

/** 服务 -> 内置图标 key；规则与 index.html 里的 builtinIconKey 保持一致 */
function iconKeyForServiceOf(svc) {
  const table = iconTable();
  const files = table.files || {};
  const aliases = table.aliases || {};
  const hosts = table.hosts || {};
  const pick = (key) => {
    if (!key) return '';
    if (files[key]) return key;
    const alias = aliases[key];
    if (alias && files[alias]) return alias;
    return '';
  };
  let hit = pick(svc.icon);
  if (!hit) {
    const raw = String(svc.icon || '').trim().toLowerCase();
    if (raw) hit = pick(raw);
  }
  if (!hit) {
    const host = hostOfUrl(svc.url).replace(/^www\./, '');
    if (host) {
      hit = pick(hosts[host]);
      if (!hit) {
        const parts = host.split('.');
        for (let i = 1; i < parts.length && !hit; i += 1) hit = pick(hosts[parts.slice(i).join('.')]);
      }
      if (!hit) {
        const flat = host.replace(/[^a-z0-9]/g, '');
        for (const key of Object.keys(files)) {
          if (key.length >= 4 && flat.includes(key)) { hit = key; break; }
        }
      }
    }
  }
  if (!hit) {
    const name = String(svc.name || '').trim().toLowerCase();
    if (name) hit = pick(name);
  }
  return hit;
}

/** 服务 -> 原生菜单用的图标（32×32 PNG，按当前明暗取对应一套） */
function menuIconFor(svc) {
  const key = iconKeyForServiceOf(svc);
  if (!key) return null;
  const tone = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const file = path.join(__dirname, 'icons', 'menu', tone, `${key}.png`);
  if (!fs.existsSync(file)) return null;
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? null : image;
}

/** 分屏菜单的内容（抽成纯函数，方便自检直接断言它的结构） */
function buildSplitMenuTemplate() {
  const panes = config.panes.filter((id) => getService(id));
  const template = [
    { label: `分屏：已选 ${panes.length} / ${MAX_PANES} 栏（勾选即加入）`, enabled: false },
    { type: 'separator' },
  ];

  for (const svc of config.services) {
    const index = panes.indexOf(svc.id);
    const inLayout = index >= 0;
    // Windows 的勾选标记和自定义图标抢同一个位置，所以把「第几栏」直接写进文字里，
    // 和标签栏上的序号角标对得上，也不依赖勾是否画得出来。
    const item = {
      label: inLayout ? `${svc.name}　第 ${index + 1} 栏` : svc.name,
      type: 'checkbox',
      checked: inLayout,
      // 已经在里面的可以随时退出；不在里面的，栏数满了就不让加
      enabled: inLayout || panes.length < MAX_PANES,
      click: () => togglePaneInLayout(svc.id),
    };
    const icon = menuIconFor(svc);
    if (icon) item.icon = icon;
    template.push(item);
  }

  template.push({ type: 'separator' });
  template.push({
    label: '均分所有栏宽度',
    enabled: panes.length >= 2,
    click: () => equalizeAll(),
  });
  template.push({
    label: '只显示当前标签',
    enabled: panes.length >= 2,
    click: () => showSinglePane(null),
  });
  template.push({ type: 'separator' });
  template.push({ label: '拖动分隔条调宽度，双击分隔条均分', enabled: false });
  return template;
}

/** 点击 ⇔ 时弹出菜单；point 是窗口页面里按钮的位置（相对窗口左上角，DIP） */
function popupSplitMenu(point) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '窗口没了' };
  const x = Math.max(0, Math.round(Number(point && point.x) || 0));
  const y = Math.max(0, Math.round(Number(point && point.y) || 0));
  const menu = Menu.buildFromTemplate(buildSplitMenuTemplate());
  menuPopups += 1;
  menu.popup({ window: mainWindow, x, y });
  return { ok: true, items: menu.items.length, panes: config.panes.length };
}

/** 标签栏/空白处的右键菜单（标签本身的右键仍然是「加入 / 移出分屏」） */
function buildShellMenuTemplate() {
  const svc = getService(config.activeId);
  return [
    { label: svc ? `刷新「${svc.name}」` : '刷新当前标签', enabled: Boolean(svc), click: () => reloadTab(null) },
    { label: '强制刷新（忽略缓存）', enabled: Boolean(svc), click: () => reloadTab(null, { ignoreCache: true }) },
    { label: '回到首页', enabled: Boolean(svc), click: () => goHome(null) },
    { type: 'separator' },
    { label: '启动时预加载所有标签', type: 'checkbox', checked: Boolean(config.preload), click: () => setPreload(!config.preload) },
    {
      label: `外观主题：${THEME_LABELS[config.theme] || config.theme}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '隐藏到后台（快捷键随时唤回）', click: () => { hideToBackground(); hintHiddenToTray(); } },
    {
      label: `唤出快捷键：${config.hotkey.accelerator} · ${hotkeyStatusText()}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '设置 · 服务管理', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ui:open-settings'); } },
    { label: '开发者工具', click: () => toggleDevTools(null) },
  ];
}

function popupShellMenu(point) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '窗口没了' };
  const x = Math.max(0, Math.round(Number(point && point.x) || 0));
  const y = Math.max(0, Math.round(Number(point && point.y) || 0));
  Menu.buildFromTemplate(buildShellMenuTemplate()).popup({ window: mainWindow, x, y });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 外观主题
// ---------------------------------------------------------------------------

const THEMES = ['dark', 'light', 'system'];
const THEME_LABELS = { dark: '深色', light: '浅色', system: '跟随系统' };

/** 服务页面的底色：跟着主题走，避免首帧出现大面积白闪或黑闪 */
function viewBackground() {
  return nativeTheme.shouldUseDarkColors ? '#12141a' : '#ffffff';
}

function applyTheme() {
  nativeTheme.themeSource = THEMES.includes(config.theme) ? config.theme : 'system';
  const color = viewBackground();
  for (const view of views.values()) {
    try {
      if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor(color);
    } catch {
      /* 个别版本没有这个方法，忽略 */
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setBackgroundColor(color);
    } catch {
      /* 同上 */
    }
  }
}

function setTheme(value) {
  if (!THEMES.includes(value)) return { ok: false, error: '不支持的主题' };
  config.theme = value;
  applyTheme();
  saveConfig();
  broadcast();
  return { ok: true, theme: value };
}

// ---------------------------------------------------------------------------
// 全局快捷键唤出（老板键）+ 托盘
//
// 交互按「唤出 / 收起」一组来做：
//   按下快捷键（系统级，任何程序在前面都有效）
//     · 窗口不在前面  -> 恢复 + 显示 + 抢到最前（可选强制置顶，压过全屏程序和朋友窗口）
//     · 窗口已经在前面 -> 收进后台（再按一次回来），像开关一样
//   收起之后靠什么回来：快捷键本身 + 托盘图标（双保险，藏起来了也不会「叫不回来」）
// ---------------------------------------------------------------------------

let registeredAccelerator = null; // 真的注册进系统里的那个组合键
let hotkeyState = { registered: false, error: '' };
let pinnedByHotkey = false; // 「最高优先级置顶」是不是这一轮唤出加上去的
let hotkeyPressedAt = 0; // 按住不放时 Windows 会连发，这里去抖
let tray = null;
let trayHintShown = false;

function unregisterHotkey() {
  if (!registeredAccelerator) return;
  try {
    globalShortcut.unregister(registeredAccelerator);
  } catch (err) {
    log('注销快捷键失败:', err.message);
  }
  registeredAccelerator = null;
}

/**
 * 注册全局快捷键。注册不上要留下明确的原因（否则用户只看到「按了没反应」）：
 * 绝大多数情况是这个组合键已经被别的程序占了（PowerToys Run 默认就是 Alt+Space）。
 */
function registerHotkey() {
  unregisterHotkey();
  hotkeyState = { registered: false, error: '' };
  const accelerator = config.hotkey.accelerator;
  if (!config.hotkey.enabled) return hotkeyState;

  try {
    const ok = globalShortcut.isRegistered(accelerator)
      || globalShortcut.register(accelerator, onGlobalHotkey);
    if (!ok || !globalShortcut.isRegistered(accelerator)) {
      hotkeyState.error = '这个组合键已被其它程序占用（例如 PowerToys Run、输入法、截图工具），换一个试试';
      console.error('[aihub] 全局快捷键注册失败:', accelerator);
      return hotkeyState;
    }
  } catch (err) {
    hotkeyState.error = `注册失败：${err.message}`;
    console.error('[aihub] 全局快捷键注册异常:', accelerator, err.message);
    return hotkeyState;
  }

  registeredAccelerator = accelerator;
  hotkeyState.registered = true;
  log('全局快捷键已注册:', accelerator);
  return hotkeyState;
}

/** 系统级按下的那一下（globalShortcut 的回调 + 自检里直接调用它） */
function onGlobalHotkey() {
  const now = Date.now();
  if (now - hotkeyPressedAt < 220) return; // 长按产生的连发，忽略后面的
  hotkeyPressedAt = now;
  if (config.hotkey.action === 'toggle' && isWindowForeground()) {
    hideToBackground();
    return;
  }
  summonWindow();
}

/** 窗口是不是已经「在前面」了（可见、没最小化、并且是当前前台窗口） */
function isWindowForeground() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  return win.isVisible() && !win.isMinimized() && win.isFocused();
}

/**
 * 最高优先级置顶：level 用 screen-saver，比普通置顶窗口更高，
 * 连别的程序的全屏（游戏、浏览器 F11、播放器）也压得住。
 */
function pinWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  // 刚唤出就是要置顶，之前那次失焦排队的「取消置顶」作废
  if (pinReleaseTimer) {
    clearTimeout(pinReleaseTimer);
    pinReleaseTimer = null;
  }
  try {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    pinnedByHotkey = true;
  } catch (err) {
    log('置顶失败（可忽略）:', err.message);
  }
}

/** 取消置顶。窗口切到后台时自动放开，不然会一直压着别人的窗口 */
function releasePin(options) {
  const force = Boolean(options && options.force);
  if (!pinnedByHotkey && !force) return;
  pinnedByHotkey = false;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(false);
  } catch (err) {
    log('取消置顶失败（可忽略）:', err.message);
  }
}

let pinReleaseTimer = null;

/**
 * 窗口「刚失焦」时的处理：延迟 250ms 再放开置顶。
 *
 * 直接放开会有个很烦人的边缘情况：系统通知、输入法候选框、或者别的程序瞬间抢一下前台，
 * 都会触发 blur，于是置顶被撤掉——用户明明还在用这个窗口，它却不再压着别的窗口了。
 * 所以这里给一小段缓冲：这段时间内窗口重新拿到焦点就什么都不做。
 */
function scheduleReleasePin(options) {
  const force = Boolean(options && options.force);
  if (force) {
    if (pinReleaseTimer) {
      clearTimeout(pinReleaseTimer);
      pinReleaseTimer = null;
    }
    releasePin({ force: true });
    return;
  }
  if (pinReleaseTimer) clearTimeout(pinReleaseTimer);
  pinReleaseTimer = setTimeout(() => {
    pinReleaseTimer = null;
    const win = mainWindow;
    if (win && !win.isDestroyed() && win.isFocused()) return; // 又回来了，保持置顶
    releasePin();
  }, 250);
}

/** 把窗口拉到最前面并聚焦（窗口被销毁过就重新建一个） */
function summonWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return false;
  }
  const win = mainWindow;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (config.hotkey.pinTop) pinWindow();
  else releasePin({ force: true });

  try {
    win.moveTop();
  } catch (err) {
    log('moveTop 失败（可忽略）:', err.message);
  }
  win.focus();

  // 从别的程序（尤其是全屏）手里抢前台时，Windows 会忽略第一次 focus，补一次
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized() || mainWindow.isFocused()) return;
    try {
      mainWindow.moveTop();
    } catch { /* 忽略 */ }
    mainWindow.focus();
  }, 160);

  // 焦点还给当前标签的页面；设置面板开着时不抢，否则面板里的输入框没法打字
  if (!overlayOpen) {
    const view = activeView();
    if (view && !view.webContents.isDestroyed()) view.webContents.focus();
  }
  refreshTrayMenu();
  return true;
}

/**
 * 收起窗口到后台。
 * 安全阀：快捷键没注册上、也没有托盘时不做真正的隐藏 —— 那样窗口就再也叫不回来了，
 * 这种情况下退化成最小化，任务栏上还留着一个入口。
 */
function hideToBackground() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false, mode: 'none' };
  if (!hotkeyState.registered && !tray) {
    if (!win.isMinimized()) win.minimize();
    refreshTrayMenu();
    return { ok: true, mode: 'minimize' };
  }
  releasePin({ force: true });
  win.hide();
  refreshTrayMenu();
  return { ok: true, mode: 'hide' };
}

// ---------------------------------------------------------------------------
// 托盘：窗口收进后台之后仍然有一个能点回来的入口
// ---------------------------------------------------------------------------

/**
 * 托盘图标：优先用小尺寸专用图（build/tray.png）。
 *
 * 专门做一张而不是把 1024 的图标硬缩到 16px，是为了让菜单栏 / 托盘里的边缘别发灰；
 * 命名带上 @2x 的同名文件（tray@2x.png），macOS 上 Electron 会自己挑 Retina 那版。
 */
function trayImage() {
  const trayFile = path.join(__dirname, 'build', 'tray.png');
  if (fs.existsSync(trayFile)) {
    const image = nativeImage.createFromPath(trayFile);
    if (!image.isEmpty()) return image;
  }
  const candidates = [
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) continue;
    const resized = image.resize({ width: 16, height: 16, quality: 'best' });
    if (!resized.isEmpty()) return resized;
  }
  return null;
}

function hotkeyStatusText() {
  if (!config.hotkey.enabled) return '未启用';
  if (hotkeyState.registered) return '已注册';
  return `注册失败（${hotkeyState.error || '被其它程序占用'}）`;
}

/** 托盘菜单的内容（抽成纯函数，方便自检直接断言结构） */
function buildTrayMenuTemplate() {
  const accelerator = config.hotkey.accelerator;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const visible = Boolean(win && win.isVisible() && !win.isMinimized());
  return [
    {
      label: visible ? '显示主窗口（已经在前面）' : `显示主窗口（${accelerator}）`,
      enabled: !visible,
      click: () => summonWindow(),
    },
    { label: '隐藏到后台', enabled: visible, click: () => hideToBackground() },
    { type: 'separator' },
    { label: `全局快捷键：${accelerator} · ${hotkeyStatusText()}`, enabled: false },
    { label: '设置…', click: () => openSettingsPanel() },
    { type: 'separator' },
    { label: '退出 Aihub', click: () => quitApp() },
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
  } catch (err) {
    log('更新托盘菜单失败:', err.message);
  }
}

function createTray() {
  if (tray) return tray;
  if (!config.hotkey.tray) return null;
  const image = trayImage();
  if (!image) {
    log('没有可用的托盘图标，跳过托盘');
    return null;
  }
  try {
    tray = new Tray(image);
  } catch (err) {
    log('创建托盘失败（可忽略）:', err.message);
    tray = null;
    return null;
  }
  applyTrayTooltip();
  tray.on('click', () => summonWindow());
  tray.on('double-click', () => summonWindow());
  refreshTrayMenu();
  return tray;
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (err) {
    log('销毁托盘失败（可忽略）:', err.message);
  }
  tray = null;
}

function applyTrayTooltip() {
  if (!tray) return;
  try {
    tray.setToolTip(`Aihub · ${config.hotkey.accelerator} 唤出`);
  } catch (err) {
    log('设置托盘提示失败（可忽略）:', err.message);
  }
}

/** 第一次收进后台时冒个气泡：不然用户会以为应用已经退出了 */
function hintHiddenToTray() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: 'Aihub 还在后台运行',
      content: `按 ${config.hotkey.accelerator} 随时唤出，右键托盘图标可以退出。`,
    });
  } catch (err) {
    log('托盘提示失败（可忽略）:', err.message);
  }
}

function quitApp() {
  quitting = true;
  app.quit();
}

function openSettingsPanel() {
  summonWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ui:open-settings');
  mainWindow.webContents.focus();
}

/**
 * 设置面板改快捷键 / 开关：改完立刻重新注册，把注册结果（含失败原因）一起回给页面，
 * 这样「换个键 → 立刻能用」和「这个键被占了」都能当场看到。
 */
function setHotkey(input) {
  const data = input || {};
  const next = Object.assign({}, config.hotkey);

  if (data.accelerator !== undefined) {
    const accelerator = normalizeAccelerator(data.accelerator);
    if (!accelerator) return { ok: false, error: acceleratorHint(data.accelerator) };
    next.accelerator = accelerator;
  }
  if (data.enabled !== undefined) next.enabled = Boolean(data.enabled);
  if (data.action !== undefined && HOTKEY_ACTIONS.includes(data.action)) next.action = data.action;
  if (data.pinTop !== undefined) next.pinTop = Boolean(data.pinTop);
  if (data.closeToTray !== undefined) next.closeToTray = Boolean(data.closeToTray);
  if (data.tray !== undefined) next.tray = Boolean(data.tray);

  config.hotkey = next;
  registerHotkey();
  if (next.tray) createTray();
  else destroyTray();
  applyTrayTooltip();
  refreshTrayMenu();
  saveConfig();
  broadcast();
  return {
    ok: true,
    hotkey: publicState().hotkey,
    registered: hotkeyState.registered,
    error: hotkeyState.error,
  };
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

function layout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const [width, height] = mainWindow.getContentSize();
  // 窗口最小化时 Windows 会返回退化的客户区尺寸（通常只剩边框甚至 0x0）。
  // 若照着它算分屏宽度，视图会被压成 0 宽，所以直接跳过这次布局，
  // 等 restore / resize 事件带着正常尺寸再算一遍。
  if (width < MIN_SANE_WIDTH || height < MIN_SANE_HEIGHT) {
    log('跳过本次布局：窗口尺寸异常', width, height);
    return;
  }
  const top = TAB_BAR_HEIGHT;
  const bodyHeight = Math.max(0, height - top);

  // 设置面板打开时所有视图让位给窗口自身的页面
  const visible = overlayOpen ? [] : config.panes.filter((id) => getService(id));

  const geometry = computeGeometry(width);
  lastGeometry = geometry;

  for (const [id, view] of Array.from(views.entries())) {
    if (visible.includes(id) || !attached.has(id)) continue;
    try {
      mainWindow.contentView.removeChildView(view);
    } catch (err) {
      log('隐藏视图失败:', err.message);
    }
    attached.delete(id);
  }

  geometry.panes.forEach((pane) => {
    if (!visible.includes(pane.id)) return;
    const svc = getService(pane.id);
    if (!svc) return;
    const view = ensureView(svc);
    if (!attached.has(pane.id)) {
      mainWindow.contentView.addChildView(view);
      attached.add(pane.id);
    }
    view.setBounds({
      x: pane.x,
      y: top,
      width: pane.width,
      height: bodyHeight,
    });
  });

  sendLayout();

  // 开发调试：把当前几何导出到文件，供真实鼠标拖拽测试读取坐标（tools/ 不参与打包）
  if (process.env.AIHUB_LAYOUT_DUMP) {
    try {
      require('./tools/layout-dump.js')({
        mainWindow,
        screen,
        config,
        geometry: lastGeometry,
        tabBarHeight: TAB_BAR_HEIGHT,
      });
    } catch (err) {
      log('导出布局失败:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 标签操作
// ---------------------------------------------------------------------------

/**
 * 点击标签的行为：
 *  - 该服务已经在布局里 → 聚焦那一栏（布局不变）
 *  - 不在布局里 → 在当前聚焦的那一栏里打开它（单栏时就是普通的切换标签）
 */
function activate(id, { focus = true } = {}) {
  const svc = getService(id);
  if (!svc) return;

  if (config.panes.includes(id)) {
    config.activeId = id;
  } else {
    const index = Math.max(0, config.panes.indexOf(config.activeId));
    config.panes[index] = id;
    config.activeId = id;
    ensureView(svc);
  }

  saveConfig();
  layout();
  broadcast();
  if (focus && !overlayOpen) {
    const view = views.get(id);
    if (view && !view.webContents.isDestroyed()) view.webContents.focus();
  }
}

/** 单栏显示：只保留指定的一栏（默认当前聚焦栏） */
function showSinglePane(id) {
  const target = getService(id) ? id : config.activeId;
  return setPanes([target]);
}

function activeView() {
  const view = views.get(config.activeId);
  if (view && !view.webContents.isDestroyed()) return view;
  return null;
}

function reloadTab(id, { ignoreCache = false } = {}) {
  const targetId = id || config.activeId;
  const view = views.get(targetId);
  if (!view || view.webContents.isDestroyed()) return;
  if (ignoreCache) view.webContents.reloadIgnoringCache();
  else view.webContents.reload();
}

function goHome(id) {
  const targetId = id || config.activeId;
  const svc = getService(targetId);
  const view = views.get(targetId);
  if (!svc || !view || view.webContents.isDestroyed()) return;
  delete config.lastUrls[targetId];
  saveConfig();
  view.webContents.loadURL(svc.url).catch(() => {});
}

function setZoom(delta, id) {
  const targetId = id || config.activeId;
  const view = views.get(targetId);
  if (!view || view.webContents.isDestroyed()) return;
  const next = Math.max(-3, Math.min(4, view.webContents.getZoomLevel() + delta));
  view.webContents.setZoomLevel(next);
}

function cycleTab(step) {
  const list = config.services;
  if (!list.length) return;
  const index = list.findIndex((s) => s.id === config.activeId);
  const next = ((index < 0 ? 0 : index) + step + list.length) % list.length;
  activate(list[next].id);
}

function activateByIndex(index) {
  const svc = config.services[index];
  if (svc) activate(svc.id);
}

function toggleDevTools(id) {
  const targetId = id || config.activeId;
  const view = views.get(targetId);
  if (!view || view.webContents.isDestroyed()) return;
  // detach 模式：调试窗口独立，不会挤占视图区域
  if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools();
  else view.webContents.openDevTools({ mode: 'detach' });
}

// ---------------------------------------------------------------------------
// 右键菜单
//
// Electron 默认不给任何右键菜单（连「复制 / 粘贴」都没有），所以服务页面里
// 右键会像坏掉一样。这里给每个服务视图挂一个原生右键菜单：
// 有选区就给复制，在输入框里就给撤销/剪切/粘贴，点在链接/图片上就给对应操作，
// 最后永远有「刷新 / 检查元素」这类兜底项。
// ---------------------------------------------------------------------------

/** 服务页面里的右键菜单 */
function popupViewContextMenu(wc, params) {
  if (!wc || wc.isDestroyed()) return;
  const items = [];
  const add = (item) => items.push(item);
  const sep = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  };

  // 可编辑区域（输入框、聊天框）：给完整的编辑动作
  if (params.isEditable) {
    add({ role: 'undo', label: '撤销' });
    add({ role: 'redo', label: '重做' });
    sep();
    add({ role: 'cut', label: '剪切' });
    add({ role: 'copy', label: '复制' });
    add({ role: 'paste', label: '粘贴' });
    add({ role: 'selectAll', label: '全选' });
  } else if (params.selectionText) {
    add({ role: 'copy', label: '复制' });
    const text = params.selectionText.length > 24
      ? `${params.selectionText.slice(0, 24)}…`
      : params.selectionText;
    add({
      label: `用默认浏览器搜索「${text.replace(/\s+/g, ' ')}」`,
      click: () => {
        shell.openExternal(`https://www.bing.com/search?q=${encodeURIComponent(params.selectionText)}`);
      },
    });
  }

  if (params.linkURL) {
    sep();
    add({
      label: '在默认浏览器中打开链接',
      click: () => { shell.openExternal(params.linkURL); },
    });
    add({
      label: '复制链接地址',
      click: () => { clipboard.writeText(params.linkURL); },
    });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    sep();
    add({
      label: '复制图片',
      click: () => { wc.copyImageAt(params.x, params.y); },
    });
    add({
      label: '在默认浏览器中打开图片',
      click: () => { shell.openExternal(params.srcURL); },
    });
  }

  sep();
  add({ label: '刷新页面', click: () => { wc.reload(); } });
  add({ label: '强制刷新（忽略缓存）', click: () => { wc.reloadIgnoringCache(); } });
  add({
    label: '检查元素',
    click: () => {
      wc.inspectElement(params.x, params.y);
      if (wc.isDevToolsOpened()) wc.devToolsWebContents.focus();
    },
  });

  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: mainWindow || undefined });
}

// ---------------------------------------------------------------------------
// 服务增删改
// ---------------------------------------------------------------------------

function addService(input) {
  const name = String((input && input.name) || '').trim().slice(0, 40);
  const url = normalizeUrl(input && input.url);
  if (!name) return { ok: false, error: '请填写服务名称' };
  if (!url) return { ok: false, error: '请填写合法网址（http / https）' };
  if (config.services.some((s) => s.url === url)) {
    return { ok: false, error: '这个网址已经添加过了' };
  }
  const svc = {
    id: newServiceId(name, config.services),
    name,
    url,
    color: /^#[0-9a-f]{6}$/i.test((input && input.color) || '')
      ? input.color
      : pickColor(config.services.length),
    custom: true,
  };
  // 常见站点自动配上内置 logo
  svc.icon = iconForService(svc);
  config.services.push(svc);
  saveConfig();
  // 开着预加载时，新加的标签也立刻加载起来，不用点一下才出标题
  if (config.preload) {
    try {
      ensureView(svc);
    } catch (err) {
      log('新服务预加载失败:', err.message);
    }
  }
  broadcast();
  return { ok: true, id: svc.id };
}

function updateService(input) {
  const id = String((input && input.id) || '');
  const svc = getService(id);
  if (!svc) return { ok: false, error: '服务不存在' };

  const name = String((input && input.name) || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: '请填写服务名称' };
  const url = input && input.url !== undefined ? normalizeUrl(input.url) : svc.url;
  if (!url) return { ok: false, error: '请填写合法网址（http / https）' };
  if (config.services.some((s) => s.id !== id && s.url === url)) {
    return { ok: false, error: '这个网址已经添加过了' };
  }

  const urlChanged = url !== svc.url;
  svc.name = name;
  svc.url = url;
  if (/^#[0-9a-f]{6}$/i.test((input && input.color) || '')) svc.color = input.color;

  if (urlChanged) {
    delete config.lastUrls[id];
    const view = views.get(id);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.loadURL(url).catch(() => {});
    }
  }

  saveConfig();
  layout();
  broadcast();
  return { ok: true, id };
}

function removeService(id, wipe) {
  const svc = getService(id);
  if (!svc) return { ok: false, error: '服务不存在' };

  destroyView(id);

  if (wipe) {
    try {
      // 立刻清掉内容（Cookie、本地存储等），目录本身留到下次启动再删
      Promise.resolve(session.fromPartition(partitionOf(id)).clearStorageData())
        .catch((err) => log('清除登录数据失败:', err.message));
    } catch (err) {
      log('清除登录数据失败:', err.message);
    }
    hardenedSessions.delete(partitionOf(id));
    if (!Array.isArray(config.pendingWipe)) config.pendingWipe = [];
    if (!config.pendingWipe.includes(id)) config.pendingWipe.push(id);
  }

  config.services = config.services.filter((s) => s.id !== id);
  delete config.lastUrls[id];
  if (!config.services.length) {
    config.services = DEFAULT_SERVICES.map((s) => ({ ...s, custom: false }));
  }
  // 从分屏布局里摘掉它，剩下的栏按比例放大（保留用户拖过的比例）
  if (config.panes.includes(id)) {
    const remaining = config.panes.filter((paneId) => paneId !== id);
    if (remaining.length) {
      const weights = remaining.map((paneId) => config.weights[config.panes.indexOf(paneId)] || 0);
      config.panes = remaining;
      config.weights = normalizeWeights(weights, remaining.length);
    } else {
      config.panes = [config.services[0].id];
      config.weights = [1];
    }
  }
  if (config.activeId === id) config.activeId = config.panes[0];

  saveConfig();
  activate(config.activeId);
  return { ok: true, state: publicState() };
}

// ---------------------------------------------------------------------------
// 登录信息导出 / 导入（跨设备迁移账号）
// ---------------------------------------------------------------------------
//
// 每个服务是独立的 session partition，登录态由两部分组成：
//   1. Cookie（HttpOnly 的会话令牌也在内）—— 通过 session.cookies 读写，和磁盘上的文件无关；
//   2. 页面本地存储（localStorage / sessionStorage）—— 只能在该服务的页面里用 JS 读写。
// 导出成一个 JSON 文件，另一台设备导入后各服务的登录态就跟着过去了。
// 可选给文件加密（scrypt 派生密钥 + AES-256-GCM），因为里面等于明文密码。
//
// 不含 IndexedDB / Service Worker 缓存：这四个站点（以及绝大多数网页版 AI）
// 的登录态都在 Cookie 和 localStorage 里，其余属于缓存内容，迁移没有意义。

const LOGIN_FORMAT = 'aihub-login';
// 改名之前导出的文件写的是这个 format，导入时要继续认，不能让人重导一次
const LOGIN_FORMAT_LEGACY = ['ai-multi-hub-login'];
const LOGIN_VERSION = 1;
const STORAGE_READ_TIMEOUT = 20000;

const STORAGE_DUMP_JS = `(() => {
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        out[key] = store.getItem(key);
      }
    } catch (err) { /* 某些页面禁止访问，忽略 */ }
    return out;
  };
  return { origin: location.origin, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
})()`;

function storageRestoreJs(payload) {
  return `(() => {
  const data = ${JSON.stringify(payload)};
  const put = (store, entries) => {
    let n = 0;
    Object.keys(entries || {}).forEach((key) => {
      try { store.setItem(key, entries[key]); n += 1; } catch (err) { /* 忽略单个键 */ }
    });
    return n;
  };
  return { localStorage: put(localStorage, data.localStorage), sessionStorage: put(sessionStorage, data.sessionStorage) };
})()`;
}

function sessionOf(id) {
  return session.fromPartition(partitionOf(id));
}

/** 等视图当前这次加载结束（带超时），返回是否加载完成 */
function waitForLoad(wc, timeoutMs) {
  if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', onStop);
      wc.off('did-fail-load', onStop);
      wc.off('render-process-gone', onStop);
      resolve(ok);
    };
    const onStop = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    wc.on('did-stop-loading', onStop);
    wc.on('did-fail-load', onStop);
    wc.on('render-process-gone', onStop);
  });
}

/** 读出某个服务当前页面所在源的本地存储 */
async function readStorages(svc) {
  const view = ensureView(svc);
  const wc = view.webContents;
  await waitForLoad(wc, STORAGE_READ_TIMEOUT);
  if (wc.isDestroyed()) return [];
  const url = wc.getURL();
  if (!/^https?:/i.test(url)) return [];
  try {
    const data = await wc.executeJavaScript(STORAGE_DUMP_JS, false);
    if (!data || !data.origin) return [];
    return [{
      origin: data.origin,
      pageUrl: url,
      localStorage: data.localStorage || {},
      sessionStorage: data.sessionStorage || {},
    }];
  } catch (err) {
    log('读取本地存储失败:', svc.id, err.message);
    return [];
  }
}

function cleanCookie(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '',
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || 'unspecified',
    hostOnly: Boolean(cookie.hostOnly),
  };
  if (typeof cookie.expirationDate === 'number') out.expirationDate = cookie.expirationDate;
  return out;
}

/** 导出用：采集一个服务的登录信息 */
async function collectLoginData(svc) {
  let cookies = [];
  try {
    cookies = (await sessionOf(svc.id).cookies.get({})).map(cleanCookie);
  } catch (err) {
    log('读取 Cookie 失败:', svc.id, err.message);
  }
  return {
    id: svc.id,
    name: svc.name,
    url: svc.url,
    color: svc.color,
    cookies,
    origins: await readStorages(svc),
  };
}

function countStorages(entry) {
  return Object.keys(entry.localStorage || {}).length + Object.keys(entry.sessionStorage || {}).length;
}

function encryptLogin(payload, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: LOGIN_FORMAT,
    version: LOGIN_VERSION,
    encrypted: true,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptLogin(envelope, password) {
  if (!password) throw new Error('这个文件已加密，请先填写导出时设置的密码');
  const key = crypto.scryptSync(password, Buffer.from(String(envelope.salt || ''), 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv || ''), 'base64'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  const text = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.data || ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(text);
}

function parseLoginFile(text) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('这个文件不是有效的登录信息文件（JSON 解析失败）');
  }
  if (!raw || typeof raw !== 'object') throw new Error('登录信息文件内容为空');
  if (raw.format !== LOGIN_FORMAT && !LOGIN_FORMAT_LEGACY.includes(raw.format)) {
    throw new Error('文件格式不匹配：请选择由本应用「导出登录信息」生成的文件');
  }
  if (raw.encrypted) return { envelope: raw, payload: null };
  return { envelope: null, payload: raw };
}

/**
 * 把导入文件里的服务条目和当前服务对应起来。
 * 匹配顺序很关键：同一个站点可能被用户加成了两个标签（比如同一域名的两个路径），
 * 只按域名匹配会把数据写进另一个服务的分区，所以先看 id、再看完整网址，最后才退回同源。
 * 一个服务只接受一条导入条目（防止同一份数据被写两次）。
 */
function matchServices(payloadServices) {
  const matched = [];
  const unmatched = [];
  const used = new Set();

  const pick = (entry, predicate) => config.services.find(
    (s) => !used.has(s.id) && predicate(s),
  );

  for (const entry of payloadServices) {
    if (!entry || !entry.id) continue;
    const origin = originOf(entry.url);
    const url = String(entry.url || '');
    const svc = (url && pick(entry, (s) => s.id === entry.id && s.url === url))
      || (url && pick(entry, (s) => s.url === url))
      || pick(entry, (s) => s.id === entry.id)
      || (origin && pick(entry, (s) => originOf(s.url) === origin))
      || null;
    if (svc) {
      used.add(svc.id);
      matched.push({ svc, entry });
    } else {
      unmatched.push({ id: entry.id, name: entry.name || entry.id, url: entry.url || '' });
    }
  }
  return { matched, unmatched };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '');
  }
}

function cookieUrl(cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const scheme = cookie.secure ? 'https' : 'http';
  const cookiePath = String(cookie.path || '/').startsWith('/') ? cookie.path : '/';
  return `${scheme}://${host}${cookiePath}`;
}

/** 写入单个 Cookie，返回 'ok' | 'expired' | 'failed' */
async function restoreCookie(ses, cookie) {
  if (!cookie || !cookie.name) return 'failed';
  if (typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 < Date.now()) return 'expired';
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: String(cookie.value == null ? '' : cookie.value),
    path: String(cookie.path || '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  // host-only 的 Cookie 不能带 domain，否则会变成域 Cookie
  if (cookie.domain && !cookie.hostOnly) details.domain = cookie.domain;
  const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)
    ? cookie.sameSite
    : 'unspecified';
  if (sameSite !== 'unspecified') details.sameSite = sameSite;
  if (typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate;
  try {
    await ses.cookies.set(details);
    return 'ok';
  } catch (err) {
    log('写入 Cookie 失败:', cookie.name, err.message);
    return 'failed';
  }
}

/** 导出：可选加密，返回统计结果 */
async function exportLogin(input) {
  const options = input || {};
  const file = options.file ? path.resolve(String(options.file)) : null;
  if (!file) return { ok: false, error: '没有选择保存位置' };
  const password = String(options.password || '');

  const services = [];
  const preExisting = new Set(views.keys());
  for (const svc of config.services) {
    // 逐个服务顺序采集，避免同时加载多个站点
    services.push(await collectLoginData(svc));
    // 读本地存储需要页面，所以会给没打开过的服务临时建视图；读完就还回去，
    // 否则导出一次就让所有服务都常驻内存，和「懒创建」的设计相悖。
    if (!preExisting.has(svc.id) && !attached.has(svc.id)) destroyView(svc.id);
  }

  const payload = {
    format: LOGIN_FORMAT,
    version: LOGIN_VERSION,
    exportedAt: new Date().toISOString(),
    app: { name: 'Aihub', version: app.getVersion() },
    services,
  };

  const body = password ? encryptLogin(payload, password) : payload;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: `写入文件失败：${err.message}` };
  }

  const cookieCount = services.reduce((sum, s) => sum + s.cookies.length, 0);
  const storageCount = services.reduce((sum, s) => sum + s.origins.reduce((n, o) => n + countStorages(o), 0), 0);
  log('导出登录信息:', file, `${services.length} 个服务 / ${cookieCount} 条 Cookie / ${storageCount} 项本地存储`);
  return {
    ok: true,
    file,
    encrypted: Boolean(password),
    services: services.length,
    cookies: cookieCount,
    storages: storageCount,
    bytes: fs.statSync(file).size,
  };
}

/**
 * 导入：dryRun 时只解析并汇总，不写入。
 * 写入顺序是「先 Cookie 后本地存储」，最后刷新各视图让新登录态生效。
 */
async function importLogin(input) {
  const options = input || {};
  const file = options.file ? path.resolve(String(options.file)) : null;
  if (!file) return { ok: false, error: '没有选择文件' };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, file, error: `读取文件失败：${err.message}` };
  }

  let payload;
  let wasEncrypted = false;
  try {
    const parsed = parseLoginFile(text);
    wasEncrypted = Boolean(parsed.envelope);
    payload = parsed.envelope ? decryptLogin(parsed.envelope, String(options.password || '')) : parsed.payload;
  } catch (err) {
    return { ok: false, file, error: err.message, needsPassword: wasEncrypted && !options.password };
  }

  if (!payload || !Array.isArray(payload.services) || !payload.services.length) {
    return { ok: false, file, error: '文件里没有任何可导入的服务' };
  }

  const { matched, unmatched } = matchServices(payload.services);
  if (!matched.length) {
    return {
      ok: false,
      file,
      error: '文件里的服务在当前应用里都找不到对应项（请先添加同样的服务再导入）',
      unmatched,
    };
  }

  const summary = {
    ok: true,
    file,
    dryRun: Boolean(options.dryRun),
    encrypted: wasEncrypted,
    exportedAt: payload.exportedAt || '',
    services: [],
    unmatched,
  };
  for (const { svc, entry } of matched) {
    summary.services.push({
      id: svc.id,
      name: svc.name,
      cookies: (entry.cookies || []).length,
      storages: (entry.origins || []).reduce((n, o) => n + countStorages(o), 0),
    });
  }
  if (options.dryRun) return summary;

  for (const { svc, entry } of matched) {
    const ses = sessionOf(svc.id);
    let ok = 0;
    let failed = 0;
    let expired = 0;
    for (const cookie of entry.cookies || []) {
      // 顺序写入：并发写同一个 Cookie 存储容易互相覆盖
      const result = await restoreCookie(ses, cookie);
      if (result === 'ok') ok += 1;
      else if (result === 'expired') expired += 1;
      else failed += 1;
    }
    const target = summary.services.find((s) => s.id === svc.id);
    target.cookies = ok;
    target.expired = expired;
    target.failed = failed;

    // 本地存储只能写进「同源」的页面里
    let restoredKeys = 0;
    for (const origin of entry.origins || []) {
      if (!origin || !origin.origin) continue;
      const view = ensureView(svc);
      const wc = view.webContents;
      await waitForLoad(wc, STORAGE_READ_TIMEOUT);
      if (wc.isDestroyed()) break;
      const current = originOf(wc.getURL());
      if (current !== origin.origin) {
        // 视图不在这个源上（例如停在第三方登录页）：先回到服务首页再写
        try {
          wc.loadURL(svc.url);
          await waitForLoad(wc, STORAGE_READ_TIMEOUT);
        } catch (err) {
          log('回到服务首页失败:', svc.id, err.message);
          continue;
        }
      }
      try {
        const written = await wc.executeJavaScript(storageRestoreJs({
          localStorage: origin.localStorage || {},
          sessionStorage: origin.sessionStorage || {},
        }), false);
        restoredKeys += (written && written.localStorage ? written.localStorage : 0)
          + (written && written.sessionStorage ? written.sessionStorage : 0);
      } catch (err) {
        log('写入本地存储失败:', svc.id, err.message);
      }
    }
    target.storages = restoredKeys;

    // 刷新一次，让页面用新登录态重新加载
    const view = views.get(svc.id);
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
  }

  layout();
  broadcast();
  return summary;
}

// ---------------------------------------------------------------------------
// 键盘快捷键（挂在所有 webContents 上，标签内也生效）
// ---------------------------------------------------------------------------

function attachShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = isMac ? input.meta : input.control;
    const key = String(input.key || '').toLowerCase();

    if (!mod) {
      if (key === 'f5') {
        event.preventDefault();
        reloadTab(null, { ignoreCache: input.shift });
      } else if (key === 'f12') {
        event.preventDefault();
        toggleDevTools(null);
      }
      return;
    }

    if (key === 'tab') {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      reloadTab(null, { ignoreCache: input.shift });
      return;
    }
    if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      activateByIndex(Number(key) - 1);
      return;
    }
    if (key === '=' || key === '+') {
      event.preventDefault();
      setZoom(0.1);
      return;
    }
    if (key === '-') {
      event.preventDefault();
      setZoom(-0.1);
      return;
    }
    if (key === '0') {
      event.preventDefault();
      const view = activeView();
      if (view) view.webContents.setZoomLevel(0);
      return;
    }
    if (key === 'i' && input.shift) {
      event.preventDefault();
      toggleDevTools(null);
      return;
    }
    if (key === ',') {
      // 打开设置面板：设在标签栏页面里，由它回传 ui:overlay 让视图让位
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ui:open-settings');
        mainWindow.webContents.focus();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

let ipcInstalled = false;

function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.handle('app:get-state', () => publicState());

  ipcMain.on('tab:activate', (_event, id) => activate(String(id || '')));
  ipcMain.on('tab:reload', (_event, id) => reloadTab(id ? String(id) : null));
  ipcMain.on('tab:reload-hard', (_event, id) => reloadTab(id ? String(id) : null, { ignoreCache: true }));
  ipcMain.on('tab:home', (_event, id) => goHome(id ? String(id) : null));
  ipcMain.on('tab:devtools', (_event, id) => toggleDevTools(id ? String(id) : null));
  ipcMain.on('tab:zoom', (_event, payload) => {
    const data = payload || {};
    setZoom(Number(data.delta) || 0, data.id ? String(data.id) : null);
  });
  ipcMain.on('pane:focus', (_event, id) => focusPane(String(id || '')));
  ipcMain.handle('layout:set-panes', (_event, ids) => setPanes(ids));
  ipcMain.handle('layout:get', () => ({
    panes: lastGeometry.panes,
    dividers: lastGeometry.dividers,
    gap: SPLIT_GAP,
    minPaneWidth: MIN_PANE_WIDTH,
    top: TAB_BAR_HEIGHT,
    overlay: overlayOpen,
  }));
  ipcMain.on('layout:drag', (_event, payload) => {
    const data = payload || {};
    if (dragDivider(Number(data.index), Number(data.x))) dragging = true;
  });
  ipcMain.on('layout:drag-end', (_event, payload) => {
    dragging = false;
    const data = payload || {};
    if (data.equalize) equalizeDivider(Number(data.index));
    saveConfig();
    broadcast();
    sendLayout();
  });
  ipcMain.on('layout:equalize', () => equalizeAll());
  ipcMain.on('layout:single', (_event, id) => showSinglePane(id ? String(id) : null));
  ipcMain.on('ui:overlay', (_event, open) => {
    overlayOpen = Boolean(open);
    layout();
    if (!overlayOpen) {
      const view = activeView();
      if (view) view.webContents.focus();
    }
  });
  ipcMain.on('app:open-external', (_event, url) => openExternal(url));
  ipcMain.on('app:quit', () => quitApp());
  ipcMain.on('window:summon', () => summonWindow());
  ipcMain.on('window:hide', () => hideToBackground());

  ipcMain.handle('services:add', (_event, input) => addService(input));
  ipcMain.handle('services:update', (_event, input) => updateService(input));
  ipcMain.handle('config:set-preload', (_event, payload) => setPreload(payload));
  ipcMain.handle('config:get-preload', () => Boolean(config.preload));
  ipcMain.handle('config:set-theme', (_event, payload) => setTheme(String(payload || '')));
  ipcMain.handle('config:set-hotkey', (_event, payload) => setHotkey(payload));
  ipcMain.handle('config:get-hotkey', () => publicState().hotkey);
  ipcMain.handle('ui:split-menu', (_event, point) => popupSplitMenu(point));
  ipcMain.handle('ui:shell-menu', (_event, point) => popupShellMenu(point));
  ipcMain.handle('services:remove', (_event, payload) => {
    const data = payload || {};
    return removeService(String(data.id || ''), Boolean(data.wipe));
  });

  ipcMain.handle('login:export', async (_event, payload) => {
    const data = payload || {};
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '导出登录信息',
      defaultPath: path.join(app.getPath('documents'), `aihub-login-${stamp}.json`),
      filters: [{ name: '登录信息文件', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    return exportLogin({ file: picked.filePath, password: data.password });
  });

  ipcMain.handle('login:import', async (_event, payload) => {
    const data = payload || {};
    let file = data.file ? String(data.file) : '';
    if (!file) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '导入登录信息',
        filters: [{ name: '登录信息文件', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      [file] = picked.filePaths;
    }
    return importLogin({ file, password: data.password, dryRun: Boolean(data.dryRun) });
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function windowIcon() {
  const file = path.join(__dirname, 'build', 'icon.ico');
  return process.platform === 'win32' && fs.existsSync(file) ? file : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    title: 'Aihub',
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 应用自己这一层（标签栏 / 设置面板）的右键：
  // 输入框、选区交给原生编辑菜单；其它位置由渲染层发 ui:shell-menu 弹出应用菜单。
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    try {
      popupViewContextMenu(mainWindow.webContents, params);
    } catch (err) {
      log('右键菜单失败:', err.message);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', layout);
  mainWindow.on('restore', layout);
  mainWindow.on('maximize', layout);
  mainWindow.on('unmaximize', layout);
  mainWindow.on('enter-full-screen', layout);
  mainWindow.on('leave-full-screen', layout);

  // 唤出时加的「最高优先级置顶」在窗口真正让出前台后自动取消，
  // 否则它会长久压在别的窗口上，反而碍事。
  // 用 scheduleReleasePin：瞬间的 blur（系统通知、输入法、别的程序抢一下前台）不算让出前台。
  mainWindow.on('blur', () => scheduleReleasePin());
  mainWindow.on('hide', () => scheduleReleasePin({ force: true }));
  for (const event of ['show', 'hide', 'minimize', 'restore']) {
    mainWindow.on(event, () => refreshTrayMenu());
  }

  // 点关闭按钮：默认收进后台而不是退出（否则快捷键就跟着没了）。
  // quitting 为真（托盘退出 / 系统注销 / app.quit）时不拦，让它正常关闭。
  mainWindow.on('close', (event) => {
    if (quitting || !config.hotkey.closeToTray) return;
    event.preventDefault();
    hideToBackground();
    hintHiddenToTray();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    attached.clear();
  });

  installIpc();
  activate(config.activeId || config.services[0].id, { focus: false });
  // 其余标签按顺序在后台加载好（标题、favicon 不用点就有）
  preloadAll();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/**
 * 老版本叫 "AI Multi Hub"，数据目录就是 %APPDATA%\AI Multi Hub；改名成 Aihub 之后
 * Electron 会改用 %APPDATA%\Aihub，登录态（Partitions/）、配置、缓存全都留在旧目录里。
 *
 * 坑：**不能只看「新目录是否存在」**。Electron 在跑主进程脚本之前就把 userData 目录建好了
 * （里面只有一堆 Chromium 缓存壳子），所以旧写法永远判定成「新目录已存在」而跳过迁移，
 * 结果就是改名之后所有站点都要重新登录。改成逐个条目搬，并且同盘优先用 rename（瞬间完成）：
 *
 *   · 新目录里已经存在同名条目（空壳缓存 / 已经用过新版本）→ 递归合并覆盖
 *   · 新目录里还没有 → 直接 rename，同盘改名是瞬时的，不会卡启动
 *
 * 失败也只在日志里报错——最坏情况不过是重新登录一次，绝不能让启动失败。
 */
const MIGRATE_ENTRIES = [
  'config.json',        // 服务列表、分屏布局、主题、快捷键
  'Partitions',         // 各服务的 Cookie / 本地存储（登录态）
  'Local Storage',
  'Session Storage',
  'Network',
  'Preferences',
  'Local State',
];

/**
 * 「这个目录已经被真正用过」的判据，只认 config.json。
 *
 * config.json 是本应用自己写的，第一次启动就会落盘；而 Electron 提前建好目录时只会放
 * Chromium 那些缓存壳子（Cache / GPUCache / Preferences…），不会有它。
 * 注意不能用「目录存在」判断——那正是上一版迁移失效的原因（Electron 先把目录建好了，
 * 于是每次都被判定成「新目录已存在」而跳过，结果改名之后所有站点都要重新登录）。
 */
function isProfileInUse(dir) {
  return fs.existsSync(path.join(dir, 'config.json'));
}

/** 旧目录里还有没有值得搬的东西（配置或登录态） */
function hasLegacyData(dir) {
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'config.json'))) return true;
  try {
    const partitions = path.join(dir, 'Partitions');
    return fs.existsSync(partitions) && fs.readdirSync(partitions).length > 0;
  } catch {
    return false;
  }
}

function migrateLegacyUserData(options) {
  const appData = (options && options.appData) || app.getPath('appData');
  const current = (options && options.current) || app.getPath('userData');
  const legacy = (options && options.legacy) || path.join(appData, 'AI Multi Hub');
  const result = { migrated: false, reason: '', from: legacy, to: current, moved: [], copied: [] };

  try {
    if (path.resolve(legacy) === path.resolve(current)) {
      result.reason = '新旧目录相同';
      return result;
    }
    if (!hasLegacyData(legacy)) {
      result.reason = '旧目录没有用户数据';
      return result;
    }
    if (isProfileInUse(current)) {
      result.reason = '新目录已有用户数据，不覆盖';
      return result;
    }

    for (const entry of MIGRATE_ENTRIES) {
      const from = path.join(legacy, entry);
      if (!fs.existsSync(from)) continue;
      const to = path.join(current, entry);
      try {
        if (!fs.existsSync(to)) {
          fs.renameSync(from, to);
          result.moved.push(entry);
        } else {
          fs.cpSync(from, to, { recursive: true, force: true });
          result.copied.push(entry);
        }
      } catch (err) {
        console.error(`[aihub] 迁移 ${entry} 失败（继续迁移其它条目）:`, err.message);
      }
    }

    result.migrated = result.moved.length > 0 || result.copied.length > 0;
    result.reason = result.migrated ? '已迁移' : '没有可迁移的条目';
    if (result.migrated) {
      log('已迁移旧数据目录内容:', legacy, '->', current,
        '（直接改名:', result.moved.join(',') || '无', '；合并复制:', result.copied.join(',') || '无', '）');
    }
  } catch (err) {
    result.reason = '迁移失败: ' + err.message;
    console.error('[aihub] 旧数据目录迁移失败（不影响启动）:', err.message);
  }
  return result;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 自检时被单实例锁挡住会「什么都没跑就退出」，看起来像通过，必须大声失败
  if (process.env.AIHUB_SMOKE) {
    console.error('SMOKE_FAIL：已有实例在运行，单实例锁导致本次自检没有真正执行。请先退出应用再跑。');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    // 再次双击图标 / 再开一次时，不新开窗口，直接把它唤到最前
    summonWindow();
  });

  if (process.platform === 'win32') app.setAppUserModelId('io.github.openx123.aihub');

  // 必须在任何 session / 配置读写之前做完：数据目录还在用旧名字的话，这里就把它搬过来
  migrateLegacyUserData();

  app.on('web-contents-created', (_event, wc) => attachShortcuts(wc));

  // 跟随系统时，系统深浅色一变，服务页面的底色也要跟着换
  nativeTheme.on('updated', () => applyTheme());

  app.whenReady().then(() => {
    if (!isMac) Menu.setApplicationMenu(null);
    loadConfig();
    log('配置:', configFile());
    applyTheme();
    // 删除服务时标记的分区目录，趁现在还没有任何 session 打开它，直接删干净
    flushPendingWipes();
    createWindow();
    // 全局快捷键要在窗口建好之后注册：注册失败时至少还能看到窗口
    registerHotkey();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else summonWindow();
    });

    if (process.env.AIHUB_SMOKE) {
      // 开发自检：驱动一遍核心流程并逐项断言，只在设置了环境变量时加载。
      // tools/ 不参与打包，所以包一层 try，避免误设环境变量时把应用带崩。
      try {
        require('./tools/smoke.js')({
          app,
          getWindow: () => mainWindow,
          views,
          attached,
          config,
          publicState,
          activate,
          setPanes,
          dragDivider,
          equalizeDivider,
          equalizeAll,
          focusPane,
          addService,
          removeService,
          migrateServices,
          setPreload,
          setTheme,
          buildSplitMenuTemplate,
          buildShellMenuTemplate,
          popupSplitMenu,
          popupShellMenu,
          popupViewContextMenu,
          getMenuPopupCount: () => menuPopups,
          iconKeyForService: iconKeyForServiceOf,
          THEMES,
          preloadAll,
          iconForService,
          DEFAULT_SERVICES,
          SERVICES_VERSION,
          exportLogin,
          importLogin,
          sessionOf,
          LOGIN_FORMAT,
          LOGIN_FORMAT_LEGACY,
          migrateLegacyUserData,
          configFile,
          getGeometry: () => lastGeometry,
          getOverlay: () => overlayOpen,
          setOverlay: (open) => {
            overlayOpen = Boolean(open);
            layout();
          },
          // 全局快捷键 / 托盘
          setHotkey,
          getHotkey: () => publicState().hotkey,
          normalizeAccelerator,
          acceleratorHint,
          summonWindow,
          hideWindow: hideToBackground,
          triggerHotkey: onGlobalHotkey,
          pinWindow,
          releasePin,
          isPinned: () => pinnedByHotkey,
          snapshotConfig: () => JSON.parse(JSON.stringify(config)),
          replaceConfig,
          isHotkeyRegistered: (acc) => {
            try {
              return globalShortcut.isRegistered(String(acc || ''));
            } catch {
              return false;
            }
          },
          getRegisteredAccelerator: () => registeredAccelerator,
          getTray: () => tray,
          buildTrayMenuTemplate,
          createTray,
          destroyTray,
          openSettingsPanel,
          HOTKEY_DEFAULT,
          log,
        });
      } catch (err) {
        console.error('[aihub] 自检脚本加载失败（打包版不含 tools/，属正常）:', err.message);
      }
    }
  });
}

app.on('before-quit', () => {
  quitting = true;
  flushConfig();
  // 快捷键占着系统资源，退出前一定要还回去（否则要等进程真正结束才释放）
  unregisterHotkey();
  destroyTray();
  for (const win of Array.from(popups)) {
    if (!win.isDestroyed()) win.destroy();
  }
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    log('注销全部快捷键失败（可忽略）:', err.message);
  }
});

app.on('window-all-closed', () => {
  flushConfig();
  if (!isMac || quitting) app.quit();
});
