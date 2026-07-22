import { app, BrowserWindow, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/contracts';
import { createDefaultState, sanitizeState, type MacintoshState } from '../shared/state';

const STATE_FILE_NAME = 'macintosh-state.json';
const PROBE_FILE_NAME = 'persistence-proof.json';
const smokeMode = process.argv.includes('--smoke-test');
const persistenceProbeMode = process.argv.includes('--persistence-probe');
const captureAboutMode = process.argv.includes('--capture-about');
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

app.setName('Macintosh Workbench');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let quitRequested = false;

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

const saveState = async (state: MacintoshState): Promise<void> => {
  saveQueue = saveQueue.then(() => writeStateAtomically(state));
  await saveQueue;
};

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
    await saveState(sanitizeState(value));
    return { ok: true as const };
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

  const initialVfsCount = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
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

  const invalidTarget = {
    x: Math.max(140, coordinates.disk.x - 240),
    y: Math.min(520, coordinates.disk.y + 220),
  };
  await sendDrag(coordinates.disk, invalidTarget, true);
  await pause(260);
  const invalidDropRestored = await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(disk instanceof HTMLElement) || !(trash instanceof HTMLElement)) return false;
      const rect = disk.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - ${coordinates.disk.x}, rect.top + rect.height / 2 - ${coordinates.disk.y});
      return distance <= 2 && !trash.classList.contains('is-drop-target');
    })()`,
    true,
  );
  if (!invalidDropRestored) throw new Error('Invalid disk drop did not return cleanly to desktop.');

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
    if (!(disk instanceof HTMLElement) || !(root instanceof HTMLElement) || !(finder instanceof HTMLElement)) return null;
    const rect = disk.getBoundingClientRect();
    return {
      loaded: document.body.dataset.stateLoaded === 'true',
      diskLabel: disk.getAttribute('aria-label'),
      diskVisible: rect.width > 0 && rect.height > 0,
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
    title: 'Macintosh Workbench',
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
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
