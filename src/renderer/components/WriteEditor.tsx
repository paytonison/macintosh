import {
  useCallback,
  useEffect,
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
  WriteMarkType,
} from '../../shared/write';
import {
  editorDocumentToPayload,
  insertManualPageBreak,
  insertTab,
  payloadToEditorDocument,
  projectBlockHeightsToPages,
  selectionStyle,
  setParagraphAttribute,
  writeSchema,
  type WriteSelectionStyle,
} from '../model/write-document';

export type WriteEditorCommand =
  | { type: 'undo' | 'redo' | 'select-all' | 'page-break' | 'tab' }
  | { type: 'mark'; mark: WriteMarkType }
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
}

export interface WriteEditorHandle {
  execute: (command: WriteEditorCommand) => boolean;
  clipboard: (action: 'copy' | 'cut' | 'paste') => Promise<void>;
  focus: () => void;
  context: () => WriteEditorContext;
}

interface WriteEditorProps {
  editorRef: Ref<WriteEditorHandle>;
  payload: DocumentPayload;
  zoom: 50 | 75 | 100;
  active: boolean;
  onChange: (payload: DocumentPayload) => void;
  onContextChange: (context: WriteEditorContext) => void;
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
      return next
        ? next.positions
        : transaction.docChanged
          ? positions.map((position) => transaction.mapping.map(position, -1))
          : positions;
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

export function WriteEditor({
  editorRef,
  payload,
  zoom,
  active,
  onChange,
  onContextChange,
  onPaginationChange,
}: WriteEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rich = useRef(payload.format === 'write-v1');
  const zoomRef = useRef(zoom);
  const layoutFrame = useRef<number | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const pageCountRef = useRef(1);
  const pageNumberRef = useRef(1);

  const publishContext = (): void => {
    if (view.current) onContextChange(editorContext(view.current.state));
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

  const layoutPages = useCallback((): void => {
    const editor = view.current;
    if (!editor) return;
    if ((automaticPageBreakKey.getState(editor.state)?.length ?? 0) > 0) {
      editor.dispatch(
        editor.state.tr.setMeta(automaticPageBreakKey, { positions: [] as readonly number[] }),
      );
    }
    const root = mount.current?.querySelector<HTMLElement>('.ProseMirror');
    if (!root) return;
    layoutTabs(root);
    const blocks = [...root.children].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    for (const block of blocks) {
      block.style.marginTop = '';
      if (block.matches('[data-write-page-break]')) block.style.height = '0px';
    }
    const heights = blocks.map((block) =>
      block.matches('[data-write-page-break]') ? 0 : block.offsetHeight + 8,
    );
    const manualBreaks = new Set(
      blocks.flatMap((block, index) => (block.matches('[data-write-page-break]') ? [index] : [])),
    );
    const projection = projectBlockHeightsToPages(heights, manualBreaks);
    const scale = zoomRef.current / 100;
    blocks.forEach((block, index) => {
      const margin = projection.marginBefore[index] ?? 0;
      if (margin > 0) block.style.marginTop = `${margin}px`;
      if (manualBreaks.has(index)) {
        block.style.height = `${projection.manualBreakHeights[index] ?? 0}px`;
      }
    });
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
    if (automaticBreakPositions.length > 0) {
      editor.dispatch(
        editor.state.tr.setMeta(automaticPageBreakKey, {
          positions: [...new Set(automaticBreakPositions)],
        }),
      );
    }
    const pageCountChanged = projection.pageCount !== pageCountRef.current;
    if (pageCountChanged) {
      pageCountRef.current = projection.pageCount;
      setPageCount(projection.pageCount);
    }
    const rootBounds = root.getBoundingClientRect();
    const selectionTop = editor?.coordsAtPos(editor.state.selection.head).top ?? rootBounds.top;
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
      onPaginationChange(pageNumber, projection.pageCount);
    }
  }, [layoutTabs, onPaginationChange]);

  const scheduleLayout = useCallback((): void => {
    if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = null;
      layoutPages();
    });
  }, [layoutPages]);

  const promote = (): void => {
    rich.current = true;
  };

  const execute = (command: WriteEditorCommand): boolean => {
    const editor = view.current;
    if (!editor) return false;
    const dispatch = (transaction: Parameters<EditorView['dispatch']>[0]): void =>
      editor.dispatch(transaction);
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
      case 'page-break':
        promote();
        handled = insertManualPageBreak(editor.state, dispatch);
        break;
      case 'tab':
        handled = insertTab(editor.state, dispatch);
        break;
      case 'mark':
        promote();
        handled = toggleMark(writeSchema.marks[command.mark])(editor.state, dispatch);
        break;
      case 'font-family':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'fontFamily', command.value);
        break;
      case 'font-size':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'fontSize', command.value);
        break;
      case 'alignment':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'alignment', command.value);
        break;
      case 'line-spacing':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'lineSpacing', command.value);
        break;
      case 'left-indent':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'leftIndent', command.value);
        break;
      case 'first-line-indent':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'firstLineIndent', command.value);
        break;
      case 'right-indent':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'rightIndent', command.value);
        break;
      case 'tab-stops':
        promote();
        handled = setParagraphAttribute(editor.state, dispatch, 'tabStops', command.value);
        break;
    }
    if (handled) editor.focus();
    return handled;
  };

  useImperativeHandle(editorRef, (): WriteEditorHandle => ({
    execute,
    clipboard: async (action) => {
      view.current?.focus();
      await window.macintosh.editClipboard(action);
    },
    focus: () => view.current?.focus(),
    context: () =>
      view.current
        ? editorContext(view.current.state)
        : editorContext(EditorState.create({ schema: writeSchema })),
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
      editable: () => active,
      attributes: {
        'aria-label': 'Write document',
        'data-write-editor': 'true',
        spellcheck: 'false',
      },
      dispatchTransaction: (transaction) => {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged) onChange(editorDocumentToPayload(next.doc, rich.current));
        if (transaction.docChanged || transaction.selectionSet || transaction.storedMarksSet) {
          publishContext();
        }
        if (transaction.docChanged || transaction.selectionSet) scheduleLayout();
      },
    });
    view.current = editor;
    publishContext();
    scheduleLayout();
    return () => {
      if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
      layoutFrame.current = null;
      editor.destroy();
      view.current = null;
    };
    // A Write window owns one editor instance for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.setProps({ editable: () => active });
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
