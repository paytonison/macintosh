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
    !target.closest('[data-finder-window], [data-calculator-window], [role="dialog"]')
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
  const dragOrigins = useRef<Partial<Record<SpecialDesktopIconId, Point>>>({});
  const systemDiskDragPreviewItemRef = useRef<IconDragPreviewItem | null>(null);
  const vfsItemDrag = useRef<VfsItemDragContext | null>(null);
  const vfsItemInvalidTargets = useRef<Set<string>>(new Set());
  const vfsItemDraggingRef = useRef(false);
  const vfsItemDropTarget = useRef<HTMLElement | null>(null);
  const zoomRestore = useRef<Map<string, WindowGeometry>>(new Map());
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
        document.body.dataset.stateLoaded = 'true';
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        hydrated.current = true;
        replaceState(createDefaultState());
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

  useEffect(() => {
    const removeListener = window.macintosh.onNormalQuitRequested(() => {
      if (normalQuitFlush.current) return;
      if (persistenceTimer.current) {
        clearTimeout(persistenceTimer.current);
        persistenceTimer.current = null;
      }
      cancelPointerInteractions();
      setOpenMenu(null);
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
    });
    void window.macintosh.signalNormalQuitReady().catch((error: unknown) => {
      console.error('Could not announce normal-quit readiness:', error);
    });
    return () => {
      removeListener();
      document.documentElement.classList.remove('is-normal-quit-pending');
    };
  }, [cancelPointerInteractions, reportPersistenceError, setNormalQuitInteraction]);

  const ready = Boolean(state && startupComplete);
  useEffect(() => {
    document.body.dataset.macReady = ready ? 'true' : 'false';
  }, [ready]);

  const finderCommandContext = useMemo(
    () => deriveFinderCommandContext(state, finderSelection),
    [finderSelection, state],
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
    dialogOpen: dialog !== null,
    ejectionInProgress: ejecting,
    pointerSessionActive,
    menuOpen: openMenu !== null,
    calculatorOpen,
    finderWindowOpen: activeWindow !== null,
  });
  const systemInputBlocked =
    keyboardOwner === 'persistence-alert' ||
    keyboardOwner === 'normal-quit' ||
    keyboardOwner === 'dialog' ||
    keyboardOwner === 'ejection' ||
    keyboardOwner === 'pointer-session';

  const activateWindow = useCallback(
    (windowId: string): void => {
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
      const windowId = `window-${nodeId}`;
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
          width: node.kind === 'document' ? 520 : 640,
          height: node.kind === 'document' ? 390 : 420,
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
    [replaceState, setDesktopSelection, setFinderSelection],
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

  const selectDesktopIcon = (id: string, additive: boolean): void => {
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

  const clearSystemDiskDragPreview = (): void => {
    systemDiskDragPreviewItemRef.current = null;
    setSystemDiskDragPreviewItem(null);
    setSystemDiskDragPointer(null);
    setSystemDiskDragSolidShadow(false);
  };

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

  const restoreIcon = (id: SpecialDesktopIconId): void => {
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
  };

  const ejectSystemDisk = async (): Promise<void> => {
    if (!state || ejecting) return;
    const diskOrigin = dragOrigins.current['system-disk'] ?? state.desktop.diskPosition;
    setOpenMenu(null);
    setEjecting(true);
    setDraggingIcon(null);
    clearSystemDiskDragPreview();
    setTrashHover(true);
    playEjectSound();
    await pause(automation ? 280 : 920);

    const current = stateRef.current ?? state;
    const nextState = {
      ...current,
      desktop: {
        ...current.desktop,
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
  };

  const finishIconDrag = (id: SpecialDesktopIconId, pointer: Point): void => {
    if (!state) return;
    if (id === 'system-disk' && pointerTargetsTrash(pointer)) {
      void ejectSystemDisk();
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
    const parentId = finderCommandDestinationId(current);
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
  }, [replaceState, setDesktopSelection, setFinderSelection, showTransferNotice]);

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
    const destinationId = finderCommandDestinationId(current);
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
  }, [performVfsMutation]);

  const pasteText = useCallback(
    (content: string): void => {
      const current = stateRef.current;
      if (!current) return;
      const destinationId = finderCommandDestinationId(current);
      void performVfsMutation(
        {
          type: 'create-document',
          parentId: destinationId,
          name: 'Clipboard',
          content,
        },
        destinationId,
        'Copied',
        'The Clipboard text could not be pasted.',
      );
    },
    [performVfsMutation],
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
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files);
      const current = stateRef.current;
      if (!current) return;
      const destinationId = finderCommandDestinationId(current);
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
  }, [importHostFiles, pasteText, systemInputBlocked]);

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

  const closeCalculator = useCallback((): void => setCalculatorOpen(false), []);

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
            action: () => setCalculatorOpen(true),
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
    activeWindow,
    closeWindow,
    copyFinderSelection,
    copyableFinderSelectionIds.length,
    createFolder,
    emptyTrashAndClearSelection,
    openSelected,
    pasteFromClipboard,
    selectAll,
    selectedNode,
    setDesktopSelection,
    setFinderSelection,
    state,
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
              active={!calculatorOpen && activeWindowId === windowState.id}
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
        {calculatorOpen ? (
          <CalculatorWindow
            interactionCancelToken={interactionCancelToken}
            keyboardEnabled={keyboardOwner === 'calculator'}
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
