'use strict';

/**
 * 检查 src-ui/index.html 里内联主脚本块的语法。
 *
 * 这块脚本有 49K 字符，是标签栏和设置面板的全部逻辑。它不是独立的 .js 文件，
 * `node --check` 直接看不了，但它一旦有语法错，整个外壳会白屏——
 * 而白屏在 CI 里是看不出来的（进程照样起得来）。所以这里抽出来单独检一遍。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'src-ui', 'index.html');
const html = fs.readFileSync(file, 'utf8');

// 换行符按 .gitattributes 会被转成 CRLF，所以这里不能写死 \n
const match = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?)\s*<\/script>/);
if (!match) {
  console.error('[check-ui] 没在 src-ui/index.html 里找到主脚本块 —— 结构变了？');
  process.exit(1);
}

try {
  // new Script 只解析不执行，正好用来验语法
  new vm.Script(match[1], { filename: 'index.html#inline' });
  console.log(`[check-ui] 主脚本语法 OK（${match[1].length} 字符）`);
} catch (err) {
  console.error('[check-ui] 主脚本有语法错误:', err.message);
  process.exit(1);
}
