import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/contracts';
import { createDefaultState, sanitizeState, type MacintoshState } from '../shared/state';
import { inspectImportPaths } from './import-files';
import { createSerializedStateWriter } from './state-save-queue';

const STATE_FILE_NAME = 'macintosh-state.json';
const PROBE_FILE_NAME = 'persistence-proof.json';
const APP_NAME = 'The Macintosh';
const APP_ICON_PATH = path.join(app.getAppPath(), 'assets', 'the-macintosh-icon.png');
const smokeMode = process.argv.includes('--smoke-test');
const persistenceProbeMode = process.argv.includes('--persistence-probe');
const captureAboutMode = process.argv.includes('--capture-about');
const captureCalculatorMode = process.argv.includes('--capture-calculator');
const captureStartupArgument = process.argv.find((value) => value.startsWith('--capture-startup='));
const automationMode =
  smokeMode ||
  persistenceProbeMode ||
  process.argv.some((value) => value.startsWith('--capture-screen='));
const captureArgument = process.argv.find((value) => value.startsWith('--capture-screen='));

const automationUserData = process.env.MACINTOSH_AUTOMATION_USER_DATA;
if (automationUserData) {
  app.setPath('userData', path.resolve(automationUserData));
}

app.setName(APP_NAME);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
let applicationIcon: NativeImage | null = null;
let quitRequested = false;
let smokeSaveFailuresRemaining = 0;

const getApplicationIcon = (): NativeImage => {
  if (applicationIcon) return applicationIcon;

  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  if (icon.isEmpty()) {
    throw new Error(`Could not load application icon from ${APP_ICON_PATH}.`);
  }
  applicationIcon = icon;
  return applicationIcon;
};

const installApplicationMenu = (): void => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { label: `About ${APP_NAME}`, role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { label: `Hide ${APP_NAME}`, role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: `Quit ${APP_NAME}`, role: 'quit' },
        ],
      },
    ]),
  );
};

const statePath = (): string => path.join(app.getPath('userData'), STATE_FILE_NAME);

const loadState = async (): Promise<MacintoshState> => {
  try {
    const serialized = await readFile(statePath(), 'utf8');
    if (serialized.length > 1024 * 1024) return createDefaultState();
    return sanitizeState(JSON.parse(serialized) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.warn('Could not load Macintosh state:', error);
    return createDefaultState();
  }
};

const writeStateAtomically = async (state: MacintoshState): Promise<void> => {
  const safeState = sanitizeState(state);
  const destination = statePath();
  const temporary = `${destination}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(safeState, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
};

const saveState = createSerializedStateWriter(writeStateAtomically);

const assertTrustedRenderer = (event: IpcMainInvokeEvent): void => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Rejected IPC from an unknown renderer.');
  }
  const senderUrl = event.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file://')) {
    throw new Error('Rejected IPC from a non-local document.');
  }
};

const registerIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.loadState, async (event) => {
    assertTrustedRenderer(event);
    return loadState();
  });

  ipcMain.handle(IPC_CHANNELS.saveState, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (smokeMode && smokeSaveFailuresRemaining > 0) {
      smokeSaveFailuresRemaining -= 1;
      throw new Error('Injected smoke-test save failure.');
    }
    await saveState(sanitizeState(value));
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.importFiles, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return inspectImportPaths(value);
  });

  ipcMain.handle(IPC_CHANNELS.requestPaste, (event) => {
    assertTrustedRenderer(event);
    event.sender.paste();
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.quitAfterEject, (event) => {
    assertTrustedRenderer(event);
    quitRequested = true;
    setTimeout(() => app.quit(), 80);
    return { accepted: true as const };
  });
};

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForRenderer = async (window: BrowserWindow): Promise<void> => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "document.body.dataset.macReady === 'true'",
      true,
    );
    if (ready) return;
    await pause(50);
  }
  throw new Error('Renderer did not become ready in time.');
};

const runSmokeDrag = async (window: BrowserWindow): Promise<void> => {
  await waitForRenderer(window);
  window.show();
  window.focus();
  await pause(100);

  const documentTitle = (await window.webContents.executeJavaScript(
    'document.title',
    true,
  )) as string;
  const menuLabel = Menu.getApplicationMenu()?.items[0]?.label;
  const iconSize = getApplicationIcon().getSize();
  const usesBrandedBundle =
    process.platform !== 'darwin' || process.execPath.includes(`/${APP_NAME}.app/`);
  if (
    app.getName() !== APP_NAME ||
    window.getTitle() !== APP_NAME ||
    documentTitle !== APP_NAME ||
    (process.platform === 'darwin' && menuLabel !== APP_NAME) ||
    !usesBrandedBundle ||
    iconSize.width !== 1024 ||
    iconSize.height !== 1024
  ) {
    throw new Error(
      `Native application identity is incomplete: ${JSON.stringify({
        appName: app.getName(),
        windowTitle: window.getTitle(),
        documentTitle,
        menuLabel,
        executable: process.execPath,
        iconSize,
      })}`,
    );
  }

  const initialVfsCount = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  const importFixtureRoot = path.join(app.getPath('userData'), 'smoke-import-fixtures');
  const importFolder = path.join(importFixtureRoot, 'Drop Folder');
  const importDocument = path.join(importFixtureRoot, 'Dropped Note.txt');
  await mkdir(importFolder, { recursive: true });
  await writeFile(importDocument, 'This document arrived through an external Electron drop.\n');
  await writeFile(path.join(importFolder, 'Nested Note.txt'), 'Nested folder import passed.\n');

  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="system"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="about"]\')?.click()',
    true,
  );
  const aboutOpened = await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="About This Macintosh"]\') !== null',
    true,
  );
  if (!aboutOpened) throw new Error('About This Macintosh did not open from the System menu.');
  await window.webContents.executeJavaScript(
    "document.querySelector('.classic-dialog .classic-default-button')?.click()",
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="system"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="calculator"]\')?.click()',
    true,
  );
  await pause(40);
  const calculatorOpened = await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-calculator-window="true"]\') !== null',
    true,
  );
  if (!calculatorOpened) throw new Error('Calculator did not open from the System menu.');

  const calculatorDragStart = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      const handle = calculator?.querySelector('[data-calculator-drag-handle="true"]');
      if (!(calculator instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      const windowRect = calculator.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      return {
        window: { left: windowRect.left, top: windowRect.top },
        pointer: {
          x: Math.round(handleRect.left + handleRect.width * 0.72),
          y: Math.round(handleRect.top + handleRect.height / 2)
        }
      };
    })()`,
    true,
  )) as {
    window: { left: number; top: number };
    pointer: { x: number; y: number };
  } | null;
  if (!calculatorDragStart) throw new Error('Calculator title bar could not be located.');
  const calculatorDragEnd = {
    x: calculatorDragStart.pointer.x + 48,
    y: calculatorDragStart.pointer.y + 32,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...calculatorDragStart.pointer });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...calculatorDragStart.pointer,
  });
  for (let step = 1; step <= 4; step += 1) {
    const progress = step / 4;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        calculatorDragStart.pointer.x +
          (calculatorDragEnd.x - calculatorDragStart.pointer.x) * progress,
      ),
      y: Math.round(
        calculatorDragStart.pointer.y +
          (calculatorDragEnd.y - calculatorDragStart.pointer.y) * progress,
      ),
    });
    await pause(28);
  }
  await pause(60);
  const calculatorDragPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      const outline = calculator?.querySelector('.calculator-drag-outline');
      if (!(calculator instanceof HTMLElement) || !(outline instanceof HTMLElement)) return null;
      const windowRect = calculator.getBoundingClientRect();
      const outlineRect = outline.getBoundingClientRect();
      return {
        windowLeft: windowRect.left,
        windowTop: windowRect.top,
        outlineLeft: outlineRect.left,
        outlineTop: outlineRect.top
      };
    })()`,
    true,
  )) as {
    windowLeft: number;
    windowTop: number;
    outlineLeft: number;
    outlineTop: number;
  } | null;
  if (
    !calculatorDragPreview ||
    Math.abs(calculatorDragPreview.windowLeft - calculatorDragStart.window.left) > 1 ||
    Math.abs(calculatorDragPreview.windowTop - calculatorDragStart.window.top) > 1 ||
    Math.abs(calculatorDragPreview.outlineLeft - (calculatorDragStart.window.left + 47)) > 2 ||
    Math.abs(calculatorDragPreview.outlineTop - (calculatorDragStart.window.top + 31)) > 2
  ) {
    throw new Error(
      `Calculator drag outline did not track correctly: ${JSON.stringify(calculatorDragPreview)}.`,
    );
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...calculatorDragEnd,
  });
  await pause(40);
  const calculatorDragCommitted = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      if (!(calculator instanceof HTMLElement)) return null;
      const rect = calculator.getBoundingClientRect();
      return { left: rect.left, top: rect.top, outlineGone: !calculator.querySelector('.calculator-drag-outline') };
    })()`,
    true,
  )) as { left: number; top: number; outlineGone: boolean } | null;
  if (
    !calculatorDragCommitted ||
    Math.abs(calculatorDragCommitted.left - (calculatorDragStart.window.left + 48)) > 1 ||
    Math.abs(calculatorDragCommitted.top - (calculatorDragStart.window.top + 32)) > 1 ||
    !calculatorDragCommitted.outlineGone
  ) {
    throw new Error(
      `Calculator did not redraw at its release position: ${JSON.stringify(calculatorDragCommitted)}.`,
    );
  }

  await window.webContents.executeJavaScript(
    `(() => {
      for (const key of ['7', '*', '6', '=']) {
        document.querySelector('[data-calculator-key="' + key + '"]')?.click();
      }
    })()`,
    true,
  );
  await pause(40);
  const clickedCalculatorResult = await window.webContents.executeJavaScript(
    "document.querySelector('[data-calculator-display]')?.textContent?.trim()",
    true,
  );
  if (clickedCalculatorResult !== '42') {
    throw new Error(`Calculator button input returned ${String(clickedCalculatorResult)}.`);
  }

  await window.webContents.executeJavaScript(
    `(() => {
      for (const key of ['c', '1', '2', '+', '3', 'Enter']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      }
    })()`,
    true,
  );
  await pause(40);
  const keyboardCalculatorResult = await window.webContents.executeJavaScript(
    "document.querySelector('[data-calculator-display]')?.textContent?.trim()",
    true,
  );
  if (keyboardCalculatorResult !== '15') {
    throw new Error(`Calculator keyboard input returned ${String(keyboardCalculatorResult)}.`);
  }

  const finderInactiveWithCalculator = await window.webContents.executeJavaScript(
    "document.querySelector('.finder-window.is-active') === null",
    true,
  );
  if (!finderInactiveWithCalculator) {
    throw new Error('A Finder window remained visually active beneath Calculator.');
  }
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="system"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="about"]\')?.click()',
    true,
  );
  await pause(40);
  const modalCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('[data-menu="system"]');
      const content = document.querySelector(
        '[data-finder-window="window-system-disk"] .window-content'
      );
      if (!(menu instanceof HTMLElement) || !(content instanceof HTMLElement)) return null;
      const menuBounds = menu.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      return {
        menu: {
          x: Math.round(menuBounds.left + menuBounds.width / 2),
          y: Math.round(menuBounds.top + menuBounds.height / 2)
        },
        drop: {
          x: Math.round(contentBounds.left + contentBounds.width * 0.88),
          y: Math.round(contentBounds.top + contentBounds.height * 0.82)
        }
      };
    })()`,
    true,
  )) as { menu: { x: number; y: number }; drop: { x: number; y: number } } | null;
  if (!modalCoordinates) {
    throw new Error('The menu and Finder drop surface could not be located beneath the dialog.');
  }

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '7' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '7' });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Tab',
    modifiers: ['shift'],
  });
  window.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'Tab',
    modifiers: ['shift'],
  });
  window.webContents.sendInputEvent({ type: 'mouseMove', ...modalCoordinates.menu });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...modalCoordinates.menu,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...modalCoordinates.menu,
  });
  window.webContents.debugger.attach('1.3');
  try {
    const dragData = { items: [], files: [importDocument], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
        type,
        ...modalCoordinates.drop,
        data: dragData,
      });
    }
  } finally {
    window.webContents.debugger.detach();
  }
  await pause(280);
  const modalPrecedence = (await window.webContents.executeJavaScript(
    `(() => {
      const layer = document.querySelector('[data-modal-layer="dialog"]');
      return {
        aboutOpen: document.querySelector('[aria-label="About This Macintosh"]') !== null,
        calculatorDisplay: document.querySelector('[data-calculator-display]')?.textContent?.trim(),
        dropBlocked:
          document.querySelector('[data-vfs-item="welcome"]') !== null &&
          [...document.querySelectorAll('[data-vfs-item]')].every(
            (item) => !item.textContent?.includes('Dropped Note.txt')
          ),
        focusContained: layer instanceof HTMLElement && layer.contains(document.activeElement),
        menuBlocked:
          document.querySelector('[data-menu="system"]')?.getAttribute('aria-expanded') === 'false',
        vfsCount: Number(
          document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0
        )
      };
    })()`,
    true,
  )) as {
    aboutOpen: boolean;
    calculatorDisplay: string | undefined;
    dropBlocked: boolean;
    focusContained: boolean;
    menuBlocked: boolean;
    vfsCount: number;
  } | null;
  if (
    !modalPrecedence?.aboutOpen ||
    modalPrecedence.calculatorDisplay !== '15' ||
    !modalPrecedence.dropBlocked ||
    !modalPrecedence.focusContained ||
    !modalPrecedence.menuBlocked ||
    modalPrecedence.vfsCount !== initialVfsCount
  ) {
    throw new Error(`Dialog did not retain input precedence: ${JSON.stringify(modalPrecedence)}.`);
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(40);
  const dialogDismissedToCalculator = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="About This Macintosh"]') === null &&
      document.querySelector('[data-calculator-window="true"]') !== null`,
    true,
  );
  if (!dialogDismissedToCalculator) {
    throw new Error('Escape did not dismiss the dialog back to Calculator.');
  }
  for (const keyCode of ['C', '9']) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  await pause(60);
  const resumedCalculatorResult = await window.webContents.executeJavaScript(
    "document.querySelector('[data-calculator-display]')?.textContent?.trim()",
    true,
  );
  if (resumedCalculatorResult !== '9') {
    throw new Error('Calculator keyboard ownership did not resume after the dialog closed.');
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(40);
  const calculatorClosed = await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-calculator-window="true"]\') === null',
    true,
  );
  if (!calculatorClosed) throw new Error('Calculator did not close with Escape.');

  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="file"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="new-folder"]\')?.click()',
    true,
  );
  await pause(80);
  const menuVfsCount = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  if (menuVfsCount !== initialVfsCount + 1) {
    throw new Error('File > New Folder did not update the virtual filesystem.');
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['meta'] });
  await pause(80);
  const shortcutVfsCount = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  if (shortcutVfsCount !== initialVfsCount + 2) {
    throw new Error('Command-N did not use the New Folder menu action.');
  }

  const importDropPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const content = document.querySelector(
        '[data-finder-window="window-system-disk"] .window-content'
      );
      if (!(content instanceof HTMLElement)) return null;
      const rect = content.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width * 0.82),
        y: Math.round(rect.top + rect.height * 0.82)
      };
    })()`,
    true,
  )) as { x: number; y: number } | null;
  if (!importDropPoint) throw new Error('Smoke test could not locate the external drop surface.');

  window.webContents.debugger.attach('1.3');
  try {
    const dragData = {
      items: [],
      files: [importDocument, importFolder],
      dragOperationsMask: 1,
    };
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      type: 'dragEnter',
      ...importDropPoint,
      data: dragData,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      type: 'dragOver',
      ...importDropPoint,
      data: dragData,
    });
    await pause(40);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['meta'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['meta'] });
    await pause(60);
    const dragOwnedVfsCount = (await window.webContents.executeJavaScript(
      "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
      true,
    )) as number;
    if (dragOwnedVfsCount !== shortcutVfsCount) {
      throw new Error('Command-N escaped an active external file drag.');
    }
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      type: 'drop',
      ...importDropPoint,
      data: dragData,
    });
  } finally {
    window.webContents.debugger.detach();
  }
  await pause(280);

  const externalImport = (await window.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('[data-vfs-item]')];
      const names = items.map((item) => item.textContent?.trim() ?? '');
      return {
        documentVisible: names.some((name) => name.includes('Dropped Note.txt')),
        folderVisible: names.some((name) => name.includes('Drop Folder')),
        notice: document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? ''
      };
    })()`,
    true,
  )) as { documentVisible: boolean; folderVisible: boolean; notice: string };
  if (!externalImport.documentVisible || !externalImport.folderVisible) {
    throw new Error(`External file/folder drop failed: ${JSON.stringify(externalImport)}.`);
  }
  if (!externalImport.notice.startsWith('Copied 3 items to System Disk.')) {
    throw new Error(`External drop did not report its result: ${externalImport.notice}.`);
  }

  const clipboardPasteHandled = await window.webContents.executeJavaScript(
    `(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'This document arrived through Paste.');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()`,
    true,
  );
  if (!clipboardPasteHandled) throw new Error('Plain-text document paste was not handled.');
  await pause(100);

  const selectedImport = await window.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll('[data-vfs-item]')].find(
        (candidate) => candidate.textContent?.includes('Dropped Note.txt')
      );
      if (!(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()`,
    true,
  );
  if (!selectedImport) throw new Error('Imported document could not be selected for Copy/Paste.');
  await pause(50);
  await window.webContents.executeJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }))",
    true,
  );
  await pause(50);
  await window.webContents.executeJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true }))",
    true,
  );
  await pause(120);

  const pastedDocuments = (await window.webContents.executeJavaScript(
    `(() => {
      const names = [...document.querySelectorAll('[data-vfs-item]')].map(
        (item) => item.textContent?.trim() ?? ''
      );
      return {
        clipboard: names.some((name) => name.includes('Clipboard')),
        duplicated: names.some((name) => name.includes('Dropped Note copy.txt'))
      };
    })()`,
    true,
  )) as { clipboard: boolean; duplicated: boolean };
  if (!pastedDocuments.clipboard || !pastedDocuments.duplicated) {
    throw new Error(`Document Copy/Paste failed: ${JSON.stringify(pastedDocuments)}.`);
  }

  const freeIconPlacement = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-vfs-item="applications"]');
      const canvas = document.querySelector('[data-icon-layout-parent="system-disk"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const sourceRect = source.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const hotspot = { x: 31, y: 19 };
      const destination = { x: 441, y: 239 };
      const client = {
        x: Math.round(canvasRect.left + destination.x + hotspot.x),
        y: Math.round(canvasRect.top + destination.y + hotspot.y)
      };
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {
        dataTransfer: data,
        clientX: Math.round(sourceRect.left + hotspot.x),
        clientY: Math.round(sourceRect.top + hotspot.y),
        bubbles: true,
        cancelable: true
      }));
      canvas.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data,
        clientX: client.x,
        clientY: client.y,
        bubbles: true,
        cancelable: true
      }));
      const highlighted = canvas.classList.contains('is-file-drop-target');
      canvas.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data,
        clientX: client.x,
        clientY: client.y,
        bubbles: true,
        cancelable: true
      }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return {
        highlighted,
        payload: data.getData('application/x-macintosh-vfs-node-ids'),
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { highlighted: boolean; payload: string; vfsCount: number } | null;
  if (!freeIconPlacement?.payload || !freeIconPlacement.highlighted) {
    throw new Error(
      `Free Finder placement did not use the internal drag surface: ${JSON.stringify(freeIconPlacement)}.`,
    );
  }
  await pause(100);
  const placedIcon = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-vfs-item="applications"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        x: Number(source.dataset.iconX),
        y: Number(source.dataset.iconY),
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { x: number; y: number; vfsCount: number } | null;
  if (
    !placedIcon ||
    placedIcon.x !== 441 ||
    placedIcon.y !== 239 ||
    placedIcon.vfsCount !== freeIconPlacement.vfsCount
  ) {
    throw new Error(`Finder icon did not commit its free position: ${JSON.stringify(placedIcon)}.`);
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu="view"]')?.click()`,
    true,
  );
  await pause(20);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu-action="view-list"]')?.click()`,
    true,
  );
  await pause(60);
  const listViewVisible = await window.webContents.executeJavaScript(
    `document.querySelector('[data-finder-window="window-system-disk"] .finder-list') !== null`,
    true,
  );
  if (!listViewVisible) throw new Error('View by Name did not replace the free icon canvas.');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu="view"]')?.click()`,
    true,
  );
  await pause(20);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu-action="view-icons"]')?.click()`,
    true,
  );
  await pause(60);
  const restoredIconPosition = await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-vfs-item="applications"]');
      return source instanceof HTMLElement && Number(source.dataset.iconX) === 441 && Number(source.dataset.iconY) === 239;
    })()`,
    true,
  );
  if (!restoredIconPosition) {
    throw new Error('Returning to icon view did not restore the free Finder position.');
  }

  const importCaptureDestination = process.env.MACINTOSH_SMOKE_IMPORT_CAPTURE_PATH;
  if (importCaptureDestination) {
    const image = await window.webContents.capturePage();
    await mkdir(path.dirname(importCaptureDestination), { recursive: true });
    await writeFile(importCaptureDestination, image.toPNG());
  }

  const internalFolderDrop = (await window.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('[data-vfs-item]')];
      const source = items.find((item) => item.textContent?.includes('Drop Folder'));
      const destination = document.querySelector('[data-vfs-item="documents"]');
      if (!(source instanceof HTMLElement) || !(destination instanceof HTMLElement)) return null;
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {
        dataTransfer: data,
        bubbles: true,
        cancelable: true
      }));
      destination.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data,
        bubbles: true,
        cancelable: true
      }));
      const highlighted = destination.classList.contains('is-file-drop-target');
      destination.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data,
        bubbles: true,
        cancelable: true
      }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return {
        highlighted,
        payload: data.getData('application/x-macintosh-vfs-node-ids')
      };
    })()`,
    true,
  )) as { highlighted: boolean; payload: string } | null;
  if (!internalFolderDrop?.payload || !internalFolderDrop.highlighted) {
    throw new Error(
      `Internal folder drag did not create and accept its payload: ${JSON.stringify(internalFolderDrop)}.`,
    );
  }
  await pause(120);
  const movedFolderHidden = await window.webContents.executeJavaScript(
    `![...document.querySelectorAll('[data-vfs-item]')].some(
      (item) => item.textContent?.includes('Drop Folder')
    )`,
    true,
  );
  if (!movedFolderHidden) throw new Error('Internal folder drop did not move the folder.');

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
  await pause(60);
  const commandAfterInternalDrop = (await window.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )];
      return items.length > 0 && items.every((item) => item.classList.contains('is-selected'));
    })()`,
    true,
  )) as boolean;
  if (!commandAfterInternalDrop) {
    throw new Error('Finder command ownership did not resume after an internal drop.');
  }

  const applicationsOpened = await window.webContents.executeJavaScript(
    `(() => {
      const applications = document.querySelector('[data-vfs-item="applications"]');
      if (!(applications instanceof HTMLElement)) return false;
      applications.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!applicationsOpened) throw new Error('Smoke test could not open Applications.');
  await pause(80);

  const windowDragStart = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const handle = finder?.querySelector('[data-window-drag-handle="true"]');
      const releaseWindow = document.querySelector(
        '[data-finder-window="window-system-disk"]'
      );
      if (
        !(finder instanceof HTMLElement) ||
        !(handle instanceof HTMLElement) ||
        !(releaseWindow instanceof HTMLElement)
      ) return null;
      const windowRect = finder.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const releaseRect = releaseWindow.getBoundingClientRect();
      handle.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokePointerId = event.pointerId; },
        { once: true }
      );
      return {
        window: { left: windowRect.left, top: windowRect.top },
        pointer: {
          x: Math.round(handleRect.left + handleRect.width / 2),
          y: Math.round(handleRect.top + handleRect.height / 2)
        },
        release: {
          x: Math.round(releaseRect.left + releaseRect.width * 0.72),
          y: Math.round(releaseRect.top + handleRect.height / 2)
        }
      };
    })()`,
    true,
  )) as {
    window: { left: number; top: number };
    pointer: { x: number; y: number };
    release: { x: number; y: number };
  } | null;
  if (!windowDragStart) throw new Error('Smoke test could not locate the Finder title bar.');

  const windowDragEnd = windowDragStart.release;
  const windowDragDelta = {
    x: windowDragEnd.x - windowDragStart.pointer.x,
    y: windowDragEnd.y - windowDragStart.pointer.y,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...windowDragStart.pointer });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...windowDragStart.pointer,
  });
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        windowDragStart.pointer.x + (windowDragEnd.x - windowDragStart.pointer.x) * progress,
      ),
      y: Math.round(
        windowDragStart.pointer.y + (windowDragEnd.y - windowDragStart.pointer.y) * progress,
      ),
    });
    await pause(18);
  }
  await pause(60);

  const windowDragPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const shadow = finder?.querySelector('.window-drag-shadow');
      const releaseWindow = document.querySelector(
        '[data-finder-window="window-system-disk"]'
      );
      if (
        !(finder instanceof HTMLElement) ||
        !(shadow instanceof HTMLElement) ||
        !(releaseWindow instanceof HTMLElement)
      ) return null;
      const windowRect = finder.getBoundingClientRect();
      const shadowRect = shadow.getBoundingClientRect();
      const releaseRect = releaseWindow.getBoundingClientRect();
      return {
        windowLeft: windowRect.left,
        windowTop: windowRect.top,
        shadowLeft: shadowRect.left,
        shadowTop: shadowRect.top,
        shadowVisible: getComputedStyle(shadow).display !== 'none',
        dragging: finder.dataset.windowDragging === 'true',
        overlapsReleaseWindow:
          shadowRect.left < releaseRect.right &&
          shadowRect.right > releaseRect.left &&
          shadowRect.top < releaseRect.bottom &&
          shadowRect.bottom > releaseRect.top
      };
    })()`,
    true,
  )) as {
    windowLeft: number;
    windowTop: number;
    shadowLeft: number;
    shadowTop: number;
    shadowVisible: boolean;
    dragging: boolean;
    overlapsReleaseWindow: boolean;
  } | null;
  if (!windowDragPreview) throw new Error('Finder drag preview could not be inspected.');
  if (
    Math.abs(windowDragPreview.windowLeft - windowDragStart.window.left) > 1 ||
    Math.abs(windowDragPreview.windowTop - windowDragStart.window.top) > 1
  ) {
    throw new Error('The full Finder window moved before the title-bar drag was released.');
  }
  if (
    !windowDragPreview.shadowVisible ||
    !windowDragPreview.dragging ||
    !windowDragPreview.overlapsReleaseWindow
  ) {
    throw new Error('The 1-bit Finder drag shadow did not overlap the rendered release window.');
  }
  if (
    Math.abs(windowDragPreview.shadowLeft - (windowDragStart.window.left + windowDragDelta.x - 1)) >
      2 ||
    Math.abs(windowDragPreview.shadowTop - (windowDragStart.window.top + windowDragDelta.y - 1)) > 2
  ) {
    throw new Error(
      `The Finder drag shadow did not follow the pointer: ${JSON.stringify({ windowDragStart, windowDragPreview })}`,
    );
  }

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  await pause(60);
  const windowDragRetainedOwnership = await window.webContents.executeJavaScript(
    `document.querySelector('[data-finder-window="window-applications"]')
      ?.getAttribute('data-window-dragging') === 'true'`,
    true,
  );
  if (!windowDragRetainedOwnership) {
    throw new Error('Command-W escaped the active Finder window drag session.');
  }

  const dragCaptureDestination = process.env.MACINTOSH_SMOKE_DRAG_CAPTURE_PATH;
  if (dragCaptureDestination) {
    const image = await window.webContents.capturePage();
    await mkdir(path.dirname(dragCaptureDestination), { recursive: true });
    await writeFile(dragCaptureDestination, image.toPNG());
  }

  const releasedCapture = (await window.webContents.executeJavaScript(
    `(() => {
      const handle = document.querySelector(
        '[data-finder-window="window-applications"] [data-window-drag-handle="true"]'
      );
      const pointerId = window.__macintoshSmokePointerId;
      const releaseElement = document.elementFromPoint(${windowDragEnd.x}, ${windowDragEnd.y});
      const releaseTarget = releaseElement
        ?.closest('[data-finder-window]')
        ?.getAttribute('data-finder-window');
      if (!(handle instanceof HTMLElement) || typeof pointerId !== 'number') return null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      return {
        captureReleased: !handle.hasPointerCapture(pointerId),
        releaseTarget,
        releaseOnDragHandle:
          releaseElement?.closest('[data-window-drag-handle="true"]') !== null
      };
    })()`,
    true,
  )) as {
    captureReleased: boolean;
    releaseTarget: string | null;
    releaseOnDragHandle: boolean;
  } | null;
  if (
    !releasedCapture?.captureReleased ||
    releasedCapture.releaseOnDragHandle ||
    releasedCapture.releaseTarget === null
  ) {
    throw new Error(
      `Smoke test could not reproduce lost capture over a Finder window: ${JSON.stringify(releasedCapture)}`,
    );
  }

  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...windowDragEnd,
  });
  await pause(80);

  const windowDragCommitted = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const shadow = finder?.querySelector('.window-drag-shadow');
      if (!(finder instanceof HTMLElement) || !(shadow instanceof HTMLElement)) return null;
      const rect = finder.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        shadowHidden: getComputedStyle(shadow).display === 'none',
        draggingCleared: finder.dataset.windowDragging === undefined
      };
    })()`,
    true,
  )) as {
    left: number;
    top: number;
    shadowHidden: boolean;
    draggingCleared: boolean;
  } | null;
  if (!windowDragCommitted) throw new Error('Committed Finder geometry could not be inspected.');
  if (
    Math.abs(windowDragCommitted.left - (windowDragStart.window.left + windowDragDelta.x)) > 1 ||
    Math.abs(windowDragCommitted.top - (windowDragStart.window.top + windowDragDelta.y)) > 1
  ) {
    throw new Error(
      'The full Finder window did not redraw after capture was lost over another window.',
    );
  }
  if (!windowDragCommitted.shadowHidden || !windowDragCommitted.draggingCleared) {
    throw new Error('The Finder drag shadow did not clear after release.');
  }

  const dragAfterCaptureDestination = process.env.MACINTOSH_SMOKE_DRAG_AFTER_CAPTURE_PATH;
  if (dragAfterCaptureDestination) {
    const image = await window.webContents.capturePage();
    await mkdir(path.dirname(dragAfterCaptureDestination), { recursive: true });
    await writeFile(dragAfterCaptureDestination, image.toPNG());
  }

  const coordinates = (await window.webContents.executeJavaScript(
    `(() => {
    const disk = document.querySelector('[data-desktop-icon="system-disk"]');
    const trash = document.querySelector('[data-desktop-icon="trash"]');
    if (!(disk instanceof HTMLElement) || !(trash instanceof HTMLElement)) return null;
    const d = disk.getBoundingClientRect();
    const t = trash.getBoundingClientRect();
    return {
      disk: { x: Math.round(d.left + d.width / 2), y: Math.round(d.top + d.height / 2) },
      trash: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) }
    };
  })()`,
    true,
  )) as { disk: { x: number; y: number }; trash: { x: number; y: number } } | null;

  if (!coordinates) throw new Error('Smoke test could not locate desktop icons.');

  const sendDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    verifyFollowing: boolean,
  ): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });

    for (let step = 1; step <= 12; step += 1) {
      const progress = step / 12;
      const pointer = {
        x: Math.round(from.x + (to.x - from.x) * progress),
        y: Math.round(from.y + (to.y - from.y) * progress),
      };
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        button: 'left',
        modifiers: ['leftbuttondown'],
        ...pointer,
      });
      await pause(22);
      if (verifyFollowing && step === 6) {
        const distance = (await window.webContents.executeJavaScript(
          `(() => {
            const disk = document.querySelector('[data-desktop-icon="system-disk"]');
            if (!(disk instanceof HTMLElement)) return 9999;
            const rect = disk.getBoundingClientRect();
            return Math.hypot(rect.left + rect.width / 2 - ${pointer.x}, rect.top + rect.height / 2 - ${pointer.y});
          })()`,
          true,
        )) as number;
        if (distance > 12) throw new Error('System Disk did not follow the pointer during drag.');
      }
    }

    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...to,
    });
  };

  await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return;
      trash.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokeTrashPointerId = event.pointerId; },
        { once: true }
      );
    })()`,
    true,
  );
  const cancelledTrashTarget = {
    x: coordinates.trash.x - 112,
    y: coordinates.trash.y - 48,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates.trash });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...coordinates.trash,
  });
  for (let step = 1; step <= 4; step += 1) {
    const progress = step / 4;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        coordinates.trash.x + (cancelledTrashTarget.x - coordinates.trash.x) * progress,
      ),
      y: Math.round(
        coordinates.trash.y + (cancelledTrashTarget.y - coordinates.trash.y) * progress,
      ),
    });
    await pause(16);
  }
  const trashPreviewMoved = await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return false;
      const rect = trash.getBoundingClientRect();
      return Math.hypot(
        rect.left + rect.width / 2 - ${coordinates.trash.x},
        rect.top + rect.height / 2 - ${coordinates.trash.y}
      ) > 40 && trash.classList.contains('is-dragging');
    })()`,
    true,
  );
  if (!trashPreviewMoved) throw new Error('Trash did not enter a movable preview before cancel.');
  await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const pointerId = window.__macintoshSmokeTrashPointerId;
      if (!(trash instanceof HTMLElement) || typeof pointerId !== 'number') return false;
      return trash.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId, pointerType: 'mouse', bubbles: true
      }));
    })()`,
    true,
  );
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...cancelledTrashTarget,
  });
  await pause(40);
  const trashCancelRestored = await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return false;
      const rect = trash.getBoundingClientRect();
      return Math.hypot(
        rect.left + rect.width / 2 - ${coordinates.trash.x},
        rect.top + rect.height / 2 - ${coordinates.trash.y}
      ) <= 2 && !trash.classList.contains('is-dragging');
    })()`,
    true,
  );
  if (!trashCancelRestored) throw new Error('Cancelled Trash drag committed its preview.');

  await pause(260);
  smokeSaveFailuresRemaining = 1;
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="special"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="clean-desktop"]\')?.click()',
    true,
  );
  await pause(20);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates.disk });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...coordinates.disk,
  });
  for (let step = 1; step <= 8; step += 1) {
    const progress = step / 8;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(coordinates.disk.x + (coordinates.trash.x - coordinates.disk.x) * progress),
      y: Math.round(coordinates.disk.y + (coordinates.trash.y - coordinates.disk.y) * progress),
    });
    await pause(16);
  }
  let saveFailureAlertOpened = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    saveFailureAlertOpened = (await window.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="Persistence error"]\') !== null',
      true,
    )) as boolean;
    if (saveFailureAlertOpened) break;
    await pause(30);
  }
  if (!saveFailureAlertOpened) {
    throw new Error('Injected save failure did not present its persistence alert.');
  }
  const failedSaveCancelledCapture = await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      if (!(disk instanceof HTMLElement)) return false;
      const bounds = disk.getBoundingClientRect();
      return !disk.classList.contains('is-dragging') &&
        Math.hypot(
          bounds.left + bounds.width / 2 - ${coordinates.disk.x},
          bounds.top + bounds.height / 2 - ${coordinates.disk.y}
        ) <= 2;
    })()`,
    true,
  );
  if (!failedSaveCancelledCapture) {
    throw new Error('Persistence alert did not cancel the captured System Disk drag.');
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...coordinates.trash,
  });
  await pause(100);
  const failedSaveStayedModal = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Persistence error"]') !== null &&
      document.querySelector('[data-desktop-icon="system-disk"]')
        ?.classList.contains('is-ejecting') === false`,
    true,
  );
  if (!failedSaveStayedModal || quitRequested) {
    throw new Error('Release beneath the persistence alert started an ejection.');
  }
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="Persistence error"] button\')?.click()',
    true,
  );
  await pause(40);

  const repositionTarget = { x: 137, y: 343 };
  await sendDrag(coordinates.disk, repositionTarget, true);
  await pause(260);
  const diskPositionCommitted = await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(disk instanceof HTMLElement) || !(trash instanceof HTMLElement)) return false;
      const rect = disk.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - ${repositionTarget.x}, rect.top + rect.height / 2 - ${repositionTarget.y});
      return distance <= 2 && !trash.classList.contains('is-drop-target');
    })()`,
    true,
  );
  if (!diskPositionCommitted) {
    throw new Error('System Disk did not remain at its free desktop position.');
  }
  coordinates.disk = repositionTarget;

  window.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates.disk });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...coordinates.disk,
  });
  for (let step = 1; step <= 12; step += 1) {
    const progress = step / 12;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(coordinates.disk.x + (coordinates.trash.x - coordinates.disk.x) * progress),
      y: Math.round(coordinates.disk.y + (coordinates.trash.y - coordinates.disk.y) * progress),
    });
    await pause(22);
  }

  await pause(100);
  const trashIsActive = await window.webContents.executeJavaScript(
    "document.querySelector('[data-desktop-icon=\"trash\"]')?.classList.contains('is-drop-target') === true",
    true,
  );
  if (!trashIsActive) throw new Error('Trash did not enter its valid-drop hover state.');

  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...coordinates.trash,
  });

  await pause(55);
  const ejectAnimationStarted = await window.webContents.executeJavaScript(
    "document.querySelector('[data-desktop-icon=\"system-disk\"]')?.classList.contains('is-ejecting') === true",
    true,
  );
  if (!ejectAnimationStarted) throw new Error('Disk eject animation did not start.');

  setTimeout(() => {
    if (!quitRequested) {
      console.error('Disk-to-Trash gesture did not request application quit.');
      app.exit(1);
    }
  }, 8_000);
};

const runPersistenceProbe = async (window: BrowserWindow): Promise<void> => {
  await waitForRenderer(window);
  const proof = await window.webContents.executeJavaScript(
    `(() => {
    const disk = document.querySelector('[data-desktop-icon="system-disk"]');
    const root = document.querySelector('[data-vfs-count]');
    const finder = document.querySelector('[data-finder-window="window-applications"]');
    const applications = document.querySelector('[data-vfs-item="applications"]');
    if (!(disk instanceof HTMLElement) || !(root instanceof HTMLElement) || !(finder instanceof HTMLElement) || !(applications instanceof HTMLElement)) return null;
    const rect = disk.getBoundingClientRect();
    return {
      loaded: document.body.dataset.stateLoaded === 'true',
      diskLabel: disk.getAttribute('aria-label'),
      diskVisible: rect.width > 0 && rect.height > 0,
      diskX: Number.parseFloat(disk.style.getPropertyValue('--icon-x')),
      diskY: Number.parseFloat(disk.style.getPropertyValue('--icon-y')),
      applicationsX: Number(applications.dataset.iconX),
      applicationsY: Number(applications.dataset.iconY),
      vfsCount: Number(root.dataset.vfsCount || 0),
      windowLeft: Number.parseFloat(finder.style.left),
      windowTop: Number.parseFloat(finder.style.top)
    };
  })()`,
    true,
  );

  const destination = path.join(app.getPath('userData'), PROBE_FILE_NAME);
  await writeFile(destination, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  app.quit();
};

const captureScreen = async (window: BrowserWindow, destination: string): Promise<void> => {
  await waitForRenderer(window);
  if (captureAboutMode) {
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu="system"]\')?.click()',
      true,
    );
    await pause(60);
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu-action="about"]\')?.click()',
      true,
    );
  }
  if (captureCalculatorMode) {
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu="system"]\')?.click()',
      true,
    );
    await pause(60);
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu-action="calculator"]\')?.click()',
      true,
    );
    await pause(60);
    await window.webContents.executeJavaScript(
      `(() => {
        for (const key of ['7', '*', '6', '=']) {
          document.querySelector('[data-calculator-key="' + key + '"]')?.click();
        }
      })()`,
      true,
    );
  }
  await pause(300);
  const image = await window.webContents.capturePage();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, image.toPNG());
  app.quit();
};

const captureStartup = async (window: BrowserWindow, destination: string): Promise<void> => {
  await pause(1_900);
  const image = await window.webContents.capturePage();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, image.toPNG());
  app.quit();
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1152,
    height: 768,
    minWidth: 800,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    title: APP_NAME,
    icon: getApplicationIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const indexPath = path.join(__dirname, '../../renderer/index.html');
  await mainWindow.loadFile(indexPath, {
    query: automationMode ? { automation: '1' } : undefined,
  });

  if (smokeMode) {
    void runSmokeDrag(mainWindow).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  } else if (persistenceProbeMode) {
    void runPersistenceProbe(mainWindow).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  } else if (captureArgument) {
    const destination = path.resolve(captureArgument.slice('--capture-screen='.length));
    void captureScreen(mainWindow, destination).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  } else if (captureStartupArgument) {
    const destination = path.resolve(captureStartupArgument.slice('--capture-startup='.length));
    void captureStartup(mainWindow, destination).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }
};

app.whenReady().then(async () => {
  const icon = getApplicationIcon();
  if (process.platform === 'darwin') app.dock?.setIcon(icon);
  installApplicationMenu();
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
