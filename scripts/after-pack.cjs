// electron-builder hook: gives the Mac app an ad-hoc signature.
//
// The app is not signed with an Apple Developer ID (that needs a paid account). Apple Silicon
// refuses to run code without any signature, so the bundle is signed "ad hoc" after it is put
// together. macOS still asks once before the first start of a downloaded copy (see README).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
