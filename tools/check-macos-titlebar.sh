#!/usr/bin/env bash
#
# 检查 macOS 上「系统标题栏有没有压住 44px 标签栏」。
#
# 为什么需要它：Tauri 在 macOS 上默认把窗口建成 FullSizeContentView
# （tauri-runtime-wry 的 TitleBarStyle::Visible 分支，为了绕开 tauri#3914），
# 内容视图于是铺满整个窗口框，而系统标题栏还是那条不透明的——它直接压在
# 内容顶上，标签栏只剩下十几 px 露出来。Windows 上内容区本来就在标题栏下方，
# 所以这个坑只在 mac 上出现，而且看代码看不出来：几何算得没错，
# 错的是「内容区从哪儿开始」。src-tauri/src/macos.rs 里把这一位摘掉之后，
# 内外尺寸差就等于一个标题栏的高度，这个脚本量的就是这个差值。
#
# 用法：
#   bash tools/check-macos-titlebar.sh                 # 跑 debug 构建
#   bash tools/check-macos-titlebar.sh path/to/aihub   # 跑指定的二进制（比如 release）
#
# 退出码：0 = 标签栏完整可见；1 = 被标题栏压住；2 = 没拿到窗口几何日志。
set -u

if [ "$(uname -s)" != "Darwin" ]; then
  echo "跳过：这个检查只在 macOS 上有意义（其它平台内容区本来就在标题栏下方）"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/src-tauri/target/debug/aihub}"
LOG="$(mktemp -t aihub-titlebar)"

if [ ! -x "$BIN" ]; then
  echo "找不到可执行文件 $BIN（先 cargo build）" >&2
  exit 2
fi

# 已经在跑的实例会被 single-instance 插件挡住，先请它让位（配置和登录态都在磁盘上）
pkill -f 'Aihub.app/Contents/MacOS/aihub' 2>/dev/null
pkill -f 'target/(debug|release)/aihub' 2>/dev/null
sleep 1

"$BIN" >"$LOG" 2>&1 &
APP_PID=$!
for _ in $(seq 1 40); do
  grep -q '窗口几何' "$LOG" && break
  sleep 0.25
done
kill "$APP_PID" 2>/dev/null

LINE="$(grep '窗口几何' "$LOG" | tail -1)"
if [ -z "$LINE" ]; then
  echo "没等到窗口几何日志，最后几行是：" >&2
  tail -5 "$LOG" >&2
  rm -f "$LOG"
  exit 2
fi
rm -f "$LOG"
echo "$LINE"

INNER_H="$(echo "$LINE" | sed -n 's/.*inner=[0-9]*x\([0-9]*\).*/\1/p')"
OUTER_H="$(echo "$LINE" | sed -n 's/.*outer=[0-9]*x\([0-9]*\).*/\1/p')"
CHROME=$((OUTER_H - INNER_H))

if [ "$CHROME" -lt 20 ]; then
  echo "✗ 内容区顶到窗口边：系统标题栏盖住标签栏顶部，44px 只露出十几 px"
  exit 1
fi
echo "✓ 内容区在标题栏下方（差 $CHROME px），44px 标签栏完整可见"
