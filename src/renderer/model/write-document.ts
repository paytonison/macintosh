import {
  Fragment,
  Schema,
  Slice,
  type Mark,
  type MarkType,
  type Node as ProseMirrorNode,
} from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';

import {
  WRITE_FONT_FAMILIES,
  WRITE_FONT_SIZES,
  WRITE_TEXT_MARK_TYPES,
  createDefaultWriteParagraphStyle,
  promotePlainTextPayload,
  sanitizeWriteParagraphStyle,
  sanitizeDocumentPayload,
  writeFontFamilyMarkType,
  writeFontSizeMarkType,
  writeMarkFontFamily,
  writeMarkFontSize,
  type DocumentPayload,
  type WriteAlignment,
  type WriteBlock,
  type WriteFontFamily,
  type WriteFontSize,
  type WriteInline,
  type WriteLineSpacing,
  type WriteMark,
  type WriteParagraphStyle,
  type WriteTextMarkType,
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

const normalizeCssFontName = (value: string): string =>
  value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();

const WRITE_CSS_FONT_NAMES: Record<WriteFontFamily, ReadonlySet<string>> = {
  serif: new Set(['times new roman', 'times', 'serif']),
  sans: new Set(['helvetica', 'arial', 'sans-serif']),
  mono: new Set(['monaco', 'courier new', 'monospace']),
};

export const parseWriteFontFamilyCss = (value: unknown): WriteFontFamily | null => {
  if (typeof value !== 'string') return null;
  const names = value.split(',').map(normalizeCssFontName);
  if (names.length === 0 || names.some((name) => name.length === 0)) return null;
  const matches = WRITE_FONT_FAMILIES.filter((family) =>
    names.every((name) => WRITE_CSS_FONT_NAMES[family].has(name)),
  );
  return matches.length === 1 ? matches[0]! : null;
};

export const parseWriteFontFamilyData = (value: unknown): WriteFontFamily | null =>
  WRITE_FONT_FAMILIES.find((candidate) => candidate === value) ?? null;

export const parseWriteFontSizeCss = (value: unknown): WriteFontSize | null => {
  if (typeof value !== 'string') return null;
  const match = /^\s*(9|10|12|14|18|24)(?:px|pt)?\s*$/i.exec(value);
  if (!match) return null;
  const size = Number(match[1]);
  return WRITE_FONT_SIZES.find((candidate) => candidate === size) ?? null;
};

const familyMarkAttrs = (value: unknown): { family: WriteFontFamily } | false => {
  const family = parseWriteFontFamilyCss(value);
  return family === null ? false : { family };
};

const logicalFamilyMarkAttrs = (value: unknown): { family: WriteFontFamily } | false => {
  const family = parseWriteFontFamilyData(value);
  return family === null ? false : { family };
};

const sizeMarkAttrs = (value: unknown): { size: WriteFontSize } | false => {
  const size = parseWriteFontSizeCss(value);
  return size === null ? false : { size };
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
          // Retained only as a read-compatible fallback for existing write-v1 payloads.
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
    font_family: {
      attrs: { family: { default: paragraphDefaults.fontFamily } },
      parseDOM: [
        {
          tag: 'span[data-write-font-family]',
          getAttrs: (node) =>
            node instanceof HTMLElement
              ? logicalFamilyMarkAttrs(node.getAttribute('data-write-font-family'))
              : false,
        },
        { style: 'font-family', getAttrs: familyMarkAttrs },
      ],
      toDOM: (mark) => ['span', { 'data-write-font-family': mark.attrs.family as string }, 0],
    },
    font_size: {
      attrs: { size: { default: paragraphDefaults.fontSize } },
      parseDOM: [
        {
          tag: 'span[data-write-font-size]',
          getAttrs: (node) =>
            node instanceof HTMLElement
              ? sizeMarkAttrs(node.getAttribute('data-write-font-size'))
              : false,
        },
        { style: 'font-size', getAttrs: sizeMarkAttrs },
      ],
      toDOM: (mark) => ['span', { 'data-write-font-size': String(mark.attrs.size) }, 0],
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

const isWriteFontFamily = (value: unknown): value is WriteFontFamily =>
  WRITE_FONT_FAMILIES.some((candidate) => candidate === value);

const isWriteFontSize = (value: unknown): value is WriteFontSize =>
  WRITE_FONT_SIZES.some((candidate) => candidate === value);

const proseMirrorMarkFromWriteMark = (mark: WriteMark): Mark | null => {
  if (WRITE_TEXT_MARK_TYPES.some((candidate) => candidate === mark.type)) {
    return writeSchema.marks[mark.type].create();
  }
  const family = writeMarkFontFamily(mark.type);
  if (family !== null) return writeSchema.marks.font_family.create({ family });
  const size = writeMarkFontSize(mark.type);
  return size === null ? null : writeSchema.marks.font_size.create({ size });
};

const inlineNodes = (content: readonly WriteInline[]) =>
  content.flatMap((inline) => {
    if (inline.type === 'tab') return [writeSchema.nodes.tab.create()];
    if (!inline.text) return [];
    const marks = (inline.marks ?? []).flatMap((mark) => {
      const converted = proseMirrorMarkFromWriteMark(mark);
      return converted ? [converted] : [];
    });
    return [writeSchema.text(inline.text, marks)];
  });

export const payloadToEditorDocument = (payload: DocumentPayload): ProseMirrorNode => {
  const safe = sanitizeDocumentPayload(payload);
  const promoted =
    safe.format === 'plain-text' ? sanitizeDocumentPayload(promotePlainTextPayload(safe)) : safe;
  const blocks: WriteBlock[] = promoted.format === 'write-v1' ? promoted.blocks : [];
  return writeSchema.nodes.doc.create(
    null,
    blocks.map((block) =>
      block.type === 'page-break'
        ? writeSchema.nodes.page_break.create()
        : writeSchema.nodes.paragraph.create(block.style, inlineNodes(block.content)),
    ),
  );
};

const textMarkType = (mark: Mark): WriteTextMarkType | null =>
  mark.type === writeSchema.marks.bold
    ? 'bold'
    : mark.type === writeSchema.marks.italic
      ? 'italic'
      : mark.type === writeSchema.marks.underline
        ? 'underline'
        : null;

const markFontFamily = (mark: Mark): WriteFontFamily | null =>
  mark.type === writeSchema.marks.font_family && isWriteFontFamily(mark.attrs.family)
    ? mark.attrs.family
    : null;

const markFontSize = (mark: Mark): WriteFontSize | null =>
  mark.type === writeSchema.marks.font_size && isWriteFontSize(mark.attrs.size)
    ? mark.attrs.size
    : null;

const writeMarksFromProseMirror = (
  marks: readonly Mark[],
  fallback: WriteParagraphStyle,
): WriteMark[] => {
  const converted: WriteMark[] = [];
  let family: WriteFontFamily | null = null;
  let size: WriteFontSize | null = null;
  for (const mark of marks) {
    const textType = textMarkType(mark);
    if (textType !== null) {
      converted.push({ type: textType });
      continue;
    }
    family ??= markFontFamily(mark);
    size ??= markFontSize(mark);
  }
  const effectiveFamily = family ?? fallback.fontFamily;
  const effectiveSize = size ?? fallback.fontSize;
  if (family !== null || effectiveFamily !== paragraphDefaults.fontFamily) {
    converted.push({ type: writeFontFamilyMarkType(effectiveFamily) });
  }
  if (size !== null || effectiveSize !== paragraphDefaults.fontSize) {
    converted.push({ type: writeFontSizeMarkType(effectiveSize) });
  }
  return converted;
};

const paragraphContent = (node: ProseMirrorNode): WriteInline[] => {
  const fallback = styleFromAttrs(node.attrs);
  const content: WriteInline[] = [];
  node.forEach((inline) => {
    if (inline.type === writeSchema.nodes.tab) {
      content.push({ type: 'tab' });
      return;
    }
    if (!inline.isText || !inline.text) return;
    const marks = writeMarksFromProseMirror(inline.marks, fallback);
    content.push({
      type: 'text',
      text: inline.text,
      ...(marks.length > 0 ? { marks } : {}),
    });
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
      const content = paragraphContent(block);
      const style = styleFromAttrs(block.attrs);
      blocks.push({
        type: 'paragraph',
        style:
          content.some((inline) => inline.type === 'text') &&
          (style.fontFamily !== paragraphDefaults.fontFamily ||
            style.fontSize !== paragraphDefaults.fontSize)
            ? {
                ...style,
                fontFamily: paragraphDefaults.fontFamily,
                fontSize: paragraphDefaults.fontSize,
              }
            : style,
        content,
      });
    }
  });
  return {
    format: 'write-v1',
    pagePreset: 'us-letter-1in',
    blocks,
  };
};

export type WriteSelectionMarkState = boolean | 'mixed';

export interface WriteSelectionStyle {
  fontFamily: WriteFontFamily | null;
  fontSize: WriteFontSize | null;
  alignment: WriteAlignment | null;
  leftIndent: number | null;
  firstLineIndent: number | null;
  rightIndent: number | null;
  tabStops: number[] | null;
  lineSpacing: WriteLineSpacing | null;
  bold: WriteSelectionMarkState;
  italic: WriteSelectionMarkState;
  underline: WriteSelectionMarkState;
}

const markState = (state: EditorState, name: WriteTextMarkType): WriteSelectionMarkState => {
  const type = writeSchema.marks[name];
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));

  let marked = false;
  let unmarked = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText || !node.text) return true;
    if (type.isInSet(node.marks)) marked = true;
    else unmarked = true;
    return !(marked && unmarked);
  });
  return marked && unmarked ? 'mixed' : marked;
};

const paragraphStylesEqual = (left: WriteParagraphStyle, right: WriteParagraphStyle): boolean =>
  left.fontFamily === right.fontFamily &&
  left.fontSize === right.fontSize &&
  left.alignment === right.alignment &&
  left.leftIndent === right.leftIndent &&
  left.firstLineIndent === right.firstLineIndent &&
  left.rightIndent === right.rightIndent &&
  left.lineSpacing === right.lineSpacing &&
  left.tabStops.length === right.tabStops.length &&
  left.tabStops.every((stop, index) => stop === right.tabStops[index]);

const selectedParagraphStyles = (state: EditorState): WriteParagraphStyle[] => {
  if (state.selection.empty) {
    return state.selection.$from.parent.type === writeSchema.nodes.paragraph
      ? [styleFromAttrs(state.selection.$from.parent.attrs)]
      : [];
  }
  const styles: WriteParagraphStyle[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (node.type !== writeSchema.nodes.paragraph) return true;
    styles.push(styleFromAttrs(node.attrs));
    return false;
  });
  return styles;
};

const commonValue = <Value>(
  values: readonly Value[],
  equal: (left: Value, right: Value) => boolean = Object.is,
): Value | null => {
  const first = values[0];
  if (first === undefined || values.some((value) => !equal(value, first))) return null;
  return first;
};

const fragmentHasText = (fragment: Fragment): boolean => {
  let hasText = false;
  fragment.forEach((inline) => {
    if (inline.isText && inline.text) hasText = true;
  });
  return hasText;
};

const paragraphHasText = (paragraph: ProseMirrorNode): boolean =>
  fragmentHasText(paragraph.content);

const activeInlineStyle = <Value extends WriteFontFamily | WriteFontSize>(
  state: EditorState,
  type: MarkType,
  markValue: (mark: Mark) => Value | null,
  paragraphValue: (style: WriteParagraphStyle) => Value,
): Value | null => {
  if (state.selection.empty) {
    const mark = type.isInSet(state.storedMarks ?? state.selection.$from.marks());
    const explicit = mark ? markValue(mark) : null;
    if (explicit !== null) return explicit;
    return state.selection.$from.parent.type === writeSchema.nodes.paragraph
      ? paragraphValue(styleFromAttrs(state.selection.$from.parent.attrs))
      : null;
  }

  const values: Value[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, _position, parent) => {
    if (node.type === writeSchema.nodes.paragraph && !paragraphHasText(node)) {
      values.push(paragraphValue(styleFromAttrs(node.attrs)));
      return false;
    }
    if (!node.isText || !node.text) return true;
    const mark = type.isInSet(node.marks);
    const explicit = mark ? markValue(mark) : null;
    const fallback =
      parent?.type === writeSchema.nodes.paragraph
        ? paragraphValue(styleFromAttrs(parent.attrs))
        : paragraphValue(paragraphDefaults);
    values.push(explicit ?? fallback);
    return true;
  });
  if (values.length > 0) return commonValue(values);
  return commonValue(selectedParagraphStyles(state).map(paragraphValue));
};

export const selectionStyle = (state: EditorState): WriteSelectionStyle => {
  const styles = selectedParagraphStyles(state);
  return {
    fontFamily: activeInlineStyle(
      state,
      writeSchema.marks.font_family,
      markFontFamily,
      (style) => style.fontFamily,
    ),
    fontSize: activeInlineStyle(
      state,
      writeSchema.marks.font_size,
      markFontSize,
      (style) => style.fontSize,
    ),
    alignment: commonValue(styles.map((style) => style.alignment)),
    leftIndent: commonValue(styles.map((style) => style.leftIndent)),
    firstLineIndent: commonValue(styles.map((style) => style.firstLineIndent)),
    rightIndent: commonValue(styles.map((style) => style.rightIndent)),
    tabStops: commonValue(
      styles.map((style) => style.tabStops),
      (left, right) =>
        left.length === right.length && left.every((stop, index) => stop === right[index]),
    ),
    lineSpacing: commonValue(styles.map((style) => style.lineSpacing)),
    bold: markState(state, 'bold'),
    italic: markState(state, 'italic'),
    underline: markState(state, 'underline'),
  };
};

export const setInlineStyleMark = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  attribute: 'fontFamily' | 'fontSize',
  value: WriteFontFamily | WriteFontSize,
): boolean => {
  const current = selectionStyle(state);
  if (current[attribute] === value) return false;
  const { empty, from, to } = state.selection;
  if (empty && state.selection.$from.parent.type !== writeSchema.nodes.paragraph) return false;
  let hasText = false;
  const emptyParagraphs: { node: ProseMirrorNode; position: number }[] = [];
  if (!empty) {
    state.doc.nodesBetween(from, to, (node, position) => {
      if (node.type === writeSchema.nodes.paragraph && !paragraphHasText(node)) {
        emptyParagraphs.push({ node, position });
        return false;
      }
      if (node.isText && node.text) hasText = true;
      return true;
    });
    if (!hasText && emptyParagraphs.length === 0) return false;
  }
  const type =
    attribute === 'fontFamily' ? writeSchema.marks.font_family : writeSchema.marks.font_size;
  const mark =
    attribute === 'fontFamily'
      ? type.create({ family: value as WriteFontFamily })
      : type.create({ size: value as WriteFontSize });
  if (dispatch) {
    let transaction = state.tr;
    if (empty) {
      transaction = transaction.addStoredMark(mark);
    } else {
      if (hasText) transaction = transaction.removeMark(from, to, type).addMark(from, to, mark);
      for (const paragraph of emptyParagraphs) {
        const style = styleFromAttrs(paragraph.node.attrs);
        transaction = transaction.setNodeMarkup(paragraph.position, undefined, {
          ...style,
          [attribute]: value,
        });
      }
      transaction = transaction.scrollIntoView();
    }
    dispatch(transaction);
  }
  return true;
};

export const setParagraphAttribute = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  attribute:
    'alignment' | 'leftIndent' | 'firstLineIndent' | 'rightIndent' | 'tabStops' | 'lineSpacing',
  value: WriteAlignment | WriteLineSpacing | number | number[],
): boolean => {
  let changed = false;
  const transaction = state.tr;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (node.type !== writeSchema.nodes.paragraph) return true;
    const current = styleFromAttrs(node.attrs);
    const next = sanitizeWriteParagraphStyle({ ...current, [attribute]: value });
    if (paragraphStylesEqual(current, next)) return false;
    transaction.setNodeMarkup(position, undefined, next);
    changed = true;
    return false;
  });
  if (!changed && state.selection.$from.parent.type === writeSchema.nodes.paragraph) {
    const position = state.selection.$from.before();
    const current = styleFromAttrs(state.selection.$from.parent.attrs);
    const next = sanitizeWriteParagraphStyle({ ...current, [attribute]: value });
    if (!paragraphStylesEqual(current, next)) {
      transaction.setNodeMarkup(position, undefined, next);
      changed = true;
    }
  }
  if (changed && dispatch) {
    if (state.selection.empty && state.storedMarks !== null) {
      transaction.setStoredMarks(state.storedMarks);
    }
    dispatch(transaction.scrollIntoView());
  }
  return changed;
};

export const clearTextFormatting = (
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean => {
  const supportedMarks = WRITE_TEXT_MARK_TYPES.map((name) => writeSchema.marks[name]);
  const { empty, from, to, $from } = state.selection;
  if (empty) {
    const activeMarks = state.storedMarks ?? $from.marks();
    if (!supportedMarks.some((type) => type.isInSet(activeMarks))) return false;
    if (dispatch) {
      const transaction = supportedMarks.reduce(
        (next, type) => next.removeStoredMark(type),
        state.tr,
      );
      dispatch(transaction);
    }
    return true;
  }
  if (!supportedMarks.some((type) => state.doc.rangeHasMark(from, to, type))) return false;
  if (dispatch) {
    const transaction = supportedMarks.reduce(
      (next, type) => next.removeMark(from, to, type),
      state.tr,
    );
    dispatch(transaction.scrollIntoView());
  }
  return true;
};

export const clearSelection = (
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean => {
  if (state.selection.empty) return false;
  if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView());
  return true;
};

const normalizePastedMarks = (
  marks: readonly Mark[],
  fallback: WriteParagraphStyle,
): readonly Mark[] => {
  let normalized: readonly Mark[] = [];
  let family: WriteFontFamily | null = null;
  let size: WriteFontSize | null = null;
  for (const mark of marks) {
    const textType = textMarkType(mark);
    if (textType !== null) {
      normalized = mark.addToSet(normalized);
      continue;
    }
    family ??= markFontFamily(mark);
    size ??= markFontSize(mark);
  }
  const effectiveFamily = family ?? fallback.fontFamily;
  const effectiveSize = size ?? fallback.fontSize;
  if (family !== null || effectiveFamily !== paragraphDefaults.fontFamily) {
    normalized = writeSchema.marks.font_family
      .create({ family: effectiveFamily })
      .addToSet(normalized);
  }
  if (size !== null || effectiveSize !== paragraphDefaults.fontSize) {
    normalized = writeSchema.marks.font_size.create({ size: effectiveSize }).addToSet(normalized);
  }
  return normalized;
};

const normalizePastedFragment = (fragment: Fragment, fallback: WriteParagraphStyle): Fragment => {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      children.push(node.mark(normalizePastedMarks(node.marks, fallback)));
      return;
    }
    if (node.type === writeSchema.nodes.paragraph) {
      const paragraphStyle = styleFromAttrs(node.attrs);
      const content = normalizePastedFragment(node.content, paragraphStyle);
      const migratedStyle =
        fragmentHasText(content) &&
        (paragraphStyle.fontFamily !== paragraphDefaults.fontFamily ||
          paragraphStyle.fontSize !== paragraphDefaults.fontSize)
          ? {
              ...paragraphStyle,
              fontFamily: paragraphDefaults.fontFamily,
              fontSize: paragraphDefaults.fontSize,
            }
          : paragraphStyle;
      children.push(node.type.create(migratedStyle, content, node.marks));
      return;
    }
    children.push(node.isLeaf ? node : node.copy(normalizePastedFragment(node.content, fallback)));
  });
  return Fragment.fromArray(children);
};

export const sanitizePastedWriteSlice = (slice: Slice): Slice =>
  new Slice(
    normalizePastedFragment(slice.content, paragraphDefaults),
    slice.openStart,
    slice.openEnd,
  );

export const sliceHasRichWriteSemantics = (slice: Slice): boolean => {
  let rich = false;
  slice.content.descendants((node) => {
    if (
      node.type === writeSchema.nodes.tab ||
      node.type === writeSchema.nodes.page_break ||
      node.marks.some((mark) => {
        const textType = textMarkType(mark);
        if (textType !== null) return true;
        const family = markFontFamily(mark);
        if (family !== null) return family !== paragraphDefaults.fontFamily;
        const size = markFontSize(mark);
        return size !== null && size !== paragraphDefaults.fontSize;
      })
    ) {
      rich = true;
      return false;
    }
    if (
      node.type === writeSchema.nodes.paragraph &&
      !paragraphStylesEqual(styleFromAttrs(node.attrs), paragraphDefaults)
    ) {
      rich = true;
      return false;
    }
    return !rich;
  });
  return rich;
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

export const createPageLayoutSignature = (
  blockHeights: readonly number[],
  manualBreaks: ReadonlySet<number>,
  projection: PageProjection,
  automaticBreakPositions: readonly number[],
): string =>
  JSON.stringify([
    blockHeights,
    [...manualBreaks].sort((left, right) => left - right),
    projection.pageCount,
    projection.marginBefore,
    projection.manualBreakHeights,
    projection.internalBreakOffsets,
    automaticBreakPositions,
  ]);

export interface PageLayoutConvergenceState {
  pass: number;
  previousSignature: string | null;
}

export type PageLayoutConvergenceResult =
  | { status: 'repeat'; state: PageLayoutConvergenceState }
  | { status: 'stable'; pass: number }
  | { status: 'error'; pass: number };

export const advancePageLayoutConvergence = (
  state: PageLayoutConvergenceState,
  signature: string,
  passLimit = 4,
): PageLayoutConvergenceResult => {
  const pass = state.pass + 1;
  if (state.previousSignature === signature) return { status: 'stable', pass };
  if (pass >= Math.max(2, passLimit)) return { status: 'error', pass };
  return { status: 'repeat', state: { pass, previousSignature: signature } };
};
