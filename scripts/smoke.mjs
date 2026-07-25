import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBrandedElectronExecutable } from './macos-runtime.mjs';

const electronPath = await getBrandedElectronExecutable();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'macintosh-workbench-smoke-'));

const runElectron = (flag) =>
  new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['.', flag], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MACINTOSH_AUTOMATION_USER_DATA: userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Electron ${flag} timed out.\n${output}`));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Electron ${flag} exited with ${code ?? signal}.\n${output}`));
    });
  });

try {
  await runElectron('--smoke-test');

  const state = JSON.parse(await readFile(path.join(userData, 'macintosh-state.json'), 'utf8'));
  const disk = state.nodes.find((node) => node.id === 'system-disk');
  if (!disk || disk.kind !== 'disk') throw new Error('The persisted virtual disk was removed.');
  if (!state.desktop.lastEjectAt) throw new Error('The eject timestamp was not persisted.');
  if (
    !state.nodes.some((node) => node.parentId === 'system-disk' && node.name === 'untitled folder')
  ) {
    throw new Error('The folder created through the File menu was not persisted.');
  }
  const droppedDocument = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Dropped Note.txt',
  );
  if (!droppedDocument?.content?.includes('external Electron drop')) {
    throw new Error('The externally dropped document and its contents were not persisted.');
  }
  const droppedCopy = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Dropped Note copy.txt',
  );
  if (droppedCopy?.content !== droppedDocument.content) {
    throw new Error('The copied and pasted virtual document was not persisted correctly.');
  }
  const clipboardDocument = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Clipboard',
  );
  if (clipboardDocument?.content !== 'This document arrived through Paste.') {
    throw new Error('The pasted Clipboard document was not persisted.');
  }
  const droppedFolder = state.nodes.find(
    (node) => node.parentId === 'documents' && node.name === 'Drop Folder',
  );
  if (!droppedFolder) throw new Error('The internally dragged folder was not moved to Documents.');
  if (
    !state.nodes.some(
      (node) => node.parentId === droppedFolder.id && node.name === 'Nested Note.txt',
    )
  ) {
    throw new Error('The externally dropped folder hierarchy was not persisted.');
  }
  if (state.desktop.diskPosition.x < 0 || state.desktop.diskPosition.y < 0) {
    throw new Error('The disk did not return to a valid persisted desktop position.');
  }
  const savedWindow = state.desktop.windows.find((item) => item.id === 'window-applications');
  if (!savedWindow || savedWindow.x !== 405 || savedWindow.y !== 105) {
    throw new Error(
      `The Finder window release position was not persisted: ${JSON.stringify(savedWindow)}`,
    );
  }

  await runElectron('--persistence-probe');
  const proof = JSON.parse(await readFile(path.join(userData, 'persistence-proof.json'), 'utf8'));
  if (!proof?.loaded || !proof.diskVisible || proof.diskLabel !== 'System Disk') {
    throw new Error(`Persistence relaunch probe failed: ${JSON.stringify(proof)}`);
  }
  if (!Number.isFinite(proof.vfsCount) || proof.vfsCount !== state.nodes.length) {
    throw new Error('The persisted virtual filesystem was not loaded by the renderer.');
  }
  if (proof.windowLeft !== savedWindow.x || proof.windowTop !== savedWindow.y) {
    throw new Error('The persisted Finder window position was not restored on relaunch.');
  }

  console.log(
    'Electron smoke passed: native The Macintosh identity/icon, external file/folder drop, document paste and duplication, internal folder move, shared menu shortcuts, Calculator buttons/keyboard/outline drag, modal input precedence, Finder drag overlap/release redraw, cancelled Trash drag, disk pointer-follow, invalid snapback, Trash hover, eject animation, persisted quit.',
  );
  console.log(
    'Persistence relaunch passed: Finder geometry, System Disk, and virtual filesystem reloaded.',
  );
} finally {
  await rm(userData, { recursive: true, force: true });
}
