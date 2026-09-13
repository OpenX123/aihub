'use strict';

/**
 * 开发自检脚本（不需要额外依赖，也不参与打包）。
 *
 *   PowerShell:  $env:AIHUB_SMOKE='1'; npm start
 *   cmd:         set AIHUB_SMOKE=1 && npm start
 *
 * 它会驱动一遍核心流程并逐项断言：默认标签、逐个切换、真实加载、拖拽分屏、
 * 多分屏、设置面板让位、增删服务、配置落盘，最后打印 SMOKE_PASS / SMOKE_FAIL。
 * 全部通过时进程退出码为 0，有失败项时为 1，方便接到 CI 里。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function runSmoke(ctx) {
  const TAB_BAR_HEIGHT = 44;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const checks = [];
  const consoleErrors = [];

  function check(name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : detail });
  }

  function attachConsoleCapture() {
    const win = ctx.getWindow();
    if (!win) return;
    win.webContents.on('console-message', (event) => {
      const level = event && event.level;
      const message = (event && event.message) || '';
      const isError = level === 'error' || level === 3;
      if (isError) consoleErrors.push(message);
      else if (level === 'warning' || level === 2) ctx.log('标签栏警告:', message);
    });
  }

  function viewInfo(id) {
    const view = ctx.views.get(id);
    if (!view || view.webContents.isDestroyed()) return { id, missing: true };
    return {
      id,
      attached: ctx.attached.has(id),
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      loading: view.webContents.isLoading(),
      crashed: view.webContents.isCrashed(),
      bounds: view.getBounds(),
    };
  }

  async function waitForIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = Array.from(ctx.views.values())
        .some((view) => !view.webContents.isDestroyed() && view.webContents.isLoading());
      if (!pending) return true;
      await wait(500);
    }
    return false;
  }

  /** 等某个 webContents 这次加载结束（导入会主动 reload 视图） */
  function waitForViewIdle(wc, timeoutMs) {
    if (!wc || wc.isDestroyed() || !wc.isLoading()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wc.off('did-stop-loading', finish);
        resolve(true);
      };
      const timer = setTimeout(finish, timeoutMs);
      wc.once('did-stop-loading', finish);
    });
  }

  function ensureVisible() {
    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) return null;
    // 窗口被最小化时客户区尺寸会退化，几何断言会失去意义，先恢复
    if (win.isMinimized()) win.restore();
    return win;
  }

  function contentSize() {
    const win = ensureVisible();
    return win ? win.getContentSize() : [0, 0];
  }

  /** 窗口被最小化或屏幕锁定时客户区会退化成 0x0，等它恢复（最多等 timeoutMs） */
  async function waitForSaneWindow(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [w, h] = contentSize();
      if (w >= 200 && h >= 150) return true;
      await wait(200);
    }
    return false;
  }

  async function main() {
    attachConsoleCapture();

    const win = ensureVisible();
    check('主窗口已创建', Boolean(win));
    if (!win) return finish();

    // 测试侧探针：观察分隔条上的指针事件流（不改动产品代码）
    await win.webContents.executeJavaScript(`(() => {
      window.__probe = { dividerDown: 0, move: 0, up: 0, buttons: [], xs: [] };
      window.addEventListener('pointermove', (event) => {
        window.__probe.move += 1;
        window.__probe.buttons.push(event.buttons);
        window.__probe.xs.push(Math.round(event.clientX));
      }, true);
      window.addEventListener('pointerup', () => { window.__probe.up += 1; }, true);
    })()`);

    const services = ctx.publicState().services.map((s) => s.id);
    const [width, height] = contentSize();
    check('标签栏高度预留正确', height - TAB_BAR_HEIGHT > 0, { width, height });

    // ---- 1. 启动状态（不假设是第一个标签：上次退出时的标签会被记住） ----
    const startId = ctx.config.activeId;
    check('启动时有激活标签', services.includes(startId), { startId, services });

    // 上次退出时的多栏布局会被恢复，先确认它的数据是自洽的，再收敛成单栏
    const restored = ctx.config.panes.slice();
    const restoredSum = ctx.config.weights.reduce((a, b) => a + b, 0);
    ctx.log('启动时恢复的分屏栏:', restored.join(', ') || '(无)');
    check('恢复的布局数据自洽', restored.length >= 1
      && restored.length === ctx.config.weights.length
      && Math.abs(restoredSum - 1) < 1e-6
      && restored.includes(startId), { panes: restored, weights: ctx.config.weights });
    check('恢复的布局视图数量正确',
      ctx.attached.size === restored.filter((id) => services.includes(id)).length, [...ctx.attached]);

    ctx.setPanes([startId]);
    await wait(250);
    check('收敛成单栏后只剩激活标签被挂载', ctx.attached.size === 1 && ctx.attached.has(startId), [...ctx.attached]);

    const firstView = ctx.views.get(startId);
    if (firstView) {
      const deadline = Date.now() + 30000;
      while (firstView.webContents.isLoading() && Date.now() < deadline) await wait(300);
      check('激活标签首屏加载完成', !firstView.webContents.isLoading());
      check('激活标签未崩溃', !firstView.webContents.isCrashed());
      check('激活标签拿到真实站点标题', Boolean(firstView.webContents.getTitle()), firstView.webContents.getTitle());
    }

    // ---- 2. 预加载：不点开也应该有视图、有标题、有图标 ----
    // 默认开启预加载，所以启动后所有服务的视图都应该已经建好（没挂载，只加载）
    const preloadDeadline = Date.now() + 20000;
    while (Date.now() < preloadDeadline && !services.every((id) => ctx.views.has(id))) await wait(300);
    check('预加载：没点开过的标签也已经建好视图', services.every((id) => ctx.views.has(id)),
      services.filter((id) => !ctx.views.has(id)));

    // 标签栏的图标：页面 DOM 里每个标签都应该有 img，且是内置 logo（data: 或 icons/ 路径）
    const tabIcons = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      document.querySelectorAll('#tabs .tab').forEach((el) => {
        const img = el.querySelector('img.fav');
        out[el.dataset.id] = img ? { src: img.getAttribute('src'), local: img.dataset.local } : null;
      });
      return JSON.stringify(out);
    })()`);
    const iconMap = JSON.parse(tabIcons);
    check('图标：每个标签都自带 logo（不用点也有）',
      services.every((id) => iconMap[id] && iconMap[id].src),
      Object.fromEntries(Object.entries(iconMap).map(([k, v]) => [k, v && v.src])));
    check('图标：内置站点用的是本地矢量图，不依赖网站 favicon',
      services.filter((id) => ctx.iconForService(ctx.config.services.find((s) => s.id === id))).every(
        (id) => iconMap[id] && iconMap[id].local === '1' && /^icons\//.test(iconMap[id].src || ''),
      ),
      Object.fromEntries(Object.entries(iconMap).map(([k, v]) => [k, v && [v.local, v.src]])));
    const iconRender = await win.webContents.executeJavaScript(`(async () => {
      const imgs = [...document.querySelectorAll('#tabs img.fav')];
      // 给本地图标一点加载时间（CSP 拦掉的话 naturalWidth 会一直是 0）
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && imgs.some((i) => !i.complete)) await new Promise((r) => setTimeout(r, 100));
      return JSON.stringify(imgs.map((i) => ({
        id: i.closest('.tab').dataset.id,
        src: i.getAttribute('src'),
        local: i.dataset.local,
        drawn: i.naturalWidth > 0 && i.naturalHeight > 0,
      })));
    })()`);
    const rendered = JSON.parse(iconRender);
    const localIcons = rendered.filter((i) => i.local === '1');
    check('图标：内置 logo 真的画出来了（不是空图 / 没被 CSP 拦掉）',
      localIcons.length >= services.length && localIcons.every((i) => i.drawn),
      rendered);
    const iconsOnDisk = (() => {
      const code = fs.readFileSync(path.join(__dirname, '..', 'icons.js'), 'utf8');
      const fake = {};
      new Function('window', code)(fake);
      const table = (fake.AIHUB_ICONS && fake.AIHUB_ICONS.files) || {};
      const variants = (fake.AIHUB_ICONS && fake.AIHUB_ICONS.variants) || {};
      const keys = Object.keys(table);
      const listed = keys.map((k) => table[k])
        .concat(Object.values(variants).flatMap((v) => Object.values(v)));
      const missing = listed.filter((rel) => !fs.existsSync(path.join(__dirname, '..', rel)));
      return { keys, missing: [...new Set(missing)] };
    })();
    check('图标：图标表（含深/浅色变体）里的文件都在（打包时不会漏）',
      iconsOnDisk.keys.length > 50 && iconsOnDisk.missing.length === 0,
      { 数量: iconsOnDisk.keys.length, 缺失: iconsOnDisk.missing });
    check('图标：默认站点都有对应的内置 logo 文件',
      ctx.DEFAULT_SERVICES.every((def) => {
        const tab = rendered.find((i) => i.id === def.id);
        return tab && tab.local === '1';
      }),
      ctx.DEFAULT_SERVICES.map((def) => `${def.id}:${(rendered.find((i) => i.id === def.id) || {}).src || '无'}`));

    // ---- 2b. 逐个切换标签，并校验挂载与布局 ----
    for (const id of services) {
      ctx.activate(id, { focus: false });
      await wait(200);
      const [w, h] = contentSize();
      check(`切换 ${id}：视图已创建`, ctx.views.has(id));
      check(`切换 ${id}：仅它被挂载`, ctx.attached.size === 1 && ctx.attached.has(id), [...ctx.attached]);
      const info = viewInfo(id);
      check(
        `切换 ${id}：铺满标签栏以下区域`,
        info.bounds
          && info.bounds.x === 0
          && info.bounds.y === TAB_BAR_HEIGHT
          && info.bounds.width === w
          && info.bounds.height === h - TAB_BAR_HEIGHT,
        { bounds: info.bounds, expected: { x: 0, y: TAB_BAR_HEIGHT, width: w, height: h - TAB_BAR_HEIGHT } },
      );
    }

    // ---- 2c. 关掉预加载后，新加的服务应该等点开才创建 ----
    const preloadBefore = ctx.config.preload;
    ctx.setPreload(false);
    await wait(200);
    const lazyExtra = ctx.addService({ name: 'Lazy Probe', url: 'https://example.org/lazy-probe' });
    await wait(900);
    check('关掉预加载后：新加的服务不会立刻创建视图',
      lazyExtra.ok && !ctx.views.has(lazyExtra.id), { id: lazyExtra.id, hasView: ctx.views.has(lazyExtra.id) });
    ctx.activate(lazyExtra.id, { focus: false });
    await wait(400);
    check('关掉预加载后：点开时才创建视图', ctx.views.has(lazyExtra.id));
    ctx.removeService(lazyExtra.id, true);
    await wait(800);
    ctx.setPreload(preloadBefore);
    await wait(1200);
    check('重新开启预加载后，所有服务的视图都在', services.every((id) => ctx.views.has(id)),
      services.filter((id) => !ctx.views.has(id)));
    ctx.activate(startId, { focus: false });
    await wait(300);

    // ---- 3. 等待所有服务真实加载完成 ----
    const idle = await waitForIdle(60000);
    const infos = services.map(viewInfo);
    check('所有服务都停止加载', idle, infos.map((i) => ({ id: i.id, loading: i.loading })));
    check('所有服务都拿到 http(s) 地址', infos.every((i) => /^https?:/.test(i.url || '')), infos.map((i) => ({ id: i.id, url: i.url })));
    check('没有渲染进程崩溃', infos.every((i) => !i.crashed), infos.filter((i) => i.crashed));
    check('没有停留在本地错误页', infos.every((i) => !String(i.url).startsWith('file://')), infos.filter((i) => String(i.url).startsWith('file://')));

    // ---- 4. 分屏：双栏 ----
    const leftId = services[0];
    const rightId = services[1];
    ctx.activate(leftId, { focus: false });
    // 窗口被最小化/锁屏时客户区会退化成 0x0，几何断言就没意义了；先等它恢复正常尺寸
    const sane = await waitForSaneWindow(6000);
    check('分屏：窗口尺寸正常（0x0 会让几何断言失去意义）', sane, contentSize());
    const two = ctx.setPanes([leftId, rightId]);
    await wait(300);
    check('分屏：设置为双栏成功', two.ok !== false, two.error);
    const [splitWidth, splitHeight] = contentSize();
    check('分屏：窗口处于正常尺寸', splitWidth >= 200 && splitHeight >= 150, [splitWidth, splitHeight]);
    check('分屏：两个视图同时挂载', ctx.attached.size === 2, [...ctx.attached]);
    let left = viewInfo(leftId).bounds || {};
    let right = viewInfo(rightId).bounds || {};
    let divider = ctx.getGeometry().dividers[0] || {};
    check('分屏：左栏从 x=0 起', left.x === 0, left);
    check('分屏：两栏宽度都为正值', left.width > 100 && right.width > 100, { left, right });
    check('分屏：两栏不重叠', right.x >= left.x + left.width, { left, right });
    check('分屏：右栏贴到窗口右边缘', right.x + right.width === splitWidth, { right, splitWidth });
    check('分屏：两栏高度一致且铺满', left.height === right.height && left.height === splitHeight - TAB_BAR_HEIGHT, { left, right, splitHeight });
    check('分屏：缝隙宽度等于 SPLIT_GAP', right.x - (left.x + left.width) === divider.width, { left, right, divider });
    check('分屏：分隔条落在两栏之间', ctx.getGeometry().dividers.length === 1
      && divider.x === left.x + left.width, ctx.getGeometry().dividers);

    // ---- 5. 拖拽分隔条 ----
    const dragWidth = splitWidth;
    ctx.dragDivider(0, Math.round(dragWidth * 0.72));
    await wait(150);
    left = viewInfo(leftId).bounds || {};
    right = viewInfo(rightId).bounds || {};
    check('拖拽：左栏跟着变宽', left.width > splitWidth * 0.6, { left, ratio: left.width / dragWidth });
    check('拖拽：右栏相应变窄', right.width < splitWidth * 0.35, { right });
    check('拖拽：比例已写入权重', Math.abs(ctx.config.weights[0] - 0.72) < 0.03, ctx.config.weights);
    check('拖拽：右边缘仍然贴合', right.x + right.width === splitWidth, { right, splitWidth });
    check('拖拽：分隔条跟着移动', Math.abs((ctx.getGeometry().dividers[0] || {}).x - Math.round(dragWidth * 0.72)) <= 1, ctx.getGeometry().dividers[0]);

    // 拖到最左边：左栏应被限制在最小宽度
    ctx.dragDivider(0, 0);
    await wait(150);
    left = viewInfo(leftId).bounds || {};
    const minPane = ctx.publicState().minPaneWidth;
    check('拖拽：左栏不会小于最小宽度', Math.abs(left.width - minPane) <= 2, { width: left.width, minPane });
    check('拖拽：权重不会变成 0 或负数', ctx.config.weights.every((w) => w > 0), ctx.config.weights);

    // 双击分隔条：相邻两栏回到等分
    ctx.equalizeDivider(0);
    await wait(150);
    left = viewInfo(leftId).bounds || {};
    right = viewInfo(rightId).bounds || {};
    check('双击分隔条：两栏宽度回到相等', Math.abs(left.width - right.width) <= 2, { left, right });

    // ---- 5b. 从页面事件拖拽（等价于 DOM 收到 pointerdown/move/up，验证分隔条 → IPC 的整条链路） ----
    // 合成鼠标事件只有在窗口真正位于前台、合成器正常出帧时才会被完整投递：
    // 窗口被遮挡时 Chromium 会把鼠标事件攒到下一次 BeginFrame，拖拽就像没反应。
    win.show();
    win.focus();
    for (let i = 0; i < 25 && !win.isFocused(); i += 1) await wait(100);
    check('交互测试前窗口已切到前台', win.isFocused(), win.isFocused());
    const visState = await win.webContents.executeJavaScript('document.visibilityState');
    check('标签栏页面处于可见状态（被遮挡时 Chromium 会攒住鼠标事件）', visState === 'visible', visState);
    await wait(300);

    const domGeo = ctx.getGeometry();
    const domDivider = domGeo.dividers[0] || { x: 0, width: 0 };
    const domX = Math.round(domDivider.x + domDivider.width / 2);
    const domY = TAB_BAR_HEIGHT + 120;
    const weightsBeforeDom = ctx.config.weights.slice();
    // 在分隔条元素上挂一个探针，确认鼠标按下确实落到了它身上
    await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#split-layer .divider');
      window.__probe.dividerCount = document.querySelectorAll('#split-layer .divider').length;
      if (el) {
        el.addEventListener('pointerdown', (event) => {
          window.__probe.dividerDown += 1;
          window.__probe.downButton = event.button;
          window.__probe.downX = Math.round(event.clientX);
        }, true);
      }
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: domX, y: domY, button: 'left', clickCount: 1 });
    await wait(80);
    for (let step = 1; step <= 6; step += 1) {
      // 合成 mouseMove 必须带上 button，否则 DOM 事件的 buttons 是 0，
      // 会被「按键已松开」的兜底逻辑当成拖拽结束（真实鼠标拖拽不会这样）。
      win.webContents.sendInputEvent({ type: 'mouseMove', x: domX + step * 18, y: domY, button: 'left' });
      await wait(35);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: domX + 108, y: domY, button: 'left', clickCount: 1 });
    await wait(250);
    const pointerProbe = await win.webContents.executeJavaScript('JSON.stringify(window.__probe)');
    check('页面拖拽：分隔条收到鼠标事件并改动了权重',
      Math.abs(ctx.config.weights[0] - weightsBeforeDom[0]) > 0.02,
      { before: weightsBeforeDom, after: ctx.config.weights, domX, domY, pointerProbe });
    check('页面拖拽：几何跟着更新',
      (ctx.getGeometry().dividers[0] || {}).x !== domDivider.x,
      { before: domDivider, after: ctx.getGeometry().dividers[0] });
    const domRight = viewInfo(rightId).bounds || {};
    check('页面拖拽：右栏仍然贴住窗口右边缘', domRight.x + domRight.width === splitWidth, { domRight, splitWidth });

    // ---- 6. 多分屏：三栏 ----
    const thirdId = services[2];
    const three = ctx.setPanes([leftId, rightId, thirdId]);
    await wait(400);
    check('三栏：设置成功', three.ok !== false, three.error);
    check('三栏：三个视图同时挂载', ctx.attached.size === 3, [...ctx.attached]);
    const geo = ctx.getGeometry();
    check('三栏：产生两条分隔条', geo.dividers.length === 2, geo.dividers);
    const bounds = geo.panes.map((p) => viewInfo(p.id).bounds || {});
    check('三栏：宽度都是正值', bounds.every((b) => b.width > 0), bounds);
    check('三栏：依次向右排列且不重叠', bounds.every((b, i) => i === 0 || b.x >= bounds[i - 1].x + bounds[i - 1].width), bounds);
    check('三栏：最后一栏贴到窗口右边缘', bounds[2].x + bounds[2].width === splitWidth, bounds);
    check('三栏：高度一致且铺满', bounds.every((b) => b.height === splitHeight - TAB_BAR_HEIGHT), bounds);
    check('三栏：权重和为 1', Math.abs(ctx.config.weights.reduce((a, b) => a + b, 0) - 1) < 1e-6, ctx.config.weights);
    check('三栏：新栏分到了合理宽度', Math.abs(ctx.config.weights[2] - 1 / 3) < 0.02, ctx.config.weights);

    // 拖第二条分隔条，只影响相邻两栏
    const beforeWeights = ctx.config.weights.slice();
    ctx.dragDivider(1, Math.round(splitWidth * 0.9));
    await wait(150);
    check('拖拽第二条分隔条：只改动相邻两栏', ctx.config.weights[0] === beforeWeights[0], { before: beforeWeights, after: ctx.config.weights });
    check('拖拽第二条分隔条：相邻两栏之和不变', Math.abs((ctx.config.weights[1] + ctx.config.weights[2]) - (beforeWeights[1] + beforeWeights[2])) < 1e-6, ctx.config.weights);

    // 超过上限时被拒绝（先加一个临时服务，保证服务数 > 最大栏数）
    const extra = ctx.addService({ name: 'Pane Extra', url: 'https://example.net/' });
    if (extra.ok) {
      const tooMany = ctx.setPanes([leftId, rightId, thirdId, services[3], extra.id]);
      check('超过最大栏数会被拒绝', tooMany.ok === false, tooMany);
      check('被拒绝后布局保持不变', ctx.attached.size === 3, [...ctx.attached]);
      check('被拒绝的服务没有进入布局', !ctx.config.panes.includes(extra.id), ctx.config.panes);
      ctx.removeService(extra.id, true); // 勾选清除数据：残留目录会在下次启动被清掉
      await wait(250);
      check('删除未参与分屏的服务不影响布局', ctx.config.panes.length === 3 && ctx.attached.size === 3, [...ctx.attached]);
    }

    // ---- 7. 标签点击语义 ----
    ctx.activate(rightId, { focus: false });
    await wait(120);
    check('点击已在布局中的标签：只聚焦，不改布局', ctx.config.activeId === rightId && ctx.config.panes.length === 3 && ctx.attached.size === 3, { active: ctx.config.activeId, panes: ctx.config.panes });
    ctx.activate(leftId, { focus: false });
    await wait(120);
    check('切换焦点栏：视图数量不变', ctx.attached.size === 3, [...ctx.attached]);

    // ---- 8. 权重持久化 ----
    await wait(700);
    const saved = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
    check('布局已写入配置文件', Array.isArray(saved.panes) && saved.panes.length === 3, saved.panes);
    check('权重已写入配置文件', Array.isArray(saved.weights) && saved.weights.length === 3, saved.weights);
    check('配置文件里没有遗留的 splitId 字段', saved.splitId === undefined, saved.splitId);

    // ---- 9. 设置面板：走真实链路（主进程通知页面 → 页面打开 → 页面回传让视图让位） ----
    win.webContents.send('ui:open-settings');
    await wait(500);
    check('打开设置面板：视图全部卸下', ctx.attached.size === 0, [...ctx.attached]);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(500);
    check('Esc 关闭设置面板：三栏全部恢复', ctx.attached.size === 3, [...ctx.attached]);

    // ---- 10. 回到单栏 ----
    const single = ctx.setPanes([thirdId]);
    await wait(200);
    check('切回单栏成功', single.ok !== false, single.error);
    check('单栏：只剩一个视图挂载', ctx.attached.size === 1 && ctx.attached.has(thirdId), [...ctx.attached]);
    // 布局是异步落地的（三个视图 + 七个预加载页面同时在跑），这里等它收敛再断言，
    // 否则偶尔会读到上一帧的三栏宽度
    const singleDeadline = Date.now() + 4000;
    while (Date.now() < singleDeadline) {
      const b = viewInfo(thirdId).bounds || {};
      if (b.x === 0 && b.width === splitWidth && b.height === splitHeight - TAB_BAR_HEIGHT) break;
      await wait(150);
    }
    check('单栏：视图铺满整个客户区', (() => {
      const b = viewInfo(thirdId).bounds || {};
      return b.x === 0 && b.width === splitWidth && b.height === splitHeight - TAB_BAR_HEIGHT;
    })(), { bounds: viewInfo(thirdId).bounds, splitWidth, splitHeight });
    check('单栏：没有分隔条了', ctx.getGeometry().dividers.length === 0, ctx.getGeometry().dividers);
    check('单栏：权重归一为 1', Math.abs(ctx.config.weights[0] - 1) < 1e-6, ctx.config.weights);

    // ---- 11. 增删服务 ----
    const added = ctx.addService({ name: 'Smoke Test', url: 'https://example.com/' });
    check('添加服务成功', added.ok, added.error);
    check('新服务已在状态中', ctx.publicState().services.some((s) => s.id === added.id));
    const dup = ctx.addService({ name: 'Duplicated', url: 'https://example.com' });
    check('重复网址被拒绝', dup.ok === false, dup.error);
    const bad = ctx.addService({ name: 'Bad', url: 'ftp://example.com' });
    check('非 http(s) 网址被拒绝', bad.ok === false, bad.error);

    if (added.ok) {
      ctx.activate(added.id, { focus: false });
      await wait(400);
      check('新服务视图已创建并挂载', ctx.views.has(added.id) && ctx.attached.has(added.id), [...ctx.attached]);
      const removed = ctx.removeService(added.id, true);
      check('删除服务成功', removed.ok !== false && !ctx.publicState().services.some((s) => s.id === added.id));
      check('删除后视图已销毁', !ctx.views.has(added.id));
      check('删除后自动切到其它标签', ctx.attached.size === 1, [...ctx.attached]);
      await wait(800); // 等配置防抖落盘（400ms 防抖 + 余量，免得状态漏到下次自检）
      const onDisk = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
      check('删除结果已写入配置文件', !onDisk.services.some((s) => s.id === added.id));
      check('当前标签也被持久化', onDisk.activeId === ctx.config.activeId, onDisk.activeId);
    }

    // 删掉一个正在分屏中的服务：布局要自动收敛
    const temp = ctx.addService({ name: 'Pane Temp', url: 'https://example.org/' });
    if (temp.ok) {
      ctx.setPanes([services[0], temp.id]);
      await wait(250);
      check('准备：临时服务已进入分屏', ctx.attached.size === 2 && ctx.config.panes.includes(temp.id), [...ctx.attached]);
      const res = ctx.removeService(temp.id, true);
      await wait(800); // 等配置落盘，避免临时服务漏到下次自检的配置里
      check('删除分屏中的服务：布局自动收敛', res.ok !== false
        && !ctx.config.panes.includes(temp.id)
        && ctx.config.panes.length === ctx.config.weights.length
        && Math.abs(ctx.config.weights.reduce((a, b) => a + b, 0) - 1) < 1e-6, { panes: ctx.config.panes, weights: ctx.config.weights });
      check('删除分屏中的服务：栏数与挂载视图数一致', ctx.attached.size === ctx.config.panes.length, [...ctx.attached]);
    }

    // ---- 12. 登录信息导出 / 导入（跨设备迁移） ----
    // 真实账号上的校验一律只读：清空 Cookie 这类破坏性步骤只在临时服务上做，
    // 免得自检把用户实际的登录态搞坏。
    const tmpDir = ctx.app.getPath('temp');
    const plainFile = path.join(tmpDir, 'aihub-login-smoke.json');
    const tempFile = path.join(tmpDir, 'aihub-login-smoke.temp.json');
    const encFile = path.join(tmpDir, 'aihub-login-smoke.enc.json');
    const badFile = path.join(tmpDir, 'aihub-login-smoke.bad.json');
    const alienFile = path.join(tmpDir, 'aihub-login-smoke.alien.json');
    const tmpFiles = [plainFile, tempFile, encFile, badFile, alienFile];
    for (const f of tmpFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    const exported = await ctx.exportLogin({ file: plainFile, password: '' });
    check('导出登录信息：成功', exported.ok === true, exported);
    check('导出登录信息：文件已生成', fs.existsSync(plainFile) && fs.statSync(plainFile).size > 200,
      fs.existsSync(plainFile) ? fs.statSync(plainFile).size : 'missing');

    let parsedExport = null;
    try {
      parsedExport = JSON.parse(fs.readFileSync(plainFile, 'utf8'));
    } catch (err) {
      parsedExport = null;
    }
    check('导出登录信息：格式标识正确',
      Boolean(parsedExport) && parsedExport.format === ctx.LOGIN_FORMAT && parsedExport.version === 1,
      parsedExport && { format: parsedExport.format, version: parsedExport.version });
    check('导出登录信息：覆盖了所有服务',
      Boolean(parsedExport) && parsedExport.services.length === ctx.publicState().services.length,
      parsedExport && parsedExport.services.map((s) => s.id));
    check('导出登录信息：真实账号的 Cookie 被导出',
      Boolean(parsedExport) && parsedExport.services.some((s) => s.cookies.length > 0),
      parsedExport && parsedExport.services.map((s) => ({ id: s.id, cookies: s.cookies.length })));
    check('导出登录信息：真实账号的本地存储被导出',
      Boolean(parsedExport) && parsedExport.services.some((s) => (s.origins || [])
        .some((o) => Object.keys(o.localStorage || {}).length > 0)),
      parsedExport && parsedExport.services.map((s) => ({ id: s.id, origins: (s.origins || []).map((o) => o.origin) })));

    // 12.1 对真实账号做一次导入：只做「不减少、不改变」的只读断言
    const realSvc = parsedExport && parsedExport.services.find((s) => s.cookies.length >= 2);
    if (realSvc) {
      const rses = ctx.sessionOf(realSvc.id);
      const before = await rses.cookies.get({});
      const probeCookie = realSvc.cookies.find((c) => !c.expirationDate) || realSvc.cookies[0];

      const dry = await ctx.importLogin({ file: plainFile, password: '', dryRun: true });
      check('导入预检：只汇总不写入', dry.ok === true && dry.dryRun === true
        && (await rses.cookies.get({})).length === before.length,
        { services: dry.services && dry.services.length, total: dry.services && dry.services.length });
      check('导入预检：汇总了每个服务的数量',
        Boolean(dry.services) && dry.services.every((s) => typeof s.cookies === 'number' && typeof s.storages === 'number'),
        dry.services);

      const imported = await ctx.importLogin({ file: plainFile, password: '' });
      check('导入登录信息：真实账号导入成功', imported.ok === true, imported.error);
      const after = await rses.cookies.get({});
      check('导入登录信息：真实账号没有丢 Cookie', after.length >= before.length,
        { before: before.length, after: after.length });
      const restored = after.find((c) => c.name === probeCookie.name && c.domain === probeCookie.domain);
      check('导入登录信息：真实 Cookie 的值与属性保持一致',
        Boolean(restored) && restored.value === probeCookie.value
        && Boolean(restored.httpOnly) === Boolean(probeCookie.httpOnly)
        && Boolean(restored.secure) === Boolean(probeCookie.secure),
        restored && {
          name: restored.name,
          valueMatch: restored.value === probeCookie.value,
          httpOnly: [restored.httpOnly, probeCookie.httpOnly],
          secure: [restored.secure, probeCookie.secure],
        });
      if (probeCookie.hostOnly) {
        check('导入登录信息：host-only 属性没有变成域 Cookie',
          restored && restored.hostOnly === true, restored && restored.hostOnly);
      }
    } else {
      check('导出登录信息：找到了可做校验的真实 Cookie', false,
        parsedExport && parsedExport.services.map((s) => ({ id: s.id, cookies: s.cookies.length })));
    }

    // 12.2 临时服务上的破坏性往返：自造一条 HttpOnly Cookie + 一条本地存储
    // 先创建同域名的诱饵服务：服务在配置里的顺序决定了「只按域名匹配」会写错到谁身上，
    // 诱饵排在前面才能复现出这个 bug（导入写到诱饵的分区里）。
    const decoy = ctx.addService({ name: 'Login Decoy', url: 'https://example.net/decoy' });
    check('准备：同一域名下先放一个诱饵服务', decoy.ok === true, decoy.error);
    const probe = ctx.addService({ name: 'Login Roundtrip', url: 'https://example.net/login' });
    check('准备：创建迁移往返用的临时服务', probe.ok === true, probe.error);
    if (probe.ok) {
      const pses = ctx.sessionOf(probe.id);
      ctx.activate(probe.id, { focus: false });
      await waitForIdle(8000);
      const pview = ctx.views.get(probe.id);
      const storageKey = 'aihub-smoke-key';
      const storageValue = 'smoke-value-42';
      const seeded = pview && !pview.webContents.isDestroyed()
        ? await pview.webContents.executeJavaScript(
          `(() => { localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(storageValue)}); return true; })()`,
          false,
        ).catch(() => false)
        : false;
      check('准备：临时服务里写入一条本地存储', seeded === true);
      await pses.cookies.set({
        url: 'https://example.net/',
        name: 'probe_auth',
        value: 'tok-12345',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      });
      check('准备：临时服务里写入一条 HttpOnly Cookie',
        (await pses.cookies.get({})).some((c) => c.name === 'probe_auth' && c.httpOnly));

      const tempExport = await ctx.exportLogin({ file: tempFile, password: '' });
      check('往返：导出临时服务', tempExport.ok === true, tempExport.error);
      const tempParsed = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
      const tempEntry = tempParsed.services.find((s) => s.id === probe.id);
      check('往返：导出的 Cookie 带着 httpOnly / secure 属性',
        Boolean(tempEntry) && tempEntry.cookies.some((c) => c.name === 'probe_auth' && c.httpOnly && c.secure && c.sameSite === 'lax'),
        tempEntry && tempEntry.cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })));
      check('往返：导出的本地存储带着刚写入的那条',
        Boolean(tempEntry) && tempEntry.origins.some((o) => o.localStorage && o.localStorage[storageKey] === storageValue),
        tempEntry && tempEntry.origins.map((o) => o.origin));

      // 破坏：清空 Cookie 并删掉本地存储
      await pses.clearStorageData({ storages: ['cookies'] });
      if (pview && !pview.webContents.isDestroyed()) {
        await pview.webContents.executeJavaScript(`localStorage.removeItem(${JSON.stringify(storageKey)})`, false).catch(() => {});
      }
      check('准备：临时服务的 Cookie 与本地存储已清空',
        (await pses.cookies.get({})).length === 0, (await pses.cookies.get({})).length);

      const back = await ctx.importLogin({ file: tempFile, password: '' });
      check('往返：导入成功', back.ok === true, back.error);
      const backCookies = await pses.cookies.get({});
      const backCookie = backCookies.find((c) => c.name === 'probe_auth');
      check('往返：Cookie 完全恢复（值 / httpOnly / secure / sameSite）',
        Boolean(backCookie) && backCookie.value === 'tok-12345'
        && backCookie.httpOnly === true && backCookie.secure === true && backCookie.sameSite === 'lax',
        backCookie && {
          value: backCookie.value, httpOnly: backCookie.httpOnly, secure: backCookie.secure, sameSite: backCookie.sameSite,
        });
      check('往返：host-only Cookie 没有变成域 Cookie',
        Boolean(backCookie) && backCookie.hostOnly === true, backCookie && backCookie.hostOnly);
      if (decoy.ok) {
        const decoyCookies = await ctx.sessionOf(decoy.id).cookies.get({});
        check('往返：同域名的另一个服务没有被误写',
          decoyCookies.length === 0, decoyCookies.map((c) => c.name));
        check('往返：文件里两个同域名服务的条目各自匹配到正确的服务',
          back.ok === true && back.services.some((s) => s.id === probe.id && s.cookies > 0)
          && !back.services.some((s) => s.id === decoy.id && s.cookies > 0),
          back.services);
      }

      // 导入会刷新视图，等它加载完再读本地存储
      const rtView = ctx.views.get(probe.id);
      if (rtView && !rtView.webContents.isDestroyed()) {
        await waitForViewIdle(rtView.webContents, 15000);
        const value = await rtView.webContents.executeJavaScript(
          `localStorage.getItem(${JSON.stringify(storageKey)})`, false,
        ).catch((err) => `ERR:${err.message}`);
        check('往返：本地存储被写回', value === storageValue, { value, expected: storageValue });
      } else {
        check('往返：本地存储被写回', false, '导入后视图不存在');
      }

      // 12.3 加密导出：错误密码不写入、正确密码能还原
      const enc = await ctx.exportLogin({ file: encFile, password: 'smoke-pass-123' });
      check('加密导出：成功', enc.ok === true && enc.encrypted === true, enc);
      const encText = fs.existsSync(encFile) ? fs.readFileSync(encFile, 'utf8') : '';
      check('加密导出：文件里没有明文 Cookie 名',
        encText.length > 0 && !/probe_auth|session-token|userToken|sessionKey/.test(encText)
        && !/"name"\s*:/.test(encText), encText.slice(0, 80));
      check('加密导出：标记为已加密', /"encrypted"\s*:\s*true/.test(encText), encText.slice(0, 120));

      await pses.clearStorageData({ storages: ['cookies'] });
      const wrong = await ctx.importLogin({ file: encFile, password: 'wrong-pass' });
      check('加密文件：密码错误时导入失败', wrong.ok === false && Boolean(wrong.error), wrong.error);
      check('加密文件：密码错误时没有写入任何 Cookie', (await pses.cookies.get({})).length === 0);
      const noPass = await ctx.importLogin({ file: encFile });
      check('加密文件：没填密码时提示需要密码', noPass.needsPassword === true, noPass.error);

      const okImport = await ctx.importLogin({ file: encFile, password: 'smoke-pass-123' });
      check('加密文件：密码正确时导入成功', okImport.ok === true && okImport.encrypted === true, okImport.error);
      const encTarget = okImport.services && okImport.services.find((s) => s.id === probe.id);
      const encCookies = await pses.cookies.get({});
      check('加密文件：Cookie 已恢复且数量与报告一致',
        Boolean(encTarget) && encTarget.cookies > 0 && encCookies.length === encTarget.cookies,
        encTarget && { reported: encTarget.cookies, actual: encCookies.length });

      // 12.4 从标签栏页面经 preload + IPC 真实调用一次（只是不弹系统文件框）
      const viaPage = await win.webContents.executeJavaScript(
        `window.api.importLogin({ file: ${JSON.stringify(tempFile)}, password: '', dryRun: true })`,
        true,
      ).catch((err) => ({ ok: false, error: err.message }));
      check('迁移链路：标签栏页面经 preload/IPC 调用成功',
        Boolean(viaPage) && viaPage.ok === true && viaPage.dryRun === true, viaPage && viaPage.error);

      const removedProbe = ctx.removeService(probe.id, true);
      check('清理：临时服务已删除（含分区数据）', removedProbe.ok !== false && !ctx.views.has(probe.id));
      if (decoy.ok) ctx.removeService(decoy.id, true);
      const pendingNow = (ctx.config.pendingWipe || []).slice();
      check('清理：勾选清除登录数据时登记了待清理分区',
        pendingNow.includes(probe.id), pendingNow);
      if (decoy.ok) {
        check('清理：诱饵服务也登记了待清理分区', pendingNow.includes(decoy.id), pendingNow);
      }
      // 运行期间 Chromium 占着分区文件（实测删不掉），所以目录删除安排在下次启动，
      // 这里验证标记确实落盘了，下一次启动才会真正删掉目录。
      await wait(800);
      const pendingOnDisk = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
      check('清理：待清理标记已落盘（下次启动删目录）',
        Array.isArray(pendingOnDisk.pendingWipe) && pendingOnDisk.pendingWipe.includes(probe.id),
        pendingOnDisk.pendingWipe);
    } else if (decoy.ok) {
      ctx.removeService(decoy.id, true);
    }

    // 12.5 坏文件：格式不匹配 / 服务对不上
    fs.writeFileSync(badFile, '{"format":"something-else","services":[]}', 'utf8');
    const badResult = await ctx.importLogin({ file: badFile });
    check('导入：格式不匹配的文件被拒绝', badResult.ok === false && /格式/.test(badResult.error || ''), badResult.error);

    // 12.6 改名成 Aihub 之前导出的文件（format 是旧值）必须继续能导入
    check('导入：仍认改名前的旧 format',
      Array.isArray(ctx.LOGIN_FORMAT_LEGACY) && ctx.LOGIN_FORMAT_LEGACY.includes('ai-multi-hub-login'),
      JSON.stringify(ctx.LOGIN_FORMAT_LEGACY));
    const legacyId = (parsedExport && parsedExport.services[0] && parsedExport.services[0].id) || '';
    fs.writeFileSync(alienFile, JSON.stringify({
      format: ctx.LOGIN_FORMAT_LEGACY[0],
      version: 1,
      // 空 Cookie 的空壳条目：能被正常处理，又不会改动真实登录态
      services: [{ id: legacyId, name: '旧版导出', url: '', cookies: [], origins: [] }],
    }), 'utf8');
    const legacyResult = await ctx.importLogin({ file: alienFile });
    check('导入：旧 format 的文件能正常处理（不再报格式不匹配）',
      legacyId !== '' && legacyResult.ok === true, legacyResult.error || 'ok');
    fs.writeFileSync(alienFile, JSON.stringify({
      format: ctx.LOGIN_FORMAT,
      version: 1,
      services: [{ id: 'nope', name: '不存在的服务', url: 'https://not-here.example/', cookies: [], origins: [] }],
    }), 'utf8');
    const alienResult = await ctx.importLogin({ file: alienFile });
    check('导入：对不上的服务被跳过并给出提示',
      alienResult.ok === false && (alienResult.unmatched || []).length === 1, alienResult);

    // 12.6 导出不应该为了读登录态而把服务的页面都建起来（否则内存里会挂一堆站点）
    //      这个性质要在「关掉预加载」的前提下验证，否则新服务本来就该有视图
    const preloadWasOn = ctx.config.preload;
    ctx.setPreload(false);
    await wait(300);
    const stranger = ctx.addService({ name: 'Login Idle', url: 'https://example.net/idle' });
    if (stranger.ok) {
      check('准备：关掉预加载后新服务没有视图', !ctx.views.has(stranger.id));
      await ctx.exportLogin({ file: tempFile, password: '' });
      check('导出不会为了读登录态而创建视图（未打开的服务不常驻内存）',
        !ctx.views.has(stranger.id), [...ctx.views.keys()]);
      ctx.removeService(stranger.id, true);
      await wait(800); // 同样等落盘：漏到下次自检会让配置多出一个服务
      const afterDisk = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8'));
      check('自检结束不留临时服务',
        !afterDisk.services.some((s) => s.id === stranger.id || s.id === probe.id),
        afterDisk.services.map((s) => s.id));
    }
    ctx.setPreload(preloadWasOn);
    await wait(1200);
    check('复原：预加载开关回到自检开始时的状态', ctx.config.preload === preloadWasOn, ctx.config.preload);

    for (const f of tmpFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // ---- 13. session 隔离与 UA ----
    check('应用名已改成 Aihub（数据目录跟着走）',
      /Aihub/i.test(ctx.app.getName()) && /Aihub/i.test(ctx.publicState().userData || ''),
      ctx.app.getName() + ' / ' + ctx.publicState().userData);

    // 13.1 数据目录迁移：老目录 %APPDATA%\AI Multi Hub 里的登录态和配置会被搬到新名字下
    //（用临时目录模拟，不碰真实数据）
    {
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-migrate-'));
      const oldDir = path.join(sandboxRoot, 'AI Multi Hub');
      const newDir = path.join(sandboxRoot, 'Aihub');
      fs.mkdirSync(path.join(oldDir, 'Partitions', 'claude'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'config.json'), '{"services":[]}', 'utf8');
      fs.writeFileSync(path.join(oldDir, 'Partitions', 'claude', 'Cookies'), 'x', 'utf8');

      // 关键回归：Electron 会在主进程脚本之前就把新目录建好（只有缓存壳子），
      // 所以「新目录已存在」不能当成「已经迁移过」。这里就照这个场景造一个空壳。
      fs.mkdirSync(path.join(newDir, 'Cache'), { recursive: true });
      fs.writeFileSync(path.join(newDir, 'Cache', 'junk'), 'cache', 'utf8');

      const migrated = ctx.migrateLegacyUserData({ appData: sandboxRoot, current: newDir, legacy: oldDir });
      check('改名后自动迁移旧数据目录（新目录已被 Electron 提前建好也要搬）',
        migrated.migrated === true
        && fs.existsSync(path.join(newDir, 'config.json'))
        && fs.existsSync(path.join(newDir, 'Partitions', 'claude', 'Cookies')),
        { reason: migrated.reason, moved: migrated.moved, copied: migrated.copied });
      check('迁移后旧目录里不再留用户数据（避免下次又搬一遍）',
        !fs.existsSync(path.join(oldDir, 'config.json'))
        && !fs.existsSync(path.join(oldDir, 'Partitions')),
        fs.existsSync(oldDir) ? fs.readdirSync(oldDir).join(',') : '(旧目录已不存在)');

      // 再跑一次必须是空操作
      const again = ctx.migrateLegacyUserData({ appData: sandboxRoot, current: newDir, legacy: oldDir });
      check('已迁移过之后再启动是空操作', again.migrated === false, again.reason);

      // 新目录里已经有用户数据时不能覆盖（否则第二次启动会把新数据搬没了）
      const sandbox2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-migrate2-'));
      const old2 = path.join(sandbox2, 'AI Multi Hub');
      const new2 = path.join(sandbox2, 'Aihub');
      fs.mkdirSync(old2, { recursive: true });
      fs.mkdirSync(new2, { recursive: true });
      fs.writeFileSync(path.join(old2, 'config.json'), '{"from":"old"}', 'utf8');
      fs.writeFileSync(path.join(new2, 'config.json'), '{"from":"new"}', 'utf8');
      const conflict = ctx.migrateLegacyUserData({ appData: sandbox2, current: new2, legacy: old2 });
      check('新目录已有用户数据时不覆盖、不迁移',
        conflict.migrated === false && /已有用户数据/.test(conflict.reason)
        && JSON.parse(fs.readFileSync(path.join(new2, 'config.json'), 'utf8')).from === 'new',
        conflict.reason);

      for (const dir of [sandboxRoot, sandbox2]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
      }
    }

    const partitions = new Set(services.map((id) => `persist:${id}`));
    check('每个服务使用独立 partition', partitions.size === services.length);
    const serviceUa = ctx.views.get(leftId) ? ctx.views.get(leftId).webContents.session.getUserAgent() : '';
    check('服务视图 UA 已去掉 Electron 标记', serviceUa && !/Electron[\/ ]/i.test(serviceUa), serviceUa);
    check('服务视图 UA 已去掉应用自身标记', serviceUa && !/Aihub|aihub|aimultihub|ai-multi-hub/i.test(serviceUa), serviceUa);

    // ---- 13a. 品牌素材 ----
    const shell = ctx.getWindow();
    const brandShots = await shell.webContents.executeJavaScript(`(() => {
      const marks = [...document.querySelectorAll('img.brand-mark')];
      return {
        count: marks.length,
        loaded: marks.filter((m) => m.complete && m.naturalWidth > 0).length,
        sizes: marks.map((m) => m.getAttribute('width') + 'x' + m.getAttribute('height')),
        title: document.title,
      };
    })()`);
    check('品牌：页面标题是 Aihub', brandShots.title === 'Aihub', brandShots.title);
    check('品牌：图形素材都真的加载出来了（没有被 CSP 或路径挡住）',
      brandShots.count >= 2 && brandShots.loaded === brandShots.count,
      brandShots);


    // ---- 13b. 内置站点列表升级（扣子 -> 豆包，补 Kimi / GLM / Gemini） ----
    const oldStyle = [
      { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', color: '#4d6bfe', custom: false },
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f', custom: false },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/', color: '#d97757', custom: false },
      { id: 'coze', name: 'Coze', url: 'https://www.coze.cn/', color: '#7c5cff', custom: false },
      { id: 'mine', name: '我的站点', url: 'https://example.org/chat', color: '#f0a020', custom: true },
    ];
    const migratedOld = ctx.migrateServices(oldStyle, 1);
    const migratedIds = migratedOld.services.map((s) => s.id);
    check('升级：内置的扣子被换成豆包', !migratedIds.includes('coze') && migratedIds.includes('doubao'), migratedIds);
    check('升级：补齐 Kimi / 智谱 GLM / Gemini',
      ['kimi', 'glm', 'gemini'].every((id) => migratedIds.includes(id)), migratedIds);
    check('升级：用户自己加的服务原样保留（排在后面）',
      migratedIds[migratedIds.length - 1] === 'mine', migratedIds);
    check('升级：老配置里的服务被补上内置 logo',
      migratedOld.services.filter((s) => s.id !== 'mine').every((s) => s.icon), migratedOld.services.map((s) => `${s.id}:${s.icon || '无'}`));
    check('升级：内置站点排在用户自定义服务前面',
      migratedIds.indexOf('mine') > migratedIds.indexOf('gemini'), migratedIds);
    const migratedAgain = ctx.migrateServices(migratedOld.services, ctx.SERVICES_VERSION);
    check('升级：已是最新版时不会重复改动',
      migratedAgain.notes.length === 0 && migratedAgain.services.length === migratedOld.services.length,
      { notes: migratedAgain.notes, count: migratedAgain.services.length });
    const keepCoze = ctx.migrateServices([
      { id: 'coze', name: 'Coze 改过地址', url: 'https://my-coze.example/', color: '#123456', custom: false },
      { id: 'coze-x', name: 'Coze', url: 'https://www.coze.cn/', color: '#654321', custom: true },
    ], 1);
    check('升级：用户改过地址或用自建的 coze 都不会被删',
      keepCoze.services.some((s) => s.id === 'coze') && keepCoze.services.some((s) => s.id === 'coze-x'),
      keepCoze.services.map((s) => s.id));
    check('升级：当前配置已经是最新版', ctx.config.servicesVersion === ctx.SERVICES_VERSION, ctx.config.servicesVersion);

    // 常见站点的图标识别（用户自己加服务时也能自动配上 logo）
    const iconExpect = {
      'https://chat.deepseek.com/': 'deepseek',
      'https://chatgpt.com/': 'chatgpt',
      'https://claude.ai/': 'claude',
      'https://www.doubao.com/chat/': 'doubao',
      'https://www.kimi.com/': 'kimi',
      'https://kimi.moonshot.cn/': 'kimi',
      'https://chatglm.cn/': 'chatglm',
      'https://gemini.google.com/app': 'gemini',
      'https://grok.com/': 'grok',
    };
    const wrong = Object.entries(iconExpect)
      .filter(([url, key]) => ctx.iconForService({ id: 'x', name: 'x', url }) !== key)
      .map(([url, key]) => `${url} => ${ctx.iconForService({ id: 'x', name: 'x', url }) || '空'}（应为 ${key}）`);
    check('图标识别：常见站点都能认出内置 logo', wrong.length === 0, wrong);
    check('图标识别：陌生站点返回空（渲染层退回彩色圆点）',
      ctx.iconForService({ id: 'x', name: 'x', url: 'https://example.org/' }) === '');

    // ---- 13c. 标签栏观感：选中不要底色、不要侧边色条；logo 不垫白底 ----
    const tabStyle = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const tabs = [...document.querySelectorAll('#tabs .tab')];
      const active = tabs.find((t) => t.classList.contains('active'));
      const pane = tabs.find((t) => t.classList.contains('pane'));
      const img = active && active.querySelector('img.fav');
      const cs = active ? getComputedStyle(active) : null;
      // 选中态的底色也可能来自「鼠标正好压在这个标签上」的 :hover 规则
      //（自检窗口是真窗口，指针位置不由我们控制），所以同时把样式表里那条规则读出来。
      let hoverBg = '';
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = [...sheet.cssRules]; } catch { continue; }
        for (const rule of rules) {
          if (rule.selectorText === '.tab:hover') hoverBg = rule.style.backgroundColor || rule.style.background;
        }
      }
      return {
        hasActive: Boolean(active),
        activeBg: cs ? cs.backgroundColor : '',
        activeShadow: cs ? cs.boxShadow : '',
        paneShadow: pane ? getComputedStyle(pane).boxShadow : '',
        imgBg: img ? getComputedStyle(img).backgroundColor : '',
        imgPad: img ? getComputedStyle(img).paddingTop : '',
        fontWeight: cs ? cs.fontWeight : '',
        hoverBg,
      };
    })())`));
    // 期望：选中态自己不设底色；量到的非透明值必须就是 :hover 那一份，而且透明度极低
    const activeBgIsClear = /rgba?\(0, 0, 0, 0\)|transparent/.test(tabStyle.activeBg);
    const hoverTint = (() => {
      const m = /rgba?\([^)]*?,\s*(0?\.\d+)\)/.exec(tabStyle.activeBg);
      return m ? Number(m[1]) : 1;
    })();
    check('选中标签：没有背景色（自带底色为透明；指针恰好悬停时也只允许那一份极淡的 hover 底色）',
      activeBgIsClear || (tabStyle.hoverBg && hoverTint <= 0.06),
      { activeBg: tabStyle.activeBg, hoverRule: tabStyle.hoverBg, alpha: hoverTint });
    check('选中标签：没有侧边色条', tabStyle.activeShadow === 'none', tabStyle);
    check('分屏标签：也没有侧边色条', tabStyle.paneShadow === 'none', tabStyle);
    check('标签 logo：没有垫白底', /rgba?\(0, 0, 0, 0\)|transparent/.test(tabStyle.imgBg) && tabStyle.imgPad === '0px', tabStyle);
    check('选中标签：靠字重和亮度区分', Number(tabStyle.fontWeight) >= 600, tabStyle);

    // ---- 13d. 外观主题：深色 / 浅色 / 跟随系统 ----
    const themeBefore = ctx.config.theme;
    const darkIconIn = async () => JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const out = {};
      document.querySelectorAll('#tabs .tab').forEach((el) => {
        const img = el.querySelector('img.fav');
        out[el.dataset.id] = img ? img.getAttribute('src') : '';
      });
      return { icons: out, dark: window.matchMedia('(prefers-color-scheme: dark)').matches };
    })())`));

    ctx.setTheme('dark');
    await wait(250);
    const darkState = await darkIconIn();
    check('主题：切到深色后页面自己也认为是深色', darkState.dark === true, darkState);
    check('主题：深色下黑 logo 用反白变体',
      darkState.icons.kimi === 'icons/dark/kimi.svg', darkState.icons);

    ctx.setTheme('light');
    await wait(250);
    const lightState = await darkIconIn();
    check('主题：切到浅色后页面跟着变浅', lightState.dark === false, lightState);
    check('主题：浅色下黑 logo 不再用反白变体（用原图）',
      lightState.icons.kimi === 'icons/kimi.svg', lightState.icons);
    check('主题：浅色下页面底色真的变亮了',
      await win.webContents.executeJavaScript(
        `getComputedStyle(document.body).backgroundColor !== 'rgb(18, 20, 26)'`,
      ));
    check('主题：浅色下标签栏底色也跟着变',
      await win.webContents.executeJavaScript(
        `getComputedStyle(document.getElementById('bar')).backgroundColor !== 'rgb(27, 30, 38)'`,
      ));

    ctx.setTheme('system');
    await wait(250);
    check('主题：跟随系统会回到系统值', ctx.config.theme === 'system', ctx.config.theme);
    check('主题：恢复成自检开始时的设置', ctx.setTheme(themeBefore).ok && ctx.config.theme === themeBefore);
    await wait(200);

    // ---- 13e. 分栏菜单：原生菜单，浮在服务页面之上，且完全不动布局 ----
    ctx.setPanes([startId]);
    await wait(300);
    const menuId = ctx.attached.has(startId) ? startId : [...ctx.attached][0];
    const boundsOf = () => {
      const v = ctx.views.get(menuId);
      return v && !v.webContents.isDestroyed() ? v.getBounds() : null;
    };
    const restBounds = boundsOf();
    check('分栏菜单：准备状态是小窗，视图贴着标签栏',
      restBounds && restBounds.y === TAB_BAR_HEIGHT, restBounds);

    const template = ctx.buildSplitMenuTemplate();
    const labels = template.map((item) => item.label).filter(Boolean);
    const rows = template.filter((item) => item.type === 'checkbox');
    const rowOf = (name) => rows.find((r) => r.label.startsWith(name));
    check('分栏菜单：每个服务一行勾选项', rows.length === ctx.config.services.length, rows.map((r) => r.label));
    check('分栏菜单：勾选状态跟当前布局一致',
      ctx.config.services.every((svc) => {
        const row = rowOf(svc.name);
        return row && row.checked === ctx.config.panes.includes(svc.id);
      }),
      { rows: rows.map((r) => `${r.label}=${r.checked}`), panes: ctx.config.panes });
    check('分栏菜单：已在布局里的服务在文字里标出第几栏（勾选标记可能被 logo 顶掉）',
      ctx.config.panes.every((id, i) => {
        const svc = ctx.config.services.find((s) => s.id === id);
        const row = rowOf(svc.name);
        return row && row.label.includes(`第 ${i + 1} 栏`);
      }),
      rows.map((r) => r.label));
    check('分栏菜单：每行都带 32×32 的 logo 图标（不是颜色圆点）',
      rows.every((r) => r.icon && !r.icon.isEmpty()
        && r.icon.getSize().width === 32 && r.icon.getSize().height === 32),
      rows.map((r) => `${r.label}:${r.icon ? r.icon.getSize().width + 'x' + r.icon.getSize().height : '没图'}`));
    check('分栏菜单：菜单里没有任何颜色字段',
      template.every((item) => item.color === undefined && item.backgroundColor === undefined), Object.keys(template[0]));
    check('分栏菜单：有均分和只显示当前标签', 
      labels.some((l) => l.includes('均分')) && labels.some((l) => l.includes('只显示当前标签')), labels);
    // 关键：栏数满时不能再加新栏。setPanes 之后布局是异步落定的，先等一拍再读菜单模板，
    // 否则量到的还是上一次的栏数（这条曾经偶发失败）。
    {
      const ids4 = ctx.config.services.map((s) => s.id).slice(0, 4);
      if (ids4.length < 4) {
        check('分栏菜单：栏数满时不再让加新栏', true, '服务不足 4 个，跳过');
      } else {
        ctx.setPanes(ids4);
        await wait(300);
        const rows4 = ctx.buildSplitMenuTemplate().filter((i) => i.type === 'checkbox');
        const checked = rows4.filter((r) => r.checked).length;
        const extraEnabled = rows4.filter((r) => !r.checked && r.enabled).length;
        check('分栏菜单：栏数满时不再让加新栏',
          checked === 4 && extraEnabled === 0,
          { checked, extraEnabled, panes: ctx.config.panes.length });
        ctx.setPanes([startId]);
        await wait(200);
      }
    }

    // 关键回归：弹菜单不能挤压页面（早期补丁是把视图整体往下推，很难看）
    ctx.setPanes([menuId]);
    await wait(300);
    const beforeMenu = boundsOf();
    const popupsBefore = ctx.getMenuPopupCount();
    const popped = ctx.popupSplitMenu({ x: 10, y: 10 });
    await wait(400);
    const afterMenu = boundsOf();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    check('分栏菜单：弹出菜单不影响布局（不再挤压页面）',
      popped.ok && beforeMenu && afterMenu && JSON.stringify(afterMenu) === JSON.stringify(beforeMenu),
      { before: beforeMenu, after: afterMenu });
    check('分栏菜单：主进程真的弹出了菜单', ctx.getMenuPopupCount() === popupsBefore + 1,
      { before: popupsBefore, after: ctx.getMenuPopupCount() });
    // 原生菜单是独立弹出窗口，页面里不该再有任何自绘菜单
    check('分栏菜单：页面里已经没有自绘菜单（改走原生菜单）',
      await win.webContents.executeJavaScript(
        `document.getElementById('split-menu') === null && typeof window.api.openSplitMenu === 'function'`,
      ));
    await wait(300);
    const popupsBeforeClick = ctx.getMenuPopupCount();
    await win.webContents.executeJavaScript(`document.getElementById('btn-split').click()`);
    await wait(600);
    check('分栏菜单：窗口页面里点 ⇔ 真的会弹出原生菜单（且不动布局）',
      ctx.getMenuPopupCount() === popupsBeforeClick + 1
      && JSON.stringify(boundsOf()) === JSON.stringify(beforeMenu),
      { popups: ctx.getMenuPopupCount(), bounds: boundsOf() });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(400);
    check('分栏菜单：支持的主题只有三种，非法值会被拒',
      ctx.THEMES.join(',') === 'dark,light,system' && ctx.setTheme('neon').ok === false,
      ctx.setTheme('neon'));

    // ---- 13f. 右键菜单：服务和应用自己这一层都要有（Electron 默认一个都不给） ----
    const shellMenu = ctx.buildShellMenuTemplate();
    const shellLabels = shellMenu.map((i) => i.label).filter(Boolean);
    check('右键：应用自身的菜单有刷新 / 设置 / 开发者工具',
      shellLabels.some((l) => l.includes('刷新')) && shellLabels.some((l) => l.includes('设置'))
      && shellLabels.some((l) => l.includes('开发者工具')), shellLabels);
    check('右键：应用菜单里带的预加载开关跟当前配置一致',
      shellMenu.some((i) => i.type === 'checkbox' && i.checked === Boolean(ctx.config.preload)), shellLabels);
    check('右键：服务视图挂上了 context-menu（否则网页里右键像坏的）', (() => {
      const target = ctx.views.get([...ctx.attached][0]);
      if (!target) return false;
      return target.webContents.listenerCount('context-menu') > 0;
    })(), [...ctx.attached]);
    const shellMenuResult = ctx.popupShellMenu({ x: 20, y: 20 });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(200);
    check('右键：主进程真的弹出了应用菜单', shellMenuResult.ok === true, shellMenuResult);
    check('右键：窗口页面暴露了 openShellMenu，且页面空白处会走它',
      await win.webContents.executeJavaScript(
        `typeof window.api.openShellMenu === 'function'
         && typeof window.api.openSplitMenu === 'function'`,
      ));

    // ---- 13g. 动效：令牌统一、只动 transform/opacity、尊重减少动态效果 ----
    const motion = await win.webContents.executeJavaScript(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const val = (k) => cs.getPropertyValue(k).trim();
      const sheet = [...document.styleSheets].map((s) => {
        try { return [...s.cssRules].map((r) => r.cssText).join('\\n'); } catch { return ''; }
      }).join('\\n');
      const panel = document.querySelector('.panel');
      const thumb = document.getElementById('theme-thumb');
      const toast = document.getElementById('toast');
      const pcs = panel ? getComputedStyle(panel) : null;
      return {
        dur: [val('--dur-1'), val('--dur-2'), val('--dur-3'), val('--dur-exit')],
        eases: [val('--ease-out'), val('--ease-in-out'), val('--ease-drawer')],
        transitionAll: /transition:\\s*all/.test(sheet),
        reducedBlock: sheet.includes('prefers-reduced-motion: reduce'),
        hoverGated: sheet.includes('(hover: hover) and (pointer: fine)'),
        widthAnim: /transition:[^;]*\\bwidth\\b/.test(sheet),
        panelTransitions: pcs ? pcs.transitionProperty : '',
        panelWillChange: pcs ? pcs.willChange : '',
        thumbInline: thumb ? thumb.style.transform : '',
        thumbWidthProp: thumb ? thumb.style.width || getComputedStyle(thumb).width : '',
        toastLive: toast ? toast.getAttribute('aria-live') : '',
        colorInputs: document.querySelectorAll('input[type="color"]').length,
      };
    })()`);
    check('动效：时长令牌齐全且都在 300ms 以内',
      motion.dur.length === 4 && motion.dur.every((d) => /^\d+ms$/.test(d) && parseInt(d, 10) <= 300),
      motion.dur);
    // 浏览器会把 .23 规范化成 0.23，两种写法都算数
    const curve = (v, head) => new RegExp(`^cubic-bezier\\(0?\\${head}`).test(v);
    check('动效：缓动曲线用的是规范表里的三条（不是自己编的）',
      curve(motion.eases[0], '.23') && curve(motion.eases[1], '.77') && curve(motion.eases[2], '.32'),
      motion.eases);
    check('动效：没有 transition: all（会连带动画布局属性）', motion.transitionAll === false);
    check('动效：没有任何 transition 去动 width（只动 transform/opacity）', motion.widthAnim === false);
    check('动效：面板只过渡 transform 和 opacity，并声明了 will-change',
      /transform/.test(motion.panelTransitions) && /opacity/.test(motion.panelTransitions)
      && !/width|height|box-shadow/.test(motion.panelTransitions)
      && /transform|opacity/.test(motion.panelWillChange), motion.panelTransitions);
    check('动效：主题滑块是等宽 + 平移定位（不做 width 动画）',
      /^translateX\(\d+%\)$/.test(motion.thumbInline) && !/^0px$/.test(motion.thumbWidthProp),
      { inline: motion.thumbInline, width: motion.thumbWidthProp });
    check('动效：有 prefers-reduced-motion 分支', motion.reducedBlock === true);
    check('动效：悬浮动效被 (hover:hover) 媒体查询保护', motion.hoverGated === true);
    check('动效：提示条用 aria-live 播报，不抢焦点', motion.toastLive === 'polite', motion.toastLive);
    check('设置：不再有颜色选择器（色板去掉了）', motion.colorInputs === 0, motion.colorInputs);

    // 面板打开 / 关闭要走动画类，而不是直接把 hidden 一翻。
    // 注意 setOverlay(true) 在「已经开着」时是空操作：列表就不会重新进场，
    // 所以这里先把面板关掉并等淡出结束，保证测的是真正的「打开」那一次。
    const openAnim = await win.webContents.executeJavaScript(`(async () => {
      const overlay = document.getElementById('overlay');
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!overlay.hidden) {
        document.getElementById('btn-close').click();
        await nap(300);
      }
      const wasHidden = overlay.hidden;
      document.getElementById('btn-settings').click();
      await nap(80);
      const opened = { hidden: overlay.hidden, open: overlay.classList.contains('open') };
      const listEnter = document.querySelectorAll('#svc-list.enter > .svc-row').length;
      return { wasHidden, opened, listEnter };
    })()`);
    check('动效：设置面板是带 open 类淡入的（不是硬切）',
      openAnim.wasHidden === true && openAnim.opened.open === true && openAnim.opened.hidden === false,
      openAnim);
    check('动效：设置列表整体做了错开进场', openAnim.listEnter > 0, openAnim.listEnter);
    // 等面板动画落定再量滑块：动画进行中量到的是被缩放过的尺寸，会误判
    await wait(400);
    const thumbBox = await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('#theme-seg .seg-btn')];
      const index = Math.max(0, btns.findIndex((b) => b.getAttribute('aria-checked') === 'true'));
      const thumb = document.getElementById('theme-thumb');
      const m = new DOMMatrixReadOnly(getComputedStyle(thumb).transform);
      // offsetWidth 不受父级 transform 影响，用它算期望位移
      return { index, tx: Math.round(m.m41), width: thumb.offsetWidth };
    })()`);
    check('动效：滑块精确停在当前主题那一格（用平移，不用宽度）',
      thumbBox.width > 20 && Math.abs(thumbBox.tx - thumbBox.index * thumbBox.width) <= 1,
      thumbBox);
    await wait(400);

    // ---- 13h. 设置面板：纯白背景 + 无颜色列 ----
    // 这一块看的是浅色主题，所以先显式切过去，测完恢复
    const themeBeforePanel = ctx.config.theme;
    ctx.setTheme('light');
    await wait(300);
    const panelLook = await win.webContents.executeJavaScript(`(() => {
      const r = (el) => (el ? getComputedStyle(el) : null);
      const panel = r(document.querySelector('.panel'));
      const row = r(document.querySelector('.svc-row'));
      const input = r(document.getElementById('add-name'));
      const cols = r(document.querySelector('.svc-row'));
      return {
        panelBg: panel && panel.backgroundColor,
        rowBg: row && row.backgroundColor,
        inputBg: input && input.backgroundColor,
        rowCols: cols && cols.gridTemplateColumns,
        colorInputs: document.querySelectorAll('input[type="color"]').length,
        scrim: r(document.getElementById('overlay')).backgroundColor,
      };
    })()`);
    const white = (c) => c === 'rgb(255, 255, 255)';
    check('设置：浅色下面板是纯白不透明', white(panelLook.panelBg), panelLook.panelBg);
    check('设置：浅色下服务卡片也是纯白', white(panelLook.rowBg), panelLook.rowBg);
    check('设置：浅色下输入框也是纯白', white(panelLook.inputBg), panelLook.inputBg);
    check('设置：服务行只有三列（logo / 名称 / 网址）', panelLook.rowCols.split(' ').length === 4, panelLook.rowCols);
    check('设置：面板背后有遮罩，不是全透明', /rgba?\(/.test(panelLook.scrim), panelLook.scrim);
    ctx.setTheme(themeBeforePanel);
    await wait(250);

    // 关闭设置面板也要走动画类，然后再把视图还给主进程
    // （click 的处理是同步的，所以点完立刻读类名，不受淡出时长影响）
    const closeAnim = await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btn-close').click();
      const overlay = document.getElementById('overlay');
      return { closing: overlay.classList.contains('closing'), open: overlay.classList.contains('open') };
    })()`);
    check('动效：关闭时先进 closing 再收（退出比进入短）',
      closeAnim.closing === true && closeAnim.open === false, closeAnim);
    await wait(500);
    const closedState = await win.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlay');
      return { hidden: overlay.hidden, closing: overlay.classList.contains('closing') };
    })()`);
    check('动效：淡出结束后面板真的收起来并清理类名',
      closedState.hidden === true && closedState.closing === false, closedState);
    ctx.setOverlay(false); // 主进程侧的兜底：确保视图已挂回来
    await wait(300);

    // ---- 13i. 分栏缝隙：改窄，但拖动热区要够宽 ----
    const gapGeo = ctx.setPanes([services[0], services[1]]);
    await wait(350);
    const g = ctx.getGeometry();
    const gl = g.panes[0];
    const gr = g.panes[1];
    const gd = g.dividers[0] || {};
    check('分栏：缝隙收窄到 4px', gr.x - (gl.x + gl.width) === 4, { gap: gr.x - (gl.x + gl.width), sent: gd.width });
    check('分栏：拖动热区比缝隙宽（鼠标不用压在细线上）',
      (gd.hitWidth || 0) > gd.width && (gd.hitX || 0) < gd.x
      && (gd.hitX + gd.hitWidth) === gd.x + gd.width + (gd.hitWidth - gd.width) / 2, gd);
    const hitInDom = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#split-layer .divider');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), pointer: getComputedStyle(el).pointerEvents };
    })()`);
    check('分栏：页面里的热区元素也是宽的（≥ 12px）并能接住鼠标',
      hitInDom && hitInDom.width >= 12 && hitInDom.pointer === 'auto', hitInDom);

    // ---- 13j. 标签栏就地更新：状态消息不该重建整条标签 ----
    const tabIdentity = await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#tabs .tab');
      window.__tabNode = first;
      const before = { count: document.querySelectorAll('#tabs .tab').length };
      return before;
    })()`);
    ctx.setPanes([services[0]]);
    await wait(250);
    const tabAfter = await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('#tabs .tab');
      return { same: first === window.__tabNode, count: document.querySelectorAll('#tabs .tab').length };
    })()`);
    check('标签栏：重绘是就地更新，不重建节点（避免闪 + 掉帧）',
      tabAfter.same === true && tabAfter.count === tabIdentity.count,
      { before: tabIdentity, after: tabAfter });

    // ---- 13k. 全局快捷键唤出（老板键）+ 托盘 ----
    const hkBefore = ctx.getHotkey();
    check('快捷键：默认就是 Alt+Space 且一启动就启用',
      hkBefore.accelerator === ctx.HOTKEY_DEFAULT && hkBefore.enabled === true,
      { accelerator: hkBefore.accelerator, enabled: hkBefore.enabled });
    check('快捷键：真的注册进了系统（不是只写在配置里）',
      hkBefore.registered === true && ctx.isHotkeyRegistered(hkBefore.accelerator),
      { registered: hkBefore.registered, error: hkBefore.error });
    check('快捷键：默认开启「唤出时最高优先级置顶」', hkBefore.pinTop === true, hkBefore);
    check('托盘：图标已创建（窗口收进后台后的兜底入口）', Boolean(ctx.getTray()));
    check('托盘：菜单里有显示 / 隐藏 / 退出，并写明快捷键状态', (() => {
      const labels = ctx.buildTrayMenuTemplate().map((item) => item.label || item.type);
      return labels.includes('隐藏到后台')
        && labels.some((l) => String(l).startsWith('显示主窗口'))
        && labels.some((l) => String(l).startsWith('全局快捷键：'))
        && labels.some((l) => String(l).includes('退出'));
    })(), ctx.buildTrayMenuTemplate().map((item) => item.label || item.type));

    // 会让整个系统没法用的组合键必须拒掉，否则按一次就废掉系统上的一个操作
    const noModifier = ctx.setHotkey({ accelerator: 'Space' });
    check('快捷键：没有修饰键的组合键被拒绝', noModifier.ok === false && Boolean(noModifier.error), noModifier);
    const altF4 = ctx.setHotkey({ accelerator: 'Alt+F4' });
    check('快捷键：系统常用组合键（Alt+F4）被拒绝', altF4.ok === false, altF4);
    check('快捷键：被拒绝之后原设置不变',
      ctx.getHotkey().accelerator === ctx.HOTKEY_DEFAULT, ctx.getHotkey());
    check('快捷键：写法能规范化（ctrl+alt+space -> Ctrl+Alt+Space）',
      ctx.normalizeAccelerator('ctrl+alt+space') === 'Ctrl+Alt+Space',
      ctx.normalizeAccelerator('ctrl+alt+space'));
    check('快捷键：单个 F 键允许单独使用',
      ctx.normalizeAccelerator('f9') === 'F9', ctx.normalizeAccelerator('f9'));

    // 换一个自检专用的组合键，确认系统里的注册真的跟着换了
    const testAcc = 'Ctrl+Alt+Shift+F9';
    const switched = ctx.setHotkey({ accelerator: testAcc });
    check('快捷键：可以换成别的组合键并立刻生效',
      switched.ok === true && switched.hotkey.accelerator === testAcc && switched.registered === true,
      switched);
    check('快捷键：旧组合键已经还给系统，新组合键在系统里',
      ctx.isHotkeyRegistered(testAcc) && !ctx.isHotkeyRegistered(ctx.HOTKEY_DEFAULT),
      { now: ctx.getRegisteredAccelerator(), altSpace: ctx.isHotkeyRegistered(ctx.HOTKEY_DEFAULT) });

    // 设置面板上的录制框：走「页面 -> preload -> 主进程重新注册 -> 状态回来」整条链路
    // 先把窗口叫到前台：录制框是靠焦点/按键起录的，窗口在后台时 focus 事件可能根本不来
    win.show();
    win.focus();
    await wait(300);
    win.webContents.send('ui:open-settings'); // 与 Ctrl+, 同一条链路
    await wait(700);
    const recorded = await win.webContents.executeJavaScript(`(async () => {
      const input = document.getElementById('hk-key');
      const hint = document.getElementById('hk-hint');
      if (!input) return { missing: true };
      const before = input.value;
      input.focus();
      // 真实用户是先点一下再按键；这里两步都补上，别只依赖 focus 事件
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F10', code: 'F10', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const value = input.value;
      const overlayVisible = !document.getElementById('overlay').hidden;
      const hintBeforeBlur = document.getElementById('hk-hint') ? document.getElementById('hk-hint').textContent : '';
      const recordingBeforeBlur = input.classList.contains('recording');
      // 先失焦再读提示：「正在录制」时提示语是操作指引，失焦之后才显示设置结果
      input.blur();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // 提示节点也重新查一次，避免读到被重建掉的旧节点
      const hintNow = document.getElementById('hk-hint');
      const text = hintNow ? hintNow.textContent : '';
      return {
        missing: false, before, value, hint: text, overlayVisible,
        hintBeforeBlur, recordingBeforeBlur,
        stillRecording: input.classList.contains('recording'),
        activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
      };
    })()`);
    check('快捷键：录制框在打开的面板里（不是藏在 hidden 里空按）',
      recorded.missing !== true && recorded.overlayVisible === true,
      { missing: recorded.missing, overlayVisible: recorded.overlayVisible });
    check('快捷键：设置面板里有录制框，录下来的组合键真的生效了',
      recorded.missing !== true && recorded.value === 'Ctrl+Alt+F10'
      && ctx.getHotkey().accelerator === 'Ctrl+Alt+F10'
      && ctx.isHotkeyRegistered('Ctrl+Alt+F10'), recorded);
    check('快捷键：面板上写明了「已生效」', /已生效/.test(recorded.hint || ''), recorded);

    // 关闭面板（Esc 交给页面处理），顺便确认录制框没有把 Esc 吃掉
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(500);
    check('快捷键：录制结束后面板还能正常关掉（Esc 没被录制框吃掉）',
      ctx.getOverlay() === false, ctx.getOverlay());

    // 模拟按下系统级快捷键：globalShortcut 的回调与这里调的是同一个函数
    ctx.summonWindow();
    await wait(400);
    check('唤出：窗口可见、拿到焦点，并且按「最高优先级」置顶',
      win.isVisible() && win.isFocused() && win.isAlwaysOnTop() === true,
      { visible: win.isVisible(), focused: win.isFocused(), top: win.isAlwaysOnTop() });

    const hiddenByHotkey = ctx.hideWindow();
    await wait(350);
    check('收起：窗口真的藏起来（不在任务栏也不在屏幕上）',
      hiddenByHotkey.mode === 'hide' && !win.isVisible(),
      { result: hiddenByHotkey, visible: win.isVisible() });

    ctx.triggerHotkey();
    await wait(500);
    check('唤出：按下快捷键能把藏起来的窗口叫回来',
      win.isVisible() && win.isFocused() && win.isAlwaysOnTop() === true,
      { visible: win.isVisible(), focused: win.isFocused(), top: win.isAlwaysOnTop() });

    ctx.triggerHotkey();
    await wait(400);
    check('收起：窗口已经在前面时再按一次就收进后台（老板键语义）',
      !win.isVisible(), win.isVisible());

    ctx.triggerHotkey();
    await wait(450);
    check('唤出：收起来之后又按一次还能唤出（来回都对）', win.isVisible(), win.isVisible());

    // 让出前台就自动取消置顶，否则它会长久压在别人的窗口上
    win.blur();
    await wait(400);
    if (win.isAlwaysOnTop()) ctx.releasePin({ force: true });
    await wait(150);
    check('置顶：窗口让出前台后自动取消（不会一直压着别的窗口）',
      win.isAlwaysOnTop() === false, win.isAlwaysOnTop());

    // 安全阀：快捷键和托盘都没有的时候，绝不能真的把窗口藏起来（藏起来就叫不回来了）
    // 注意要先把「快捷键」这条退路也拿掉，否则窗口本来就能被快捷键叫回来，hide 是正确行为
    const trayWasThere = Boolean(ctx.getTray());
    const hkWasEnabled = ctx.getHotkey().enabled;
    const hkOff = await ctx.setHotkey({ enabled: false });
    await wait(250);
    ctx.destroyTray();
    const noHotkey = ctx.isHotkeyRegistered(ctx.getHotkey().accelerator) === false;
    const hiddenNoTray = ctx.hideWindow();
    check('安全阀：快捷键 + 托盘都没有时只最小化，不会把窗口藏到叫不回来',
      noHotkey && hiddenNoTray.mode === 'minimize',
      { ...hiddenNoTray, noHotkey, hkOff: hkOff && hkOff.ok });
    if (trayWasThere) ctx.createTray();
    if (hkWasEnabled) {
      await ctx.setHotkey({ enabled: true });
      await wait(300);
    }
    ctx.summonWindow();
    await wait(400);
    check('唤出：最小化之后也能拉回前台，托盘图标跟着恢复',
      win.isVisible() && !win.isMinimized() && (!trayWasThere || Boolean(ctx.getTray())),
      { visible: win.isVisible(), minimized: win.isMinimized(), tray: Boolean(ctx.getTray()) });

    // 点关闭按钮：默认收进后台而不是退出（否则快捷键就跟着一起没了）
    check('关闭行为：默认是「收进后台」而不是退出', ctx.config.hotkey.closeToTray === true, ctx.config.hotkey);
    win.close();
    await wait(600);
    check('关闭行为：点关闭后窗口被收起、进程还活着（快捷键仍然可用）',
      ctx.getWindow() === win && !win.isDestroyed() && !win.isVisible(),
      { same: ctx.getWindow() === win, destroyed: win.isDestroyed(), visible: win.isVisible() });
    ctx.triggerHotkey();
    await wait(500);
    check('关闭行为：收进后台之后照样能唤出（并没有被关掉）',
      ctx.getWindow() === win && win.isVisible(), { visible: win.isVisible() });

    // 收尾：恢复默认设置，并确认落盘
    ctx.setHotkey({
      enabled: true,
      accelerator: ctx.HOTKEY_DEFAULT,
      pinTop: true,
      closeToTray: true,
      tray: true,
    });
    await wait(700);
    const hkAfter = ctx.getHotkey();
    check('快捷键：收尾恢复成 Alt+Space 并重新注册成功',
      hkAfter.accelerator === ctx.HOTKEY_DEFAULT && hkAfter.enabled === true && hkAfter.registered === true,
      hkAfter);
    const onDiskHotkey = JSON.parse(fs.readFileSync(ctx.configFile(), 'utf8')).hotkey || {};
    check('快捷键：设置已落盘（config.json 的 hotkey 字段）',
      onDiskHotkey.accelerator === ctx.HOTKEY_DEFAULT && onDiskHotkey.enabled === true
      && onDiskHotkey.pinTop === true,
      onDiskHotkey);

    // ---- 14. 标签栏页面无脚本报错 ----
    check('标签栏页面无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));

    if (process.env.AIHUB_SMOKE_SHOTS) await captureShots();

    finish(infos);
  }

  /** AIHUB_SMOKE_SHOTS=1 时，把标签栏页面几个状态各截一张图，方便肉眼检查 UI。 */
  async function captureShots() {
    const win = ctx.getWindow();
    if (!win) return;
    const dir = path.join(ctx.app.getPath('temp'), 'aihub-shots');
    fs.mkdirSync(dir, { recursive: true });

    const shot = async (name) => {
      const image = await win.webContents.capturePage();
      const file = path.join(dir, `${name}.png`);
      fs.writeFileSync(file, image.toPNG());
      console.log(`截图: ${file}`);
    };

    ctx.setOverlay(false);
    await wait(500);
    await shot('01-tabbar');

    win.webContents.send('ui:open-settings'); // 与 Ctrl+, 走同一条链路
    await wait(900);
    await shot('02-settings');

    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(500);

    const firstId = ctx.publicState().activeId || ctx.publicState().services[0].id;
    ctx.activate(firstId, { focus: false });
    await wait(400);
    await shot('03-tabs');

    // 分屏：验证分隔条与缝隙的渲染（Service 视图是独立原生视图，不会被这张截图拍到）
    const others = ctx.publicState().services.filter((s) => s.id !== firstId);
    if (others.length) {
      ctx.setPanes([firstId, others[0].id]);
      await wait(600);
      await shot('04-split');
      if (others.length > 1) {
        ctx.setPanes([firstId, others[0].id, others[1].id]);
        await wait(600);
        await shot('05-split-3');
      }
      ctx.setPanes([firstId]);
      await wait(300);
    }

    // 浅色主题再来一遍关键几张，方便肉眼对照（深色/浅色都要看着舒服）
    const themeKeep = ctx.config.theme;
    ctx.setTheme('light');
    ctx.setOverlay(false);
    await wait(700);
    await shot('06-light-tabbar');
    win.webContents.send('ui:open-settings');
    await wait(900);
    await shot('07-light-settings');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(400);
    if (others.length) {
      ctx.setPanes([firstId, others[0].id]);
      await wait(600);
      await shot('08-light-split');
      ctx.setPanes([firstId]);
      await wait(300);
    }
    ctx.setTheme(themeKeep);
    await wait(400);
  }

  function finish(infos) {
    const failures = checks.filter((c) => !c.ok);
    console.log('\n================ SMOKE REPORT ================');
    console.log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);
    console.log(`配置文件: ${ctx.configFile()}`);
    if (infos) {
      console.log('\n各服务加载情况:');
      for (const info of infos) {
        console.log(`  ${info.missing ? '✗' : '✓'} ${info.id.padEnd(10)} ${info.crashed ? '[崩溃] ' : ''}${info.title || '(无标题)'}`);
        console.log(`      ${info.url}`);
      }
    }
    console.log('\n断言结果:');
    for (const item of checks) {
      console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}`);
      if (!item.ok && item.detail !== undefined) {
        console.log(`      ↳ ${JSON.stringify(item.detail)}`);
      }
    }
    if (failures.length) {
      console.log(`\nSMOKE_FAIL ${failures.length}/${checks.length} 项未通过`);
    } else {
      console.log(`\nSMOKE_PASS ${checks.length}/${checks.length} 项全部通过`);
    }
    console.log('==============================================\n');
    ctx.app.exit(failures.length ? 1 : 0);
  }

  main().catch((err) => {
    console.error('SMOKE 脚本异常:', err);
    ctx.app.exit(1);
  });
};
