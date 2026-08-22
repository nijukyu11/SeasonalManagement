import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'src', 'app');
const publicRoot = path.join(appRoot, '(public-report)');
const desktopRoot = path.join(appRoot, '(desktop)');
const sentinels = [
  'AppShell', 'OperatorAuthGate', 'NativeRuntimeGate', 'AppSidebar',
  'SeasonSyncProvider', 'AppUpdateProvider', 'ExportNotificationProvider',
  'seasonWorkspaceStore', 'remoteStore', '@tauri-apps/', 'zustand',
];

assert.equal(existsSync(path.join(appRoot, 'layout.tsx')), false, 'top-level root layout must not exist');
const desktopLayout = readFileSync(path.join(desktopRoot, 'layout.tsx'), 'utf8');
const publicLayout = readFileSync(path.join(publicRoot, 'layout.tsx'), 'utf8');
assert.match(desktopLayout, /import AppShell from '\.\/components\/AppShell'/);
assert.match(desktopLayout, /<html lang="vi">/);
assert.match(publicLayout, /<html lang="vi">/);
assert.doesNotMatch(publicLayout, /['"]use client['"]/);
for (const sentinel of sentinels) assert.doesNotMatch(publicLayout, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];
const visited = new Set();
function resolveImport(fromFile, specifier) {
  if (specifier.startsWith('@/')) return resolveCandidate(path.join(root, 'src', specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveCandidate(path.resolve(path.dirname(fromFile), specifier));
  return null;
}
function resolveCandidate(candidate) {
  for (const extension of extensions) {
    const file = `${candidate}${extension}`;
    if (existsSync(file)) return file;
  }
  for (const extension of extensions.slice(1)) {
    const indexFile = path.join(candidate, `index${extension}`);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
}
function visit(file) {
  if (!file || visited.has(file) || !/\.[jt]sx?$/.test(file)) return;
  visited.add(file);
  const source = readFileSync(file, 'utf8');
  for (const sentinel of sentinels) {
    assert.equal(source.includes(sentinel), false, `${path.relative(root, file)} imports or references forbidden public sentinel ${sentinel}`);
  }
  const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) visit(resolveImport(file, match[1]));
}

visit(path.join(publicRoot, 'layout.tsx'));
visit(path.join(publicRoot, 'reports', 'traffic', 'page.tsx'));
assert.ok(visited.size >= 5, 'public report import graph was not traversed');

const htmlPath = path.join(root, 'out', 'reports', 'traffic.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /traffic-report-root/);
  const builtSources = [html];
  for (const match of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)) {
    const assetPath = path.join(root, 'out', match[1].replace(/^\//, ''));
    if (existsSync(assetPath)) builtSources.push(readFileSync(assetPath, 'utf8'));
  }
  const builtText = builtSources.join('\n');
  for (const sentinel of ['Native app required', 'Checking operator session', 'appSidebarCollapsed', 'season-sync', '__TAURI_INTERNALS__']) {
    assert.equal(builtText.includes(sentinel), false, `built public report leaks desktop sentinel ${sentinel}`);
  }
}

console.log(JSON.stringify({ suite: 'traffic-report-isolation', status: 'passed', files: visited.size }));
