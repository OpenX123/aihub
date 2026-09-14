'use strict';

/**
 * window.api —— Tauri 版实现。
 *
 * 这是整个迁移的接缝。Electron 版里这层是 preload.js（contextBridge + ipcRenderer），
 * 这里换成 Tauri 的 invoke + event，但**方法名、参数、返回值形状一个都没变**，
 * 所以 index.html（87 KB）原样搬过来就能跑。
 *
 * 对应关系：
 *   ipcRenderer.invoke('tab:activate', id)  ->  invoke('tab_activate', { id })
 *   ipcRenderer.on('state:changed', fn)     ->  listen('state:changed', e => fn(e.payload))
 *
 * 依赖 tauri.conf.json 里的 withGlobalTauri: true —— 不需要打包器，
 * 直接用全局的 window.__TAURI__，和 Electron 版一样是一个 <script> 标签的事。
 */

(function () {
  const T = window.__TAURI__;
  if (!T) {
    console.error('[aihub] window.__TAURI__ 不存在：检查 tauri.conf.json 的 withGlobalTauri');
    return;
  }

  const invoke = T.core.invoke;
  const listen = T.event.listen;

  /**
   * 把 Tauri 的事件订阅包成 Electron 版那种「同步返回退订函数」的形状。
   * listen() 是异步的，但调用方（index.html）期望立刻拿到一个可调用的退订函数，
   * 所以这里先返回一个占位闭包，等 listen 真的就绪了再补上。
   */
  function on(channel, handler) {
    let unlisten = null;
    let cancelled = false;
    listen(channel, (event) => handler(event.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }

  /** send 语义：不关心返回值，失败只记日志，绝不让 UI 卡住 */
  function send(cmd, args) {
    invoke(cmd, args || {}).catch((err) => console.error(`[aihub] ${cmd} 失败:`, err));
  }

  window.api = {
    // ---- 状态 ----
    getState: () => invoke('app_get_state'),
    onState: (handler) => on('state:changed', handler),
    onTabStatus: (handler) => on('tab:status', handler),
    onOpenSettings: (handler) => on('ui:open-settings', handler),
    onLayout: (handler) => on('layout:changed', handler),

    // ---- 标签 ----
    activate: (id) => send('tab_activate', { id }),
    reload: (id) => send('tab_reload', { id }),
    reloadHard: (id) => send('tab_reload_hard', { id }),
    home: (id) => send('tab_home', { id }),
    devtools: (id) => send('tab_devtools', { id }),
    zoom: (delta, id) => send('tab_zoom', { delta, id: id || null }),

    // ---- 分屏布局 ----
    getLayout: () => invoke('layout_get'),
    setPanes: (ids) => invoke('layout_set_panes', { ids }),
    showSingle: (id) => send('layout_single', { id }),
    equalize: () => send('layout_equalize'),
    focusPane: (id) => send('pane_focus', { id }),
    dragDivider: (index, x) => send('layout_drag', { index, x }),
    endDrag: () => send('layout_drag_end'),

    // ---- 服务管理 ----
    addService: (input) => invoke('services_add', { input }),
    updateService: (input) => invoke('services_update', { input }),
    removeService: (id, wipe) => invoke('services_remove', { id, wipe: Boolean(wipe) }),
    setServiceHidden: (id, hidden) => invoke('services_set_hidden', { id, hidden: Boolean(hidden) }),
    reorderServices: (ids) => invoke('services_reorder', { ids }),

    // ---- 偏好 ----
    setPreload: (on) => invoke('config_set_preload', { on: Boolean(on) }),
    getPreload: () => invoke('config_get_preload'),
    setHibernate: (input) => invoke('config_set_hibernate', { input: input || {} }),
    setTheme: (theme) => invoke('config_set_theme', { theme: String(theme || '') }),
    setHotkey: (input) => invoke('config_set_hotkey', { input: input || {} }),
    getHotkey: () => invoke('config_get_hotkey'),

    // ---- 窗口 ----
    summonWindow: () => send('window_summon'),
    hideWindow: () => send('window_hide'),
    setOverlay: (open) => send('ui_overlay', { open: Boolean(open) }),
    openExternal: (url) => send('app_open_external', { url }),
    quit: () => send('app_quit'),

    // 原生右键菜单还没接 Tauri 的 menu API；返回 fallback 让前端自绘
    openSplitMenu: (point) => invoke('ui_split_menu', { point: point || {} }),
    openShellMenu: (point) => invoke('ui_shell_menu', { point: point || {} }),

    // ---- 登录迁移（尚未移植，会明确抛错而不是静默失败）----
    exportLogin: (password) => invoke('login_export', { password: String(password || '') }),
    importLogin: (options) => invoke('login_import', { options: options || {} }),

    // ---- 更新 ----
    checkUpdate: () => invoke('update_check'),
    installUpdate: () => invoke('update_install'),

    // ================= v4 新增 =================

    /** 功能 1：常驻置顶（Windows 上是 SetWindowPos(HWND_TOPMOST)，系统层面的顶） */
    setAlwaysOnTop: (on) => invoke('window_set_always_on_top', { on: Boolean(on) }),

    /** 功能 2：标签栏显示 / 收起。收起后站点视图铺满整窗。 */
    setTabBar: (visible) => invoke('window_set_tab_bar', { visible: Boolean(visible) }),

    /** 把服务放进第 index 个格子：index < 栏数 = 放进/互换那格，== 栏数 = 追加一格 */
    placePane: (id, index) => invoke('layout_place', { id, index }),
    /** 两个格子里的服务对调（位置大小不变，只换内容） */
    swapPanes: (a, b) => invoke('layout_swap', { a, b }),
    /** 把第 index 格从布局里去掉 */
    removePane: (index) => invoke('layout_remove_pane', { index }),

    /** 内置目录里还没加到标签栏上的站点（「添加 AI」面板用） */
    availableServices: () => invoke('services_available'),
    /** 把内置站点加到标签栏上 */
    addBuiltin: (id) => invoke('services_add_builtin', { id }),

    /** 功能 3：设置里显示版本号 */
    getVersion: () => invoke('app_version'),
    /** 功能 3：更新进度（downloading / closing） */
    onUpdateProgress: (handler) => on('update:progress', handler),
  };
})();
