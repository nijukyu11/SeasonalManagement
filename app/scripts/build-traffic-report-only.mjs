import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = join(appRoot, '.traffic-report-build');
const buildRoot = join(stagingRoot, 'workspace');
const stagedOutput = join(stagingRoot, 'out');
const finalOutput = join(appRoot, 'out-report');
const previousOutput = join(stagingRoot, 'out-report.previous');

const copy = (source, destination) => {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
};

const listFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(root);
  return files;
};

const fail = (message) => {
  throw new Error(`Traffic report build rejected: ${message}`);
};

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(join(buildRoot, 'src', 'app'), { recursive: true });

for (const configFile of [
  'next.config.ts',
  'package.json',
  'postcss.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
]) {
  copy(join(appRoot, configFile), join(buildRoot, configFile));
}

copy(join(appRoot, 'public'), join(buildRoot, 'public'));
copy(join(appRoot, 'src', 'app', 'globals.css'), join(buildRoot, 'src', 'app', 'globals.css'));
copy(join(appRoot, 'src', 'app', '(public-report)'), join(buildRoot, 'src', 'app', '(public-report)'));
for (const reportLibrary of [
  'annualPassengerKpiContract.ts',
  'cn.ts',
  'trafficReportContract.ts',
  'trafficReportDataAdapter.ts',
  'trafficReportExcelExport.ts',
  'trafficReportOperationalHours.ts',
  'trafficReportV2Contract.ts',
]) {
  copy(join(appRoot, 'src', 'lib', reportLibrary), join(buildRoot, 'src', 'lib', reportLibrary));
}

const nextCli = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const build = spawnSync(process.execPath, [nextCli, 'build', buildRoot], {
  cwd: appRoot,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  encoding: 'utf8',
  stdio: 'inherit',
});

if (build.error) throw build.error;
if (build.status !== 0) {
  rmSync(stagingRoot, { recursive: true, force: true });
  process.exit(build.status ?? 1);
}

const exportedOutput = join(buildRoot, 'out');
if (!existsSync(exportedOutput)) fail('Next.js did not create an export directory.');
renameSync(exportedOutput, stagedOutput);

const forbiddenPaths = [
  'index.html',
  'audit.html',
  'checkin.html',
  'daily.html',
  'dashboard.html',
  'detailed.html',
  'gate.html',
  'seasonal.html',
  'settings.html',
];

for (const forbiddenPath of forbiddenPaths) {
  if (existsSync(join(stagedOutput, forbiddenPath))) fail(`unexpected desktop route ${forbiddenPath}`);
}

for (const requiredPath of ['reports/traffic.html', 'reports/traffic.txt', 'reports/traffic/dashboard.html', '_next/static']) {
  if (!existsSync(join(stagedOutput, requiredPath))) fail(`missing required output ${requiredPath}`);
}

const forbiddenMarkers = [
  'Native app required',
  'Seasonal Schedule - Aviation Command',
  'Check-in Allocation',
  'Gate Allocation',
];

for (const file of listFiles(stagedOutput)) {
  if (!/\.(?:html|js|css|txt|json)$/.test(file)) continue;
  const contents = readFileSync(file, 'utf8');
  const marker = forbiddenMarkers.find((candidate) => contents.includes(candidate));
  if (marker) fail(`desktop marker ${JSON.stringify(marker)} found in ${relative(stagedOutput, file)}`);
}

writeFileSync(join(stagedOutput, 'traffic-report-build-manifest.json'), `${JSON.stringify({
  artifact: 'traffic-report-only',
  publicRoutes: ['/', '/reports/traffic', '/dashboard', '/api/report/*'],
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');

rmSync(previousOutput, { recursive: true, force: true });
if (existsSync(finalOutput)) renameSync(finalOutput, previousOutput);
try {
  renameSync(stagedOutput, finalOutput);
  rmSync(previousOutput, { recursive: true, force: true });
} catch (error) {
  if (!existsSync(finalOutput) && existsSync(previousOutput)) renameSync(previousOutput, finalOutput);
  throw error;
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  artifact: 'traffic-report-only',
  output: finalOutput,
  files: listFiles(finalOutput).length,
}));
