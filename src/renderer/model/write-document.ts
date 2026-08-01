import { Schema, type Mark, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';

import {
  createDefaultWriteParagraphStyle,
  promotePlainTextPayload,
  sanitizeWriteParagraphStyle,
  sanitizeDocumentPayload,
  type DocumentPayload,
  type WriteAlignment,
  type WriteBlock,
  type WriteFontFamily,
  type WriteFontSize,
  type WriteInline,
  type WriteLineSpacing,
  type WriteMarkType,
  type WriteParagraphStyle,
} from '../../shared/write';

const paragraphDefaults = createDefaultWriteParagraphStyle();

const paragraphAttrsFromDom = (element: HTMLElement): WriteParagraphStyle => {
  const numberAttribute = (name: string): number | undefined => {
    const value = element.getAttribute(name);
    return value === null ? undefined : Number(value);
  };
  const tabStops = element.getAttribute('data-tab-stops');
  return sanitizeWriteParagraphStyle({
    fontFamily: element.getAttribute('data-font-family'),
    fontSize: numberAttribute('data-font-size'),
    alignment: element.getAttribute('data-alignment'),
    leftIndent: numberAttribute('data-left-indent'),
    firstLineIndent: numberAttribute('data-first-line-indent'),
    rightIndent: numberAttribute('data-right-indent'),
    tabStops: tabStops === null ? undefined : tabStops.split(',').filter(Boolean).map(Number),
    lineSpacing: numberAttribute('data-line-spacing'),
  });
};

export const writeSchema = new Schema({
  nodes: {
    doc: { content: '(paragraph | page_break)+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      attrs: {
        fontFamily: { default: paragraphDefaults.fontFamily },
        fontSize: { default: paragraphDefaults.fontSize },
        alignment: { default: paragraphDefaults.alignment },
        leftIndent: { default: paragraphDefaults.leftIndent },
        firstLineIndent: { default: paragraphDefaults.firstLineIndent },
        rightIndent: { default: paragraphDefaults.rightIndent },
        tabStops: { default: paragraphDefaults.tabStops },
        lineSpacing: { default: paragraphDefaults.lineSpacing },
      },
      parseDOM: [
        {
          tag: 'p[data-write-paragraph]',
          getAttrs: (node) =>
            node instanceof HTMLElement ? paragraphAttrsFromDom(node) : paragraphDefaults,
        },
        { tag: 'p', getAttrs: () => paragraphDefaults },
      ],
      toDOM: (node) => [
        'p',
        {
          'data-write-paragraph': 'true',
          'data-font-family': node.attrs.fontFamily as string,
          'data-font-size': String(node.attrs.fontSize),
          'data-alignment': node.attrs.alignment as string,
          'data-left-indent': String(node.attrs.leftIndent),
          'data-first-line-indent': String(node.attrs.firstLineIndent),
          'data-right-indent': String(node.attrs.rightIndent),
          'data-tab-stops': Array.isArray(node.attrs.tabStops)
            ? (node.attrs.tabStops as number[]).join(',')
            : '',
          'data-line-spacing': String(node.attrs.lineSpacing),
          style: [
            `font-size:${String(node.attrs.fontSize)}px`,
            `text-align:${String(node.attrs.alignment)}`,
            `margin-left:${String(node.attrs.leftIndent)}px`,
            `margin-right:${String(node.attrs.rightIndent)}px`,
            `text-indent:${String(node.attrs.firstLineIndent)}px`,
            `line-height:${String(node.attrs.lineSpacing)}`,
          ].join(';'),
        },
        0,
      ],
    },
    text: { group: 'inline' },
    tab: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      leafText: () => '\t',
      parseDOM: [{ tag: 'span[data-write-tab]' }],
      toDOM: () => [
        'span',
        {
          class: 'write-tab',
          'data-write-tab': 'true',
          'aria-label': 'Tab',
        },
        '\t',
      ],
    },
    page_break: {
      group: 'block',
      atom: true,
      selectable: true,
      leafText: () => '\f',
      parseDOM: [{ tag: 'div[data-write-page-break]' }],
      toDOM: () => [
        'div',
        {
          class: 'write-manual-page-break',
          'data-write-page-break': 'true',
          contenteditable: 'false',
          role: 'separator',
          'aria-label': 'Manual page break',
        },
      ],
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong', 0],
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em', 0],
    },
    underline: {
      parseDOM: [{ tag: 'span.write-underline' }, { tag: 'u' }],
      toDOM: () => ['span', { class: 'write-underline' }, 0],
    },
  },
});

const styleFromAttrs = (attrs: unknown): WriteParagraphStyle => {
  const payload = sanitizeDocumentPayload({
    format: 'write-v1',
    pagePreset: 'us-letter-1in',
    blocks: [{ type: 'paragraph', style: attrs, content: [] }],
  });
  const block = payload.format === 'write-v1' ? payload.blocks[0] : undefined;
  return block?.type === 'paragraph' ? block.style : paragraphDefaults;
};

const inlineNodes = (content: readonly WriteInline[]) =>
  content.flatMap((inline) => {
    if (inline.type === 'tab') return [writeSchema.nodes.tab.create()];
    if (!inline.text) return [];
    const marks = (inline.marks ?? []).flatMap((mark) => {
      const type = writeSchema.marks[mark.type];
      return type ? [type.create()] : [];
    });
    return [writeSchema.text(inline.text, marks)];
  });

export const payloadToEditorDocument = (payload: DocumentPayload): ProseMirrorNode => {
  const safe = sanitizeDocumentPayload(payload);
  const blocks: WriteBlock[] =
    safe.format === 'plain-text' ? promotePlainTextPayload(safe).blocks : safe.blocks;
  return writeSchema.nodes.doc.create(
    null,
    blocks.map((block) =>
      block.type === 'page-break'
        ? writeSchema.nodes.page_break.create()
        : writeSchema.nodes.paragraph.create(block.style, inlineNodes(block.content)),
    ),
  );
};

const markType = (mark: Mark): WriteMarkType | null =>
  mark.type === writeSchema.marks.bold
    ? 'bold'
    : mark.type === writeSchema.marks.italic
      ? 'italic'
      : mark.type === writeSchema.marks.underline
        ? 'underline'
        : null;

const paragraphContent = (node: ProseMirrorNode): WriteInline[] => {
  const content: WriteInline[] = [];
  node.forEach((inline) => {
    if (inline.type === writeSchema.nodes.tab) {
      content.push({ type: 'tab' });
      return;
    }
    if (!inline.isText || !inline.text) return;
    const marks = inline.marks.flatMap((mark) => {
      const type = markType(mark);
      return type ? [{ type }] : [];
    });
    content.push({ type: 'text', text: inline.text, ...(marks.length > 0 ? { marks } : {}) });
  });
  return content;
};

export const editorDocumentToPayload = (
  document: ProseMirrorNode,
  rich: boolean,
): DocumentPayload => {
  if (!rich) {
    const lines: string[] = [];
    document.forEach((block) => {
      if (block.type === writeSchema.nodes.page_break) lines.push('\f');
      else
        lines.push(
          paragraphContent(block)
            .map((inline) => (inline.type === 'tab' ? '\t' : inline.text))
            .join(''),
        );
    });
    return { format: 'plain-text', text: lines.join('\n') };
  }
  const blocks: WriteBlock[] = [];
  document.forEach((block) => {
    if (block.type === writeSchema.nodes.page_break) {
      blocks.push({ type: 'page-break' });
    } else {
      blocks.push({
        type: 'paragraph',
        style: styleFromAttrs(block.attrs),
        content: paragraphContent(block),
      });
    }
  });
  return {
    format: 'write-v1',
    pagePreset: 'us-letter-1in',
    blocks,
  };
};

export interface WriteSelectionStyle extends WriteParagraphStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

const markActive = (state: EditorState, name: WriteMarkType): boolean => {
  const type = writeSchema.marks[name];
  const { from, $from, to, empty } = state.selection;
  return empty
    ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
    : state.doc.rangeHasMark(from, to, type);
};

export const selectionStyle = (state: EditorState): WriteSelectionStyle => {
  const attrs =
    state.selection.$from.parent.type === writeSchema.nodes.paragraph
      ? state.selection.$from.parent.attrs
      : paragraphDefaults;
  return {
    ...styleFromAttrs(attrs),
    bold: markActive(state, 'bold'),
    italic: markActive(state, 'italic'),
    underline: markActive(state, 'underline'),
  };
};

export const setParagraphAttribute = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  attribute:
    | 'fontFamily'
    | 'fontSize'
    | 'alignment'
    | 'leftIndent'
    | 'firstLineIndent'
    | 'rightIndent'
    | 'tabStops'
    | 'lineSpacing',
  value: WriteFontFamily | WriteFontSize | WriteAlignment | WriteLineSpacing | number | number[],
): boolean => {
  let changed = false;
  const transaction = state.tr;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (node.type !== writeSchema.nodes.paragraph) return true;
    transaction.setNodeMarkup(
      position,
      undefined,
      sanitizeWriteParagraphStyle({ ...node.attrs, [attribute]: value }),
    );
    changed = true;
    return false;
  });
  if (!changed && state.selection.$from.parent.type === writeSchema.nodes.paragraph) {
    const position = state.selection.$from.before();
    transaction.setNodeMarkup(
      position,
      undefined,
      sanitizeWriteParagraphStyle({ ...state.selection.$from.parent.attrs, [attribute]: value }),
    );
    changed = true;
  }
  if (changed && dispatch) dispatch(transaction.scrollIntoView());
  return changed;
};

export const insertManualPageBreak = (
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean => {
  if (!dispatch) return true;
  const paragraph = writeSchema.nodes.paragraph.create(paragraphDefaults);
  const transaction = state.tr.replaceSelectionWith(writeSchema.nodes.page_break.create());
  const insertion = transaction.selection.to;
  const appendedParagraph = transaction.doc.lastChild?.type === writeSchema.nodes.page_break;
  if (appendedParagraph) {
    transaction.insert(transaction.doc.content.size, paragraph);
  }
  transaction.setSelection(
    TextSelection.near(transaction.doc.resolve(insertion + (appendedParagraph ? 1 : 0)), 1),
  );
  dispatch(transaction.scrollIntoView());
  return true;
};

export const insertTab = (
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean => {
  if (dispatch)
    dispatch(state.tr.replaceSelectionWith(writeSchema.nodes.tab.create()).scrollIntoView());
  return true;
};

export interface PageProjection {
  pageCount: number;
  marginBefore: number[];
  manualBreakHeights: number[];
  internalBreakOffsets: number[][];
}

export const projectBlockHeightsToPages = (
  blockHeights: readonly number[],
  manualBreaks: ReadonlySet<number>,
  contentHeight = 648,
  pageStride = 816,
): PageProjection => {
  let cursor = 0;
  const marginBefore = blockHeights.map(() => 0);
  const manualBreakHeights = blockHeights.map(() => 0);
  const internalBreakOffsets = blockHeights.map((): number[] => []);
  const pageGap = pageStride - contentHeight;
  for (let index = 0; index < blockHeights.length; index += 1) {
    let local = cursor % pageStride;
    if (manualBreaks.has(index)) {
      const height = local === 0 ? pageStride : pageStride - local;
      manualBreakHeights[index] = height;
      cursor += height;
      continue;
    }
    const height = Math.max(1, Math.ceil(blockHeights[index] ?? 1));
    if (local > 0 && local + height > contentHeight) {
      const margin = pageStride - local;
      marginBefore[index] = margin;
      cursor += margin;
    }

    let consumed = 0;
    while (consumed < height) {
      local = cursor % pageStride;
      const available = Math.max(1, contentHeight - local);
      const amount = Math.min(height - consumed, available);
      cursor += amount;
      consumed += amount;
      if (consumed < height) {
        internalBreakOffsets[index]!.push(consumed);
        cursor += pageGap;
      }
    }
  }
  return {
    pageCount: Math.max(1, Math.floor(Math.max(0, cursor - 1) / pageStride) + 1),
    marginBefore,
    manualBreakHeights,
    internalBreakOffsets,
  };
};
