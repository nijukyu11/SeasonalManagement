/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const arg1 = process.argv[2]?.trim();
const arg2 = process.argv[3]?.trim();
const tauriConfigPath = path.join(appRoot, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));

function sanitizeRepo(input) {
  if (!input) return null;
  const cleaned = input
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned) ? cleaned : null;
}

if (arg1 === '--check') {
  const endpoints = tauriConfig?.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    console.error('Error: tauri.conf.json missing plugins.updater.endpoints');
    process.exit(1);
  }

  for (const endpoint of endpoints) {
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:') {
        console.error(`Error: updater endpoint must use HTTPS: ${endpoint}`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: invalid updater endpoint URL: ${endpoint}`);
      process.exit(1);
    }
  }

  if (arg2) {
    const targetRepo = sanitizeRepo(arg2);
    if (!targetRepo) {
      console.error(`Error: invalid target repository '${arg2}'`);
      process.exit(1);
    }
    const expectedEndpoint = `https://github.com/${targetRepo}/releases/latest/download/latest.json`;
    if (!endpoints.includes(expectedEndpoint)) {
      console.error(`Error: updater endpoint does not match repository '${targetRepo}'.`);
      console.error(`Expected: ${expectedEndpoint}`);
      console.error(`Found: ${endpoints.join(', ')}`);
      process.exit(1);
    }
  }

  console.log('Updater endpoint configuration verified.');
  process.exit(0);
}

const repo = sanitizeRepo(arg1);
if (!repo) {
  console.error('Usage: node scripts/configure-release-repo.cjs <owner/repo>');
  console.error('       node scripts/configure-release-repo.cjs --check [owner/repo]');
  console.error('Example: node scripts/configure-release-repo.cjs nijukyu11/SeasonalManagement');
  process.exit(1);
}

tauriConfig.plugins = tauriConfig.plugins ?? {};
tauriConfig.plugins.updater = tauriConfig.plugins.updater ?? {};
tauriConfig.plugins.updater.endpoints = [
  `https://github.com/${repo}/releases/latest/download/latest.json`,
];

fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
console.log(`Configured updater release endpoint for ${repo}`);
