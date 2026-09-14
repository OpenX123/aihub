'use strict';

/**
 * 检查前端 api-shim.js 和 Rust 侧命令的契约是否对得上。
 *
 * 为什么需要：Tauri 的 invoke 是「字符串命令名 + 字符串参数名」，
 * 拼错了编译器不会管，单测也测不到——要等用户真的点到那个按钮才炸。
 * 迁移时这类错误尤其容易犯（36 个 IPC 通道要逐个改名）。
 *
 * 检查两件事：
 *   1. 前端调的每个命令，Rust 侧都真的有
 *   2. 每个命令的参数名两边一致（Rust 的 snake_case 参数名就是前端要传的 key）
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'commands.rs'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src-ui', 'api-shim.js'), 'utf8');

// --- Rust 侧：命令名 -> 参数名集合 ---
const cmds = new Map();
const cmdRe = /#\[tauri::command\]\s*\n\s*pub (?:async )?fn (\w+)\s*\(([^)]*)\)/g;
for (const m of rs.matchAll(cmdRe)) {
  const [, name, args] = m;
  const params = new Set();
  for (const arg of args.split(',')) {
    const trimmed = arg.trim();
    if (!trimmed) continue;
    const p = trimmed.split(':')[0].trim();
    if (p === 'app') continue;
    // 带 _ 前缀的是「收下但暂时不用」，前端照样要按原名传
    params.add(p.replace(/^_/, ''));
  }
  cmds.set(name, params);
}

// --- 前端侧：invoke/send 调用 ---
const problems = [];
const callRe = /(?:invoke|send)\('(\w+)'(?:,\s*\{([^}]*)\})?/g;
for (const m of js.matchAll(callRe)) {
  const [, name, argstr = ''] = m;
  if (!cmds.has(name)) {
    problems.push(`前端调了不存在的命令: ${name}`);
    continue;
  }
  const keys = new Set();
  for (const part of argstr.split(',')) {
    const t = part.trim();
    if (!t) continue;
    // 同时支持 { id } 简写和 { id: value }
    keys.add(t.split(':')[0].trim());
  }
  const want = cmds.get(name);
  const missing = [...want].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !want.has(k));
  if (missing.length) problems.push(`${name}: Rust 要 [${missing}]，前端没传`);
  if (extra.length) problems.push(`${name}: 前端多传了 [${extra}]，Rust 侧会忽略`);
}

if (problems.length) {
  console.error('[check-ipc] 前后端契约对不上：');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
console.log(`[check-ipc] ${cmds.size} 个命令的名字和参数名全部对得上`);
