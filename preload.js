'use strict';

/**
 * 标签栏页面（index.html）的安全桥梁。
 * 只暴露“切换标签 / 管理服务 / 收状态”这几件事，不暴露任何 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  // 状态
  getState: () => ipcRenderer.invoke('app:get-state'),
  onState: (handler) => on('state:changed', handler),
  onTabStatus: (handler) => on('tab:status', handler),
  onOpenSettings: (handler) => on('ui:open-settings', handler),
  onLayout: (handler) => on('layout:changed', handler),

  // 标签
  activate: (id) => ipcRenderer.send('tab:activate', id),
  reload: (id) => ipcRenderer.send('tab:reload', id),
  reloadHard: (id) => ipcRenderer.send('tab:reload-hard', id),
  home: (id) => ipcRenderer.send('tab:home', id),
  devtools: (id) => ipcRenderer.send('tab:devtools', id),
  zoom: (delta, id) => ipcRenderer.send('tab:zoom', { delta, id }),

  // 分屏布局
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setPanes: (ids) => ipcRenderer.invoke('layout:set-panes', ids),
  showSingle: (id) => ipcRenderer.send('layout:single', id),
  equalize: () => ipcRenderer.send('layout:equalize'),
  focusPane: (id) => ipcRenderer.send('pane:focus', id),
  dragDivider: (index, x) => ipcRenderer.send('layout:drag', { index, x }),
  endDrag: (payload) => ipcRenderer.send('layout:drag-end', payload || {}),

  // 服务管理
  addService: (input) => ipcRenderer.invoke('services:add', input),
  updateService: (input) => ipcRenderer.invoke('services:update', input),
  removeService: (id, wipe) => ipcRenderer.invoke('services:remove', { id, wipe }),
  // 从顶栏收起 / 放回来（服务和登录态都留着，只是不在标签栏上占位）
  setServiceHidden: (id, hidden) => ipcRenderer.invoke('services:set-hidden', { id, hidden }),
  // 拖拽调整标签顺序：传顶栏上看得见的那些 id，按新顺序
  reorderServices: (ids) => ipcRenderer.invoke('services:reorder', { ids }),

  // 偏好：启动时预加载所有标签
  setPreload: (on) => ipcRenderer.invoke('config:set-preload', Boolean(on)),
  getPreload: () => ipcRenderer.invoke('config:get-preload'),

  // 偏好：后台标签闲置多久自动休眠（释放它的渲染进程，点回去自动恢复）
  setHibernate: (input) => ipcRenderer.invoke('config:set-hibernate', input || {}),

  // 外观主题：dark / light / system
  setTheme: (theme) => ipcRenderer.invoke('config:set-theme', String(theme || '')),

  // 全局快捷键（老板键）：改完立刻重新注册，注册失败的原因会一起回传
  setHotkey: (input) => ipcRenderer.invoke('config:set-hotkey', input || {}),
  getHotkey: () => ipcRenderer.invoke('config:get-hotkey'),
  summonWindow: () => ipcRenderer.send('window:summon'),
  hideWindow: () => ipcRenderer.send('window:hide'),

  // 分屏菜单：交给主进程弹 Windows 原生菜单（浮在服务页面之上，不需要让布局腾地方）
  openSplitMenu: (point) => ipcRenderer.invoke('ui:split-menu', point || {}),
  // 标签栏/空白处的右键菜单
  openShellMenu: (point) => ipcRenderer.invoke('ui:shell-menu', point || {}),

  // 登录信息迁移
  exportLogin: (password) => ipcRenderer.invoke('login:export', { password }),
  importLogin: (options) => ipcRenderer.invoke('login:import', options || {}),

  // 自动更新（只有 Windows 打包版会真的去查；状态跟着 onState 一起回来）
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),

  // 窗口
  setOverlay: (open) => ipcRenderer.send('ui:overlay', Boolean(open)),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
});
