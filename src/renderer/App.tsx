import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react';

import {
  createDefaultState,
  type FinderWindowState,
  type MacintoshState,
  type Point,
  type VfsNode,
  type WindowGeometry,
} from '../shared/state';
import { mergePresentation, projectPresentation } from '../shared/presentation';
import {
  createDefaultWriteParagraphStyle,
  documentPayloadEqual,
  reconcileCommittedDocument,
  type DocumentPayload,
} from '../shared/write';
import {
  descendantsOf,
  listChildren,
  placeFinderIcons,
  type DesktopPlacement,
  type VfsCommand,
  type VfsMutationResult,
} from '../shared/vfs';
import { playEjectSound, playMenuTick } from './audio/sounds';
import { CalculatorWindow } from './components/CalculatorWindow';
import { AboutDialog, EjectTipDialog, InfoDialog, PersistenceAlert } from './components/Dialogs';
import { DesktopIcon } from './components/DesktopIcon';
import {
  DesktopSurface,
  resolveDesktopDropTarget,
  type IconDropLocation,
} from './components/DesktopSurface';
import { DesktopVfsIcon } from './components/DesktopVfsIcon';
import {
  FinderWindow,
  FinderWindowAnimationShadow,
  type FinderWindowAnimation,
} from './components/FinderWindow';
import { MenuBar, type MenuDefinition, type MenuEntry } from './components/MenuBar';
import { StartupScreen } from './components/StartupScreen';
import { SystemDiskDragPreview } from './components/SystemDiskDragPreview';
import { VfsItemDragPreview } from './components/VfsItemDragPreview';
import { UnsavedChangesDialog, VirtualFileDialog } from './components/WriteDialogs';
import type {
  WriteEditorCommand,
  WriteEditorContext,
  WriteEditorHandle,
} from './components/WriteEditor';
import { WriteWindow, type WriteWindowState } from './components/WriteWindow';
import {
  deriveFinderCommandContext,
  finderCommandDestinationId,
  findMenuShortcutEntry,
} from './model/command-context';
import { resolveDesktopIconPosition, translateDesktopIconDrag } from './model/desktop-icon-layout';
import { isTrashDropPoint } from './model/desktop-drop-target';
import { translateFinderIconDrag } from './model/finder-icon-layout';
import {
  createIconDragPreviewItems,
  resolveIconDragPreviewPosition,
  type IconDragPreviewItem,
} from './model/icon-drag-preview';
import { resolveKeyboardOwner } from './model/input-owner';
import type { VfsItemDragContext } from './model/vfs-drag';

type SpecialDesktopIconId = 'system-disk' | 'trash';
type DialogState =
  { type: 'about' } | { type: 'info'; node: VfsNode } | { type: 'eject-tip' } | null;
type TransferNotice = { message: string; error: boolean } | null;
type WindowAnimationSource = HTMLElement | null;
type ActiveOwner =
  | { type: 'finder'; id: string | null }
  | { type: 'write'; id: string }
  | { type: 'calculator'; id: 'calculator' };
type WriteFileDialogState =
  | { type: 'open' }
  | { type: 'save-as'; windowId: string; after: 'none' | 'close' | 'quit' | 'eject' }
  | null;
type PendingWriteClose = {
  windowId: string;
  reason: 'close' | 'quit' | 'eject';
  position: number;
  total: number;
} | null;
type WriteExitIntent = { type: 'normal-quit' } | { type: 'eject'; diskOrigin: Point } | null;

const defaultWriteContext = (): WriteEditorContext => ({
  style: {
    ...createDefaultWriteParagraphStyle(),
    bold: false,
    italic: false,
    underline: false,
  },
  canUndo: false,
  canRedo: false,
  canFormat: true,
});

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const useClock = (): string => {
  const format = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const [clock, setClock] = useState(format);
  useEffect(() => {
    const timer = setInterval(() => setClock(format()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return clock;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const initialWriteWindowGeometry = (
  surfaceWidth: number,
  surfaceHeight: number,
  cascade: number,
): WindowGeometry => {
  const width = clamp(760, 520, Math.max(520, surfaceWidth - 48));
  const height = clamp(570, 360, Math.max(360, surfaceHeight - 36));
  return {
    x: clamp(78 + cascade * 26, 0, Math.max(0, surfaceWidth - width - 6)),
    y: clamp(30 + cascade * 22, 0, Math.max(0, surfaceHeight - height - 6)),
    width,
    height,
  };
};

const plural = (count: number, singular: string, pluralValue = `${singular}s`): string =>
  count === 1 ? singular : pluralValue;

const desktopPlacementFrom = (
  destinationId: string,
  location: IconDropLocation | null,
): DesktopPlacement | undefined =>
  destinationId === 'desktop' && location?.parentId === 'desktop'
    ? { point: location.point, surfaceSize: location.surfaceSize }
    : undefined;

const resolveWindowAnimationOrigin = (
  source: WindowAnimationSource,
  windowState: FinderWindowState,
): Point => {
  const surfaceBounds = source?.closest<HTMLElement>('.desktop-surface')?.getBoundingClientRect();
  const sourceBounds = source?.getBoundingClientRect();
  return surfaceBounds && sourceBounds
    ? {
        x: Math.round(sourceBounds.left + sourceBounds.width / 2 - surfaceBounds.left),
        y: Math.round(sourceBounds.top + sourceBounds.height / 2 - surfaceBounds.top),
      }
    : {
        x: Math.round(windowState.x + windowState.width / 2),
        y: Math.round(windowState.y + windowState.height / 2),
      };
};

const findNodeAnimationSource = (nodeId: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-vfs-node-id], [data-vfs-item]')].find(
    (element) => element.dataset.vfsNodeId === nodeId || element.dataset.vfsItem === nodeId,
  ) ?? null;

const previewUsesSolidDesktopShadow = (item: IconDragPreviewItem, pointer: Point): boolean => {
  const position = resolveIconDragPreviewPosition(item, pointer);
  const target = document.elementFromPoint(
    position.x + Math.round(item.size / 2),
    position.y + Math.round(item.size / 2),
  );
  const surface = document.querySelector<HTMLElement>('.desktop-surface');
  return (
    target instanceof Element &&
    surface?.contains(target) === true &&
    !target.closest(
      '[data-finder-window], [data-write-window], [data-calculator-window], [role="dialog"]',
    )
  );
};

export default function App() {
  const automation = useMemo(
    () => new URLSearchParams(window.location.search).has('automation'),
    [],
  );
  const [state, setState] = useState<MacintoshState | null>(null);
  const [startupComplete, setStartupComplete] = useState(false);
  const [desktopSelection, setDesktopSelectionState] = useState<Set<string>>(new Set());
  const [finderSelection, setFinderSelectionState] = useState<Set<string>>(new Set());
  const [previewPositions, setPreviewPositions] = useState<
    Partial<Record<SpecialDesktopIconId, Point>>
  >({});
  const [draggingIcon, setDraggingIcon] = useState<SpecialDesktopIconId | null>(null);
  const [systemDiskDragPreviewItem, setSystemDiskDragPreviewItem] =
    useState<IconDragPreviewItem | null>(null);
  const [systemDiskDragPointer, setSystemDiskDragPointer] = useState<Point | null>(null);
  const [systemDiskDragSolidShadow, setSystemDiskDragSolidShadow] = useState(false);
  const [vfsItemDragging, setVfsItemDragging] = useState(false);
  const [vfsItemDragPreviewItems, setVfsItemDragPreviewItems] = useState<IconDragPreviewItem[]>([]);
  const [vfsItemDragPointer, setVfsItemDragPointer] = useState<Point | null>(null);
  const [vfsItemDragSolidShadowIds, setVfsItemDragSolidShadowIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [snappingIcon, setSnappingIcon] = useState<SpecialDesktopIconId | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [ejecting, setEjecting] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [writeWindows, setWriteWindows] = useState<WriteWindowState[]>([]);
  const [writeContexts, setWriteContexts] = useState<Record<string, WriteEditorContext>>({});
  const [activeOwner, setActiveOwner] = useState<ActiveOwner>({ type: 'finder', id: null });
  const [writeFileDialog, setWriteFileDialog] = useState<WriteFileDialogState>(null);
  const [pendingWriteClose, setPendingWriteClose] = useState<PendingWriteClose>(null);
  const [writeSaving, setWriteSaving] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pointerSessionActive, setPointerSessionActive] = useState(false);
  const [interactionCancelToken, setInteractionCancelToken] = useState(0);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [normalQuitPending, setNormalQuitPending] = useState(false);
  const [transferNotice, setTransferNotice] = useState<TransferNotice>(null);
  const [windowAnimations, setWindowAnimations] = useState<Record<string, FinderWindowAnimation>>(
    {},
  );
  const windowAnimationsRef = useRef<Record<string, FinderWindowAnimation>>({});
  const windowAnimationToken = useRef(0);
  const calculatorReturnOwner = useRef<ActiveOwner>({ type: 'finder', id: null });
  const dragOrigins = useRef<Partial<Record<SpecialDesktopIconId, Point>>>({});
  const systemDiskDragPreviewItemRef = useRef<IconDragPreviewItem | null>(null);
  const vfsItemDrag = useRef<VfsItemDragContext | null>(null);
  const vfsItemInvalidTargets = useRef<Set<string>>(new Set());
  const vfsItemDraggingRef = useRef(false);
  const vfsItemDropTarget = useRef<HTMLElement | null>(null);
  const zoomRestore = useRef<Map<string, WindowGeometry>>(new Map());
  const writeZoomRestore = useRef<Map<string, WindowGeometry>>(new Map());
  const writeWindowsRef = useRef<WriteWindowState[]>([]);
  const writeEditors = useRef<Map<string, WriteEditorHandle>>(new Map());
  const writeSaveInFlight = useRef(false);
  const untitledCounter = useRef(0);
  const quitWriteQueue = useRef<string[]>([]);
  const quitWriteTotal = useRef(0);
  const writeExitIntent = useRef<WriteExitIntent>(null);
  const stateRef = useRef<MacintoshState | null>(null);
  const selectionEpoch = useRef(0);
  const clipboardNodeIds = useRef<string[]>([]);
  const persistenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const normalQuitFlush = useRef<Promise<void> | null>(null);
  const transferNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);
  const pointerSessionActiveRef = useRef(false);
  const clock = useClock();

  const setPointerInteractionActive = useCallback((active: boolean): void => {
    pointerSessionActiveRef.current = active;
    setPointerSessionActive(active);
  }, []);

  const setVfsItemDragActive = useCallback((active: boolean): void => {
    vfsItemDraggingRef.current = active;
    document.documentElement.classList.toggle('is-item-dragging', active);
    setVfsItemDragging(active);
  }, []);

  const clearVfsItemDropTarget = useCallback((): void => {
    vfsItemDropTarget.current?.classList.remove('is-file-drop-target');
    vfsItemDropTarget.current = null;
  }, []);

  const cancelPointerInteractions = useCallback((): void => {
    if (!pointerSessionActiveRef.current && !vfsItemDrag.current && !vfsItemDraggingRef.current) {
      return;
    }
    pointerSessionActiveRef.current = false;
    vfsItemDrag.current = null;
    vfsItemInvalidTargets.current.clear();
    clearVfsItemDropTarget();
    setPointerSessionActive(false);
    setVfsItemDragActive(false);
    setVfsItemDragPreviewItems([]);
    setVfsItemDragPointer(null);
    setVfsItemDragSolidShadowIds(new Set());
    setInteractionCancelToken((current) => current + 1);
  }, [clearVfsItemDropTarget, setVfsItemDragActive]);

  const setDesktopSelection = useCallback((next: SetStateAction<Set<string>>): void => {
    selectionEpoch.current += 1;
    setDesktopSelectionState(next);
  }, []);

  const setFinderSelection = useCallback((next: SetStateAction<Set<string>>): void => {
    selectionEpoch.current += 1;
    setFinderSelectionState(next);
  }, []);

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  useLayoutEffect(() => {
    writeWindowsRef.current = writeWindows;
  }, [writeWindows]);

  useLayoutEffect(() => {
    windowAnimationsRef.current = windowAnimations;
  }, [windowAnimations]);

  useEffect(() => {
    if (!state) return;
    const nodeIds = new Set(state.nodes.map((node) => node.id));
    const renderedWindowIds = new Set(
      state.desktop.windows
        .filter((windowState) => nodeIds.has(windowState.nodeId))
        .map((windowState) => windowState.id),
    );
    const staleWindowIds = Object.keys(windowAnimationsRef.current).filter(
      (windowId) => !renderedWindowIds.has(windowId),
    );
    if (staleWindowIds.length === 0) return;
    const nextAnimations = { ...windowAnimationsRef.current };
    for (const windowId of staleWindowIds) delete nextAnimations[windowId];
    windowAnimationsRef.current = nextAnimations;
    setWindowAnimations(nextAnimations);
  }, [state]);

  useEffect(
    () => () => {
      if (transferNoticeTimer.current) clearTimeout(transferNoticeTimer.current);
    },
    [],
  );

  const showTransferNotice = useCallback((message: string, error = false): void => {
    if (transferNoticeTimer.current) clearTimeout(transferNoticeTimer.current);
    setTransferNotice({ message, error });
    transferNoticeTimer.current = setTimeout(() => setTransferNotice(null), error ? 5_000 : 3_200);
  }, []);

  const invokeMenuEntry = useCallback((entry: MenuEntry): void => {
    if (entry.disabled || entry.separator) return;
    setOpenMenu(null);
    playMenuTick();
    entry.action?.();
  }, []);

  const replaceState = useCallback((nextState: MacintoshState): void => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const updateState = useCallback(
    (update: (current: MacintoshState) => MacintoshState): void => {
      const current = stateRef.current;
      if (!current) return;
      replaceState(update(current));
    },
    [replaceState],
  );

  const persistState = useCallback(
    (nextState: MacintoshState) =>
      window.macintosh.savePresentation(projectPresentation(nextState)),
    [],
  );

  const setNormalQuitInteraction = useCallback((active: boolean): void => {
    document.documentElement.classList.toggle('is-normal-quit-pending', active);
    setNormalQuitPending(active);
  }, []);

  const reportPersistenceError = useCallback(
    (message: string): void => {
      setOpenMenu(null);
      cancelPointerInteractions();
      setPersistenceError(message);
    },
    [cancelPointerInteractions],
  );

  const commitVfsMutation = useCallback(
    (
      current: MacintoshState,
      result: VfsMutationResult,
      requestSelectionEpoch: number,
      destinationId: string,
      verb: 'Copied' | 'Moved',
      extraSkipped = 0,
      extraTruncated = 0,
    ): void => {
      const latestPresentation = projectPresentation(stateRef.current ?? current);
      const nextState = mergePresentation(result.state, latestPresentation);
      const affectedCount = verb === 'Copied' ? result.addedCount : result.affectedIds.length;
      const skipped = result.skippedCount + extraSkipped;
      const truncated = result.truncatedCount + extraTruncated;
      replaceState(nextState);
      if (affectedCount === 0) {
        showTransferNotice(
          skipped > 0
            ? `Nothing changed; ${skipped} ${plural(skipped, 'item')} could not be ${verb === 'Moved' ? 'moved' : 'copied'}.`
            : 'Nothing changed.',
          true,
        );
        return;
      }

      if (selectionEpoch.current === requestSelectionEpoch) {
        if (destinationId === 'desktop') {
          setDesktopSelection(new Set(result.affectedIds));
          setFinderSelection(new Set());
        } else {
          setFinderSelection(new Set(result.affectedIds));
          setDesktopSelection(new Set());
        }
      }
      const destination =
        nextState.nodes.find((node) => node.id === destinationId)?.name ?? 'System Disk';
      const details = [
        skipped > 0 ? `${skipped} skipped` : '',
        truncated > 0 ? `${truncated} truncated` : '',
      ].filter(Boolean);
      showTransferNotice(
        `${verb} ${affectedCount} ${plural(affectedCount, 'item')} to ${destination}.${details.length > 0 ? ` ${details.join(', ')}.` : ''}`,
      );
    },
    [replaceState, setDesktopSelection, setFinderSelection, showTransferNotice],
  );

  useEffect(() => {
    let cancelled = false;
    window.macintosh
      .loadState()
      .then((loaded) => {
        if (cancelled) return;
        hydrated.current = true;
        replaceState(loaded);
        setActiveOwner({ type: 'finder', id: loaded.desktop.windows.at(-1)?.id ?? null });
        document.body.dataset.stateLoaded = 'true';
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        hydrated.current = true;
        const fallback = createDefaultState();
        replaceState(fallback);
        setActiveOwner({ type: 'finder', id: fallback.desktop.windows.at(-1)?.id ?? null });
        reportPersistenceError('The saved desktop could not be read. A fresh desktop was opened.');
        document.body.dataset.stateLoaded = 'false';
      });
    return () => {
      cancelled = true;
    };
  }, [replaceState, reportPersistenceError]);

  useEffect(() => {
    if (!state || !hydrated.current || ejecting || normalQuitPending) return;
    const timer = setTimeout(() => {
      if (persistenceTimer.current === timer) persistenceTimer.current = null;
      void persistState(state).catch((error: unknown) => {
        console.error(error);
        reportPersistenceError('The desktop could not be saved.');
      });
    }, 220);
    persistenceTimer.current = timer;
    return () => {
      clearTimeout(timer);
      if (persistenceTimer.current === timer) persistenceTimer.current = null;
    };
  }, [state, ejecting, normalQuitPending, persistState, reportPersistenceError]);

  const ready = Boolean(state && startupComplete);
  useEffect(() => {
    document.body.dataset.macReady = ready ? 'true' : 'false';
  }, [ready]);

  const activeFinderWindowId = activeOwner.type === 'finder' ? activeOwner.id : null;
  const finderCommandContext = useMemo(
    () => deriveFinderCommandContext(state, finderSelection, activeFinderWindowId),
    [activeFinderWindowId, finderSelection, state],
  );
  const desktopItems = useMemo(
    () => (state ? listChildren(state.nodes, 'desktop', 'icons') : []),
    [state],
  );
  const { activeWindow, activeNode, visibleSelection } = finderCommandContext;
  const copyableFinderSelectionIds = useMemo(
    () =>
      visibleSelection
        .filter((node) => node.id !== 'system-disk' && node.id !== 'trash')
        .map((node) => node.id),
    [visibleSelection],
  );
  const keyboardOwner = resolveKeyboardOwner({
    persistenceAlertOpen: persistenceError !== null,
    normalQuitInProgress: normalQuitPending,
    dialogOpen: dialog !== null || writeFileDialog !== null || pendingWriteClose !== null,
    ejectionInProgress: ejecting,
    pointerSessionActive,
    menuOpen: openMenu !== null,
    writeWindowOpen: activeOwner.type === 'write',
    calculatorOpen: calculatorOpen && activeOwner.type === 'calculator',
    finderWindowOpen: activeWindow !== null && activeOwner.type === 'finder',
  });
  const systemInputBlocked =
    keyboardOwner === 'persistence-alert' ||
    keyboardOwner === 'normal-quit' ||
    keyboardOwner === 'dialog' ||
    keyboardOwner === 'ejection' ||
    keyboardOwner === 'pointer-session';

  const replaceWriteWindows = useCallback(
    (update: (current: WriteWindowState[]) => WriteWindowState[]): void => {
      const next = update(writeWindowsRef.current);
      writeWindowsRef.current = next;
      setWriteWindows(next);
    },
    [],
  );

  const registerWriteEditor = useCallback(
    (windowId: string, editor: WriteEditorHandle | null): void => {
      if (editor) writeEditors.current.set(windowId, editor);
      else writeEditors.current.delete(windowId);
    },
    [],
  );

  const activateWriteWindow = useCallback(
    (windowId: string): void => {
      replaceWriteWindows((current) => {
        const target = current.find((item) => item.id === windowId);
        return target && current.at(-1)?.id !== windowId
          ? [...current.filter((item) => item.id !== windowId), target]
          : current;
      });
      setActiveOwner({ type: 'write', id: windowId });
      setDesktopSelection(new Set());
      setFinderSelection(new Set());
    },
    [replaceWriteWindows, setDesktopSelection, setFinderSelection],
  );

  const newWriteDocument = useCallback((): void => {
    untitledCounter.current += 1;
    const id = `write-untitled-${Date.now().toString(36)}-${untitledCounter.current}`;
    const surface = document.querySelector<HTMLElement>('.desktop-surface');
    const surfaceWidth = surface?.clientWidth ?? window.innerWidth;
    const surfaceHeight = surface?.clientHeight ?? window.innerHeight - 22;
    const cascade = writeWindowsRef.current.length % 5;
    const payload: DocumentPayload = { format: 'plain-text', text: '' };
    const geometry = initialWriteWindowGeometry(surfaceWidth, surfaceHeight, cascade);
    const windowState: WriteWindowState = {
      id,
      documentId: null,
      title: 'Untitled',
      draft: payload,
      saved: payload,
      dirty: false,
      zoom: 75,
      pageNumber: 1,
      pageCount: 1,
      ...geometry,
    };
    replaceWriteWindows((current) => [...current, windowState]);
    setWriteContexts((current) => ({ ...current, [id]: defaultWriteContext() }));
    setActiveOwner({ type: 'write', id });
  }, [replaceWriteWindows]);

  const openWriteDocument = useCallback(
    (documentId: string): void => {
      const existing = writeWindowsRef.current.find((item) => item.documentId === documentId);
      if (existing) {
        activateWriteWindow(existing.id);
        return;
      }
      const node = stateRef.current?.nodes.find((item) => item.id === documentId);
      if (!node || node.kind !== 'document' || !node.payload) return;
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      const surfaceWidth = surface?.clientWidth ?? window.innerWidth;
      const surfaceHeight = surface?.clientHeight ?? window.innerHeight - 22;
      const cascade = writeWindowsRef.current.length % 5;
      const id = `write-${documentId}`;
      const geometry = initialWriteWindowGeometry(surfaceWidth, surfaceHeight, cascade);
      const windowState: WriteWindowState = {
        id,
        documentId,
        title: node.name,
        draft: node.payload,
        saved: node.payload,
        dirty: false,
        zoom: 75,
        pageNumber: 1,
        pageCount: 1,
        ...geometry,
      };
      replaceWriteWindows((current) => [...current, windowState]);
      setWriteContexts((current) => ({ ...current, [id]: defaultWriteContext() }));
      setActiveOwner({ type: 'write', id });
      setDesktopSelection(new Set());
      setFinderSelection(new Set());
    },
    [activateWriteWindow, replaceWriteWindows, setDesktopSelection, setFinderSelection],
  );

  const removeWriteWindow = useCallback(
    (windowId: string): void => {
      writeZoomRestore.current.delete(windowId);
      writeEditors.current.delete(windowId);
      replaceWriteWindows((current) => current.filter((item) => item.id !== windowId));
      setWriteContexts((current) => {
        const next = { ...current };
        delete next[windowId];
        return next;
      });
      const remaining = writeWindowsRef.current.filter((item) => item.id !== windowId);
      if (remaining.length > 0) {
        setActiveOwner({ type: 'write', id: remaining.at(-1)!.id });
      } else {
        setActiveOwner({
          type: 'finder',
          id: stateRef.current?.desktop.windows.at(-1)?.id ?? null,
        });
      }
    },
    [replaceWriteWindows],
  );

  const mutateWriteDocument = useCallback(
    async (command: VfsCommand): Promise<VfsMutationResult> => {
      const current = stateRef.current;
      if (!current) throw new Error('The virtual disk is unavailable.');
      const requestPresentation = projectPresentation(current);
      const result = await window.macintosh.mutateVfs({
        command,
        presentation: requestPresentation,
      });
      const latestPresentation = projectPresentation(stateRef.current ?? current);
      replaceState(mergePresentation(result.state, latestPresentation));
      return result;
    },
    [replaceState],
  );

  const saveWriteDocument = useCallback(
    async (windowId: string): Promise<boolean> => {
      const target = writeWindowsRef.current.find((item) => item.id === windowId);
      if (!target) return false;
      if (!target.documentId) {
        setWriteFileDialog({ type: 'save-as', windowId, after: 'none' });
        return false;
      }
      if (writeSaveInFlight.current) return false;
      writeSaveInFlight.current = true;
      setWriteSaving(true);
      try {
        const result = await mutateWriteDocument({
          type: 'update-document',
          nodeId: target.documentId,
          payload: target.draft,
        });
        if (
          !result.affectedIds.includes(target.documentId) ||
          result.skippedCount > 0 ||
          result.truncatedCount > 0
        ) {
          throw new Error('The virtual disk could not store the complete document.');
        }
        const savedNode = result.state.nodes.find((node) => node.id === target.documentId);
        if (!savedNode || savedNode.kind !== 'document' || !savedNode.payload) {
          throw new Error('The saved document was not returned by the virtual disk.');
        }
        let currentDraftSaved = false;
        replaceWriteWindows((current) =>
          current.map((item) => {
            if (item.id !== windowId) return item;
            const reconciliation = reconcileCommittedDocument(item.draft, savedNode.payload!);
            currentDraftSaved = !reconciliation.dirty;
            return {
              ...item,
              ...reconciliation,
              title: savedNode.name,
            };
          }),
        );
        return currentDraftSaved;
      } catch (error) {
        console.error(error);
        reportPersistenceError(`“${target.title}” could not be saved.`);
        return false;
      } finally {
        writeSaveInFlight.current = false;
        setWriteSaving(false);
      }
    },
    [mutateWriteDocument, replaceWriteWindows, reportPersistenceError],
  );

  const clearSystemDiskDragPreview = useCallback((): void => {
    systemDiskDragPreviewItemRef.current = null;
    setSystemDiskDragPreviewItem(null);
    setSystemDiskDragPointer(null);
    setSystemDiskDragSolidShadow(false);
  }, []);

  const restoreIcon = useCallback(
    (id: SpecialDesktopIconId): void => {
      const origin = dragOrigins.current[id];
      if (origin) setPreviewPositions((current) => ({ ...current, [id]: origin }));
      setDraggingIcon(null);
      setSnappingIcon(id);
      setTrashHover(false);
      if (id === 'system-disk') clearSystemDiskDragPreview();
      setTimeout(() => {
        setPreviewPositions((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        delete dragOrigins.current[id];
        setSnappingIcon(null);
      }, 190);
    },
    [clearSystemDiskDragPreview],
  );

  const performEjectSystemDisk = useCallback(
    async (diskOrigin: Point): Promise<void> => {
      const current = stateRef.current;
      if (!current || ejecting) return;
      writeExitIntent.current = null;
      setOpenMenu(null);
      setEjecting(true);
      setDraggingIcon(null);
      clearSystemDiskDragPreview();
      setTrashHover(true);
      playEjectSound();
      await pause(automation ? 280 : 920);

      const latest = stateRef.current ?? current;
      const nextState = {
        ...latest,
        desktop: {
          ...latest.desktop,
          diskPosition: diskOrigin,
        },
      };

      try {
        await window.macintosh.saveAndQuitAfterEject(projectPresentation(nextState));
      } catch (error) {
        console.error(error);
        reportPersistenceError(
          'The disk could not be safely ejected or The Macintosh could not shut down.',
        );
        setEjecting(false);
        restoreIcon('system-disk');
      }
    },
    [automation, clearSystemDiskDragPreview, ejecting, reportPersistenceError, restoreIcon],
  );

  const finalizeNormalQuit = useCallback((): void => {
    if (normalQuitFlush.current) return;
    writeExitIntent.current = null;
    setPendingWriteClose(null);
    setWriteFileDialog(null);
    setNormalQuitInteraction(true);
    const finalPresentation = stateRef.current ? projectPresentation(stateRef.current) : null;
    const flush = (async (): Promise<void> => {
      try {
        await window.macintosh.flushPresentationAndQuit(finalPresentation);
      } catch (error) {
        console.error(error);
        setNormalQuitInteraction(false);
        reportPersistenceError('The Macintosh could not quit because the desktop was not saved.');
      } finally {
        normalQuitFlush.current = null;
      }
    })();
    normalQuitFlush.current = flush;
  }, [reportPersistenceError, setNormalQuitInteraction]);

  const continueQuitReview = useCallback((): void => {
    setPendingWriteClose(null);
    const intent = writeExitIntent.current;
    const reason = intent?.type === 'eject' ? 'eject' : 'quit';
    while (quitWriteQueue.current.length > 0) {
      const windowId = quitWriteQueue.current.shift()!;
      const target = writeWindowsRef.current.find((item) => item.id === windowId);
      if (!target?.dirty) continue;
      const position = quitWriteTotal.current - quitWriteQueue.current.length;
      setPendingWriteClose({
        windowId,
        reason,
        position,
        total: quitWriteTotal.current,
      });
      setActiveOwner({ type: 'write', id: windowId });
      return;
    }
    if (intent?.type === 'eject') {
      void performEjectSystemDisk(intent.diskOrigin);
    } else {
      finalizeNormalQuit();
    }
  }, [finalizeNormalQuit, performEjectSystemDisk]);

  const requestWriteClose = useCallback(
    (windowId: string): void => {
      const target = writeWindowsRef.current.find((item) => item.id === windowId);
      if (!target) return;
      if (!target.dirty) {
        removeWriteWindow(windowId);
        return;
      }
      setPendingWriteClose({ windowId, reason: 'close', position: 1, total: 1 });
      setActiveOwner({ type: 'write', id: windowId });
    },
    [removeWriteWindow],
  );

  const saveWriteAs = useCallback(
    async (
      windowId: string,
      parentId: string,
      name: string,
      after: 'none' | 'close' | 'quit' | 'eject',
    ): Promise<void> => {
      const target = writeWindowsRef.current.find((item) => item.id === windowId);
      if (!target || writeSaveInFlight.current) return;
      writeSaveInFlight.current = true;
      setWriteSaving(true);
      try {
        const result = await mutateWriteDocument({
          type: 'create-document',
          parentId,
          name,
          payload: target.draft,
        });
        if (
          result.affectedIds.length !== 1 ||
          result.skippedCount > 0 ||
          result.truncatedCount > 0
        ) {
          throw new Error('The virtual disk could not store the complete document.');
        }
        const documentId = result.affectedIds[0];
        const savedNode = result.state.nodes.find((node) => node.id === documentId);
        if (!savedNode || savedNode.kind !== 'document' || !savedNode.payload) {
          throw new Error('The new document was not returned by the virtual disk.');
        }
        let currentDraftSaved = false;
        replaceWriteWindows((current) =>
          current.map((item) => {
            if (item.id !== windowId) return item;
            const reconciliation = reconcileCommittedDocument(item.draft, savedNode.payload!);
            currentDraftSaved = !reconciliation.dirty;
            return {
              ...item,
              ...reconciliation,
              documentId: savedNode.id,
              title: savedNode.name,
            };
          }),
        );
        setWriteFileDialog(null);
        if (after === 'close') {
          if (currentDraftSaved) removeWriteWindow(windowId);
          else setPendingWriteClose({ windowId, reason: 'close', position: 1, total: 1 });
        } else if (after === 'quit' || after === 'eject') {
          if (currentDraftSaved) {
            continueQuitReview();
          } else {
            setPendingWriteClose({
              windowId,
              reason: after,
              position: quitWriteTotal.current - quitWriteQueue.current.length,
              total: quitWriteTotal.current,
            });
          }
        }
      } catch (error) {
        console.error(error);
        reportPersistenceError(`“${target.title}” could not be saved.`);
      } finally {
        writeSaveInFlight.current = false;
        setWriteSaving(false);
      }
    },
    [
      continueQuitReview,
      mutateWriteDocument,
      removeWriteWindow,
      replaceWriteWindows,
      reportPersistenceError,
    ],
  );

  const cancelWriteExitReview = useCallback((): void => {
    const normalQuit = writeExitIntent.current?.type === 'normal-quit';
    writeExitIntent.current = null;
    quitWriteQueue.current = [];
    quitWriteTotal.current = 0;
    setPendingWriteClose(null);
    setWriteFileDialog(null);
    if (!normalQuit) return;
    const current = stateRef.current;
    if (current) {
      void persistState(current).catch((error: unknown) => {
        console.error(error);
        reportPersistenceError('The desktop could not be saved.');
      });
    }
    void window.macintosh.cancelNormalQuit().catch((error: unknown) => {
      console.error('Could not cancel normal Quit:', error);
    });
  }, [persistState, reportPersistenceError]);

  useEffect(() => {
    const removeListener = window.macintosh.onNormalQuitRequested(() => {
      if (normalQuitFlush.current || writeExitIntent.current) return;
      if (persistenceTimer.current) {
        clearTimeout(persistenceTimer.current);
        persistenceTimer.current = null;
      }
      cancelPointerInteractions();
      setOpenMenu(null);
      setDialog(null);
      setWriteFileDialog(null);
      setPendingWriteClose(null);
      writeExitIntent.current = { type: 'normal-quit' };
      const dirtyIds = writeWindowsRef.current.filter((item) => item.dirty).map((item) => item.id);
      quitWriteQueue.current = dirtyIds;
      quitWriteTotal.current = dirtyIds.length;
      if (dirtyIds.length > 0) continueQuitReview();
      else finalizeNormalQuit();
    });
    void window.macintosh.signalNormalQuitReady().catch((error: unknown) => {
      console.error('Could not announce normal-quit readiness:', error);
    });
    return () => {
      removeListener();
      document.documentElement.classList.remove('is-normal-quit-pending');
    };
  }, [cancelPointerInteractions, continueQuitReview, finalizeNormalQuit]);

  const activateWindow = useCallback(
    (windowId: string): void => {
      setActiveOwner({ type: 'finder', id: windowId });
      updateState((current) => {
        const target = current.desktop.windows.find((item) => item.id === windowId);
        if (!target || current.desktop.windows.at(-1)?.id === windowId) return current;
        return {
          ...current,
          desktop: {
            ...current.desktop,
            windows: [...current.desktop.windows.filter((item) => item.id !== windowId), target],
          },
        };
      });
    },
    [updateState],
  );

  const openNode = useCallback(
    (nodeId: string, source: WindowAnimationSource = null): void => {
      const current = stateRef.current;
      const node = current?.nodes.find((item) => item.id === nodeId);
      if (!current || !node || node.kind === 'desktop') return;
      if (node.kind === 'application' && node.applicationId === 'write') {
        newWriteDocument();
        return;
      }
      if (node.kind === 'document') {
        openWriteDocument(node.id);
        return;
      }
      const windowId = `window-${nodeId}`;
      setActiveOwner({ type: 'finder', id: windowId });
      const existing = current.desktop.windows.find((item) => item.id === windowId);
      const remaining = current.desktop.windows.filter((item) => item.id !== windowId);
      const cascade = remaining.length % 5;
      const nextWindow: FinderWindowState =
        existing ??
        ({
          id: windowId,
          nodeId,
          x: 170 + cascade * 28,
          y: 70 + cascade * 24,
          width: 640,
          height: 420,
        } satisfies FinderWindowState);

      const currentAnimations = windowAnimationsRef.current;
      if (!existing) {
        const nextAnimations = {
          ...currentAnimations,
          [windowId]: {
            phase: 'opening',
            origin: resolveWindowAnimationOrigin(source, nextWindow),
            token: (windowAnimationToken.current += 1),
          } satisfies FinderWindowAnimation,
        };
        windowAnimationsRef.current = nextAnimations;
        setWindowAnimations(nextAnimations);
      } else if (currentAnimations[windowId]?.phase === 'closing') {
        const nextAnimations = { ...currentAnimations };
        delete nextAnimations[windowId];
        windowAnimationsRef.current = nextAnimations;
        setWindowAnimations(nextAnimations);
      }

      replaceState({
        ...current,
        desktop: { ...current.desktop, windows: [...remaining, nextWindow] },
      });
      setFinderSelection(new Set());
      setDesktopSelection(new Set());
    },
    [newWriteDocument, openWriteDocument, replaceState, setDesktopSelection, setFinderSelection],
  );

  const closeWindow = useCallback(
    (windowId: string): void => {
      const current = stateRef.current;
      const target = current?.desktop.windows.find((item) => item.id === windowId);
      if (!current || !target) return;
      if (windowAnimationsRef.current[windowId]?.phase === 'closing') return;
      const nextAnimations = {
        ...windowAnimationsRef.current,
        [windowId]: {
          phase: 'closing',
          origin: resolveWindowAnimationOrigin(findNodeAnimationSource(target.nodeId), target),
          token: (windowAnimationToken.current += 1),
        } satisfies FinderWindowAnimation,
      };
      windowAnimationsRef.current = nextAnimations;
      setWindowAnimations(nextAnimations);
      setFinderSelection(new Set());
    },
    [setFinderSelection],
  );

  const finishWindowAnimation = useCallback(
    (windowId: string, phase: FinderWindowAnimation['phase'], token: number): void => {
      const activeAnimation = windowAnimationsRef.current[windowId];
      if (activeAnimation?.phase !== phase || activeAnimation.token !== token) return;
      const nextAnimations = { ...windowAnimationsRef.current };
      delete nextAnimations[windowId];
      windowAnimationsRef.current = nextAnimations;
      setWindowAnimations(nextAnimations);
      if (phase !== 'closing') return;
      zoomRestore.current.delete(windowId);
      const nextFinderOwner =
        stateRef.current?.desktop.windows.filter((item) => item.id !== windowId).at(-1)?.id ?? null;
      setActiveOwner((owner) =>
        owner.type === 'finder' && owner.id === windowId
          ? { type: 'finder', id: nextFinderOwner }
          : owner,
      );
      updateState((current) => ({
        ...current,
        desktop: {
          ...current.desktop,
          windows: current.desktop.windows.filter((item) => item.id !== windowId),
        },
      }));
    },
    [updateState],
  );

  const setWindowGeometry = useCallback(
    (windowId: string, geometry: WindowGeometry): void => {
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      const maximumWidth = surface?.clientWidth ?? window.innerWidth;
      const maximumHeight = surface?.clientHeight ?? window.innerHeight - 24;
      updateState((current) => ({
        ...current,
        desktop: {
          ...current.desktop,
          windows: current.desktop.windows.map((item) =>
            item.id === windowId
              ? {
                  ...item,
                  x: clamp(geometry.x, 0, Math.max(0, maximumWidth - 96)),
                  y: clamp(geometry.y, 0, Math.max(0, maximumHeight - 28)),
                  width: clamp(geometry.width, 300, maximumWidth),
                  height: clamp(geometry.height, 220, maximumHeight),
                }
              : item,
          ),
        },
      }));
    },
    [updateState],
  );

  const zoomWindow = useCallback(
    (windowId: string): void => {
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      if (!surface || !state) return;
      const current = state.desktop.windows.find((item) => item.id === windowId);
      if (!current) return;
      const restore = zoomRestore.current.get(windowId);
      if (restore) {
        zoomRestore.current.delete(windowId);
        setWindowGeometry(windowId, restore);
        return;
      }
      zoomRestore.current.set(windowId, current);
      setWindowGeometry(windowId, {
        x: 10,
        y: 10,
        width: surface.clientWidth - 20,
        height: surface.clientHeight - 20,
      });
    },
    [setWindowGeometry, state],
  );

  const setWriteWindowGeometry = useCallback(
    (windowId: string, geometry: WindowGeometry): void => {
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      const maximumWidth = surface?.clientWidth ?? window.innerWidth;
      const maximumHeight = surface?.clientHeight ?? window.innerHeight - 24;
      replaceWriteWindows((current) =>
        current.map((item) =>
          item.id === windowId
            ? {
                ...item,
                x: clamp(geometry.x, 0, Math.max(0, maximumWidth - 96)),
                y: clamp(geometry.y, 0, Math.max(0, maximumHeight - 28)),
                width: clamp(geometry.width, 520, maximumWidth),
                height: clamp(geometry.height, 360, maximumHeight),
              }
            : item,
        ),
      );
    },
    [replaceWriteWindows],
  );

  const zoomWriteWindow = useCallback(
    (windowId: string): void => {
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      const current = writeWindowsRef.current.find((item) => item.id === windowId);
      if (!surface || !current) return;
      const restore = writeZoomRestore.current.get(windowId);
      if (restore) {
        writeZoomRestore.current.delete(windowId);
        setWriteWindowGeometry(windowId, restore);
        return;
      }
      writeZoomRestore.current.set(windowId, current);
      setWriteWindowGeometry(windowId, {
        x: 10,
        y: 10,
        width: surface.clientWidth - 20,
        height: surface.clientHeight - 20,
      });
    },
    [setWriteWindowGeometry],
  );

  const updateWriteDraft = useCallback(
    (windowId: string, payload: DocumentPayload): void => {
      replaceWriteWindows((current) =>
        current.map((item) =>
          item.id === windowId
            ? {
                ...item,
                draft: payload,
                dirty: !documentPayloadEqual(payload, item.saved),
              }
            : item,
        ),
      );
    },
    [replaceWriteWindows],
  );

  const updateWriteContext = useCallback((windowId: string, context: WriteEditorContext): void => {
    setWriteContexts((current) => ({ ...current, [windowId]: context }));
  }, []);

  const updateWritePagination = useCallback(
    (windowId: string, pageNumber: number, pageCount: number): void => {
      replaceWriteWindows((current) =>
        current.map((item) =>
          item.id === windowId && (item.pageNumber !== pageNumber || item.pageCount !== pageCount)
            ? { ...item, pageNumber, pageCount }
            : item,
        ),
      );
    },
    [replaceWriteWindows],
  );

  const executeWriteCommand = useCallback(
    (command: WriteEditorCommand): boolean => {
      if (activeOwner.type !== 'write') return false;
      return writeEditors.current.get(activeOwner.id)?.execute(command) ?? false;
    },
    [activeOwner],
  );

  const setWriteZoom = useCallback(
    (windowId: string, zoom: 50 | 75 | 100): void => {
      replaceWriteWindows((current) =>
        current.map((item) => (item.id === windowId ? { ...item, zoom } : item)),
      );
    },
    [replaceWriteWindows],
  );

  const selectDesktopIcon = (id: string, additive: boolean): void => {
    setActiveOwner({ type: 'finder', id: null });
    setFinderSelection(new Set());
    setDesktopSelection((current) => {
      if (!additive) return new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectFinderItem = (id: string, additive: boolean): void => {
    setActiveOwner({
      type: 'finder',
      id: stateRef.current?.desktop.windows.at(-1)?.id ?? null,
    });
    setDesktopSelection(new Set());
    setFinderSelection((current) => {
      if (!additive) return new Set([id]);
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startFinderItemDrag = (id: string, context: VfsItemDragContext): void => {
    const current = stateRef.current;
    if (!current) return;
    const nodeIds = context.nodeIds.length > 0 ? context.nodeIds : [id];
    vfsItemDrag.current = { ...context, nodeIds };
    vfsItemInvalidTargets.current = new Set(nodeIds);
    for (const nodeId of nodeIds) {
      for (const descendantId of descendantsOf(current.nodes, nodeId)) {
        vfsItemInvalidTargets.current.add(descendantId);
      }
    }
    setVfsItemDragActive(true);
    setVfsItemDragPreviewItems(context.previewItems);
    setVfsItemDragPointer(null);
    setVfsItemDragSolidShadowIds(new Set());
    setPointerInteractionActive(true);
    setFinderSelection(new Set(nodeIds));
    setDesktopSelection(new Set());
  };

  const startDesktopItemDrag = (id: string, pointerOffset: Point, pointerOrigin: Point): void => {
    const current = stateRef.current;
    if (!current) return;
    const items = listChildren(current.nodes, 'desktop', 'icons');
    const selectedIds = desktopSelection.has(id) ? desktopSelection : new Set([id]);
    const draggedItems = items.filter((item) => selectedIds.has(item.id));
    if (draggedItems.length === 0) return;
    const nodeIds = draggedItems.map((item) => item.id);
    const renderedItems = [...document.querySelectorAll<HTMLElement>('[data-desktop-vfs-item]')];
    const previewItems = createIconDragPreviewItems(
      nodeIds.flatMap((nodeId) => {
        const renderedItem = renderedItems.find(
          (element) => element.dataset.desktopVfsItem === nodeId,
        );
        const icon = renderedItem?.querySelector('.pixel-icon');
        if (!icon) return [];
        const bounds = icon.getBoundingClientRect();
        return [
          {
            nodeId,
            bounds: {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            },
          },
        ];
      }),
      pointerOrigin,
    );
    vfsItemDrag.current = {
      parentId: 'desktop',
      nodeIds,
      layout: {
        anchorId: id,
        pointerOffset,
        positions: Object.fromEntries(
          draggedItems.map((item) => [item.id, resolveDesktopIconPosition(item)]),
        ),
      },
      previewItems,
      source: 'desktop',
    };
    vfsItemInvalidTargets.current = new Set(nodeIds);
    for (const nodeId of nodeIds) {
      for (const descendantId of descendantsOf(current.nodes, nodeId)) {
        vfsItemInvalidTargets.current.add(descendantId);
      }
    }
    setVfsItemDragActive(true);
    setVfsItemDragPreviewItems(previewItems);
    setVfsItemDragPointer(null);
    setVfsItemDragSolidShadowIds(new Set());
    setPointerInteractionActive(true);
    setDesktopSelection(new Set(nodeIds));
    setFinderSelection(new Set());
  };

  const resolveVfsItemDrop = useCallback((pointer: Point) => {
    const surface = document.querySelector<HTMLElement>('.desktop-surface');
    if (!surface) return null;
    const target = resolveDesktopDropTarget(
      surface,
      document.elementFromPoint(pointer.x, pointer.y),
      false,
      vfsItemInvalidTargets.current,
      pointer,
    );
    if (!target) return null;
    const layoutParent = target.element.dataset.iconLayoutParent;
    const bounds = layoutParent ? target.element.getBoundingClientRect() : null;
    return {
      ...target,
      iconLocation:
        layoutParent && bounds
          ? {
              parentId: layoutParent,
              point: {
                x: Math.round(pointer.x - bounds.left),
                y: Math.round(pointer.y - bounds.top),
              },
              surfaceSize: {
                width: Math.round(bounds.width),
                height: Math.round(bounds.height),
              },
            }
          : null,
    };
  }, []);

  const previewVfsItemDrag = useCallback(
    (pointer: Point): void => {
      const previewPointer = { x: Math.round(pointer.x), y: Math.round(pointer.y) };
      setVfsItemDragPointer(previewPointer);
      setVfsItemDragSolidShadowIds(
        new Set(
          (vfsItemDrag.current?.previewItems ?? [])
            .filter((item) => previewUsesSolidDesktopShadow(item, previewPointer))
            .map((item) => item.nodeId),
        ),
      );
      const target = resolveVfsItemDrop(pointer);
      if (vfsItemDropTarget.current === target?.element) return;
      clearVfsItemDropTarget();
      if (!target) return;
      vfsItemDropTarget.current = target.element;
      target.element.classList.add('is-file-drop-target');
    },
    [clearVfsItemDropTarget, resolveVfsItemDrop],
  );

  const performVfsMutation = useCallback(
    async (
      command: VfsCommand,
      destinationId: string,
      verb: 'Copied' | 'Moved',
      failureMessage: string,
    ): Promise<void> => {
      const current = stateRef.current;
      if (!current) return;
      const requestSelectionEpoch = selectionEpoch.current;
      try {
        const result = await window.macintosh.mutateVfs({
          command,
          presentation: projectPresentation(current),
        });
        commitVfsMutation(current, result, requestSelectionEpoch, destinationId, verb);
      } catch (error) {
        console.error(error);
        showTransferNotice(failureMessage, true);
      }
    },
    [commitVfsMutation, showTransferNotice],
  );

  const importHostFiles = useCallback(
    async (
      files: File[],
      destinationId: string,
      iconLocation: IconDropLocation | null = null,
    ): Promise<void> => {
      if (files.length === 0) return;
      const current = stateRef.current;
      if (!current) return;
      const requestSelectionEpoch = selectionEpoch.current;
      try {
        const desktopPlacement = desktopPlacementFrom(destinationId, iconLocation);
        const result = await window.macintosh.importFiles(files, {
          parentId: destinationId,
          presentation: projectPresentation(current),
          ...(desktopPlacement ? { desktopPlacement } : {}),
        });
        if (result.affectedIds.length === 0 && result.skippedCount === 0) {
          showTransferNotice('No readable files or folders were found.', true);
          return;
        }
        commitVfsMutation(current, result, requestSelectionEpoch, destinationId, 'Copied');
      } catch (error) {
        console.error(error);
        showTransferNotice('The dropped items could not be copied.', true);
      }
    },
    [commitVfsMutation, showTransferNotice],
  );

  const dropItems = useCallback(
    (
      destinationId: string,
      nodeIds: string[],
      files: File[],
      iconLocation: IconDropLocation | null,
    ): void => {
      if (nodeIds.length > 0) {
        const current = stateRef.current;
        if (!current) return;
        const dragContext = vfsItemDrag.current;
        let translatedPositions: Record<string, Point> | null = null;
        if (iconLocation?.parentId === destinationId && dragContext?.layout) {
          if (destinationId === 'desktop') {
            translatedPositions = translateDesktopIconDrag(
              dragContext.layout,
              iconLocation.point,
              iconLocation.surfaceSize,
            );
            if (!translatedPositions) {
              showTransferNotice('The selected items do not fit on the Desktop.', true);
              return;
            }
          } else {
            translatedPositions = translateFinderIconDrag(dragContext.layout, iconLocation.point);
          }
        }
        const desktopPlacement = translatedPositions
          ? undefined
          : desktopPlacementFrom(destinationId, iconLocation);
        const placementsFor = (ids: string[]) =>
          ids.flatMap((nodeId) => {
            const position = translatedPositions?.[nodeId];
            return position ? [{ nodeId, position }] : [];
          });

        if (translatedPositions && dragContext?.parentId === destinationId) {
          const positioned = placeFinderIcons(
            current,
            destinationId,
            placementsFor(dragContext.nodeIds),
          );
          if (positioned !== current) {
            replaceState(positioned);
          }
          if (destinationId === 'desktop') {
            setDesktopSelection(new Set(dragContext.nodeIds));
            setFinderSelection(new Set());
          } else {
            setFinderSelection(new Set(dragContext.nodeIds));
            setDesktopSelection(new Set());
          }
          return;
        }

        void performVfsMutation(
          {
            type: 'move-nodes',
            nodeIds,
            parentId: destinationId,
            ...(translatedPositions
              ? { placements: placementsFor(dragContext?.nodeIds ?? nodeIds) }
              : {}),
            ...(desktopPlacement ? { desktopPlacement } : {}),
          },
          destinationId,
          'Moved',
          'The selected items could not be moved.',
        );
        return;
      }
      void importHostFiles(files, destinationId, iconLocation);
    },
    [
      importHostFiles,
      performVfsMutation,
      replaceState,
      setDesktopSelection,
      setFinderSelection,
      showTransferNotice,
    ],
  );

  const finishVfsItemDrag = (pointer: Point): void => {
    const context = vfsItemDrag.current;
    const target = resolveVfsItemDrop(pointer);
    clearVfsItemDropTarget();
    if (context && target) {
      dropItems(target.destinationId, context.nodeIds, [], target.iconLocation);
    }
    vfsItemDrag.current = null;
    vfsItemInvalidTargets.current.clear();
    setVfsItemDragActive(false);
    setVfsItemDragPreviewItems([]);
    setVfsItemDragPointer(null);
    setVfsItemDragSolidShadowIds(new Set());
    setPointerInteractionActive(false);
  };

  const cancelVfsItemDrag = useCallback((): void => {
    vfsItemDrag.current = null;
    vfsItemInvalidTargets.current.clear();
    clearVfsItemDropTarget();
    setVfsItemDragActive(false);
    setVfsItemDragPreviewItems([]);
    setVfsItemDragPointer(null);
    setVfsItemDragSolidShadowIds(new Set());
    setPointerInteractionActive(false);
  }, [clearVfsItemDropTarget, setPointerInteractionActive, setVfsItemDragActive]);

  const startIconDrag = (id: SpecialDesktopIconId, origin: Point, pointerOrigin: Point): void => {
    dragOrigins.current[id] = origin;
    setDraggingIcon(id);
    setSnappingIcon(null);
    if (id === 'system-disk') {
      const icon = document.querySelector<SVGElement>(
        '[data-desktop-icon="system-disk"] .pixel-icon',
      );
      const bounds = icon?.getBoundingClientRect();
      const [previewItem] = bounds
        ? createIconDragPreviewItems(
            [
              {
                nodeId: id,
                bounds: {
                  left: bounds.left,
                  top: bounds.top,
                  width: bounds.width,
                  height: bounds.height,
                },
              },
            ],
            pointerOrigin,
          )
        : [];
      systemDiskDragPreviewItemRef.current = previewItem ?? null;
      setSystemDiskDragPreviewItem(previewItem ?? null);
      setSystemDiskDragPointer(pointerOrigin);
      setSystemDiskDragSolidShadow(
        previewItem ? previewUsesSolidDesktopShadow(previewItem, pointerOrigin) : false,
      );
    }
    selectDesktopIcon(id, false);
  };

  const pointerTargetsTrash = (pointer: Point): boolean => {
    const trash = document.querySelector<HTMLElement>('[data-desktop-icon="trash"]');
    if (!trash) return false;
    return isTrashDropPoint(pointer, trash);
  };

  const previewIconDrag = (id: SpecialDesktopIconId, position: Point, pointer: Point): void => {
    const surface = document.querySelector<HTMLElement>('.desktop-surface');
    const maxX = Math.max(0, (surface?.clientWidth ?? window.innerWidth) - 90);
    const maxY = Math.max(0, (surface?.clientHeight ?? window.innerHeight - 24) - 92);
    const next = { x: clamp(position.x, 0, maxX), y: clamp(position.y, 0, maxY) };
    setPreviewPositions((current) => ({ ...current, [id]: next }));

    if (id !== 'system-disk') return;
    setSystemDiskDragPointer(pointer);
    setSystemDiskDragSolidShadow(
      systemDiskDragPreviewItemRef.current
        ? previewUsesSolidDesktopShadow(systemDiskDragPreviewItemRef.current, pointer)
        : false,
    );
    setTrashHover(pointerTargetsTrash(pointer));
  };

  const cancelIconDrag = (id: SpecialDesktopIconId): void => {
    setPreviewPositions((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete dragOrigins.current[id];
    setDraggingIcon(null);
    setSnappingIcon(null);
    setTrashHover(false);
    if (id === 'system-disk') clearSystemDiskDragPreview();
  };

  const ejectSystemDisk = (): void => {
    const current = stateRef.current ?? state;
    if (!current || ejecting || writeExitIntent.current) return;
    const diskOrigin = dragOrigins.current['system-disk'] ?? current.desktop.diskPosition;
    const dirtyIds = writeWindowsRef.current.filter((item) => item.dirty).map((item) => item.id);
    if (dirtyIds.length === 0) {
      void performEjectSystemDisk(diskOrigin);
      return;
    }

    restoreIcon('system-disk');
    setOpenMenu(null);
    writeExitIntent.current = { type: 'eject', diskOrigin };
    quitWriteQueue.current = dirtyIds;
    quitWriteTotal.current = dirtyIds.length;
    continueQuitReview();
  };

  const finishIconDrag = (id: SpecialDesktopIconId, pointer: Point): void => {
    if (!state) return;
    if (id === 'system-disk' && pointerTargetsTrash(pointer)) {
      ejectSystemDisk();
      return;
    }
    const position =
      previewPositions[id] ??
      (id === 'system-disk' ? state.desktop.diskPosition : state.desktop.trashPosition);
    updateState((current) => ({
      ...current,
      desktop: {
        ...current.desktop,
        ...(id === 'system-disk' ? { diskPosition: position } : { trashPosition: position }),
      },
    }));
    setPreviewPositions((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete dragOrigins.current[id];
    setDraggingIcon(null);
    setTrashHover(false);
    if (id === 'system-disk') clearSystemDiskDragPreview();
  };

  const createFolder = useCallback((): void => {
    const current = stateRef.current;
    if (!current) return;
    const parentId = finderCommandDestinationId(current, activeFinderWindowId);
    const requestSelectionEpoch = selectionEpoch.current;
    void window.macintosh
      .mutateVfs({
        command: { type: 'create-folder', parentId },
        presentation: projectPresentation(current),
      })
      .then((result) => {
        const next = mergePresentation(
          result.state,
          projectPresentation(stateRef.current ?? current),
        );
        replaceState(next);
        const addedId = result.affectedIds[0];
        if (!addedId) {
          showTransferNotice('A new folder could not be created.', true);
          return;
        }
        if (selectionEpoch.current === requestSelectionEpoch) {
          if (parentId === 'desktop') {
            setDesktopSelection(new Set([addedId]));
            setFinderSelection(new Set());
          } else {
            setDesktopSelection(new Set());
            setFinderSelection(new Set([addedId]));
          }
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        showTransferNotice('A new folder could not be created.', true);
      });
  }, [
    activeFinderWindowId,
    replaceState,
    setDesktopSelection,
    setFinderSelection,
    showTransferNotice,
  ]);

  const selectedNode = useMemo(() => {
    if (!state) return null;
    const finderNode = visibleSelection[0];
    if (finderNode) return finderNode;
    const desktopId = desktopSelection.values().next().value;
    return desktopId ? (state.nodes.find((node) => node.id === desktopId) ?? null) : null;
  }, [desktopSelection, state, visibleSelection]);

  const copyFinderSelection = useCallback((): boolean => {
    const current = stateRef.current;
    if (!current) return false;
    const nodeIds = copyableFinderSelectionIds.filter((id) =>
      current.nodes.some((node) => node.id === id),
    );
    if (nodeIds.length === 0) return false;
    clipboardNodeIds.current = nodeIds;
    showTransferNotice(
      `Copied ${nodeIds.length} ${plural(nodeIds.length, 'item')} to the Clipboard.`,
    );
    return true;
  }, [copyableFinderSelectionIds, showTransferNotice]);

  const pasteCopiedItems = useCallback((): boolean => {
    const current = stateRef.current;
    if (!current || clipboardNodeIds.current.length === 0) return false;
    const destinationId = finderCommandDestinationId(current, activeFinderWindowId);
    void performVfsMutation(
      {
        type: 'duplicate-nodes',
        nodeIds: clipboardNodeIds.current,
        parentId: destinationId,
      },
      destinationId,
      'Copied',
      'The copied items could not be pasted.',
    );
    return true;
  }, [activeFinderWindowId, performVfsMutation]);

  const pasteText = useCallback(
    (content: string): void => {
      const current = stateRef.current;
      if (!current) return;
      const destinationId = finderCommandDestinationId(current, activeFinderWindowId);
      void performVfsMutation(
        {
          type: 'create-document',
          parentId: destinationId,
          name: 'Clipboard',
          payload: { format: 'plain-text', text: content },
        },
        destinationId,
        'Copied',
        'The Clipboard text could not be pasted.',
      );
    },
    [activeFinderWindowId, performVfsMutation],
  );

  const pasteFromClipboard = useCallback((): void => {
    if (pasteCopiedItems()) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pasteTarget = document.createElement('textarea');
    pasteTarget.setAttribute('aria-hidden', 'true');
    pasteTarget.tabIndex = -1;
    pasteTarget.style.position = 'fixed';
    pasteTarget.style.width = '1px';
    pasteTarget.style.height = '1px';
    pasteTarget.style.opacity = '0';
    pasteTarget.style.pointerEvents = 'none';
    document.body.append(pasteTarget);
    pasteTarget.focus();
    void window.macintosh
      .requestPaste()
      .catch((error: unknown) => {
        console.error(error);
        showTransferNotice('The Clipboard could not be read.', true);
      })
      .finally(() => {
        pasteTarget.remove();
        previousFocus?.focus({ preventScroll: true });
      });
  }, [pasteCopiedItems, showTransferNotice]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      if (systemInputBlocked) return;
      if (event.target instanceof Element && event.target.closest('[data-write-editor]')) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files);
      const current = stateRef.current;
      if (!current) return;
      const destinationId = finderCommandDestinationId(current, activeFinderWindowId);
      if (files.length > 0) {
        event.preventDefault();
        void importHostFiles(files, destinationId);
        return;
      }
      const text = clipboard.getData('text/plain');
      if (text.length > 0) {
        event.preventDefault();
        pasteText(text);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeFinderWindowId, importHostFiles, pasteText, systemInputBlocked]);

  useEffect(() => {
    const clearInternalClipboard = (): void => {
      clipboardNodeIds.current = [];
      cancelPointerInteractions();
    };
    window.addEventListener('blur', clearInternalClipboard);
    return () => window.removeEventListener('blur', clearInternalClipboard);
  }, [cancelPointerInteractions]);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);

  const openSelected = useCallback((): void => {
    if (selectedNode) openNode(selectedNode.id);
  }, [openNode, selectedNode]);

  const selectAll = useCallback((): void => {
    if (!state) return;
    if (activeNode && activeNode.kind !== 'document') {
      setFinderSelection(
        new Set(
          listChildren(state.nodes, activeNode.id, state.desktop.viewMode).map((item) => item.id),
        ),
      );
      setDesktopSelection(new Set());
    } else {
      setDesktopSelection(
        new Set(['system-disk', 'trash', ...desktopItems.map((item) => item.id)]),
      );
      setFinderSelection(new Set());
    }
  }, [activeNode, desktopItems, setDesktopSelection, setFinderSelection, state]);

  const openCalculator = useCallback((): void => {
    setCalculatorOpen(true);
    setActiveOwner((owner) => {
      if (owner.type !== 'calculator') calculatorReturnOwner.current = owner;
      return { type: 'calculator', id: 'calculator' };
    });
  }, []);

  const closeCalculator = useCallback((): void => {
    setCalculatorOpen(false);
    const requested = calculatorReturnOwner.current;
    if (
      requested.type === 'write' &&
      writeWindowsRef.current.some((window) => window.id === requested.id)
    ) {
      setActiveOwner(requested);
      return;
    }
    if (
      requested.type === 'finder' &&
      (requested.id === null ||
        stateRef.current?.desktop.windows.some((window) => window.id === requested.id))
    ) {
      setActiveOwner(requested);
      return;
    }
    const finderWindowId = stateRef.current?.desktop.windows.at(-1)?.id;
    const writeWindow = writeWindowsRef.current.at(-1);
    setActiveOwner(
      finderWindowId
        ? { type: 'finder', id: finderWindowId }
        : writeWindow
          ? { type: 'write', id: writeWindow.id }
          : { type: 'finder', id: null },
    );
  }, []);

  const emptyTrashAndClearSelection = useCallback((): void => {
    const current = stateRef.current;
    if (!current) return;
    setFinderSelection(new Set());
    void window.macintosh
      .mutateVfs({
        command: { type: 'empty-trash' },
        presentation: projectPresentation(current),
      })
      .then((result) => {
        const next = mergePresentation(
          result.state,
          projectPresentation(stateRef.current ?? current),
        );
        replaceState(next);
      })
      .catch((error: unknown) => {
        console.error(error);
        showTransferNotice('Trash could not be emptied.', true);
      });
  }, [replaceState, setFinderSelection, showTransferNotice]);

  const menus = useMemo<MenuDefinition[]>(() => {
    if (!state) return [];
    if (activeOwner.type === 'write') {
      const writeWindow = writeWindows.find((item) => item.id === activeOwner.id);
      if (writeWindow) {
        const context = writeContexts[writeWindow.id] ?? defaultWriteContext();
        const runClipboard = (action: 'copy' | 'cut' | 'paste'): void => {
          void writeEditors.current
            .get(writeWindow.id)
            ?.clipboard(action)
            .catch((error: unknown) => {
              console.error(error);
              showTransferNotice('The Clipboard operation could not be completed.', true);
            });
        };
        const writeSystemMenu: MenuDefinition = {
          id: 'system',
          system: true,
          entries: [
            {
              id: 'about',
              label: 'About This Macintosh…',
              action: () => setDialog({ type: 'about' }),
            },
            { id: 'system-separator-about', separator: true },
            { id: 'calculator', label: 'Calculator', action: openCalculator },
          ],
        };
        return [
          writeSystemMenu,
          {
            id: 'file',
            label: 'File',
            entries: [
              { id: 'new-document', label: 'New', shortcut: 'n', action: newWriteDocument },
              {
                id: 'open-document',
                label: 'Open…',
                shortcut: 'o',
                action: () => setWriteFileDialog({ type: 'open' }),
              },
              {
                id: 'close-write-window',
                label: 'Close',
                shortcut: 'w',
                action: () => requestWriteClose(writeWindow.id),
              },
              { id: 'write-file-separator', separator: true },
              {
                id: 'save-document',
                label: 'Save',
                shortcut: 's',
                action: () => {
                  if (writeWindow.documentId) void saveWriteDocument(writeWindow.id);
                  else
                    setWriteFileDialog({
                      type: 'save-as',
                      windowId: writeWindow.id,
                      after: 'none',
                    });
                },
              },
              {
                id: 'save-document-as',
                label: 'Save As…',
                action: () =>
                  setWriteFileDialog({
                    type: 'save-as',
                    windowId: writeWindow.id,
                    after: 'none',
                  }),
              },
            ],
          },
          {
            id: 'edit',
            label: 'Edit',
            entries: [
              {
                id: 'undo',
                label: 'Undo',
                shortcut: 'z',
                disabled: !context.canUndo,
                action: () => executeWriteCommand({ type: 'undo' }),
              },
              {
                id: 'redo',
                label: 'Redo',
                disabled: !context.canRedo,
                action: () => executeWriteCommand({ type: 'redo' }),
              },
              { id: 'write-edit-separator', separator: true },
              { id: 'cut', label: 'Cut', shortcut: 'x', action: () => runClipboard('cut') },
              { id: 'copy', label: 'Copy', shortcut: 'c', action: () => runClipboard('copy') },
              { id: 'paste', label: 'Paste', shortcut: 'v', action: () => runClipboard('paste') },
              { id: 'write-edit-separator-2', separator: true },
              {
                id: 'select-all',
                label: 'Select All',
                shortcut: 'a',
                action: () => executeWriteCommand({ type: 'select-all' }),
              },
            ],
          },
          {
            id: 'format',
            label: 'Format',
            entries: [
              {
                id: 'bold',
                label: 'Bold',
                shortcut: 'b',
                checked: context.style.bold,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'mark', mark: 'bold' }),
              },
              {
                id: 'italic',
                label: 'Italic',
                shortcut: 'i',
                checked: context.style.italic,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'mark', mark: 'italic' }),
              },
              {
                id: 'underline',
                label: 'Underline',
                shortcut: 'u',
                checked: context.style.underline,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'mark', mark: 'underline' }),
              },
              { id: 'write-format-separator', separator: true },
              {
                id: 'align-left',
                label: 'Left',
                checked: context.style.alignment === 'left',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'alignment', value: 'left' }),
              },
              {
                id: 'align-center',
                label: 'Center',
                checked: context.style.alignment === 'center',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'alignment', value: 'center' }),
              },
              {
                id: 'align-right',
                label: 'Right',
                checked: context.style.alignment === 'right',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'alignment', value: 'right' }),
              },
              { id: 'write-format-separator-2', separator: true },
              {
                id: 'increase-left-indent',
                label: 'Increase Left Indent',
                disabled: !context.canFormat,
                action: () =>
                  executeWriteCommand({
                    type: 'left-indent',
                    value: context.style.leftIndent + 18,
                  }),
              },
              {
                id: 'decrease-left-indent',
                label: 'Decrease Left Indent',
                disabled: !context.canFormat || context.style.leftIndent <= 0,
                action: () =>
                  executeWriteCommand({
                    type: 'left-indent',
                    value: Math.max(0, context.style.leftIndent - 18),
                  }),
              },
              { id: 'write-format-separator-3', separator: true },
              {
                id: 'line-spacing-1',
                label: 'Single Spacing',
                checked: context.style.lineSpacing === 1,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'line-spacing', value: 1 }),
              },
              {
                id: 'line-spacing-1.5',
                label: '1.5 Spacing',
                checked: context.style.lineSpacing === 1.5,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'line-spacing', value: 1.5 }),
              },
              {
                id: 'line-spacing-2',
                label: 'Double Spacing',
                checked: context.style.lineSpacing === 2,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'line-spacing', value: 2 }),
              },
              { id: 'write-format-separator-4', separator: true },
              {
                id: 'insert-page-break',
                label: 'Insert Page Break',
                action: () => executeWriteCommand({ type: 'page-break' }),
              },
            ],
          },
          {
            id: 'font',
            label: 'Font',
            entries: [
              {
                id: 'font-serif',
                label: 'Serif',
                checked: context.style.fontFamily === 'serif',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-family', value: 'serif' }),
              },
              {
                id: 'font-sans',
                label: 'Sans',
                checked: context.style.fontFamily === 'sans',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-family', value: 'sans' }),
              },
              {
                id: 'font-mono',
                label: 'Monospaced',
                checked: context.style.fontFamily === 'mono',
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-family', value: 'mono' }),
              },
            ],
          },
          {
            id: 'size',
            label: 'Size',
            entries: [
              {
                id: 'size-9',
                label: '9',
                checked: context.style.fontSize === 9,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 9 }),
              },
              {
                id: 'size-10',
                label: '10',
                checked: context.style.fontSize === 10,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 10 }),
              },
              {
                id: 'size-12',
                label: '12',
                checked: context.style.fontSize === 12,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 12 }),
              },
              {
                id: 'size-14',
                label: '14',
                checked: context.style.fontSize === 14,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 14 }),
              },
              {
                id: 'size-18',
                label: '18',
                checked: context.style.fontSize === 18,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 18 }),
              },
              {
                id: 'size-24',
                label: '24',
                checked: context.style.fontSize === 24,
                disabled: !context.canFormat,
                action: () => executeWriteCommand({ type: 'font-size', value: 24 }),
              },
            ],
          },
          {
            id: 'view',
            label: 'View',
            entries: [
              {
                id: 'zoom-50',
                label: '50%',
                checked: writeWindow.zoom === 50,
                action: () => setWriteZoom(writeWindow.id, 50),
              },
              {
                id: 'zoom-75',
                label: '75%',
                checked: writeWindow.zoom === 75,
                action: () => setWriteZoom(writeWindow.id, 75),
              },
              {
                id: 'zoom-100',
                label: '100%',
                checked: writeWindow.zoom === 100,
                action: () => setWriteZoom(writeWindow.id, 100),
              },
            ],
          },
        ];
      }
    }
    const trashHasItems = state.nodes.some((node) => node.parentId === 'trash');
    return [
      {
        id: 'system',
        system: true,
        entries: [
          {
            id: 'about',
            label: 'About This Macintosh…',
            action: () => setDialog({ type: 'about' }),
          },
          { id: 'system-separator-about', separator: true },
          {
            id: 'calculator',
            label: 'Calculator',
            action: openCalculator,
          },
          { id: 'system-separator-info', separator: true },
          {
            id: 'system-info',
            label: 'System Disk Info',
            action: () => {
              const disk = state.nodes.find((node) => node.id === 'system-disk');
              if (disk) setDialog({ type: 'info', node: disk });
            },
          },
        ],
      },
      {
        id: 'file',
        label: 'File',
        entries: [
          { id: 'new-folder', label: 'New Folder', shortcut: 'n', action: createFolder },
          {
            id: 'open',
            label: 'Open',
            shortcut: 'o',
            disabled: !selectedNode,
            action: openSelected,
          },
          {
            id: 'close',
            label: 'Close Window',
            shortcut: 'w',
            disabled: !activeWindow,
            action: () => activeWindow && closeWindow(activeWindow.id),
          },
          { id: 'file-separator', separator: true },
          {
            id: 'get-info',
            label: 'Get Info',
            shortcut: 'i',
            disabled: !selectedNode,
            action: () => selectedNode && setDialog({ type: 'info', node: selectedNode }),
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        entries: [
          { id: 'undo', label: 'Undo', disabled: true },
          { id: 'edit-separator', separator: true },
          { id: 'cut', label: 'Cut', disabled: true },
          {
            id: 'copy',
            label: 'Copy',
            shortcut: 'c',
            disabled: copyableFinderSelectionIds.length === 0,
            action: () => copyFinderSelection(),
          },
          { id: 'paste', label: 'Paste', shortcut: 'v', action: pasteFromClipboard },
          { id: 'edit-separator-2', separator: true },
          { id: 'select-all', label: 'Select All', shortcut: 'a', action: selectAll },
          {
            id: 'clear-selection',
            label: 'Clear Selection',
            action: () => {
              setDesktopSelection(new Set());
              setFinderSelection(new Set());
            },
          },
        ],
      },
      {
        id: 'view',
        label: 'View',
        entries: [
          {
            id: 'view-icons',
            label: 'by Icon',
            checked: state.desktop.viewMode === 'icons',
            action: () =>
              updateState((current) => ({
                ...current,
                desktop: { ...current.desktop, viewMode: 'icons' },
              })),
          },
          {
            id: 'view-list',
            label: 'by Name',
            checked: state.desktop.viewMode === 'list',
            action: () =>
              updateState((current) => ({
                ...current,
                desktop: { ...current.desktop, viewMode: 'list' },
              })),
          },
          { id: 'view-separator', separator: true },
          {
            id: 'clean-window',
            label: 'Clean Up Window',
            disabled: true,
          },
        ],
      },
      {
        id: 'special',
        label: 'Special',
        entries: [
          {
            id: 'empty-trash',
            label: 'Empty Trash',
            disabled: !trashHasItems,
            action: emptyTrashAndClearSelection,
          },
          {
            id: 'clean-desktop',
            label: 'Clean Up Desktop',
            action: () => {
              const defaults = createDefaultState().desktop;
              updateState((current) => ({
                ...current,
                desktop: {
                  ...current.desktop,
                  diskPosition: defaults.diskPosition,
                  trashPosition: defaults.trashPosition,
                },
              }));
            },
          },
          { id: 'special-separator', separator: true },
          {
            id: 'eject-tip',
            label: 'Eject System Disk…',
            action: () => setDialog({ type: 'eject-tip' }),
          },
        ],
      },
    ];
  }, [
    activeOwner,
    activeWindow,
    closeWindow,
    copyFinderSelection,
    copyableFinderSelectionIds.length,
    createFolder,
    emptyTrashAndClearSelection,
    executeWriteCommand,
    newWriteDocument,
    openCalculator,
    openSelected,
    pasteFromClipboard,
    requestWriteClose,
    saveWriteDocument,
    selectAll,
    selectedNode,
    setDesktopSelection,
    setFinderSelection,
    state,
    writeContexts,
    writeWindows,
    setWriteZoom,
    showTransferNotice,
    updateState,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (systemInputBlocked) return;
      const entry = findMenuShortcutEntry(menus, event);
      if (!entry) return;
      event.preventDefault();
      invokeMenuEntry(entry);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [invokeMenuEntry, menus, systemInputBlocked]);

  if (!startupComplete || !state) {
    return <StartupScreen automation={automation} onComplete={() => setStartupComplete(true)} />;
  }

  const diskPosition =
    draggingIcon === 'system-disk'
      ? state.desktop.diskPosition
      : (previewPositions['system-disk'] ?? state.desktop.diskPosition);
  const trashPosition = previewPositions.trash ?? state.desktop.trashPosition;
  const activeWindowId = state.desktop.windows.at(-1)?.id ?? null;
  const itemDragging = draggingIcon !== null || vfsItemDragging;
  const pendingWriteWindow = pendingWriteClose
    ? writeWindows.find((item) => item.id === pendingWriteClose.windowId)
    : undefined;
  const saveAsWindow =
    writeFileDialog?.type === 'save-as'
      ? writeWindows.find((item) => item.id === writeFileDialog.windowId)
      : undefined;

  return (
    <main
      aria-label="The Macintosh desktop"
      aria-busy={normalQuitPending}
      className={[
        'macintosh',
        automation ? 'is-automation' : '',
        itemDragging ? 'is-item-dragging' : '',
        normalQuitPending ? 'is-normal-quit-pending' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-item-dragging={itemDragging ? 'true' : undefined}
      data-normal-quit-pending={normalQuitPending ? 'true' : undefined}
    >
      <MenuBar
        clock={clock}
        menus={menus}
        onInvoke={invokeMenuEntry}
        onOpenMenuChange={setOpenMenu}
        openMenu={openMenu}
      />
      <DesktopSurface
        interactionCancelToken={interactionCancelToken}
        onBackgroundClick={() => {
          setActiveOwner({ type: 'finder', id: null });
          setDesktopSelection(new Set());
          setFinderSelection(new Set());
        }}
        onMarquee={(ids) => {
          setDesktopSelection(new Set(ids));
          setFinderSelection(new Set());
        }}
        onDropItems={dropItems}
        onInteractionChange={setPointerInteractionActive}
        vfsCount={state.nodes.length}
      >
        {state.desktop.windows.map((windowState, index) => {
          const animation = windowAnimations[windowState.id];
          const node = state.nodes.find((item) => item.id === windowState.nodeId);
          if (!animation || !node || node.kind === 'desktop') return null;
          return (
            <FinderWindowAnimationShadow
              animation={animation}
              key={`${windowState.id}-animation-shadow`}
              stackIndex={index}
              windowState={windowState}
            />
          );
        })}
        {state.desktop.windows.map((windowState, index) => {
          const node = state.nodes.find((item) => item.id === windowState.nodeId);
          if (!node || node.kind === 'desktop') return null;
          const items = listChildren(state.nodes, node.id, state.desktop.viewMode);
          return (
            <FinderWindow
              active={
                activeOwner.type === 'finder' &&
                activeOwner.id === windowState.id &&
                activeWindowId === windowState.id
              }
              animation={windowAnimations[windowState.id]}
              interactionCancelToken={interactionCancelToken}
              items={items}
              key={windowState.id}
              node={node}
              onActivate={activateWindow}
              onAnimationComplete={finishWindowAnimation}
              onClose={closeWindow}
              onGeometry={setWindowGeometry}
              onItemDragCancel={cancelVfsItemDrag}
              onItemDragMove={previewVfsItemDrag}
              onItemDragStart={startFinderItemDrag}
              onItemDragEnd={finishVfsItemDrag}
              onItemOpen={openNode}
              onItemSelect={selectFinderItem}
              onInteractionChange={setPointerInteractionActive}
              onZoom={zoomWindow}
              selectedIds={finderSelection}
              stackIndex={index}
              viewMode={state.desktop.viewMode}
              windowState={windowState}
            />
          );
        })}
        {writeWindows.map((windowState, index) => (
          <WriteWindow
            active={activeOwner.type === 'write' && activeOwner.id === windowState.id}
            context={writeContexts[windowState.id] ?? defaultWriteContext()}
            interactionCancelToken={interactionCancelToken}
            key={windowState.id}
            onActivate={activateWriteWindow}
            onClose={requestWriteClose}
            onDraftChange={updateWriteDraft}
            onEditorContext={updateWriteContext}
            onEditorRegistration={registerWriteEditor}
            onGeometry={setWriteWindowGeometry}
            onInteractionChange={setPointerInteractionActive}
            onPaginationChange={updateWritePagination}
            onZoom={zoomWriteWindow}
            stackIndex={index}
            windowState={windowState}
          />
        ))}
        {calculatorOpen ? (
          <CalculatorWindow
            active={activeOwner.type === 'calculator'}
            interactionCancelToken={interactionCancelToken}
            keyboardEnabled={keyboardOwner === 'calculator'}
            onActivate={() => setActiveOwner({ type: 'calculator', id: 'calculator' })}
            onClose={closeCalculator}
            onInteractionChange={setPointerInteractionActive}
          />
        ) : null}
        {desktopItems.map((item) => (
          <DesktopVfsIcon
            interactionCancelToken={interactionCancelToken}
            key={item.id}
            node={item}
            onDragCancel={cancelVfsItemDrag}
            onDragEnd={finishVfsItemDrag}
            onDragMove={previewVfsItemDrag}
            onDragStart={startDesktopItemDrag}
            onInteractionChange={setPointerInteractionActive}
            onOpen={openNode}
            onSelect={selectDesktopIcon}
            position={resolveDesktopIconPosition(item)}
            selected={desktopSelection.has(item.id)}
          />
        ))}
        <DesktopIcon
          ejecting={ejecting}
          icon="disk"
          id="system-disk"
          interactionCancelToken={interactionCancelToken}
          label="System Disk"
          onDrag={previewIconDrag}
          onDragCancel={cancelIconDrag}
          onDragEnd={finishIconDrag}
          onDragStart={startIconDrag}
          onInteractionChange={setPointerInteractionActive}
          onOpen={openNode}
          onSelect={selectDesktopIcon}
          position={diskPosition}
          selected={desktopSelection.has('system-disk')}
          snapping={snappingIcon === 'system-disk'}
        />
        <DesktopIcon
          dragging={draggingIcon === 'trash'}
          icon={
            trashHover || state.nodes.some((node) => node.parentId === 'trash')
              ? 'trash-full'
              : 'trash'
          }
          id="trash"
          interactionCancelToken={interactionCancelToken}
          label="Trash"
          onDrag={previewIconDrag}
          onDragCancel={cancelIconDrag}
          onDragEnd={finishIconDrag}
          onDragStart={startIconDrag}
          onInteractionChange={setPointerInteractionActive}
          onOpen={openNode}
          onSelect={selectDesktopIcon}
          position={trashPosition}
          selected={desktopSelection.has('trash')}
          snapping={snappingIcon === 'trash'}
          validDropTarget={trashHover}
        />
        {!persistenceError && dialog?.type === 'about' && (
          <AboutDialog
            interactionCancelToken={interactionCancelToken}
            onClose={() => setDialog(null)}
            onInteractionChange={setPointerInteractionActive}
          />
        )}
        {!persistenceError && dialog?.type === 'info' && (
          <InfoDialog
            interactionCancelToken={interactionCancelToken}
            node={dialog.node}
            onClose={() => setDialog(null)}
            onInteractionChange={setPointerInteractionActive}
            where={state.nodes.find((node) => node.id === dialog.node.parentId)?.name ?? 'Desktop'}
          />
        )}
        {!persistenceError && dialog?.type === 'eject-tip' && (
          <EjectTipDialog
            interactionCancelToken={interactionCancelToken}
            onClose={() => setDialog(null)}
            onInteractionChange={setPointerInteractionActive}
          />
        )}
        {!persistenceError && writeFileDialog?.type === 'open' && (
          <VirtualFileDialog
            interactionCancelToken={interactionCancelToken}
            mode="open"
            nodes={state.nodes}
            onCancel={() => setWriteFileDialog(null)}
            onInteractionChange={setPointerInteractionActive}
            onOpen={(nodeId) => {
              setWriteFileDialog(null);
              openWriteDocument(nodeId);
            }}
            onSave={() => undefined}
          />
        )}
        {!persistenceError && writeFileDialog?.type === 'save-as' && saveAsWindow && (
          <VirtualFileDialog
            initialName={saveAsWindow.title}
            interactionCancelToken={interactionCancelToken}
            mode="save-as"
            nodes={state.nodes}
            onCancel={() => {
              const quitting =
                writeFileDialog.after === 'quit' || writeFileDialog.after === 'eject';
              setWriteFileDialog(null);
              if (quitting) cancelWriteExitReview();
            }}
            onInteractionChange={setPointerInteractionActive}
            onOpen={() => undefined}
            onSave={(parentId, name) =>
              void saveWriteAs(saveAsWindow.id, parentId, name, writeFileDialog.after)
            }
            saving={writeSaving}
          />
        )}
        {!persistenceError && pendingWriteClose && pendingWriteWindow && (
          <UnsavedChangesDialog
            detail={
              pendingWriteClose.reason === 'quit'
                ? `Document ${pendingWriteClose.position} of ${pendingWriteClose.total}. The Macintosh will quit after all open documents are reviewed.`
                : pendingWriteClose.reason === 'eject'
                  ? `Document ${pendingWriteClose.position} of ${pendingWriteClose.total}. The disk will eject after all open documents are reviewed.`
                  : undefined
            }
            interactionCancelToken={interactionCancelToken}
            onCancel={() => {
              if (pendingWriteClose.reason !== 'close') cancelWriteExitReview();
              else setPendingWriteClose(null);
            }}
            onDiscard={() => {
              setPendingWriteClose(null);
              if (pendingWriteClose.reason === 'close') removeWriteWindow(pendingWriteWindow.id);
              else continueQuitReview();
            }}
            onInteractionChange={setPointerInteractionActive}
            onSave={() => {
              if (!pendingWriteWindow.documentId) {
                setPendingWriteClose(null);
                setWriteFileDialog({
                  type: 'save-as',
                  windowId: pendingWriteWindow.id,
                  after: pendingWriteClose.reason,
                });
                return;
              }
              void saveWriteDocument(pendingWriteWindow.id).then((saved) => {
                if (!saved) return;
                setPendingWriteClose(null);
                if (pendingWriteClose.reason === 'close') {
                  removeWriteWindow(pendingWriteWindow.id);
                } else {
                  continueQuitReview();
                }
              });
            }}
            saving={writeSaving}
            title={pendingWriteWindow.title}
          />
        )}
        {persistenceError && (
          <PersistenceAlert message={persistenceError} onClose={() => setPersistenceError(null)} />
        )}
        {ejecting && (
          <div aria-hidden="true" className="ejection-input-layer" data-drop-blocked="true" />
        )}
        {transferNotice && (
          <div
            className={`transfer-notice ${transferNotice.error ? 'is-error' : ''}`}
            data-transfer-notice="true"
            role={transferNotice.error ? 'alert' : 'status'}
          >
            {transferNotice.message}
          </div>
        )}
      </DesktopSurface>
      {vfsItemDragging && vfsItemDragPointer ? (
        <VfsItemDragPreview
          items={vfsItemDragPreviewItems}
          nodes={state.nodes}
          pointer={vfsItemDragPointer}
          solidShadowIds={vfsItemDragSolidShadowIds}
        />
      ) : null}
      {draggingIcon === 'system-disk' && systemDiskDragPreviewItem && systemDiskDragPointer ? (
        <SystemDiskDragPreview
          item={systemDiskDragPreviewItem}
          pointer={systemDiskDragPointer}
          solidShadow={systemDiskDragSolidShadow}
        />
      ) : null}
    </main>
  );
}
