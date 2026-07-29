import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createDefaultState,
  sanitizeState,
  type FinderWindowState,
  type MacintoshState,
  type Point,
  type VfsNode,
  type WindowGeometry,
} from '../shared/state';
import type { ImportedEntry } from '../shared/contracts';
import { playEjectSound, playMenuTick } from './audio/sounds';
import { CalculatorWindow } from './components/CalculatorWindow';
import { AboutDialog, EjectTipDialog, InfoDialog, PersistenceAlert } from './components/Dialogs';
import { DesktopIcon } from './components/DesktopIcon';
import { DesktopSurface, type IconDropLocation } from './components/DesktopSurface';
import { DesktopVfsIcon } from './components/DesktopVfsIcon';
import { FinderWindow } from './components/FinderWindow';
import { MenuBar, type MenuDefinition, type MenuEntry } from './components/MenuBar';
import { StartupScreen } from './components/StartupScreen';
import {
  deriveFinderCommandContext,
  finderCommandDestinationId,
  findMenuShortcutEntry,
} from './model/command-context';
import {
  defaultDesktopIconPosition,
  placeImportedDesktopRoots,
  resolveDesktopIconPosition,
  translateDesktopIconDrag,
} from './model/desktop-icon-layout';
import { isTrashDropPoint } from './model/desktop-drop-target';
import { translateFinderIconDrag } from './model/finder-icon-layout';
import { resolveKeyboardOwner } from './model/input-owner';
import {
  addFolder,
  duplicateNodes,
  emptyTrash,
  listChildren,
  mergeImportedEntries,
  moveNodes,
  placeFinderIcons,
  type VfsMutationResult,
} from './model/vfs';
import { writeVfsDragPayload, type VfsItemDragContext } from './model/vfs-drag';

type SpecialDesktopIconId = 'system-disk' | 'trash';
type DialogState =
  { type: 'about' } | { type: 'info'; node: VfsNode } | { type: 'eject-tip' } | null;
type TransferNotice = { message: string; error: boolean } | null;

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

export default function App() {
  const automation = useMemo(
    () => new URLSearchParams(window.location.search).has('automation'),
    [],
  );
  const [state, setState] = useState<MacintoshState | null>(null);
  const [startupComplete, setStartupComplete] = useState(false);
  const [desktopSelection, setDesktopSelection] = useState<Set<string>>(new Set());
  const [finderSelection, setFinderSelection] = useState<Set<string>>(new Set());
  const [previewPositions, setPreviewPositions] = useState<
    Partial<Record<SpecialDesktopIconId, Point>>
  >({});
  const [draggingIcon, setDraggingIcon] = useState<SpecialDesktopIconId | null>(null);
  const [snappingIcon, setSnappingIcon] = useState<SpecialDesktopIconId | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [ejecting, setEjecting] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pointerSessionActive, setPointerSessionActive] = useState(false);
  const [interactionCancelToken, setInteractionCancelToken] = useState(0);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<TransferNotice>(null);
  const dragOrigins = useRef<Partial<Record<SpecialDesktopIconId, Point>>>({});
  const vfsItemDrag = useRef<VfsItemDragContext | null>(null);
  const zoomRestore = useRef<Map<string, WindowGeometry>>(new Map());
  const stateRef = useRef<MacintoshState | null>(null);
  const clipboardNodeIds = useRef<string[]>([]);
  const transferNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);
  const clock = useClock();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    vfsItemDrag.current = null;
  }, [interactionCancelToken]);

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

  const persistState = useCallback(
    (nextState: MacintoshState) => window.macintosh.saveState(sanitizeState(nextState)),
    [],
  );

  const reportPersistenceError = useCallback((message: string): void => {
    setOpenMenu(null);
    setPointerSessionActive(false);
    setInteractionCancelToken((current) => current + 1);
    setPersistenceError(message);
  }, []);

  const positionDesktopMutation = useCallback(
    (
      current: MacintoshState,
      result: VfsMutationResult,
      location: IconDropLocation | null = null,
    ): VfsMutationResult => {
      if (result.affectedIds.length === 0) return result;
      const surface = document.querySelector<HTMLElement>('.desktop-surface');
      const surfaceSize = location?.surfaceSize ?? {
        width: surface?.clientWidth ?? window.innerWidth,
        height: surface?.clientHeight ?? window.innerHeight - 22,
      };
      const dropPoint =
        location?.point ??
        defaultDesktopIconPosition(listChildren(current.nodes, 'desktop', 'icons').length);
      return {
        ...result,
        state: placeFinderIcons(
          result.state,
          'desktop',
          placeImportedDesktopRoots(result.affectedIds, dropPoint, surfaceSize),
        ),
      };
    },
    [],
  );

  const commitVfsMutation = useCallback(
    (
      current: MacintoshState,
      result: VfsMutationResult,
      destinationId: string,
      verb: 'Copied' | 'Moved',
      extraSkipped = 0,
      extraTruncated = 0,
    ): void => {
      const addedCount = Math.max(0, result.state.nodes.length - current.nodes.length);
      const affectedCount = verb === 'Moved' ? result.affectedIds.length : addedCount;
      const skipped = result.skippedCount + extraSkipped;
      const truncated = result.truncatedCount + extraTruncated;
      if (result.state === current || affectedCount === 0) {
        showTransferNotice(
          skipped > 0
            ? `Nothing changed; ${skipped} ${plural(skipped, 'item')} could not be ${verb === 'Moved' ? 'moved' : 'copied'}.`
            : 'Nothing changed.',
          true,
        );
        return;
      }

      stateRef.current = result.state;
      setState(result.state);
      if (destinationId === 'desktop') {
        setDesktopSelection(new Set(result.affectedIds));
        setFinderSelection(new Set());
      } else {
        setFinderSelection(new Set(result.affectedIds));
        setDesktopSelection(new Set());
      }
      const destination =
        result.state.nodes.find((node) => node.id === destinationId)?.name ?? 'System Disk';
      const details = [
        skipped > 0 ? `${skipped} skipped` : '',
        truncated > 0 ? `${truncated} truncated` : '',
      ].filter(Boolean);
      showTransferNotice(
        `${verb} ${affectedCount} ${plural(affectedCount, 'item')} to ${destination}.${details.length > 0 ? ` ${details.join(', ')}.` : ''}`,
      );
    },
    [showTransferNotice],
  );

  useEffect(() => {
    let cancelled = false;
    window.macintosh
      .loadState()
      .then((loaded) => {
        if (cancelled) return;
        hydrated.current = true;
        setState(loaded);
        document.body.dataset.stateLoaded = 'true';
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        hydrated.current = true;
        setState(createDefaultState());
        reportPersistenceError('The saved desktop could not be read. A fresh desktop was opened.');
        document.body.dataset.stateLoaded = 'false';
      });
    return () => {
      cancelled = true;
    };
  }, [reportPersistenceError]);

  useEffect(() => {
    if (!state || !hydrated.current || ejecting) return;
    const timer = setTimeout(() => {
      void persistState(state).catch((error: unknown) => {
        console.error(error);
        reportPersistenceError('The desktop could not be saved.');
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [state, ejecting, persistState, reportPersistenceError]);

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
    dialogOpen: dialog !== null,
    ejectionInProgress: ejecting,
    pointerSessionActive,
    menuOpen: openMenu !== null,
    calculatorOpen,
    finderWindowOpen: activeWindow !== null,
  });
  const systemInputBlocked =
    keyboardOwner === 'persistence-alert' ||
    keyboardOwner === 'dialog' ||
    keyboardOwner === 'ejection' ||
    keyboardOwner === 'pointer-session';

  const activateWindow = useCallback((windowId: string): void => {
    setState((current) => {
      if (!current) return current;
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
  }, []);

  const openNode = useCallback((nodeId: string): void => {
    setState((current) => {
      if (!current) return current;
      const node = current.nodes.find((item) => item.id === nodeId);
      if (!node || node.kind === 'desktop') return current;
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
      return {
        ...current,
        desktop: { ...current.desktop, windows: [...remaining, nextWindow] },
      };
    });
    setFinderSelection(new Set());
    setDesktopSelection(new Set());
  }, []);

  const closeWindow = useCallback((windowId: string): void => {
    zoomRestore.current.delete(windowId);
    setState((current) =>
      current
        ? {
            ...current,
            desktop: {
              ...current.desktop,
              windows: current.desktop.windows.filter((item) => item.id !== windowId),
            },
          }
        : current,
    );
    setFinderSelection(new Set());
  }, []);

  const setWindowGeometry = useCallback((windowId: string, geometry: WindowGeometry): void => {
    const surface = document.querySelector<HTMLElement>('.desktop-surface');
    const maximumWidth = surface?.clientWidth ?? window.innerWidth;
    const maximumHeight = surface?.clientHeight ?? window.innerHeight - 24;
    setState((current) =>
      current
        ? {
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
          }
        : current,
    );
  }, []);

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

  const startVfsItemDrag = (
    id: string,
    dataTransfer: DataTransfer,
    context: VfsItemDragContext,
  ): void => {
    const current = stateRef.current;
    if (!current) return;
    vfsItemDrag.current = context;
    setPointerSessionActive(true);
    const nodeIds = context.nodeIds.length > 0 ? context.nodeIds : [id];
    if (context.source === 'desktop') {
      setDesktopSelection(new Set(nodeIds));
      setFinderSelection(new Set());
    } else {
      setFinderSelection(new Set(nodeIds));
      setDesktopSelection(new Set());
    }
    const names = nodeIds.flatMap((nodeId) => {
      const node = current.nodes.find((item) => item.id === nodeId);
      return node ? [node.name] : [];
    });
    writeVfsDragPayload(dataTransfer, nodeIds, names);
  };

  const startDesktopItemDrag = (
    id: string,
    dataTransfer: DataTransfer,
    pointerOffset: Point,
  ): void => {
    const current = stateRef.current;
    if (!current) return;
    const items = listChildren(current.nodes, 'desktop', 'icons');
    const selectedItems = desktopSelection.has(id)
      ? items.filter((item) => desktopSelection.has(item.id))
      : items.filter((item) => item.id === id);
    const draggedItems =
      selectedItems.length > 0 ? selectedItems : items.filter((item) => item.id === id);
    startVfsItemDrag(id, dataTransfer, {
      parentId: 'desktop',
      nodeIds: draggedItems.map((item) => item.id),
      layout: {
        anchorId: id,
        pointerOffset,
        positions: Object.fromEntries(
          items.flatMap((item, index) =>
            draggedItems.some((dragged) => dragged.id === item.id)
              ? [[item.id, resolveDesktopIconPosition(item, index)]]
              : [],
          ),
        ),
      },
      source: 'desktop',
    });
  };

  const importHostFiles = useCallback(
    async (
      files: File[],
      destinationId: string,
      iconLocation: IconDropLocation | null = null,
    ): Promise<void> => {
      if (files.length === 0) return;
      try {
        const inspected = await window.macintosh.importFiles(files);
        const current = stateRef.current;
        if (!current) return;
        if (inspected.entries.length === 0) {
          showTransferNotice('No readable files or folders were found.', true);
          return;
        }
        const merged = mergeImportedEntries(current, inspected.entries, destinationId);
        const result =
          destinationId === 'desktop'
            ? positionDesktopMutation(current, merged, iconLocation)
            : merged;
        commitVfsMutation(
          current,
          result,
          destinationId,
          'Copied',
          inspected.skippedCount,
          inspected.truncatedCount,
        );
      } catch (error) {
        console.error(error);
        showTransferNotice('The dropped items could not be copied.', true);
      }
    },
    [commitVfsMutation, positionDesktopMutation, showTransferNotice],
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
        const translatedPositions =
          iconLocation && iconLocation.parentId === destinationId && dragContext
            ? destinationId === 'desktop'
              ? translateDesktopIconDrag(
                  dragContext.layout,
                  iconLocation.point,
                  iconLocation.surfaceSize,
                )
              : translateFinderIconDrag(dragContext.layout, iconLocation.point)
            : null;
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
            stateRef.current = positioned;
            setState(positioned);
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

        const result = moveNodes(current, nodeIds, destinationId);
        const positionedState = translatedPositions
          ? placeFinderIcons(result.state, destinationId, placementsFor(result.affectedIds))
          : result.state;
        commitVfsMutation(current, { ...result, state: positionedState }, destinationId, 'Moved');
        return;
      }
      void importHostFiles(files, destinationId, iconLocation);
    },
    [commitVfsMutation, importHostFiles],
  );

  const finishVfsItemDrag = (): void => {
    vfsItemDrag.current = null;
    setPointerSessionActive(false);
  };

  const startIconDrag = (id: SpecialDesktopIconId, origin: Point): void => {
    dragOrigins.current[id] = origin;
    setDraggingIcon(id);
    setSnappingIcon(null);
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
  };

  const restoreIcon = (id: SpecialDesktopIconId): void => {
    const origin = dragOrigins.current[id];
    if (origin) setPreviewPositions((current) => ({ ...current, [id]: origin }));
    setDraggingIcon(null);
    setSnappingIcon(id);
    setTrashHover(false);
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
    setTrashHover(true);
    playEjectSound();
    await pause(automation ? 280 : 920);

    const current = stateRef.current ?? state;
    const nextState = sanitizeState({
      ...current,
      desktop: {
        ...current.desktop,
        diskPosition: diskOrigin,
        lastEjectAt: new Date().toISOString(),
      },
    });

    try {
      await persistState(nextState);
      setState(nextState);
    } catch (error) {
      console.error(error);
      reportPersistenceError(
        'The disk could not be safely ejected because the desktop was not saved.',
      );
      setEjecting(false);
      restoreIcon('system-disk');
      return;
    }

    try {
      await window.macintosh.quitAfterEject();
    } catch (error) {
      console.error(error);
      reportPersistenceError('The disk was saved, but The Macintosh could not shut down.');
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
    setState((current) =>
      current
        ? {
            ...current,
            desktop: {
              ...current.desktop,
              ...(id === 'system-disk' ? { diskPosition: position } : { trashPosition: position }),
            },
          }
        : current,
    );
    setPreviewPositions((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete dragOrigins.current[id];
    setDraggingIcon(null);
    setTrashHover(false);
  };

  const createFolder = useCallback((): void => {
    if (!state) return;
    const parentId = finderCommandDestinationId(state);
    const addedState = addFolder(state, parentId);
    const added = addedState.nodes.at(-1);
    const next =
      parentId === 'desktop' && added
        ? positionDesktopMutation(state, {
            state: addedState,
            affectedIds: [added.id],
            skippedCount: 0,
            truncatedCount: 0,
          }).state
        : addedState;
    stateRef.current = next;
    setState(next);
    if (added && parentId === 'desktop') {
      setDesktopSelection(new Set([added.id]));
      setFinderSelection(new Set());
    } else {
      setDesktopSelection(new Set());
      if (added) setFinderSelection(new Set([added.id]));
    }
  }, [positionDesktopMutation, state]);

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
    const duplicated = duplicateNodes(current, clipboardNodeIds.current, destinationId);
    const result =
      destinationId === 'desktop' ? positionDesktopMutation(current, duplicated) : duplicated;
    commitVfsMutation(current, result, destinationId, 'Copied');
    return true;
  }, [commitVfsMutation, positionDesktopMutation]);

  const pasteText = useCallback(
    (content: string): void => {
      const current = stateRef.current;
      if (!current) return;
      const destinationId = finderCommandDestinationId(current);
      const timestamp = new Date().toISOString();
      const entry: ImportedEntry = {
        name: 'Clipboard',
        kind: 'document',
        content,
        createdAt: timestamp,
        modifiedAt: timestamp,
      };
      const merged = mergeImportedEntries(current, [entry], destinationId);
      const result =
        destinationId === 'desktop' ? positionDesktopMutation(current, merged) : merged;
      commitVfsMutation(current, result, destinationId, 'Copied');
    },
    [commitVfsMutation, positionDesktopMutation],
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
    };
    window.addEventListener('blur', clearInternalClipboard);
    return () => window.removeEventListener('blur', clearInternalClipboard);
  }, []);

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
  }, [activeNode, desktopItems, state]);

  const closeCalculator = useCallback((): void => setCalculatorOpen(false), []);

  const emptyTrashAndClearSelection = useCallback((): void => {
    setState((current) => (current ? emptyTrash(current) : current));
    setFinderSelection(new Set());
  }, []);

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
            action: () => setState({ ...state, desktop: { ...state.desktop, viewMode: 'icons' } }),
          },
          {
            id: 'view-list',
            label: 'by Name',
            checked: state.desktop.viewMode === 'list',
            action: () => setState({ ...state, desktop: { ...state.desktop, viewMode: 'list' } }),
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
              setState({
                ...state,
                desktop: {
                  ...state.desktop,
                  diskPosition: defaults.diskPosition,
                  trashPosition: defaults.trashPosition,
                },
              });
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
    state,
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

  const diskPosition = previewPositions['system-disk'] ?? state.desktop.diskPosition;
  const trashPosition = previewPositions.trash ?? state.desktop.trashPosition;
  const activeWindowId = state.desktop.windows.at(-1)?.id ?? null;

  return (
    <main className="macintosh" aria-label="The Macintosh desktop">
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
        onInteractionChange={setPointerSessionActive}
        vfsCount={state.nodes.length}
      >
        {state.desktop.windows.map((windowState, index) => {
          const node = state.nodes.find((item) => item.id === windowState.nodeId);
          if (!node || node.kind === 'desktop') return null;
          const items = listChildren(state.nodes, node.id, state.desktop.viewMode);
          return (
            <FinderWindow
              active={!calculatorOpen && activeWindowId === windowState.id}
              interactionCancelToken={interactionCancelToken}
              items={items}
              key={windowState.id}
              node={node}
              onActivate={activateWindow}
              onClose={closeWindow}
              onGeometry={setWindowGeometry}
              onItemDragStart={startVfsItemDrag}
              onItemDragEnd={finishVfsItemDrag}
              onItemOpen={openNode}
              onItemSelect={selectFinderItem}
              onInteractionChange={setPointerSessionActive}
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
            onInteractionChange={setPointerSessionActive}
          />
        ) : null}
        {desktopItems.map((item, index) => (
          <DesktopVfsIcon
            interactionCancelToken={interactionCancelToken}
            key={item.id}
            node={item}
            onDragEnd={finishVfsItemDrag}
            onDragStart={startDesktopItemDrag}
            onOpen={openNode}
            onSelect={selectDesktopIcon}
            position={resolveDesktopIconPosition(item, index)}
            selected={desktopSelection.has(item.id)}
          />
        ))}
        <DesktopIcon
          dragging={draggingIcon === 'system-disk'}
          ejecting={ejecting}
          icon="disk"
          id="system-disk"
          interactionCancelToken={interactionCancelToken}
          label="System Disk"
          onDrag={previewIconDrag}
          onDragCancel={cancelIconDrag}
          onDragEnd={finishIconDrag}
          onDragStart={startIconDrag}
          onInteractionChange={setPointerSessionActive}
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
          onInteractionChange={setPointerSessionActive}
          onOpen={openNode}
          onSelect={selectDesktopIcon}
          position={trashPosition}
          selected={desktopSelection.has('trash')}
          snapping={snappingIcon === 'trash'}
          validDropTarget={trashHover}
        />
        {!persistenceError && dialog?.type === 'about' && (
          <AboutDialog onClose={() => setDialog(null)} />
        )}
        {!persistenceError && dialog?.type === 'info' && (
          <InfoDialog
            node={dialog.node}
            onClose={() => setDialog(null)}
            where={state.nodes.find((node) => node.id === dialog.node.parentId)?.name ?? 'Desktop'}
          />
        )}
        {!persistenceError && dialog?.type === 'eject-tip' && (
          <EjectTipDialog onClose={() => setDialog(null)} />
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
    </main>
  );
}
