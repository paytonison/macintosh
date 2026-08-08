import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBrandedElectronExecutable } from './macos-runtime.mjs';

const SYSTEM_DISK_CREATED_AT = '1984-01-24T00:00:00.000Z';
const BUILT_IN_ITEM_CREATED_AT = '1984-01-24T00:00:00.000Z';
const NORMAL_QUIT_WINDOW_DELTA = { x: 37, y: 23 };
const CANONICAL_CREATED_AT_BY_NODE_ID = new Map([
  ['system-disk', SYSTEM_DISK_CREATED_AT],
  ['trash', BUILT_IN_ITEM_CREATED_AT],
  ['system-folder', BUILT_IN_ITEM_CREATED_AT],
  ['applications', BUILT_IN_ITEM_CREATED_AT],
  ['documents', BUILT_IN_ITEM_CREATED_AT],
  ['utilities', BUILT_IN_ITEM_CREATED_AT],
  ['welcome', BUILT_IN_ITEM_CREATED_AT],
  ['finder-notes', BUILT_IN_ITEM_CREATED_AT],
  ['read-me', BUILT_IN_ITEM_CREATED_AT],
  ['write', BUILT_IN_ITEM_CREATED_AT],
]);
const electronPath = await getBrandedElectronExecutable();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = await mkdtemp(path.join(tmpdir(), 'macintosh-workbench-smoke-'));

const assertCanonicalCreationMetadata = (state, label) => {
  for (const [nodeId, expected] of CANONICAL_CREATED_AT_BY_NODE_ID) {
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.createdAt !== expected) {
      throw new Error(
        `${label} ${nodeId} creation metadata was not canonical: ${node?.createdAt ?? 'missing'}.`,
      );
    }
  }
};

const documentText = (node) => {
  const payload = node?.payload;
  if (payload?.format === 'plain-text') return payload.text;
  if (payload?.format !== 'write-v1' || !Array.isArray(payload.blocks)) return '';
  return payload.blocks
    .map((block) =>
      block.type === 'page-break'
        ? '\f'
        : (block.content ?? [])
            .map((inline) => (inline.type === 'tab' ? '\t' : (inline.text ?? '')))
            .join(''),
    )
    .join('\n');
};

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
    const timeout = flag === '--smoke-test' ? 40_000 : 20_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Electron ${flag} timed out.\n${output}`));
    }, timeout);

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
  if (state.schemaVersion !== 4)
    throw new Error('The persisted state was not migrated to schema 4.');
  const disk = state.nodes.find((node) => node.id === 'system-disk');
  if (!disk || disk.kind !== 'disk') throw new Error('The persisted virtual disk was removed.');
  assertCanonicalCreationMetadata(state, 'Smoke state');
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
    desktopDocument?.payload?.format !== 'write-v1' ||
    !documentText(desktopDocument).includes('external Electron drop') ||
    !desktopDocument.payload.blocks.some(
      (block) =>
        block.type === 'paragraph' &&
        block.content.some(
          (inline) => inline.type === 'text' && inline.marks?.some((mark) => mark.type === 'bold'),
        ),
    ) ||
    desktopDocument.iconPosition?.x !== 121 ||
    desktopDocument.iconPosition?.y !== 591
  ) {
    throw new Error('The externally dropped Desktop document and its position were not persisted.');
  }
  const droppedDocument = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Dropped Note.txt',
  );
  if (!documentText(droppedDocument).includes('external Electron drop')) {
    throw new Error('The externally dropped document and its contents were not persisted.');
  }
  const droppedCopy = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Dropped Note copy.txt',
  );
  if (JSON.stringify(droppedCopy?.payload) !== JSON.stringify(droppedDocument.payload)) {
    throw new Error('The copied and pasted virtual document was not persisted correctly.');
  }
  const clipboardDocument = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Clipboard',
  );
  if (documentText(clipboardDocument) !== 'This document arrived through Paste.') {
    throw new Error('The pasted Clipboard document was not persisted.');
  }
  const writeApplication = state.nodes.find((node) => node.id === 'write');
  if (
    writeApplication?.kind !== 'application' ||
    writeApplication.applicationId !== 'write' ||
    writeApplication.parentId !== 'applications'
  ) {
    throw new Error('The built-in Write application was not persisted correctly.');
  }
  const smokeWrite = state.nodes.find(
    (node) => node.parentId === 'system-disk' && node.name === 'Smoke Write',
  );
  if (
    smokeWrite?.payload?.format !== 'write-v1' ||
    !documentText(smokeWrite).includes('Write smoke document') ||
    !documentText(smokeWrite).includes('Page two') ||
    documentText(smokeWrite).includes('unsaved') ||
    !smokeWrite.payload.blocks.some((block) => block.type === 'page-break') ||
    !smokeWrite.payload.blocks.some(
      (block) => block.type === 'paragraph' && block.style.tabStops.includes(54),
    )
  ) {
    throw new Error(
      `The saved Write document payload was incomplete: ${JSON.stringify(smokeWrite)}.`,
    );
  }
  const droppedFolder = state.nodes.find(
    (node) => node.parentId === 'desktop' && node.name === 'Drop Folder',
  );
  if (
    !droppedFolder ||
    droppedFolder.iconPosition?.x !== 134 ||
    droppedFolder.iconPosition?.y !== 602
  ) {
    throw new Error('The externally dropped Desktop folder and its position were not persisted.');
  }
  if (
    !state.nodes.some(
      (node) => node.parentId === droppedFolder.id && node.name === 'Nested Note.txt',
    )
  ) {
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
  if (!state.nodes.some((node) => node.id === 'documents' && node.parentId === 'trash')) {
    throw new Error('The scaled pointer-owned VFS item drop into Trash was not persisted.');
  }
  const desktopUtilities = state.nodes.find(
    (node) => node.id === 'utilities' && node.parentId === 'desktop',
  );
  if (desktopUtilities?.iconPosition?.x !== 593 || desktopUtilities.iconPosition?.y !== 649) {
    throw new Error('The internally moved and repositioned Desktop folder was not persisted.');
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
  if (!savedWindow || savedWindow.x !== 198 || savedWindow.y !== 94) {
    throw new Error(
      `The Finder window lost-capture cancellation was not persisted: ${JSON.stringify(savedWindow)}`,
    );
  }

  await runElectron('--normal-quit-probe');
  const normalQuitState = JSON.parse(
    await readFile(path.join(userData, 'macintosh-state.json'), 'utf8'),
  );
  assertCanonicalCreationMetadata(normalQuitState, 'Normal-quit state');
  if (normalQuitState.nodes.length !== state.nodes.length) {
    throw new Error('Normal quit unexpectedly changed the authoritative virtual filesystem.');
  }
  const normalQuitWindow = normalQuitState.desktop.windows.find(
    (item) => item.id === 'window-applications',
  );
  if (
    !normalQuitWindow ||
    normalQuitWindow.x !== savedWindow.x + NORMAL_QUIT_WINDOW_DELTA.x ||
    normalQuitWindow.y !== savedWindow.y + NORMAL_QUIT_WINDOW_DELTA.y ||
    normalQuitWindow.width !== savedWindow.width ||
    normalQuitWindow.height !== savedWindow.height
  ) {
    throw new Error(
      `Normal quit did not persist the committed presentation geometry while rejecting the provisional outline resize: ${JSON.stringify(normalQuitWindow)}.`,
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
  if (
    proof.windowLeft !== normalQuitWindow.x ||
    proof.windowTop !== normalQuitWindow.y ||
    proof.windowWidth !== normalQuitWindow.width ||
    proof.windowHeight !== normalQuitWindow.height
  ) {
    throw new Error('The normal-quit Finder geometry was not restored on relaunch.');
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
  if (
    !proof.writeReopened ||
    proof.writeFormat !== 'write-v1' ||
    !proof.writeText?.includes('Write smoke document') ||
    !proof.writeText?.includes('Page two') ||
    proof.writeText?.includes('unsaved') ||
    !proof.writeClean ||
    !proof.writeZoom75 ||
    proof.writePageCount !== 2 ||
    proof.writeLayoutState !== 'stable' ||
    !Number.isFinite(proof.writeLayoutGeneration) ||
    proof.writeLayoutGeneration <= 0 ||
    proof.writeExpandedSelection ||
    !proof.writeUndoDisabled ||
    !proof.writeRedoDisabled
  ) {
    throw new Error(
      `The saved Write document did not reopen on relaunch: ${JSON.stringify(proof)}.`,
    );
  }

  console.log(
    'Electron smoke passed: native The Macintosh identity/icon, pixel cursor assets/hotspots, pointer menu selection, Finder zoom and stationary outline resize controls, outline-only Finder and Write opening/closing transitions, content-heavy Write outline resizing without held-frame reflow, host file/folder Desktop placement, Desktop selection/open/info, direct System Disk import, blocked document fall-through, external Trash rejection, pointer-owned Finder-to-Desktop movement and free reposition, document paste and duplication, free Finder icon placement, direct folder move, drag-session input ownership, focus-loss preview/cursor cleanup, shared menu shortcuts, Calculator buttons/keyboard/outline drag, modal input precedence, save-failure drag cancellation, Finder drag overlap/release redraw, cancelled and committed Trash movement, precise glyph-edge/label/internal/scaled Trash hit testing with an ordinary VFS commit at 1.25x, free System Disk placement with an icon-only preview, Write launch and document routing, shared Finder/Write classic scroll controls, native Write wheel scrolling, minimum-size 50%/75%/100% overflow and ruler alignment, automatic pagination and backflow, rich formatting, ruler tabs, manual page breaks, Save As, virtual Open, dirty-close choices, multi-document quit cancellation, eject animation, persisted eject, normal-quit save failure recovery, repeated quit coalescing, canonical schema-4 built-in metadata, committed presentation persistence inside the debounce window, and provisional outline resize cancellation before quit.',
  );
  console.log(
    'Persistence relaunch passed: normal-quit committed Finder geometry, exact Desktop and Finder icon positions, canonical System Disk metadata, schema-4 virtual filesystem reload, and the saved rich Write document reopened without discarded edits.',
  );
} finally {
  await rm(userData, { recursive: true, force: true });
}
