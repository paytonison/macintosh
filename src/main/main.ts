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

  type SmokePoint = { x: number; y: number };
  const clickAt = async (point: SmokePoint): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await pause(20);
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await pause(40);
  };
  const assertPixelCursor = (
    label: string,
    value: string,
    width: number,
    height: number,
    hotspot: SmokePoint,
  ): void => {
    let decoded = '';
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // The assertion below reports the invalid computed value.
    }
    if (
      !decoded.includes(`width="${width}" height="${height}"`) ||
      !decoded.includes('<rect ') ||
      !value.includes(`) ${hotspot.x} ${hotspot.y}`)
    ) {
      throw new Error(`${label} did not use its tested pixel cursor and hotspot.`);
    }
  };

  const cursorBindings = (await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      const finder = document.querySelector('[data-finder-window="window-system-disk"]');
      const titlebar = finder?.querySelector('[data-window-drag-handle="true"]');
      const close = finder?.querySelector('[aria-label="Close System Disk"]');
      const grow = finder?.querySelector('[aria-label="Resize System Disk"]');
      if (!(disk instanceof HTMLElement) || !(titlebar instanceof HTMLElement) || !(close instanceof HTMLElement) || !(grow instanceof HTMLElement)) return null;
      return {
        body: getComputedStyle(document.body).cursor,
        desktopIcon: getComputedStyle(disk).cursor,
        titlebar: getComputedStyle(titlebar).cursor,
        windowControl: getComputedStyle(close).cursor,
        growBox: getComputedStyle(grow).cursor
      };
    })()`,
    true,
  )) as {
    body: string;
    desktopIcon: string;
    titlebar: string;
    windowControl: string;
    growBox: string;
  } | null;
  if (!cursorBindings) throw new Error('Pixel cursor bindings could not be inspected.');
  assertPixelCursor('Desktop arrow', cursorBindings.body, 11, 16, { x: 1, y: 1 });
  assertPixelCursor('Desktop icon grab', cursorBindings.desktopIcon, 16, 16, { x: 7, y: 8 });
  assertPixelCursor('Window title-bar grab', cursorBindings.titlebar, 16, 16, { x: 7, y: 8 });
  assertPixelCursor('Window control arrow', cursorBindings.windowControl, 11, 16, { x: 1, y: 1 });
  assertPixelCursor('Window resize', cursorBindings.growBox, 15, 15, { x: 7, y: 7 });

  type SmokeWindowGeometry = {
    left: number;
    top: number;
    width: number;
    height: number;
    zoom: SmokePoint;
    grow: SmokePoint;
  };
  const readSystemWindowGeometry = async (): Promise<SmokeWindowGeometry | null> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const finder = document.querySelector('[data-finder-window="window-system-disk"]');
        const zoom = finder?.querySelector('[aria-label="Zoom System Disk"]');
        const grow = finder?.querySelector('[aria-label="Resize System Disk"]');
        if (!(finder instanceof HTMLElement) || !(zoom instanceof HTMLElement) || !(grow instanceof HTMLElement)) return null;
        const frame = finder.getBoundingClientRect();
        const zoomBounds = zoom.getBoundingClientRect();
        const growBounds = grow.getBoundingClientRect();
        return {
          left: frame.left,
          top: frame.top,
          width: frame.width,
          height: frame.height,
          zoom: { x: Math.round(zoomBounds.left + zoomBounds.width / 2), y: Math.round(zoomBounds.top + zoomBounds.height / 2) },
          grow: { x: Math.round(growBounds.left + growBounds.width / 2), y: Math.round(growBounds.top + growBounds.height / 2) }
        };
      })()`,
      true,
    )) as SmokeWindowGeometry | null;
  const originalWindow = await readSystemWindowGeometry();
  if (!originalWindow) throw new Error('System Disk controls could not be located.');

  await clickAt(originalWindow.zoom);
  const zoomedWindow = await readSystemWindowGeometry();
  if (
    !zoomedWindow ||
    (Math.abs(zoomedWindow.width - originalWindow.width) < 10 &&
      Math.abs(zoomedWindow.height - originalWindow.height) < 10)
  ) {
    throw new Error('The Finder zoom control did not change window geometry.');
  }
  await clickAt(zoomedWindow.zoom);
  const restoredWindow = await readSystemWindowGeometry();
  if (
    !restoredWindow ||
    Math.abs(restoredWindow.left - originalWindow.left) > 1 ||
    Math.abs(restoredWindow.top - originalWindow.top) > 1 ||
    Math.abs(restoredWindow.width - originalWindow.width) > 1 ||
    Math.abs(restoredWindow.height - originalWindow.height) > 1
  ) {
    throw new Error('The Finder zoom control did not restore its original geometry.');
  }

  const resizeWindow = async (from: SmokePoint, to: SmokePoint): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
    await pause(20);
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...to,
    });
    await pause(40);
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...to,
    });
    await pause(60);
  };
  const resizeDelta = { x: 24, y: 16 };
  await resizeWindow(restoredWindow.grow, {
    x: restoredWindow.grow.x + resizeDelta.x,
    y: restoredWindow.grow.y + resizeDelta.y,
  });
  const resizedWindow = await readSystemWindowGeometry();
  if (
    !resizedWindow ||
    Math.abs(resizedWindow.width - (originalWindow.width + resizeDelta.x)) > 1 ||
    Math.abs(resizedWindow.height - (originalWindow.height + resizeDelta.y)) > 1
  ) {
    throw new Error('The Finder grow box did not resize from the pixel-cursor hotspot.');
  }
  await resizeWindow(resizedWindow.grow, {
    x: resizedWindow.grow.x - resizeDelta.x,
    y: resizedWindow.grow.y - resizeDelta.y,
  });
  const resizeRestoredWindow = await readSystemWindowGeometry();
  if (
    !resizeRestoredWindow ||
    Math.abs(resizeRestoredWindow.width - originalWindow.width) > 1 ||
    Math.abs(resizeRestoredWindow.height - originalWindow.height) > 1
  ) {
    throw new Error('The Finder grow box did not restore its original geometry.');
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

  const systemMenuPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('[data-menu="system"]');
      if (!(menu instanceof HTMLElement)) return null;
      const bounds = menu.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`,
    true,
  )) as SmokePoint | null;
  if (!systemMenuPoint) throw new Error('The System menu could not be located.');
  await clickAt(systemMenuPoint);
  const aboutMenuPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('[data-menu-action="about"]');
      if (!(item instanceof HTMLElement)) return null;
      const bounds = item.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`,
    true,
  )) as SmokePoint | null;
  if (!aboutMenuPoint) throw new Error('The About menu item could not be located.');
  await clickAt(aboutMenuPoint);
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
      const handle = calculator?.querySelector('[data-calculator-drag-handle="true"]');
      if (!(calculator instanceof HTMLElement) || !(outline instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      const windowRect = calculator.getBoundingClientRect();
      const outlineRect = outline.getBoundingClientRect();
      return {
        windowLeft: windowRect.left,
        windowTop: windowRect.top,
        outlineLeft: outlineRect.left,
        outlineTop: outlineRect.top,
        cursor: getComputedStyle(handle).cursor
      };
    })()`,
    true,
  )) as {
    windowLeft: number;
    windowTop: number;
    outlineLeft: number;
    outlineTop: number;
    cursor: string;
  } | null;
  if (calculatorDragPreview) {
    assertPixelCursor('Calculator drag', calculatorDragPreview.cursor, 16, 16, { x: 7, y: 7 });
  }
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
      const handle = finder?.querySelector('[data-window-drag-handle="true"]');
      const releaseWindow = document.querySelector(
        '[data-finder-window="window-system-disk"]'
      );
      if (
        !(finder instanceof HTMLElement) ||
        !(shadow instanceof HTMLElement) ||
        !(handle instanceof HTMLElement) ||
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
        cursor: getComputedStyle(handle).cursor,
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
    cursor: string;
    overlapsReleaseWindow: boolean;
  } | null;
  if (!windowDragPreview) throw new Error('Finder drag preview could not be inspected.');
  assertPixelCursor('Finder window drag', windowDragPreview.cursor, 16, 16, { x: 7, y: 7 });
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

  type ClientBounds = { left: number; right: number; top: number; bottom: number };
  type DesktopGeometry = {
    disk: { x: number; y: number };
    trash: { x: number; y: number };
    trashGlyph: ClientBounds;
    trashLabel: ClientBounds;
    trashTolerance: number;
    viewport: { width: number; height: number; devicePixelRatio: number };
  };
  const readDesktopGeometry = async (): Promise<DesktopGeometry | null> =>
    (await window.webContents.executeJavaScript(
      `(() => {
    const disk = document.querySelector('[data-desktop-icon="system-disk"]');
    const trash = document.querySelector('[data-desktop-icon="trash"]');
    const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
    const label = trash?.querySelector('[data-desktop-icon-label="trash"]');
    if (!(disk instanceof HTMLElement) || !(trash instanceof HTMLElement) || !(glyph instanceof Element) || !(label instanceof HTMLElement)) return null;
    const d = disk.getBoundingClientRect();
    const t = trash.getBoundingClientRect();
    const g = glyph.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    return {
      disk: { x: Math.round(d.left + d.width / 2), y: Math.round(d.top + d.height / 2) },
      trash: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) },
      trashGlyph: { left: g.left, right: g.right, top: g.top, bottom: g.bottom },
      trashLabel: { left: l.left, right: l.right, top: l.top, bottom: l.bottom },
      trashTolerance: Number(glyph.getAttribute('data-trash-drop-tolerance')),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }
    };
  })()`,
      true,
    )) as DesktopGeometry | null;

  let desktopGeometry = await readDesktopGeometry();
  const coordinates = desktopGeometry
    ? { disk: desktopGeometry.disk, trash: desktopGeometry.trash }
    : null;

  if (!coordinates) throw new Error('Smoke test could not locate desktop icons.');

  const moveHeldPointer = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps: number,
    verifyFollowing = false,
  ): Promise<void> => {
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
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
      if (verifyFollowing && step === Math.ceil(steps / 2)) {
        let distance = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          distance = (await window.webContents.executeJavaScript(
            `(() => {
              const disk = document.querySelector('[data-desktop-icon="system-disk"]');
              if (!(disk instanceof HTMLElement)) return 9999;
              const rect = disk.getBoundingClientRect();
              return Math.hypot(rect.left + rect.width / 2 - ${pointer.x}, rect.top + rect.height / 2 - ${pointer.y});
            })()`,
            true,
          )) as number;
          if (distance <= 12) break;
          await pause(15);
        }
        if (distance > 12) throw new Error('System Disk did not follow the pointer during drag.');
      }
    }
  };

  const beginDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    verifyFollowing: boolean,
  ): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
    await pause(25);
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    await pause(25);
    await moveHeldPointer(from, to, 12, verifyFollowing);
  };

  const releaseDrag = (to: { x: number; y: number }): void => {
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...to,
    });
  };

  const sendDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    verifyFollowing: boolean,
  ): Promise<void> => {
    await beginDrag(from, to, verifyFollowing);
    releaseDrag(to);
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
  const trashPreviewMoved = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return null;
      const rect = trash.getBoundingClientRect();
      return {
        moved: Math.hypot(
          rect.left + rect.width / 2 - ${coordinates.trash.x},
          rect.top + rect.height / 2 - ${coordinates.trash.y}
        ) > 40 && trash.classList.contains('is-dragging'),
        cursor: getComputedStyle(trash).cursor
      };
    })()`,
    true,
  )) as { moved: boolean; cursor: string } | null;
  if (!trashPreviewMoved?.moved) {
    throw new Error('Trash did not enter a movable preview before cancel.');
  }
  assertPixelCursor('Desktop icon drag', trashPreviewMoved.cursor, 16, 16, { x: 7, y: 7 });
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

  const waitForTrashHighlight = async (expected: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const highlighted = (await window.webContents.executeJavaScript(
        "document.querySelector('[data-desktop-icon=\"trash\"]')?.classList.contains('is-drop-target') === true",
        true,
      )) as boolean;
      if (highlighted === expected) return;
      await pause(15);
    }
    throw new Error(`Trash highlight did not become ${expected ? 'active' : 'inactive'}.`);
  };

  const trashProbePoints = (geometry: DesktopGeometry) => ({
    insideEdge: {
      x: Math.floor(geometry.trashGlyph.right + geometry.trashTolerance - 1),
      y: Math.round((geometry.trashGlyph.top + geometry.trashGlyph.bottom) / 2),
    },
    outsideEdge: {
      x: Math.ceil(geometry.trashGlyph.right + geometry.trashTolerance + 1),
      y: Math.round((geometry.trashGlyph.top + geometry.trashGlyph.bottom) / 2),
    },
    label: {
      x: Math.round((geometry.trashLabel.left + geometry.trashLabel.right) / 2),
      y: Math.round((geometry.trashLabel.top + geometry.trashLabel.bottom) / 2),
    },
  });

  const assertRejectedDiskRelease = async (
    expectedCenter: { x: number; y: number },
    description: string,
  ): Promise<void> => {
    const geometry = await readDesktopGeometry();
    const inactive = (await window.webContents.executeJavaScript(
      `(() => {
        const disk = document.querySelector('[data-desktop-icon="system-disk"]');
        const trash = document.querySelector('[data-desktop-icon="trash"]');
        return disk instanceof HTMLElement && trash instanceof HTMLElement &&
          !disk.classList.contains('is-ejecting') &&
          !disk.classList.contains('is-dragging') &&
          !trash.classList.contains('is-drop-target');
      })()`,
      true,
    )) as boolean;
    if (
      !geometry ||
      Math.hypot(geometry.disk.x - expectedCenter.x, geometry.disk.y - expectedCenter.y) > 2 ||
      !inactive ||
      quitRequested
    ) {
      throw new Error(`${description} incorrectly ejected System Disk.`);
    }
  };

  const restoreDefaultDesktopLayout = async (): Promise<DesktopGeometry> => {
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu="special"]\')?.click()',
      true,
    );
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-menu-action="clean-desktop"]\')?.click()',
      true,
    );
    await pause(260);
    const geometry = await readDesktopGeometry();
    if (!geometry) throw new Error('Clean Up Desktop did not restore measurable icon geometry.');
    return geometry;
  };

  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry || desktopGeometry.trashTolerance !== 4) {
    throw new Error('Trash artwork geometry or its documented tolerance is unavailable.');
  }

  window.webContents.sendInputEvent({ type: 'mouseMove', ...desktopGeometry.disk });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...desktopGeometry.disk,
  });
  releaseDrag(desktopGeometry.disk);
  await pause(40);
  const trashInitiallyUnselected = (await window.webContents.executeJavaScript(
    "document.querySelector('[data-desktop-icon=\"trash\"]')?.classList.contains('is-selected') === false",
    true,
  )) as boolean;
  if (!trashInitiallyUnselected) throw new Error('Trash selection precondition could not be set.');

  const trashLabelCenter = trashProbePoints(desktopGeometry).label;
  window.webContents.sendInputEvent({ type: 'mouseMove', ...trashLabelCenter });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...trashLabelCenter,
  });
  releaseDrag(trashLabelCenter);
  await pause(50);
  const trashSelected = (await window.webContents.executeJavaScript(
    "document.querySelector('[data-desktop-icon=\"trash\"]')?.classList.contains('is-selected') === true",
    true,
  )) as boolean;
  if (!trashSelected) throw new Error('Trash label no longer selects the desktop icon.');

  const trashMoveTarget = { x: 520, y: 350 };
  let probePoints = trashProbePoints(desktopGeometry);
  await beginDrag(desktopGeometry.disk, probePoints.insideEdge, true);
  await waitForTrashHighlight(true);
  const trashHitboxCaptureDestination = process.env.MACINTOSH_SMOKE_TRASH_HITBOX_CAPTURE_PATH;
  if (trashHitboxCaptureDestination) {
    const image = await window.webContents.capturePage();
    await mkdir(path.dirname(trashHitboxCaptureDestination), { recursive: true });
    await writeFile(trashHitboxCaptureDestination, image.toPNG());
  }
  await moveHeldPointer(probePoints.insideEdge, probePoints.outsideEdge, 4);
  await waitForTrashHighlight(false);
  releaseDrag(probePoints.outsideEdge);
  await pause(80);
  await assertRejectedDiskRelease(probePoints.outsideEdge, 'The outside-edge release');

  const safeDiskPoint = { x: 137, y: 343 };
  const separatedTrashPoint = { x: 650, y: 430 };
  desktopGeometry = await restoreDefaultDesktopLayout();

  probePoints = trashProbePoints(desktopGeometry);
  await beginDrag(desktopGeometry.disk, probePoints.insideEdge, true);
  await waitForTrashHighlight(true);
  await moveHeldPointer(probePoints.insideEdge, probePoints.label, 6);
  await waitForTrashHighlight(false);
  releaseDrag(probePoints.label);
  await pause(80);
  await assertRejectedDiskRelease(probePoints.label, 'The Trash-label release');

  await restoreDefaultDesktopLayout();

  const rejectedInternalTrashDrop = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
      );
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const label = trash?.querySelector('[data-desktop-icon-label="trash"]');
      if (!(source instanceof HTMLElement) || !(trash instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {
        dataTransfer: data,
        clientX: sourceBounds.left + sourceBounds.width / 2,
        clientY: sourceBounds.top + sourceBounds.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const point = {
        x: labelBounds.left + labelBounds.width / 2,
        y: labelBounds.top + labelBounds.height / 2
      };
      label.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      const highlighted = trash.classList.contains('is-file-drop-target');
      label.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return { highlighted, payload: data.getData('application/x-macintosh-vfs-node-ids') };
    })()`,
    true,
  )) as { highlighted: boolean; payload: string } | null;
  await pause(100);
  const rejectedInternalItemRemained = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
    ) !== null`,
    true,
  )) as boolean;
  if (
    !rejectedInternalTrashDrop?.payload ||
    rejectedInternalTrashDrop.highlighted ||
    !rejectedInternalItemRemained
  ) {
    throw new Error(
      `The Trash label accepted an internal item: ${JSON.stringify(rejectedInternalTrashDrop)}.`,
    );
  }

  const acceptedInternalTrashDrop = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
      );
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
      if (!(source instanceof HTMLElement) || !(trash instanceof HTMLElement) || !(glyph instanceof Element)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const glyphBounds = glyph.getBoundingClientRect();
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {
        dataTransfer: data,
        clientX: sourceBounds.left + sourceBounds.width / 2,
        clientY: sourceBounds.top + sourceBounds.height / 2,
        bubbles: true,
        cancelable: true
      }));
      const point = {
        x: glyphBounds.left + glyphBounds.width / 2,
        y: glyphBounds.top + glyphBounds.height / 2
      };
      glyph.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      const highlighted = trash.classList.contains('is-file-drop-target');
      glyph.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return { highlighted, payload: data.getData('application/x-macintosh-vfs-node-ids') };
    })()`,
    true,
  )) as { highlighted: boolean; payload: string } | null;
  await pause(120);
  const acceptedInternalItemMoved = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
    ) === null`,
    true,
  )) as boolean;
  if (
    !acceptedInternalTrashDrop?.payload ||
    !acceptedInternalTrashDrop.highlighted ||
    !acceptedInternalItemMoved
  ) {
    throw new Error(
      `The rendered Trash glyph rejected an internal item: ${JSON.stringify(acceptedInternalTrashDrop)}.`,
    );
  }

  const trashWindowOpened = await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return false;
      trash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!trashWindowOpened) throw new Error('Trash could not be opened after an internal drop.');
  await pause(80);
  const trashWindowState = (await window.webContents.executeJavaScript(
    `(() => ({
      windows: document.querySelectorAll('[data-finder-window="window-trash"]').length,
      containsWelcome:
        document.querySelector(
          '[data-finder-window="window-trash"] [data-vfs-item="welcome"]'
        ) !== null,
      ejecting:
        document.querySelector('[data-desktop-icon="system-disk"]')
          ?.classList.contains('is-ejecting') === true
    }))()`,
    true,
  )) as { windows: number; containsWelcome: boolean; ejecting: boolean };
  if (
    trashWindowState.windows !== 1 ||
    !trashWindowState.containsWelcome ||
    trashWindowState.ejecting ||
    quitRequested
  ) {
    throw new Error(
      `Opening Trash crossed interaction behaviors: ${JSON.stringify(trashWindowState)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="Close Trash"]\')?.click()',
    true,
  );
  await pause(50);

  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-finder-window]').forEach((finder) => {
      if (finder instanceof HTMLElement) finder.style.pointerEvents = 'none';
    })`,
    true,
  );
  await pause(50);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry disappeared during hitbox isolation.');

  await pause(260);
  const nodesBeforeTrashMove = JSON.stringify((await loadState()).nodes);
  const nodeCountBeforeTrashMove = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  await sendDrag(desktopGeometry.trash, trashMoveTarget, false);
  await pause(260);
  desktopGeometry = await readDesktopGeometry();
  const nodeCountAfterTrashMove = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  const nodesAfterTrashMove = JSON.stringify((await loadState()).nodes);
  if (
    !desktopGeometry ||
    Math.hypot(
      desktopGeometry.trash.x - trashMoveTarget.x,
      desktopGeometry.trash.y - trashMoveTarget.y,
    ) > 2 ||
    nodeCountAfterTrashMove !== nodeCountBeforeTrashMove ||
    nodesAfterTrashMove !== nodesBeforeTrashMove ||
    quitRequested
  ) {
    throw new Error('Moving Trash did not remain a distinct desktop-layout operation.');
  }
  await sendDrag(desktopGeometry.disk, safeDiskPoint, true);
  await pause(80);

  window.setContentSize(800, 560);
  await pause(120);
  desktopGeometry = await readDesktopGeometry();
  if (
    !desktopGeometry ||
    desktopGeometry.viewport.width !== 800 ||
    desktopGeometry.viewport.height !== 560
  ) {
    throw new Error(`Minimum-window geometry was not applied: ${JSON.stringify(desktopGeometry)}.`);
  }
  probePoints = trashProbePoints(desktopGeometry);
  await beginDrag(desktopGeometry.disk, probePoints.insideEdge, true);
  await waitForTrashHighlight(true);
  await moveHeldPointer(probePoints.insideEdge, probePoints.outsideEdge, 4);
  await waitForTrashHighlight(false);
  releaseDrag(probePoints.outsideEdge);
  await pause(80);
  await assertRejectedDiskRelease(probePoints.outsideEdge, 'The minimum-window outside edge');

  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry disappeared at minimum window size.');
  await sendDrag(desktopGeometry.trash, separatedTrashPoint, false);
  await pause(80);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Trash did not move away at minimum window size.');
  await sendDrag(desktopGeometry.disk, { x: 120, y: 280 }, true);
  await pause(80);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry disappeared while restoring Trash.');
  await sendDrag(desktopGeometry.trash, trashMoveTarget, false);
  await pause(80);

  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Unscaled desktop geometry could not be measured.');
  const unscaledViewport = desktopGeometry.viewport;
  window.webContents.setZoomFactor(1.25);
  await pause(120);
  const scaledDropProbe = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
      const label = trash?.querySelector('[data-desktop-icon-label="trash"]');
      const surface = document.querySelector('.desktop-surface');
      if (!(trash instanceof HTMLElement) || !(glyph instanceof Element) || !(label instanceof HTMLElement) || !(surface instanceof HTMLElement)) return null;
      const glyphBounds = glyph.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      const tolerance = Number(glyph.getAttribute('data-trash-drop-tolerance'));
      const data = new DataTransfer();
      data.setData('application/x-macintosh-vfs-node-ids', JSON.stringify(['read-me']));
      const dragOver = (target, point) => target.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      const inside = {
        x: glyphBounds.right + tolerance - 1,
        y: (glyphBounds.top + glyphBounds.bottom) / 2
      };
      const outside = { x: glyphBounds.right + tolerance + 1, y: inside.y };
      const labelPoint = {
        x: labelBounds.left + labelBounds.width / 2,
        y: labelBounds.top + labelBounds.height / 2
      };
      dragOver(glyph, inside);
      const insideHighlighted = trash.classList.contains('is-file-drop-target');
      dragOver(glyph, outside);
      const outsideRejected = !trash.classList.contains('is-file-drop-target');
      dragOver(label, labelPoint);
      const labelRejected = !trash.classList.contains('is-file-drop-target');
      dragOver(glyph, inside);
      const dropCommitted = !glyph.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data, clientX: inside.x, clientY: inside.y, bubbles: true, cancelable: true
      }));
      surface.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
      return {
        insideHighlighted,
        outsideRejected,
        labelRejected,
        dropCommitted,
        glyphVisible:
          glyphBounds.left >= 0 && glyphBounds.right <= window.innerWidth &&
          glyphBounds.top >= 0 && glyphBounds.bottom <= window.innerHeight,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio
        }
      };
    })()`,
    true,
  )) as {
    insideHighlighted: boolean;
    outsideRejected: boolean;
    labelRejected: boolean;
    dropCommitted: boolean;
    glyphVisible: boolean;
    viewport: { width: number; height: number; devicePixelRatio: number };
  } | null;
  if (
    window.webContents.getZoomFactor() !== 1.25 ||
    !scaledDropProbe?.insideHighlighted ||
    !scaledDropProbe.outsideRejected ||
    !scaledDropProbe.labelRejected ||
    !scaledDropProbe.dropCommitted ||
    !scaledDropProbe.glyphVisible ||
    scaledDropProbe.viewport.width >= unscaledViewport.width ||
    scaledDropProbe.viewport.height >= unscaledViewport.height
  ) {
    throw new Error(`Scaled Trash coordinates failed: ${JSON.stringify(scaledDropProbe)}.`);
  }
  await pause(320);
  const scaledDropPersisted = (await loadState()).nodes.some(
    (node) => node.id === 'read-me' && node.parentId === 'trash',
  );
  if (!scaledDropPersisted) throw new Error('The scaled Trash drop did not commit its VFS move.');

  window.webContents.setZoomFactor(1);
  window.setContentSize(1152, 768);
  await pause(140);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry did not recover after scaled testing.');

  const repositionTarget = { x: 137, y: 343 };
  await sendDrag(desktopGeometry.disk, repositionTarget, true);
  await pause(260);
  await assertRejectedDiskRelease(repositionTarget, 'The free desktop release');
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-finder-window]').forEach((finder) => {
      if (finder instanceof HTMLElement) finder.style.removeProperty('pointer-events');
    })`,
    true,
  );

  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry disappeared before ejection.');
  const ejectPoint = trashProbePoints(desktopGeometry).insideEdge;
  await beginDrag(desktopGeometry.disk, ejectPoint, true);
  await waitForTrashHighlight(true);
  releaseDrag(ejectPoint);

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
