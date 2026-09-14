#!/usr/bin/env node
'use strict';

/**
 * 生成 tauri-plugin-updater 的更新源 latest.json。
 *
 * 对应 Electron 版的 latest.yml。格式差别很大，关键点：
 *   - 按 platform 键分发（windows-x86_64 / darwin-aarch64）
 *   - 每个包必须带上它 .sig 文件的**内容**（不是路径）
 *     没有签名的话 updater 会拒绝安装，静默失败很难查，所以这里缺一个就直接报错退出。
 *
 * 用法：node make-latest-json.mjs <version> <dir> <owner/repo> <tag>
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [version, dir, repo, tag] = process.argv.slice(2);
if (!version || !dir || !repo || !tag) {
  console.error('用法: make-latest-json.mjs <version> <dir> <owner/repo> <tag>');
  process.exit(1);
}

const files = readdirSync(dir);
const base = `https://github.com/${repo}/releases/download/${tag}`;

/** 找到包文件和它配套的 .sig，读出签名内容 */
function pick(matcher, label) {
  const file = files.find((f) => matcher(f) && !f.endsWith('.sig'));
  if (!file) {
    console.warn(`[latest.json] 没找到 ${label} 的包，跳过这个平台`);
    return null;
  }
  const sigFile = files.find((f) => f === `${file}.sig`);
  if (!sigFile) {
    // 签名缺失时宁可让发布失败，也不要放一个客户端永远装不上的更新源出去
    console.error(`[latest.json] ${file} 缺少配套的 .sig —— 检查 TAURI_SIGNING_PRIVATE_KEY secret`);
    process.exit(1);
  }
  return {
    signature: readFileSync(join(dir, sigFile), 'utf8').trim(),
    url: `${base}/${encodeURIComponent(file)}`,
  };
}

const platforms = {};

const win = pick((f) => f.endsWith('.exe'), 'Windows');
if (win) platforms['windows-x86_64'] = win;

// macOS 的自动更新走 .tar.gz（.dmg 只是给人手动下载用的，updater 不认）
const mac = pick((f) => f.endsWith('.tar.gz'), 'macOS');
if (mac) platforms['darwin-aarch64'] = mac;

if (Object.keys(platforms).length === 0) {
  console.error('[latest.json] 一个平台的包都没有，不生成更新源');
  process.exit(1);
}

const manifest = {
  version,
  notes: `Aihub ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`[latest.json] 已生成，覆盖平台：${Object.keys(platforms).join(', ')}`);
