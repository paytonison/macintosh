import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  type Event as ElectronEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/contracts';
import { createDefaultState, sanitizeState, type MacintoshState } from '../shared/state';
import { inspectImportPaths } from './import-files';
import { createNormalQuitCoordinator } from './normal-quit';
import { createSerializedStateWriter } from './state-save-queue';

const STATE_FILE_NAME = 'macintosh-state.json';
const PROBE_FILE_NAME = 'persistence-proof.json';
const APP_NAME = 'The Macintosh';
const APP_ICON_PATH = path.join(app.getAppPath(), 'assets', 'the-macintosh-icon.png');
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

const persistRendererState = async (value: unknown): Promise<void> => {
  if ((smokeMode || normalQuitProbeMode) && smokeSaveFailuresRemaining > 0) {
    smokeSaveFailuresRemaining -= 1;
    throw new Error('Injected smoke-test save failure.');
  }
  await saveState(sanitizeState(value));
};

const normalQuit = createNormalQuitCoordinator<MacintoshState>({
  requestRendererFlush: () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      throw new Error('The renderer is unavailable for a final state flush.');
    }
    mainWindow.webContents.send(IPC_CHANNELS.normalQuitRequested);
  },
  persistFinalState: async (state) => {
    if (state) await persistRendererState(state);
  },
  quitApplication: () => setTimeout(() => app.quit(), 0),
});

const requestNormalQuit = (): void => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    normalQuit.quitWithoutFlush();
    return;
  }
  normalQuit.requestQuit();
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
    await persistRendererState(value);
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

  ipcMain.handle(IPC_CHANNELS.flushStateAndQuit, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const finalState = value === null ? null : sanitizeState(value);
    await normalQuit.flushAndQuit(finalState);
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.quitAfterEject, (event) => {
    assertTrustedRenderer(event);
    quitRequested = true;
    setTimeout(() => normalQuit.quitWithoutFlush(), 80);
    return { accepted: true as const };
  });
};

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface SmokePoint {
  x: number;
  y: number;
}

interface SmokeWindowAnimationRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface SmokeWindowAnimationSample {
  frame: SmokeWindowAnimationRect;
  shadow: SmokeWindowAnimationRect;
}

interface SmokeWindowAnimation {
  phase: 'opening' | 'closing';
  animationName: string;
  duration: string;
  timingFunction: string;
  keyframeTransforms: string[];
  transformOrigin: string;
  expectedTransformOrigin: string;
  offsetX: string;
  offsetY: string;
  expectedOffsetX: string;
  expectedOffsetY: string;
  boxShadow: string;
  zIndex: string;
  shadowAnimationName: string;
  shadowDuration: string;
  shadowTimingFunction: string;
  shadowKeyframeTransforms: string[];
  shadowTransformOrigin: string;
  shadowOffsetX: string;
  shadowOffsetY: string;
  shadowBackgroundColor: string;
  shadowBoxShadow: string;
  shadowPaintMatchesMovePreview: boolean;
  shadowPointerEvents: string;
  shadowZIndex: string;
  shadowAriaHidden: string | null;
  shadowPrecedesWindow: boolean;
  expectedShadowTransformOrigin: string;
  shadowSamples: SmokeWindowAnimationSample[];
  mounted: boolean;
  shadowMounted: boolean;
  endedWhileMounted: boolean;
  shadowEndedWhileMounted: boolean;
}

interface SmokeCursorValues {
  arrow: string;
  pointing: string;
  open: string;
  closed: string;
}

type FinderCursorResetProbe = 'pointercancel' | 'lostpointercapture' | null;
type SmokeCursorPhase = 'idle' | 'pressed' | 'dragging' | 'off-dragging' | 'off-idle';
type SmokeCursorState = [string, string, boolean, boolean, boolean, string | null];

const smokeCursorName = (cursor: string, expected: SmokeCursorValues): string => {
  for (const [name, value] of Object.entries(expected)) {
    if (cursor === value) return name;
  }
  return cursor ? `unexpected:${cursor.slice(-32)}` : 'missing';
};

const expectItemCursor = async (
  window: BrowserWindow,
  sourceSelector: string,
  point: SmokePoint,
  expected: SmokeCursorValues,
  phase: SmokeCursorPhase,
  label: string,
): Promise<void> => {
  const phaseValues = {
    idle: [expected.pointing, expected.pointing, true, false, false, null],
    pressed: [expected.open, expected.open, true, true, false, null],
    dragging: [expected.closed, expected.closed, true, false, true, 'true'],
    'off-dragging': [expected.closed, expected.closed, false, false, true, 'true'],
    'off-idle': [expected.pointing, expected.arrow, false, false, false, null],
  } satisfies Record<SmokeCursorPhase, SmokeCursorState>;
  const deadline = Date.now() + 300;
  let state: SmokeCursorState | null = null;
  while (Date.now() < deadline) {
    state = (await window.webContents.executeJavaScript(
      `(() => {
        const source = document.querySelector(${JSON.stringify(sourceSelector)});
        const root = document.querySelector('.macintosh');
        const target = document.elementFromPoint(${point.x}, ${point.y});
        if (!(source instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
        return [
          getComputedStyle(source).cursor,
          target instanceof Element ? getComputedStyle(target).cursor : '',
          target?.closest(${JSON.stringify(sourceSelector)}) === source,
          source.classList.contains('is-pointer-pressed'),
          root.classList.contains('is-item-dragging'),
          root.dataset.itemDragging ?? null
        ];
      })()`,
      true,
    )) as SmokeCursorState | null;
    if (state && phaseValues[phase].every((value, index) => state?.[index] === value)) return;
    await pause(10);
  }
  throw new Error(
    `${label} cursor state was incorrect: ${JSON.stringify(
      state
        ? [
            smokeCursorName(state[0], expected),
            smokeCursorName(state[1], expected),
            ...state.slice(2),
          ]
        : null,
    )}.`,
  );
};

const runFinderItemCursorProbe = async (
  window: BrowserWindow,
  itemId: string,
  expectedRendererClass: 'finder-item' | 'finder-list-row',
  expected: SmokeCursorValues,
  bareDesktopPoint: SmokePoint,
  resetProbe: FinderCursorResetProbe,
  fullLifecycle = true,
): Promise<void> => {
  const points = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector('[data-vfs-item="${itemId}"]');
      const label = source?.querySelector('span:not(.finder-kind)');
      const menu = document.querySelector('.menu-bar');
      if (!(source instanceof HTMLElement) || !(label instanceof HTMLElement) || !(menu instanceof HTMLElement)) return null;
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        };
      };
      return {
        rendererMatches: source.classList.contains('${expectedRendererClass}'),
        label: center(label),
        blocked: center(menu)
      };
    })()`,
    true,
  )) as { rendererMatches: boolean; label: SmokePoint; blocked: SmokePoint } | null;
  if (!points?.rendererMatches) {
    throw new Error(`${itemId} was not rendered as a ${expectedRendererClass}.`);
  }

  const selector = `[data-vfs-item="${itemId}"]`;
  const move = async (point: SmokePoint): Promise<void> => {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await pause(24);
  };
  const expect = (label: string, point: SmokePoint, phase: SmokeCursorPhase) =>
    expectItemCursor(window, selector, point, expected, phase, `${itemId} ${label}`);

  await move(points.label);
  await expect('label hover', points.label, 'idle');

  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...points.label });
  await pause(24);
  await expect('pointer-down', points.label, 'pressed');

  if (fullLifecycle) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...points.label,
    });
    await pause(24);
    await expect('stationary hold', points.label, 'pressed');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...points.label });
    await pause(24);
    await expect('pointer-up', points.label, 'idle');
  }

  if (fullLifecycle && resetProbe) {
    await move(points.label);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...points.label });
    await pause(24);
    const resetDispatched = await window.webContents.executeJavaScript(
      `(() => {
        const source = document.querySelector('[data-vfs-item="${itemId}"]');
        if (!(source instanceof HTMLElement)) return false;
        return source.dispatchEvent(new PointerEvent('${resetProbe}', {
          pointerId: 1,
          pointerType: 'mouse',
          bubbles: true
        }));
      })()`,
      true,
    );
    if (!resetDispatched) throw new Error(`${itemId} ${resetProbe} could not be dispatched.`);
    await pause(24);
    await expect(resetProbe, points.label, 'idle');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...points.label });
    await pause(16);
  }

  if (fullLifecycle) {
    await move(points.label);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...points.label });
    await pause(24);
    await expect('pre-drag press', points.label, 'pressed');
  }

  const thresholdPoint = { x: points.label.x, y: points.label.y + 4 };
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...thresholdPoint,
  });
  await pause(40);
  await expect('drag threshold', thresholdPoint, 'dragging');

  if (fullLifecycle) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...bareDesktopPoint,
    });
    await pause(32);
    await expect('off-source drag', bareDesktopPoint, 'off-dragging');
  }

  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...points.blocked,
  });
  await pause(32);
  await expect('blocked-surface drag', points.blocked, 'off-dragging');
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...points.blocked });
  await pause(40);
  if (fullLifecycle) {
    await expect('pointer-up off-source', points.blocked, 'off-idle');
    await move(points.label);
  }
  await expect('post-drag hover', points.label, 'idle');
};

interface SmokeNativeCursorEvent {
  type: string;
  hash: string;
  scale: number;
  size: { width: number; height: number };
  hotspot: SmokePoint;
}

const runNativeFinderDragCursorProbe = async (
  window: BrowserWindow,
  itemId: string,
  expected: SmokeCursorValues,
  destination: SmokePoint,
): Promise<void> => {
  const points = (await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('[data-vfs-item="${itemId}"]');
      const menu = document.querySelector('.menu-bar');
      const canvas = item?.closest('[data-icon-layout-parent]');
      if (!(item instanceof HTMLElement) || !(menu instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return null;
      const bounds = item.getBoundingClientRect();
      const menuBounds = menu.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      let downward = null;
      for (let y = Math.round(bounds.bottom + 12); y < canvasBounds.bottom - 12; y += 12) {
        const x = Math.round(bounds.left + bounds.width / 2);
        const target = document.elementFromPoint(x, y);
        if (target?.closest('[data-icon-layout-parent]') === canvas && !target.closest('[data-vfs-item]')) {
          downward = { x, y };
          break;
        }
      }
      if (!downward) return null;
      return {
        source: {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        },
        downward,
        blocked: {
          x: Math.round(menuBounds.left + menuBounds.width / 2),
          y: Math.round(menuBounds.top + menuBounds.height / 2)
        }
      };
    })()`,
    true,
  )) as { source: SmokePoint; downward: SmokePoint; blocked: SmokePoint } | null;
  if (!points) throw new Error(`${itemId} was unavailable for a native cursor probe.`);

  const cursorEvents: SmokeNativeCursorEvent[] = [];
  const recordCursor = (
    _event: ElectronEvent,
    type: string,
    image: NativeImage,
    scale: number,
    size: { width: number; height: number },
    hotspot: SmokePoint,
  ): void => {
    cursorEvents.push({
      type,
      hash: image.isEmpty() ? '' : createHash('sha256').update(image.toBitmap()).digest('hex'),
      scale,
      size,
      hotspot,
    });
  };
  const cursorState = async (point: SmokePoint) =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const root = document.querySelector('.macintosh');
        const source = document.querySelector('[data-vfs-item="${itemId}"]');
        const target = document.elementFromPoint(${point.x}, ${point.y});
        if (!(root instanceof HTMLElement) || !(source instanceof HTMLElement)) return null;
        return {
          htmlDragging: document.documentElement.classList.contains('is-item-dragging'),
          rootDragging: root.classList.contains('is-item-dragging'),
          dataDragging: root.dataset.itemDragging ?? null,
          sourceCursor: getComputedStyle(source).cursor,
          targetCursor: target instanceof Element ? getComputedStyle(target).cursor : '',
          dropHighlighted: target instanceof Element &&
            target.closest('[data-drop-destination]')?.classList.contains('is-file-drop-target') === true
        };
      })()`,
      true,
    )) as {
      htmlDragging: boolean;
      rootDragging: boolean;
      dataDragging: string | null;
      sourceCursor: string;
      targetCursor: string;
      dropHighlighted: boolean;
    } | null;
  window.webContents.on('cursor-changed', recordCursor);
  let buttonDown = false;
  try {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...points.source });
    await pause(32);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...points.source });
    buttonDown = true;
    await pause(32);
    for (let offset = 2; offset <= 12; offset += 2) {
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        button: 'left',
        modifiers: ['leftbuttondown'],
        x: points.source.x + offset,
        y: points.source.y + offset,
      });
      await pause(32);
    }

    const activeCursor = cursorEvents.at(-1);
    const activeScale = activeCursor ? activeCursor.size.width / 16 : 0;
    const activeState = await cursorState({
      x: points.source.x + 12,
      y: points.source.y + 12,
    });
    if (
      !activeCursor ||
      activeCursor.type !== 'custom' ||
      activeCursor.hash.length === 0 ||
      activeCursor.size.width !== activeCursor.size.height ||
      activeScale <= 0 ||
      activeCursor.hotspot.x / activeScale !== 8 ||
      activeCursor.hotspot.y / activeScale !== 8 ||
      !activeState?.htmlDragging ||
      !activeState.rootDragging ||
      activeState.dataDragging !== 'true' ||
      activeState.sourceCursor !== expected.closed ||
      activeState.targetCursor !== expected.closed
    ) {
      throw new Error(
        `Native ${itemId} drag did not acquire the closed-fist cursor: ${JSON.stringify({ activeCursor, activeState })}.`,
      );
    }
    cursorEvents.length = 0;

    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...points.downward,
    });
    await pause(64);
    const downwardState = await cursorState(points.downward);
    if (
      !downwardState?.htmlDragging ||
      !downwardState.rootDragging ||
      downwardState.targetCursor !== expected.closed ||
      !downwardState.dropHighlighted
    ) {
      throw new Error(
        `Native ${itemId} drag lost its cursor while moving downward inside Finder: ${JSON.stringify(downwardState)}.`,
      );
    }

    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...destination,
    });
    await pause(64);
    const desktopState = await cursorState(destination);
    if (
      !desktopState?.htmlDragging ||
      !desktopState.rootDragging ||
      desktopState.targetCursor !== expected.closed
    ) {
      throw new Error(
        `Native ${itemId} drag lost its cursor over the desktop: ${JSON.stringify(desktopState)}.`,
      );
    }
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...points.blocked,
    });
    await pause(64);
    const blockedState = await cursorState(points.blocked);
    if (
      !blockedState?.htmlDragging ||
      !blockedState.rootDragging ||
      blockedState.targetCursor !== expected.closed
    ) {
      throw new Error(
        `Native ${itemId} drag lost its cursor over a blocked surface: ${JSON.stringify(blockedState)}.`,
      );
    }
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...destination,
    });
    await pause(64);
    const fallbackCursor = cursorEvents.find(
      (event) => event.type !== 'custom' || event.hash !== activeCursor.hash,
    );
    if (fallbackCursor) {
      throw new Error(
        `Native ${itemId} drag fell back from the closed-fist cursor: ${JSON.stringify(fallbackCursor)}.`,
      );
    }
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...points.blocked,
    });
    await pause(32);
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...points.blocked });
    buttonDown = false;
    await pause(100);
    const releasedState = await cursorState(points.blocked);
    if (
      !releasedState ||
      releasedState.htmlDragging ||
      releasedState.rootDragging ||
      releasedState.dataDragging !== null ||
      ![expected.arrow, expected.pointing].includes(releasedState.targetCursor)
    ) {
      throw new Error(
        `Native ${itemId} drag did not release its cursor: ${JSON.stringify(releasedState)}.`,
      );
    }
  } finally {
    if (buttonDown) {
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...destination });
      await pause(32);
    }
    window.webContents.off('cursor-changed', recordCursor);
  }
};

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

const observeFinderWindowAnimation = async (
  window: BrowserWindow,
  windowLabel: string,
  sourceSelector: string,
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
        let settled = false;
        let animationElement = null;
        let animationEndHandler = null;
        let timeoutId;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timeoutId);
          animationElement?.removeEventListener('animationend', animationEndHandler);
          resolve(value);
        };
        const inspect = () => {
          const finder = [...document.querySelectorAll('[data-finder-window]')].find(
            (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(windowLabel)}
          );
          const source = document.querySelector(${JSON.stringify(sourceSelector)});
          const shadow = [...document.querySelectorAll('[data-window-animation-shadow]')].find(
            (candidate) =>
              candidate.getAttribute('data-window-animation-shadow') ===
              finder?.getAttribute('data-finder-window')
          );
          if (
            !(finder instanceof HTMLElement) ||
            !(source instanceof HTMLElement) ||
            !(shadow instanceof HTMLElement) ||
            finder.getAttribute(animationAttribute) !== 'true'
          ) return false;
          observer.disconnect();
          const style = getComputedStyle(finder);
          const shadowStyle = getComputedStyle(shadow);
          const activeAnimation = finder.getAnimations().find(
            (animation) => animation.animationName === expectedAnimationName
          );
          const activeShadowAnimation = shadow.getAnimations().find(
            (animation) => animation.animationName === expectedAnimationName
          );
          const effect = activeAnimation?.effect;
          const keyframes = effect && typeof effect.getKeyframes === 'function'
            ? effect.getKeyframes()
            : [];
          const shadowEffect = activeShadowAnimation?.effect;
          const shadowKeyframes =
            shadowEffect && typeof shadowEffect.getKeyframes === 'function'
              ? shadowEffect.getKeyframes()
              : [];
          const sourceBounds = source.getBoundingClientRect();
          const surfaceBounds = surface.getBoundingClientRect();
          const originX = Math.round(
            sourceBounds.left + sourceBounds.width / 2 - surfaceBounds.left
          );
          const originY = Math.round(
            sourceBounds.top + sourceBounds.height / 2 - surfaceBounds.top
          );
          const toRect = (rect) => ({
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width
          });
          const dragPreview = finder.querySelector('.window-drag-shadow');
          const shadowTitlebar = shadow.querySelector(':scope > span');
          const dragTitlebar = dragPreview?.querySelector(':scope > span');
          const stylesMatch = (left, right, properties) =>
            properties.every((property) => left[property] === right[property]);
          const borderProperties = [
            'borderTopColor',
            'borderTopStyle',
            'borderTopWidth'
          ];
          const shadowPaintMatchesMovePreview =
            dragPreview instanceof HTMLElement &&
            shadowTitlebar instanceof HTMLElement &&
            dragTitlebar instanceof HTMLElement &&
            stylesMatch(shadowStyle, getComputedStyle(dragPreview), [
              ...borderProperties,
              'outlineColor',
              'outlineOffset',
              'outlineStyle',
              'outlineWidth',
              'backgroundColor',
              'boxShadow'
            ]) &&
            stylesMatch(
              getComputedStyle(shadow, '::before'),
              getComputedStyle(dragPreview, '::before'),
              ['inset', ...borderProperties]
            ) &&
            stylesMatch(getComputedStyle(shadowTitlebar), getComputedStyle(dragTitlebar), [
              'top',
              'right',
              'left',
              ...borderProperties
            ]) &&
            stylesMatch(
              getComputedStyle(shadowTitlebar, '::before'),
              getComputedStyle(dragTitlebar, '::before'),
              ['top', 'left', 'width', 'height', ...borderProperties, 'backgroundColor']
            );
          const durationValue = effect?.getTiming().duration;
          const duration = typeof durationValue === 'number' ? durationValue : 20;
          const shadowSamples = [];
          if (activeAnimation && activeShadowAnimation) {
            activeAnimation.pause();
            activeShadowAnimation.pause();
            for (const step of [1, 3, 5, 7, 9, 11]) {
              const currentTime = (duration * step) / 12;
              activeAnimation.currentTime = currentTime;
              activeShadowAnimation.currentTime = currentTime;
              shadowSamples.push({
                frame: toRect(finder.getBoundingClientRect()),
                shadow: toRect(shadow.getBoundingClientRect())
              });
            }
            activeAnimation.currentTime = 0;
            activeShadowAnimation.currentTime = 0;
            activeAnimation.play();
            activeShadowAnimation.play();
          }
          const snapshot = {
            phase: ${JSON.stringify(phase)},
            animationName: style.animationName,
            duration: style.animationDuration,
            timingFunction: style.animationTimingFunction,
            keyframeTransforms: keyframes.map((keyframe) => String(keyframe.transform ?? '')),
            transformOrigin: style.transformOrigin,
            expectedTransformOrigin: finder.offsetWidth / 2 + 'px ' + finder.offsetHeight / 2 + 'px',
            offsetX: style.getPropertyValue('--window-animation-offset-x').trim(),
            offsetY: style.getPropertyValue('--window-animation-offset-y').trim(),
            expectedOffsetX: Math.round(
              originX - (finder.offsetLeft + finder.offsetWidth / 2)
            ) + 'px',
            expectedOffsetY: Math.round(
              originY - (finder.offsetTop + finder.offsetHeight / 2)
            ) + 'px',
            boxShadow: style.boxShadow,
            zIndex: style.zIndex,
            shadowAnimationName: shadowStyle.animationName,
            shadowDuration: shadowStyle.animationDuration,
            shadowTimingFunction: shadowStyle.animationTimingFunction,
            shadowKeyframeTransforms: shadowKeyframes.map(
              (keyframe) => String(keyframe.transform ?? '')
            ),
            shadowTransformOrigin: shadowStyle.transformOrigin,
            shadowOffsetX: shadowStyle.getPropertyValue('--window-animation-offset-x').trim(),
            shadowOffsetY: shadowStyle.getPropertyValue('--window-animation-offset-y').trim(),
            shadowBackgroundColor: shadowStyle.backgroundColor,
            shadowBoxShadow: shadowStyle.boxShadow,
            shadowPaintMatchesMovePreview,
            shadowPointerEvents: shadowStyle.pointerEvents,
            shadowZIndex: shadowStyle.zIndex,
            shadowAriaHidden: shadow.getAttribute('aria-hidden'),
            shadowPrecedesWindow: Boolean(
              shadow.compareDocumentPosition(finder) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
            expectedShadowTransformOrigin:
              shadow.offsetWidth / 2 + 'px ' + shadow.offsetHeight / 2 + 'px',
            shadowSamples,
            mounted: finder.isConnected,
            shadowMounted: shadow.isConnected
          };
          animationElement = finder;
          animationEndHandler = (event) => {
            if (event.target !== finder || event.animationName !== expectedAnimationName) return;
            settle({
              ...snapshot,
              endedWhileMounted: finder.isConnected,
              shadowEndedWhileMounted: shadow.isConnected
            });
          };
          finder.addEventListener('animationend', animationEndHandler);
          return true;
        };
        const observer = new MutationObserver(() => inspect());
        observer.observe(surface, {
          attributes: true,
          attributeFilter: ['class', 'data-opening', 'data-closing'],
          childList: true,
          subtree: true
        });
        if (inspect()) return;
        timeoutId = setTimeout(() => settle(null), 500);
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

const assertFinderWindowAnimation = (
  animation: SmokeWindowAnimation | null,
  phase: SmokeWindowAnimation['phase'],
  label: string,
): void => {
  const expectedName = phase === 'opening' ? 'finder-window-open' : 'finder-window-close';
  const expectedFirstScale = phase === 'opening' ? 'scale(0.12)' : 'scale(1)';
  const expectedLastScale = phase === 'opening' ? 'scale(1)' : 'scale(0.12)';
  const firstTransform = animation?.keyframeTransforms.at(0) ?? '';
  const lastTransform = animation?.keyframeTransforms.at(-1) ?? '';
  const originTransform = phase === 'opening' ? firstTransform : lastTransform;
  const fullFrameTransform = phase === 'opening' ? lastTransform : firstTransform;
  const expectedOriginTranslation = animation
    ? `translate3d(${animation.expectedOffsetX}, ${animation.expectedOffsetY}, 0px)`
    : '';
  const nearlyEqual = (left: number, right: number): boolean => Math.abs(left - right) <= 0.05;
  const shadowSamplesAreAligned =
    animation?.shadowSamples.length === 6 &&
    animation.shadowSamples.every(
      ({ frame, shadow }) =>
        nearlyEqual(shadow.left, frame.left) &&
        nearlyEqual(shadow.top, frame.top) &&
        nearlyEqual(shadow.right, frame.right) &&
        nearlyEqual(shadow.bottom, frame.bottom) &&
        nearlyEqual(shadow.width, frame.width) &&
        nearlyEqual(shadow.height, frame.height),
    );
  if (
    animation?.phase !== phase ||
    animation.animationName !== expectedName ||
    animation.duration !== '0.02s' ||
    !['steps(6)', 'steps(6, end)'].includes(animation.timingFunction) ||
    !firstTransform.includes(expectedFirstScale) ||
    !lastTransform.includes(expectedLastScale) ||
    originTransform !== `${expectedOriginTranslation} scale(0.12)` ||
    fullFrameTransform !== 'translate(0px) scale(1)' ||
    animation.transformOrigin !== animation.expectedTransformOrigin ||
    animation.offsetX !== animation.expectedOffsetX ||
    animation.offsetY !== animation.expectedOffsetY ||
    (animation.offsetX === '0px' && animation.offsetY === '0px') ||
    animation.boxShadow !== 'none' ||
    animation.shadowAnimationName !== animation.animationName ||
    animation.shadowDuration !== animation.duration ||
    animation.shadowTimingFunction !== animation.timingFunction ||
    JSON.stringify(animation.shadowKeyframeTransforms) !==
      JSON.stringify(animation.keyframeTransforms) ||
    animation.shadowTransformOrigin !== animation.expectedShadowTransformOrigin ||
    animation.shadowOffsetX !== animation.offsetX ||
    animation.shadowOffsetY !== animation.offsetY ||
    animation.shadowBackgroundColor !== 'rgba(0, 0, 0, 0)' ||
    !animation.shadowBoxShadow.startsWith('rgb(0, 0, 0) ') ||
    !animation.shadowBoxShadow.endsWith(' 3px 3px 0px 0px') ||
    !animation.shadowPaintMatchesMovePreview ||
    animation.shadowPointerEvents !== 'none' ||
    animation.shadowZIndex !== animation.zIndex ||
    animation.shadowAriaHidden !== 'true' ||
    !animation.shadowPrecedesWindow ||
    !shadowSamplesAreAligned ||
    !animation.mounted ||
    !animation.shadowMounted ||
    !animation.endedWhileMounted ||
    !animation.shadowEndedWhileMounted
  ) {
    throw new Error(`${label} animation was incorrect: ${JSON.stringify(animation)}.`);
  }
};

const waitForFinderWindowState = async (
  window: BrowserWindow,
  windowLabel: string,
  expected: 'settled' | 'absent',
): Promise<void> => {
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    const reached = await window.webContents.executeJavaScript(
      `(() => {
        const finder = [...document.querySelectorAll('[data-finder-window]')].find(
          (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(windowLabel)}
        );
        return ${JSON.stringify(expected)} === 'absent'
          ? finder === undefined
          : finder instanceof HTMLElement &&
              finder.dataset.opening !== 'true' && finder.dataset.closing !== 'true';
      })()`,
      true,
    );
    if (reached) return;
    await pause(10);
  }
  throw new Error(`${windowLabel} did not reach its expected ${expected} state.`);
};

const assertFinderWindowSettledShadow = async (
  window: BrowserWindow,
  windowLabel: string,
): Promise<void> => {
  const state = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = [...document.querySelectorAll('[data-finder-window]')].find(
        (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(windowLabel)}
      );
      if (!(finder instanceof HTMLElement)) return null;
      const shadowPresent = [...document.querySelectorAll('[data-window-animation-shadow]')].some(
        (candidate) =>
          candidate.getAttribute('data-window-animation-shadow') ===
          finder.getAttribute('data-finder-window')
      );
      return {
        boxShadow: getComputedStyle(finder).boxShadow,
        shadowPresent
      };
    })()`,
    true,
  )) as { boxShadow: string; shadowPresent: boolean } | null;
  if (
    state === null ||
    state.shadowPresent ||
    !state.boxShadow.startsWith('rgb(0, 0, 0) ') ||
    !state.boxShadow.endsWith(' 3px 3px 0px 0px')
  ) {
    throw new Error(
      `${windowLabel} did not restore its settled pixel shadow: ${JSON.stringify(state)}.`,
    );
  }
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

  const cursorBindings = (await window.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('.macintosh');
      const surface = document.querySelector('.desktop-surface');
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const folder = document.querySelector('[data-vfs-item="applications"]');
      const documentItem = document.querySelector('[data-vfs-item="welcome"]');
      const titlebar = document.querySelector('[data-window-drag-handle="true"]');
      const close = titlebar?.querySelector('button');
      const grow = document.querySelector('.window-grow-box');
      if (![root, surface, disk, trash, folder, documentItem, titlebar, close, grow]
        .every((element) => element instanceof HTMLElement)) return null;
      const names = {
        arrow: '--system-arrow-cursor',
        pointing: '--pointing-hand-cursor',
        open: '--open-hand-cursor',
        closed: '--closed-fist-cursor'
      };
      const rootStyle = getComputedStyle(document.documentElement);
      const variables = Object.fromEntries(Object.entries(names).map(([name, variable]) =>
        [name, rootStyle.getPropertyValue(variable).trim()]));
      const probe = document.createElement('span');
      document.body.append(probe);
      const expected = Object.fromEntries(Object.entries(names).map(([name, variable]) => {
        probe.style.cursor = 'var(' + variable + '), default';
        return [name, getComputedStyle(probe).cursor];
      }));
      probe.remove();
      const cursor = (element) => element instanceof Element ? getComputedStyle(element).cursor : '';
      const asset = (name, width, height, x, y) =>
        variables[name].includes('width%3D%22' + width + '%22') &&
        variables[name].includes('height%3D%22' + height + '%22') &&
        variables[name].endsWith(' ' + x + ' ' + y);
      const surfaceBounds = surface.getBoundingClientRect();
      let bareDesktopPoint = null;
      for (let y = Math.round(surfaceBounds.top + 18); y < surfaceBounds.bottom - 18; y += 24) {
        for (let x = Math.round(surfaceBounds.left + 18); x < surfaceBounds.right - 18; x += 24) {
          if (document.elementFromPoint(x, y) === surface) {
            bareDesktopPoint = { x, y };
            break;
          }
        }
        if (bareDesktopPoint) break;
      }
      if (!bareDesktopPoint) return null;
      const bareTarget = document.elementFromPoint(bareDesktopPoint.x, bareDesktopPoint.y);
      const arrowElements = [document.body, surface, bareTarget, close];
      const pointingElements = [
        disk, disk.querySelector('.desktop-icon-glyph'), disk.querySelector('.desktop-icon-label'),
        trash, trash.querySelector('.desktop-icon-glyph'), trash.querySelector('.desktop-icon-label'),
        folder, folder.querySelector('.pixel-icon'), folder.querySelector('span'),
        documentItem, documentItem.querySelector('.pixel-icon'), documentItem.querySelector('span')
      ];
      return {
        expected,
        ok: {
          assets: asset('arrow', 11, 16, 1, 1) && asset('pointing', 16, 16, 5, 1) &&
            asset('open', 16, 16, 8, 8) && asset('closed', 16, 16, 8, 8),
          distinct: new Set(Object.values(expected)).size === 4 &&
            Object.values(expected).every((value) => value.includes('url(')),
          arrowBindings: arrowElements.every((element) => cursor(element) === expected.arrow),
          pointingBindings: pointingElements.every((element) => cursor(element) === expected.pointing),
          preserved: cursor(titlebar) === 'grab' && cursor(grow) === 'nwse-resize',
          clean: !document.documentElement.classList.contains('is-item-dragging') &&
            !root.classList.contains('is-item-dragging') && root.dataset.itemDragging === undefined
        },
        bareDesktopPoint
      };
    })()`,
    true,
  )) as {
    expected: SmokeCursorValues;
    ok: Record<
      'assets' | 'distinct' | 'arrowBindings' | 'pointingBindings' | 'preserved' | 'clean',
      boolean
    >;
    bareDesktopPoint: SmokePoint;
  } | null;
  if (!cursorBindings || Object.values(cursorBindings.ok).some((value) => !value)) {
    throw new Error(
      `System 1 cursor bindings are incomplete: ${JSON.stringify(cursorBindings?.ok ?? null)}.`,
    );
  }

  await runNativeFinderDragCursorProbe(
    window,
    'applications',
    cursorBindings.expected,
    cursorBindings.bareDesktopPoint,
  );

  await runFinderItemCursorProbe(
    window,
    'applications',
    'finder-item',
    cursorBindings.expected,
    cursorBindings.bareDesktopPoint,
    'pointercancel',
  );
  await runFinderItemCursorProbe(
    window,
    'welcome',
    'finder-item',
    cursorBindings.expected,
    cursorBindings.bareDesktopPoint,
    'lostpointercapture',
  );
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

  const calculatorSubthresholdPoint = {
    x: calculatorDragStart.pointer.x + 3,
    y: calculatorDragStart.pointer.y,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...calculatorDragStart.pointer });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...calculatorDragStart.pointer,
  });
  await pause(70);
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...calculatorSubthresholdPoint,
  });
  await pause(50);
  const calculatorHeldBelowThreshold = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      const handle = calculator?.querySelector('[data-calculator-drag-handle="true"]');
      if (!(calculator instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      const rect = calculator.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        dragging: calculator.classList.contains('is-dragging'),
        outlineVisible: calculator.querySelector('.calculator-drag-outline') !== null,
        cursor: getComputedStyle(handle).cursor
      };
    })()`,
    true,
  )) as {
    left: number;
    top: number;
    dragging: boolean;
    outlineVisible: boolean;
    cursor: string;
  } | null;
  if (
    !calculatorHeldBelowThreshold ||
    Math.abs(calculatorHeldBelowThreshold.left - calculatorDragStart.window.left) > 1 ||
    Math.abs(calculatorHeldBelowThreshold.top - calculatorDragStart.window.top) > 1 ||
    calculatorHeldBelowThreshold.dragging ||
    calculatorHeldBelowThreshold.outlineVisible ||
    calculatorHeldBelowThreshold.cursor !== 'grab'
  ) {
    throw new Error(
      `Calculator began dragging below the movement threshold: ${JSON.stringify(calculatorHeldBelowThreshold)}.`,
    );
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...calculatorSubthresholdPoint,
  });
  await pause(40);

  await window.webContents.executeJavaScript(
    `(() => {
      document.body.dataset.macintoshSmokeBlurred = 'false';
      window.addEventListener(
        'blur',
        () => { document.body.dataset.macintoshSmokeBlurred = 'true'; },
        { once: true }
      );
    })()`,
    true,
  );
  const calculatorFocusLossPoint = {
    x: calculatorDragStart.pointer.x + 24,
    y: calculatorDragStart.pointer.y + 14,
  };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...calculatorDragStart.pointer });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...calculatorDragStart.pointer,
  });
  for (let step = 1; step <= 3; step += 1) {
    const progress = step / 3;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: Math.round(
        calculatorDragStart.pointer.x +
          (calculatorFocusLossPoint.x - calculatorDragStart.pointer.x) * progress,
      ),
      y: Math.round(
        calculatorDragStart.pointer.y +
          (calculatorFocusLossPoint.y - calculatorDragStart.pointer.y) * progress,
      ),
    });
    await pause(22);
  }
  const calculatorFocusLossPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      const handle = calculator?.querySelector('[data-calculator-drag-handle="true"]');
      if (!(calculator instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      return {
        dragging: calculator.classList.contains('is-dragging'),
        outlineVisible: calculator.querySelector('.calculator-drag-outline') !== null,
        cursor: getComputedStyle(handle).cursor
      };
    })()`,
    true,
  )) as { dragging: boolean; outlineVisible: boolean; cursor: string } | null;
  if (
    !calculatorFocusLossPreview?.dragging ||
    !calculatorFocusLossPreview.outlineVisible ||
    calculatorFocusLossPreview.cursor !== 'grabbing'
  ) {
    throw new Error(
      `Calculator did not enter the active drag state: ${JSON.stringify(calculatorFocusLossPreview)}.`,
    );
  }

  window.blur();
  let calculatorBlurCancelled = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    calculatorBlurCancelled = (await window.webContents.executeJavaScript(
      `(() => {
        const calculator = document.querySelector('[data-calculator-window="true"]');
        if (!(calculator instanceof HTMLElement)) return false;
        const rect = calculator.getBoundingClientRect();
        return document.body.dataset.macintoshSmokeBlurred === 'true' &&
          !calculator.classList.contains('is-dragging') &&
          !calculator.querySelector('.calculator-drag-outline') &&
          Math.abs(rect.left - ${calculatorDragStart.window.left}) <= 1 &&
          Math.abs(rect.top - ${calculatorDragStart.window.top}) <= 1;
      })()`,
      true,
    )) as boolean;
    if (calculatorBlurCancelled) break;
    await pause(25);
  }
  window.focus();
  await pause(60);
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...calculatorFocusLossPoint,
  });
  await pause(40);
  const calculatorAfterFocusLoss = (await window.webContents.executeJavaScript(
    `(() => {
      const calculator = document.querySelector('[data-calculator-window="true"]');
      const handle = calculator?.querySelector('[data-calculator-drag-handle="true"]');
      if (!(calculator instanceof HTMLElement) || !(handle instanceof HTMLElement)) return null;
      const rect = calculator.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        dragging: calculator.classList.contains('is-dragging'),
        outlineVisible: calculator.querySelector('.calculator-drag-outline') !== null,
        cursor: getComputedStyle(handle).cursor
      };
    })()`,
    true,
  )) as {
    left: number;
    top: number;
    dragging: boolean;
    outlineVisible: boolean;
    cursor: string;
  } | null;
  if (
    !calculatorBlurCancelled ||
    !calculatorAfterFocusLoss ||
    Math.abs(calculatorAfterFocusLoss.left - calculatorDragStart.window.left) > 1 ||
    Math.abs(calculatorAfterFocusLoss.top - calculatorDragStart.window.top) > 1 ||
    calculatorAfterFocusLoss.dragging ||
    calculatorAfterFocusLoss.outlineVisible ||
    calculatorAfterFocusLoss.cursor !== 'grab'
  ) {
    throw new Error(
      `Calculator drag did not cancel cleanly on focus loss: ${JSON.stringify({
        calculatorBlurCancelled,
        calculatorAfterFocusLoss,
      })}.`,
    );
  }

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
      if (
        !(calculator instanceof HTMLElement) ||
        !(outline instanceof HTMLElement) ||
        !(handle instanceof HTMLElement)
      ) return null;
      const windowRect = calculator.getBoundingClientRect();
      const outlineRect = outline.getBoundingClientRect();
      return {
        windowLeft: windowRect.left,
        windowTop: windowRect.top,
        outlineLeft: outlineRect.left,
        outlineTop: outlineRect.top,
        cursor: getComputedStyle(handle).cursor,
        pointerOutsideCommittedWindow:
          document.elementFromPoint(${calculatorDragEnd.x}, ${calculatorDragEnd.y})
            ?.closest('[data-calculator-window="true"]') === null
      };
    })()`,
    true,
  )) as {
    windowLeft: number;
    windowTop: number;
    outlineLeft: number;
    outlineTop: number;
    cursor: string;
    pointerOutsideCommittedWindow: boolean;
  } | null;
  if (
    !calculatorDragPreview ||
    Math.abs(calculatorDragPreview.windowLeft - calculatorDragStart.window.left) > 1 ||
    Math.abs(calculatorDragPreview.windowTop - calculatorDragStart.window.top) > 1 ||
    Math.abs(calculatorDragPreview.outlineLeft - (calculatorDragStart.window.left + 47)) > 2 ||
    Math.abs(calculatorDragPreview.outlineTop - (calculatorDragStart.window.top + 31)) > 2 ||
    Math.abs(
      calculatorDragEnd.x -
        (calculatorDragPreview.outlineLeft + 1) -
        (calculatorDragStart.pointer.x - calculatorDragStart.window.left),
    ) > 2 ||
    Math.abs(
      calculatorDragEnd.y -
        (calculatorDragPreview.outlineTop + 1) -
        (calculatorDragStart.pointer.y - calculatorDragStart.window.top),
    ) > 2 ||
    calculatorDragPreview.cursor !== 'grabbing' ||
    !calculatorDragPreview.pointerOutsideCommittedWindow
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
      const point = {
        x: Math.round(rect.left + ${desktopImportPoint.x}),
        y: Math.round(rect.top + ${desktopImportPoint.y})
      };
      return document.elementFromPoint(point.x, point.y) === surface ? point : null;
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
      const documentItem = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
      );
      const folderItem = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Drop Folder"]'
      );
      if (!(documentItem instanceof HTMLElement) || !(folderItem instanceof HTMLElement)) {
        return null;
      }
      return {
        documentPosition: {
          x: Number(documentItem.dataset.iconX),
          y: Number(documentItem.dataset.iconY)
        },
        folderPosition: {
          x: Number(folderItem.dataset.iconX),
          y: Number(folderItem.dataset.iconY)
        },
        notice: document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? ''
      };
    })()`,
    true,
  )) as {
    documentPosition: SmokePoint;
    folderPosition: SmokePoint;
    notice: string;
  } | null;
  if (
    !externalImport ||
    externalImport.documentPosition.x !== desktopImportPoint.x ||
    externalImport.documentPosition.y !== desktopImportPoint.y ||
    externalImport.folderPosition.x !== desktopImportPoint.x + 94 ||
    externalImport.folderPosition.y !== desktopImportPoint.y
  ) {
    throw new Error(`External file/folder drop failed: ${JSON.stringify(externalImport)}.`);
  }
  if (!externalImport.notice.startsWith('Copied 3 items to Desktop.')) {
    throw new Error(`External drop did not report its result: ${externalImport.notice}.`);
  }

  const desktopDocumentPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
      );
      if (!(item instanceof HTMLElement)) return null;
      const bounds = item.getBoundingClientRect();
      return {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2)
      };
    })()`,
    true,
  )) as SmokePoint | null;
  if (!desktopDocumentPoint) throw new Error('Imported Desktop document could not be located.');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...desktopDocumentPoint });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...desktopDocumentPoint });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...desktopDocumentPoint });
  await pause(40);
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

  const desktopFolderSelector = '[data-desktop-vfs-item][aria-label="Drop Folder"]';
  const desktopFolderOpenAnimation = await observeFinderWindowAnimation(
    window,
    'Drop Folder window',
    desktopFolderSelector,
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(desktopFolderSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertFinderWindowAnimation(desktopFolderOpenAnimation, 'opening', 'Desktop folder opening');
  await waitForFinderWindowState(window, 'Drop Folder window', 'settled');
  await assertFinderWindowSettledShadow(window, 'Drop Folder window');
  const desktopFolderHierarchyVisible = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Drop Folder window"] [data-vfs-item]')
      ?.textContent?.includes('Nested Note.txt') === true`,
    true,
  );
  if (!desktopFolderHierarchyVisible) {
    throw new Error('The imported Desktop folder did not preserve its hierarchy.');
  }

  const nestedDocumentSelector = '[aria-label="Drop Folder window"] [data-vfs-item]';
  const nestedDocumentOpenAnimation = await observeFinderWindowAnimation(
    window,
    'Nested Note.txt window',
    nestedDocumentSelector,
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(nestedDocumentSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertFinderWindowAnimation(
    nestedDocumentOpenAnimation,
    'opening',
    'Nested Finder document opening',
  );
  await waitForFinderWindowState(window, 'Nested Note.txt window', 'settled');
  await assertFinderWindowSettledShadow(window, 'Nested Note.txt window');
  const nestedDocumentCloseAnimation = await observeFinderWindowAnimation(
    window,
    'Nested Note.txt window',
    nestedDocumentSelector,
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Nested Note.txt"]')?.click()`,
        true,
      ),
  );
  assertFinderWindowAnimation(
    nestedDocumentCloseAnimation,
    'closing',
    'Nested Finder document closing',
  );
  await waitForFinderWindowState(window, 'Nested Note.txt window', 'absent');

  const closeCancellationState = (await window.webContents.executeJavaScript(
    `(async () => {
      const close = document.querySelector('[aria-label="Close Drop Folder"]');
      const source = document.querySelector(${JSON.stringify(desktopFolderSelector)});
      const originalWindow = document.querySelector('[aria-label="Drop Folder window"]');
      if (
        !(close instanceof HTMLElement) ||
        !(source instanceof HTMLElement) ||
        !(originalWindow instanceof HTMLElement)
      ) return null;
      const closingStarted = new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(value);
        };
        const observer = new MutationObserver(() => {
          if (originalWindow.dataset.closing === 'true') settle(true);
        });
        observer.observe(originalWindow, {
          attributes: true,
          attributeFilter: ['data-closing']
        });
        const timeoutId = setTimeout(() => settle(false), 200);
      });
      close.click();
      const sawClosing = await closingStarted;
      if (!sawClosing) return null;
      let replayedOpening = false;
      const reopenObserver = new MutationObserver(() => {
        if (originalWindow.dataset.opening === 'true') replayedOpening = true;
      });
      reopenObserver.observe(originalWindow, {
        attributes: true,
        attributeFilter: ['data-opening']
      });
      source.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      reopenObserver.disconnect();
      const windows = [...document.querySelectorAll('[data-finder-window]')].filter(
        (candidate) => candidate.getAttribute('aria-label') === 'Drop Folder window'
      );
      return {
        count: windows.length,
        sameElement: windows[0] === originalWindow && originalWindow.isConnected,
        replayedOpening,
        opening: originalWindow.dataset.opening === 'true',
        closing: originalWindow.dataset.closing === 'true',
        animationShadowPresent: [...document.querySelectorAll(
          '[data-window-animation-shadow]'
        )].some(
          (candidate) =>
            candidate.getAttribute('data-window-animation-shadow') ===
            originalWindow.getAttribute('data-finder-window')
        )
      };
    })()`,
    true,
  )) as {
    count: number;
    sameElement: boolean;
    replayedOpening: boolean;
    opening: boolean;
    closing: boolean;
    animationShadowPresent: boolean;
  } | null;
  if (
    closeCancellationState?.count !== 1 ||
    !closeCancellationState.sameElement ||
    closeCancellationState.replayedOpening ||
    closeCancellationState.opening ||
    closeCancellationState.closing ||
    closeCancellationState.animationShadowPresent
  ) {
    throw new Error(
      `Reopening did not cancel the pending Finder close: ${JSON.stringify(closeCancellationState)}.`,
    );
  }

  const desktopFolderCloseAnimation = await observeFinderWindowAnimation(
    window,
    'Drop Folder window',
    desktopFolderSelector,
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Drop Folder"]')?.click()`,
        true,
      ),
  );
  assertFinderWindowAnimation(desktopFolderCloseAnimation, 'closing', 'Desktop folder closing');
  await waitForFinderWindowState(window, 'Drop Folder window', 'absent');

  const systemDiskDropPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      if (!(disk instanceof HTMLElement)) return null;
      const bounds = disk.getBoundingClientRect();
      return {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2)
      };
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
      visible: [...document.querySelectorAll(
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
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return null;
      }
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        };
      };
      return {
        source: center(source),
        destination: center(target),
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
      if (!(documentItem instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return null;
      }
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
  const documentDropStayedPut = await window.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('[data-vfs-count]');
      return root instanceof HTMLElement &&
        Number(root.dataset.vfsCount || 0) === ${documentBlockCoordinates.vfsCount} &&
        document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
        ) !== null &&
        document.querySelector('[data-desktop-vfs-item="applications"]') === null;
    })()`,
    true,
  );
  if (
    !documentDropPreview?.pointerOwned ||
    documentDropPreview.cursor !== cursorBindings.expected.closed ||
    documentDropPreview.highlighted ||
    !documentDropStayedPut
  ) {
    throw new Error(
      `A Desktop document did not block an active internal drop: ${JSON.stringify(documentDropPreview)}.`,
    );
  }

  const hostTrashProbe = (await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(trash instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const bounds = trash.getBoundingClientRect();
      return {
        point: {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        },
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { point: SmokePoint; vfsCount: number } | null;
  if (!hostTrashProbe) throw new Error('Trash could not be located for the host-drop probe.');
  let hostTrashHighlighted: boolean;
  window.webContents.debugger.attach('1.3');
  try {
    const dragData = { items: [], files: [importDocument], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver']) {
      await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
        type,
        ...hostTrashProbe.point,
        data: dragData,
      });
    }
    await pause(40);
    hostTrashHighlighted = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-desktop-icon="trash"]')
        ?.classList.contains('is-file-drop-target') === true`,
      true,
    )) as boolean;
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      type: 'drop',
      ...hostTrashProbe.point,
      data: dragData,
    });
  } finally {
    window.webContents.debugger.detach();
  }
  await pause(100);
  const hostTrashVfsCount = (await window.webContents.executeJavaScript(
    `Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)`,
    true,
  )) as number;
  if (hostTrashHighlighted || hostTrashVfsCount !== hostTrashProbe.vfsCount) {
    throw new Error('Trash accepted a host-file drop.');
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
      const item = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )].find(
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
  if (
    !freeIconPreview?.highlighted ||
    !freeIconPreview.pointerOwned ||
    freeIconPreview.cursor !== cursorBindings.expected.closed
  ) {
    throw new Error(
      `Free Finder placement did not use the pointer-owned internal drag surface: ${JSON.stringify(freeIconPreview)}.`,
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
  await runFinderItemCursorProbe(
    window,
    'applications',
    'finder-list-row',
    cursorBindings.expected,
    cursorBindings.bareDesktopPoint,
    null,
    false,
  );
  await runFinderItemCursorProbe(
    window,
    'welcome',
    'finder-list-row',
    cursorBindings.expected,
    cursorBindings.bareDesktopPoint,
    null,
    false,
  );
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
      if (!(source instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return null;
      }
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
  if (
    !finderToDesktopPreview?.highlighted ||
    !finderToDesktopPreview.pointerOwned ||
    finderToDesktopPreview.cursor !== cursorBindings.expected.closed
  ) {
    throw new Error(
      `Finder-to-Desktop drag did not retain pointer ownership: ${JSON.stringify(finderToDesktopPreview)}.`,
    );
  }
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
      if (!(source instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return null;
      }
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
  if (
    !desktopRepositionPreview?.highlighted ||
    !desktopRepositionPreview.pointerOwned ||
    desktopRepositionPreview.cursor !== cursorBindings.expected.closed
  ) {
    throw new Error(
      `Desktop reposition did not retain pointer ownership: ${JSON.stringify(desktopRepositionPreview)}.`,
    );
  }
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
  if (
    !internalFolderPreview?.highlighted ||
    !internalFolderPreview.pointerOwned ||
    internalFolderPreview.cursor !== cursorBindings.expected.closed
  ) {
    throw new Error(
      `Internal folder drag did not keep pointer ownership over its target: ${JSON.stringify(internalFolderPreview)}.`,
    );
  }
  await pause(120);
  const movedFolderHidden = await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-finder-window="window-system-disk"] [data-vfs-item="system-folder"]'
    ) === null`,
    true,
  );
  if (!movedFolderHidden) throw new Error('Internal folder drop did not move the folder.');

  const internalTrashCoordinates = (await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
      );
      const destination = document.querySelector('[data-desktop-icon="trash"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(destination instanceof HTMLElement) || !(root instanceof HTMLElement)) {
        return null;
      }
      const center = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        };
      };
      return {
        source: center(source),
        destination: center(destination),
        vfsCount: Number(root.dataset.vfsCount || 0)
      };
    })()`,
    true,
  )) as { source: SmokePoint; destination: SmokePoint; vfsCount: number } | null;
  if (!internalTrashCoordinates) {
    throw new Error('Internal Trash drag coordinates were unavailable.');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...internalTrashCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...internalTrashCoordinates.source,
  });
  for (const offset of [2, 4]) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      x: internalTrashCoordinates.source.x + offset,
      y: internalTrashCoordinates.source.y,
    });
    await pause(24);
  }
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...internalTrashCoordinates.destination,
  });
  await pause(40);
  const internalTrashPreview = (await window.webContents.executeJavaScript(
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
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    ...internalTrashCoordinates.destination,
  });
  if (
    !internalTrashPreview?.highlighted ||
    !internalTrashPreview.pointerOwned ||
    internalTrashPreview.cursor !== cursorBindings.expected.closed
  ) {
    throw new Error(
      `Internal Trash drop did not retain pointer ownership: ${JSON.stringify(internalTrashPreview)}.`,
    );
  }
  await pause(100);
  const internalTrashMove = (await window.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('[data-vfs-count]');
      return root instanceof HTMLElement &&
        Number(root.dataset.vfsCount || 0) === ${internalTrashCoordinates.vfsCount} &&
        document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="welcome"]'
        ) === null &&
        (document.querySelector('[data-transfer-notice="true"]')?.textContent?.trim() ?? '')
          .startsWith('Moved 1 item to Trash.');
    })()`,
    true,
  )) as boolean;
  if (!internalTrashMove) throw new Error('Internal document drop did not move into Trash.');

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
  )) as {
    disk: SmokePoint;
    trash: SmokePoint;
  } | null;

  if (!coordinates) throw new Error('Smoke test could not locate desktop icons.');

  await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      if (!(disk instanceof HTMLElement)) return;
      disk.addEventListener(
        'pointerdown',
        (event) => { window.__macintoshSmokeDiskPointerId = event.pointerId; },
        { once: true }
      );
    })()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates.disk });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...coordinates.disk,
  });
  await pause(28);
  await expectItemCursor(
    window,
    '[data-desktop-icon="system-disk"]',
    coordinates.disk,
    cursorBindings.expected,
    'pressed',
    'System Disk pointer-down before lost capture',
  );
  const diskCaptureReleased = await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      const pointerId = window.__macintoshSmokeDiskPointerId;
      if (!(disk instanceof HTMLElement) || typeof pointerId !== 'number') return false;
      if (!disk.hasPointerCapture(pointerId)) return false;
      disk.releasePointerCapture(pointerId);
      const released = !disk.hasPointerCapture(pointerId);
      disk.dispatchEvent(new PointerEvent('lostpointercapture', {
        pointerId,
        pointerType: 'mouse',
        bubbles: true
      }));
      return released;
    })()`,
    true,
  );
  if (!diskCaptureReleased) throw new Error('System Disk pointer capture could not be released.');
  await pause(44);
  await expectItemCursor(
    window,
    '[data-desktop-icon="system-disk"]',
    coordinates.disk,
    cursorBindings.expected,
    'idle',
    'System Disk lostpointercapture reset',
  );
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...coordinates.disk,
  });
  await pause(24);

  const sendDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    verifyFollowing: boolean,
  ): Promise<void> => {
    const selector = '[data-desktop-icon="system-disk"]';
    window.webContents.sendInputEvent({ type: 'mouseMove', ...from });
    await pause(24);
    await expectItemCursor(window, selector, from, cursorBindings.expected, 'idle', 'Disk hover');
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    await pause(28);
    await expectItemCursor(window, selector, from, cursorBindings.expected, 'pressed', 'Disk down');
    const subthresholdPoint = { x: from.x + 2, y: from.y };
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...subthresholdPoint,
    });
    await pause(24);
    await expectItemCursor(
      window,
      selector,
      subthresholdPoint,
      cursorBindings.expected,
      'pressed',
      'Disk sub-threshold hold',
    );

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
        await expectItemCursor(
          window,
          selector,
          pointer,
          cursorBindings.expected,
          'dragging',
          'Disk active drag',
        );
        const distance = (await window.webContents.executeJavaScript(
          `(() => {
            const disk = document.querySelector('[data-desktop-icon="system-disk"]');
            if (!(disk instanceof HTMLElement)) return 9999;
            const bounds = disk.getBoundingClientRect();
            return Math.hypot(bounds.left + bounds.width / 2 - ${pointer.x},
              bounds.top + bounds.height / 2 - ${pointer.y});
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
    await pause(36);
    await expectItemCursor(window, selector, to, cursorBindings.expected, 'idle', 'Disk up');
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
  await pause(28);
  await expectItemCursor(
    window,
    '[data-desktop-icon="trash"]',
    coordinates.trash,
    cursorBindings.expected,
    'pressed',
    'Trash pointer-down',
  );
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
  await expectItemCursor(
    window,
    '[data-desktop-icon="trash"]',
    cancelledTrashTarget,
    cursorBindings.expected,
    'dragging',
    'Trash active drag',
  );
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
  await pause(36);
  await expectItemCursor(
    window,
    '[data-desktop-icon="trash"]',
    cancelledTrashTarget,
    cursorBindings.expected,
    'off-idle',
    'Trash pointercancel reset',
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
    'document.querySelector(\'[data-menu="view"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="view-list"]\')?.click()',
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
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="view"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="view-icons"]\')?.click()',
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
  const geometryProof = (await window.webContents.executeJavaScript(
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
      windowTop: Number.parseFloat(finder.style.top)
    };
  })()`,
    true,
  )) as Record<string, unknown> | null;

  const desktopDocumentOpened = await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]'
      );
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  await pause(80);
  const desktopDocumentContent = desktopDocumentOpened
    ? await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Dropped Note.txt window"] .document-sheet')
          ?.textContent ?? null`,
        true,
      )
    : null;
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Close Dropped Note.txt"]')?.click()`,
    true,
  );
  await pause(40);

  const desktopFolderOpened = await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Drop Folder"]'
      );
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  await pause(80);
  const desktopFolderNestedVisible = desktopFolderOpened
    ? await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Drop Folder window"] [data-vfs-item]')
          ?.textContent?.includes('Nested Note.txt') === true`,
        true,
      )
    : false;
  const desktopNestedDocumentOpened = desktopFolderNestedVisible
    ? await window.webContents.executeJavaScript(
        `(() => {
          const item = document.querySelector(
            '[aria-label="Drop Folder window"] [data-vfs-item]'
          );
          if (!(item instanceof HTMLElement)) return false;
          item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
          return true;
        })()`,
        true,
      )
    : false;
  await pause(80);
  const desktopNestedDocumentContent = desktopNestedDocumentOpened
    ? await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Nested Note.txt window"] .document-sheet')
          ?.textContent ?? null`,
        true,
      )
    : null;
  const proof = {
    ...geometryProof,
    desktopDocumentContent,
    desktopFolderNestedVisible,
    desktopNestedDocumentContent,
  };

  const destination = path.join(app.getPath('userData'), PROBE_FILE_NAME);
  await writeFile(destination, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  normalQuit.quitWithoutFlush();
};

const runNormalQuitProbe = async (window: BrowserWindow): Promise<void> => {
  await waitForRenderer(window);

  smokeSaveFailuresRemaining = 1;
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
  await pause(30);

  const initialVfsCount = (await window.webContents.executeJavaScript(
    "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
    true,
  )) as number;
  const mutationStartedAt = Date.now();
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu="file"]\')?.click()',
    true,
  );
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-menu-action="new-folder"]\')?.click()',
    true,
  );

  const mutationDeadline = mutationStartedAt + 210;
  let finalVfsCount = initialVfsCount;
  while (Date.now() < mutationDeadline) {
    finalVfsCount = (await window.webContents.executeJavaScript(
      "Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') || 0)",
      true,
    )) as number;
    if (finalVfsCount === initialVfsCount + 1) break;
    await pause(5);
  }
  const quitDelay = Date.now() - mutationStartedAt;
  if (finalVfsCount !== initialVfsCount + 1 || quitDelay >= 220) {
    throw new Error(
      `Normal quit mutation missed the persistence debounce window: ${JSON.stringify({
        initialVfsCount,
        finalVfsCount,
        quitDelay,
      })}.`,
    );
  }

  app.quit();
  app.quit();
  setTimeout(() => {
    if (!window.isDestroyed()) {
      console.error('Normal quit did not complete after the final state flush.');
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
  } else if (persistenceProbeMode) {
    void runPersistenceProbe(mainWindow).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  } else if (normalQuitProbeMode) {
    void runNormalQuitProbe(mainWindow).catch((error) => {
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

app.on('before-quit', (event) => {
  if (!normalQuit.shouldPreventQuit()) return;
  event.preventDefault();
  requestNormalQuit();
});

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
