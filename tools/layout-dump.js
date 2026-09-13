'use strict';

/**
 * 仅开发用的调试钩子（不参与打包）。
 *
 * 设置 AIHUB_LAYOUT_DUMP=<文件路径> 启动应用，每次布局都会把当前几何写进去，
 * 并附带分隔条中心点在「屏幕物理像素」下的坐标，方便用 SendInput 做真实鼠标拖拽测试：
 *
 *   $env:AIHUB_LAYOUT_DUMP="$env:TEMP\hub-layout.json"; npm start
 */

const fs = require('fs');

module.exports = function dumpLayout(ctx) {
  const { mainWindow, screen, config, geometry, tabBarHeight } = ctx;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 真实鼠标拖拽测试专用：把窗口置顶并激活，保证注入的点击一定落在它身上
  // （窗口未激活时，Chromium 会把第一次 mousedown 吃掉用于激活，拖拽就起不来）
  if (process.env.AIHUB_TEST_TOPMOST && !mainWindow.__testTopped) {
    mainWindow.__testTopped = true;
    try {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.moveTop();
      mainWindow.focus();
    } catch {
      // 置顶失败不影响后续判断（测试脚本会自己校验像素归属）
    }
  }

  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const contentBounds = mainWindow.getContentBounds();
  const contentSize = mainWindow.getContentSize();

  const payload = {
    at: Date.now(),
    scaleFactor: scale,
    contentBounds,
    contentSize,
    minPaneWidth: config.minPaneWidth,
    panes: geometry.panes,
    dividers: geometry.dividers,
    weights: config.weights.slice(),
    paneIds: config.panes.slice(),
    // 每个分隔条中心点的屏幕物理坐标（拖拽测试的起点）
    dragPoints: geometry.dividers.map((divider) => ({
      index: divider.index,
      x: Math.round((contentBounds.x + divider.x + divider.width / 2) * scale),
      y: Math.round((contentBounds.y + tabBarHeight + 200) * scale),
    })),
  };

  try {
    fs.writeFileSync(process.env.AIHUB_LAYOUT_DUMP, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // 调试钩子失败不影响正常使用
  }
};
