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
    const captureOutput = (chunk) => {
      output += chunk.toString();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Electron ${flag} timed out.\n${output}`));
    }, 20_000);

    child.stdout.on('data', captureOutput);
    child.stderr.on('data', captureOutput);
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
  if (state.schemaVersion !== 3)
    throw new Error('The persisted state was not migrated to schema 3.');
  const disk = state.nodes.find((node) => node.id === 'system-disk');
  if (!disk || disk.kind !== 'disk') throw new Error('The persisted virtual disk was removed.');
  const desktop = state.nodes.find((node) => node.id === 'desktop');
  if (!desktop || desktop.kind !== 'desktop' || desktop.parentId !== null) {
    throw new Error('The hidden Desktop root was not persisted.');
  }
  if (!state.desktop.lastEjectAt) throw new Error('The eject timestamp was not persisted.');
  if (
    !state.nodes.some((node) => node.parentId === 'system-disk' && node.name === 'untitled folder')
  ) {
    throw new Error('The folder created through the File menu was not persisted.');
  }
  const desktopDocument = state.nodes.find(
    (node) => node.parentId === 'desktop' && node.name === 'Dropped Note.txt',
  );
  if (
    !desktopDocument?.content?.includes('external Electron drop') ||
    desktopDocument.iconPosition?.x !== 121 ||
    desktopDocument.iconPosition?.y !== 591
  ) {
    throw new Error('The externally dropped Desktop document and its position were not persisted.');
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
    (node) => node.parentId === 'desktop' && node.name === 'Drop Folder',
  );
  if (
    !droppedFolder ||
    droppedFolder.iconPosition?.x !== 215 ||
    droppedFolder.iconPosition?.y !== 591
  ) {
    throw new Error('The externally dropped Desktop folder and its position were not persisted.');
  }
  const nestedDocument = state.nodes.find(
    (node) => node.parentId === droppedFolder.id && node.name === 'Nested Note.txt',
  );
  if (nestedDocument?.content !== 'Nested folder import passed.\n') {
    throw new Error('The externally dropped folder hierarchy was not persisted.');
  }
  const movedSystemFolder = state.nodes.find(
    (node) => node.id === 'system-folder' && node.parentId === 'documents',
  );
  if (
    !movedSystemFolder ||
    !state.nodes.some(
      (node) => node.id === 'finder-notes' && node.parentId === movedSystemFolder.id,
    )
  ) {
    throw new Error('The direct folder drop did not preserve the moved hierarchy.');
  }
  const desktopUtilities = state.nodes.find(
    (node) => node.id === 'utilities' && node.parentId === 'desktop',
  );
  if (desktopUtilities?.iconPosition?.x !== 593 || desktopUtilities.iconPosition?.y !== 649) {
    throw new Error('The internally moved and repositioned Desktop folder was not persisted.');
  }
  if (!state.nodes.some((node) => node.id === 'welcome' && node.parentId === 'trash')) {
    throw new Error('The direct Trash drop was not persisted.');
  }
  if (state.desktop.diskPosition.x < 0 || state.desktop.diskPosition.y < 0) {
    throw new Error('The disk did not return to a valid persisted desktop position.');
  }
  if (state.desktop.diskPosition.x === 1036 && state.desktop.diskPosition.y === 52) {
    throw new Error('The freely repositioned System Disk returned to its default position.');
  }
  const applications = state.nodes.find((node) => node.id === 'applications');
  if (
    applications?.parentId !== 'system-disk' ||
    applications.iconPosition?.x !== 441 ||
    applications.iconPosition?.y !== 239
  ) {
    throw new Error(
      `The free Finder icon position was not persisted: ${JSON.stringify(applications)}.`,
    );
  }
  const savedWindow = state.desktop.windows.find((item) => item.id === 'window-applications');
  if (!savedWindow || savedWindow.x !== 405 || savedWindow.y !== 105) {
    throw new Error(
      `The Finder window release position was not persisted: ${JSON.stringify(savedWindow)}`,
    );
  }

  await runElectron('--normal-quit-probe');
  const normalQuitState = JSON.parse(
    await readFile(path.join(userData, 'macintosh-state.json'), 'utf8'),
  );
  if (normalQuitState.nodes.length !== state.nodes.length + 1) {
    throw new Error(
      'Normal quit did not persist the mutation made inside the 220 ms debounce window.',
    );
  }

  await runElectron('--persistence-probe');
  const proof = JSON.parse(await readFile(path.join(userData, 'persistence-proof.json'), 'utf8'));
  if (!proof?.loaded || !proof.diskVisible || proof.diskLabel !== 'System Disk') {
    throw new Error(`Persistence relaunch probe failed: ${JSON.stringify(proof)}`);
  }
  if (!Number.isFinite(proof.vfsCount) || proof.vfsCount !== normalQuitState.nodes.length) {
    throw new Error('The persisted virtual filesystem was not loaded by the renderer.');
  }
  if (proof.windowLeft !== savedWindow.x || proof.windowTop !== savedWindow.y) {
    throw new Error('The persisted Finder window position was not restored on relaunch.');
  }
  if (
    proof.diskX !== state.desktop.diskPosition.x ||
    proof.diskY !== state.desktop.diskPosition.y
  ) {
    throw new Error('The freely positioned System Disk was not restored on relaunch.');
  }
  if (
    proof.applicationsX !== applications.iconPosition.x ||
    proof.applicationsY !== applications.iconPosition.y
  ) {
    throw new Error('The free Finder icon position was not restored on relaunch.');
  }
  if (
    proof.desktopDocumentX !== desktopDocument.iconPosition.x ||
    proof.desktopDocumentY !== desktopDocument.iconPosition.y ||
    proof.desktopFolderX !== droppedFolder.iconPosition.x ||
    proof.desktopFolderY !== droppedFolder.iconPosition.y ||
    proof.desktopUtilitiesX !== desktopUtilities.iconPosition.x ||
    proof.desktopUtilitiesY !== desktopUtilities.iconPosition.y
  ) {
    throw new Error('Desktop VFS items did not restore their exact free positions on relaunch.');
  }
  if (!proof.desktopDocumentContent?.includes('external Electron drop')) {
    throw new Error('The Desktop document content was not restored on relaunch.');
  }
  if (!proof.desktopFolderNestedVisible) {
    throw new Error('The Desktop folder hierarchy was not restored on relaunch.');
  }
  if (proof.desktopNestedDocumentContent !== 'Nested folder import passed.\n') {
    throw new Error('The nested Desktop document content was not restored on relaunch.');
  }

  console.log(
    'Electron smoke passed: native The Macintosh identity/icon, System 1 bitmap cursor bindings, native closed-fist drag continuity, file/folder pointer transitions, thresholded click-hold/drag, off-center pointer alignment, focus-loss cleanup, host file/folder Desktop placement, Desktop selection/info/stepped folder and document opening and closing with the Finder move-preview outline and hard shadow, direct System Disk import, blocked document fall-through, external Trash rejection, Finder-to-Desktop move and free reposition, document paste and duplication, free Finder icon placement, direct folder and Trash moves, drag-session input ownership, shared menu shortcuts, Calculator buttons/keyboard/outline drag, modal input precedence, save-failure drag cancellation, Finder drag overlap/release redraw, cancelled Trash drag, free System Disk placement, disk pointer-follow, Trash hover, eject animation, persisted eject, normal-quit save failure recovery, repeated quit coalescing, and quit-inside-debounce persistence.',
  );
  console.log(
    'Persistence relaunch passed: normal-quit mutation, Finder geometry, exact Desktop and Finder icon positions, Desktop content and hierarchy, System Disk, and virtual filesystem reloaded.',
  );
} finally {
  await rm(userData, { recursive: true, force: true });
}
