/**
 * 拖标签分屏 / 换顺序的自检脚本（Tauri debug 构建专用）。
 *
 *   AIHUB_SELFTEST=tools/tauri-drag-selftest.js \
 *     cargo run --manifest-path src-tauri/Cargo.toml
 *
 * 为什么要专门给它写个脚本：拖拽向来是「合成鼠标事件测不到」的典型，Electron
 * 版只能靠注入真实鼠标来验。Tauri 版把拖拽改成自己跟踪鼠标事件之后（原因见
 * src-ui/index.html 里 startTabDrag 的注释），合成的 MouseEvent 就能把整条链路
 * 走通，这个脚本就是那条链路的回归测试。
 *
 * 结论走 debug_note（脚本的返回值不会回传：WKWebView 的 evaluateJavaScript
 * 不等 promise），所以看 stderr 上的 `[selftest]` 行。
 * 它只是临时改布局和标签顺序，失败也一定还原（finally）。
 */
(async () => {
  const note = (m) => window.__TAURI__.core.invoke('debug_note', { line: m });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 合成一次「按下 → 移动 → 松手」。按住期间 buttons 必须是 1。 */
  const mouse = (el, type, x, y) =>
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'mouseup' ? 0 : 1,
    }));

  const tabs = () => [...document.querySelectorAll('.tab')];
  /** 每次都重新查节点：拖拽期间状态广播会重建标签，旧的引用会失效 */
  const tabOf = (id) => tabs().find((t) => t.dataset.id === id) || null;
  const rectOf = (id) => {
    const t = tabOf(id);
    return t ? t.getBoundingClientRect() : null;
  };
  const visibleIds = async () =>
    (await window.api.getState()).services.filter((s) => !s.hidden).map((s) => s.id);
  const paneIds = async () => (await window.api.getLayout()).panes.map((p) => p.id);
  /** 还原顺序要用**全部**服务的顺序：reorderServices 会把没出现在参数里的服务
      接到后面，只传看得见的那些会把收起的服务全挪到末尾。 */
  const allIds = async () => (await window.api.getState()).services.map((s) => s.id);

  const before = { panes: await paneIds(), order: await allIds() };
  /** 拖拽应该干净收场：影子、投放区、让位状态一样都不许剩 */
  const assertIdle = async (when) => {
    if (document.body.classList.contains('dragging-tab')) {
      throw new Error(when + '：还停在拖拽模式（站点视图回不来）');
    }
    if (document.querySelector('.tab-ghost')) throw new Error(when + '：标签影子还在');
    if (document.querySelectorAll('.dz').length) throw new Error(when + '：投放区还在');
  };

  try {
    // ---------- 1. 拖到页面区域松手 = 分栏 ----------
    const panes = before.panes;
    const ids = await visibleIds();
    const splitId = ids.find((id) => !panes.includes(id));
    if (!splitId) throw new Error('顶栏上没有「不在分屏里」的标签，没法测分栏');

    let r = rectOf(splitId);
    mouse(tabOf(splitId), 'mousedown', r.left + 4, r.top + 4);
    await wait(30);
    mouse(document, 'mousemove', r.left + 40, r.top + 40); // 超过阈值 → 进拖拽模式
    await wait(400);

    if (!document.body.classList.contains('dragging-tab')) throw new Error('移动超过阈值后没进拖拽模式');
    const zones = [...document.querySelectorAll('.dz')];
    if (!zones.length) throw new Error('拖拽模式下没有投放区');
    if (!document.querySelector('.tab-ghost')) throw new Error('拖拽时没有跟手的标签影子');

    const zr = (zones[1] || zones[0]).getBoundingClientRect();
    const zx = zr.left + Math.min(40, zr.width / 2);
    const zy = zr.top + zr.height / 2;
    mouse(document, 'mousemove', zx, zy);
    await wait(120);
    if (!zones.some((z) => z.classList.contains('hot'))) throw new Error('指针压在投放区上却没点亮');
    mouse(document, 'mouseup', zx, zy);
    await wait(800);

    const afterSplit = await paneIds();
    if (!afterSplit.includes(splitId)) {
      throw new Error('松手后 panes=' + JSON.stringify(afterSplit) + ' 里没有拖过去的 ' + splitId);
    }
    await assertIdle('分栏之后');
    await note('分栏 OK: ' + JSON.stringify(panes) + ' -> ' + JSON.stringify(afterSplit));

    // ---------- 2. 拖到另一个标签上 = 换顺序 ----------
    const ids2 = await visibleIds();
    if (ids2.length < 3) throw new Error('可见标签少于 3 个，没法测换顺序');
    const [firstId, , thirdId] = ids2;
    const expected = ids2.filter((id) => id !== firstId);
    expected.splice(expected.indexOf(thirdId) + 1, 0, firstId); // 放到第三个后面

    const fr = rectOf(firstId);
    const tr = rectOf(thirdId);
    mouse(tabOf(firstId), 'mousedown', fr.left + 4, fr.top + 4);
    await wait(30);
    mouse(document, 'mousemove', tr.right - 3, tr.top + 8); // 落在目标标签的右半边
    await wait(150);
    if (!tabOf(thirdId).classList.contains('drop-after')) throw new Error('压在标签右半边却没出现 drop-after 标记');
    mouse(document, 'mouseup', tr.right - 3, tr.top + 8);
    await wait(700);

    const afterOrder = await visibleIds();
    if (JSON.stringify(afterOrder) !== JSON.stringify(expected)) {
      throw new Error('换顺序结果不对：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(afterOrder));
    }
    await assertIdle('换顺序之后');
    await note('换顺序 OK: ' + JSON.stringify(ids2) + ' -> ' + JSON.stringify(afterOrder));

    // ---------- 3. Esc 取消 ----------
    const er = rectOf(ids2[0]);
    mouse(tabOf(ids2[0]), 'mousedown', er.left + 4, er.top + 4);
    await wait(30);
    mouse(document, 'mousemove', er.left + 60, er.top + 60);
    await wait(300);
    if (!document.body.classList.contains('dragging-tab')) throw new Error('Esc 用例：没能进入拖拽模式');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);
    await assertIdle('Esc 之后');
    const afterEsc = await visibleIds();
    if (JSON.stringify(afterEsc) !== JSON.stringify(afterOrder)) {
      throw new Error('Esc 之后布局被改了：' + JSON.stringify(afterEsc));
    }
    await note('Esc 取消 OK');

    await note('通过: 分栏 / 换顺序 / Esc 取消 三条都正常');
  } finally {
    await window.api.setPanes(before.panes);
    await window.api.reorderServices(before.order);
    await note('布局已还原（panes=' + JSON.stringify(before.panes) + '）');
  }
})()
