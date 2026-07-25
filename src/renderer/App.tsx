import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createDefaultState,
  type FinderWindowState,
  type MacintoshState,
  type Point,
  type VfsNode,
  type WindowGeometry,
} from '../shared/state';
import type { ImportedEntry } from '../shared/contracts';
import { playEjectSound } from './audio/sounds';
import { CalculatorWindow } from './components/CalculatorWindow';
import { AboutDialog, EjectTipDialog, InfoDialog } from './components/Dialogs';
import { DesktopIcon } from './components/DesktopIcon';
import { DesktopSurface, VFS_DRAG_TYPE } from './components/DesktopSurface';
import { FinderWindow } from './components/FinderWindow';
import { MenuBar, type MenuDefinition } from './components/MenuBar';
import { StartupScreen } from './components/StartupScreen';
import {
  addFolder,
  duplicateNodes,
  emptyTrash,
  listChildren,
  mergeImportedEntries,
  moveNodes,
  type VfsMutationResult,
} from './model/vfs';

type DesktopIconId = 'system-disk' | 'trash';
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

const canContainItems = (node: VfsNode | undefined): node is VfsNode =>
  node?.kind === 'disk' || node?.kind === 'folder' || node?.kind === 'trash';

const plural = (count: number, singular: string, pluralValue = `${singular}s`): string =>
  count === 1 ? singular : pluralValue;

export default function App() {
  const automation = useMemo(
    () => new URLSearchParams(window.location.search).has('automation'),
    [],
  );
  const [state, setState] = useState<MacintoshState | null>(null);
  const [startupComplete, setStartupComplete] = useState(false);
  const [desktopSelection, setDesktopSelection] = useState<Set<DesktopIconId>>(new Set());
  const [finderSelection, setFinderSelection] = useState<Set<string>>(new Set());
  const [previewPositions, setPreviewPositions] = useState<Partial<Record<DesktopIconId, Point>>>(
    {},
  );
  const [draggingIcon, setDraggingIcon] = useState<DesktopIconId | null>(null);
  const [snappingIcon, setSnappingIcon] = useState<DesktopIconId | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [ejecting, setEjecting] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<TransferNotice>(null);
  const dragOrigins = useRef<Partial<Record<DesktopIconId, Point>>>({});
  const zoomRestore = useRef<Map<string, WindowGeometry>>(new Map());
  const stateRef = useRef<MacintoshState | null>(null);
  const clipboardNodeIds = useRef<string[]>([]);
  const transferNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);
  const clock = useClock();

  useEffect(() => {
    stateRef.current = state;
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

  const pasteDestinationId = useCallback((current: MacintoshState): string => {
    const active = current.desktop.windows.at(-1);
    const activeContainer = active
      ? current.nodes.find((node) => node.id === active.nodeId)
      : undefined;
    return canContainItems(activeContainer) ? activeContainer.id : 'system-disk';
  }, []);

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
      setFinderSelection(new Set(result.affectedIds));
      setDesktopSelection(new Set());
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
        setPersistenceError('The saved desktop could not be read. A fresh desktop was opened.');
        document.body.dataset.stateLoaded = 'false';
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state || !hydrated.current || ejecting) return;
    const timer = setTimeout(() => {
      void window.macintosh.saveState(state).catch((error: unknown) => {
        console.error(error);
        setPersistenceError('The desktop could not be saved.');
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [state, ejecting]);

  const ready = Boolean(state && startupComplete);
  useEffect(() => {
    document.body.dataset.macReady = ready ? 'true' : 'false';
  }, [ready]);

  const activeWindow = state?.desktop.windows.at(-1) ?? null;
  const activeNode = activeWindow
    ? (state?.nodes.find((node) => node.id === activeWindow.nodeId) ?? null)
    : null;

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
      if (!node) return current;
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

  const selectDesktopIcon = (id: DesktopIconId, additive: boolean): void => {
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

  const startFinderItemDrag = (id: string, dataTransfer: DataTransfer): void => {
    if (!state) return;
    const nodeIds = finderSelection.has(id) ? [...finderSelection] : [id];
    if (!finderSelection.has(id)) {
      setFinderSelection(new Set([id]));
      setDesktopSelection(new Set());
    }
    const names = nodeIds.flatMap((nodeId) => {
      const node = state.nodes.find((item) => item.id === nodeId);
      return node ? [node.name] : [];
    });
    dataTransfer.effectAllowed = 'copyMove';
    dataTransfer.setData(VFS_DRAG_TYPE, JSON.stringify(nodeIds));
    dataTransfer.setData('text/plain', names.join('\n'));
  };

  const importHostFiles = useCallback(
    async (files: File[], destinationId: string): Promise<void> => {
      if (files.length === 0) return;
      try {
        const inspected = await window.macintosh.importFiles(files);
        const current = stateRef.current;
        if (!current) return;
        if (inspected.entries.length === 0) {
          showTransferNotice('No readable files or folders were found.', true);
          return;
        }
        const result = mergeImportedEntries(current, inspected.entries, destinationId);
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
    [commitVfsMutation, showTransferNotice],
  );

  const dropItems = useCallback(
    (destinationId: string, nodeIds: string[], files: File[]): void => {
      if (nodeIds.length > 0) {
        const current = stateRef.current;
        if (!current) return;
        const result = moveNodes(current, nodeIds, destinationId);
        commitVfsMutation(current, result, destinationId, 'Moved');
        return;
      }
      void importHostFiles(files, destinationId);
    },
    [commitVfsMutation, importHostFiles],
  );

  const startIconDrag = (id: DesktopIconId, origin: Point): void => {
    dragOrigins.current[id] = origin;
    setDraggingIcon(id);
    setSnappingIcon(null);
    selectDesktopIcon(id, false);
  };

  const previewIconDrag = (id: DesktopIconId, position: Point, pointer: Point): void => {
    const surface = document.querySelector<HTMLElement>('.desktop-surface');
    const maxX = Math.max(0, (surface?.clientWidth ?? window.innerWidth) - 90);
    const maxY = Math.max(0, (surface?.clientHeight ?? window.innerHeight - 24) - 92);
    const next = { x: clamp(position.x, 0, maxX), y: clamp(position.y, 0, maxY) };
    setPreviewPositions((current) => ({ ...current, [id]: next }));

    if (id !== 'system-disk') return;
    const trash = document.querySelector<HTMLElement>('[data-desktop-icon="trash"]');
    if (!trash) return;
    const bounds = trash.getBoundingClientRect();
    setTrashHover(
      pointer.x >= bounds.left - 8 &&
        pointer.x <= bounds.right + 8 &&
        pointer.y >= bounds.top - 8 &&
        pointer.y <= bounds.bottom + 8,
    );
  };

  const restoreIcon = (id: DesktopIconId): void => {
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
      setSnappingIcon(null);
    }, 190);
  };

  const ejectSystemDisk = async (): Promise<void> => {
    if (!state || ejecting) return;
    const diskOrigin = dragOrigins.current['system-disk'] ?? state.desktop.diskPosition;
    setEjecting(true);
    setDraggingIcon(null);
    setTrashHover(true);
    playEjectSound();
    await pause(automation ? 280 : 920);

    const nextState: MacintoshState = {
      ...state,
      desktop: {
        ...state.desktop,
        diskPosition: diskOrigin,
        lastEjectAt: new Date().toISOString(),
      },
    };

    try {
      await window.macintosh.saveState(nextState);
      setState(nextState);
      await window.macintosh.quitAfterEject();
    } catch (error) {
      console.error(error);
      setPersistenceError(
        'The disk could not be safely ejected because the desktop was not saved.',
      );
      setEjecting(false);
      restoreIcon('system-disk');
    }
  };

  const finishIconDrag = (id: DesktopIconId): void => {
    if (!state) return;
    if (id === 'system-disk') {
      if (trashHover) void ejectSystemDisk();
      else restoreIcon(id);
      return;
    }
    const position = previewPositions[id] ?? state.desktop.trashPosition;
    setState({
      ...state,
      desktop: { ...state.desktop, trashPosition: position },
    });
    setPreviewPositions((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDraggingIcon(null);
  };

  const createFolder = useCallback((): void => {
    if (!state) return;
    const parentId =
      activeNode && (activeNode.kind === 'disk' || activeNode.kind === 'folder')
        ? activeNode.id
        : 'system-disk';
    const next = addFolder(state, parentId);
    const added = next.nodes.at(-1);
    setState(next);
    if (added) setFinderSelection(new Set([added.id]));
  }, [activeNode, state]);

  const selectedNode = useMemo(() => {
    if (!state) return null;
    const finderId = finderSelection.values().next().value as string | undefined;
    if (finderId) return state.nodes.find((node) => node.id === finderId) ?? null;
    const desktopId = desktopSelection.values().next().value as DesktopIconId | undefined;
    return desktopId ? (state.nodes.find((node) => node.id === desktopId) ?? null) : null;
  }, [desktopSelection, finderSelection, state]);

  const copyFinderSelection = useCallback((): boolean => {
    const current = stateRef.current;
    if (!current) return false;
    const nodeIds = [...finderSelection].filter((id) => {
      const node = current.nodes.find((item) => item.id === id);
      return Boolean(node && node.id !== 'system-disk' && node.id !== 'trash');
    });
    if (nodeIds.length === 0) return false;
    clipboardNodeIds.current = nodeIds;
    showTransferNotice(
      `Copied ${nodeIds.length} ${plural(nodeIds.length, 'item')} to the Clipboard.`,
    );
    return true;
  }, [finderSelection, showTransferNotice]);

  const pasteCopiedItems = useCallback((): boolean => {
    const current = stateRef.current;
    if (!current || clipboardNodeIds.current.length === 0) return false;
    const destinationId = pasteDestinationId(current);
    const result = duplicateNodes(current, clipboardNodeIds.current, destinationId);
    commitVfsMutation(current, result, destinationId, 'Copied');
    return true;
  }, [commitVfsMutation, pasteDestinationId]);

  const pasteText = useCallback(
    (content: string): void => {
      const current = stateRef.current;
      if (!current) return;
      const destinationId = pasteDestinationId(current);
      const timestamp = new Date().toISOString();
      const entry: ImportedEntry = {
        name: 'Clipboard',
        kind: 'document',
        content,
        createdAt: timestamp,
        modifiedAt: timestamp,
      };
      const result = mergeImportedEntries(current, [entry], destinationId);
      commitVfsMutation(current, result, destinationId, 'Copied');
    },
    [commitVfsMutation, pasteDestinationId],
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
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files);
      const current = stateRef.current;
      if (!current) return;
      const destinationId = pasteDestinationId(current);
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
  }, [importHostFiles, pasteDestinationId, pasteText]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return;
      if (event.key.toLocaleLowerCase() === 'c') {
        if (copyFinderSelection()) event.preventDefault();
        else clipboardNodeIds.current = [];
        return;
      }
      if (event.key.toLocaleLowerCase() === 'v') {
        event.preventDefault();
        pasteFromClipboard();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [copyFinderSelection, pasteFromClipboard]);

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
      setDesktopSelection(new Set(['system-disk', 'trash']));
      setFinderSelection(new Set());
    }
  }, [activeNode, state]);

  const closeCalculator = useCallback((): void => setCalculatorOpen(false), []);

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
          { id: 'new-folder', label: 'New Folder', shortcut: '⌘N', action: createFolder },
          {
            id: 'open',
            label: 'Open',
            shortcut: '⌘O',
            disabled: !selectedNode,
            action: openSelected,
          },
          {
            id: 'close',
            label: 'Close Window',
            shortcut: '⌘W',
            disabled: !activeWindow,
            action: () => activeWindow && closeWindow(activeWindow.id),
          },
          { id: 'file-separator', separator: true },
          {
            id: 'get-info',
            label: 'Get Info',
            shortcut: '⌘I',
            disabled: !selectedNode,
            action: () => selectedNode && setDialog({ type: 'info', node: selectedNode }),
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        entries: [
          { id: 'undo', label: 'Undo', shortcut: '⌘Z', disabled: true },
          { id: 'edit-separator', separator: true },
          { id: 'cut', label: 'Cut', shortcut: '⌘X', disabled: true },
          {
            id: 'copy',
            label: 'Copy',
            shortcut: '⌘C',
            disabled: finderSelection.size === 0,
            action: () => copyFinderSelection(),
          },
          { id: 'paste', label: 'Paste', shortcut: '⌘V', action: pasteFromClipboard },
          { id: 'edit-separator-2', separator: true },
          { id: 'select-all', label: 'Select All', shortcut: '⌘A', action: selectAll },
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
            action: () => setFinderSelection(new Set()),
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
            action: () => setState(emptyTrash(state)),
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
    createFolder,
    finderSelection.size,
    openSelected,
    pasteFromClipboard,
    selectAll,
    selectedNode,
    state,
  ]);

  if (!startupComplete || !state) {
    return <StartupScreen automation={automation} onComplete={() => setStartupComplete(true)} />;
  }

  const diskPosition = previewPositions['system-disk'] ?? state.desktop.diskPosition;
  const trashPosition = previewPositions.trash ?? state.desktop.trashPosition;
  const activeWindowId = state.desktop.windows.at(-1)?.id ?? null;

  return (
    <main className="macintosh" aria-label="The Macintosh desktop">
      <MenuBar clock={clock} menus={menus} />
      <DesktopSurface
        onBackgroundClick={() => {
          setDesktopSelection(new Set());
          setFinderSelection(new Set());
        }}
        onMarquee={(ids) => {
          setDesktopSelection(new Set(ids));
          setFinderSelection(new Set());
        }}
        onDropItems={dropItems}
        vfsCount={state.nodes.length}
      >
        {state.desktop.windows.map((windowState, index) => {
          const node = state.nodes.find((item) => item.id === windowState.nodeId);
          if (!node) return null;
          const items = listChildren(state.nodes, node.id, state.desktop.viewMode);
          return (
            <FinderWindow
              active={!calculatorOpen && activeWindowId === windowState.id}
              items={items}
              key={windowState.id}
              node={node}
              onActivate={activateWindow}
              onClose={closeWindow}
              onGeometry={setWindowGeometry}
              onItemDragStart={startFinderItemDrag}
              onItemOpen={openNode}
              onItemSelect={selectFinderItem}
              onZoom={zoomWindow}
              selectedIds={finderSelection}
              stackIndex={index}
              viewMode={state.desktop.viewMode}
              windowState={windowState}
            />
          );
        })}
        {calculatorOpen ? <CalculatorWindow onClose={closeCalculator} /> : null}
        <DesktopIcon
          dragging={draggingIcon === 'system-disk'}
          ejecting={ejecting}
          icon="disk"
          id="system-disk"
          label="System Disk"
          onDrag={previewIconDrag}
          onDragEnd={finishIconDrag}
          onDragStart={startIconDrag}
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
          label="Trash"
          onDrag={previewIconDrag}
          onDragEnd={finishIconDrag}
          onDragStart={startIconDrag}
          onOpen={openNode}
          onSelect={selectDesktopIcon}
          position={trashPosition}
          selected={desktopSelection.has('trash')}
          snapping={snappingIcon === 'trash'}
          validDropTarget={trashHover}
        />
        {dialog?.type === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
        {dialog?.type === 'info' && (
          <InfoDialog node={dialog.node} onClose={() => setDialog(null)} />
        )}
        {dialog?.type === 'eject-tip' && <EjectTipDialog onClose={() => setDialog(null)} />}
        {persistenceError && (
          <div className="save-error" role="alert">
            <span>{persistenceError}</span>
            <button onClick={() => setPersistenceError(null)} type="button">
              OK
            </button>
          </div>
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
