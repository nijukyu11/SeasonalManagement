/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const version = process.argv[2];
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  console.error('Usage: node scripts/sync-release-version.cjs <semver>');
  console.error('Example: node scripts/sync-release-version.cjs 0.2.0');
  process.exit(1);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const packagePath = path.join(appRoot, 'package.json');
const tauriConfigPath = path.join(appRoot, 'src-tauri', 'tauri.conf.json');
const cargoPath = path.join(appRoot, 'src-tauri', 'Cargo.toml');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.version = version;
writeJson(packagePath, packageJson);

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

const cargoToml = fs.readFileSync(cargoPath, 'utf8');
const nextCargoToml = cargoToml.replace(
  /^version = ".*"$/m,
  `version = "${version}"`
);
fs.writeFileSync(cargoPath, nextCargoToml);

console.log(`Synced release version ${version}`);
