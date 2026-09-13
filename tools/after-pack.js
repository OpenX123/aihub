'use strict';

/**
 * electron-builder 的 afterPack 钩子：在 macOS 上给 .app 补一次 ad-hoc 签名。
 *
 * 为什么需要：Apple Silicon（arm64）的内核要求所有可执行代码至少带着 ad-hoc 签名才允许运行。
 * Electron 自带的 framework 本来是签过名的，但 electron-builder 重新组装 bundle
 * （塞进 app.asar、改可执行文件名……）之后那个签名就失效了，结果就是下载下来一打开
 * 只看到「Aihub 已损坏，无法打开」，连「仍要打开」的入口都没有。
 *
 * 配了正式证书（CSC_LINK / CSC_NAME / CSC_KEYCHAIN）时不插手：那种情况下
 * electron-builder 会在我们之后做真正的签名，别去动它。
 */

const { execFileSync } = require('child_process');
const path = require('path');

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const realSigning = process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEYCHAIN;
  if (realSigning) {
    console.log('[after-pack] 检测到正式签名配置，跳过 ad-hoc 签名');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[after-pack] 已给 ${appName}.app 加上 ad-hoc 签名`);
  } catch (err) {
    // 签名失败不让整个打包挂掉：产物仍然是可用的（用户需要右键「打开」或自行去掉 quarantine）
    console.error('[after-pack] ad-hoc 签名失败（打包继续）:', err.message);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
