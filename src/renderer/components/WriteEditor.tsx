import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { AllSelection, EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

import {
  WRITE_DEFAULT_TAB_INTERVAL,
  WRITE_PAGE_HEIGHT,
  WRITE_PAGE_MARGIN,
  WRITE_TEXT_WIDTH,
} from '../../shared/write';
import type {
  DocumentPayload,
  WriteAlignment,
  WriteFontFamily,
  WriteFontSize,
  WriteLineSpacing,
  WriteTextMarkType,
} from '../../shared/write';
import {
  advancePageLayoutConvergence,
  clearSelection,
  clearTextFormatting,
  createPageLayoutSignature,
  editorDocumentToPayload,
  insertManualPageBreak,
  insertTab,
  payloadToEditorDocument,
  projectBlockHeightsToPages,
  sanitizePastedWriteSlice,
  selectionStyle,
  setInlineStyleMark,
  setParagraphAttribute,
  sliceHasRichWriteSemantics,
  writeSchema,
  type PageLayoutConvergenceState,
  type PageProjection,
  type WriteSelectionStyle,
} from '../model/write-document';

export type WriteEditorCommand =
  | {
      type: 'undo' | 'redo' | 'select-all' | 'page-break' | 'tab' | 'plain-text' | 'clear';
    }
  | { type: 'mark'; mark: WriteTextMarkType }
  | { type: 'font-family'; value: WriteFontFamily }
  | { type: 'font-size'; value: WriteFontSize }
  | { type: 'alignment'; value: WriteAlignment }
  | { type: 'line-spacing'; value: WriteLineSpacing }
  | { type: 'left-indent' | 'first-line-indent' | 'right-indent'; value: number }
  | { type: 'tab-stops'; value: number[] };

export interface WriteEditorContext {
  style: WriteSelectionStyle;
  canUndo: boolean;
  canRedo: boolean;
  canFormat: boolean;
  canClear: boolean;
}

export interface WriteEditorHandle {
  execute: (command: WriteEditorCommand) => boolean;
  clipboard: (action: 'copy' | 'cut' | 'paste') => Promise<void>;
  focus: () => void;
  context: () => WriteEditorContext;
  flushLayout: () => Promise<void>;
  prepareSave: () => Promise<DocumentPayload>;
}

export type WriteEditorLayoutState = 'pending' | 'stable' | 'error';

export class WriteLayoutConvergenceError extends Error {
  readonly code = 'write-layout-did-not-converge';

  constructor() {
    super('Write could not settle the page layout. Edit the document and try saving again.');
    this.name = 'WriteLayoutConvergenceError';
  }
}

interface WriteEditorProps {
  editorRef: Ref<WriteEditorHandle>;
  payload: DocumentPayload;
  zoom: 50 | 75 | 100;
  active: boolean;
  onChange: (payload: DocumentPayload) => void;
  onContextChange: (context: WriteEditorContext) => void;
  onLayoutError?: (message: string | null) => void;
  onPaginationChange: (pageNumber: number, pageCount: number) => void;
}

export const editorContext = (state: EditorState): WriteEditorContext => {
  let canFormat = state.selection.$from.parent.type === writeSchema.nodes.paragraph;
  if (!state.selection.empty) {
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      if (node.type === writeSchema.nodes.paragraph) canFormat = true;
      return !canFormat;
    });
  }
  return {
    style: selectionStyle(state),
    canUndo: undo(state),
    canRedo: redo(state),
    canFormat,
    canClear: !state.selection.empty,
  };
};

const automaticPageBreakKey = new PluginKey<readonly number[]>('write-automatic-page-breaks');

const automaticPageBreakPlugin = new Plugin<readonly number[]>({
  key: automaticPageBreakKey,
  state: {
    init: () => [],
    apply: (transaction, positions) => {
      const next = transaction.getMeta(automaticPageBreakKey) as
        { positions: readonly number[] } | undefined;
      return next ? next.positions : transaction.docChanged ? [] : positions;
    },
  },
  props: {
    decorations: (state) => {
      const positions = automaticPageBreakKey.getState(state) ?? [];
      return DecorationSet.create(
        state.doc,
        positions.map((position) =>
          Decoration.widget(
            position,
            () => {
              const gap = document.createElement('span');
              gap.className = 'write-automatic-page-gap';
              gap.contentEditable = 'false';
              gap.setAttribute('aria-hidden', 'true');
              return gap;
            },
            { key: `write-page-gap-${position}`, side: -1 },
          ),
        ),
      );
    },
  },
});

interface LayoutWaiter {
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface MeasuredPageLayout {
  blocks: HTMLElement[];
  projection: PageProjection;
  automaticBreakPositions: number[];
  signature: string;
}

const structuralBlocks = (root: HTMLElement): HTMLElement[] =>
  [...root.children].filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      element.matches('[data-write-paragraph], [data-write-page-break]'),
  );

export function WriteEditor({
  editorRef,
  payload,
  zoom,
  active,
  onChange,
  onContextChange,
  onLayoutError,
  onPaginationChange,
}: WriteEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rich = useRef(payload.format === 'write-v1');
  const pendingRichPaste = useRef(false);
  const changeHandler = useRef(onChange);
  const contextHandler = useRef(onContextChange);
  const layoutErrorHandler = useRef(onLayoutError);
  const paginationHandler = useRef(onPaginationChange);
  const zoomRef = useRef(zoom);
  const editableRef = useRef(active);
  const layoutFrame = useRef<number | null>(null);
  const caretFrame = useRef<number | null>(null);
  const layoutGeneration = useRef(0);
  const settledLayoutGeneration = useRef(0);
  const failedLayout = useRef<{ generation: number; error: WriteLayoutConvergenceError } | null>(
    null,
  );
  const layoutWaiters = useRef<LayoutWaiter[]>([]);
  const lastStableProjection = useRef<PageProjection | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const pageCountRef = useRef(1);
  const pageNumberRef = useRef(1);
  const [layoutState, setLayoutState] = useState<WriteEditorLayoutState>('pending');
  const [layoutPass, setLayoutPass] = useState(0);
  const [renderedLayoutGeneration, setRenderedLayoutGeneration] = useState(0);

  useLayoutEffect(() => {
    changeHandler.current = onChange;
    contextHandler.current = onContextChange;
    layoutErrorHandler.current = onLayoutError;
    paginationHandler.current = onPaginationChange;
  }, [onChange, onContextChange, onLayoutError, onPaginationChange]);

  const publishContext = (): void => {
    if (view.current) contextHandler.current(editorContext(view.current.state));
  };

  const layoutTabs = useCallback((root: HTMLElement): void => {
    const rootBounds = root.getBoundingClientRect();
    const scale = zoomRef.current / 100;
    for (const paragraph of root.querySelectorAll<HTMLElement>('[data-write-paragraph]')) {
      const stops = (paragraph.dataset.tabStops ?? '')
        .split(',')
        .map(Number)
        .filter((point) => Number.isFinite(point) && point > 0 && point < WRITE_TEXT_WIDTH)
        .sort((left, right) => left - right);
      for (const tab of paragraph.querySelectorAll<HTMLElement>('[data-write-tab]')) {
        tab.style.width = '1px';
        const current = (tab.getBoundingClientRect().left - rootBounds.left) / scale;
        const nextStop =
          stops.find((point) => point > current + 0.5) ??
          Math.min(
            WRITE_TEXT_WIDTH,
            Math.ceil((current + 1) / WRITE_DEFAULT_TAB_INTERVAL) * WRITE_DEFAULT_TAB_INTERVAL,
          );
        tab.style.width = `${Math.max(4, Math.round(nextStop - current))}px`;
      }
    }
  }, []);

  const publishPagination = useCallback((projection: PageProjection): void => {
    const editor = view.current;
    const root = mount.current?.querySelector<HTMLElement>('.ProseMirror');
    if (!editor || !root) return;
    const pageCountChanged = projection.pageCount !== pageCountRef.current;
    if (pageCountChanged) {
      pageCountRef.current = projection.pageCount;
      setPageCount(projection.pageCount);
    }
    const rootBounds = root.getBoundingClientRect();
    const selectionTop = editor.coordsAtPos(editor.state.selection.head).top;
    const scale = zoomRef.current / 100;
    const logicalTop = (selectionTop - rootBounds.top) / scale;
    const pageNumber = Math.max(
      1,
      Math.min(
        projection.pageCount,
        Math.floor((logicalTop + WRITE_PAGE_MARGIN) / (WRITE_PAGE_HEIGHT + 24)) + 1,
      ),
    );
    if (pageCountChanged || pageNumber !== pageNumberRef.current) {
      pageNumberRef.current = pageNumber;
      paginationHandler.current(pageNumber, projection.pageCount);
    }
  }, []);

  const measurePageLayout = useCallback((): MeasuredPageLayout | null => {
    const editor = view.current;
    const root = mount.current?.querySelector<HTMLElement>('.ProseMirror');
    if (!editor || !root) return null;
    layoutTabs(root);
    const blocks = structuralBlocks(root);
    if (blocks.length !== editor.state.doc.childCount) return null;
    const heights = blocks.map((block) =>
      block.matches('[data-write-page-break]') ? 0 : block.offsetHeight + 8,
    );
    const manualBreaks = new Set(
      blocks.flatMap((block, index) => (block.matches('[data-write-page-break]') ? [index] : [])),
    );
    const projection = projectBlockHeightsToPages(heights, manualBreaks);
    const scale = zoomRef.current / 100;
    const automaticBreakPositions: number[] = [];
    let documentPosition = 0;
    blocks.forEach((block, index) => {
      const node = editor.state.doc.child(index);
      const contentStart = documentPosition + 1;
      const contentEnd = documentPosition + node.nodeSize - 1;
      const blockBounds = block.getBoundingClientRect();
      for (const offset of projection.internalBreakOffsets[index] ?? []) {
        if (offset >= block.offsetHeight - 1 || contentStart >= contentEnd) continue;
        const targetTop = blockBounds.top + offset * scale;
        let low = contentStart;
        let high = contentEnd;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (editor.coordsAtPos(middle).top >= targetTop) high = middle;
          else low = middle + 1;
        }
        if (low > contentStart && low < contentEnd) automaticBreakPositions.push(low);
      }
      documentPosition += node.nodeSize;
    });
    const positions = [...new Set(automaticBreakPositions)];
    return {
      blocks,
      projection,
      automaticBreakPositions: positions,
      signature: createPageLayoutSignature(heights, manualBreaks, projection, positions),
    };
  }, [layoutTabs]);

  const applyPageLayout = useCallback((layout: MeasuredPageLayout): void => {
    const editor = view.current;
    if (!editor) return;
    layout.blocks.forEach((block, index) => {
      const margin = layout.projection.marginBefore[index] ?? 0;
      block.style.marginTop = margin > 0 ? `${margin}px` : '';
      if (block.matches('[data-write-page-break]')) {
        block.style.height = `${layout.projection.manualBreakHeights[index] ?? 0}px`;
      }
    });
    const currentPositions = automaticPageBreakKey.getState(editor.state) ?? [];
    if (
      currentPositions.length !== layout.automaticBreakPositions.length ||
      currentPositions.some((position, index) => position !== layout.automaticBreakPositions[index])
    ) {
      editor.dispatch(
        editor.state.tr.setMeta(automaticPageBreakKey, {
          positions: layout.automaticBreakPositions,
        }),
      );
    }
  }, []);

  const resetPageLayout = useCallback((): boolean => {
    const editor = view.current;
    if (!editor) return false;
    if ((automaticPageBreakKey.getState(editor.state)?.length ?? 0) > 0) {
      editor.dispatch(
        editor.state.tr.setMeta(automaticPageBreakKey, { positions: [] as readonly number[] }),
      );
    }
    const root = mount.current?.querySelector<HTMLElement>('.ProseMirror');
    if (!root) return false;
    for (const block of structuralBlocks(root)) {
      block.style.marginTop = '';
      if (block.matches('[data-write-page-break]')) block.style.height = '0px';
    }
    return true;
  }, []);

  const settleWaiters = useCallback((generation: number, error?: Error): void => {
    const pending: LayoutWaiter[] = [];
    for (const waiter of layoutWaiters.current) {
      if (waiter.generation > generation) {
        pending.push(waiter);
      } else if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
    layoutWaiters.current = pending;
  }, []);

  const scheduleLayout = useCallback((): void => {
    const generation = layoutGeneration.current + 1;
    layoutGeneration.current = generation;
    failedLayout.current = null;
    setRenderedLayoutGeneration(generation);
    setLayoutState('pending');
    setLayoutPass(0);
    if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
    let attempts = 0;

    const scheduleFrame = (callback: () => void): void => {
      layoutFrame.current = requestAnimationFrame(() => {
        layoutFrame.current = null;
        callback();
      });
    };
    const reportFailure = (pass: number, projection?: PageProjection): void => {
      if (generation !== layoutGeneration.current) return;
      if (projection) publishPagination(projection);
      const error = new WriteLayoutConvergenceError();
      failedLayout.current = { generation, error };
      setLayoutPass(pass);
      setLayoutState('error');
      layoutErrorHandler.current?.(error.message);
      settleWaiters(generation, error);
    };
    const runPass = (convergence: PageLayoutConvergenceState): void => {
      if (generation !== layoutGeneration.current) return;
      attempts += 1;
      setLayoutPass(attempts);
      if (!resetPageLayout()) {
        if (attempts >= 4) reportFailure(attempts);
        else scheduleFrame(() => runPass(convergence));
        return;
      }
      scheduleFrame(() => {
        if (generation !== layoutGeneration.current) return;
        const measured = measurePageLayout();
        if (!measured) {
          if (attempts >= 4) reportFailure(attempts);
          else scheduleFrame(() => runPass(convergence));
          return;
        }
        applyPageLayout(measured);
        const result = advancePageLayoutConvergence(convergence, measured.signature, 4);
        if (result.status === 'repeat') {
          if (attempts >= 4) {
            scheduleFrame(() => reportFailure(attempts, measured.projection));
          } else scheduleFrame(() => runPass(result.state));
          return;
        }
        scheduleFrame(() => {
          if (generation !== layoutGeneration.current) return;
          publishPagination(measured.projection);
          if (result.status === 'stable') {
            lastStableProjection.current = measured.projection;
            settledLayoutGeneration.current = generation;
            failedLayout.current = null;
            setLayoutState('stable');
            layoutErrorHandler.current?.(null);
            settleWaiters(generation);
            return;
          }
          reportFailure(attempts);
        });
      });
    };
    scheduleFrame(() => runPass({ pass: 0, previousSignature: null }));
  }, [applyPageLayout, measurePageLayout, publishPagination, resetPageLayout, settleWaiters]);

  const scheduleCaretPage = useCallback((): void => {
    if (caretFrame.current !== null) cancelAnimationFrame(caretFrame.current);
    caretFrame.current = requestAnimationFrame(() => {
      caretFrame.current = null;
      if (settledLayoutGeneration.current !== layoutGeneration.current) return;
      const projection = lastStableProjection.current;
      if (projection) publishPagination(projection);
    });
  }, [publishPagination]);

  const execute = (command: WriteEditorCommand): boolean => {
    const editor = view.current;
    if (!editor) return false;
    const dispatch = (transaction: Parameters<EditorView['dispatch']>[0]): void =>
      editor.dispatch(transaction);
    const dispatchRich = (transaction: Parameters<EditorView['dispatch']>[0]): void => {
      if (transaction.docChanged || transaction.storedMarksSet) rich.current = true;
      editor.dispatch(transaction);
    };
    let handled = false;
    switch (command.type) {
      case 'undo':
        handled = undo(editor.state, dispatch);
        break;
      case 'redo':
        handled = redo(editor.state, dispatch);
        break;
      case 'select-all':
        editor.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
        handled = true;
        break;
      case 'clear':
        handled = clearSelection(editor.state, dispatch);
        break;
      case 'plain-text':
        handled = clearTextFormatting(editor.state, dispatchRich);
        break;
      case 'page-break':
        handled = insertManualPageBreak(editor.state, dispatchRich);
        break;
      case 'tab':
        handled = insertTab(editor.state, dispatch);
        break;
      case 'mark':
        handled = toggleMark(writeSchema.marks[command.mark])(editor.state, dispatchRich);
        break;
      case 'font-family':
        handled = setInlineStyleMark(editor.state, dispatchRich, 'fontFamily', command.value);
        break;
      case 'font-size':
        handled = setInlineStyleMark(editor.state, dispatchRich, 'fontSize', command.value);
        break;
      case 'alignment':
        handled = setParagraphAttribute(editor.state, dispatchRich, 'alignment', command.value);
        break;
      case 'line-spacing':
        handled = setParagraphAttribute(editor.state, dispatchRich, 'lineSpacing', command.value);
        break;
      case 'left-indent':
        handled = setParagraphAttribute(editor.state, dispatchRich, 'leftIndent', command.value);
        break;
      case 'first-line-indent':
        handled = setParagraphAttribute(
          editor.state,
          dispatchRich,
          'firstLineIndent',
          command.value,
        );
        break;
      case 'right-indent':
        handled = setParagraphAttribute(editor.state, dispatchRich, 'rightIndent', command.value);
        break;
      case 'tab-stops':
        handled = setParagraphAttribute(editor.state, dispatchRich, 'tabStops', command.value);
        break;
    }
    if (handled && editableRef.current) editor.focus();
    return handled;
  };

  const flushLayout = useCallback(async (): Promise<void> => {
    if (!view.current) throw new Error('The Write editor is not available.');
    const generation = layoutGeneration.current;
    if (settledLayoutGeneration.current >= generation) return;
    const failure = failedLayout.current;
    if (failure?.generation === generation) throw failure.error;
    await new Promise<void>((resolve, reject) => {
      layoutWaiters.current.push({ generation, resolve, reject });
    });
  }, []);

  const prepareSave = useCallback(async (): Promise<DocumentPayload> => {
    while (true) {
      const generation = layoutGeneration.current;
      await flushLayout();
      if (
        generation === layoutGeneration.current &&
        settledLayoutGeneration.current >= generation
      ) {
        const editor = view.current;
        if (!editor) throw new Error('The Write editor is not available.');
        return editorDocumentToPayload(editor.state.doc, rich.current);
      }
    }
  }, [flushLayout]);

  useImperativeHandle(editorRef, (): WriteEditorHandle => ({
    execute,
    clipboard: async (action) => {
      const editor = view.current;
      if (!editor) return;
      if (!editableRef.current) editor.setProps({ editable: () => true });
      editor.focus();
      try {
        await window.macintosh.editClipboard(action);
      } finally {
        if (view.current === editor) {
          editor.setProps({ editable: () => editableRef.current });
        }
      }
    },
    focus: () => view.current?.focus(),
    context: () =>
      view.current
        ? editorContext(view.current.state)
        : editorContext(EditorState.create({ schema: writeSchema })),
    flushLayout,
    prepareSave,
  }));

  useLayoutEffect(() => {
    if (!mount.current) return;
    const state = EditorState.create({
      schema: writeSchema,
      doc: payloadToEditorDocument(payload),
      plugins: [
        history(),
        automaticPageBreakPlugin,
        keymap({
          Tab: insertTab,
        }),
        keymap(baseKeymap),
      ],
    });
    const editor = new EditorView(mount.current, {
      state,
      editable: () => editableRef.current,
      handlePaste: (_view, event) => {
        if ((event.clipboardData?.files.length ?? 0) === 0) return false;
        pendingRichPaste.current = false;
        return true;
      },
      transformPasted: (slice) => {
        const sanitized = sanitizePastedWriteSlice(slice);
        pendingRichPaste.current = sliceHasRichWriteSemantics(sanitized);
        return sanitized;
      },
      attributes: {
        'aria-label': 'Write document',
        'data-write-editor': 'true',
        spellcheck: 'false',
      },
      dispatchTransaction: (transaction) => {
        const pasted = transaction.getMeta('paste') === true;
        if (pasted && transaction.docChanged && pendingRichPaste.current) rich.current = true;
        if (pasted) pendingRichPaste.current = false;
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged) {
          changeHandler.current(editorDocumentToPayload(next.doc, rich.current));
        }
        if (transaction.docChanged || transaction.selectionSet || transaction.storedMarksSet) {
          publishContext();
        }
        if (transaction.docChanged) scheduleLayout();
        else if (transaction.selectionSet) scheduleCaretPage();
      },
    });
    view.current = editor;
    publishContext();
    scheduleLayout();
    return () => {
      if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
      if (caretFrame.current !== null) cancelAnimationFrame(caretFrame.current);
      layoutFrame.current = null;
      caretFrame.current = null;
      const error = new Error('The Write editor closed before page layout finished.');
      for (const waiter of layoutWaiters.current) waiter.reject(error);
      layoutWaiters.current = [];
      editor.destroy();
      view.current = null;
    };
    // A Write window owns one editor instance for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    editableRef.current = active;
    view.current?.setProps({ editable: () => editableRef.current });
  }, [active]);

  useLayoutEffect(() => {
    zoomRef.current = zoom;
    scheduleLayout();
  }, [scheduleLayout, zoom]);

  const scale = zoom / 100;
  const canvasHeight = pageCount * 792 + (pageCount - 1) * 24;
  return (
    <div
      className="write-page-stack"
      data-page-count={pageCount}
      data-write-layout-generation={renderedLayoutGeneration}
      data-write-layout-pass={layoutPass}
      data-write-layout-state={layoutState}
      style={{ width: 612 * scale, height: canvasHeight * scale }}
    >
      <div
        className="write-scaled-canvas"
        style={{ width: 612, height: canvasHeight, transform: `scale(${scale})` }}
      >
        {Array.from({ length: pageCount }, (_, index) => (
          <div
            aria-hidden="true"
            className="write-page-paper"
            key={index}
            style={{ top: index * 816 }}
          />
        ))}
        <div className="write-editor-layer" ref={mount} />
      </div>
    </div>
  );
}
