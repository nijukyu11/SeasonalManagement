/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const agentDir = path.join(root, 'ai-agent');
const binariesDir = path.join(root, 'src-tauri', 'binaries');
const targetTriple = process.env.TAURI_PLATFORM_TARGET ?? 'x86_64-pc-windows-msvc';
const binaryBaseName = `dashboard-ai-agent-${targetTriple}`;
const binaryName = process.platform === 'win32' ? `${binaryBaseName}.exe` : binaryBaseName;
const outputPath = path.join(binariesDir, binaryName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

fs.mkdirSync(binariesDir, { recursive: true });

run('python', ['-m', 'pip', 'install', '-r', path.join(agentDir, 'requirements.txt')]);
run('python', ['-m', 'pip', 'install', '-r', path.join(agentDir, 'requirements-build.txt')]);
run('python', [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name',
  binaryBaseName,
  '--paths',
  agentDir,
  '--distpath',
  binariesDir,
  '--workpath',
  path.join(agentDir, '.pyinstaller', 'build'),
  '--specpath',
  path.join(agentDir, '.pyinstaller'),
  path.join(agentDir, 'agent_sidecar.py'),
]);

if (!fs.existsSync(outputPath)) {
  throw new Error(`Python agent bundle was not created: ${outputPath}`);
}

console.log(`Built Python AI sidecar: ${outputPath}`);
