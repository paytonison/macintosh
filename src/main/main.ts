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
import {
  executeVfsCommand,
  isMergeImportedEntriesCommand,
  isVfsCommand,
  type VfsMutationResult,
} from '../shared/vfs';
import { inspectImportPaths } from './import-files';
import { createNormalQuitCoordinator } from './normal-quit';
import { createAuthoritativeStateController } from './state-controller';
import { createSerializedStateWriter } from './state-save-queue';

const STATE_FILE_NAME = 'macintosh-state.json';
const PROBE_FILE_NAME = 'persistence-proof.json';
const APP_NAME = 'The Macintosh';
const NORMAL_QUIT_WINDOW_DELTA = { x: 37, y: 23 } as const;
const APP_ICON_PATH = path.join(app.getAppPath(), 'assets', 'the-macintosh-icon.png');
type SmokePoint = { x: number; y: number };
const smokeMode = process.argv.includes('--smoke-test');
const persistenceProbeMode = process.argv.includes('--persistence-probe');
const normalQuitProbeMode = process.argv.includes('--normal-quit-probe');
const captureAboutMode = process.argv.includes('--capture-about');
const captureCalculatorMode = process.argv.includes('--capture-calculator');
const captureStartupArgument = process.argv.find((value) => value.startsWith('--capture-startup='));
const automationMode =
  smokeMode ||
  persistenceProbeMode ||
  normalQuitProbeMode ||
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
let smokeSaveFailureTarget: 'eject' | 'import' | 'presentation' | 'vfs' | null = null;

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
const stateController = createAuthoritativeStateController({
  load: loadState,
  write: saveState,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const injectSmokeSaveFailure = (operation: Exclude<typeof smokeSaveFailureTarget, null>): void => {
  if ((!smokeMode && !normalQuitProbeMode) || smokeSaveFailureTarget !== operation) return;
  smokeSaveFailureTarget = null;
  throw new Error('Injected smoke-test save failure.');
};

const normalQuit = createNormalQuitCoordinator<unknown>({
  requestRendererFlush: () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      throw new Error('The renderer is unavailable for a final presentation flush.');
    }
    mainWindow.webContents.send(IPC_CHANNELS.normalQuitRequested);
  },
  persistFinalState: async (presentation) => {
    injectSmokeSaveFailure('presentation');
    await stateController.finalize(presentation ?? {}, (state) => ({ state, value: null }));
  },
  quitApplication: () => {
    setTimeout(() => app.quit(), 0);
  },
});

const requestNormalQuit = (): void => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    void normalQuit.finalizeAndQuitWithoutRenderer().catch((error: unknown) => {
      console.error('The Macintosh could not finalize state without its renderer:', error);
    });
    return;
  }
  normalQuit.requestQuit();
};

const commitVfsCommand = async (
  presentation: unknown,
  command: unknown,
): Promise<VfsMutationResult> => {
  if (!isVfsCommand(command)) throw new TypeError('Invalid renderer VFS command.');
  injectSmokeSaveFailure('vfs');
  const committed = await stateController.transact(presentation, (state) => {
    const result = executeVfsCommand(state, command);
    return {
      state: result.state,
      value: {
        affectedIds: result.affectedIds,
        addedCount: result.addedCount,
        skippedCount: result.skippedCount,
        truncatedCount: result.truncatedCount,
      },
    };
  });
  return { state: committed.state, ...committed.value };
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
    return stateController.load();
  });

  ipcMain.handle(IPC_CHANNELS.savePresentation, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    injectSmokeSaveFailure('presentation');
    await stateController.savePresentation(value);
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.mutateVfs, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (!isRecord(value)) throw new TypeError('Invalid VFS mutation request.');
    return commitVfsCommand(value.presentation, value.command);
  });

  ipcMain.handle(IPC_CHANNELS.importFiles, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (!isRecord(value)) throw new TypeError('Invalid host import request.');
    const request = {
      type: 'merge-imported-entries',
      entries: [],
      parentId: value.parentId,
      ...(value.desktopPlacement === undefined ? {} : { desktopPlacement: value.desktopPlacement }),
    };
    if (!isMergeImportedEntriesCommand(request)) {
      throw new TypeError('Invalid host import destination.');
    }
    injectSmokeSaveFailure('import');
    const committed = await stateController.transact(value.presentation, async (state) => {
      const inspected = await inspectImportPaths(value.paths);
      const command = { ...request, entries: inspected.entries };
      const result = executeVfsCommand(state, command);
      return {
        state: result.state,
        value: {
          affectedIds: result.affectedIds,
          addedCount: result.addedCount,
          skippedCount: result.skippedCount + inspected.skippedCount,
          truncatedCount: result.truncatedCount + inspected.truncatedCount,
        },
      };
    });
    return { state: committed.state, ...committed.value };
  });

  ipcMain.handle(IPC_CHANNELS.requestPaste, (event) => {
    assertTrustedRenderer(event);
    event.sender.paste();
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.normalQuitReady, (event) => {
    assertTrustedRenderer(event);
    normalQuit.rendererReady();
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.flushPresentationAndQuit, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await normalQuit.flushAndQuit(value);
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.saveAndQuitAfterEject, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    injectSmokeSaveFailure('eject');
    await stateController.finalize(value, (state) => ({
      state: {
        ...state,
        desktop: {
          ...state.desktop,
          lastEjectAt: new Date().toISOString(),
        },
      },
      value: null,
    }));
    quitRequested = true;
    setTimeout(() => normalQuit.quitWithoutFlush(), 80);
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

  type SmokeWindowAnimation = {
    phase: 'opening' | 'closing';
    animationName: string;
    offsetX: string;
    offsetY: string;
    windowId: string;
    frameBoxShadow: string;
    frameTransform: string;
    shadowAnimationName: string;
    shadowAriaHidden: string | null;
    shadowBoxShadow: string;
    shadowMounted: boolean;
    shadowPointerEvents: string;
    shadowTransform: string;
    transformsMatch: boolean;
    framesAligned: boolean;
  };
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
  const observeWindowAnimation = async (
    windowLabel: string,
    phase: SmokeWindowAnimation['phase'],
    run: () => void | Promise<void>,
  ): Promise<SmokeWindowAnimation | null> => {
    await window.webContents.executeJavaScript(
      `(() => {
        window.__macintoshSmokeWindowAnimation = new Promise((resolve) => {
          const surface = document.querySelector('.desktop-surface');
          if (!(surface instanceof HTMLElement)) {
            resolve(null);
            return;
          }
          const animationAttribute = ${JSON.stringify(`data-${phase}`)};
          const expectedAnimationName = ${JSON.stringify(
            phase === 'opening' ? 'finder-window-open' : 'finder-window-close',
          )};
          const observer = new MutationObserver(() => {
            const finder = [...document.querySelectorAll('[data-finder-window]')].find(
              (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(windowLabel)}
            );
            if (!(finder instanceof HTMLElement) || finder.getAttribute(animationAttribute) !== 'true') return;
            const windowId = finder.getAttribute('data-finder-window');
            const shadow = [...document.querySelectorAll('[data-window-animation-shadow]')].find(
              (candidate) =>
                candidate.getAttribute('data-window-animation-shadow') === windowId
            );
            if (!(shadow instanceof HTMLElement) || !windowId) return;
            observer.disconnect();
            const frameAnimation = finder.getAnimations().find(
              (animation) => animation.animationName === expectedAnimationName
            );
            const shadowAnimation = shadow.getAnimations().find(
              (animation) => animation.animationName === expectedAnimationName
            );
            if (frameAnimation && shadowAnimation) {
              const durationValue = frameAnimation.effect?.getTiming().duration;
              const duration = typeof durationValue === 'number' ? durationValue : 20;
              frameAnimation.pause();
              shadowAnimation.pause();
              frameAnimation.currentTime = duration / 2;
              shadowAnimation.currentTime = duration / 2;
            }
            const style = getComputedStyle(finder);
            const shadowStyle = getComputedStyle(shadow);
            const frameBounds = finder.getBoundingClientRect();
            const shadowBounds = shadow.getBoundingClientRect();
            const nearlyEqual = (left, right) => Math.abs(left - right) <= 0.05;
            const framesAligned =
              nearlyEqual(frameBounds.left, shadowBounds.left) &&
              nearlyEqual(frameBounds.top, shadowBounds.top) &&
              nearlyEqual(frameBounds.right, shadowBounds.right) &&
              nearlyEqual(frameBounds.bottom, shadowBounds.bottom) &&
              nearlyEqual(frameBounds.width, shadowBounds.width) &&
              nearlyEqual(frameBounds.height, shadowBounds.height);
            const frameTransform = style.transform;
            const shadowTransform = shadowStyle.transform;
            const snapshot = {
              phase: ${JSON.stringify(phase)},
              animationName: style.animationName,
              offsetX: style.getPropertyValue('--window-animation-offset-x').trim(),
              offsetY: style.getPropertyValue('--window-animation-offset-y').trim(),
              windowId,
              frameBoxShadow: style.boxShadow,
              frameTransform,
              shadowAnimationName: shadowStyle.animationName,
              shadowAriaHidden: shadow.getAttribute('aria-hidden'),
              shadowBoxShadow: shadowStyle.boxShadow,
              shadowMounted: shadow.isConnected,
              shadowPointerEvents: shadowStyle.pointerEvents,
              shadowTransform,
              transformsMatch: frameTransform === shadowTransform,
              framesAligned
            };
            if (frameAnimation && shadowAnimation) {
              frameAnimation.currentTime = 0;
              shadowAnimation.currentTime = 0;
              frameAnimation.play();
              shadowAnimation.play();
            }
            resolve({
              ...snapshot
            });
          });
          observer.observe(surface, {
            attributes: true,
            attributeFilter: ['class', 'data-opening', 'data-closing'],
            childList: true,
            subtree: true,
          });
          setTimeout(() => {
            observer.disconnect();
            resolve(null);
          }, 300);
        });
      })()`,
      true,
    );
    await run();
    return window.webContents.executeJavaScript(
      'window.__macintoshSmokeWindowAnimation',
      true,
    ) as Promise<SmokeWindowAnimation | null>;
  };
  const assertWindowAnimationShadow = (
    animation: SmokeWindowAnimation | null,
    label: string,
  ): void => {
    const expectedName =
      animation?.phase === 'opening' ? 'finder-window-open' : 'finder-window-close';
    if (
      !animation ||
      animation.animationName !== expectedName ||
      animation.shadowAnimationName !== expectedName ||
      animation.frameBoxShadow !== 'none' ||
      !animation.shadowBoxShadow.startsWith('rgb(0, 0, 0) ') ||
      !animation.shadowBoxShadow.endsWith(' 3px 3px 0px 0px') ||
      animation.shadowPointerEvents !== 'none' ||
      animation.shadowAriaHidden !== 'true' ||
      !animation.shadowMounted ||
      !animation.transformsMatch ||
      animation.frameTransform !== animation.shadowTransform ||
      !animation.framesAligned
    ) {
      throw new Error(
        `${label} did not render an aligned hard animation shadow: ${JSON.stringify(animation)}.`,
      );
    }
  };
  const waitForFinderWindowSettled = async (
    windowLabel: string,
    windowId: string,
  ): Promise<void> => {
    type SettledWindowState = {
      boxShadow: string;
      opening: string | null;
      closing: string | null;
      shadowPresent: boolean;
    };
    const deadline = Date.now() + 800;
    let state: SettledWindowState | null = null;
    while (Date.now() < deadline) {
      state = (await window.webContents.executeJavaScript(
        `(() => {
          const finder = [...document.querySelectorAll('[data-finder-window]')].find(
            (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(windowLabel)}
          );
          if (!(finder instanceof HTMLElement)) return null;
          return {
            boxShadow: getComputedStyle(finder).boxShadow,
            opening: finder.getAttribute('data-opening'),
            closing: finder.getAttribute('data-closing'),
            shadowPresent: document.querySelector(
              '[data-window-animation-shadow=${JSON.stringify(windowId)}]'
            ) !== null
          };
        })()`,
        true,
      )) as SettledWindowState | null;
      if (state && state.opening !== 'true' && state.closing !== 'true' && !state.shadowPresent) {
        if (
          !state.boxShadow.startsWith('rgb(0, 0, 0) ') ||
          !state.boxShadow.endsWith(' 3px 3px 0px 0px')
        ) {
          throw new Error(
            `${windowLabel} did not restore its settled hard shadow: ${JSON.stringify(state)}.`,
          );
        }
        return;
      }
      await pause(10);
    }
    throw new Error(
      `${windowLabel} did not tear down its animation shadow: ${JSON.stringify(state)}.`,
    );
  };
  const waitForFinderWindowAbsence = async (
    windowLabel: string,
    windowId?: string,
  ): Promise<void> => {
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const absent = await window.webContents.executeJavaScript(
        `(() => {
          const finderAbsent = [...document.querySelectorAll('[data-finder-window]')].every(
            (candidate) => candidate.getAttribute('aria-label') !== ${JSON.stringify(windowLabel)}
          );
          const shadowAbsent = ${JSON.stringify(windowId ?? null)} === null ||
            document.querySelector(
              '[data-window-animation-shadow=' + JSON.stringify(${JSON.stringify(windowId ?? '')}) + ']'
            ) === null;
          return finderAbsent && shadowAbsent;
        })()`,
        true,
      );
      if (absent) return;
      await pause(10);
    }
    throw new Error(`${windowLabel} remained after its close animation.`);
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
  assertPixelCursor('Desktop icon pointing hand', cursorBindings.desktopIcon, 16, 16, {
    x: 5,
    y: 1,
  });
  assertPixelCursor('Window title-bar grab', cursorBindings.titlebar, 16, 16, { x: 7, y: 8 });
  assertPixelCursor('Window control arrow', cursorBindings.windowControl, 11, 16, { x: 1, y: 1 });
  assertPixelCursor('Window resize', cursorBindings.growBox, 15, 15, { x: 7, y: 7 });

  const focusLossDragPoints = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
      );
      const icon = source?.querySelector('.pixel-icon');
      const surface = document.querySelector('.desktop-surface');
      if (
        !(source instanceof HTMLElement) ||
        !(icon instanceof SVGElement) ||
        !(surface instanceof HTMLElement)
      ) return null;
      const iconBounds = icon.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      let destination = null;
      const clearOffsets = [-18, 0, 18];
      for (let y = Math.round(surfaceBounds.top + 18); y < surfaceBounds.bottom - 18; y += 24) {
        for (let x = Math.round(surfaceBounds.left + 18); x < surfaceBounds.right - 18; x += 24) {
          if (
            clearOffsets.every((offsetY) =>
              clearOffsets.every(
                (offsetX) => document.elementFromPoint(x + offsetX, y + offsetY) === surface
              )
            )
          ) {
            destination = { x, y };
            break;
          }
        }
        if (destination) break;
      }
      if (!destination) return null;
      document.body.dataset.macintoshSmokeBlurred = 'false';
      window.addEventListener(
        'blur',
        () => { document.body.dataset.macintoshSmokeBlurred = 'true'; },
        { once: true }
      );
      return {
        source: {
          x: Math.round(iconBounds.left + iconBounds.width / 2),
          y: Math.round(iconBounds.top + iconBounds.height / 2)
        },
        icon: {
          left: Math.round(iconBounds.left),
          top: Math.round(iconBounds.top),
          width: Math.round(iconBounds.width),
          height: Math.round(iconBounds.height)
        },
        destination
      };
    })()`,
    true,
  )) as {
    source: SmokePoint;
    icon: { left: number; top: number; width: number; height: number };
    destination: SmokePoint;
  } | null;
  if (!focusLossDragPoints) throw new Error('Focus-loss drag coordinates were unavailable.');

  type SmokeFocusLossPreviewState = {
    left: number;
    top: number;
    width: number;
    height: number;
    artworkName: string | null;
    artworkVariant: string | null;
    shadowName: string | null;
    shadowVariant: string | null;
    shadowOffsetX: number;
    shadowOffsetY: number;
    shadowColors: string[];
    pointerEvents: string;
    borderStyle: string;
    outlineStyle: string;
    solidShadow: boolean;
    shadowFullyBlack: boolean;
  };
  type SmokeFocusLossDragState = {
    htmlDragging: boolean;
    rootDragging: boolean;
    dataDragging: string | null;
    sourcePressed: boolean;
    sourceCursor: string;
    targetCursor: string;
    preview: SmokeFocusLossPreviewState | null;
  };
  const readFocusLossDragState = async (
    point: SmokePoint,
  ): Promise<SmokeFocusLossDragState | null> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const source = document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
        );
        const root = document.querySelector('.macintosh');
        const target = document.elementFromPoint(${point.x}, ${point.y});
        const previewRoot = document.querySelector('[data-vfs-item-drag-preview="true"]');
        const preview = document.querySelector(
          '[data-vfs-item-drag-preview-node="applications"]'
        );
        const artwork = preview?.querySelector('.pixel-icon-drag-artwork');
        const shadow = preview?.querySelector('.pixel-icon-drag-shadow');
        const artworkBounds = artwork?.getBoundingClientRect();
        const shadowBounds = shadow?.getBoundingClientRect();
        const previewStyle = preview instanceof HTMLElement ? getComputedStyle(preview) : null;
        if (!(source instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
        const shadowRects = shadow instanceof SVGElement
          ? [...shadow.querySelectorAll('rect')]
          : [];
        return {
          htmlDragging: document.documentElement.classList.contains('is-item-dragging'),
          rootDragging: root.classList.contains('is-item-dragging'),
          dataDragging: root.dataset.itemDragging ?? null,
          sourcePressed: source.classList.contains('is-pointer-pressed'),
          sourceCursor: getComputedStyle(source).cursor,
          targetCursor: target instanceof Element ? getComputedStyle(target).cursor : '',
          preview:
            previewRoot instanceof HTMLElement &&
            preview instanceof HTMLElement &&
            artwork instanceof SVGElement &&
            shadow instanceof SVGElement &&
            artworkBounds &&
            shadowBounds &&
            previewStyle
              ? {
                  left: Math.round(artworkBounds.left),
                  top: Math.round(artworkBounds.top),
                  width: Math.round(artworkBounds.width),
                  height: Math.round(artworkBounds.height),
                  artworkName: artwork.dataset.pixelIcon ?? null,
                  artworkVariant: artwork.dataset.pixelIconVariant ?? null,
                  shadowName: shadow.dataset.pixelIcon ?? null,
                  shadowVariant: shadow.dataset.pixelIconVariant ?? null,
                  shadowOffsetX: Math.round(shadowBounds.left - artworkBounds.left),
                  shadowOffsetY: Math.round(shadowBounds.top - artworkBounds.top),
                  shadowColors: [...new Set(
                    shadowRects.map((rect) => rect.getAttribute('fill') ?? '')
                  )],
                  pointerEvents: getComputedStyle(previewRoot).pointerEvents,
                  borderStyle: previewStyle.borderStyle,
                  outlineStyle: previewStyle.outlineStyle,
                  solidShadow: preview.classList.contains('is-solid-shadow'),
                  shadowFullyBlack:
                    shadowRects.length > 0 && shadowRects.every(
                      (rect) => getComputedStyle(rect).fill === 'rgb(0, 0, 0)'
                    )
                }
              : null
        };
      })()`,
      true,
    )) as SmokeFocusLossDragState | null;

  window.webContents.sendInputEvent({ type: 'mouseMove', ...focusLossDragPoints.source });
  await pause(32);
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...focusLossDragPoints.source,
  });
  await pause(32);
  const preThresholdPoint = {
    x: focusLossDragPoints.source.x + 2,
    y: focusLossDragPoints.source.y,
  };
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...preThresholdPoint,
  });
  await pause(32);
  const focusLossPressedState = await readFocusLossDragState(preThresholdPoint);
  if (
    !focusLossPressedState?.sourcePressed ||
    focusLossPressedState.rootDragging ||
    focusLossPressedState.dataDragging !== null ||
    focusLossPressedState.preview !== null
  ) {
    throw new Error(
      `The focus-loss probe did not preserve its pre-threshold press: ${JSON.stringify(focusLossPressedState)}.`,
    );
  }
  assertPixelCursor(
    'Focus-loss pre-threshold open hand',
    focusLossPressedState.sourceCursor,
    16,
    16,
    { x: 8, y: 8 },
  );

  const thresholdPoint = {
    x: focusLossDragPoints.source.x + 4,
    y: focusLossDragPoints.source.y,
  };
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...thresholdPoint,
  });
  await pause(48);
  const focusLossThresholdState = await readFocusLossDragState(thresholdPoint);
  const thresholdPreview = focusLossThresholdState?.preview;
  if (
    !focusLossThresholdState?.rootDragging ||
    focusLossThresholdState.dataDragging !== 'true' ||
    focusLossThresholdState.sourcePressed ||
    !thresholdPreview ||
    thresholdPreview.left !== focusLossDragPoints.icon.left + 4 ||
    thresholdPreview.top !== focusLossDragPoints.icon.top ||
    thresholdPreview.width !== 32 ||
    thresholdPreview.height !== 32 ||
    thresholdPreview.artworkName !== 'folder' ||
    thresholdPreview.shadowName !== thresholdPreview.artworkName ||
    thresholdPreview.artworkVariant !== 'artwork' ||
    thresholdPreview.shadowVariant !== 'shadow' ||
    thresholdPreview.shadowOffsetX !== 3 ||
    thresholdPreview.shadowOffsetY !== 3 ||
    !thresholdPreview.shadowColors.includes('#000') ||
    !thresholdPreview.shadowColors.includes('#fff') ||
    thresholdPreview.pointerEvents !== 'none' ||
    thresholdPreview.borderStyle !== 'none' ||
    thresholdPreview.outlineStyle !== 'none' ||
    thresholdPreview.solidShadow ||
    thresholdPreview.shadowFullyBlack
  ) {
    throw new Error(
      `The focus-loss probe did not render its pointer-following dithered Finder preview: ${JSON.stringify(focusLossThresholdState)}.`,
    );
  }
  assertPixelCursor(
    'Focus-loss post-threshold closed fist',
    focusLossThresholdState.sourceCursor,
    16,
    16,
    { x: 8, y: 8 },
  );

  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...focusLossDragPoints.destination,
  });
  await pause(60);
  let focusLossActiveState: SmokeFocusLossDragState | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    focusLossActiveState = await readFocusLossDragState(focusLossDragPoints.destination);
    if (
      focusLossActiveState?.preview?.solidShadow &&
      focusLossActiveState.preview.shadowFullyBlack
    ) {
      break;
    }
    await pause(15);
  }
  const activePreview = focusLossActiveState?.preview;
  if (
    !focusLossActiveState?.rootDragging ||
    focusLossActiveState.dataDragging !== 'true' ||
    focusLossActiveState.sourcePressed ||
    !activePreview ||
    activePreview.left !==
      focusLossDragPoints.icon.left +
        focusLossDragPoints.destination.x -
        focusLossDragPoints.source.x ||
    activePreview.top !==
      focusLossDragPoints.icon.top +
        focusLossDragPoints.destination.y -
        focusLossDragPoints.source.y ||
    activePreview.width !== 32 ||
    activePreview.height !== 32 ||
    !activePreview.solidShadow ||
    !activePreview.shadowFullyBlack
  ) {
    throw new Error(
      `The focus-loss probe did not acquire an active item drag: ${JSON.stringify(focusLossActiveState)}.`,
    );
  }
  assertPixelCursor(
    'Focus-loss active source closed fist',
    focusLossActiveState.sourceCursor,
    16,
    16,
    { x: 8, y: 8 },
  );
  assertPixelCursor(
    'Focus-loss active target closed fist',
    focusLossActiveState.targetCursor,
    16,
    16,
    { x: 8, y: 8 },
  );

  window.blur();
  type SmokeFocusLossCleanedState = {
    blurred: boolean;
    htmlDragging: boolean;
    rootDragging: boolean;
    dataDragging: string | null;
    previewVisible: boolean;
    sourcePressed: boolean;
    highlightedTargets: number;
    sourceCursor: string;
    targetCursor: string;
  };
  let focusLossCleanedState: SmokeFocusLossCleanedState | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    focusLossCleanedState = (await window.webContents.executeJavaScript(
      `(() => {
        const source = document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
        );
        const root = document.querySelector('.macintosh');
        const target = document.elementFromPoint(
          ${focusLossDragPoints.destination.x},
          ${focusLossDragPoints.destination.y}
        );
        if (!(source instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
        return {
          blurred: document.body.dataset.macintoshSmokeBlurred === 'true',
          htmlDragging: document.documentElement.classList.contains('is-item-dragging'),
          rootDragging: root.classList.contains('is-item-dragging'),
          dataDragging: root.dataset.itemDragging ?? null,
          previewVisible:
            document.querySelector('[data-vfs-item-drag-preview="true"]') !== null,
          sourcePressed: source.classList.contains('is-pointer-pressed'),
          highlightedTargets: document.querySelectorAll('.is-file-drop-target').length,
          sourceCursor: getComputedStyle(source).cursor,
          targetCursor: target instanceof Element ? getComputedStyle(target).cursor : ''
        };
      })()`,
      true,
    )) as SmokeFocusLossCleanedState | null;
    if (
      focusLossCleanedState?.blurred &&
      !focusLossCleanedState.htmlDragging &&
      !focusLossCleanedState.rootDragging &&
      focusLossCleanedState.dataDragging === null &&
      !focusLossCleanedState.previewVisible &&
      !focusLossCleanedState.sourcePressed &&
      focusLossCleanedState.highlightedTargets === 0
    ) {
      break;
    }
    await pause(25);
  }
  window.focus();
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...focusLossDragPoints.destination,
  });
  await pause(60);
  if (
    !focusLossCleanedState?.blurred ||
    focusLossCleanedState.htmlDragging ||
    focusLossCleanedState.rootDragging ||
    focusLossCleanedState.dataDragging !== null ||
    focusLossCleanedState.previewVisible ||
    focusLossCleanedState.sourcePressed ||
    focusLossCleanedState.highlightedTargets !== 0
  ) {
    throw new Error(
      `The active item drag did not clean up on focus loss: ${JSON.stringify(focusLossCleanedState)}.`,
    );
  }
  assertPixelCursor(
    'Focus-loss restored item pointing hand',
    focusLossCleanedState.sourceCursor,
    16,
    16,
    { x: 5, y: 1 },
  );
  assertPixelCursor(
    'Focus-loss restored desktop arrow',
    focusLossCleanedState.targetCursor,
    11,
    16,
    { x: 1, y: 1 },
  );

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
  const waitForSystemWindowSize = async (
    width: number,
    height: number,
  ): Promise<SmokeWindowGeometry | null> => {
    const deadline = Date.now() + 800;
    let geometry: SmokeWindowGeometry | null = null;
    while (Date.now() < deadline) {
      geometry = await readSystemWindowGeometry();
      if (
        geometry &&
        Math.abs(geometry.width - width) <= 1 &&
        Math.abs(geometry.height - height) <= 1
      ) {
        return geometry;
      }
      await pause(10);
    }
    return geometry;
  };
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
    await window.webContents.executeJavaScript(
      `(() => {
        delete window.__macintoshSmokeSystemResizePointerId;
        const grow = document.querySelector(
          '[data-finder-window="window-system-disk"] [aria-label="Resize System Disk"]'
        );
        if (!(grow instanceof HTMLElement)) return;
        grow.addEventListener(
          'pointerdown',
          (event) => { window.__macintoshSmokeSystemResizePointerId = event.pointerId; },
          { once: true }
        );
      })()`,
      true,
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
    await pause(32);
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    let captureOwned = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      captureOwned = (await window.webContents.executeJavaScript(
        `(() => {
          const grow = document.querySelector(
            '[data-finder-window="window-system-disk"] [aria-label="Resize System Disk"]'
          );
          const pointerId = window.__macintoshSmokeSystemResizePointerId;
          return grow instanceof HTMLElement &&
            typeof pointerId === 'number' &&
            grow.hasPointerCapture(pointerId);
        })()`,
        true,
      )) as boolean;
      if (captureOwned) break;
      await pause(10);
    }
    if (!captureOwned) {
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...from,
      });
      throw new Error('The Finder grow box did not acquire native pointer capture.');
    }
    await pause(24);
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round((from.x + to.x) / 2),
      y: Math.round((from.y + to.y) / 2),
    });
    await pause(20);
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
  const resizedWindow = await waitForSystemWindowSize(
    originalWindow.width + resizeDelta.x,
    originalWindow.height + resizeDelta.y,
  );
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
  const resizeRestoredWindow = await waitForSystemWindowSize(
    originalWindow.width,
    originalWindow.height,
  );
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
      handle.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokeCalculatorPointerId = event.pointerId; },
        { once: true }
      );
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
  await pause(32);
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...calculatorDragStart.pointer,
  });
  let calculatorCaptureOwned = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    calculatorCaptureOwned = (await window.webContents.executeJavaScript(
      `(() => {
        const handle = document.querySelector('[data-calculator-drag-handle="true"]');
        const pointerId = window.__macintoshSmokeCalculatorPointerId;
        return handle instanceof HTMLElement &&
          typeof pointerId === 'number' &&
          handle.hasPointerCapture(pointerId);
      })()`,
      true,
    )) as boolean;
    if (calculatorCaptureOwned) break;
    await pause(10);
  }
  if (!calculatorCaptureOwned) {
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...calculatorDragStart.pointer,
    });
    throw new Error('Calculator drag did not acquire native pointer capture.');
  }
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

  const desktopImportPoint = { x: 121, y: 591 };
  const importDropPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const surface = document.querySelector('.desktop-surface');
      if (!(surface instanceof HTMLElement)) return null;
      const rect = surface.getBoundingClientRect();
      return {
        x: Math.round(rect.left + ${desktopImportPoint.x}),
        y: Math.round(rect.top + ${desktopImportPoint.y})
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
      const documentItem = document.querySelector('[data-desktop-vfs-item][aria-label="Dropped Note.txt"]');
      const folderItem = document.querySelector('[data-desktop-vfs-item][aria-label="Drop Folder"]');
      if (!(documentItem instanceof HTMLElement) || !(folderItem instanceof HTMLElement)) return null;
      return {
        documentVisible: true,
        folderVisible: true,
        documentPosition: { x: Number(documentItem.dataset.iconX), y: Number(documentItem.dataset.iconY) },
        folderPosition: { x: Number(folderItem.dataset.iconX), y: Number(folderItem.dataset.iconY) },
        notice: document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? ''
      };
    })()`,
    true,
  )) as {
    documentVisible: boolean;
    folderVisible: boolean;
    documentPosition: SmokePoint;
    folderPosition: SmokePoint;
    notice: string;
  } | null;
  if (
    !externalImport?.documentVisible ||
    !externalImport.folderVisible ||
    externalImport.documentPosition.x !== desktopImportPoint.x ||
    externalImport.documentPosition.y !== desktopImportPoint.y ||
    externalImport.folderPosition.x !== desktopImportPoint.x + 13 ||
    externalImport.folderPosition.y !== desktopImportPoint.y + 11
  ) {
    throw new Error(`External file/folder drop failed: ${JSON.stringify(externalImport)}.`);
  }
  if (!externalImport.notice.startsWith('Copied 3 items to Desktop.')) {
    throw new Error(`External drop did not report its result: ${externalImport.notice}.`);
  }

  const desktopSelectionWorked = await window.webContents.executeJavaScript(
    `(() => {
      const documentItem = document.querySelector('[data-desktop-vfs-item][aria-label="Dropped Note.txt"]');
      const folderItem = document.querySelector('[data-desktop-vfs-item][aria-label="Drop Folder"]');
      if (!(documentItem instanceof HTMLElement) || !(folderItem instanceof HTMLElement)) return false;
      documentItem.click();
      folderItem.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      return documentItem.classList.contains('is-selected') && folderItem.classList.contains('is-selected');
    })()`,
    true,
  );
  if (!desktopSelectionWorked) throw new Error('Desktop VFS Shift-selection did not work.');

  const desktopDocumentOpenAnimation = await observeWindowAnimation(
    'Dropped Note.txt window',
    'opening',
    () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta'] });
    },
  );
  if (
    desktopDocumentOpenAnimation?.phase !== 'opening' ||
    desktopDocumentOpenAnimation.animationName !== 'finder-window-open' ||
    desktopDocumentOpenAnimation.offsetX !== '0px' ||
    desktopDocumentOpenAnimation.offsetY !== '0px'
  ) {
    throw new Error(
      `Desktop document opening did not scale from its command origin: ${JSON.stringify(desktopDocumentOpenAnimation)}.`,
    );
  }
  assertWindowAnimationShadow(desktopDocumentOpenAnimation, 'Desktop document opening animation');
  await waitForFinderWindowSettled(
    'Dropped Note.txt window',
    desktopDocumentOpenAnimation.windowId,
  );
  const desktopDocumentOpened = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Dropped Note.txt window"] .document-sheet')
      ?.textContent?.includes('external Electron drop') === true`,
    true,
  );
  if (!desktopDocumentOpened) throw new Error('Open did not use the selected Desktop document.');
  const desktopDocumentCloseAnimation = await observeWindowAnimation(
    'Dropped Note.txt window',
    'closing',
    () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
    },
  );
  if (
    desktopDocumentCloseAnimation?.phase !== 'closing' ||
    desktopDocumentCloseAnimation.animationName !== 'finder-window-close' ||
    (desktopDocumentCloseAnimation.offsetX === '0px' &&
      desktopDocumentCloseAnimation.offsetY === '0px')
  ) {
    throw new Error(
      `Desktop document closing did not scale to its icon: ${JSON.stringify(desktopDocumentCloseAnimation)}.`,
    );
  }
  assertWindowAnimationShadow(desktopDocumentCloseAnimation, 'Desktop document closing animation');
  await waitForFinderWindowAbsence(
    'Dropped Note.txt window',
    desktopDocumentCloseAnimation.windowId,
  );

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-vfs-item][aria-label="Dropped Note.txt"]')?.click()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: ['meta'] });
  await pause(60);
  const desktopInfoOpened = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Dropped Note.txt Info"]');
      return dialog instanceof HTMLElement && dialog.textContent?.includes('Desktop');
    })()`,
    true,
  );
  if (!desktopInfoOpened) throw new Error('Get Info did not use the selected Desktop document.');
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Dropped Note.txt Info"] .classic-default-button')?.click()`,
    true,
  );

  const desktopFolderOpenAnimation = await observeWindowAnimation(
    'Drop Folder window',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[data-desktop-vfs-item][aria-label="Drop Folder"]')
            ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  if (
    desktopFolderOpenAnimation?.phase !== 'opening' ||
    desktopFolderOpenAnimation.animationName !== 'finder-window-open' ||
    (desktopFolderOpenAnimation.offsetX === '0px' && desktopFolderOpenAnimation.offsetY === '0px')
  ) {
    throw new Error(
      `Desktop folder opening did not scale from its icon: ${JSON.stringify(desktopFolderOpenAnimation)}.`,
    );
  }
  assertWindowAnimationShadow(desktopFolderOpenAnimation, 'Desktop folder opening animation');
  await waitForFinderWindowSettled('Drop Folder window', desktopFolderOpenAnimation.windowId);
  const desktopFolderOpened = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Drop Folder window"] [data-vfs-item]')
      ?.textContent?.includes('Nested Note.txt') === true`,
    true,
  );
  if (!desktopFolderOpened)
    throw new Error('The imported Desktop folder did not open its hierarchy.');
  const desktopFolderCloseAnimation = await observeWindowAnimation(
    'Drop Folder window',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Drop Folder"]')?.click()`,
        true,
      ),
  );
  if (
    desktopFolderCloseAnimation?.phase !== 'closing' ||
    desktopFolderCloseAnimation.animationName !== 'finder-window-close' ||
    (desktopFolderCloseAnimation.offsetX === '0px' && desktopFolderCloseAnimation.offsetY === '0px')
  ) {
    throw new Error(
      `Desktop folder closing did not scale to its icon: ${JSON.stringify(desktopFolderCloseAnimation)}.`,
    );
  }
  assertWindowAnimationShadow(desktopFolderCloseAnimation, 'Desktop folder closing animation');
  await waitForFinderWindowAbsence('Drop Folder window', desktopFolderCloseAnimation.windowId);

  const systemDiskDropPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      if (!(disk instanceof HTMLElement)) return null;
      const bounds = disk.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`,
    true,
  )) as SmokePoint | null;
  if (!systemDiskDropPoint) throw new Error('System Disk could not be located for direct import.');
  window.webContents.debugger.attach('1.3');
  try {
    const dragData = { items: [], files: [importDocument], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
        type,
        ...systemDiskDropPoint,
        data: dragData,
      });
    }
  } finally {
    window.webContents.debugger.detach();
  }
  await pause(220);
  const directSystemDiskImport = (await window.webContents.executeJavaScript(
    `(() => ({
      visible:
        [...document.querySelectorAll(
          '[data-finder-window="window-system-disk"] [data-vfs-item]'
        )].some((item) => item.textContent?.includes('Dropped Note.txt')),
      notice: document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? ''
    }))()`,
    true,
  )) as { visible: boolean; notice: string };
  if (
    !directSystemDiskImport.visible ||
    !directSystemDiskImport.notice.startsWith('Copied 1 item to System Disk.')
  ) {
    throw new Error(`Direct System Disk import failed: ${JSON.stringify(directSystemDiskImport)}.`);
  }

  const documentBlockCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
      );
      const target = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
      );
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        };
      };
      const visiblePoint = (element) => {
        const bounds = element.getBoundingClientRect();
        for (let y = Math.ceil(bounds.top + 2); y < Math.floor(bounds.bottom - 2); y += 3) {
          for (let x = Math.ceil(bounds.left + 2); x < Math.floor(bounds.right - 2); x += 3) {
            if (document.elementFromPoint(x, y)?.closest('[data-desktop-vfs-item]') === element) {
              return { x, y };
            }
          }
        }
        return null;
      };
      const destination = visiblePoint(target);
      if (!destination) return null;
      return {
        source: center(source),
        destination,
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint; vfsCount: number } | null;
  if (!documentBlockCoordinates) {
    throw new Error('Desktop document drop-block coordinates were unavailable.');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...documentBlockCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...documentBlockCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: documentBlockCoordinates.source.x + offset,
      y: documentBlockCoordinates.source.y,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...documentBlockCoordinates.destination,
  });
  await pause(40);
  const documentDropPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const documentItem = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
      );
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('.macintosh');
      if (!(documentItem instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted:
          documentItem.classList.contains('is-file-drop-target') ||
          surface.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(documentItem).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...documentBlockCoordinates.destination,
  });
  await pause(80);
  const documentDropResult = (await window.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('[data-vfs-count]');
      return {
        vfsCount: root instanceof HTMLElement ? Number(root.dataset.vfsCount || 0) : null,
        sourcePresent: document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
        ) !== null,
        desktopPresent: document.querySelector('[data-desktop-vfs-item="applications"]') !== null
      };
    })()`,
    true,
  )) as { vfsCount: number | null; sourcePresent: boolean; desktopPresent: boolean };
  const documentDropStayedPut =
    documentDropResult.vfsCount === documentBlockCoordinates.vfsCount &&
    documentDropResult.sourcePresent &&
    !documentDropResult.desktopPresent;
  if (
    !documentDropPreview?.pointerOwned ||
    documentDropPreview.highlighted ||
    !documentDropStayedPut
  ) {
    throw new Error(
      `A Desktop document did not block an active internal drop: ${JSON.stringify({ preview: documentDropPreview, result: documentDropResult })}.`,
    );
  }
  assertPixelCursor('Internal item closed fist', documentDropPreview.cursor, 16, 16, {
    x: 8,
    y: 8,
  });

  const hostTrashDropRejected = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(trash instanceof HTMLElement) || !(glyph instanceof Element) || !(root instanceof HTMLElement)) return null;
      const bounds = glyph.getBoundingClientRect();
      const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const data = new DataTransfer();
      data.items.add(new File(['host-drop-probe'], 'Trash Probe.txt', { type: 'text/plain' }));
      glyph.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      const highlighted = trash.classList.contains('is-file-drop-target');
      glyph.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      return { highlighted, vfsCount: Number(root.dataset.vfsCount || 0) };
    })()`,
    true,
  )) as { highlighted: boolean; vfsCount: number } | null;
  await pause(80);
  const hostTrashVfsCount = (await window.webContents.executeJavaScript(
    `Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)`,
    true,
  )) as number;
  if (
    !hostTrashDropRejected ||
    hostTrashDropRejected.highlighted ||
    hostTrashDropRejected.vfsCount !== hostTrashVfsCount
  ) {
    throw new Error(
      `Trash accepted an external file drop: ${JSON.stringify(hostTrashDropRejected)}.`,
    );
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

  const freeIconCoordinates = (await window.webContents.executeJavaScript(
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
      return {
        source: {
          x: Math.round(sourceRect.left + hotspot.x),
          y: Math.round(sourceRect.top + hotspot.y)
        },
        destination: client,
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint; vfsCount: number } | null;
  if (!freeIconCoordinates) throw new Error('Free Finder placement coordinates were unavailable.');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...freeIconCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...freeIconCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: freeIconCoordinates.source.x + offset,
      y: freeIconCoordinates.source.y,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...freeIconCoordinates.destination,
  });
  await pause(40);
  const freeIconPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-vfs-item="applications"]');
      const canvas = document.querySelector('[data-icon-layout-parent="system-disk"]');
      const root = document.querySelector('.macintosh');
      if (!(source instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: canvas.classList.contains('is-file-drop-target'),
        pointerOwned: !source.hasAttribute('draggable') && root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(canvas).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...freeIconCoordinates.destination,
  });
  if (!freeIconPreview?.highlighted || !freeIconPreview.pointerOwned) {
    throw new Error(
      `Free Finder placement did not use the pointer-owned internal drag surface: ${JSON.stringify(freeIconPreview)}.`,
    );
  }
  assertPixelCursor('Free Finder placement closed fist', freeIconPreview.cursor, 16, 16, {
    x: 8,
    y: 8,
  });
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
    placedIcon.vfsCount !== freeIconCoordinates.vfsCount
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

  const desktopInternalInitial = { x: 713, y: 627 };
  const finderToDesktopCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="utilities"]'
      );
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      const hotspot = { x: 29, y: 17 };
      const destination = {
        x: Math.round(surfaceBounds.left + ${desktopInternalInitial.x} + hotspot.x),
        y: Math.round(surfaceBounds.top + ${desktopInternalInitial.y} + hotspot.y)
      };
      if (document.elementFromPoint(destination.x, destination.y) !== surface) return null;
      return {
        source: {
          x: Math.round(sourceBounds.left + hotspot.x),
          y: Math.round(sourceBounds.top + hotspot.y)
        },
        destination,
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint; vfsCount: number } | null;
  if (!finderToDesktopCoordinates) {
    throw new Error('Finder-to-Desktop drag coordinates were unavailable.');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...finderToDesktopCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...finderToDesktopCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: finderToDesktopCoordinates.source.x + offset,
      y: finderToDesktopCoordinates.source.y,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...finderToDesktopCoordinates.destination,
  });
  await pause(40);
  const finderToDesktopPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('.macintosh');
      if (!(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: surface.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(surface).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...finderToDesktopCoordinates.destination,
  });
  if (!finderToDesktopPreview?.highlighted || !finderToDesktopPreview.pointerOwned) {
    throw new Error(
      `Finder-to-Desktop drag did not retain pointer ownership: ${JSON.stringify(finderToDesktopPreview)}.`,
    );
  }
  assertPixelCursor('Finder-to-Desktop closed fist', finderToDesktopPreview.cursor, 16, 16, {
    x: 8,
    y: 8,
  });
  await pause(120);
  const movedDesktopItem = (await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('[data-desktop-vfs-item="utilities"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(item instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        x: Number(item.dataset.iconX),
        y: Number(item.dataset.iconY),
        vfsCount: Number(root.dataset.vfsCount || 0),
        notice: document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? ''
      };
    })()`,
    true,
  )) as { x: number; y: number; vfsCount: number; notice: string } | null;
  if (
    !movedDesktopItem ||
    movedDesktopItem.x !== desktopInternalInitial.x ||
    movedDesktopItem.y !== desktopInternalInitial.y ||
    movedDesktopItem.vfsCount !== finderToDesktopCoordinates.vfsCount ||
    !movedDesktopItem.notice.startsWith('Moved 1 item to Desktop.')
  ) {
    throw new Error(
      `Finder item did not become a positioned Desktop child: ${JSON.stringify(movedDesktopItem)}.`,
    );
  }

  const desktopInternalFinal = { x: 593, y: 649 };
  const desktopRepositionCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-desktop-vfs-item="utilities"]');
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      const hotspot = { x: 23, y: 15 };
      const destination = {
        x: Math.round(surfaceBounds.left + ${desktopInternalFinal.x} + hotspot.x),
        y: Math.round(surfaceBounds.top + ${desktopInternalFinal.y} + hotspot.y)
      };
      if (document.elementFromPoint(destination.x, destination.y) !== surface) return null;
      return {
        source: {
          x: Math.round(sourceBounds.left + hotspot.x),
          y: Math.round(sourceBounds.top + hotspot.y)
        },
        destination,
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint; vfsCount: number } | null;
  if (!desktopRepositionCoordinates) {
    throw new Error('Desktop reposition coordinates were unavailable.');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...desktopRepositionCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...desktopRepositionCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: desktopRepositionCoordinates.source.x + offset,
      y: desktopRepositionCoordinates.source.y,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...desktopRepositionCoordinates.destination,
  });
  await pause(40);
  const desktopRepositionPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('.macintosh');
      if (!(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: surface.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(surface).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...desktopRepositionCoordinates.destination,
  });
  if (!desktopRepositionPreview?.highlighted || !desktopRepositionPreview.pointerOwned) {
    throw new Error(
      `Desktop reposition did not retain pointer ownership: ${JSON.stringify(desktopRepositionPreview)}.`,
    );
  }
  assertPixelCursor('Desktop reposition closed fist', desktopRepositionPreview.cursor, 16, 16, {
    x: 8,
    y: 8,
  });
  await pause(100);
  const repositionedDesktopItem = (await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('[data-desktop-vfs-item="utilities"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(item instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        x: Number(item.dataset.iconX),
        y: Number(item.dataset.iconY),
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { x: number; y: number; vfsCount: number } | null;
  if (
    !repositionedDesktopItem ||
    repositionedDesktopItem.x !== desktopInternalFinal.x ||
    repositionedDesktopItem.y !== desktopInternalFinal.y ||
    repositionedDesktopItem.vfsCount !== desktopRepositionCoordinates.vfsCount
  ) {
    throw new Error(
      `Desktop item did not commit its free reposition: ${JSON.stringify(repositionedDesktopItem)}.`,
    );
  }

  const importCaptureDestination = process.env.MACINTOSH_SMOKE_IMPORT_CAPTURE_PATH;
  if (importCaptureDestination) {
    const image = await window.webContents.capturePage();
    await mkdir(path.dirname(importCaptureDestination), { recursive: true });
    await writeFile(importCaptureDestination, image.toPNG());
  }

  const internalFolderCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="system-folder"]'
      );
      const destination = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="documents"]'
      );
      if (!(source instanceof HTMLElement) || !(destination instanceof HTMLElement)) return null;
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        };
      };
      return {
        source: center(source),
        destination: center(destination)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint } | null;
  if (!internalFolderCoordinates) {
    throw new Error('Internal folder drag coordinates were unavailable.');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...internalFolderCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...internalFolderCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: internalFolderCoordinates.source.x,
      y: internalFolderCoordinates.source.y + offset,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...internalFolderCoordinates.destination,
  });
  await pause(40);
  const internalFolderPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="system-folder"]'
      );
      const destination = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="documents"]'
      );
      const root = document.querySelector('.macintosh');
      if (!(source instanceof HTMLElement) || !(destination instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: destination.classList.contains('is-file-drop-target'),
        pointerOwned: !source.hasAttribute('draggable') && root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(destination).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...internalFolderCoordinates.destination,
  });
  if (!internalFolderPreview?.highlighted || !internalFolderPreview.pointerOwned) {
    throw new Error(
      `Internal folder drag did not keep pointer ownership over its target: ${JSON.stringify(internalFolderPreview)}.`,
    );
  }
  assertPixelCursor('Internal folder closed fist', internalFolderPreview.cursor, 16, 16, {
    x: 8,
    y: 8,
  });
  await pause(120);
  const movedFolderHidden = await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="system-folder"]'
    ) === null`,
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

  type SmokeDiskDragPreview = {
    sourceDistance: number;
    sourceDragging: boolean;
    previewDeltaX: number;
    previewDeltaY: number;
    width: number;
    height: number;
    artworkVariant: string | null;
    shadowVariant: string | null;
    shadowOffsetX: number;
    shadowOffsetY: number;
    pointerEvents: string;
    borderStyle: string;
    outlineStyle: string;
  };

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
        let dragPreview: SmokeDiskDragPreview | null = null;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          dragPreview = (await window.webContents.executeJavaScript(
            `(() => {
              const disk = document.querySelector('[data-desktop-icon="system-disk"]');
              const sourceArtwork = disk?.querySelector('.pixel-icon');
              const previewRoot = document.querySelector('[data-system-disk-drag-preview="true"]');
              const preview = previewRoot?.querySelector('[data-system-disk-drag-preview-icon="true"]');
              const artwork = preview?.querySelector('.pixel-icon-drag-artwork');
              const shadow = preview?.querySelector('.pixel-icon-drag-shadow');
              if (!(disk instanceof HTMLElement) || !(sourceArtwork instanceof SVGElement) ||
                  !(previewRoot instanceof HTMLElement) || !(preview instanceof HTMLElement) ||
                  !(artwork instanceof SVGElement) || !(shadow instanceof SVGElement)) return null;
              const diskBounds = disk.getBoundingClientRect();
              const sourceBounds = sourceArtwork.getBoundingClientRect();
              const artworkBounds = artwork.getBoundingClientRect();
              const shadowBounds = shadow.getBoundingClientRect();
              const previewStyle = getComputedStyle(preview);
              return {
                sourceDistance: Math.hypot(
                  diskBounds.left + diskBounds.width / 2 - ${from.x},
                  diskBounds.top + diskBounds.height / 2 - ${from.y}
                ),
                sourceDragging: disk.classList.contains('is-dragging'),
                previewDeltaX: Math.round(artworkBounds.left - sourceBounds.left),
                previewDeltaY: Math.round(artworkBounds.top - sourceBounds.top),
                width: Math.round(artworkBounds.width),
                height: Math.round(artworkBounds.height),
                artworkVariant: artwork.dataset.pixelIconVariant ?? null,
                shadowVariant: shadow.dataset.pixelIconVariant ?? null,
                shadowOffsetX: Math.round(shadowBounds.left - artworkBounds.left),
                shadowOffsetY: Math.round(shadowBounds.top - artworkBounds.top),
                pointerEvents: getComputedStyle(previewRoot).pointerEvents,
                borderStyle: previewStyle.borderStyle,
                outlineStyle: previewStyle.outlineStyle
              };
            })()`,
            true,
          )) as SmokeDiskDragPreview | null;
          if (
            dragPreview &&
            dragPreview.sourceDistance <= 2 &&
            dragPreview.previewDeltaX === pointer.x - from.x &&
            dragPreview.previewDeltaY === pointer.y - from.y
          ) {
            break;
          }
          await pause(15);
        }
        if (
          !dragPreview ||
          dragPreview.sourceDistance > 2 ||
          dragPreview.sourceDragging ||
          dragPreview.previewDeltaX !== pointer.x - from.x ||
          dragPreview.previewDeltaY !== pointer.y - from.y ||
          dragPreview.width !== 32 ||
          dragPreview.height !== 32 ||
          dragPreview.artworkVariant !== 'artwork' ||
          dragPreview.shadowVariant !== 'shadow' ||
          dragPreview.shadowOffsetX !== 3 ||
          dragPreview.shadowOffsetY !== 3 ||
          dragPreview.pointerEvents !== 'none' ||
          dragPreview.borderStyle !== 'none' ||
          dragPreview.outlineStyle !== 'none'
        ) {
          throw new Error(
            `System Disk did not use its icon-only drag preview: ${JSON.stringify(dragPreview)}.`,
          );
        }
      }
      if (verifyFollowing && step === steps) {
        const desktopShadow = (await window.webContents.executeJavaScript(
          `(() => {
            const preview = document.querySelector('[data-system-disk-drag-preview-icon="true"]');
            const shadow = preview?.querySelector('.pixel-icon-drag-shadow');
            if (!(preview instanceof HTMLElement) || !(shadow instanceof SVGElement)) return null;
            return {
              solid: preview.classList.contains('is-solid-shadow'),
              fullyBlack: [...shadow.querySelectorAll('rect')].every(
                (rect) => getComputedStyle(rect).fill === 'rgb(0, 0, 0)'
              )
            };
          })()`,
          true,
        )) as { solid: boolean; fullyBlack: boolean } | null;
        if (!desktopShadow?.solid || !desktopShadow.fullyBlack) {
          throw new Error(
            `System Disk shadow did not switch to solid black over the Desktop: ${JSON.stringify(desktopShadow)}.`,
          );
        }
      }
    }
  };

  const beginDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    verifyFollowing: boolean,
  ): Promise<void> => {
    type SystemDiskInputReadiness = {
      hit: string | null;
      hovered: boolean;
      pointerOwned: boolean;
      previewVisible: boolean;
    };
    let inputReadiness: SystemDiskInputReadiness | null = null;
    for (let attempt = 0; attempt < (verifyFollowing ? 12 : 1); attempt += 1) {
      window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
      await pause(25);
      if (!verifyFollowing) break;
      inputReadiness = (await window.webContents.executeJavaScript(
        `(() => {
          const disk = document.querySelector('[data-desktop-icon="system-disk"]');
          const root = document.querySelector('.macintosh');
          const hit = document.elementFromPoint(${from.x}, ${from.y});
          if (!(disk instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
          return {
            hit: hit instanceof Element
              ? hit.closest('[data-desktop-icon]')?.getAttribute('data-desktop-icon') ?? null
              : null,
            hovered: disk.matches(':hover'),
            pointerOwned: root.dataset.itemDragging === 'true',
            previewVisible:
              document.querySelector('[data-vfs-item-drag-preview="true"], [data-system-disk-drag-preview="true"]') !== null
          };
        })()`,
        true,
      )) as SystemDiskInputReadiness | null;
      if (
        inputReadiness?.hit === 'system-disk' &&
        inputReadiness.hovered &&
        !inputReadiness.pointerOwned &&
        !inputReadiness.previewVisible
      ) {
        break;
      }
      await pause(15);
    }
    if (
      verifyFollowing &&
      (inputReadiness?.hit !== 'system-disk' ||
        !inputReadiness.hovered ||
        inputReadiness.pointerOwned ||
        inputReadiness.previewVisible)
    ) {
      throw new Error(
        `System Disk was not ready to receive native pointer input: ${JSON.stringify(inputReadiness)}.`,
      );
    }
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    let diskPressed = !verifyFollowing;
    for (let attempt = 0; verifyFollowing && attempt < 12; attempt += 1) {
      diskPressed = (await window.webContents.executeJavaScript(
        `document.querySelector('[data-desktop-icon="system-disk"]')
          ?.classList.contains('is-pointer-pressed') === true`,
        true,
      )) as boolean;
      if (diskPressed) break;
      await pause(15);
    }
    if (!diskPressed) {
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...from,
      });
      throw new Error('System Disk did not acknowledge its native pointer press.');
    }
    if (verifyFollowing) {
      const delta = { x: to.x - from.x, y: to.y - from.y };
      const distance = Math.max(1, Math.hypot(delta.x, delta.y));
      const thresholdPoint = {
        x: Math.round(from.x + (delta.x / distance) * 5),
        y: Math.round(from.y + (delta.y / distance) * 5),
      };
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        button: 'left',
        modifiers: ['leftbuttondown'],
        ...thresholdPoint,
      });
      let previewOwned = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        previewOwned = (await window.webContents.executeJavaScript(
          `(() => {
            const disk = document.querySelector('[data-desktop-icon="system-disk"]');
            const root = document.querySelector('.macintosh');
            return disk instanceof HTMLElement &&
              root instanceof HTMLElement &&
              !disk.classList.contains('is-pointer-pressed') &&
              root.dataset.itemDragging === 'true' &&
              document.querySelector('[data-system-disk-drag-preview="true"]') !== null;
          })()`,
          true,
        )) as boolean;
        if (previewOwned) break;
        await pause(15);
      }
      if (!previewOwned) {
        window.webContents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          ...thresholdPoint,
        });
        throw new Error(
          'System Disk did not retain pointer ownership while crossing the drag threshold.',
        );
      }
    }
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
  assertPixelCursor('Desktop icon closed fist', trashPreviewMoved.cursor, 16, 16, { x: 8, y: 8 });
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
  smokeSaveFailureTarget = 'presentation';
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

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-finder-window="window-system-disk"]')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9001 })
    )`,
    true,
  );
  await pause(40);

  const rejectedInternalTrashCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
      );
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const label = trash?.querySelector('[data-desktop-icon-label="trash"]');
      if (!(source instanceof HTMLElement) || !(trash instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      return {
        source: {
          x: Math.round(sourceBounds.left + sourceBounds.width / 2),
          y: Math.round(sourceBounds.top + sourceBounds.height / 2)
        },
        destination: {
          x: Math.round(labelBounds.left + labelBounds.width / 2),
          y: Math.round(labelBounds.top + labelBounds.height / 2)
        }
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint } | null;
  if (!rejectedInternalTrashCoordinates) {
    throw new Error('The Trash-label internal-drop coordinates were unavailable.');
  }
  await beginDrag(
    rejectedInternalTrashCoordinates.source,
    rejectedInternalTrashCoordinates.destination,
    false,
  );
  const rejectedInternalTrashPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const root = document.querySelector('.macintosh');
      if (!(trash instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: trash.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(trash).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  releaseDrag(rejectedInternalTrashCoordinates.destination);
  await pause(100);
  const rejectedInternalItemRemained = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
    ) !== null`,
    true,
  )) as boolean;
  if (
    !rejectedInternalTrashPreview?.pointerOwned ||
    rejectedInternalTrashPreview.highlighted ||
    !rejectedInternalItemRemained
  ) {
    throw new Error(
      `The Trash label accepted an internal item: ${JSON.stringify(rejectedInternalTrashPreview)}.`,
    );
  }
  assertPixelCursor(
    'Rejected internal Trash closed fist',
    rejectedInternalTrashPreview.cursor,
    16,
    16,
    { x: 8, y: 8 },
  );

  const acceptedInternalTrashCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
      );
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
      if (!(source instanceof HTMLElement) || !(trash instanceof HTMLElement) || !(glyph instanceof Element)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const glyphBounds = glyph.getBoundingClientRect();
      return {
        source: {
          x: Math.round(sourceBounds.left + sourceBounds.width / 2),
          y: Math.round(sourceBounds.top + sourceBounds.height / 2)
        },
        destination: {
          x: Math.round(glyphBounds.left + glyphBounds.width / 2),
          y: Math.round(glyphBounds.top + glyphBounds.height / 2)
        }
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint } | null;
  if (!acceptedInternalTrashCoordinates) {
    throw new Error('The Trash-glyph internal-drop coordinates were unavailable.');
  }
  await beginDrag(
    acceptedInternalTrashCoordinates.source,
    acceptedInternalTrashCoordinates.destination,
    false,
  );
  const acceptedInternalTrashPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const root = document.querySelector('.macintosh');
      if (!(trash instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: trash.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        cursor: getComputedStyle(trash).cursor
      };
    })()`,
    true,
  )) as { highlighted: boolean; pointerOwned: boolean; cursor: string } | null;
  releaseDrag(acceptedInternalTrashCoordinates.destination);
  await pause(120);
  const acceptedInternalItemMoved = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
    ) === null`,
    true,
  )) as boolean;
  if (
    !acceptedInternalTrashPreview?.pointerOwned ||
    !acceptedInternalTrashPreview.highlighted ||
    !acceptedInternalItemMoved
  ) {
    throw new Error(
      `The rendered Trash glyph rejected an internal item: ${JSON.stringify(acceptedInternalTrashPreview)}.`,
    );
  }
  assertPixelCursor(
    'Accepted internal Trash closed fist',
    acceptedInternalTrashPreview.cursor,
    16,
    16,
    { x: 8, y: 8 },
  );

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
  const scaledGeometry = await readDesktopGeometry();
  if (
    window.webContents.getZoomFactor() !== 1.25 ||
    !scaledGeometry ||
    scaledGeometry.trashGlyph.left < 0 ||
    scaledGeometry.trashGlyph.right > scaledGeometry.viewport.width ||
    scaledGeometry.trashGlyph.top < 0 ||
    scaledGeometry.trashGlyph.bottom > scaledGeometry.viewport.height ||
    scaledGeometry.viewport.width >= unscaledViewport.width ||
    scaledGeometry.viewport.height >= unscaledViewport.height
  ) {
    throw new Error(`Scaled Trash geometry failed: ${JSON.stringify(scaledGeometry)}.`);
  }
  const scaledInputPoint = (point: SmokePoint): SmokePoint => ({
    x: Math.round(point.x * window.webContents.getZoomFactor()),
    y: Math.round(point.y * window.webContents.getZoomFactor()),
  });
  const scaledProbePoints = trashProbePoints(scaledGeometry);
  await beginDrag(
    scaledInputPoint(scaledGeometry.disk),
    scaledInputPoint(scaledProbePoints.insideEdge),
    false,
  );
  await waitForTrashHighlight(true);
  await moveHeldPointer(
    scaledInputPoint(scaledProbePoints.insideEdge),
    scaledInputPoint(scaledProbePoints.outsideEdge),
    4,
  );
  await waitForTrashHighlight(false);
  await moveHeldPointer(
    scaledInputPoint(scaledProbePoints.outsideEdge),
    scaledInputPoint(scaledProbePoints.label),
    6,
  );
  await waitForTrashHighlight(false);
  await moveHeldPointer(
    scaledInputPoint(scaledProbePoints.label),
    scaledInputPoint(scaledProbePoints.insideEdge),
    6,
  );
  await waitForTrashHighlight(true);
  await moveHeldPointer(
    scaledInputPoint(scaledProbePoints.insideEdge),
    scaledInputPoint(scaledProbePoints.outsideEdge),
    4,
  );
  await waitForTrashHighlight(false);
  releaseDrag(scaledInputPoint(scaledProbePoints.outsideEdge));
  await pause(80);
  await assertRejectedDiskRelease(scaledProbePoints.outsideEdge, 'The scaled outside-edge release');

  const scaledVfsTrashCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-system-disk"]');
      if (finder instanceof HTMLElement) finder.style.removeProperty('pointer-events');
      const source = finder?.querySelector('[data-vfs-item="documents"]');
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const glyph = trash?.querySelector('[data-trash-drop-bounds="true"]');
      if (!(finder instanceof HTMLElement) || !(source instanceof HTMLElement) || !(glyph instanceof Element)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const glyphBounds = glyph.getBoundingClientRect();
      const sourcePoint = {
        x: Math.round(sourceBounds.left + sourceBounds.width / 2),
        y: Math.round(sourceBounds.top + sourceBounds.height / 2)
      };
      if (document.elementFromPoint(sourcePoint.x, sourcePoint.y)?.closest('[data-vfs-item]') !== source) {
        return null;
      }
      return {
        source: sourcePoint,
        destination: {
          x: Math.round(glyphBounds.left + glyphBounds.width / 2),
          y: Math.round(glyphBounds.top + glyphBounds.height / 2)
        }
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint } | null;
  if (!scaledVfsTrashCoordinates) {
    throw new Error('The scaled ordinary-item Trash coordinates were unavailable.');
  }
  const scaledVfsTrashInput = {
    source: scaledInputPoint(scaledVfsTrashCoordinates.source),
    destination: scaledInputPoint(scaledVfsTrashCoordinates.destination),
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...scaledVfsTrashInput.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...scaledVfsTrashInput.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: scaledVfsTrashInput.source.x + Math.round(offset * window.webContents.getZoomFactor()),
      y: scaledVfsTrashInput.source.y,
    });
    await pause(24);
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-finder-window="window-system-disk"]')
      ?.style.setProperty('pointer-events', 'none')`,
    true,
  );
  await moveHeldPointer(
    {
      x: scaledVfsTrashInput.source.x + Math.round(4 * window.webContents.getZoomFactor()),
      y: scaledVfsTrashInput.source.y,
    },
    scaledVfsTrashInput.destination,
    12,
  );
  const scaledVfsTrashPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const root = document.querySelector('.macintosh');
      const preview = document.querySelector(
        '[data-vfs-item-drag-preview-node="documents"]'
      );
      if (!(trash instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      return {
        highlighted: trash.classList.contains('is-file-drop-target'),
        pointerOwned: root.dataset.itemDragging === 'true',
        previewVisible: preview instanceof HTMLElement,
        cursor: getComputedStyle(trash).cursor
      };
    })()`,
    true,
  )) as {
    highlighted: boolean;
    pointerOwned: boolean;
    previewVisible: boolean;
    cursor: string;
  } | null;
  if (
    !scaledVfsTrashPreview?.highlighted ||
    !scaledVfsTrashPreview.pointerOwned ||
    !scaledVfsTrashPreview.previewVisible
  ) {
    throw new Error(
      `The scaled ordinary-item Trash drop did not retain its pointer preview: ${JSON.stringify(scaledVfsTrashPreview)}.`,
    );
  }
  assertPixelCursor(
    'Scaled ordinary-item Trash closed fist',
    scaledVfsTrashPreview.cursor,
    16,
    16,
    {
      x: 8,
      y: 8,
    },
  );
  releaseDrag(scaledVfsTrashInput.destination);
  let scaledVfsTrashParent: string | null | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    scaledVfsTrashParent = (await loadState()).nodes.find(
      (node) => node.id === 'documents',
    )?.parentId;
    if (scaledVfsTrashParent === 'trash') break;
    await pause(25);
  }
  if (scaledVfsTrashParent !== 'trash') {
    throw new Error(
      `The scaled ordinary-item Trash drop did not commit its parent change: ${String(scaledVfsTrashParent)}.`,
    );
  }

  window.webContents.setZoomFactor(1);
  window.setContentSize(1152, 768);
  await pause(140);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry did not recover after scaled testing.');

  const repositionTarget = { x: 137, y: 343 };
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-icon="trash"]')
      ?.style.setProperty('pointer-events', 'none')`,
    true,
  );
  await sendDrag(desktopGeometry.disk, repositionTarget, true);
  await pause(260);
  await assertRejectedDiskRelease(repositionTarget, 'The free desktop release');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-icon="trash"]')
      ?.style.removeProperty('pointer-events')`,
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
    const desktopDocument = document.querySelector(
      '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
    );
    const desktopFolder = document.querySelector(
      '[data-desktop-vfs-item][aria-label="Drop Folder"]'
    );
    const desktopUtilities = document.querySelector('[data-desktop-vfs-item="utilities"]');
    if (
      !(disk instanceof HTMLElement) ||
      !(root instanceof HTMLElement) ||
      !(finder instanceof HTMLElement) ||
      !(applications instanceof HTMLElement) ||
      !(desktopDocument instanceof HTMLElement) ||
      !(desktopFolder instanceof HTMLElement) ||
      !(desktopUtilities instanceof HTMLElement)
    ) return null;
    const rect = disk.getBoundingClientRect();
    return {
      loaded: document.body.dataset.stateLoaded === 'true',
      diskLabel: disk.getAttribute('aria-label'),
      diskVisible: rect.width > 0 && rect.height > 0,
      diskX: Number.parseFloat(disk.style.getPropertyValue('--icon-x')),
      diskY: Number.parseFloat(disk.style.getPropertyValue('--icon-y')),
      applicationsX: Number(applications.dataset.iconX),
      applicationsY: Number(applications.dataset.iconY),
      desktopDocumentX: Number(desktopDocument.dataset.iconX),
      desktopDocumentY: Number(desktopDocument.dataset.iconY),
      desktopFolderX: Number(desktopFolder.dataset.iconX),
      desktopFolderY: Number(desktopFolder.dataset.iconY),
      desktopUtilitiesX: Number(desktopUtilities.dataset.iconX),
      desktopUtilitiesY: Number(desktopUtilities.dataset.iconY),
      vfsCount: Number(root.dataset.vfsCount || 0),
      windowLeft: Number.parseFloat(finder.style.left),
      windowTop: Number.parseFloat(finder.style.top),
      windowWidth: Number.parseFloat(finder.style.width),
      windowHeight: Number.parseFloat(finder.style.height)
    };
  })()`,
    true,
  );

  const destination = path.join(app.getPath('userData'), PROBE_FILE_NAME);
  await writeFile(destination, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  normalQuit.quitWithoutFlush();
};

const runNormalQuitProbe = async (window: BrowserWindow): Promise<void> => {
  await waitForRenderer(window);

  smokeSaveFailureTarget = 'presentation';
  window.close();

  const failureDeadline = Date.now() + 2_000;
  let saveFailureAlert: { message: string; pending: boolean } | null = null;
  while (Date.now() < failureDeadline) {
    saveFailureAlert = (await window.webContents.executeJavaScript(
      `(() => {
        const alert = document.querySelector('[aria-label="Persistence error"]');
        const root = document.querySelector('.macintosh');
        if (!(alert instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
        return {
          message: alert.textContent?.trim() ?? '',
          pending: root.dataset.normalQuitPending === 'true'
        };
      })()`,
      true,
    )) as { message: string; pending: boolean } | null;
    if (saveFailureAlert) break;
    await pause(20);
  }
  if (
    !saveFailureAlert ||
    !saveFailureAlert.message.includes('could not quit') ||
    saveFailureAlert.pending
  ) {
    throw new Error(
      `Normal quit save failure was not recoverable: ${JSON.stringify(saveFailureAlert)}.`,
    );
  }

  await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="Persistence error"] button\')?.click()',
    true,
  );
  window.focus();
  await pause(50);
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-finder-window]').forEach((finder) => {
      if (
        finder instanceof HTMLElement &&
        finder.dataset.finderWindow !== 'window-applications'
      ) {
        finder.style.pointerEvents = 'none';
      }
    })`,
    true,
  );

  const committedMove = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const handle = finder?.querySelector('[data-window-drag-handle="true"]');
      if (!(finder instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      const frame = finder.getBoundingClientRect();
      const handleBounds = handle.getBoundingClientRect();
      handle.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokeNormalQuitMovePointerId = event.pointerId; },
        { once: true }
      );
      const position = {
        x: Number.parseFloat(finder.style.left),
        y: Number.parseFloat(finder.style.top)
      };
      return {
        current: {
          ...position,
          width: Number.parseFloat(finder.style.width),
          height: Number.parseFloat(finder.style.height)
        },
        expected: {
          x: position.x + ${NORMAL_QUIT_WINDOW_DELTA.x},
          y: position.y + ${NORMAL_QUIT_WINDOW_DELTA.y},
          width: Number.parseFloat(finder.style.width),
          height: Number.parseFloat(finder.style.height)
        },
        pointer: {
          x: Math.round(handleBounds.left + handleBounds.width / 2),
          y: Math.round(handleBounds.top + handleBounds.height / 2)
        },
        rendered: {
          left: Math.round(frame.left),
          top: Math.round(frame.top)
        }
      };
    })()`,
    true,
  )) as {
    current: { x: number; y: number; width: number; height: number };
    expected: { x: number; y: number; width: number; height: number };
    pointer: SmokePoint;
    rendered: { left: number; top: number };
  } | null;
  if (
    !committedMove ||
    !Object.values(committedMove.current).every(Number.isFinite) ||
    !Object.values(committedMove.expected).every(Number.isFinite)
  ) {
    throw new Error(
      `Normal-quit presentation geometry was unavailable: ${JSON.stringify(committedMove)}.`,
    );
  }

  const moveDestination = {
    x: committedMove.pointer.x + NORMAL_QUIT_WINDOW_DELTA.x,
    y: committedMove.pointer.y + NORMAL_QUIT_WINDOW_DELTA.y,
  };
  type NormalQuitMoveInputReadiness = {
    documentFocused: boolean;
    hitHandle: boolean;
    hitWindow: string | null;
    normalQuitPending: boolean;
    persistenceAlertPresent: boolean;
  };
  let moveCaptureOwned = false;
  let moveInputReadiness: NormalQuitMoveInputReadiness | null = null;
  for (let pressAttempt = 0; pressAttempt < 8 && !moveCaptureOwned; pressAttempt += 1) {
    window.focus();
    window.webContents.sendInputEvent({ type: 'mouseMove', ...committedMove.pointer });
    await pause(30);
    moveInputReadiness = (await window.webContents.executeJavaScript(
      `(() => {
        const handle = document.querySelector(
          '[data-finder-window="window-applications"] [data-window-drag-handle="true"]'
        );
        const root = document.querySelector('.macintosh');
        const hit = document.elementFromPoint(
          ${committedMove.pointer.x},
          ${committedMove.pointer.y}
        );
        return {
          documentFocused: document.hasFocus(),
          hitHandle:
            handle instanceof HTMLElement &&
            hit instanceof Element &&
            hit.closest('[data-window-drag-handle="true"]') === handle,
          hitWindow:
            hit instanceof Element
              ? hit.closest('[data-finder-window]')?.getAttribute('data-finder-window') ?? null
              : null,
          normalQuitPending:
            root instanceof HTMLElement && root.dataset.normalQuitPending === 'true',
          persistenceAlertPresent:
            document.querySelector('[aria-label="Persistence error"]') !== null
        };
      })()`,
      true,
    )) as NormalQuitMoveInputReadiness;
    if (
      !moveInputReadiness.documentFocused ||
      !moveInputReadiness.hitHandle ||
      moveInputReadiness.hitWindow !== 'window-applications' ||
      moveInputReadiness.normalQuitPending ||
      moveInputReadiness.persistenceAlertPresent
    ) {
      await pause(20);
      continue;
    }
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...committedMove.pointer,
    });
    for (let captureAttempt = 0; captureAttempt < 10; captureAttempt += 1) {
      moveCaptureOwned = (await window.webContents.executeJavaScript(
        `(() => {
          const handle = document.querySelector(
            '[data-finder-window="window-applications"] [data-window-drag-handle="true"]'
          );
          const pointerId = window.__macintoshSmokeNormalQuitMovePointerId;
          return handle instanceof HTMLElement &&
            typeof pointerId === 'number' &&
            handle.hasPointerCapture(pointerId);
        })()`,
        true,
      )) as boolean;
      if (moveCaptureOwned) break;
      await pause(10);
    }
    if (!moveCaptureOwned) {
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...committedMove.pointer,
      });
      await pause(20);
    }
  }
  if (!moveCaptureOwned) {
    throw new Error(
      `Normal-quit presentation move did not acquire native pointer capture: ${JSON.stringify(moveInputReadiness)}.`,
    );
  }
  for (let step = 1; step <= 3; step += 1) {
    const progress = step / 3;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        committedMove.pointer.x + (moveDestination.x - committedMove.pointer.x) * progress,
      ),
      y: Math.round(
        committedMove.pointer.y + (moveDestination.y - committedMove.pointer.y) * progress,
      ),
    });
    await pause(5);
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...moveDestination,
  });
  const mutationCommittedAt = Date.now();

  type NormalQuitCommittedGeometry = {
    x: number;
    y: number;
    width: number;
    height: number;
    dragging: boolean;
  };
  let renderedCommittedGeometry: NormalQuitCommittedGeometry | null = null;
  const commitDeadline = mutationCommittedAt + 120;
  while (Date.now() < commitDeadline) {
    renderedCommittedGeometry = (await window.webContents.executeJavaScript(
      `(() => {
        const finder = document.querySelector('[data-finder-window="window-applications"]');
        if (!(finder instanceof HTMLElement)) return null;
        return {
          x: Number.parseFloat(finder.style.left),
          y: Number.parseFloat(finder.style.top),
          width: Number.parseFloat(finder.style.width),
          height: Number.parseFloat(finder.style.height),
          dragging: finder.dataset.windowDragging === 'true'
        };
      })()`,
      true,
    )) as NormalQuitCommittedGeometry | null;
    if (
      renderedCommittedGeometry?.x === committedMove.expected.x &&
      renderedCommittedGeometry.y === committedMove.expected.y &&
      renderedCommittedGeometry.width === committedMove.expected.width &&
      renderedCommittedGeometry.height === committedMove.expected.height &&
      !renderedCommittedGeometry.dragging
    ) {
      break;
    }
    await pause(5);
  }
  if (
    renderedCommittedGeometry?.x !== committedMove.expected.x ||
    renderedCommittedGeometry.y !== committedMove.expected.y ||
    renderedCommittedGeometry.width !== committedMove.expected.width ||
    renderedCommittedGeometry.height !== committedMove.expected.height ||
    renderedCommittedGeometry.dragging
  ) {
    throw new Error(
      `Normal-quit presentation move did not commit: ${JSON.stringify({ committedMove, renderedCommittedGeometry })}.`,
    );
  }

  const provisionalResize = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const grow = finder?.querySelector('[aria-label="Resize Applications"]');
      if (!(finder instanceof HTMLElement) || !(grow instanceof HTMLElement)) return null;
      const bounds = grow.getBoundingClientRect();
      grow.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokeNormalQuitResizePointerId = event.pointerId; },
        { once: true }
      );
      return {
        pointer: {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        },
        expectedCommitted: {
          x: Number.parseFloat(finder.style.left),
          y: Number.parseFloat(finder.style.top),
          width: Number.parseFloat(finder.style.width),
          height: Number.parseFloat(finder.style.height)
        }
      };
    })()`,
    true,
  )) as {
    pointer: SmokePoint;
    expectedCommitted: { x: number; y: number; width: number; height: number };
  } | null;
  if (!provisionalResize) throw new Error('Normal-quit provisional resize was unavailable.');

  const provisionalDestination = {
    x: provisionalResize.pointer.x + 48,
    y: provisionalResize.pointer.y + 32,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...provisionalResize.pointer });
  await pause(16);
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...provisionalResize.pointer,
  });
  let resizeCaptureOwned = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    resizeCaptureOwned = (await window.webContents.executeJavaScript(
      `(() => {
        const grow = document.querySelector(
          '[data-finder-window="window-applications"] [aria-label="Resize Applications"]'
        );
        const pointerId = window.__macintoshSmokeNormalQuitResizePointerId;
        return grow instanceof HTMLElement &&
          typeof pointerId === 'number' &&
          grow.hasPointerCapture(pointerId);
      })()`,
      true,
    )) as boolean;
    if (resizeCaptureOwned) break;
    await pause(5);
  }
  if (!resizeCaptureOwned) {
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...provisionalResize.pointer,
    });
    throw new Error('Normal-quit provisional resize did not acquire native pointer capture.');
  }
  for (let step = 1; step <= 3; step += 1) {
    const progress = step / 3;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        provisionalResize.pointer.x +
          (provisionalDestination.x - provisionalResize.pointer.x) * progress,
      ),
      y: Math.round(
        provisionalResize.pointer.y +
          (provisionalDestination.y - provisionalResize.pointer.y) * progress,
      ),
    });
    await pause(5);
  }
  const provisionalResizeState = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const grow = finder?.querySelector('[aria-label="Resize Applications"]');
      const pointerId = window.__macintoshSmokeNormalQuitResizePointerId;
      if (!(finder instanceof HTMLElement) || !(grow instanceof HTMLElement)) return null;
      return {
        width: Number.parseFloat(finder.style.width),
        height: Number.parseFloat(finder.style.height),
        captureOwned: typeof pointerId === 'number' && grow.hasPointerCapture(pointerId)
      };
    })()`,
    true,
  )) as { width: number; height: number; captureOwned: boolean } | null;
  const quitDelay = Date.now() - mutationCommittedAt;
  if (
    !provisionalResizeState?.captureOwned ||
    provisionalResizeState.width <= provisionalResize.expectedCommitted.width ||
    provisionalResizeState.height <= provisionalResize.expectedCommitted.height ||
    quitDelay >= 200
  ) {
    throw new Error(
      `Normal quit did not begin from an uncommitted resize inside the persistence debounce: ${JSON.stringify({ provisionalResize, provisionalResizeState, quitDelay })}.`,
    );
  }

  app.quit();
  app.quit();
  setTimeout(() => {
    if (!window.isDestroyed()) {
      console.error('Normal quit did not complete after the final presentation flush.');
      app.exit(1);
    }
  }, 8_000);
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
  normalQuit.quitWithoutFlush();
};

const captureStartup = async (window: BrowserWindow, destination: string): Promise<void> => {
  await pause(1_900);
  const image = await window.webContents.capturePage();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, image.toPNG());
  normalQuit.quitWithoutFlush();
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
  mainWindow.on('close', (event) => {
    if (!normalQuit.shouldPreventQuit()) return;
    event.preventDefault();
    requestNormalQuit();
  });
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
  } else if (normalQuitProbeMode) {
    void runNormalQuitProbe(mainWindow).catch((error) => {
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

app.on('before-quit', (event) => {
  if (!normalQuit.shouldPreventQuit()) return;
  event.preventDefault();
  requestNormalQuit();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
