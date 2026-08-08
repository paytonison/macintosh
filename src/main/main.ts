import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/contracts';
import { createDefaultState, type MacintoshState } from '../shared/state';
import {
  executeVfsCommand,
  isMergeImportedEntriesCommand,
  isVfsCommand,
  type VfsMutationResult,
} from '../shared/vfs';
import { inspectImportPaths } from './import-files';
import { createNormalQuitCoordinator } from './normal-quit';
import { parsePersistentState, serializePersistentState } from './persistent-state';
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
const captureWriteMixedMode = process.argv.includes('--capture-write-mixed');
const captureWriteMode = process.argv.includes('--capture-write') || captureWriteMixedMode;
const captureStartupArgument = process.argv.find((value) => value.startsWith('--capture-startup='));
const captureSizeArgument = process.argv.find((value) => value.startsWith('--capture-size='));
const captureSize = (() => {
  const match = captureSizeArgument?.match(/^--capture-size=(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 800 && width <= 4096 && height >= 560 && height <= 2160
    ? { width, height }
    : null;
})();
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
let smokeEjectFinalizationRequestCount = 0;

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
    return parsePersistentState(serialized);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.warn('Could not load Macintosh state:', error);
    return createDefaultState();
  }
};

const writeStateAtomically = async (state: MacintoshState): Promise<void> => {
  const destination = statePath();
  const temporary = `${destination}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, serializePersistentState(state), { mode: 0o600 });
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

  ipcMain.handle(IPC_CHANNELS.editClipboard, (event, action: unknown) => {
    assertTrustedRenderer(event);
    if (action === 'copy') event.sender.copy();
    else if (action === 'cut') event.sender.cut();
    else if (action === 'paste') event.sender.paste();
    else throw new TypeError('Invalid Clipboard edit request.');
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.normalQuitReady, (event) => {
    assertTrustedRenderer(event);
    normalQuit.rendererReady();
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.cancelNormalQuit, (event) => {
    assertTrustedRenderer(event);
    if (!normalQuit.cancelQuit()) throw new Error('No normal quit is waiting to be cancelled.');
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.flushPresentationAndQuit, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await normalQuit.flushAndQuit(value);
    return { accepted: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.saveAndQuitAfterEject, async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (smokeMode) smokeEjectFinalizationRequestCount += 1;
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
  const ensureNativeInputFocus = async (label: string): Promise<void> => {
    let rendererFocused = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      window.show();
      if (process.platform === 'darwin') app.focus({ steal: true });
      window.focus();
      window.webContents.focus();
      await pause(25);
      rendererFocused = (await window.webContents.executeJavaScript(
        'document.hasFocus()',
        true,
      )) as boolean;
      if (window.isFocused() && rendererFocused) return;
    }
    throw new Error(
      `${label} could not focus Electron for native input: ${JSON.stringify({
        browserWindowFocused: window.isFocused(),
        rendererFocused,
      })}.`,
    );
  };

  await waitForRenderer(window);
  await ensureNativeInputFocus('Initial smoke setup');
  await pause(75);

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
    frameAnimationName: string;
    frameAnimationPresent: boolean;
    windowId: string;
    frameBoxShadow: string;
    frameBounds: { left: number; top: number; width: number; height: number };
    framePointerEvents: string;
    frameTransform: string;
    frameVisibility: string;
    startX: string;
    startY: string;
    startWidth: string;
    startHeight: string;
    endX: string;
    endY: string;
    endWidth: string;
    endHeight: string;
    shadowAnimationName: string;
    shadowAriaHidden: string | null;
    shadowBounds: { left: number; top: number; width: number; height: number };
    shadowBackgroundColor: string;
    shadowBorderColor: string;
    shadowBorderStyle: string;
    shadowBorderWidth: string;
    shadowBoxShadow: string;
    shadowCloseBoxBorder: string;
    shadowInnerBorder: string;
    shadowMounted: boolean;
    shadowOutlineColor: string;
    shadowOutlineStyle: string;
    shadowOutlineWidth: string;
    shadowPointerEvents: string;
    shadowTitleDivider: string;
    shadowTransform: string;
    frames: { x: string; y: string; width: string; height: string }[];
  };
  const clickAt = async (point: SmokePoint): Promise<void> => {
    await ensureNativeInputFocus('Native click');
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
  const invokeRendererMenuAction = async (menuId: string, actionId: string): Promise<void> => {
    const found = (await window.webContents.executeJavaScript(
      `(() => {
        const menu = document.querySelector(${JSON.stringify(`[data-menu="${menuId}"]`)});
        if (!(menu instanceof HTMLElement)) return false;
        menu.click();
        return true;
      })()`,
      true,
    )) as boolean;
    if (!found) throw new Error(`Smoke test could not open the ${menuId} menu.`);
    await pause(20);
    const invoked = (await window.webContents.executeJavaScript(
      `(() => {
        const action = document.querySelector(${JSON.stringify(
          `[data-menu-action="${actionId}"]`,
        )});
        if (!(action instanceof HTMLElement)) return false;
        action.click();
        return true;
      })()`,
      true,
    )) as boolean;
    if (!invoked) throw new Error(`Smoke test could not invoke ${actionId}.`);
    await pause(40);
  };
  const readRendererMenuState = async (
    menuId: string,
    actionIds: readonly string[],
  ): Promise<Record<string, { checked: string | null; disabled: boolean }>> => {
    const found = (await window.webContents.executeJavaScript(
      `(() => {
        const menu = document.querySelector(${JSON.stringify(`[data-menu="${menuId}"]`)});
        if (!(menu instanceof HTMLElement)) return false;
        menu.click();
        return true;
      })()`,
      true,
    )) as boolean;
    if (!found) throw new Error(`Smoke test could not open the ${menuId} menu.`);
    await pause(20);
    const result = (await window.webContents.executeJavaScript(
      `(() => {
        const result = {};
        for (const actionId of ${JSON.stringify(actionIds)}) {
          const action = document.querySelector('[data-menu-action="' + actionId + '"]');
          if (!(action instanceof HTMLButtonElement)) return null;
          result[actionId] = {
            checked: action.getAttribute('aria-checked'),
            disabled: action.disabled
          };
        }
        document.querySelector(${JSON.stringify(`[data-menu="${menuId}"]`)})?.click();
        return result;
      })()`,
      true,
    )) as Record<string, { checked: string | null; disabled: boolean }> | null;
    await pause(20);
    if (!result) throw new Error(`Smoke test could not read the ${menuId} menu state.`);
    return result;
  };
  const copyActiveWriteSelection = async (expected: string, label: string): Promise<string> => {
    clipboard.clear();
    await invokeRendererMenuAction('edit', 'copy');
    let copied = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      copied = clipboard.readText();
      if (copied === expected) return copied;
      await pause(20);
    }
    throw new Error(`${label} copied the wrong retained selection: ${JSON.stringify(copied)}.`);
  };
  const activateWriteTextSelection = async (
    writeSelector: string,
    from: number,
    to: number,
    label: string,
  ): Promise<string> => {
    const selectedText = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(${JSON.stringify(writeSelector)});
        const viewport = write?.querySelector('.write-document-viewport');
        const editor = write?.querySelector('[data-write-editor="true"]');
        if (!(write instanceof HTMLElement) || !(viewport instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
        viewport.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 901
        }));
        editor.focus();
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let total = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          textNodes.push({ node, start: total, end: total + (node.textContent?.length ?? 0) });
          total += node.textContent?.length ?? 0;
        }
        const pointAt = (offset) => {
          const clamped = Math.max(0, Math.min(total, offset));
          const entry = textNodes.find((candidate) => clamped <= candidate.end) ?? textNodes.at(-1);
          return entry ? { node: entry.node, offset: Math.max(0, clamped - entry.start) } : null;
        };
        const start = pointAt(${String(from)});
        const end = pointAt(${String(to)});
        if (!start || !end) return null;
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection?.toString() ?? '';
      })()`,
      true,
    )) as string | null;
    await pause(50);
    if (selectedText === null || selectedText.length !== to - from) {
      throw new Error(`${label} could not establish its retained selection.`);
    }
    return selectedText;
  };
  const activateWriteMatchingTextSelection = async (
    writeSelector: string,
    text: string,
    label: string,
  ): Promise<string> => {
    const selectedText = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(${JSON.stringify(writeSelector)});
        const viewport = write?.querySelector('.write-document-viewport');
        const editor = write?.querySelector('[data-write-editor="true"]');
        if (!(write instanceof HTMLElement) || !(viewport instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
        viewport.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 903
        }));
        editor.focus();
        const targetText = ${JSON.stringify(text)};
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let target = null;
        let offset = -1;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const nextOffset = (node.textContent ?? '').indexOf(targetText);
          if (nextOffset < 0) continue;
          target = node;
          offset = nextOffset;
          break;
        }
        if (!target || offset < 0) return null;
        const range = document.createRange();
        range.setStart(target, offset);
        range.setEnd(target, offset + targetText.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection?.toString() ?? '';
      })()`,
      true,
    )) as string | null;
    await pause(50);
    if (selectedText !== text) {
      throw new Error(
        `${label} could not establish its retained selection: ${JSON.stringify(selectedText)}.`,
      );
    }
    return selectedText;
  };
  const reactivateWriteEditor = async (writeSelector: string, label: string): Promise<string> => {
    const activated = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(${JSON.stringify(writeSelector)});
        const viewport = write?.querySelector('.write-document-viewport');
        if (!(write instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return false;
        viewport.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 902
        }));
        viewport.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          pointerId: 902
        }));
        return true;
      })()`,
      true,
    )) as boolean;
    await pause(50);
    if (!activated) throw new Error(`${label} could not reactivate its window.`);
    const selectedText = (await window.webContents.executeJavaScript(
      `(() => {
        const editor = document.querySelector(
          ${JSON.stringify(`${writeSelector} [data-write-editor="true"]`)}
        );
        if (!(editor instanceof HTMLElement)) return null;
        editor.focus();
        return window.getSelection()?.toString() ?? '';
      })()`,
      true,
    )) as string | null;
    await pause(30);
    if (selectedText === null) throw new Error(`${label} could not reactivate its editor.`);
    return selectedText;
  };
  const readWriteRulerState = async (
    writeSelector: string,
  ): Promise<{
    leftIndent: string | null;
    firstLineIndent: string | null;
    rightIndent: string | null;
    tabs: string[];
    mixed: string | null;
  }> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(${JSON.stringify(writeSelector)});
        const markerLeft = (label) => {
          const marker = write?.querySelector('[aria-label="' + label + '"]');
          return marker instanceof HTMLElement ? marker.style.left : null;
        };
        const mixed = write?.querySelector('.write-ruler-mixed-indicator');
        return {
          leftIndent: markerLeft('Left indent'),
          firstLineIndent: markerLeft('First-line indent'),
          rightIndent: markerLeft('Right indent'),
          tabs: [...(write?.querySelectorAll('.write-ruler-marker.is-tab') ?? [])]
            .map((tab) => tab.getAttribute('aria-label') ?? ''),
          mixed: mixed?.getAttribute('aria-label') ?? null
        };
      })()`,
      true,
    )) as {
      leftIndent: string | null;
      firstLineIndent: string | null;
      rightIndent: string | null;
      tabs: string[];
      mixed: string | null;
    };
  type WriteLayoutSnapshot = {
    state: string | null;
    generation: string | null;
    pass: string | null;
    pageCount: string | null;
    status: string;
  };
  const waitForWriteLayout = async (
    writeSelector: string,
    label: string,
  ): Promise<WriteLayoutSnapshot> => {
    const deadline = Date.now() + 3_000;
    let previous: WriteLayoutSnapshot | null = null;
    let last: WriteLayoutSnapshot | null = null;
    while (Date.now() < deadline) {
      last = (await window.webContents.executeJavaScript(
        `(() => {
          const write = document.querySelector(${JSON.stringify(writeSelector)});
          const pages = write?.querySelector('.write-page-stack');
          if (!(write instanceof HTMLElement) || !(pages instanceof HTMLElement)) return null;
          return {
            state: pages.getAttribute('data-write-layout-state'),
            generation: pages.getAttribute('data-write-layout-generation'),
            pass: pages.getAttribute('data-write-layout-pass'),
            pageCount: write.querySelector('[data-page-count]')?.getAttribute('data-page-count') ?? null,
            status: write.querySelector('.write-status-bar')?.textContent?.trim() ?? ''
          };
        })()`,
        true,
      )) as WriteLayoutSnapshot | null;
      if (last?.state === 'error') {
        throw new Error(`${label} entered a failed Write layout state: ${JSON.stringify(last)}.`);
      }
      if (
        last?.state === 'stable' &&
        previous?.state === 'stable' &&
        last.generation === previous.generation &&
        last.pass === previous.pass &&
        last.pageCount === previous.pageCount
      ) {
        return last;
      }
      previous = last;
      await pause(20);
    }
    throw new Error(`${label} did not reach a stable Write layout: ${JSON.stringify(last)}.`);
  };
  const readStableWritePaginationFingerprint = async (
    writeSelector: string,
    label: string,
  ): Promise<string> => {
    await waitForWriteLayout(writeSelector, label);
    const fingerprint = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(${JSON.stringify(writeSelector)});
        const pages = write?.querySelector('.write-page-stack');
        const editor = write?.querySelector('[data-write-editor="true"]');
        if (!(write instanceof HTMLElement) || !(pages instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
        const editorBounds = editor.getBoundingClientRect();
        const round = (value) => Math.round(value * 100) / 100;
        const geometry = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            top: round(bounds.top - editorBounds.top),
            left: round(bounds.left - editorBounds.left),
            width: round(bounds.width),
            height: round(bounds.height)
          };
        };
        return JSON.stringify({
          pageCount: Number(write.querySelector('[data-page-count]')?.getAttribute('data-page-count')),
          pages: {
            width: round(pages.getBoundingClientRect().width),
            height: round(pages.getBoundingClientRect().height)
          },
          editor: {
            html: editor.innerHTML,
            clientHeight: editor.clientHeight,
            scrollHeight: editor.scrollHeight
          },
          blocks: [...editor.querySelectorAll('[data-write-paragraph], [data-write-page-break]')]
            .map((block) => ({
              type: block.hasAttribute('data-write-page-break') ? 'page-break' : 'paragraph',
              text: block.textContent ?? '',
              inlineStyles: [...block.querySelectorAll(
                '[data-write-font-family], [data-write-font-size]'
              )].map((run) => ({
                text: run.textContent ?? '',
                fontFamily: run.getAttribute('data-write-font-family'),
                fontSize: run.getAttribute('data-write-font-size')
              })),
              alignment: block.getAttribute('data-alignment'),
              lineSpacing: block.getAttribute('data-line-spacing'),
              tabStops: block.getAttribute('data-tab-stops'),
              geometry: geometry(block)
            })),
          automaticGaps: [...editor.querySelectorAll('.write-automatic-page-gap')]
            .map((gap) => geometry(gap)),
          tabs: [...editor.querySelectorAll('[data-write-tab]')]
            .map((tab) => geometry(tab))
        });
      })()`,
      true,
    )) as string | null;
    if (!fingerprint) throw new Error(`${label} could not capture its Write layout fingerprint.`);
    return fingerprint;
  };
  const observeWindowAnimation = async (
    windowSelector: string,
    phase: SmokeWindowAnimation['phase'],
    run: () => void | Promise<void>,
    hold = false,
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
            const finder = document.querySelector(${JSON.stringify(windowSelector)});
            if (!(finder instanceof HTMLElement) || finder.getAttribute(animationAttribute) !== 'true') return;
            const windowId =
              finder.getAttribute('data-finder-window') ??
              finder.getAttribute('data-write-window');
            const shadow = [...document.querySelectorAll('[data-window-animation-shadow]')].find(
              (candidate) =>
                candidate.getAttribute('data-window-animation-shadow') === windowId
            );
            if (!(shadow instanceof HTMLElement) || !windowId) return;
            observer.disconnect();
            if (${hold ? 'true' : 'false'}) {
              window.__macintoshSmokeHeldWindow = finder;
            }
            const frameAnimation = finder.getAnimations().find(
              (animation) => animation.animationName === expectedAnimationName
            );
            const shadowAnimation = shadow.getAnimations().find(
              (animation) => animation.animationName === expectedAnimationName
            );
            if (shadowAnimation) {
              const durationValue = shadowAnimation.effect?.getTiming().duration;
              const duration = typeof durationValue === 'number' ? durationValue : 20;
              shadowAnimation.pause();
              shadowAnimation.currentTime = duration / 2;
            }
            const style = getComputedStyle(finder);
            const shadowStyle = getComputedStyle(shadow);
            const surfaceBounds = surface.getBoundingClientRect();
            const frameBounds = finder.getBoundingClientRect();
            const shadowBounds = shadow.getBoundingClientRect();
            const shadowInnerStyle = getComputedStyle(shadow, '::before');
            const shadowTitle = shadow.querySelector(':scope > span');
            const shadowTitleStyle = shadowTitle ? getComputedStyle(shadowTitle) : null;
            const shadowCloseStyle = shadowTitle ? getComputedStyle(shadowTitle, '::before') : null;
            const frameTransform = style.transform;
            const shadowTransform = shadowStyle.transform;
            const snapshot = {
              phase: ${JSON.stringify(phase)},
              frameAnimationName: style.animationName,
              frameAnimationPresent: Boolean(frameAnimation),
              windowId,
              frameBoxShadow: style.boxShadow,
              frameBounds: {
                left: frameBounds.left - surfaceBounds.left,
                top: frameBounds.top - surfaceBounds.top,
                width: frameBounds.width,
                height: frameBounds.height
              },
              framePointerEvents: style.pointerEvents,
              frameTransform,
              frameVisibility: style.visibility,
              startX: shadowStyle.getPropertyValue('--window-animation-start-x').trim(),
              startY: shadowStyle.getPropertyValue('--window-animation-start-y').trim(),
              startWidth: shadowStyle.getPropertyValue('--window-animation-start-width').trim(),
              startHeight: shadowStyle.getPropertyValue('--window-animation-start-height').trim(),
              endX: shadowStyle.getPropertyValue('--window-animation-end-x').trim(),
              endY: shadowStyle.getPropertyValue('--window-animation-end-y').trim(),
              endWidth: shadowStyle.getPropertyValue('--window-animation-end-width').trim(),
              endHeight: shadowStyle.getPropertyValue('--window-animation-end-height').trim(),
              shadowAnimationName: shadowStyle.animationName,
              shadowAriaHidden: shadow.getAttribute('aria-hidden'),
              shadowBounds: {
                left: shadowBounds.left - surfaceBounds.left,
                top: shadowBounds.top - surfaceBounds.top,
                width: shadowBounds.width,
                height: shadowBounds.height
              },
              shadowBackgroundColor: shadowStyle.backgroundColor,
              shadowBorderColor: shadowStyle.borderColor,
              shadowBorderStyle: shadowStyle.borderStyle,
              shadowBorderWidth: shadowStyle.borderWidth,
              shadowBoxShadow: shadowStyle.boxShadow,
              shadowCloseBoxBorder: shadowCloseStyle
                ? [shadowCloseStyle.borderTopWidth, shadowCloseStyle.borderTopStyle, shadowCloseStyle.borderTopColor].join(' ')
                : '',
              shadowInnerBorder: [
                shadowInnerStyle.borderTopWidth,
                shadowInnerStyle.borderTopStyle,
                shadowInnerStyle.borderTopColor
              ].join(' '),
              shadowMounted: shadow.isConnected,
              shadowOutlineColor: shadowStyle.outlineColor,
              shadowOutlineStyle: shadowStyle.outlineStyle,
              shadowOutlineWidth: shadowStyle.outlineWidth,
              shadowPointerEvents: shadowStyle.pointerEvents,
              shadowTitleDivider: shadowTitleStyle
                ? [shadowTitleStyle.borderTopWidth, shadowTitleStyle.borderTopStyle, shadowTitleStyle.borderTopColor].join(' ')
                : '',
              shadowTransform,
              frames: Array.from({ length: 7 }, (_, index) => ({
                x: shadowStyle.getPropertyValue('--window-animation-frame-' + index + '-x').trim(),
                y: shadowStyle.getPropertyValue('--window-animation-frame-' + index + '-y').trim(),
                width: shadowStyle.getPropertyValue('--window-animation-frame-' + index + '-width').trim(),
                height: shadowStyle.getPropertyValue('--window-animation-frame-' + index + '-height').trim()
              }))
            };
            if (shadowAnimation && !${hold ? 'true' : 'false'}) {
              shadowAnimation.currentTime = 0;
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
  const assertWindowAnimationOutline = (
    animation: SmokeWindowAnimation | null,
    label: string,
  ): void => {
    const expectedName =
      animation?.phase === 'opening' ? 'finder-window-open' : 'finder-window-close';
    const startWidth = Number.parseFloat(animation?.startWidth ?? 'NaN');
    const startHeight = Number.parseFloat(animation?.startHeight ?? 'NaN');
    const startX = Number.parseFloat(animation?.startX ?? 'NaN');
    const startY = Number.parseFloat(animation?.startY ?? 'NaN');
    const endWidth = Number.parseFloat(animation?.endWidth ?? 'NaN');
    const endHeight = Number.parseFloat(animation?.endHeight ?? 'NaN');
    const endX = Number.parseFloat(animation?.endX ?? 'NaN');
    const endY = Number.parseFloat(animation?.endY ?? 'NaN');
    const geometryValues = [
      startX,
      startY,
      startWidth,
      startHeight,
      endX,
      endY,
      endWidth,
      endHeight,
    ];
    const frames = (animation?.frames ?? []).map((frame) => ({
      x: Number.parseFloat(frame.x),
      y: Number.parseFloat(frame.y),
      width: Number.parseFloat(frame.width),
      height: Number.parseFloat(frame.height),
    }));
    const frameValuesAreInteger =
      frames.length === 7 &&
      frames.every(
        (frame) =>
          [frame.x, frame.y, frame.width, frame.height].every(
            (value) => Number.isFinite(value) && Number.isInteger(value),
          ) &&
          frame.width > 0 &&
          frame.height > 0,
      );
    const expectedFrames = Array.from({ length: 7 }, (_, index) => {
      const progress = index / 6;
      const left = Math.round(startX + (endX - startX) * progress);
      const top = Math.round(startY + (endY - startY) * progress);
      const right = Math.round(
        startX + startWidth + (endX + endWidth - startX - startWidth) * progress,
      );
      const bottom = Math.round(
        startY + startHeight + (endY + endHeight - startY - startHeight) * progress,
      );
      return { x: left, y: top, width: right - left, height: bottom - top };
    });
    const framesFollowAuthoredPath =
      frameValuesAreInteger &&
      frames.every(
        (frame, index) =>
          frame.x === expectedFrames[index]?.x &&
          frame.y === expectedFrames[index]?.y &&
          frame.width === expectedFrames[index]?.width &&
          frame.height === expectedFrames[index]?.height,
      );
    const midpoint = frames[3];
    if (
      !animation ||
      !geometryValues.every((value) => Number.isFinite(value) && Number.isInteger(value)) ||
      startWidth !== Math.max(1, Math.round(endWidth * 0.12)) ||
      startHeight !== Math.max(1, Math.round(endHeight * 0.12)) ||
      !framesFollowAuthoredPath ||
      animation.frameAnimationName !== 'none' ||
      animation.frameAnimationPresent ||
      animation.shadowAnimationName !== expectedName ||
      animation.frameBoxShadow !== 'none' ||
      animation.frameVisibility !== 'hidden' ||
      animation.framePointerEvents !== 'none' ||
      animation.frameTransform !== 'none' ||
      animation.shadowTransform !== 'none' ||
      Math.abs(animation.frameBounds.left - endX) > 0.05 ||
      Math.abs(animation.frameBounds.top - endY) > 0.05 ||
      Math.abs(animation.frameBounds.width - endWidth) > 0.05 ||
      Math.abs(animation.frameBounds.height - endHeight) > 0.05 ||
      !midpoint ||
      Math.abs(animation.shadowBounds.left - midpoint.x) > 0.05 ||
      Math.abs(animation.shadowBounds.top - midpoint.y) > 0.05 ||
      Math.abs(animation.shadowBounds.width - midpoint.width) > 0.05 ||
      Math.abs(animation.shadowBounds.height - midpoint.height) > 0.05 ||
      animation.shadowBackgroundColor !== 'rgba(0, 0, 0, 0)' ||
      animation.shadowBorderColor !== 'rgb(0, 0, 0)' ||
      animation.shadowBorderStyle !== 'solid' ||
      animation.shadowBorderWidth !== '1px' ||
      !animation.shadowBoxShadow.startsWith('rgb(0, 0, 0) ') ||
      !animation.shadowBoxShadow.endsWith(' 3px 3px 0px 0px') ||
      animation.shadowInnerBorder !== '1px dotted rgb(0, 0, 0)' ||
      animation.shadowTitleDivider !== '1px solid rgb(0, 0, 0)' ||
      animation.shadowCloseBoxBorder !== '1px solid rgb(0, 0, 0)' ||
      animation.shadowOutlineColor !== 'rgb(255, 255, 255)' ||
      animation.shadowOutlineStyle !== 'solid' ||
      animation.shadowOutlineWidth !== '1px' ||
      animation.shadowPointerEvents !== 'none' ||
      animation.shadowAriaHidden !== 'true' ||
      !animation.shadowMounted
    ) {
      throw new Error(
        `${label} did not render a stationary hidden frame with a stepped outline: ${JSON.stringify(animation)}.`,
      );
    }
  };
  const assertWindowAnimationSource = (
    animation: SmokeWindowAnimation | null,
    source: SmokePoint,
    label: string,
  ): void => {
    const start = {
      x: Number.parseFloat(animation?.startX ?? 'NaN'),
      y: Number.parseFloat(animation?.startY ?? 'NaN'),
      width: Number.parseFloat(animation?.startWidth ?? 'NaN'),
      height: Number.parseFloat(animation?.startHeight ?? 'NaN'),
    };
    const end = {
      x: Number.parseFloat(animation?.endX ?? 'NaN'),
      y: Number.parseFloat(animation?.endY ?? 'NaN'),
      width: Number.parseFloat(animation?.endWidth ?? 'NaN'),
      height: Number.parseFloat(animation?.endHeight ?? 'NaN'),
    };
    const anchorLeft = Math.abs(source.x - end.x) <= Math.abs(source.x - (end.x + end.width));
    const anchorTop = Math.abs(source.y - end.y) <= Math.abs(source.y - (end.y + end.height));
    const corner = {
      x: anchorLeft ? start.x : start.x + start.width,
      y: anchorTop ? start.y : start.y + start.height,
    };
    if (
      ![start.x, start.y, start.width, start.height, end.x, end.y, end.width, end.height].every(
        Number.isFinite,
      ) ||
      Math.abs(corner.x - source.x) > 0.05 ||
      Math.abs(corner.y - source.y) > 0.05
    ) {
      throw new Error(
        `${label} did not anchor its nearest corner to the artwork center: ${JSON.stringify({ source, corner, anchorLeft, anchorTop, animation })}.`,
      );
    }
  };
  const assertWindowAnimationCenteredFallback = (
    animation: SmokeWindowAnimation | null,
    label: string,
  ): void => {
    const startCenter = {
      x:
        Number.parseFloat(animation?.startX ?? 'NaN') +
        Number.parseFloat(animation?.startWidth ?? 'NaN') / 2,
      y:
        Number.parseFloat(animation?.startY ?? 'NaN') +
        Number.parseFloat(animation?.startHeight ?? 'NaN') / 2,
    };
    const endCenter = {
      x:
        Number.parseFloat(animation?.endX ?? 'NaN') +
        Number.parseFloat(animation?.endWidth ?? 'NaN') / 2,
      y:
        Number.parseFloat(animation?.endY ?? 'NaN') +
        Number.parseFloat(animation?.endHeight ?? 'NaN') / 2,
    };
    if (
      ![startCenter.x, startCenter.y, endCenter.x, endCenter.y].every(Number.isFinite) ||
      Math.abs(startCenter.x - endCenter.x) > 0.5 ||
      Math.abs(startCenter.y - endCenter.y) > 0.5
    ) {
      throw new Error(
        `${label} did not use the centered source-less fallback: ${JSON.stringify({ startCenter, endCenter, animation })}.`,
      );
    }
  };
  const findWindowAnimationArtworkSource = async (
    sourceSelector: string,
  ): Promise<SmokePoint | null> => {
    const source = (await window.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector(${JSON.stringify(sourceSelector)});
        const artwork = item?.querySelector(
          '.pixel-icon[data-pixel-icon-variant="artwork"]'
        );
        const surface = item?.closest('.desktop-surface');
        if (!(item instanceof HTMLElement) || !(artwork instanceof SVGElement) || !(surface instanceof HTMLElement)) return null;
        const artworkBounds = artwork.getBoundingClientRect();
        const surfaceBounds = surface.getBoundingClientRect();
        const centerX = artworkBounds.left + artworkBounds.width / 2;
        const centerY = artworkBounds.top + artworkBounds.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        const clippingOverflow = new Set(['auto', 'clip', 'hidden', 'scroll']);
        let fullyUnclipped = false;
        for (let ancestor = artwork.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clipsX = clippingOverflow.has(style.overflowX);
          const clipsY = clippingOverflow.has(style.overflowY);
          if (clipsX || clipsY) {
            const ancestorBounds = ancestor.getBoundingClientRect();
            const clipLeft = ancestorBounds.left + ancestor.clientLeft;
            const clipTop = ancestorBounds.top + ancestor.clientTop;
            const clipRight = clipLeft + ancestor.clientWidth;
            const clipBottom = clipTop + ancestor.clientHeight;
            if (
              (clipsX &&
                (artworkBounds.left < clipLeft || artworkBounds.right > clipRight)) ||
              (clipsY &&
                (artworkBounds.top < clipTop || artworkBounds.bottom > clipBottom))
            ) {
              return null;
            }
          }
          if (ancestor === surface) {
            fullyUnclipped = true;
            break;
          }
        }
        if (
          artworkBounds.width <= 0 ||
          artworkBounds.height <= 0 ||
          !fullyUnclipped ||
          !(hit instanceof Element) ||
          !item.contains(hit)
        ) return null;
        return {
          x: Math.round(centerX - surfaceBounds.left),
          y: Math.round(centerY - surfaceBounds.top)
        };
      })()`,
      true,
    )) as SmokePoint | null;
    return source;
  };
  const readWindowAnimationArtworkSource = async (
    sourceSelector: string,
    label: string,
  ): Promise<SmokePoint> => {
    const source = await findWindowAnimationArtworkSource(sourceSelector);
    if (!source) {
      const details = await window.webContents.executeJavaScript(
        `(() => {
          const item = document.querySelector(${JSON.stringify(sourceSelector)});
          const artwork = item?.querySelector(
            '.pixel-icon[data-pixel-icon-variant="artwork"]'
          );
          if (!(item instanceof HTMLElement) || !(artwork instanceof SVGElement)) {
            return { itemPresent: Boolean(item), artworkPresent: Boolean(artwork) };
          }
          const bounds = artwork.getBoundingClientRect();
          const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
          const hit = document.elementFromPoint(center.x, center.y);
          return {
            bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            center,
            hidden: item.hidden,
            hit: hit instanceof Element ? hit.outerHTML.slice(0, 160) : null,
            hitInsideItem: hit instanceof Element && item.contains(hit),
            ancestors: [...(function* () {
              for (let ancestor = artwork.parentElement; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                const rect = ancestor.getBoundingClientRect();
                yield {
                  className: ancestor.className,
                  overflowX: style.overflowX,
                  overflowY: style.overflowY,
                  clip: {
                    left: rect.left + ancestor.clientLeft,
                    top: rect.top + ancestor.clientTop,
                    right: rect.left + ancestor.clientLeft + ancestor.clientWidth,
                    bottom: rect.top + ancestor.clientTop + ancestor.clientHeight
                  }
                };
                if (ancestor.classList.contains('desktop-surface')) break;
              }
            })()]
          };
        })()`,
        true,
      );
      throw new Error(
        `${label} pixel artwork could not be located, was clipped, or was occluded: ${JSON.stringify(details)}.`,
      );
    }
    return source;
  };
  const waitForWindowSettled = async (
    windowSelector: string,
    windowLabel: string,
    windowId: string,
  ): Promise<void> => {
    type SettledWindowState = {
      animationName: string;
      boxShadow: string;
      opening: string | null;
      closing: string | null;
      shadowPresent: boolean;
      transform: string;
      visibility: string;
    };
    const deadline = Date.now() + 800;
    let state: SettledWindowState | null = null;
    while (Date.now() < deadline) {
      state = (await window.webContents.executeJavaScript(
        `(() => {
          const finder = document.querySelector(${JSON.stringify(windowSelector)});
          if (!(finder instanceof HTMLElement)) return null;
          const style = getComputedStyle(finder);
          return {
            animationName: style.animationName,
            boxShadow: style.boxShadow,
            opening: finder.getAttribute('data-opening'),
            closing: finder.getAttribute('data-closing'),
            transform: style.transform,
            visibility: style.visibility,
            shadowPresent: document.querySelector(
              '[data-window-animation-shadow=${JSON.stringify(windowId)}]'
            ) !== null
          };
        })()`,
        true,
      )) as SettledWindowState | null;
      if (state && state.opening !== 'true' && state.closing !== 'true' && !state.shadowPresent) {
        if (
          state.animationName !== 'none' ||
          state.transform !== 'none' ||
          state.visibility !== 'visible' ||
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
  const waitForWindowAbsence = async (
    windowSelector: string,
    windowLabel: string,
    windowId?: string,
  ): Promise<void> => {
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const absent = await window.webContents.executeJavaScript(
        `(() => {
          const finderAbsent = document.querySelector(${JSON.stringify(windowSelector)}) === null;
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
  const assertHeldCloseReopened = async (
    windowSelector: string,
    windowLabel: string,
    animation: SmokeWindowAnimation,
    reopen: () => void | Promise<void>,
  ): Promise<void> => {
    const expected = {
      left: Number.parseFloat(animation.endX),
      top: Number.parseFloat(animation.endY),
      width: Number.parseFloat(animation.endWidth),
      height: Number.parseFloat(animation.endHeight),
    };
    type ReopenedWindowState = {
      animationName: string;
      bounds: { left: number; top: number; width: number; height: number };
      closing: string | null;
      count: number;
      outlinePresent: boolean;
      sameInstance: boolean;
      transform: string;
      visibility: string;
    };
    let state: ReopenedWindowState | null = null;
    try {
      await reopen();
      const deadline = Date.now() + 220;
      while (Date.now() < deadline) {
        state = (await window.webContents.executeJavaScript(
          `(() => {
            const surface = document.querySelector('.desktop-surface');
            const frame = document.querySelector(${JSON.stringify(windowSelector)});
            if (!(surface instanceof HTMLElement) || !(frame instanceof HTMLElement)) return null;
            const surfaceBounds = surface.getBoundingClientRect();
            const bounds = frame.getBoundingClientRect();
            const style = getComputedStyle(frame);
            return {
              animationName: style.animationName,
              bounds: {
                left: bounds.left - surfaceBounds.left,
                top: bounds.top - surfaceBounds.top,
                width: bounds.width,
                height: bounds.height
              },
              closing: frame.getAttribute('data-closing'),
              count: document.querySelectorAll(${JSON.stringify(windowSelector)}).length,
              outlinePresent: document.querySelector(
                '[data-window-animation-shadow=${animation.windowId}]'
              ) !== null,
              sameInstance: frame === window.__macintoshSmokeHeldWindow,
              transform: style.transform,
              visibility: style.visibility
            };
          })()`,
          true,
        )) as ReopenedWindowState | null;
        if (
          state?.sameInstance &&
          state.count === 1 &&
          state.closing !== 'true' &&
          !state.outlinePresent &&
          state.animationName === 'none' &&
          state.transform === 'none' &&
          state.visibility === 'visible' &&
          Math.abs(state.bounds.left - expected.left) <= 0.05 &&
          Math.abs(state.bounds.top - expected.top) <= 0.05 &&
          Math.abs(state.bounds.width - expected.width) <= 0.05 &&
          Math.abs(state.bounds.height - expected.height) <= 0.05
        ) {
          return;
        }
        await pause(10);
      }
    } finally {
      await window.webContents.executeJavaScript('delete window.__macintoshSmokeHeldWindow', true);
    }
    throw new Error(
      `${windowLabel} did not cancel its held close by restoring the same full window: ${JSON.stringify({ expected, state })}.`,
    );
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

  type SmokeIconHitRegionProbe = {
    itemPointerEvents: string;
    margin: {
      hitItemId: string | null;
      ownsLayout: boolean;
      point: SmokePoint;
    } | null;
    regions: {
      hitItemId: string | null;
      name: string | null;
      point: SmokePoint;
      pointerEvents: string;
    }[];
  };
  const inspectIconHitRegions = async (
    itemSelector: string,
    itemIdAttribute: string,
    layoutSelector: string,
  ): Promise<SmokeIconHitRegionProbe | null> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector(${JSON.stringify(itemSelector)});
        if (!(item instanceof HTMLElement)) return null;
        const itemBounds = item.getBoundingClientRect();
        const regions = [...item.querySelectorAll('[data-icon-hit-region]')].flatMap((region) => {
          if (!(region instanceof HTMLElement)) return [];
          const bounds = region.getBoundingClientRect();
          const point = {
            x: Math.round(bounds.left + bounds.width / 2),
            y: Math.round(bounds.top + bounds.height / 2)
          };
          const hit = document.elementFromPoint(point.x, point.y);
          return [{
            bounds,
            hitItemId: hit instanceof Element
              ? hit.closest(${JSON.stringify(
                `[${itemIdAttribute}]`,
              )})?.getAttribute(${JSON.stringify(itemIdAttribute)}) ?? null
              : null,
            name: region.getAttribute('data-icon-hit-region'),
            point,
            pointerEvents: getComputedStyle(region).pointerEvents
          }];
        });
        let margin = null;
        for (let y = Math.ceil(itemBounds.top) + 1; y < Math.floor(itemBounds.bottom) - 1 && !margin; y += 1) {
          for (let x = Math.ceil(itemBounds.left) + 1; x < Math.floor(itemBounds.right) - 1; x += 1) {
            if (regions.some(({ bounds }) =>
              x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
            )) continue;
            const hit = document.elementFromPoint(x, y);
            if (!(hit instanceof Element) || item.contains(hit)) continue;
            margin = {
              hitItemId:
                hit.closest(${JSON.stringify(
                  `[${itemIdAttribute}]`,
                )})?.getAttribute(${JSON.stringify(itemIdAttribute)}) ?? null,
              ownsLayout: hit.closest(${JSON.stringify(layoutSelector)}) !== null,
              point: { x, y }
            };
            break;
          }
        }
        return {
          itemPointerEvents: getComputedStyle(item).pointerEvents,
          margin,
          regions: regions.map(({ bounds: _bounds, ...region }) => region)
        };
      })()`,
      true,
    )) as SmokeIconHitRegionProbe | null;
  function assertIconHitRegionProbe(
    probe: SmokeIconHitRegionProbe | null,
    itemId: string,
    label: string,
  ): asserts probe is SmokeIconHitRegionProbe {
    const regionNames = probe?.regions
      .map(({ name }) => name)
      .sort()
      .join(',');
    if (
      probe?.itemPointerEvents !== 'none' ||
      regionNames !== 'artwork,label' ||
      probe.regions.some(
        (region) => region.pointerEvents !== 'auto' || region.hitItemId !== itemId,
      ) ||
      !probe.margin?.ownsLayout ||
      probe.margin.hitItemId !== null
    ) {
      throw new Error(
        `${label} retained an oversized layout-tile hit box: ${JSON.stringify(probe)}.`,
      );
    }
  }

  const desktopIconHitRegions = await inspectIconHitRegions(
    '[data-desktop-icon="system-disk"]',
    'data-desktop-icon',
    '.desktop-surface',
  );
  assertIconHitRegionProbe(desktopIconHitRegions, 'system-disk', 'Desktop icon');
  const desktopArtworkPoint = desktopIconHitRegions.regions.find(
    ({ name }) => name === 'artwork',
  )?.point;
  if (!desktopArtworkPoint || !desktopIconHitRegions.margin) {
    throw new Error('Desktop icon hit-region coordinates were unavailable.');
  }
  await clickAt(desktopArtworkPoint);
  const desktopArtworkSelected = (await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-icon="system-disk"]')?.classList.contains('is-selected') === true`,
    true,
  )) as boolean;
  await clickAt(desktopIconHitRegions.margin.point);
  const desktopMarginClearedSelection = (await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-icon="system-disk"]')?.classList.contains('is-selected') === false`,
    true,
  )) as boolean;
  if (!desktopArtworkSelected || !desktopMarginClearedSelection) {
    throw new Error('Desktop native pointer input did not distinguish artwork from tile margin.');
  }

  const finderIconHitRegions = await inspectIconHitRegions(
    '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]',
    'data-vfs-item',
    '.finder-icon-grid',
  );
  assertIconHitRegionProbe(finderIconHitRegions, 'applications', 'Finder icon');
  const finderControlHitRegions = await inspectIconHitRegions(
    '[data-finder-window="window-system-disk"] [data-vfs-item="system-folder"]',
    'data-vfs-item',
    '.finder-icon-grid',
  );
  assertIconHitRegionProbe(finderControlHitRegions, 'system-folder', 'Finder control icon');
  const finderControlArtworkPoint = finderControlHitRegions.regions.find(
    ({ name }) => name === 'artwork',
  )?.point;
  if (!finderControlArtworkPoint || !finderIconHitRegions.margin) {
    throw new Error('Finder icon hit-region coordinates were unavailable.');
  }
  await clickAt(finderControlArtworkPoint);
  await clickAt(finderIconHitRegions.margin.point);
  const finderMarginPreservedSelection = (await window.webContents.executeJavaScript(
    `document.querySelector('[data-vfs-item="system-folder"]')?.classList.contains('is-selected') === true &&
      document.querySelector('[data-vfs-item="applications"]')?.classList.contains('is-selected') === false`,
    true,
  )) as boolean;
  if (!finderMarginPreservedSelection) {
    throw new Error('Finder tile-margin input selected the icon outside its artwork and label.');
  }

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

  await ensureNativeInputFocus('Focus-loss drag');
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

  if (window.isFocused()) {
    window.blur();
  } else {
    await window.webContents.executeJavaScript("window.dispatchEvent(new Event('blur'))", true);
  }
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
  await ensureNativeInputFocus('Focus-loss recovery');
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

  const resizeWindow = async (
    windowSelector: string,
    growSelector: string,
    windowLabel: string,
    from: SmokePoint,
    to: SmokePoint,
    stationaryContentSelector?: string,
    commit = true,
  ): Promise<void> => {
    await ensureNativeInputFocus(`${windowLabel} resize`);
    const startingGeometry = (await window.webContents.executeJavaScript(
      `(() => {
        const target = document.querySelector(${JSON.stringify(windowSelector)});
        if (!(target instanceof HTMLElement)) return null;
        const bounds = target.getBoundingClientRect();
        const contentSelector = ${JSON.stringify(stationaryContentSelector ?? null)};
        const content = typeof contentSelector === 'string'
          ? target.querySelector(contentSelector)
          : null;
        const contentBounds = content?.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          content: contentBounds ? {
            left: contentBounds.left,
            top: contentBounds.top,
            width: contentBounds.width,
            height: contentBounds.height
          } : null
        };
      })()`,
      true,
    )) as {
      left: number;
      top: number;
      width: number;
      height: number;
      content: { left: number; top: number; width: number; height: number } | null;
    } | null;
    if (!startingGeometry) throw new Error(`${windowLabel} resize could not read its window.`);
    if (stationaryContentSelector && !startingGeometry.content) {
      throw new Error(`${windowLabel} resize could not read its stationary content.`);
    }
    await window.webContents.executeJavaScript(
      `(() => {
        delete window.__macintoshSmokeSystemResizePointerId;
        const grow = document.querySelector(${JSON.stringify(growSelector)});
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
          const grow = document.querySelector(${JSON.stringify(growSelector)});
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
      throw new Error(`${windowLabel} grow box did not acquire native pointer capture.`);
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
    const preview = (await window.webContents.executeJavaScript(
      `(() => {
        const target = document.querySelector(${JSON.stringify(windowSelector)});
        const outline = target?.querySelector('.window-drag-shadow');
        if (!(target instanceof HTMLElement) || !(outline instanceof HTMLElement)) return null;
        const frameBounds = target.getBoundingClientRect();
        const outlineBounds = outline.getBoundingClientRect();
        const outlineStyle = getComputedStyle(outline);
        const contentSelector = ${JSON.stringify(stationaryContentSelector ?? null)};
        const content = typeof contentSelector === 'string'
          ? target.querySelector(contentSelector)
          : null;
        const contentBounds = content?.getBoundingClientRect();
        return {
          frame: {
            left: frameBounds.left,
            top: frameBounds.top,
            width: frameBounds.width,
            height: frameBounds.height
          },
          outline: {
            left: outlineBounds.left,
            top: outlineBounds.top,
            width: outlineBounds.width,
            height: outlineBounds.height
          },
          content: contentBounds ? {
            left: contentBounds.left,
            top: contentBounds.top,
            width: contentBounds.width,
            height: contentBounds.height
          } : null,
          outlineColor: outlineStyle.outlineColor,
          outlineStyle: outlineStyle.outlineStyle,
          outlineWidth: outlineStyle.outlineWidth,
          outlineVisible: outlineStyle.display !== 'none',
          resizing: target.dataset.windowResizing === 'true'
        };
      })()`,
      true,
    )) as {
      frame: { left: number; top: number; width: number; height: number };
      outline: { left: number; top: number; width: number; height: number };
      content: { left: number; top: number; width: number; height: number } | null;
      outlineColor: string;
      outlineStyle: string;
      outlineWidth: string;
      outlineVisible: boolean;
      resizing: boolean;
    } | null;
    const expectedWidth = startingGeometry.width + to.x - from.x;
    const expectedHeight = startingGeometry.height + to.y - from.y;
    const contentMoved =
      startingGeometry.content !== null &&
      (preview === null ||
        preview.content === null ||
        Math.abs(preview.content.left - startingGeometry.content.left) > 0.05 ||
        Math.abs(preview.content.top - startingGeometry.content.top) > 0.05 ||
        Math.abs(preview.content.width - startingGeometry.content.width) > 0.05 ||
        Math.abs(preview.content.height - startingGeometry.content.height) > 0.05);
    if (
      !preview ||
      contentMoved ||
      Math.abs(preview.frame.left - startingGeometry.left) > 0.05 ||
      Math.abs(preview.frame.top - startingGeometry.top) > 0.05 ||
      Math.abs(preview.frame.width - startingGeometry.width) > 0.05 ||
      Math.abs(preview.frame.height - startingGeometry.height) > 0.05 ||
      Math.abs(preview.outline.left - (startingGeometry.left - 1)) > 1 ||
      Math.abs(preview.outline.top - (startingGeometry.top - 1)) > 1 ||
      Math.abs(preview.outline.width - expectedWidth) > 1 ||
      Math.abs(preview.outline.height - expectedHeight) > 1 ||
      preview.outlineColor !== 'rgb(255, 255, 255)' ||
      preview.outlineStyle !== 'solid' ||
      preview.outlineWidth !== '1px' ||
      !preview.outlineVisible ||
      !preview.resizing
    ) {
      throw new Error(
        `${windowLabel} did not keep its rendered frame stationary behind the resize outline: ${JSON.stringify({ startingGeometry, preview, expectedWidth, expectedHeight })}.`,
      );
    }
    if (commit) {
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...to,
      });
    } else {
      const canceled = (await window.webContents.executeJavaScript(
        `(() => {
          const target = document.querySelector(${JSON.stringify(windowSelector)});
          const grow = document.querySelector(${JSON.stringify(growSelector)});
          const pointerId = window.__macintoshSmokeSystemResizePointerId;
          const outline = target?.querySelector('.window-drag-shadow');
          if (
            !(target instanceof HTMLElement) ||
            !(grow instanceof HTMLElement) ||
            !(outline instanceof HTMLElement) ||
            typeof pointerId !== 'number'
          ) return null;
          grow.dispatchEvent(new PointerEvent('pointercancel', {
            bubbles: true,
            button: 0,
            buttons: 0,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse'
          }));
          return {
            captureOwned: grow.hasPointerCapture(pointerId),
            outlineVisible: getComputedStyle(outline).display !== 'none',
            resizing: target.dataset.windowResizing === 'true'
          };
        })()`,
        true,
      )) as { captureOwned: boolean; outlineVisible: boolean; resizing: boolean } | null;
      if (!canceled || canceled.captureOwned || canceled.outlineVisible || canceled.resizing) {
        throw new Error(
          `${windowLabel} resize cancellation did not clear immediately: ${JSON.stringify(canceled)}.`,
        );
      }
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...to,
      });
    }
    await pause(60);
    const previewCleared = await window.webContents.executeJavaScript(
      `(() => {
        const target = document.querySelector(${JSON.stringify(windowSelector)});
        const outline = target?.querySelector('.window-drag-shadow');
        return target instanceof HTMLElement &&
          outline instanceof HTMLElement &&
          target.dataset.windowResizing === undefined &&
          getComputedStyle(outline).display === 'none';
      })()`,
      true,
    );
    if (!previewCleared) {
      throw new Error(
        `${windowLabel} resize outline did not clear on ${commit ? 'release' : 'cancellation'}.`,
      );
    }
  };
  const resizeDelta = { x: 24, y: 16 };
  await resizeWindow(
    '[data-finder-window="window-system-disk"]',
    '[data-finder-window="window-system-disk"] [aria-label="Resize System Disk"]',
    'Finder',
    restoredWindow.grow,
    {
      x: restoredWindow.grow.x + resizeDelta.x,
      y: restoredWindow.grow.y + resizeDelta.y,
    },
  );
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
  await resizeWindow(
    '[data-finder-window="window-system-disk"]',
    '[data-finder-window="window-system-disk"] [aria-label="Resize System Disk"]',
    'Finder',
    resizedWindow.grow,
    {
      x: resizedWindow.grow.x - resizeDelta.x,
      y: resizedWindow.grow.y - resizeDelta.y,
    },
  );
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
  await resizeWindow(
    '[data-finder-window="window-system-disk"]',
    '[data-finder-window="window-system-disk"] [aria-label="Resize System Disk"]',
    'Finder canceled',
    resizeRestoredWindow.grow,
    {
      x: resizeRestoredWindow.grow.x + 20,
      y: resizeRestoredWindow.grow.y + 12,
    },
    undefined,
    false,
  );
  const resizeAfterCancellation = await readSystemWindowGeometry();
  if (
    !resizeAfterCancellation ||
    Math.abs(resizeAfterCancellation.width - originalWindow.width) > 1 ||
    Math.abs(resizeAfterCancellation.height - originalWindow.height) > 1
  ) {
    throw new Error('The Finder resize cancellation changed committed window geometry.');
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
  await ensureNativeInputFocus('Calculator move');
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
  type CalculatorDragPreview = {
    windowLeft: number;
    windowTop: number;
    outlineLeft: number;
    outlineTop: number;
    cursor: string;
  };
  let calculatorDragPreview: CalculatorDragPreview | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    calculatorDragPreview = (await window.webContents.executeJavaScript(
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
    )) as CalculatorDragPreview | null;
    if (calculatorDragPreview) break;
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...calculatorDragEnd,
    });
    await pause(20);
  }
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

  await ensureNativeInputFocus('Modal input ownership');
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

  const desktopDocumentSourceRevealed = await window.webContents.executeJavaScript(
    `(() => {
      const folder = document.querySelector(
        '[data-desktop-vfs-item][aria-label="Drop Folder"]'
      );
      if (!(folder instanceof HTMLElement)) return false;
      folder.style.visibility = 'hidden';
      return true;
    })()`,
    true,
  );
  if (!desktopDocumentSourceRevealed) {
    throw new Error(
      'The overlapping Desktop folder could not be hidden for the Write source probe.',
    );
  }
  const desktopDocumentAnimationSource = await readWindowAnimationArtworkSource(
    '[data-desktop-vfs-item][aria-label="Dropped Note.txt"]',
    'The Desktop document animation source',
  );
  const desktopDocumentOpenAnimation = await observeWindowAnimation(
    '[data-write-title="Dropped Note.txt"]',
    'opening',
    () => invokeRendererMenuAction('file', 'open'),
  );
  assertWindowAnimationOutline(
    desktopDocumentOpenAnimation,
    'Desktop File Open Write opening animation',
  );
  assertWindowAnimationSource(
    desktopDocumentOpenAnimation,
    desktopDocumentAnimationSource,
    'Desktop File Open Write opening outline',
  );
  await waitForWindowSettled(
    '[data-write-title="Dropped Note.txt"]',
    'Desktop Write window',
    desktopDocumentOpenAnimation!.windowId,
  );
  await pause(100);
  const desktopDocumentOpened = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Dropped Note.txt"]');
      const editor = write?.querySelector('[data-write-editor="true"]');
      return {
        count: document.querySelectorAll('[data-write-window]').length,
        text: editor?.textContent ?? '',
        format: write?.getAttribute('data-document-format') ?? '',
        hasRuler: write?.querySelector('[aria-label="Paragraph ruler"]') !== null,
        menus: [...document.querySelectorAll('[data-menu]')].map((menu) => menu.getAttribute('data-menu'))
      };
    })()`,
    true,
  )) as { count: number; text: string; format: string; hasRuler: boolean; menus: string[] };
  if (
    desktopDocumentOpened.count !== 1 ||
    !desktopDocumentOpened.text.includes('external Electron drop') ||
    desktopDocumentOpened.format !== 'plain-text' ||
    !desktopDocumentOpened.hasRuler ||
    !['file', 'edit', 'format', 'font', 'size', 'view'].every((menu) =>
      desktopDocumentOpened.menus.includes(menu),
    )
  ) {
    throw new Error(
      `Desktop document did not open in a plain-text Write window: ${JSON.stringify(desktopDocumentOpened)}.`,
    );
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-vfs-item][aria-label="Dropped Note.txt"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
    true,
  );
  await pause(60);
  const duplicateWriteCount = (await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-write-title="Dropped Note.txt"]').length`,
    true,
  )) as number;
  if (duplicateWriteCount !== 1) {
    throw new Error('Reopening a saved document created a duplicate Write window.');
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Dropped Note.txt"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu="format"]')?.click()`,
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu-action="bold"]')?.click()`,
    true,
  );
  await pause(60);
  const richDesktopDocument = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Dropped Note.txt"]');
      return {
        format: write?.getAttribute('data-document-format'),
        bold: write?.querySelector('strong') !== null,
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true
      };
    })()`,
    true,
  )) as { format: string | null; bold: boolean; dirty: boolean };
  if (
    richDesktopDocument.format !== 'write-v1' ||
    !richDesktopDocument.bold ||
    !richDesktopDocument.dirty
  ) {
    throw new Error(
      `A rich action did not promote the plain document in place: ${JSON.stringify(richDesktopDocument)}.`,
    );
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['meta'] });
  await pause(100);
  const desktopDocumentSaved = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Dropped Note.txt"] h2')?.textContent?.includes('•') === false`,
    true,
  );
  if (!desktopDocumentSaved) throw new Error('Write did not explicitly save the rich document.');
  const heldDesktopDocumentClose = await observeWindowAnimation(
    '[data-write-title="Dropped Note.txt"]',
    'closing',
    () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
    },
    true,
  );
  assertWindowAnimationOutline(heldDesktopDocumentClose, 'Held Write closing animation');
  assertWindowAnimationSource(
    heldDesktopDocumentClose,
    desktopDocumentAnimationSource,
    'Held Write closing outline',
  );
  await assertHeldCloseReopened(
    '[data-write-title="Dropped Note.txt"]',
    'Dropped Note Write window',
    heldDesktopDocumentClose!,
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[data-desktop-vfs-item][aria-label="Dropped Note.txt"]')
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  await pause(60);
  const desktopDocumentClosed = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Dropped Note.txt"]') === null`,
    true,
  );
  if (!desktopDocumentClosed) throw new Error('A clean Write window did not close.');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-desktop-vfs-item][aria-label="Drop Folder"]')
      ?.style.removeProperty('visibility')`,
    true,
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

  const desktopFolderAnimationSource = await readWindowAnimationArtworkSource(
    '[data-desktop-vfs-item][aria-label="Drop Folder"]',
    'The Desktop folder animation source',
  );
  const desktopFolderOpenAnimation = await observeWindowAnimation(
    '[aria-label="Drop Folder window"]',
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
    desktopFolderOpenAnimation.shadowAnimationName !== 'finder-window-open'
  ) {
    throw new Error(
      `Desktop folder opening outline did not begin at its icon: ${JSON.stringify(desktopFolderOpenAnimation)}.`,
    );
  }
  assertWindowAnimationOutline(desktopFolderOpenAnimation, 'Desktop folder opening animation');
  assertWindowAnimationSource(
    desktopFolderOpenAnimation,
    desktopFolderAnimationSource,
    'Desktop folder opening outline',
  );
  await waitForWindowSettled(
    '[aria-label="Drop Folder window"]',
    'Drop Folder window',
    desktopFolderOpenAnimation.windowId,
  );
  const desktopFolderOpened = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Drop Folder window"] [data-vfs-item]')
      ?.textContent?.includes('Nested Note.txt') === true`,
    true,
  );
  if (!desktopFolderOpened)
    throw new Error('The imported Desktop folder did not open its hierarchy.');
  const heldDesktopFolderClose = await observeWindowAnimation(
    '[aria-label="Drop Folder window"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Drop Folder"]')?.click()`,
        true,
      ),
    true,
  );
  assertWindowAnimationOutline(heldDesktopFolderClose, 'Held Finder closing animation');
  assertWindowAnimationSource(
    heldDesktopFolderClose,
    desktopFolderAnimationSource,
    'Held Finder closing outline',
  );
  await assertHeldCloseReopened(
    '[aria-label="Drop Folder window"]',
    'Drop Folder window',
    heldDesktopFolderClose!,
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[data-desktop-vfs-item][aria-label="Drop Folder"]')
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  const desktopFolderCloseAnimation = await observeWindowAnimation(
    '[aria-label="Drop Folder window"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Drop Folder"]')?.click()`,
        true,
      ),
  );
  if (
    desktopFolderCloseAnimation?.phase !== 'closing' ||
    desktopFolderCloseAnimation.shadowAnimationName !== 'finder-window-close'
  ) {
    throw new Error(
      `Desktop folder closing outline did not finish at its icon: ${JSON.stringify(desktopFolderCloseAnimation)}.`,
    );
  }
  assertWindowAnimationOutline(desktopFolderCloseAnimation, 'Desktop folder closing animation');
  assertWindowAnimationSource(
    desktopFolderCloseAnimation,
    desktopFolderAnimationSource,
    'Desktop folder closing outline',
  );
  await waitForWindowAbsence(
    '[aria-label="Drop Folder window"]',
    'Drop Folder window',
    desktopFolderCloseAnimation.windowId,
  );

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
  await ensureNativeInputFocus('Desktop document drop-block drag');
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
      const artwork = source?.querySelector('[data-icon-hit-region="artwork"]');
      const canvas = document.querySelector('[data-icon-layout-parent="system-disk"]');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(artwork instanceof HTMLElement) || !(canvas instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const sourceRect = source.getBoundingClientRect();
      const artworkRect = artwork.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const hotspot = {
        x: Math.round(artworkRect.left + artworkRect.width / 2 - sourceRect.left),
        y: Math.round(artworkRect.top + artworkRect.height / 2 - sourceRect.top)
      };
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
  await ensureNativeInputFocus('Free Finder placement drag');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...freeIconCoordinates.source });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    ...freeIconCoordinates.source,
  });
  await pause(30);
  for (const offset of [2, 5, 8]) {
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
  const nameViewApplicationsSelector =
    '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]';
  const nameViewApplicationsSource = await readWindowAnimationArtworkSource(
    nameViewApplicationsSelector,
    'The Finder name-view Applications animation source',
  );
  const nameViewApplicationsOpenAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(nameViewApplicationsSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    nameViewApplicationsOpenAnimation,
    'Finder name-view opening animation',
  );
  assertWindowAnimationSource(
    nameViewApplicationsOpenAnimation,
    nameViewApplicationsSource,
    'Finder name-view opening outline',
  );
  await waitForWindowSettled(
    '[data-finder-window="window-applications"]',
    'Applications name-view source window',
    nameViewApplicationsOpenAnimation!.windowId,
  );
  const visibleNameViewCloseSource = await findWindowAnimationArtworkSource(
    nameViewApplicationsSelector,
  );
  const nameViewApplicationsCloseAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Applications"]')?.click()`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    nameViewApplicationsCloseAnimation,
    'Finder name-view closing animation',
  );
  if (visibleNameViewCloseSource) {
    assertWindowAnimationSource(
      nameViewApplicationsCloseAnimation,
      visibleNameViewCloseSource,
      'Finder name-view closing outline',
    );
  } else {
    assertWindowAnimationCenteredFallback(
      nameViewApplicationsCloseAnimation,
      'Finder name-view occluded-source closing outline',
    );
  }
  await waitForWindowAbsence(
    '[data-finder-window="window-applications"]',
    'Applications name-view source window',
    nameViewApplicationsCloseAnimation!.windowId,
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
      const artwork = source?.querySelector('[data-icon-hit-region="artwork"]');
      const surface = document.querySelector('.desktop-surface');
      const root = document.querySelector('[data-vfs-count]');
      if (!(source instanceof HTMLElement) || !(artwork instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
      const sourceBounds = source.getBoundingClientRect();
      const artworkBounds = artwork.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      const hotspot = {
        x: Math.round(artworkBounds.left + artworkBounds.width / 2 - sourceBounds.left),
        y: Math.round(artworkBounds.top + artworkBounds.height / 2 - sourceBounds.top)
      };
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
  await ensureNativeInputFocus('Finder-to-Desktop drag');
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
  await ensureNativeInputFocus('Desktop reposition drag');
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
  await ensureNativeInputFocus('Internal folder drag');
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

  const finderIconApplicationsSelector =
    '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]';
  const finderIconApplicationsSource = await readWindowAnimationArtworkSource(
    finderIconApplicationsSelector,
    'The Finder icon-view Applications animation source',
  );
  const finderIconApplicationsOpenAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(finderIconApplicationsSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    finderIconApplicationsOpenAnimation,
    'Finder icon-view opening animation',
  );
  assertWindowAnimationSource(
    finderIconApplicationsOpenAnimation,
    finderIconApplicationsSource,
    'Finder icon-view opening outline',
  );
  await waitForWindowSettled(
    '[data-finder-window="window-applications"]',
    'Applications icon-view source window',
    finderIconApplicationsOpenAnimation!.windowId,
  );

  const clippedIconViewClosePrepared = await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(${JSON.stringify(finderIconApplicationsSelector)});
      const artwork = source?.querySelector(
        '.pixel-icon[data-pixel-icon-variant="artwork"]'
      );
      const grid = source?.closest('.finder-icon-grid');
      const content = source?.closest('.window-content');
      const applicationsWindow = document.querySelector(
        '[data-finder-window="window-applications"]'
      );
      if (
        !(source instanceof HTMLElement) ||
        !(artwork instanceof SVGElement) ||
        !(grid instanceof HTMLElement) ||
        !(content instanceof HTMLElement) ||
        !(applicationsWindow instanceof HTMLElement)
      ) return false;
      const artworkBounds = artwork.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      const clipTop = contentBounds.top + content.clientTop;
      const shift = Math.round(clipTop - artworkBounds.top - artworkBounds.height / 4);
      grid.dataset.smokeOriginalTransform = grid.style.transform;
      grid.style.transform = 'translateY(' + shift + 'px)';
      applicationsWindow.style.visibility = 'hidden';
      const clippedBounds = artwork.getBoundingClientRect();
      const centerX = clippedBounds.left + clippedBounds.width / 2;
      const centerY = clippedBounds.top + clippedBounds.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      return (
        clippedBounds.top < clipTop &&
        clippedBounds.bottom > clipTop &&
        centerY > clipTop &&
        source.contains(hit)
      );
    })()`,
    true,
  );
  if (!clippedIconViewClosePrepared) {
    throw new Error('Finder icon-view artwork could not be partially clipped for the close probe.');
  }
  const clippedIconViewCloseAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `(() => {
          const applicationsWindow = document.querySelector(
            '[data-finder-window="window-applications"]'
          );
          document.querySelector('[aria-label="Close Applications"]')?.click();
          if (applicationsWindow instanceof HTMLElement) {
            applicationsWindow.style.removeProperty('visibility');
          }
        })()`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    clippedIconViewCloseAnimation,
    'Finder clipped icon-view closing animation',
  );
  assertWindowAnimationCenteredFallback(
    clippedIconViewCloseAnimation,
    'Finder clipped icon-view closing outline',
  );
  await waitForWindowAbsence(
    '[data-finder-window="window-applications"]',
    'Applications clipped icon-view source window',
    clippedIconViewCloseAnimation!.windowId,
  );
  const clippedIconViewSourceRestored = await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(${JSON.stringify(finderIconApplicationsSelector)});
      const grid = source?.closest('.finder-icon-grid');
      if (!(grid instanceof HTMLElement)) return false;
      grid.style.transform = grid.dataset.smokeOriginalTransform ?? '';
      delete grid.dataset.smokeOriginalTransform;
      return true;
    })()`,
    true,
  );
  if (!clippedIconViewSourceRestored) {
    throw new Error('Finder icon-view artwork could not be restored after the close probe.');
  }
  const restoredFinderIconApplicationsSource = await readWindowAnimationArtworkSource(
    finderIconApplicationsSelector,
    'The restored Finder icon-view Applications animation source',
  );
  const finderIconApplicationsReopenAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(finderIconApplicationsSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    finderIconApplicationsReopenAnimation,
    'Finder restored icon-view opening animation',
  );
  assertWindowAnimationSource(
    finderIconApplicationsReopenAnimation,
    restoredFinderIconApplicationsSource,
    'Finder restored icon-view opening outline',
  );
  await waitForWindowSettled(
    '[data-finder-window="window-applications"]',
    'Restored Applications icon-view source window',
    finderIconApplicationsReopenAnimation!.windowId,
  );

  const visibleIconViewClosePrepared = await window.webContents.executeJavaScript(
    `(() => {
      const source = document.querySelector(${JSON.stringify(finderIconApplicationsSelector)});
      const artwork = source?.querySelector(
        '.pixel-icon[data-pixel-icon-variant="artwork"]'
      );
      const applicationsWindow = document.querySelector(
        '[data-finder-window="window-applications"]'
      );
      const handle = applicationsWindow?.querySelector('[data-window-drag-handle="true"]');
      if (
        !(artwork instanceof SVGElement) ||
        !(applicationsWindow instanceof HTMLElement) ||
        !(handle instanceof HTMLElement)
      ) return false;
      const artworkBounds = artwork.getBoundingClientRect();
      const windowBounds = applicationsWindow.getBoundingClientRect();
      if (windowBounds.right <= artworkBounds.left || windowBounds.left >= artworkBounds.right) {
        return true;
      }
      let captured = false;
      handle.setPointerCapture = () => { captured = true; };
      handle.hasPointerCapture = () => captured;
      handle.releasePointerCapture = () => { captured = false; };
      const pointerId = 904;
      const startX = Math.round(windowBounds.left + windowBounds.width / 2);
      const startY = Math.round(handle.getBoundingClientRect().top + handle.offsetHeight / 2);
      const deltaX = Math.ceil(artworkBounds.right + 12 - windowBounds.left);
      const dispatch = (type, x, buttons) =>
        handle.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons,
          clientX: x,
          clientY: startY,
          isPrimary: true,
          pointerId,
          pointerType: 'mouse'
        }));
      dispatch('pointerdown', startX, 1);
      dispatch('pointermove', startX + deltaX, 1);
      dispatch('pointerup', startX + deltaX, 0);
      return true;
    })()`,
    true,
  );
  if (!visibleIconViewClosePrepared) {
    throw new Error('Applications could not be moved away from its icon-view close source.');
  }
  await pause(60);
  const visibleFinderIconApplicationsCloseSource = await readWindowAnimationArtworkSource(
    finderIconApplicationsSelector,
    'The visible Finder icon-view Applications closing source',
  );
  const finderIconApplicationsCloseAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Close Applications"]')?.click()`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    finderIconApplicationsCloseAnimation,
    'Finder visible icon-view closing animation',
  );
  assertWindowAnimationSource(
    finderIconApplicationsCloseAnimation,
    visibleFinderIconApplicationsCloseSource,
    'Finder visible icon-view closing outline',
  );
  await waitForWindowAbsence(
    '[data-finder-window="window-applications"]',
    'Applications visible icon-view source window',
    finderIconApplicationsCloseAnimation!.windowId,
  );

  const finderIconApplicationsFinalOpenAnimation = await observeWindowAnimation(
    '[data-finder-window="window-applications"]',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(finderIconApplicationsSelector)})
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertWindowAnimationOutline(
    finderIconApplicationsFinalOpenAnimation,
    'Finder final icon-view opening animation',
  );
  assertWindowAnimationSource(
    finderIconApplicationsFinalOpenAnimation,
    restoredFinderIconApplicationsSource,
    'Finder final icon-view opening outline',
  );
  await waitForWindowSettled(
    '[data-finder-window="window-applications"]',
    'Final Applications icon-view source window',
    finderIconApplicationsFinalOpenAnimation!.windowId,
  );

  const writeApplicationSource = await readWindowAnimationArtworkSource(
    '[data-finder-window="window-applications"] [data-vfs-item="write"]',
    'The Write application animation source',
  );
  const writeApplicationOpenAnimation = await observeWindowAnimation(
    '[data-write-title="Untitled"]',
    'opening',
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector(
          '[data-finder-window="window-applications"] [data-vfs-item="write"]'
        )?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))`,
        true,
      ),
  );
  assertWindowAnimationOutline(writeApplicationOpenAnimation, 'Write opening animation');
  assertWindowAnimationSource(
    writeApplicationOpenAnimation,
    writeApplicationSource,
    'Write opening outline',
  );
  await waitForWindowSettled(
    '[data-write-title="Untitled"]',
    'Untitled Write window',
    writeApplicationOpenAnimation!.windowId,
  );
  const untitledWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        count: document.querySelectorAll('[data-write-window]').length,
        format: write?.getAttribute('data-document-format'),
        documentId: write?.getAttribute('data-document-id'),
        pageCount: write?.querySelector('[data-page-count]')?.getAttribute('data-page-count'),
        ruler: write?.querySelector('[aria-label="Paragraph ruler"]') !== null
      };
    })()`,
    true,
  )) as {
    count: number;
    format: string | null;
    documentId: string | null;
    pageCount: string | null;
    ruler: boolean;
  };
  if (
    untitledWrite.count !== 1 ||
    untitledWrite.format !== 'plain-text' ||
    untitledWrite.documentId !== '' ||
    untitledWrite.pageCount !== '1' ||
    !untitledWrite.ruler
  ) {
    throw new Error(
      `Write did not open a transient plain document: ${JSON.stringify(untitledWrite)}.`,
    );
  }

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.insertText('Automatic pagination '.repeat(900));
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write automatic pagination');
  const automaticPagination = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        pageCount: Number(write?.querySelector('[data-page-count]')?.getAttribute('data-page-count')),
        gaps: write?.querySelectorAll('.write-automatic-page-gap').length ?? 0
      };
    })()`,
    true,
  )) as { pageCount: number; gaps: number };
  if (automaticPagination.pageCount < 2 || automaticPagination.gaps < 1) {
    throw new Error(
      `Write did not project a long paragraph across automatic pages: ${JSON.stringify(automaticPagination)}.`,
    );
  }

  type ClassicScrollFrameSnapshot = {
    directions: string[];
    grow: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    horizontal: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    nativeScrollbarWidth: string;
    page: { left: number; width: number } | null;
    ruler: { left: number; width: number } | null;
    rulerScrollLeft: number | null;
    rulerViewport: { right: number } | null;
    rulerGutter: { left: number; width: number } | null;
    status: { top: number } | null;
    thumbs: number;
    tracks: number;
    vertical: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    viewport: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      clientWidth: number;
      clientHeight: number;
      scrollWidth: number;
      scrollHeight: number;
      scrollLeft: number;
      scrollTop: number;
    };
  };
  const readClassicScrollFrame = async (
    ownerSelector: string,
    viewportSelector: string,
  ): Promise<ClassicScrollFrameSnapshot | null> =>
    window.webContents.executeJavaScript(
      `(() => {
        const owner = document.querySelector(${JSON.stringify(ownerSelector)});
        const viewport = owner?.querySelector(${JSON.stringify(viewportSelector)});
        const vertical = owner?.querySelector('.scrollbar-vertical');
        const horizontal = owner?.querySelector('.scrollbar-horizontal');
        const grow = owner?.querySelector('.window-grow-box');
        if (
          !(owner instanceof HTMLElement) ||
          !(viewport instanceof HTMLElement) ||
          !(vertical instanceof HTMLElement) ||
          !(horizontal instanceof HTMLElement) ||
          !(grow instanceof HTMLElement)
        ) return null;
        const bounds = (element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            width: box.width,
            height: box.height
          };
        };
        const page = owner.querySelector('.write-page-stack');
        const ruler = owner.querySelector('.write-ruler-viewport');
        const rulerViewport = owner.querySelector('.write-ruler-scroll-viewport');
        const rulerGutter = owner.querySelector('.write-ruler-scroll-gutter');
        const status = owner.querySelector('.write-status-bar');
        return {
          directions: [...owner.querySelectorAll('[data-scroll-direction]')]
            .map((control) => control.getAttribute('data-scroll-direction') ?? '')
            .sort(),
          grow: bounds(grow),
          horizontal: bounds(horizontal),
          nativeScrollbarWidth: getComputedStyle(viewport).scrollbarWidth,
          page: page instanceof HTMLElement
            ? { left: page.getBoundingClientRect().left, width: page.getBoundingClientRect().width }
            : null,
          ruler: ruler instanceof HTMLElement
            ? { left: ruler.getBoundingClientRect().left, width: ruler.getBoundingClientRect().width }
            : null,
          rulerScrollLeft: rulerViewport instanceof HTMLElement ? rulerViewport.scrollLeft : null,
          rulerViewport: rulerViewport instanceof HTMLElement
            ? { right: rulerViewport.getBoundingClientRect().right }
            : null,
          rulerGutter: rulerGutter instanceof HTMLElement
            ? { left: rulerGutter.getBoundingClientRect().left, width: rulerGutter.getBoundingClientRect().width }
            : null,
          status: status instanceof HTMLElement ? { top: status.getBoundingClientRect().top } : null,
          thumbs: owner.querySelectorAll('.scroll-thumb').length,
          tracks: owner.querySelectorAll('.scroll-track').length,
          vertical: bounds(vertical),
          viewport: {
            ...bounds(viewport),
            clientWidth: viewport.clientWidth,
            clientHeight: viewport.clientHeight,
            scrollWidth: viewport.scrollWidth,
            scrollHeight: viewport.scrollHeight,
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop
          }
        };
      })()`,
      true,
    ) as Promise<ClassicScrollFrameSnapshot | null>;
  const assertClassicScrollFrame: (
    snapshot: ClassicScrollFrameSnapshot | null,
    label: string,
  ) => asserts snapshot is ClassicScrollFrameSnapshot = (snapshot, label) => {
    if (
      !snapshot ||
      snapshot.nativeScrollbarWidth !== 'none' ||
      snapshot.directions.join(',') !== 'down,left,right,up' ||
      snapshot.tracks !== 2 ||
      snapshot.thumbs !== 2 ||
      Math.abs(snapshot.vertical.width - 15) > 0.1 ||
      Math.abs(snapshot.horizontal.height - 15) > 0.1 ||
      Math.abs(snapshot.grow.width - 15) > 0.1 ||
      Math.abs(snapshot.grow.height - 15) > 0.1 ||
      Math.abs(snapshot.viewport.right - snapshot.vertical.left) > 0.1 ||
      Math.abs(snapshot.viewport.bottom - snapshot.horizontal.top) > 0.1 ||
      Math.abs(snapshot.horizontal.right - snapshot.grow.left) > 0.1 ||
      Math.abs(snapshot.vertical.bottom - snapshot.grow.top) > 0.1
    ) {
      throw new Error(
        `${label} did not retain the shared classic scroll frame: ${JSON.stringify(snapshot)}.`,
      );
    }
  };
  const assertWriteRulerAlignment = (
    snapshot: ClassicScrollFrameSnapshot,
    zoom: 50 | 75 | 100,
    label: string,
  ): void => {
    const expectedRulerOffset = 72 * (zoom / 100);
    const expectedRulerWidth = 468 * (zoom / 100);
    if (
      !snapshot.page ||
      !snapshot.ruler ||
      !snapshot.rulerViewport ||
      !snapshot.rulerGutter ||
      !snapshot.status ||
      snapshot.rulerScrollLeft === null ||
      Math.abs(snapshot.ruler.left - snapshot.page.left - expectedRulerOffset) > 1 ||
      Math.abs(snapshot.ruler.width - expectedRulerWidth) > 1 ||
      Math.abs(snapshot.rulerScrollLeft - snapshot.viewport.scrollLeft) > 0.1 ||
      Math.abs(snapshot.rulerViewport.right - snapshot.viewport.right) > 0.1 ||
      Math.abs(snapshot.rulerGutter.left - snapshot.vertical.left) > 0.1 ||
      Math.abs(snapshot.rulerGutter.width - 15) > 0.1 ||
      Math.abs(snapshot.horizontal.bottom - snapshot.status.top) > 0.1
    ) {
      throw new Error(
        `${label} lost page, ruler, status, or grow-box alignment: ${JSON.stringify(snapshot)}.`,
      );
    }
  };

  const finderScrollFrame = await readClassicScrollFrame(
    '[data-finder-window="window-system-disk"]',
    '.window-content',
  );
  assertClassicScrollFrame(finderScrollFrame, 'Finder');
  const standardWriteScrollFrame = await readClassicScrollFrame(
    '[data-write-title="Untitled"]',
    '.write-document-viewport',
  );
  assertClassicScrollFrame(standardWriteScrollFrame, 'Write at its standard size');
  assertWriteRulerAlignment(standardWriteScrollFrame, 75, 'Write at its standard size');
  if (
    standardWriteScrollFrame.viewport.scrollHeight <= standardWriteScrollFrame.viewport.clientHeight
  ) {
    throw new Error('The standard Write scroll probe did not contain vertical overflow.');
  }

  type WriteScrollInvariant = {
    format: string | null;
    html: string;
    layoutGeneration: string | null;
    pageCount: string | null;
    selection: string;
    title: string;
  };
  const readWriteScrollInvariant = async (): Promise<WriteScrollInvariant> =>
    window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Untitled"]');
        const editor = write?.querySelector('[data-write-editor="true"]');
        const pages = write?.querySelector('.write-page-stack');
        if (!(write instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
        return {
          format: write.getAttribute('data-document-format'),
          html: editor.innerHTML,
          layoutGeneration: pages?.getAttribute('data-write-layout-generation') ?? null,
          pageCount: pages?.getAttribute('data-page-count') ?? null,
          selection: window.getSelection()?.toString() ?? '',
          title: write.querySelector('.window-titlebar h2')?.textContent ?? ''
        };
      })()`,
      true,
    ) as Promise<WriteScrollInvariant>;
  const writeScrollControl = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      const viewport = write?.querySelector('.write-document-viewport');
      const editor = write?.querySelector('[data-write-editor="true"]');
      const down = write?.querySelector('[data-scroll-direction="down"]');
      if (
        !(viewport instanceof HTMLElement) ||
        !(editor instanceof HTMLElement) ||
        !(down instanceof HTMLElement)
      ) return null;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const firstText = walker.nextNode();
      if (!firstText || (firstText.textContent?.length ?? 0) < 9) return null;
      const range = document.createRange();
      range.setStart(firstText, 0);
      range.setEnd(firstText, 9);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      viewport.scrollTo({ left: 0, top: 0 });
      const downBounds = down.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      return {
        down: {
          x: Math.round(downBounds.left + downBounds.width / 2),
          y: Math.round(downBounds.top + downBounds.height / 2)
        },
        viewport: {
          x: Math.round(viewportBounds.left + viewportBounds.width / 2),
          y: Math.round(viewportBounds.top + viewportBounds.height / 2)
        }
      };
    })()`,
    true,
  )) as { down: SmokePoint; viewport: SmokePoint } | null;
  if (!writeScrollControl) throw new Error('Write could not prepare its classic scroll probe.');
  await pause(40);
  const writeScrollBaseline = await readWriteScrollInvariant();
  await clickAt(writeScrollControl.down);
  const afterWriteArrow = await readClassicScrollFrame(
    '[data-write-title="Untitled"]',
    '.write-document-viewport',
  );
  const afterWriteArrowInvariant = await readWriteScrollInvariant();
  if (
    !afterWriteArrow ||
    afterWriteArrow.viewport.scrollTop < 63 ||
    JSON.stringify(afterWriteArrowInvariant) !== JSON.stringify(writeScrollBaseline)
  ) {
    throw new Error(
      `Write's classic arrow changed editor state or failed to scroll its own viewport: ${JSON.stringify({ afterWriteArrow, writeScrollBaseline, afterWriteArrowInvariant })}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] .write-document-viewport')?.scrollTo({ left: 0, top: 0 })`,
    true,
  );
  await ensureNativeInputFocus('Write wheel scrolling');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...writeScrollControl.viewport });
  let wheelScrollTop = 0;
  for (const deltaY of [-120, 120]) {
    window.webContents.sendInputEvent({
      type: 'mouseWheel',
      deltaX: 0,
      deltaY,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
      ...writeScrollControl.viewport,
    });
    await pause(80);
    wheelScrollTop = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Untitled"] .write-document-viewport')?.scrollTop ?? 0`,
      true,
    )) as number;
    if (wheelScrollTop > 0) break;
  }
  const afterWriteWheelInvariant = await readWriteScrollInvariant();
  if (
    wheelScrollTop <= 0 ||
    JSON.stringify(afterWriteWheelInvariant) !== JSON.stringify(writeScrollBaseline)
  ) {
    throw new Error(
      `Native wheel scrolling changed Write editor state or failed to move its viewport: ${JSON.stringify({ wheelScrollTop, writeScrollBaseline, afterWriteWheelInvariant })}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] .write-document-viewport')?.scrollTo({ left: 0, top: 0 })`,
    true,
  );

  const readWriteResizeGeometry = async (): Promise<{
    width: number;
    height: number;
    grow: SmokePoint;
  } | null> =>
    window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Untitled"]');
        const grow = write?.querySelector('[aria-label="Resize Untitled"]');
        if (!(write instanceof HTMLElement) || !(grow instanceof HTMLElement)) return null;
        const frameBounds = write.getBoundingClientRect();
        const growBounds = grow.getBoundingClientRect();
        return {
          width: frameBounds.width,
          height: frameBounds.height,
          grow: {
            x: Math.round(growBounds.left + growBounds.width / 2),
            y: Math.round(growBounds.top + growBounds.height / 2)
          }
        };
      })()`,
      true,
    ) as Promise<{ width: number; height: number; grow: SmokePoint } | null>;
  const writeResizeStart = await readWriteResizeGeometry();
  if (!writeResizeStart) throw new Error('The multi-page Write grow box was unavailable.');
  const writeResizeDelta = {
    x: 520 - writeResizeStart.width,
    y: 360 - writeResizeStart.height,
  };
  await resizeWindow(
    '[data-write-title="Untitled"]',
    '[data-write-title="Untitled"] [aria-label="Resize Untitled"]',
    'Write',
    writeResizeStart.grow,
    {
      x: writeResizeStart.grow.x + writeResizeDelta.x,
      y: writeResizeStart.grow.y + writeResizeDelta.y,
    },
    '.write-document-viewport',
  );
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write resize layout');
  const writeResized = await readWriteResizeGeometry();
  if (
    !writeResized ||
    Math.abs(writeResized.width - 520) > 1 ||
    Math.abs(writeResized.height - 360) > 1
  ) {
    throw new Error(
      `Write did not commit its outline resize once on release: ${JSON.stringify({ writeResizeStart, writeResized })}.`,
    );
  }
  for (const zoom of [50, 75, 100] as const) {
    await invokeRendererMenuAction('view', `zoom-${String(zoom)}`);
    await waitForWriteLayout(
      '[data-write-title="Untitled"]',
      `Minimum-size Write ${String(zoom)}% scroll layout`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Untitled"] .write-document-viewport')?.scrollTo({ left: 0, top: 0 })`,
      true,
    );
    await pause(30);
    const minimumScrollFrame = await readClassicScrollFrame(
      '[data-write-title="Untitled"]',
      '.write-document-viewport',
    );
    assertClassicScrollFrame(minimumScrollFrame, `Minimum-size Write at ${String(zoom)}%`);
    assertWriteRulerAlignment(minimumScrollFrame, zoom, `Minimum-size Write at ${String(zoom)}%`);
    const horizontalOverflow =
      minimumScrollFrame.viewport.scrollWidth - minimumScrollFrame.viewport.clientWidth;
    if (
      minimumScrollFrame.viewport.scrollHeight <= minimumScrollFrame.viewport.clientHeight ||
      (zoom === 100 ? horizontalOverflow <= 0 : horizontalOverflow > 1)
    ) {
      throw new Error(
        `Minimum-size Write handled ${String(zoom)}% overflow incorrectly: ${JSON.stringify(minimumScrollFrame)}.`,
      );
    }
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Untitled"] [data-scroll-direction="down"]')?.click()`,
      true,
    );
    await pause(30);
    const verticalScrollTop = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Untitled"] .write-document-viewport')?.scrollTop ?? 0`,
      true,
    )) as number;
    if (verticalScrollTop < 63) {
      throw new Error(`Minimum-size Write ${String(zoom)}% vertical arrow did not scroll.`);
    }
    if (zoom === 100) {
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-write-title="Untitled"] [data-scroll-direction="right"]')?.click()`,
        true,
      );
      await pause(30);
      const horizontallyScrolled = await readClassicScrollFrame(
        '[data-write-title="Untitled"]',
        '.write-document-viewport',
      );
      assertClassicScrollFrame(horizontallyScrolled, 'Horizontally scrolled minimum-size Write');
      assertWriteRulerAlignment(
        horizontallyScrolled,
        100,
        'Horizontally scrolled minimum-size Write',
      );
      if (horizontallyScrolled.viewport.scrollLeft < 63) {
        throw new Error('Minimum-size Write 100% horizontal arrow did not scroll.');
      }
    }
  }
  await invokeRendererMenuAction('view', 'zoom-75');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write scroll zoom restoration');
  await resizeWindow(
    '[data-write-title="Untitled"]',
    '[data-write-title="Untitled"] [aria-label="Resize Untitled"]',
    'Write',
    writeResized.grow,
    {
      x: writeResized.grow.x - writeResizeDelta.x,
      y: writeResized.grow.y - writeResizeDelta.y,
    },
    '.write-document-viewport',
  );
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write restored resize layout');
  const writeResizeRestored = await readWriteResizeGeometry();
  if (
    !writeResizeRestored ||
    Math.abs(writeResizeRestored.width - writeResizeStart.width) > 1 ||
    Math.abs(writeResizeRestored.height - writeResizeStart.height) > 1
  ) {
    throw new Error(
      `Write did not restore its original geometry after the outline resize probe: ${JSON.stringify({ writeResizeStart, writeResizeRestored })}.`,
    );
  }
  await invokeRendererMenuAction('edit', 'select-all');
  window.webContents.insertText('Write smoke document');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write automatic backflow');
  const automaticBackflow = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        pageCount: Number(write?.querySelector('[data-page-count]')?.getAttribute('data-page-count')),
        gaps: write?.querySelectorAll('.write-automatic-page-gap').length ?? 0
      };
    })()`,
    true,
  )) as { pageCount: number; gaps: number };
  if (automaticBackflow.pageCount !== 1 || automaticBackflow.gaps !== 0) {
    throw new Error(
      `Write did not backflow to one page after shortening the paragraph: ${JSON.stringify(automaticBackflow)}.`,
    );
  }

  const ordinaryEditingStayedPlain = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"]')?.getAttribute('data-document-format') === 'plain-text'`,
    true,
  );
  if (!ordinaryEditingStayedPlain) {
    throw new Error('Ordinary Write typing promoted the document before a rich action.');
  }
  const plainClipboardBaseline = 'Write smoke document';
  // Keep each Clipboard mutation in its own ProseMirror history group.
  await pause(600);
  clipboard.writeText(' plain Clipboard text');
  await invokeRendererMenuAction('edit', 'paste');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write plain Clipboard paste');
  const plainClipboardPaste = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        format: write?.getAttribute('data-document-format'),
        text: write?.querySelector('[data-write-editor="true"]')?.textContent ?? ''
      };
    })()`,
    true,
  )) as { format: string | null; text: string };
  if (
    plainClipboardPaste.format !== 'plain-text' ||
    plainClipboardPaste.text !== `${plainClipboardBaseline} plain Clipboard text`
  ) {
    throw new Error(
      `Plain-to-plain Write paste unexpectedly promoted or changed content: ${JSON.stringify(plainClipboardPaste)}.`,
    );
  }
  await invokeRendererMenuAction('edit', 'undo');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write plain Clipboard Undo');
  const plainClipboardUndoText = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Untitled"] [data-write-editor="true"]'
    )?.textContent ?? ''`,
    true,
  )) as string;
  if (plainClipboardUndoText !== plainClipboardBaseline) {
    throw new Error('Undo did not exactly restore the plain document after Clipboard paste.');
  }

  const filePasteOwnership = (await window.webContents.executeJavaScript(
    `(() => {
      const root = document.querySelector('[data-vfs-count]');
      const editor = document.querySelector(
        '[data-write-title="Untitled"] [data-write-editor="true"]'
      );
      if (!(root instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not imported'], 'write-paste.txt', { type: 'text/plain' }));
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true
      });
      const beforeText = editor.textContent ?? '';
      const beforeCount = Number(root.dataset.vfsCount ?? '0');
      editor.dispatchEvent(event);
      return {
        prevented: event.defaultPrevented,
        beforeText,
        afterText: editor.textContent ?? '',
        beforeCount
      };
    })()`,
    true,
  )) as {
    prevented: boolean;
    beforeText: string;
    afterText: string;
    beforeCount: number;
  } | null;
  await pause(80);
  const filePasteVfsCount = (await window.webContents.executeJavaScript(
    `Number(document.querySelector('[data-vfs-count]')?.getAttribute('data-vfs-count') ?? '0')`,
    true,
  )) as number;
  if (
    !filePasteOwnership?.prevented ||
    filePasteOwnership.beforeText !== plainClipboardBaseline ||
    filePasteOwnership.afterText !== plainClipboardBaseline ||
    filePasteVfsCount !== filePasteOwnership.beforeCount
  ) {
    throw new Error(
      `A file paste owned by Write fell through or changed the editor: ${JSON.stringify({ filePasteOwnership, filePasteVfsCount })}.`,
    );
  }

  await pause(600);
  clipboard.write({
    text: 'Allowed bold linked italic underlined styled supported font unsupported font',
    html: '<p style="color:red;background:blue;font-family:Comic Sans MS"><strong>Allowed bold</strong> <a href="https://example.com"><em>linked italic</em></a> <u>underlined</u> <span style="color:green">styled</span> <span style="font-family:Helvetica;font-size:14px">supported font</span> <span style="font-family:Papyrus;font-size:13px">unsupported font</span><img src="https://example.com/pixel.png"><script>evil script</script></p>',
  });
  await invokeRendererMenuAction('edit', 'paste');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write hostile rich Clipboard paste');
  const sanitizedRichPaste = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      const editor = write?.querySelector('[data-write-editor="true"]');
      return {
        format: write?.getAttribute('data-document-format'),
        text: editor?.textContent ?? '',
        bold: [...(editor?.querySelectorAll('strong') ?? [])]
          .some((node) => node.textContent === 'Allowed bold'),
        italic: [...(editor?.querySelectorAll('em') ?? [])]
          .some((node) => node.textContent === 'linked italic'),
        underline: [...(editor?.querySelectorAll('.write-underline') ?? [])]
          .some((node) => node.textContent === 'underlined'),
        supportedFamily: [...(editor?.querySelectorAll('[data-write-font-family="sans"]') ?? [])]
          .some((node) => node.textContent === 'supported font'),
        supportedSize: [...(editor?.querySelectorAll('[data-write-font-size="14"]') ?? [])]
          .some((node) => node.textContent === 'supported font'),
        unsupportedFont: (() => {
          if (!(editor instanceof HTMLElement)) return { family: '', size: '' };
          const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.includes('unsupported font') || !(node.parentElement instanceof HTMLElement)) continue;
            const style = getComputedStyle(node.parentElement);
            return { family: style.fontFamily, size: style.fontSize };
          }
          return { family: '', size: '' };
        })(),
        unsupportedElement: editor?.querySelector('a, img, script, [href]') !== null,
        unsupportedStyle:
          editor?.querySelector(
            '[style*="color"], [style*="background"], [style*="Comic"], [style*="Papyrus"], [style*="13px"]'
          ) !== null
      };
    })()`,
    true,
  )) as {
    format: string | null;
    text: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    supportedFamily: boolean;
    supportedSize: boolean;
    unsupportedFont: { family: string; size: string };
    unsupportedElement: boolean;
    unsupportedStyle: boolean;
  };
  if (
    sanitizedRichPaste.format !== 'write-v1' ||
    !sanitizedRichPaste.text.includes(
      'Allowed bold linked italic underlined styled supported font unsupported font',
    ) ||
    sanitizedRichPaste.text.includes('evil script') ||
    !sanitizedRichPaste.bold ||
    !sanitizedRichPaste.italic ||
    !sanitizedRichPaste.underline ||
    !sanitizedRichPaste.supportedFamily ||
    !sanitizedRichPaste.supportedSize ||
    !sanitizedRichPaste.unsupportedFont.family.toLowerCase().includes('helvetica') ||
    sanitizedRichPaste.unsupportedFont.size !== '12px' ||
    sanitizedRichPaste.unsupportedElement ||
    sanitizedRichPaste.unsupportedStyle
  ) {
    throw new Error(
      `Write did not preserve the supported rich fragment while stripping hostile HTML: ${JSON.stringify(sanitizedRichPaste)}.`,
    );
  }
  await invokeRendererMenuAction('edit', 'undo');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write hostile Clipboard Undo');
  const hostilePasteUndoText = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Untitled"] [data-write-editor="true"]'
    )?.textContent ?? ''`,
    true,
  )) as string;
  if (hostilePasteUndoText !== plainClipboardBaseline) {
    throw new Error('Undo did not exactly restore the document after sanitized rich paste.');
  }
  await pause(600);
  await ensureNativeInputFocus('Write shortcut editing');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta'] });
  await pause(50);
  await window.webContents.insertText(' shortcut');
  await pause(50);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta'] });
  await pause(80);
  const shortcutBold = (await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Untitled"] [data-write-editor="true"]'
      );
      const strongTexts = [...(editor?.querySelectorAll('strong') ?? [])]
        .map((strong) => strong.textContent ?? '');
      return {
        text: editor?.textContent ?? '',
        html: editor?.innerHTML ?? '',
        strongTexts
      };
    })()`,
    true,
  )) as { text: string; html: string; strongTexts: string[] };
  if (
    shortcutBold.text !== 'Write smoke document shortcut' ||
    shortcutBold.strongTexts.length !== 1 ||
    shortcutBold.strongTexts[0] !== ' shortcut'
  ) {
    throw new Error(`Command-B did not toggle Bold exactly once: ${JSON.stringify(shortcutBold)}.`);
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
  await pause(80);
  const shortcutUndo = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        text: write?.querySelector('[data-write-editor="true"]')?.textContent ?? '',
        format: write?.getAttribute('data-document-format')
      };
    })()`,
    true,
  )) as { text: string; format: string | null };
  if (shortcutUndo.text !== 'Write smoke document' || shortcutUndo.format !== 'write-v1') {
    throw new Error(
      `Command-Z did not undo exactly one rich edit: ${JSON.stringify(shortcutUndo)}.`,
    );
  }

  await invokeRendererMenuAction('view', 'zoom-100');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
  await pause(80);
  const zoomedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      const ruler = write?.querySelector('.write-ruler-viewport');
      const page = write?.querySelector('.write-page-stack');
      const editor = write?.querySelector('[data-write-editor="true"]');
      const tab = editor?.querySelector('[data-write-tab]');
      if (!(editor instanceof HTMLElement) || !(tab instanceof HTMLElement)) return null;
      const tabRight = tab.getBoundingClientRect().right - editor.getBoundingClientRect().left;
      return {
        status: write?.querySelector('.write-status-bar')?.textContent ?? '',
        rulerWidth: ruler?.getBoundingClientRect().width ?? 0,
        pageWidth: page?.getBoundingClientRect().width ?? 0,
        tabAlignmentError: Math.abs(tabRight - Math.round(tabRight / 36) * 36)
      };
    })()`,
    true,
  )) as {
    status: string;
    rulerWidth: number;
    pageWidth: number;
    tabAlignmentError: number;
  } | null;
  if (
    !zoomedWrite ||
    !zoomedWrite.status.includes('100%') ||
    Math.abs(zoomedWrite.rulerWidth - 468) > 1 ||
    Math.abs(zoomedWrite.pageWidth - 612) > 1 ||
    zoomedWrite.tabAlignmentError > 2
  ) {
    throw new Error(`Write 100% zoom or live tab layout failed: ${JSON.stringify(zoomedWrite)}.`);
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'BACKSPACE' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'BACKSPACE' });
  await invokeRendererMenuAction('view', 'zoom-75');
  await pause(60);
  const restoredZoom = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        status: write?.querySelector('.write-status-bar')?.textContent ?? '',
        rulerWidth: write?.querySelector('.write-ruler-viewport')?.getBoundingClientRect().width ?? 0,
        pageWidth: write?.querySelector('.write-page-stack')?.getBoundingClientRect().width ?? 0
      };
    })()`,
    true,
  )) as { status: string; rulerWidth: number; pageWidth: number };
  if (
    !restoredZoom.status.includes('75%') ||
    Math.abs(restoredZoom.rulerWidth - 351) > 1 ||
    Math.abs(restoredZoom.pageWidth - 459) > 1
  ) {
    throw new Error(`Write did not restore 75% zoom: ${JSON.stringify(restoredZoom)}.`);
  }

  await invokeRendererMenuAction('view', 'zoom-50');
  await pause(50);
  const halfZoom = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        status: write?.querySelector('.write-status-bar')?.textContent ?? '',
        rulerWidth: write?.querySelector('.write-ruler-viewport')?.getBoundingClientRect().width ?? 0,
        pageWidth: write?.querySelector('.write-page-stack')?.getBoundingClientRect().width ?? 0
      };
    })()`,
    true,
  )) as { status: string; rulerWidth: number; pageWidth: number };
  if (
    !halfZoom.status.includes('50%') ||
    Math.abs(halfZoom.rulerWidth - 234) > 1 ||
    Math.abs(halfZoom.pageWidth - 306) > 1
  ) {
    throw new Error(`Write 50% zoom failed: ${JSON.stringify(halfZoom)}.`);
  }
  await invokeRendererMenuAction('view', 'zoom-75');
  await pause(50);

  await invokeRendererMenuAction('edit', 'select-all');
  for (const fontSize of [9, 10, 12, 14, 18, 24] as const) {
    await invokeRendererMenuAction('size', `size-${fontSize}`);
    await waitForWriteLayout(
      '[data-write-title="Untitled"]',
      `Write ${String(fontSize)}-point layout`,
    );
    const appliedFontSize = await window.webContents.executeJavaScript(
      `document.querySelector(
        '[data-write-title="Untitled"] [data-write-paragraph]'
      )?.querySelector('[data-write-font-size="${String(fontSize)}"]')
        ?.getAttribute('data-write-font-size')`,
      true,
    );
    if (appliedFontSize !== String(fontSize)) {
      throw new Error(`Write did not apply the supported ${String(fontSize)}-point size.`);
    }
  }
  for (const fontFamily of ['serif', 'mono', 'sans'] as const) {
    await invokeRendererMenuAction('font', `font-${fontFamily}`);
    const appliedFontFamily = await window.webContents.executeJavaScript(
      `document.querySelector(
        '[data-write-title="Untitled"] [data-write-font-family="${fontFamily}"]'
      )?.getAttribute('data-write-font-family')`,
      true,
    );
    if (appliedFontFamily !== fontFamily) {
      throw new Error(`Write did not apply the supported ${fontFamily} font family.`);
    }
  }
  await invokeRendererMenuAction('size', 'size-14');
  await invokeRendererMenuAction('format', 'italic');
  await invokeRendererMenuAction('format', 'align-center');
  await invokeRendererMenuAction('format', 'line-spacing-1.5');
  await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Untitled"] [data-write-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`,
    true,
  );
  await pause(30);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
  window.webContents.insertText('Second paragraph');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
  window.webContents.insertText('Tabbed text');
  await invokeRendererMenuAction('format', 'insert-page-break');
  window.webContents.insertText('Page two');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write formatted page projection');
  await invokeRendererMenuAction('view', 'zoom-100');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write ruler setup at 100%');
  const customTabPoint = (await window.webContents.executeJavaScript(
    `(() => {
      const ruler = document.querySelector(
        '[data-write-title="Untitled"] [aria-label="Paragraph ruler"]'
      );
      if (!(ruler instanceof HTMLElement)) return null;
      const bounds = ruler.getBoundingClientRect();
      return {
        x: Math.round(bounds.left + bounds.width * (54 / 468)),
        y: Math.round(bounds.top + bounds.height / 2)
      };
    })()`,
    true,
  )) as SmokePoint | null;
  if (!customTabPoint) throw new Error('The Write ruler could not locate a custom tab point.');
  await ensureNativeInputFocus('Write ruler press and release');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...customTabPoint });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...customTabPoint,
  });
  await pause(40);
  const customTabPreview = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        committed: write?.querySelector('[aria-label="Tab stop at 54 points"]') !== null,
        preview: write?.querySelector('.write-ruler-marker-preview') !== null
      };
    })()`,
    true,
  )) as { committed: boolean; preview: boolean };
  if (customTabPreview.committed || !customTabPreview.preview) {
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...customTabPoint,
    });
    throw new Error(
      `The Write ruler committed before native release: ${JSON.stringify(customTabPreview)}.`,
    );
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...customTabPoint,
  });
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write ruler release commit');
  const customTabAdded = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        committed: write?.querySelector('[aria-label="Tab stop at 54 points"]') !== null,
        preview: write?.querySelector('.write-ruler-marker-preview') !== null
      };
    })()`,
    true,
  )) as { committed: boolean; preview: boolean };
  if (!customTabAdded.committed || customTabAdded.preview) {
    throw new Error(
      `The Write ruler did not commit exactly on native release: ${JSON.stringify(customTabAdded)}.`,
    );
  }
  await invokeRendererMenuAction('view', 'zoom-75');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write ruler zoom restoration');
  const formattedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      const status = write?.querySelector('.write-status-bar')?.textContent ?? '';
      return {
        format: write?.getAttribute('data-document-format'),
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true,
        italic: write?.querySelector('em') !== null,
        sans: write?.querySelector('[data-write-font-family="sans"]') !== null,
        size14: write?.querySelector('[data-write-font-size="14"]') !== null,
        centered: write?.querySelector('[data-alignment="center"]') !== null,
        pageCount: write?.querySelector('[data-page-count]')?.getAttribute('data-page-count'),
        customTab: write?.querySelector('[aria-label="Tab stop at 54 points"]') !== null,
        status
      };
    })()`,
    true,
  )) as {
    format: string | null;
    dirty: boolean;
    italic: boolean;
    sans: boolean;
    size14: boolean;
    centered: boolean;
    pageCount: string | null;
    customTab: boolean;
    status: string;
  };
  if (
    formattedWrite.format !== 'write-v1' ||
    !formattedWrite.dirty ||
    !formattedWrite.italic ||
    !formattedWrite.sans ||
    !formattedWrite.size14 ||
    !formattedWrite.centered ||
    formattedWrite.pageCount !== '2' ||
    !formattedWrite.customTab ||
    !formattedWrite.status.includes('Page 2 of 2')
  ) {
    throw new Error(
      `Write formatting, ruler, or page projection failed: ${JSON.stringify(formattedWrite)}.`,
    );
  }

  const inlineClipboardSelection = await activateWriteTextSelection(
    '[data-write-title="Untitled"]',
    0,
    5,
    'Write mixed inline Clipboard fragment',
  );
  await invokeRendererMenuAction('font', 'font-serif');
  await invokeRendererMenuAction('size', 'size-18');
  await waitForWriteLayout(
    '[data-write-title="Untitled"]',
    'Write mixed inline Clipboard formatting',
  );
  const inlineClipboardFormatting = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        selectedText: window.getSelection()?.toString() ?? '',
        serifRuns: [...(write?.querySelectorAll('[data-write-font-family="serif"]') ?? [])]
          .map((run) => run.textContent ?? ''),
        size18Runs: [...(write?.querySelectorAll('[data-write-font-size="18"]') ?? [])]
          .map((run) => run.textContent ?? ''),
        sansRuns: write?.querySelectorAll('[data-write-font-family="sans"]').length ?? 0,
        size14Runs: write?.querySelectorAll('[data-write-font-size="14"]').length ?? 0
      };
    })()`,
    true,
  )) as {
    selectedText: string;
    serifRuns: string[];
    size18Runs: string[];
    sansRuns: number;
    size14Runs: number;
  };
  if (
    inlineClipboardFormatting.selectedText !== inlineClipboardSelection ||
    inlineClipboardFormatting.serifRuns.length !== 1 ||
    inlineClipboardFormatting.serifRuns[0] !== inlineClipboardSelection ||
    inlineClipboardFormatting.size18Runs.length !== 1 ||
    inlineClipboardFormatting.size18Runs[0] !== inlineClipboardSelection ||
    inlineClipboardFormatting.sansRuns < 1 ||
    inlineClipboardFormatting.size14Runs < 1
  ) {
    throw new Error(
      `Write could not create a mixed inline font/size Clipboard fragment: ${JSON.stringify(inlineClipboardFormatting)}.`,
    );
  }

  await ensureNativeInputFocus('Write rich clipboard');
  const richPaginationBaseline = await readStableWritePaginationFingerprint(
    '[data-write-title="Untitled"]',
    'Write rich Clipboard baseline',
  );
  if ((JSON.parse(richPaginationBaseline) as { pageCount?: number }).pageCount !== 2) {
    throw new Error(
      `Write rich Clipboard baseline was not exactly two pages: ${richPaginationBaseline}.`,
    );
  }
  // Keep the paste in its own ProseMirror history group so one Undo has an exact boundary.
  await pause(600);
  const richClipboardBaseline = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        pageBreaks: write?.querySelectorAll('[data-write-page-break]').length ?? 0,
        tabs: write?.querySelectorAll('[data-write-tab]').length ?? 0,
        italicRuns: write?.querySelectorAll('em').length ?? 0,
        serifRuns: write?.querySelectorAll('[data-write-font-family="serif"]').length ?? 0,
        size18Runs: write?.querySelectorAll('[data-write-font-size="18"]').length ?? 0,
        styledParagraphs: [...(write?.querySelectorAll(
          '[data-write-paragraph][data-alignment="center"]'
        ) ?? [])].filter(
          (paragraph) =>
            paragraph.querySelector('[data-write-font-family="sans"]') !== null &&
            paragraph.querySelector('[data-write-font-size="14"]') !== null
        ).length
      };
    })()`,
    true,
  )) as {
    pageBreaks: number;
    tabs: number;
    italicRuns: number;
    serifRuns: number;
    size18Runs: number;
    styledParagraphs: number;
  };
  await invokeRendererMenuAction('edit', 'select-all');
  await invokeRendererMenuAction('edit', 'copy');
  await pause(80);
  await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Untitled"] [data-write-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`,
    true,
  );
  await pause(30);
  await invokeRendererMenuAction('edit', 'paste');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Write rich Clipboard paste');
  const richClipboard = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        pageBreaks: write?.querySelectorAll('[data-write-page-break]').length ?? 0,
        tabs: write?.querySelectorAll('[data-write-tab]').length ?? 0,
        italicRuns: write?.querySelectorAll('em').length ?? 0,
        serifRuns: write?.querySelectorAll('[data-write-font-family="serif"]').length ?? 0,
        size18Runs: write?.querySelectorAll('[data-write-font-size="18"]').length ?? 0,
        styledParagraphs: [...(write?.querySelectorAll(
          '[data-write-paragraph][data-alignment="center"]'
        ) ?? [])].filter(
          (paragraph) =>
            paragraph.querySelector('[data-write-font-family="sans"]') !== null &&
            paragraph.querySelector('[data-write-font-size="14"]') !== null
        ).length
      };
    })()`,
    true,
  )) as {
    pageBreaks: number;
    tabs: number;
    italicRuns: number;
    serifRuns: number;
    size18Runs: number;
    styledParagraphs: number;
  };
  if (
    richClipboard.pageBreaks !== richClipboardBaseline.pageBreaks * 2 ||
    richClipboard.tabs !== richClipboardBaseline.tabs * 2 ||
    richClipboard.italicRuns !== richClipboardBaseline.italicRuns * 2 ||
    richClipboard.serifRuns !== richClipboardBaseline.serifRuns * 2 ||
    richClipboard.size18Runs !== richClipboardBaseline.size18Runs * 2 ||
    richClipboard.styledParagraphs !== richClipboardBaseline.styledParagraphs * 2
  ) {
    throw new Error(
      `Write rich Clipboard paste lost semantics: ${JSON.stringify({ baseline: richClipboardBaseline, pasted: richClipboard })}.`,
    );
  }
  await invokeRendererMenuAction('edit', 'undo');
  const richPaginationAfterUndo = await readStableWritePaginationFingerprint(
    '[data-write-title="Untitled"]',
    'Write rich Clipboard Undo',
  );
  const clipboardUndoRestored = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        pageCount: write?.querySelector('[data-page-count]')?.getAttribute('data-page-count'),
        pageBreaks: write?.querySelectorAll('[data-write-page-break]').length ?? 0,
        tabs: write?.querySelectorAll('[data-write-tab]').length ?? 0,
        italicRuns: write?.querySelectorAll('em').length ?? 0,
        serifRuns: write?.querySelectorAll('[data-write-font-family="serif"]').length ?? 0,
        size18Runs: write?.querySelectorAll('[data-write-font-size="18"]').length ?? 0,
        styledParagraphs: [...(write?.querySelectorAll(
          '[data-write-paragraph][data-alignment="center"]'
        ) ?? [])].filter(
          (paragraph) =>
            paragraph.querySelector('[data-write-font-family="sans"]') !== null &&
            paragraph.querySelector('[data-write-font-size="14"]') !== null
        ).length
      };
    })()`,
    true,
  )) as {
    pageCount: string | null;
    pageBreaks: number;
    tabs: number;
    italicRuns: number;
    serifRuns: number;
    size18Runs: number;
    styledParagraphs: number;
  };
  if (
    richPaginationAfterUndo !== richPaginationBaseline ||
    clipboardUndoRestored.pageCount !== '2' ||
    clipboardUndoRestored.pageBreaks !== richClipboardBaseline.pageBreaks ||
    clipboardUndoRestored.tabs !== richClipboardBaseline.tabs ||
    clipboardUndoRestored.italicRuns !== richClipboardBaseline.italicRuns ||
    clipboardUndoRestored.serifRuns !== richClipboardBaseline.serifRuns ||
    clipboardUndoRestored.size18Runs !== richClipboardBaseline.size18Runs ||
    clipboardUndoRestored.styledParagraphs !== richClipboardBaseline.styledParagraphs
  ) {
    throw new Error(
      `Undo did not restore the exact pre-paste Write layout: ${JSON.stringify({
        semantic: clipboardUndoRestored,
        fingerprintMatched: richPaginationAfterUndo === richPaginationBaseline,
        before: richPaginationBaseline,
        after: richPaginationAfterUndo,
      })}.`,
    );
  }

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['meta'] });
  await pause(80);
  const saveAsDefault = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-file-dialog="save-as"] [data-write-file-location]')
      ?.textContent?.trim()`,
    true,
  );
  if (saveAsDefault !== 'Documents') {
    throw new Error(`Write Save As did not default to Documents: ${String(saveAsDefault)}.`);
  }
  const saveAsPrepared = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="save-as"]');
      const up = dialog?.querySelector('[aria-label="Open enclosing folder"]');
      if (!(dialog instanceof HTMLElement) || !(up instanceof HTMLButtonElement)) return false;
      up.click();
      return true;
    })()`,
    true,
  );
  if (!saveAsPrepared) throw new Error('Write Save As could not open System Disk.');
  await pause(40);
  const namedForSave = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="save-as"]');
      const input = dialog?.querySelector('input');
      if (!(dialog instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Smoke Write');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    true,
  );
  if (!namedForSave) throw new Error('Write Save As could not set the document name.');
  await pause(30);
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="save-as"]');
      const save = [...(dialog?.closest('[role="dialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Save');
      save?.click();
    })()`,
    true,
  );
  await pause(140);
  const savedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Smoke Write"]');
      return {
        documentId: write?.getAttribute('data-document-id') ?? '',
        format: write?.getAttribute('data-document-format'),
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true,
        saveDialogOpen: document.querySelector('[data-write-file-dialog="save-as"]') !== null
      };
    })()`,
    true,
  )) as { documentId: string; format: string | null; dirty: boolean; saveDialogOpen: boolean };
  if (
    !savedWrite.documentId ||
    savedWrite.format !== 'write-v1' ||
    savedWrite.dirty ||
    savedWrite.saveDialogOpen
  ) {
    throw new Error(`Write Save As did not commit the document: ${JSON.stringify(savedWrite)}.`);
  }

  const immediateSavePrepared = await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Smoke Write"] [data-write-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`,
    true,
  );
  if (!immediateSavePrepared) throw new Error('Write could not prepare the immediate-save edit.');
  await ensureNativeInputFocus('Write immediate stable save');
  window.webContents.insertText(' Immediate stable save.');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['meta'] });
  await waitForWriteLayout('[data-write-title="Smoke Write"]', 'Write immediate save');
  let immediateSavedWrite: { dirty: boolean; text: string; pageCount: string | null } | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    immediateSavedWrite = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Smoke Write"]');
        if (!(write instanceof HTMLElement)) return null;
        return {
          dirty: write.querySelector('h2')?.textContent?.includes('•') === true,
          text: write.querySelector('[data-write-editor="true"]')?.textContent ?? '',
          pageCount: write.querySelector('[data-page-count]')?.getAttribute('data-page-count') ?? null
        };
      })()`,
      true,
    )) as { dirty: boolean; text: string; pageCount: string | null } | null;
    if (immediateSavedWrite && !immediateSavedWrite.dirty) break;
    await pause(25);
  }
  if (
    !immediateSavedWrite ||
    immediateSavedWrite.dirty ||
    !immediateSavedWrite.text.endsWith('Immediate stable save.') ||
    immediateSavedWrite.pageCount !== '2'
  ) {
    throw new Error(
      `Write did not save the stable post-edit snapshot: ${JSON.stringify(immediateSavedWrite)}.`,
    );
  }

  await invokeRendererMenuAction('file', 'close-write-window');
  let immediateSavedWriteClosed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    immediateSavedWriteClosed = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Smoke Write"]') === null`,
      true,
    )) as boolean;
    if (immediateSavedWriteClosed) break;
    await pause(20);
  }
  if (!immediateSavedWriteClosed) {
    throw new Error('The immediately saved Write window did not close cleanly.');
  }
  const immediateSavedWriteReopened = await window.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )].find((candidate) => candidate.textContent?.trim() === 'Smoke Write');
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!immediateSavedWriteReopened) {
    throw new Error('The immediately saved Write document was not visible on System Disk.');
  }
  await waitForWriteLayout('[data-write-title="Smoke Write"]', 'Reopened immediate Write save');
  const immediateReopenedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Smoke Write"]');
      return {
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true,
        text: write?.querySelector('[data-write-editor="true"]')?.textContent ?? ''
      };
    })()`,
    true,
  )) as { dirty: boolean; text: string };
  if (immediateReopenedWrite.dirty || immediateReopenedWrite.text !== immediateSavedWrite.text) {
    throw new Error(
      `Reopening Write did not restore the exact immediate-save snapshot: ${JSON.stringify({
        saved: immediateSavedWrite,
        reopened: immediateReopenedWrite,
      })}.`,
    );
  }

  const secondWriteOpenAnimation = await observeWindowAnimation(
    '[data-write-title="Untitled"]',
    'opening',
    () => invokeRendererMenuAction('file', 'new-document'),
  );
  assertWindowAnimationOutline(secondWriteOpenAnimation, 'Source-less Write opening animation');
  assertWindowAnimationCenteredFallback(
    secondWriteOpenAnimation,
    'Source-less Write opening outline',
  );
  await waitForWindowSettled(
    '[data-write-title="Untitled"]',
    'Second independent Write window',
    secondWriteOpenAnimation!.windowId,
  );
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Second independent Write window');
  const secondWriteFocused = await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      const editor = write?.querySelector('[data-write-editor="true"]');
      if (!(write instanceof HTMLElement) || !(editor instanceof HTMLElement)) return false;
      editor.focus();
      return write.classList.contains('is-active');
    })()`,
    true,
  );
  if (!secondWriteFocused) throw new Error('The second Write window did not become active.');
  const inactiveWriteScrollFrame = await readClassicScrollFrame(
    '[data-write-title="Smoke Write"]',
    '.write-document-viewport',
  );
  const activeWriteScrollFrame = await readClassicScrollFrame(
    '[data-write-title="Untitled"]',
    '.write-document-viewport',
  );
  assertClassicScrollFrame(inactiveWriteScrollFrame, 'Inactive Write');
  assertClassicScrollFrame(activeWriteScrollFrame, 'Active Write');
  const firstWriteInactive = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"]')?.classList.contains('is-inactive') === true`,
    true,
  );
  if (!firstWriteInactive) {
    throw new Error(
      'The inactive Write window lost its inactive treatment behind the active window.',
    );
  }
  window.webContents.insertText('Independent second window');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Second Write edit');
  await invokeRendererMenuAction('edit', 'undo');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Second Write Undo');
  const independentUndo = (await window.webContents.executeJavaScript(
    `(() => ({
      activeTitle: document.querySelector('.write-window.is-active')?.getAttribute('data-write-title'),
      firstText: document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.textContent ?? '',
      secondText: document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.textContent ?? ''
    }))()`,
    true,
  )) as { activeTitle: string | null; firstText: string; secondText: string };
  if (
    independentUndo.activeTitle !== 'Untitled' ||
    independentUndo.firstText !== immediateReopenedWrite.text ||
    independentUndo.secondText !== ''
  ) {
    throw new Error(
      `Write Undo crossed window history boundaries: ${JSON.stringify(independentUndo)}.`,
    );
  }
  await invokeRendererMenuAction('edit', 'redo');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Second Write Redo');
  const independentRedo = (await window.webContents.executeJavaScript(
    `(() => ({
      firstText: document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.textContent ?? '',
      secondText: document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.textContent ?? ''
    }))()`,
    true,
  )) as { firstText: string; secondText: string };
  if (
    independentRedo.firstText !== immediateReopenedWrite.text ||
    independentRedo.secondText !== 'Independent second window'
  ) {
    throw new Error(
      `Write Redo did not remain scoped to the active window: ${JSON.stringify(independentRedo)}.`,
    );
  }

  const firstWindowSelection = await activateWriteMatchingTextSelection(
    '[data-write-title="Smoke Write"]',
    'Page two',
    'First Write window',
  );
  if (firstWindowSelection !== 'Page two') {
    throw new Error(`The first Write selection was not distinct: ${firstWindowSelection}.`);
  }
  const writeFontActions = ['font-serif', 'font-sans', 'font-mono'] as const;
  const writeSizeActions = [
    'size-9',
    'size-10',
    'size-12',
    'size-14',
    'size-18',
    'size-24',
  ] as const;
  const writeFormatActions = [
    'bold',
    'italic',
    'underline',
    'align-left',
    'align-center',
    'align-right',
  ] as const;
  const firstFontMenuBefore = await readRendererMenuState('font', writeFontActions);
  const firstSizeMenuBefore = await readRendererMenuState('size', writeSizeActions);
  const firstFormatMenuBefore = await readRendererMenuState('format', writeFormatActions);
  const firstRulerBefore = await readWriteRulerState('[data-write-title="Smoke Write"]');
  const firstEditorBeforeSecondFormatting = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Smoke Write"] [data-write-editor="true"]'
    )?.innerHTML ?? ''`,
    true,
  )) as string;
  const secondWindowSelection = await activateWriteTextSelection(
    '[data-write-title="Untitled"]',
    0,
    11,
    'Second Write window',
  );
  if (secondWindowSelection !== 'Independent') {
    throw new Error(`The second Write selection was not distinct: ${secondWindowSelection}.`);
  }
  await invokeRendererMenuAction('font', 'font-mono');
  await invokeRendererMenuAction('size', 'size-10');
  await invokeRendererMenuAction('format', 'underline');
  await invokeRendererMenuAction('format', 'increase-left-indent');
  await invokeRendererMenuAction('format', 'bold');
  await waitForWriteLayout('[data-write-title="Untitled"]', 'Second Write selection formatting');
  const secondWindowFormatting = (await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Untitled"] [data-write-editor="true"]'
      );
      const strongRuns = [...(editor?.querySelectorAll('strong') ?? [])]
        .map((run) => run.textContent ?? '');
      return {
        selectedText: window.getSelection()?.toString() ?? '',
        strongRuns,
        mono: editor?.querySelector('[data-write-font-family="mono"]') !== null,
        size10: editor?.querySelector('[data-write-font-size="10"]') !== null,
        underline: editor?.querySelector('.write-underline') !== null
      };
    })()`,
    true,
  )) as {
    selectedText: string;
    strongRuns: string[];
    mono: boolean;
    size10: boolean;
    underline: boolean;
  };
  if (
    secondWindowFormatting.selectedText !== secondWindowSelection ||
    secondWindowFormatting.strongRuns.length !== 1 ||
    secondWindowFormatting.strongRuns[0] !== secondWindowSelection ||
    !secondWindowFormatting.mono ||
    !secondWindowFormatting.size10 ||
    !secondWindowFormatting.underline
  ) {
    throw new Error(
      `Formatting did not remain scoped to the second Write selection: ${JSON.stringify(secondWindowFormatting)}.`,
    );
  }

  await reactivateWriteEditor('[data-write-title="Smoke Write"]', 'First Write window');
  const restoredFirstSelection = await copyActiveWriteSelection(
    firstWindowSelection,
    'First Write window',
  );
  const firstFontMenu = await readRendererMenuState('font', writeFontActions);
  const firstSizeMenu = await readRendererMenuState('size', writeSizeActions);
  const firstFormatMenu = await readRendererMenuState('format', writeFormatActions);
  const firstRulerAfter = await readWriteRulerState('[data-write-title="Smoke Write"]');
  const firstWindowContext = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Smoke Write"]');
      const editor = write?.querySelector('[data-write-editor="true"]');
      return {
        active: write?.classList.contains('is-active') === true,
        editorHtml: editor?.innerHTML ?? ''
      };
    })()`,
    true,
  )) as {
    active: boolean;
    editorHtml: string;
  };
  if (
    restoredFirstSelection !== firstWindowSelection ||
    !firstWindowContext.active ||
    firstWindowContext.editorHtml !== firstEditorBeforeSecondFormatting ||
    JSON.stringify(firstFontMenu) !== JSON.stringify(firstFontMenuBefore) ||
    JSON.stringify(firstSizeMenu) !== JSON.stringify(firstSizeMenuBefore) ||
    JSON.stringify(firstFormatMenu) !== JSON.stringify(firstFormatMenuBefore) ||
    JSON.stringify(firstRulerAfter) !== JSON.stringify(firstRulerBefore)
  ) {
    throw new Error(
      `The first Write window did not restore its own selection, menu context, and ruler: ${JSON.stringify(
        {
          restoredFirstSelection,
          firstWindowSelection,
          firstWindowContext,
          firstFontMenu,
          firstSizeMenu,
          firstFormatMenu,
          firstRulerBefore,
          firstRulerAfter,
        },
      )}.`,
    );
  }

  await reactivateWriteEditor('[data-write-title="Untitled"]', 'Second Write window');
  const restoredSecondSelection = await copyActiveWriteSelection(
    secondWindowSelection,
    'Second Write window',
  );
  const secondFontMenu = await readRendererMenuState('font', writeFontActions);
  const secondSizeMenu = await readRendererMenuState('size', writeSizeActions);
  const secondFormatMenu = await readRendererMenuState('format', writeFormatActions);
  const secondRuler = await readWriteRulerState('[data-write-title="Untitled"]');
  const secondWindowContext = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Untitled"]');
      return {
        active: write?.classList.contains('is-active') === true
      };
    })()`,
    true,
  )) as { active: boolean };
  if (
    restoredSecondSelection !== secondWindowSelection ||
    !secondWindowContext.active ||
    secondRuler.leftIndent !== '18px' ||
    secondRuler.mixed !== null ||
    JSON.stringify(secondRuler) === JSON.stringify(firstRulerBefore) ||
    secondFontMenu['font-sans']?.checked !== 'false' ||
    secondFontMenu['font-mono']?.checked !== 'true' ||
    secondSizeMenu['size-14']?.checked !== 'false' ||
    secondSizeMenu['size-10']?.checked !== 'true' ||
    secondFormatMenu.underline?.checked !== 'true' ||
    secondFormatMenu.bold?.checked !== 'true' ||
    secondFormatMenu['align-left']?.checked !== 'true' ||
    secondFormatMenu['align-center']?.checked !== 'false'
  ) {
    throw new Error(
      `The second Write window did not restore its own selection, menu context, and ruler: ${JSON.stringify(
        {
          restoredSecondSelection,
          secondWindowSelection,
          secondWindowContext,
          secondFontMenu,
          secondSizeMenu,
          secondFormatMenu,
          secondRuler,
        },
      )}.`,
    );
  }
  await invokeRendererMenuAction('file', 'close-write-window');
  await pause(40);
  const secondWritePrompt = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Untitled') === true`,
    true,
  );
  if (!secondWritePrompt) throw new Error('The second dirty Write window did not request review.');
  const secondWriteCloseAnimation = await observeWindowAnimation(
    '[data-write-title="Untitled"]',
    'closing',
    () =>
      window.webContents.executeJavaScript(
        `(() => {
          const dialog = document.querySelector('[aria-label="Save Changes"]');
          const discard = [...(dialog?.querySelectorAll('button') ?? [])]
            .find((button) => button.textContent?.trim() === 'Don’t Save');
          if (!(discard instanceof HTMLButtonElement)) return false;
          discard.click();
          return true;
        })()`,
        true,
      ),
  );
  assertWindowAnimationOutline(secondWriteCloseAnimation, 'Write closing animation');
  assertWindowAnimationCenteredFallback(
    secondWriteCloseAnimation,
    'Source-less Write closing outline',
  );
  const closingWriteShortcuts: {
    keyCode: string;
    modifiers: ('meta' | 'shift')[];
  }[] = [
    { keyCode: 'W', modifiers: ['meta'] },
    { keyCode: 'S', modifiers: ['meta'] },
    { keyCode: 'S', modifiers: ['meta', 'shift'] },
  ];
  for (const input of closingWriteShortcuts) {
    window.webContents.sendInputEvent({ type: 'keyDown', ...input });
    window.webContents.sendInputEvent({ type: 'keyUp', ...input });
  }
  let secondWriteCloseState: {
    closing: string | null;
    dialogOpen: boolean;
    shadowPresent: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    secondWriteCloseState = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Untitled"]');
        if (!(write instanceof HTMLElement)) return null;
        const windowId = write.getAttribute('data-write-window');
        return {
          closing: write.getAttribute('data-closing'),
          dialogOpen: document.querySelector('[aria-label="Save Changes"]') !== null,
          shadowPresent:
            windowId !== null &&
            document.querySelector('[data-window-animation-shadow="' + windowId + '"]') !== null
        };
      })()`,
      true,
    )) as typeof secondWriteCloseState;
    if (!secondWriteCloseState) break;
    if (attempt === 59) {
      throw new Error(
        `The discarded second Write window remained open: ${JSON.stringify(secondWriteCloseState)}.`,
      );
    }
    await pause(20);
  }
  const closingWriteLeftTransientDialog = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-file-dialog], [aria-label="Save Changes"]') !== null`,
    true,
  );
  if (closingWriteLeftTransientDialog) {
    throw new Error('Write File shortcuts remained live during a discard-close animation.');
  }

  await invokeRendererMenuAction('system', 'calculator');
  const calculatorWriteOwnership = (await window.webContents.executeJavaScript(
    `(() => ({
      activeCalculator: document.querySelector('[data-calculator-window="true"].is-active') !== null,
      activeWrite: document.querySelector('.write-window.is-active') !== null,
      menus: [...document.querySelectorAll('[data-menu]')]
        .map((menu) => menu.getAttribute('data-menu'))
    }))()`,
    true,
  )) as { activeCalculator: boolean; activeWrite: boolean; menus: (string | null)[] };
  if (
    !calculatorWriteOwnership.activeCalculator ||
    calculatorWriteOwnership.activeWrite ||
    calculatorWriteOwnership.menus.join(',') !== 'system,file,edit,format,font,size,view'
  ) {
    throw new Error(
      `Calculator did not preserve Write menu ownership: ${JSON.stringify(calculatorWriteOwnership)}.`,
    );
  }
  const calculatorClipboardMarker = ' Calculator-owned paste';
  clipboard.writeText(calculatorClipboardMarker);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['meta'] });
  for (const keyCode of ['TAB', 'ENTER', 'BACKSPACE']) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  await waitForWriteLayout('[data-write-title="Smoke Write"]', 'Calculator Write paste');
  const calculatorWritePaste = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Smoke Write"] [data-write-editor="true"]'
    )?.textContent ?? ''`,
    true,
  )) as string;
  if (!calculatorWritePaste.includes(calculatorClipboardMarker)) {
    throw new Error('Write Paste did not work while Calculator retained keyboard ownership.');
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['meta'] });
  await waitForWriteLayout('[data-write-title="Smoke Write"]', 'Calculator Write Undo');
  const calculatorWriteUndo = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Smoke Write"] [data-write-editor="true"]'
    )?.textContent ?? ''`,
    true,
  )) as string;
  if (calculatorWriteUndo !== immediateReopenedWrite.text) {
    throw new Error(
      'Write Undo did not restore the document while Calculator owned ordinary keys.',
    );
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q' });
  await pause(40);
  const calculatorUnsupportedKeyText = (await window.webContents.executeJavaScript(
    `document.querySelector(
      '[data-write-title="Smoke Write"] [data-write-editor="true"]'
    )?.textContent ?? ''`,
    true,
  )) as string;
  if (calculatorUnsupportedKeyText !== immediateReopenedWrite.text) {
    throw new Error('An unsupported Calculator key leaked into the inactive Write editor.');
  }
  for (const keyCode of ['C', '4', '2']) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  await pause(60);
  const calculatorWriteInput = (await window.webContents.executeJavaScript(
    `(() => ({
      display: document.querySelector('[data-calculator-display]')?.textContent?.trim() ?? '',
      writeText: document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.textContent ?? ''
    }))()`,
    true,
  )) as { display: string; writeText: string };
  if (
    calculatorWriteInput.display !== '42' ||
    calculatorWriteInput.writeText !== immediateReopenedWrite.text
  ) {
    throw new Error(
      `Calculator ordinary-key ownership leaked into Write: ${JSON.stringify(calculatorWriteInput)}.`,
    );
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(60);
  const calculatorReturnedToWrite = await window.webContents.executeJavaScript(
    `document.querySelector('[data-calculator-window="true"]') === null &&
      document.querySelector('[data-write-title="Smoke Write"].is-active') !== null`,
    true,
  );
  if (!calculatorReturnedToWrite) {
    throw new Error('Closing Calculator did not restore the active Write window.');
  }

  await invokeRendererMenuAction('file', 'open-document');
  const openDialogDefault = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-file-dialog="open"] [data-write-file-location]')
      ?.textContent?.trim()`,
    true,
  );
  if (openDialogDefault !== 'Documents') {
    throw new Error(`Write Open did not default to Documents: ${String(openDialogDefault)}.`);
  }
  const reopenedExisting = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="open"]');
      const up = dialog?.querySelector('[aria-label="Open enclosing folder"]');
      if (!(dialog instanceof HTMLElement) || !(up instanceof HTMLButtonElement)) return false;
      up.click();
      return true;
    })()`,
    true,
  );
  if (!reopenedExisting) throw new Error('Write Open could not navigate to System Disk.');
  await pause(40);
  const selectedSavedWrite = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="open"]');
      const option = [...(dialog?.querySelectorAll('[role="option"]') ?? [])]
        .find((item) => item.textContent?.trim() === 'Smoke Write');
      if (!(option instanceof HTMLButtonElement)) return false;
      option.click();
      return true;
    })()`,
    true,
  );
  if (!selectedSavedWrite) throw new Error('Write Open could not select the saved document.');
  await pause(30);
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[data-write-file-dialog="open"]');
      const open = [...(dialog?.closest('[role="dialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Open');
      open?.click();
    })()`,
    true,
  );
  await pause(80);
  const savedWriteWindowCount = (await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-write-title="Smoke Write"]').length`,
    true,
  )) as number;
  if (savedWriteWindowCount !== 1) {
    throw new Error('Opening an already-open document created a second Write window.');
  }

  await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Smoke Write"] [data-write-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      return true;
    })()`,
    true,
  );
  await pause(30);
  window.webContents.insertText(' unsaved');
  await pause(50);
  const unsavedWriteDirty = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"] h2')?.textContent?.includes('•') === true`,
    true,
  );
  if (!unsavedWriteDirty) throw new Error('Typing did not dirty the saved Write document.');

  smokeSaveFailureTarget = 'vfs';
  await invokeRendererMenuAction('file', 'save-document');
  let writeSaveFailure: { message: string; dirty: boolean; text: string } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    writeSaveFailure = (await window.webContents.executeJavaScript(
      `(() => {
        const alert = document.querySelector('[aria-label="Persistence error"]');
        const write = document.querySelector('[data-write-title="Smoke Write"]');
        if (!(alert instanceof HTMLElement) || !(write instanceof HTMLElement)) return null;
        return {
          message: alert.textContent?.trim() ?? '',
          dirty: write.querySelector('h2')?.textContent?.includes('•') === true,
          text: write.querySelector('[data-write-editor="true"]')?.textContent ?? ''
        };
      })()`,
      true,
    )) as { message: string; dirty: boolean; text: string } | null;
    if (writeSaveFailure) break;
    await pause(25);
  }
  if (
    !writeSaveFailure ||
    !writeSaveFailure.message.includes('could not be saved') ||
    !writeSaveFailure.dirty ||
    !writeSaveFailure.text.includes('unsaved')
  ) {
    throw new Error(
      `An injected Write save failure did not preserve a visible dirty draft: ${JSON.stringify(writeSaveFailure)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Persistence error"] button')?.click()`,
    true,
  );
  await pause(40);

  await ensureNativeInputFocus('Write dirty-close shortcut');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  await pause(60);
  const dirtyClosePrompt = (await window.webContents.executeJavaScript(
    `(() => ({
      prompted:
        document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Smoke Write') === true,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((dialog) => ({
        label: dialog.getAttribute('aria-label'),
        text: dialog.textContent?.trim() ?? ''
      })),
      writeCount: document.querySelectorAll('[data-write-window]').length,
      normalQuitPending:
        document.querySelector('.macintosh')?.getAttribute('data-normal-quit-pending') ?? ''
    }))()`,
    true,
  )) as {
    prompted: boolean;
    dialogs: { label: string | null; text: string }[];
    writeCount: number;
    normalQuitPending: string;
  };
  if (!dirtyClosePrompt.prompted) {
    throw new Error(
      `Closing a dirty Write document did not ask to save: ${JSON.stringify(dirtyClosePrompt)}.`,
    );
  }
  smokeSaveFailureTarget = 'vfs';
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      const save = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Save');
      save?.click();
    })()`,
    true,
  );
  let closeSaveFailure: {
    message: string;
    dirty: boolean;
    reviewOpen: boolean;
    normalQuitPending: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    closeSaveFailure = (await window.webContents.executeJavaScript(
      `(() => {
        const alert = document.querySelector('[aria-label="Persistence error"]');
        const write = document.querySelector('[data-write-title="Smoke Write"]');
        if (!(alert instanceof HTMLElement) || !(write instanceof HTMLElement)) return null;
        return {
          message: alert.textContent?.trim() ?? '',
          dirty: write.querySelector('h2')?.textContent?.includes('•') === true,
          reviewOpen: document.querySelector('[aria-label="Save Changes"]') !== null,
          normalQuitPending:
            document.querySelector('.macintosh')?.getAttribute('data-normal-quit-pending') === 'true'
        };
      })()`,
      true,
    )) as {
      message: string;
      dirty: boolean;
      reviewOpen: boolean;
      normalQuitPending: boolean;
    } | null;
    if (closeSaveFailure) break;
    await pause(25);
  }
  if (
    !closeSaveFailure ||
    !closeSaveFailure.message.includes('could not be saved') ||
    !closeSaveFailure.dirty ||
    closeSaveFailure.reviewOpen ||
    closeSaveFailure.normalQuitPending
  ) {
    throw new Error(
      `A close-review save failure did not cancel close recoverably: ${JSON.stringify(closeSaveFailure)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Persistence error"] button')?.click()`,
    true,
  );
  await pause(40);

  await ensureNativeInputFocus('Write repeated dirty-close shortcut');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  await pause(50);
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      const cancel = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Cancel');
      cancel?.click();
    })()`,
    true,
  );
  await pause(50);
  const dirtyCloseCancelled = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"] h2')?.textContent?.includes('•') === true`,
    true,
  );
  if (!dirtyCloseCancelled) throw new Error('Cancel did not preserve the dirty Write document.');
  await ensureNativeInputFocus('Write final dirty-close shortcut');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"] [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  await pause(50);
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      const discard = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Don’t Save');
      discard?.click();
    })()`,
    true,
  );
  await pause(80);
  const dirtyWriteDiscarded = await window.webContents.executeJavaScript(
    `document.querySelector('[data-write-title="Smoke Write"]') === null`,
    true,
  );
  if (!dirtyWriteDiscarded) throw new Error('Don’t Save did not close the dirty Write document.');

  const persistedWriteReopened = await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector(
        '[data-finder-window="window-system-disk"] [data-vfs-item] [aria-label="Smoke Write"]'
      )?.closest('[data-vfs-item]') ??
        [...document.querySelectorAll(
          '[data-finder-window="window-system-disk"] [data-vfs-item]'
        )].find((candidate) => candidate.textContent?.trim() === 'Smoke Write');
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!persistedWriteReopened) {
    throw new Error('The saved Write document was not visible on System Disk.');
  }
  await pause(100);
  const persistedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Smoke Write"]');
      return {
        text: write?.querySelector('[data-write-editor="true"]')?.textContent ?? '',
        format: write?.getAttribute('data-document-format'),
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true
      };
    })()`,
    true,
  )) as { text: string; format: string | null; dirty: boolean };
  if (
    persistedWrite.format !== 'write-v1' ||
    persistedWrite.dirty ||
    !persistedWrite.text.includes('Page two') ||
    persistedWrite.text.includes('unsaved')
  ) {
    throw new Error(
      `Reopening Write did not restore only the saved rich payload: ${JSON.stringify(persistedWrite)}.`,
    );
  }

  await ensureNativeInputFocus('Write save-from-close review');
  const writePreparedForReviewSave = await window.webContents.executeJavaScript(
    `(() => {
      const editor = document.querySelector(
        '[data-write-title="Smoke Write"] [data-write-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`,
    true,
  );
  if (!writePreparedForReviewSave) {
    throw new Error('The saved Write document could not prepare its close-review edit.');
  }
  window.webContents.insertText(' saved on close');
  await pause(50);
  await invokeRendererMenuAction('file', 'close-write-window');
  await pause(60);
  const reviewSavePrompt = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Smoke Write') === true`,
    true,
  );
  if (!reviewSavePrompt) throw new Error('Close review did not offer to save the dirty document.');
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click();
    })()`,
    true,
  );
  let reviewSaveClosed = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    reviewSaveClosed = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Smoke Write"]') === null`,
      true,
    )) as boolean;
    if (reviewSaveClosed) break;
    await pause(25);
  }
  if (!reviewSaveClosed) throw new Error('Saving from close review did not close the document.');

  const reviewSavedWriteReopened = await window.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )].find((candidate) => candidate.textContent?.trim() === 'Smoke Write');
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!reviewSavedWriteReopened) {
    throw new Error('The document saved from close review could not be reopened.');
  }
  await pause(100);
  const reviewSavedWrite = (await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector('[data-write-title="Smoke Write"]');
      return {
        text: write?.querySelector('[data-write-editor="true"]')?.textContent ?? '',
        dirty: write?.querySelector('h2')?.textContent?.includes('•') === true
      };
    })()`,
    true,
  )) as { text: string; dirty: boolean };
  if (reviewSavedWrite.dirty || !reviewSavedWrite.text.includes('saved on close')) {
    throw new Error(
      `The close-review save did not persist the newest draft: ${JSON.stringify(reviewSavedWrite)}.`,
    );
  }
  await invokeRendererMenuAction('file', 'close-write-window');
  await pause(60);

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
  await ensureNativeInputFocus('Finder window drag');
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

  const windowDragCanceled = (await window.webContents.executeJavaScript(
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
  if (!windowDragCanceled) throw new Error('Canceled Finder geometry could not be inspected.');
  if (
    Math.abs(windowDragCanceled.left - windowDragStart.window.left) > 1 ||
    Math.abs(windowDragCanceled.top - windowDragStart.window.top) > 1
  ) {
    throw new Error('The Finder window committed a drag after pointer capture was lost.');
  }
  if (!windowDragCanceled.shadowHidden || !windowDragCanceled.draggingCleared) {
    throw new Error('The Finder drag shadow did not clear when pointer capture was lost.');
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
    await ensureNativeInputFocus('System Disk drag');
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
  await ensureNativeInputFocus('Cancelled Trash drag');
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
  await ensureNativeInputFocus('Save-failure System Disk drag');
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

  type EjectionFeedbackSnapshot = {
    appearance: string;
    artworkFilter: string;
    disk: SmokePoint;
    ejecting: boolean;
    flashNumber: number;
    glyph: SmokePoint;
    glyphBackground: string;
    inputBlocked: boolean;
    inverted: boolean;
    label: SmokePoint;
    labelBackground: string;
    labelColor: string;
  };
  const readEjectionFeedback = async (): Promise<EjectionFeedbackSnapshot | null> =>
    (await window.webContents.executeJavaScript(
      `(() => {
        const disk = document.querySelector('[data-desktop-icon="system-disk"]');
        const glyph = disk?.querySelector('.desktop-icon-glyph');
        const artwork = glyph?.querySelector('[data-pixel-icon="disk"]');
        const label = disk?.querySelector('[data-desktop-icon-label="system-disk"]');
        if (!(disk instanceof HTMLElement) || !(glyph instanceof HTMLElement) ||
            !(artwork instanceof SVGElement) || !(label instanceof HTMLElement)) return null;
        const center = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            x: Math.round(bounds.left + bounds.width / 2),
            y: Math.round(bounds.top + bounds.height / 2)
          };
        };
        const glyphStyle = getComputedStyle(glyph);
        const artworkStyle = getComputedStyle(artwork);
        const labelStyle = getComputedStyle(label);
        return {
          appearance: disk.dataset.ejectionFlashAppearance ?? '',
          artworkFilter: artworkStyle.filter,
          disk: center(disk),
          ejecting: disk.classList.contains('is-ejecting'),
          flashNumber: Number(disk.dataset.ejectionFlashNumber ?? 0),
          glyph: center(glyph),
          glyphBackground: glyphStyle.backgroundColor,
          inputBlocked: document.querySelector('.ejection-input-layer') !== null,
          inverted: disk.classList.contains('is-ejection-inverted'),
          label: center(label),
          labelBackground: labelStyle.backgroundColor,
          labelColor: labelStyle.color
        };
      })()`,
      true,
    )) as EjectionFeedbackSnapshot | null;

  const waitForEjectionFlashPhase = async (
    origin: EjectionFeedbackSnapshot,
    flashNumber: 1 | 2,
    appearance: 'inverted' | 'normal',
    expectedFinalizationRequests: number,
  ): Promise<EjectionFeedbackSnapshot> => {
    let latest: EjectionFeedbackSnapshot | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      latest = await readEjectionFeedback();
      if (latest?.flashNumber === flashNumber && latest.appearance === appearance) break;
      await pause(8);
    }
    if (!latest || latest.flashNumber !== flashNumber || latest.appearance !== appearance) {
      throw new Error(
        `Ejection did not reach flash ${flashNumber} ${appearance}: ${JSON.stringify(latest)}.`,
      );
    }

    const moved = (point: SmokePoint, expected: SmokePoint): boolean =>
      Math.hypot(point.x - expected.x, point.y - expected.y) > 1;
    const expectedInverted = appearance === 'inverted';
    const paintMatches = expectedInverted
      ? latest.glyphBackground === 'rgb(0, 0, 0)' && latest.artworkFilter === 'invert(1)'
      : latest.glyphBackground === 'rgba(0, 0, 0, 0)' && latest.artworkFilter === 'none';
    if (
      !latest.ejecting ||
      latest.inverted !== expectedInverted ||
      !paintMatches ||
      latest.labelBackground !== 'rgb(255, 255, 255)' ||
      latest.labelColor !== 'rgb(0, 0, 0)' ||
      !latest.inputBlocked ||
      moved(latest.disk, origin.disk) ||
      moved(latest.glyph, origin.glyph) ||
      moved(latest.label, origin.label) ||
      quitRequested ||
      smokeEjectFinalizationRequestCount !== expectedFinalizationRequests
    ) {
      throw new Error(
        `Ejection flash ${flashNumber} ${appearance} violated stationary feedback or transaction ordering: ${JSON.stringify(
          {
            expectedFinalizationRequests,
            finalizationRequests: smokeEjectFinalizationRequestCount,
            latest,
            origin,
            quitRequested,
          },
        )}.`,
      );
    }

    return latest;
  };

  const assertTwoFlashEjectionSequence = async (
    origin: EjectionFeedbackSnapshot,
    expectedFinalizationRequests: number,
  ): Promise<void> => {
    for (const phase of [
      { appearance: 'inverted', flashNumber: 1 },
      { appearance: 'normal', flashNumber: 1 },
      { appearance: 'inverted', flashNumber: 2 },
      { appearance: 'normal', flashNumber: 2 },
    ] as const) {
      await waitForEjectionFlashPhase(
        origin,
        phase.flashNumber,
        phase.appearance,
        expectedFinalizationRequests,
      );
    }
  };

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

  await ensureNativeInputFocus('System Disk selection');
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
  await ensureNativeInputFocus('Trash label selection');
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
  const directTrashDocumentOpened = await window.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector(
        '[data-finder-window="window-trash"] [data-vfs-item="welcome"]'
      );
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!directTrashDocumentOpened) throw new Error('A direct Trash document could not be opened.');
  await waitForWriteLayout('[data-write-title="Welcome"]', 'Direct Trash Write document');
  const directTrashCanonicalParent = (await loadState()).nodes.find(
    (node) => node.id === 'welcome',
  )?.parentId;
  if (directTrashCanonicalParent !== 'trash') {
    throw new Error(
      `The direct Trash guard did not have a canonical Trash document: ${String(directTrashCanonicalParent)}.`,
    );
  }
  const directTrashFinderActivated = await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-trash"]');
      if (!(finder instanceof HTMLElement)) return false;
      finder.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerId: 9101,
        pointerType: 'mouse'
      }));
      return true;
    })()`,
    true,
  );
  if (!directTrashFinderActivated) throw new Error('Trash could not regain menu ownership.');
  await pause(40);
  const directTrashEmptyGuard = (await window.webContents.executeJavaScript(
    `(async () => {
      const menu = document.querySelector('[data-menu="special"]');
      if (!(menu instanceof HTMLButtonElement)) return null;
      if (menu.getAttribute('aria-expanded') !== 'true') {
        menu.click();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      const action = document.querySelector('[data-menu-action="empty-trash"]');
      const write = document.querySelector('[data-write-title="Welcome"]');
      return {
        actionPresent: action instanceof HTMLButtonElement,
        disabled: action instanceof HTMLButtonElement && action.disabled,
        documentId: write?.getAttribute('data-document-id') ?? null,
        menus: [...document.querySelectorAll('[data-menu]')]
          .map((candidate) => candidate.getAttribute('data-menu')),
        trashContainsWelcome:
          document.querySelector(
            '[data-finder-window="window-trash"] [data-vfs-item="welcome"]'
          ) !== null,
        writeOpen: write !== null
      };
    })()`,
    true,
  )) as {
    actionPresent: boolean;
    disabled: boolean;
    documentId: string | null;
    menus: (string | null)[];
    trashContainsWelcome: boolean;
    writeOpen: boolean;
  } | null;
  if (
    !directTrashEmptyGuard?.actionPresent ||
    !directTrashEmptyGuard.disabled ||
    directTrashEmptyGuard.documentId !== 'welcome' ||
    directTrashEmptyGuard.menus.join(',') !== 'system,file,edit,view,special' ||
    !directTrashEmptyGuard.trashContainsWelcome ||
    !directTrashEmptyGuard.writeOpen
  ) {
    throw new Error(
      `An open direct Trash document did not block Empty Trash: ${JSON.stringify(directTrashEmptyGuard)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `(() => {
      document.querySelector('[data-menu="special"]')?.click();
      document.querySelector('[aria-label="Close Welcome"]')?.click();
    })()`,
    true,
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const directWriteClosed = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Welcome"]') === null`,
      true,
    )) as boolean;
    if (directWriteClosed) break;
    if (attempt === 59) throw new Error('The direct Trash Write document did not close.');
    await pause(20);
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-finder-window="window-trash"]')?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerId: 9103,
        pointerType: 'mouse'
      })
    )`,
    true,
  );
  await pause(40);
  const directTrashGuardRestored = await window.webContents.executeJavaScript(
    `(async () => {
      const menu = document.querySelector('[data-menu="special"]');
      if (!(menu instanceof HTMLButtonElement)) return false;
      if (menu.getAttribute('aria-expanded') !== 'true') {
        menu.click();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      const action = document.querySelector('[data-menu-action="empty-trash"]');
      return action instanceof HTMLButtonElement && !action.disabled;
    })()`,
    true,
  );
  if (!directTrashGuardRestored) {
    throw new Error('Closing the direct Trash document did not restore Empty Trash.');
  }
  await window.webContents.executeJavaScript(
    `(() => {
      document.querySelector('[data-menu="special"]')?.click();
      document.querySelector('[aria-label="Close Trash"]')?.click();
    })()`,
    true,
  );
  await pause(50);

  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-finder-window]').forEach((finder) => {
      if (finder instanceof HTMLElement) {
        finder.style.pointerEvents = 'none';
        finder.style.setProperty('--icon-hit-pointer-events', 'none');
      }
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
      if (finder instanceof HTMLElement) {
        finder.style.removeProperty('pointer-events');
        finder.style.removeProperty('--icon-hit-pointer-events');
      }
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
  await ensureNativeInputFocus('Scaled ordinary-item Trash drag');
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
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-system-disk"]');
      if (!(finder instanceof HTMLElement)) return;
      finder.style.setProperty('pointer-events', 'none');
      finder.style.setProperty('--icon-hit-pointer-events', 'none');
    })()`,
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

  const nestedTrashDocumentOpened = await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return false;
      trash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!nestedTrashDocumentOpened) throw new Error('Trash could not open for its nested guard.');
  await pause(100);
  for (const step of [
    { windowId: 'window-trash', itemId: 'documents', label: 'Documents' },
    { windowId: 'window-documents', itemId: 'system-folder', label: 'System Folder' },
    { windowId: 'window-system-folder', itemId: 'finder-notes', label: 'Finder Notes' },
  ]) {
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector(${JSON.stringify(
          `[data-finder-window="${step.windowId}"] [data-vfs-item="${step.itemId}"]`,
        )});
        if (!(item instanceof HTMLElement)) return false;
        item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
        return true;
      })()`,
      true,
    );
    if (!opened) {
      throw new Error(`The nested Trash guard could not open ${step.label}.`);
    }
    await pause(80);
  }
  await waitForWriteLayout('[data-write-title="Finder Notes"]', 'Nested Trash Write document');
  const nestedTrashFinderActivated = await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-system-folder"]');
      if (!(finder instanceof HTMLElement)) return false;
      finder.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        pointerId: 9102,
        pointerType: 'mouse'
      }));
      return true;
    })()`,
    true,
  );
  if (!nestedTrashFinderActivated) {
    throw new Error('The nested Trash folder could not regain menu ownership.');
  }
  await pause(40);
  const nestedTrashEmptyGuard = (await window.webContents.executeJavaScript(
    `(async () => {
      const menu = document.querySelector('[data-menu="special"]');
      if (!(menu instanceof HTMLButtonElement)) return null;
      if (menu.getAttribute('aria-expanded') !== 'true') {
        menu.click();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      const action = document.querySelector('[data-menu-action="empty-trash"]');
      return {
        actionPresent: action instanceof HTMLButtonElement,
        disabled: action instanceof HTMLButtonElement && action.disabled,
        writeOpen: document.querySelector('[data-write-title="Finder Notes"]') !== null
      };
    })()`,
    true,
  )) as { actionPresent: boolean; disabled: boolean; writeOpen: boolean } | null;
  if (
    !nestedTrashEmptyGuard?.actionPresent ||
    !nestedTrashEmptyGuard.disabled ||
    !nestedTrashEmptyGuard.writeOpen
  ) {
    throw new Error(
      `An open nested Trash document did not block Empty Trash: ${JSON.stringify(nestedTrashEmptyGuard)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `(() => {
      document.querySelector('[data-menu="special"]')?.click();
      document.querySelector('[aria-label="Close Finder Notes"]')?.click();
      for (const label of ['System Folder', 'Documents', 'Trash']) {
        document.querySelector('[aria-label="Close ' + label + '"]')?.click();
      }
    })()`,
    true,
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const nestedWindowsClosed = (await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Finder Notes"]') === null &&
        document.querySelector('[data-finder-window="window-system-folder"]') === null &&
        document.querySelector('[data-finder-window="window-documents"]') === null &&
        document.querySelector('[data-finder-window="window-trash"]') === null`,
      true,
    )) as boolean;
    if (nestedWindowsClosed) break;
    if (attempt === 59) throw new Error('Nested Trash guard windows did not close.');
    await pause(20);
  }

  window.webContents.setZoomFactor(1);
  window.setContentSize(1152, 768);
  await pause(140);
  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry did not recover after scaled testing.');

  const repositionTarget = { x: 137, y: 343 };
  await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return;
      trash.style.setProperty('pointer-events', 'none');
      trash.style.setProperty('--icon-hit-pointer-events', 'none');
    })()`,
    true,
  );
  await sendDrag(desktopGeometry.disk, repositionTarget, true);
  await pause(260);
  await assertRejectedDiskRelease(repositionTarget, 'The free desktop release');
  await window.webContents.executeJavaScript(
    `(() => {
      const trash = document.querySelector('[data-desktop-icon="trash"]');
      if (!(trash instanceof HTMLElement)) return;
      trash.style.removeProperty('pointer-events');
      trash.style.removeProperty('--icon-hit-pointer-events');
    })()`,
    true,
  );

  desktopGeometry = await readDesktopGeometry();
  if (!desktopGeometry) throw new Error('Desktop geometry disappeared before ejection.');

  const ejectionWriteOpened = await window.webContents.executeJavaScript(
    `(() => {
      const write = document.querySelector(
        '[data-finder-window="window-applications"] [data-vfs-item="write"]'
      );
      if (!(write instanceof HTMLElement)) return false;
      write.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!ejectionWriteOpened) {
    throw new Error('The ejection review could not open its first dirty Write document.');
  }
  await pause(80);
  await ensureNativeInputFocus('First ejection-review Write document');
  await window.webContents.executeJavaScript(
    `document.querySelector('.write-window.is-active [data-write-editor="true"]')?.focus()`,
    true,
  );
  await window.webContents.insertText('First eject draft');
  await invokeRendererMenuAction('file', 'new-document');
  await pause(70);
  await ensureNativeInputFocus('Second ejection-review Write document');
  await window.webContents.executeJavaScript(
    `document.querySelector('.write-window.is-active [data-write-editor="true"]')?.focus()`,
    true,
  );
  await window.webContents.insertText('Second eject draft');
  await pause(60);
  const dirtyEjectionDocuments = (await window.webContents.executeJavaScript(
    `(() => ({
      count: document.querySelectorAll('[data-write-window]').length,
      dirtyCount: [...document.querySelectorAll('[data-write-window]')]
        .filter((write) => write.querySelector('h2')?.textContent?.includes('•')).length
    }))()`,
    true,
  )) as { count: number; dirtyCount: number };
  if (dirtyEjectionDocuments.count !== 2 || dirtyEjectionDocuments.dirtyCount !== 2) {
    throw new Error(
      `The ejection review did not prepare two dirty documents: ${JSON.stringify(dirtyEjectionDocuments)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-write-window]').forEach((write) => {
      if (write instanceof HTMLElement) write.style.pointerEvents = 'none';
    })`,
    true,
  );

  const cancelledEjectOrigin = desktopGeometry.disk;
  let ejectPoint = trashProbePoints(desktopGeometry).insideEdge;
  await beginDrag(cancelledEjectOrigin, ejectPoint, true);
  await waitForTrashHighlight(true);
  releaseDrag(ejectPoint);
  await pause(70);
  const firstEjectionReview = (await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      return {
        text: dialog?.textContent?.trim() ?? '',
        ejecting: disk?.classList.contains('is-ejecting') === true,
        writeCount: document.querySelectorAll('[data-write-window]').length
      };
    })()`,
    true,
  )) as { text: string; ejecting: boolean; writeCount: number };
  if (
    !firstEjectionReview.text.includes('Document 1 of 2') ||
    firstEjectionReview.ejecting ||
    firstEjectionReview.writeCount !== 2 ||
    quitRequested
  ) {
    throw new Error(
      `Ejection did not pause for its first dirty document: ${JSON.stringify(firstEjectionReview)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Don’t Save')
        ?.click();
    })()`,
    true,
  );
  await pause(60);
  const secondEjectionReview = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Document 2 of 2') === true`,
    true,
  );
  if (!secondEjectionReview) {
    throw new Error('Ejection did not advance to its second dirty document.');
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Cancel')
        ?.click();
    })()`,
    true,
  );
  await pause(280);
  const cancelledEjection = (await window.webContents.executeJavaScript(
    `(() => {
      const disk = document.querySelector('[data-desktop-icon="system-disk"]');
      if (!(disk instanceof HTMLElement)) return null;
      const bounds = disk.getBoundingClientRect();
      return {
        dialogOpen: document.querySelector('[aria-label="Save Changes"]') !== null,
        dirtyCount: [...document.querySelectorAll('[data-write-window]')]
          .filter((write) => write.querySelector('h2')?.textContent?.includes('•')).length,
        ejecting: disk.classList.contains('is-ejecting'),
        disk: {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2)
        }
      };
    })()`,
    true,
  )) as {
    dialogOpen: boolean;
    dirtyCount: number;
    ejecting: boolean;
    disk: SmokePoint;
  } | null;
  if (
    !cancelledEjection ||
    cancelledEjection.dialogOpen ||
    cancelledEjection.dirtyCount !== 2 ||
    cancelledEjection.ejecting ||
    Math.hypot(
      cancelledEjection.disk.x - cancelledEjectOrigin.x,
      cancelledEjection.disk.y - cancelledEjectOrigin.y,
    ) > 2 ||
    quitRequested
  ) {
    throw new Error(
      `Cancel did not restore the ejection and every dirty draft: ${JSON.stringify(cancelledEjection)}.`,
    );
  }

  const beginReviewedEjection = async (description: string): Promise<EjectionFeedbackSnapshot> => {
    desktopGeometry = await readDesktopGeometry();
    const origin = await readEjectionFeedback();
    if (!desktopGeometry || !origin) {
      throw new Error(`${description} could not measure System Disk before ejection.`);
    }
    ejectPoint = trashProbePoints(desktopGeometry).insideEdge;
    await beginDrag(desktopGeometry.disk, ejectPoint, true);
    await waitForTrashHighlight(true);
    releaseDrag(ejectPoint);

    await pause(60);
    for (let position = 1; position <= 2; position += 1) {
      const reviewReady = await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Document ${position} of 2') === true`,
        true,
      );
      if (!reviewReady) {
        throw new Error(`${description} did not review dirty document ${position} of 2.`);
      }
      await window.webContents.executeJavaScript(
        `(() => {
          const dialog = document.querySelector('[aria-label="Save Changes"]');
          [...(dialog?.querySelectorAll('button') ?? [])]
            .find((button) => button.textContent?.trim() === 'Don’t Save')
            ?.click();
        })()`,
        true,
      );
      await pause(position === 1 ? 60 : 20);
    }
    return origin;
  };

  const lastEjectBeforeFailure = (await loadState()).desktop.lastEjectAt;
  smokeSaveFailureTarget = 'eject';
  const failedEjectionOrigin = await beginReviewedEjection('Failed ejection');
  await assertTwoFlashEjectionSequence(failedEjectionOrigin, 0);

  let failedEjectionRecovered = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    failedEjectionRecovered = (await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Persistence error"]') !== null &&
        document.querySelector('[data-desktop-icon="system-disk"]')
          ?.classList.contains('is-ejecting') === false`,
      true,
    )) as boolean;
    if (failedEjectionRecovered) break;
    await pause(15);
  }
  const recoveredEjection = await readEjectionFeedback();
  const stateAfterFailedEjection = await loadState();
  if (
    !failedEjectionRecovered ||
    !recoveredEjection ||
    recoveredEjection.appearance !== '' ||
    recoveredEjection.flashNumber !== 0 ||
    recoveredEjection.inputBlocked ||
    Math.hypot(
      recoveredEjection.disk.x - failedEjectionOrigin.disk.x,
      recoveredEjection.disk.y - failedEjectionOrigin.disk.y,
    ) > 1 ||
    quitRequested ||
    smokeEjectFinalizationRequestCount !== 1 ||
    stateAfterFailedEjection.desktop.lastEjectAt !== lastEjectBeforeFailure
  ) {
    throw new Error(
      `Failed ejection did not restore a recoverable disk and unchanged eject timestamp: ${JSON.stringify(
        {
          failedEjectionRecovered,
          finalizationRequests: smokeEjectFinalizationRequestCount,
          lastEjectAfterFailure: stateAfterFailedEjection.desktop.lastEjectAt,
          lastEjectBeforeFailure,
          quitRequested,
          recoveredEjection,
        },
      )}.`,
    );
  }
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="Persistence error"] button\')?.click()',
    true,
  );
  await pause(260);

  const successfulEjectionOrigin = await beginReviewedEjection('Successful ejection');
  await assertTwoFlashEjectionSequence(successfulEjectionOrigin, 1);

  setTimeout(() => {
    if (!quitRequested || smokeEjectFinalizationRequestCount !== 2) {
      console.error(
        `Disk-to-Trash gesture did not request one successful application quit after its failed retry: ${JSON.stringify(
          { quitRequested, smokeEjectFinalizationRequestCount },
        )}.`,
      );
      app.exit(1);
    }
  }, 8_000);
};

const runPersistenceProbe = async (window: BrowserWindow): Promise<void> => {
  await waitForRenderer(window);
  const transientWriteState = (await window.webContents.executeJavaScript(
    `(() => ({
      windows: document.querySelectorAll('[data-write-window]').length,
      fileDialogs: document.querySelectorAll('[data-write-file-dialog]').length,
      saveReviews: document.querySelectorAll('[aria-label="Save Changes"]').length
    }))()`,
    true,
  )) as { windows: number; fileDialogs: number; saveReviews: number };
  if (
    transientWriteState.windows !== 0 ||
    transientWriteState.fileDialogs !== 0 ||
    transientWriteState.saveReviews !== 0
  ) {
    throw new Error(
      `Relaunch restored transient Write session state: ${JSON.stringify(transientWriteState)}.`,
    );
  }
  const writeItemOpened = await window.webContents.executeJavaScript(
    `(() => {
      const item = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )].find((candidate) => candidate.textContent?.trim() === 'Smoke Write');
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!writeItemOpened) throw new Error('Persistence probe could not locate Smoke Write.');
  let reopenedWriteSession: {
    clean: boolean;
    zoom75: boolean;
    pageCount: number;
    layoutState: string | null;
    layoutGeneration: number;
    expandedSelection: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    reopenedWriteSession = (await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Smoke Write"]');
        const editor = write?.querySelector('[data-write-editor="true"]');
        const pages = write?.querySelector('.write-page-stack');
        if (
          !(write instanceof HTMLElement) ||
          !(editor instanceof HTMLElement) ||
          !(pages instanceof HTMLElement)
        ) return null;
        const selection = window.getSelection();
        return {
          clean: write.querySelector('h2')?.textContent?.includes('•') !== true,
          zoom75: write.querySelector('.write-status-bar')?.textContent?.includes('75%') === true,
          pageCount: Number(pages.getAttribute('data-page-count') ?? '0'),
          layoutState: pages.getAttribute('data-write-layout-state'),
          layoutGeneration: Number(pages.getAttribute('data-write-layout-generation') ?? '0'),
          expandedSelection:
            Boolean(selection && !selection.isCollapsed && editor.contains(selection.anchorNode))
        };
      })()`,
      true,
    )) as {
      clean: boolean;
      zoom75: boolean;
      pageCount: number;
      layoutState: string | null;
      layoutGeneration: number;
      expandedSelection: boolean;
    } | null;
    if (
      reopenedWriteSession?.layoutState === 'stable' &&
      reopenedWriteSession.layoutGeneration > 0
    ) {
      break;
    }
    await pause(25);
  }
  const historyMenuOpened = (await window.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('[data-menu="edit"]');
      if (!(menu instanceof HTMLElement)) return false;
      menu.click();
      return true;
    })()`,
    true,
  )) as boolean;
  if (!historyMenuOpened) throw new Error('Persistence probe could not open the Edit menu.');
  await pause(20);
  const historyReset = (await window.webContents.executeJavaScript(
    `(() => {
      const undo = document.querySelector('[data-menu-action="undo"]');
      const redo = document.querySelector('[data-menu-action="redo"]');
      const result = {
        undoDisabled: undo instanceof HTMLButtonElement && undo.disabled,
        redoDisabled: redo instanceof HTMLButtonElement && redo.disabled
      };
      document.querySelector('[data-menu="edit"]')?.click();
      return result;
    })()`,
    true,
  )) as { undoDisabled: boolean; redoDisabled: boolean } | null;
  if (
    !reopenedWriteSession ||
    !reopenedWriteSession.clean ||
    !reopenedWriteSession.zoom75 ||
    reopenedWriteSession.pageCount !== 2 ||
    reopenedWriteSession.layoutState !== 'stable' ||
    reopenedWriteSession.layoutGeneration <= 0 ||
    reopenedWriteSession.expandedSelection ||
    !historyReset?.undoDisabled ||
    !historyReset.redoDisabled
  ) {
    throw new Error(
      `Reopened Write restored transient session state: ${JSON.stringify({ reopenedWriteSession, historyReset })}.`,
    );
  }
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
    const write = document.querySelector('[data-write-title="Smoke Write"]');
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
      startedWithoutWriteWindows: ${transientWriteState.windows === 0},
      writeReopened: write instanceof HTMLElement,
      writeFormat: write?.getAttribute('data-document-format') ?? '',
      writeText: write?.querySelector('[data-write-editor="true"]')?.textContent ?? '',
      writeClean: ${reopenedWriteSession.clean},
      writeZoom75: ${reopenedWriteSession.zoom75},
      writePageCount: ${reopenedWriteSession.pageCount},
      writeLayoutState: ${JSON.stringify(reopenedWriteSession.layoutState)},
      writeLayoutGeneration: ${reopenedWriteSession.layoutGeneration},
      writeExpandedSelection: ${reopenedWriteSession.expandedSelection},
      writeUndoDisabled: ${historyReset.undoDisabled},
      writeRedoDisabled: ${historyReset.redoDisabled},
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

  const writeOpened = await window.webContents.executeJavaScript(
    `(() => {
      const documentItem = [...document.querySelectorAll(
        '[data-finder-window="window-system-disk"] [data-vfs-item]'
      )].find((candidate) => candidate.textContent?.trim() === 'Smoke Write');
      if (!(documentItem instanceof HTMLElement)) return false;
      documentItem.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return true;
    })()`,
    true,
  );
  if (!writeOpened) throw new Error('Normal-quit probe could not open the saved Write document.');
  await pause(80);
  await window.webContents.executeJavaScript(
    `document.querySelector('.write-window.is-active [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.insertText('First dirty document');
  await pause(40);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu="file"]')?.click()`,
    true,
  );
  await pause(20);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-menu-action="new-document"]')?.click()`,
    true,
  );
  await pause(70);
  await window.webContents.executeJavaScript(
    `document.querySelector('.write-window.is-active [data-write-editor="true"]')?.focus()`,
    true,
  );
  window.webContents.insertText('Second dirty document');
  await pause(50);

  const discardCloseStarted = await window.webContents.executeJavaScript(
    `(() => {
      const close = document.querySelector('.write-window.is-active .window-close');
      if (!(close instanceof HTMLButtonElement)) return false;
      close.click();
      return true;
    })()`,
    true,
  );
  if (!discardCloseStarted) {
    throw new Error('Normal-quit probe could not start the dirty discard-close race.');
  }
  await pause(25);
  await window.webContents.executeJavaScript(
    `(() => {
      window.__macintoshSmokeDiscardCloseAnimation = new Promise((resolve) => {
        const surface = document.querySelector('.desktop-surface');
        if (!(surface instanceof HTMLElement)) {
          resolve(null);
          return;
        }
        const observer = new MutationObserver(() => {
          const write = document.querySelector('[data-write-title="Untitled"]');
          const windowId = write?.getAttribute('data-write-window');
          const outline = windowId
            ? document.querySelector('[data-window-animation-shadow="' + windowId + '"]')
            : null;
          if (
            !(write instanceof HTMLElement) ||
            !(outline instanceof HTMLElement) ||
            write.getAttribute('data-closing') !== 'true'
          ) return;
          const animation = outline.getAnimations().find(
            (candidate) => candidate.animationName === 'finder-window-close'
          );
          if (!animation) return;
          observer.disconnect();
          animation.pause();
          const frameStyle = getComputedStyle(write);
          const outlineStyle = getComputedStyle(outline);
          resolve({
            frameAnimation: frameStyle.animationName,
            frameTransform: frameStyle.transform,
            frameVisibility: frameStyle.visibility,
            outlineAnimation: outlineStyle.animationName,
            outlinePointerEvents: outlineStyle.pointerEvents,
            paused: animation.playState === 'paused'
          });
        });
        observer.observe(surface, {
          attributes: true,
          attributeFilter: ['class', 'data-closing'],
          childList: true,
          subtree: true
        });
        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, 300);
      });
    })()`,
    true,
  );
  const discardConfirmed = await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      const discard = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Don’t Save');
      if (!(discard instanceof HTMLButtonElement)) return false;
      discard.click();
      return true;
    })()`,
    true,
  );
  if (!discardConfirmed) {
    throw new Error('Normal-quit probe could not authorize the dirty discard close.');
  }
  const discardAnimationActive = (await window.webContents.executeJavaScript(
    'window.__macintoshSmokeDiscardCloseAnimation',
    true,
  )) as {
    frameAnimation: string;
    frameTransform: string;
    frameVisibility: string;
    outlineAnimation: string;
    outlinePointerEvents: string;
    paused: boolean;
  } | null;
  if (
    !discardAnimationActive?.paused ||
    discardAnimationActive.frameAnimation !== 'none' ||
    discardAnimationActive.frameTransform !== 'none' ||
    discardAnimationActive.frameVisibility !== 'hidden' ||
    discardAnimationActive.outlineAnimation !== 'finder-window-close' ||
    discardAnimationActive.outlinePointerEvents !== 'none'
  ) {
    throw new Error(
      `The dirty Write outline close did not begin before native Quit: ${JSON.stringify(discardAnimationActive)}.`,
    );
  }
  window.close();
  await pause(80);
  const firstReview = (await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      return {
        open: dialog instanceof HTMLElement,
        text: dialog?.textContent?.trim() ?? '',
        writeCount: document.querySelectorAll('[data-write-window]').length
      };
    })()`,
    true,
  )) as { open: boolean; text: string; writeCount: number };
  if (
    !firstReview.open ||
    firstReview.writeCount !== 2 ||
    !firstReview.text.includes('Document 1 of 2') ||
    !firstReview.text.includes('Smoke Write')
  ) {
    throw new Error(
      `Normal Quit did not begin a two-document review: ${JSON.stringify(firstReview)}.`,
    );
  }
  smokeSaveFailureTarget = 'vfs';
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click();
    })()`,
    true,
  );
  let quitDocumentSaveFailure: {
    message: string;
    dialogOpen: boolean;
    dirty: boolean;
    activeTitle: string | null;
    normalQuitPending: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    quitDocumentSaveFailure = (await window.webContents.executeJavaScript(
      `(() => {
        const alert = document.querySelector('[aria-label="Persistence error"]');
        const activeWrite = document.querySelector('.write-window.is-active');
        if (!(alert instanceof HTMLElement) || !(activeWrite instanceof HTMLElement)) return null;
        return {
          message: alert.textContent?.trim() ?? '',
          dialogOpen: document.querySelector('[aria-label="Save Changes"]') !== null,
          dirty: activeWrite.querySelector('h2')?.textContent?.includes('•') === true,
          activeTitle: activeWrite.getAttribute('data-write-title'),
          normalQuitPending:
            document.querySelector('.macintosh')?.getAttribute('data-normal-quit-pending') === 'true'
        };
      })()`,
      true,
    )) as {
      message: string;
      dialogOpen: boolean;
      dirty: boolean;
      activeTitle: string | null;
      normalQuitPending: boolean;
    } | null;
    if (quitDocumentSaveFailure) break;
    await pause(25);
  }
  if (
    !quitDocumentSaveFailure ||
    !quitDocumentSaveFailure.message.includes('could not be saved') ||
    quitDocumentSaveFailure.dialogOpen ||
    !quitDocumentSaveFailure.dirty ||
    quitDocumentSaveFailure.activeTitle !== 'Smoke Write' ||
    quitDocumentSaveFailure.normalQuitPending
  ) {
    throw new Error(
      `A document-save failure did not abort normal Quit recoverably: ${JSON.stringify(quitDocumentSaveFailure)}.`,
    );
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Persistence error"] button')?.click()`,
    true,
  );
  await pause(80);
  window.close();
  await pause(80);
  const retriedFirstReview = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Document 1 of 2') === true`,
    true,
  );
  if (!retriedFirstReview) {
    throw new Error('Normal Quit did not restart cleanly after a document-save failure.');
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Don’t Save')
        ?.click();
    })()`,
    true,
  );
  await pause(60);
  const secondReview = await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Save Changes"]')?.textContent?.includes('Document 2 of 2') === true`,
    true,
  );
  if (!secondReview) throw new Error('Normal Quit did not advance to the second dirty document.');
  await window.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('[aria-label="Save Changes"]');
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Cancel')
        ?.click();
    })()`,
    true,
  );
  await pause(100);
  const quitCancelled = (await window.webContents.executeJavaScript(
    `(() => ({
      dialogOpen: document.querySelector('[aria-label="Save Changes"]') !== null,
      dirtyCount: [...document.querySelectorAll('[data-write-window]')]
        .filter((write) => write.querySelector('h2')?.textContent?.includes('•')).length,
      normalQuitPending:
        document.querySelector('.macintosh')?.getAttribute('data-normal-quit-pending') ?? ''
    }))()`,
    true,
  )) as { dialogOpen: boolean; dirtyCount: number; normalQuitPending: string };
  if (
    quitCancelled.dialogOpen ||
    quitCancelled.dirtyCount !== 2 ||
    quitCancelled.normalQuitPending
  ) {
    throw new Error(`Cancel did not resume after normal Quit: ${JSON.stringify(quitCancelled)}.`);
  }

  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await window.webContents.executeJavaScript(
      `document.querySelector('.write-window.is-active .window-close')?.click()`,
      true,
    );
    await pause(40);
    await window.webContents.executeJavaScript(
      `(() => {
        const dialog = document.querySelector('[aria-label="Save Changes"]');
        [...(dialog?.querySelectorAll('button') ?? [])]
          .find((button) => button.textContent?.trim() === 'Don’t Save')
          ?.click();
      })()`,
      true,
    );
    await pause(50);
  }
  const dirtyWindowsCleared = await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-write-window]').length === 0`,
    true,
  );
  if (!dirtyWindowsCleared)
    throw new Error('Normal-quit probe could not close its dirty documents.');

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
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  await pause(100);
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('[data-finder-window]').forEach((finder) => {
      if (
        finder instanceof HTMLElement &&
        finder.dataset.finderWindow !== 'window-applications'
      ) {
        finder.style.pointerEvents = 'none';
        finder.style.setProperty('--icon-hit-pointer-events', 'none');
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
  let syntheticMoveFallback = false;
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
  if (
    !moveCaptureOwned &&
    moveInputReadiness?.documentFocused === false &&
    moveInputReadiness.hitHandle &&
    moveInputReadiness.hitWindow === 'window-applications' &&
    !moveInputReadiness.normalQuitPending &&
    !moveInputReadiness.persistenceAlertPresent
  ) {
    syntheticMoveFallback = (await window.webContents.executeJavaScript(
      `(() => {
        const handle = document.querySelector(
          '[data-finder-window="window-applications"] [data-window-drag-handle="true"]'
        );
        if (!(handle instanceof HTMLElement)) return false;
        let captured = false;
        handle.setPointerCapture = () => { captured = true; };
        handle.hasPointerCapture = () => captured;
        handle.releasePointerCapture = () => { captured = false; };
        const pointerId = 901;
        const dispatch = (type, x, y, buttons) =>
          handle.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons,
            clientX: x,
            clientY: y,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse'
          }));
        dispatch('pointerdown', ${committedMove.pointer.x}, ${committedMove.pointer.y}, 1);
        for (let step = 1; step <= 3; step += 1) {
          const progress = step / 3;
          dispatch(
            'pointermove',
            Math.round(${committedMove.pointer.x} + (${moveDestination.x} - ${committedMove.pointer.x}) * progress),
            Math.round(${committedMove.pointer.y} + (${moveDestination.y} - ${committedMove.pointer.y}) * progress),
            1
          );
        }
        dispatch('pointerup', ${moveDestination.x}, ${moveDestination.y}, 0);
        return true;
      })()`,
      true,
    )) as boolean;
    moveCaptureOwned = syntheticMoveFallback;
    await pause(30);
  }
  if (!moveCaptureOwned) {
    throw new Error(
      `Normal-quit presentation move did not acquire native pointer capture: ${JSON.stringify(moveInputReadiness)}.`,
    );
  }
  if (!syntheticMoveFallback) {
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
  }
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
  let resizeCaptureOwned = false;
  if (syntheticMoveFallback) {
    resizeCaptureOwned = (await window.webContents.executeJavaScript(
      `(() => {
        const grow = document.querySelector(
          '[data-finder-window="window-applications"] [aria-label="Resize Applications"]'
        );
        if (!(grow instanceof HTMLElement)) return false;
        let captured = false;
        grow.setPointerCapture = () => { captured = true; };
        grow.hasPointerCapture = () => captured;
        grow.releasePointerCapture = () => { captured = false; };
        const pointerId = 902;
        const dispatch = (type, x, y, buttons) =>
          grow.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons,
            clientX: x,
            clientY: y,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse'
          }));
        dispatch(
          'pointerdown',
          ${provisionalResize.pointer.x},
          ${provisionalResize.pointer.y},
          1
        );
        for (let step = 1; step <= 3; step += 1) {
          const progress = step / 3;
          dispatch(
            'pointermove',
            Math.round(${provisionalResize.pointer.x} + (${provisionalDestination.x} - ${provisionalResize.pointer.x}) * progress),
            Math.round(${provisionalResize.pointer.y} + (${provisionalDestination.y} - ${provisionalResize.pointer.y}) * progress),
            1
          );
        }
        return captured;
      })()`,
      true,
    )) as boolean;
    await pause(20);
  } else {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...provisionalResize.pointer });
    await pause(16);
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...provisionalResize.pointer,
    });
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
  if (!syntheticMoveFallback) {
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
  }
  const provisionalResizeState = (await window.webContents.executeJavaScript(
    `(() => {
      const finder = document.querySelector('[data-finder-window="window-applications"]');
      const grow = finder?.querySelector('[aria-label="Resize Applications"]');
      const outline = finder?.querySelector('.window-drag-shadow');
      const pointerId = window.__macintoshSmokeNormalQuitResizePointerId;
      if (
        !(finder instanceof HTMLElement) ||
        !(grow instanceof HTMLElement) ||
        !(outline instanceof HTMLElement)
      ) return null;
      const frameBounds = finder.getBoundingClientRect();
      const outlineBounds = outline.getBoundingClientRect();
      return {
        width: Number.parseFloat(finder.style.width),
        height: Number.parseFloat(finder.style.height),
        renderedWidth: frameBounds.width,
        renderedHeight: frameBounds.height,
        outlineWidth: outlineBounds.width,
        outlineHeight: outlineBounds.height,
        outlineVisible: getComputedStyle(outline).display !== 'none',
        resizing: finder.dataset.windowResizing === 'true',
        captureOwned: typeof pointerId === 'number' && grow.hasPointerCapture(pointerId)
      };
    })()`,
    true,
  )) as {
    width: number;
    height: number;
    renderedWidth: number;
    renderedHeight: number;
    outlineWidth: number;
    outlineHeight: number;
    outlineVisible: boolean;
    resizing: boolean;
    captureOwned: boolean;
  } | null;
  const quitDelay = Date.now() - mutationCommittedAt;
  if (
    !provisionalResizeState?.captureOwned ||
    !provisionalResizeState.resizing ||
    !provisionalResizeState.outlineVisible ||
    provisionalResizeState.width !== provisionalResize.expectedCommitted.width ||
    provisionalResizeState.height !== provisionalResize.expectedCommitted.height ||
    provisionalResizeState.renderedWidth !== provisionalResize.expectedCommitted.width ||
    provisionalResizeState.renderedHeight !== provisionalResize.expectedCommitted.height ||
    provisionalResizeState.outlineWidth <= provisionalResize.expectedCommitted.width ||
    provisionalResizeState.outlineHeight <= provisionalResize.expectedCommitted.height ||
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
  if (captureWriteMode) {
    const applicationsOpened = await window.webContents.executeJavaScript(
      `(() => {
        const applications = document.querySelector(
          '[data-finder-window="window-system-disk"] [data-vfs-item="applications"]'
        );
        if (!(applications instanceof HTMLElement)) return false;
        applications.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
        return true;
      })()`,
      true,
    );
    if (!applicationsOpened) throw new Error('Capture could not open Applications.');
    await pause(100);
    const writeOpened = await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector(
          '[data-finder-window="window-applications"] [data-vfs-item="write"]'
        );
        if (!(write instanceof HTMLElement)) return false;
        write.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
        return true;
      })()`,
      true,
    );
    if (!writeOpened) throw new Error('Capture could not open Write.');
    await pause(120);

    const invokeWriteMenu = async (menu: string, action: string): Promise<void> => {
      const opened = await window.webContents.executeJavaScript(
        `(() => {
          const menu = document.querySelector(${JSON.stringify(`[data-menu="${menu}"]`)});
          if (!(menu instanceof HTMLElement)) return false;
          menu.click();
          return true;
        })()`,
        true,
      );
      if (!opened) throw new Error(`Capture could not open the ${menu} menu.`);
      await pause(20);
      const invoked = await window.webContents.executeJavaScript(
        `(() => {
          const action = document.querySelector(${JSON.stringify(
            `[data-menu-action="${action}"]`,
          )});
          if (!(action instanceof HTMLElement)) return false;
          action.click();
          return true;
        })()`,
        true,
      );
      if (!invoked) throw new Error(`Capture could not invoke ${menu}/${action}.`);
      await pause(30);
    };

    await window.webContents.executeJavaScript(
      `document.querySelector('[data-write-title="Untitled"] [data-write-editor="true"]')?.focus()`,
      true,
    );
    window.webContents.insertText('Write');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
    await invokeWriteMenu('font', 'font-sans');
    await invokeWriteMenu('size', 'size-18');
    await invokeWriteMenu('format', 'bold');
    await invokeWriteMenu('format', 'align-center');
    await window.webContents.executeJavaScript(
      `(() => {
        const editor = document.querySelector(
          '[data-write-title="Untitled"] [data-write-editor="true"]'
        );
        const firstParagraph = editor?.querySelector('[data-write-paragraph]');
        if (!(editor instanceof HTMLElement) || !(firstParagraph instanceof HTMLElement)) return false;
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(firstParagraph);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return true;
      })()`,
      true,
    );
    await pause(30);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    await invokeWriteMenu('font', 'font-serif');
    await invokeWriteMenu('size', 'size-12');
    await invokeWriteMenu('format', 'bold');
    await invokeWriteMenu('format', 'align-left');
    if (captureWriteMixedMode) {
      await invokeWriteMenu('format', 'increase-left-indent');
    }
    window.webContents.insertText('A page-oriented word processor for The Macintosh.');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    window.webContents.insertText(
      'Everything on this page is editable exactly where it appears, with original black-and-white controls and a ruler that belongs to the document.',
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    window.webContents.insertText(
      'Use the ruler for indents and tab stops. File, Edit, Format, Font, Size, and View all operate on the active Write window.',
    );
    await invokeWriteMenu('format', 'insert-page-break');
    window.webContents.insertText('This is the second page.');
    await pause(120);
    const captureFontFamilies = (await window.webContents.executeJavaScript(
      `(() => {
        const sans = document.querySelector(
          '[data-write-title="Untitled"] [data-write-paragraph]'
        );
        const serif = document.querySelector(
          '[data-write-title="Untitled"] [data-write-font-family="serif"]'
        );
        return {
          sans: sans instanceof Element ? getComputedStyle(sans).fontFamily : '',
          serif: serif instanceof Element ? getComputedStyle(serif).fontFamily : ''
        };
      })()`,
      true,
    )) as { sans: string; serif: string };
    if (
      !captureFontFamilies.sans.toLowerCase().includes('helvetica') ||
      !captureFontFamilies.serif.toLowerCase().includes('times')
    ) {
      throw new Error(
        `Write capture did not retain Helvetica-first sans and explicit serif families: ${JSON.stringify(captureFontFamilies)}.`,
      );
    }
    await window.webContents.executeJavaScript(
      `(() => {
        const write = document.querySelector('[data-write-title="Untitled"]');
        const editor = write?.querySelector('[data-write-editor="true"]');
        const paragraphs = editor?.querySelectorAll('[data-write-paragraph]');
        const firstParagraph = paragraphs?.[0];
        const secondParagraph = paragraphs?.[1];
        const scroll = write?.querySelector('.write-document-viewport');
        if (!(editor instanceof HTMLElement) || !(firstParagraph instanceof HTMLElement)) return false;
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        if (${captureWriteMixedMode ? 'true' : 'false'} && secondParagraph instanceof HTMLElement) {
          range.setStart(firstParagraph, 0);
          range.setEnd(secondParagraph, secondParagraph.childNodes.length);
        } else {
          range.selectNodeContents(firstParagraph);
          range.collapse(true);
        }
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        if (scroll instanceof HTMLElement) scroll.scrollTop = 0;
        return true;
      })()`,
      true,
    );
    if (captureWriteMixedMode) {
      await pause(60);
      const mixedRulerVisible = await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label^="Mixed ruler settings:"]') !== null`,
        true,
      );
      if (!mixedRulerVisible) {
        throw new Error('Capture could not present Write mixed-selection ruler state.');
      }
    }
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
    width: captureSize?.width ?? 1152,
    height: captureSize?.height ?? 768,
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
