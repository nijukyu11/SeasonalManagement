#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const SDK_PACKAGE = '@skawld/agent-sdk';
const REQUIRED_EXPORTS = {
  main: ['Agent', 'Session', 'defaultTools', 'isSubagentEvent'],
  providers: ['BaseProvider'],
  tools: ['ToolRegistry', 'defaultTools'],
  sessions: ['InMemorySessionStore', 'SqliteSessionStore'],
  permissions: ['PermissionEngine'],
};

function summarizeExports(moduleValue) {
  return Object.keys(moduleValue).sort();
}

function findMissingRequiredExports(exportsByModule) {
  const missing = {};
  for (const [moduleName, requiredNames] of Object.entries(REQUIRED_EXPORTS)) {
    const exportNames = new Set(exportsByModule[moduleName] ?? []);
    const missingNames = requiredNames.filter((name) => !exportNames.has(name));
    if (missingNames.length > 0) missing[moduleName] = missingNames;
  }
  return missing;
}

export async function checkSkawldSdkCompatibility() {
  const checkedAt = new Date().toISOString();

  try {
    const [sdk, providers, tools, sessions, permissions] = await Promise.all([
      import('@skawld/agent-sdk'),
      import('@skawld/agent-sdk/providers'),
      import('@skawld/agent-sdk/tools'),
      import('@skawld/agent-sdk/sessions'),
      import('@skawld/agent-sdk/permissions'),
    ]);
    const exportsByModule = {
      main: summarizeExports(sdk),
      providers: summarizeExports(providers),
      tools: summarizeExports(tools),
      sessions: summarizeExports(sessions),
      permissions: summarizeExports(permissions),
    };
    const missingRequiredExports = findMissingRequiredExports(exportsByModule);
    const missingRequiredCount = Object.values(missingRequiredExports).reduce((total, names) => total + names.length, 0);

    return {
      ok: missingRequiredCount === 0,
      status: missingRequiredCount === 0 ? 'available' : 'missing_required_exports',
      packageName: SDK_PACKAGE,
      devOnly: true,
      checkedAt,
      requiredExports: REQUIRED_EXPORTS,
      missingRequiredExports,
      exportCount: exportsByModule.main.length,
      exports: exportsByModule.main,
      exportsByModule,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    const missing = code === 'ERR_MODULE_NOT_FOUND' && message.includes(SDK_PACKAGE);

    return {
      ok: false,
      status: missing ? 'missing' : 'import_error',
      packageName: SDK_PACKAGE,
      devOnly: true,
      checkedAt,
      requiredExports: REQUIRED_EXPORTS,
      missingRequiredExports: REQUIRED_EXPORTS,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        code,
        message,
      },
    };
  }
}

function printResult(result, { jsonOnly }) {
  if (!jsonOnly) {
    const friendlyStatus = result.ok
      ? `available with ${result.exportCount} exported member(s)`
      : result.status === 'missing'
        ? 'not installed'
        : 'installed but failed to import';
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`Skawld SDK compatibility: ${friendlyStatus}. This check is dev-only and is not wired into production runtime.\n`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const jsonOnly = process.argv.includes('--json');
  const result = await checkSkawldSdkCompatibility();
  printResult(result, { jsonOnly });

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
