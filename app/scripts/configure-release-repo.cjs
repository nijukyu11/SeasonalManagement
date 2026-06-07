/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repo = process.argv[2]?.trim();

if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error('Usage: node scripts/configure-release-repo.cjs <owner/repo>');
  console.error('Example: node scripts/configure-release-repo.cjs tuan/SeasonalManagement');
  process.exit(1);
}

const tauriConfigPath = path.join(appRoot, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
tauriConfig.plugins = tauriConfig.plugins ?? {};
tauriConfig.plugins.updater = tauriConfig.plugins.updater ?? {};
tauriConfig.plugins.updater.endpoints = [
  `https://github.com/${repo}/releases/latest/download/latest.json`,
];

fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
console.log(`Configured updater release endpoint for ${repo}`);
