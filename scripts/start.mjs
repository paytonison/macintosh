import { spawn } from 'node:child_process';

import { getBrandedElectronExecutable, projectRoot } from './macos-runtime.mjs';

const electronExecutable = await getBrandedElectronExecutable();
const child = spawn(electronExecutable, [projectRoot, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.code ?? 1;
}
