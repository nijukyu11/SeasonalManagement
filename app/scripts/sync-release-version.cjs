/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const arg1 = process.argv[2]?.trim();
const arg2 = process.argv[3]?.trim();
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const packagePath = path.join(appRoot, 'package.json');
const packageLockPath = path.join(appRoot, 'package-lock.json');
const tauriConfigPath = path.join(appRoot, 'src-tauri', 'tauri.conf.json');
const cargoPath = path.join(appRoot, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(appRoot, 'src-tauri', 'Cargo.lock');

function readVersions() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  const cargoToml = fs.readFileSync(cargoPath, 'utf8');
  const cargoMatch = cargoToml.match(/^version = "([^"]+)"$/m);

  let cargoLockVersion = null;
  if (fs.existsSync(cargoLockPath)) {
    const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
    const match = cargoLock.match(/\[\[package\]\]\r?\nname = "seasonal-management"\r?\nversion = "([^"]+)"/);
    if (match) cargoLockVersion = match[1];
  }

  return {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.['']?.version,
    tauriConfig: tauriConfig.version,
    cargoToml: cargoMatch ? cargoMatch[1] : null,
    cargoLock: cargoLockVersion,
  };
}

if (arg1 === '--check') {
  const versions = readVersions();
  const baseVersion = arg2 || versions.tauriConfig;

  if (!baseVersion || !semverPattern.test(baseVersion)) {
    console.error(`Error: base version '${baseVersion}' is not valid semver.`);
    process.exit(1);
  }

  const mismatches = [];
  if (versions.packageJson !== baseVersion) mismatches.push(`package.json (${versions.packageJson})`);
  if (versions.packageLock !== baseVersion) mismatches.push(`package-lock.json (${versions.packageLock})`);
  if (versions.packageLockRoot && versions.packageLockRoot !== baseVersion) {
    mismatches.push(`package-lock.json packages[''] (${versions.packageLockRoot})`);
  }
  if (versions.tauriConfig !== baseVersion) mismatches.push(`src-tauri/tauri.conf.json (${versions.tauriConfig})`);
  if (versions.cargoToml !== baseVersion) mismatches.push(`src-tauri/Cargo.toml (${versions.cargoToml})`);
  if (versions.cargoLock && versions.cargoLock !== baseVersion) {
    mismatches.push(`src-tauri/Cargo.lock (${versions.cargoLock})`);
  }

  if (mismatches.length > 0) {
    console.error(`Error: release version inconsistency detected. Expected '${baseVersion}', but found differences in:`);
    for (const m of mismatches) {
      console.error(` - ${m}`);
    }
    process.exit(1);
  }

  console.log(`Release version consistency verified: ${baseVersion}`);
  process.exit(0);
}

const version = arg1;
if (!version || !semverPattern.test(version)) {
  console.error('Usage: node scripts/sync-release-version.cjs <semver>');
  console.error('       node scripts/sync-release-version.cjs --check [targetVersion]');
  console.error('Example: node scripts/sync-release-version.cjs 0.2.0');
  process.exit(1);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.version = version;
writeJson(packagePath, packageJson);

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
packageLock.version = version;
if (packageLock.packages?.['']) packageLock.packages[''].version = version;
writeJson(packageLockPath, packageLock);

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

const cargoToml = fs.readFileSync(cargoPath, 'utf8');
if (!/^version = ".*"$/m.test(cargoToml)) {
  throw new Error(`Failed to locate version entry in ${cargoPath}`);
}
const nextCargoToml = cargoToml.replace(
  /^version = ".*"$/m,
  `version = "${version}"`
);
fs.writeFileSync(cargoPath, nextCargoToml);

if (fs.existsSync(cargoLockPath)) {
  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const nextCargoLock = cargoLock.replace(
    /(\[\[package\]\]\r?\nname = "seasonal-management"\r?\nversion = ")[^"]+(")/,
    `$1${version}$2`
  );
  if (nextCargoLock !== cargoLock) {
    fs.writeFileSync(cargoLockPath, nextCargoLock);
  }
}

console.log(`Synced release version ${version}`);
