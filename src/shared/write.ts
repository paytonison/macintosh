export const WRITE_PAGE_PRESET = 'us-letter-1in' as const;
export const WRITE_PAGE_WIDTH = 612;
export const WRITE_PAGE_HEIGHT = 792;
export const WRITE_PAGE_MARGIN = 72;
export const WRITE_TEXT_WIDTH = WRITE_PAGE_WIDTH - WRITE_PAGE_MARGIN * 2;
export const WRITE_DEFAULT_TAB_INTERVAL = 36;

export const WRITE_FONT_FAMILIES = ['serif', 'sans', 'mono'] as const;
export const WRITE_FONT_SIZES = [9, 10, 12, 14, 18, 24] as const;
export const WRITE_ALIGNMENTS = ['left', 'center', 'right'] as const;
export const WRITE_LINE_SPACINGS = [1, 1.5, 2] as const;
export const WRITE_TEXT_MARK_TYPES = ['bold', 'italic', 'underline'] as const;
export const WRITE_FONT_FAMILY_MARK_TYPES = [
  'font-family-serif',
  'font-family-sans',
  'font-family-mono',
] as const;
export const WRITE_FONT_SIZE_MARK_TYPES = [
  'font-size-9',
  'font-size-10',
  'font-size-12',
  'font-size-14',
  'font-size-18',
  'font-size-24',
] as const;
export const WRITE_MARK_TYPES = [
  ...WRITE_TEXT_MARK_TYPES,
  ...WRITE_FONT_FAMILY_MARK_TYPES,
  ...WRITE_FONT_SIZE_MARK_TYPES,
] as const;

export type WriteFontFamily = (typeof WRITE_FONT_FAMILIES)[number];
export type WriteFontSize = (typeof WRITE_FONT_SIZES)[number];
export type WriteAlignment = (typeof WRITE_ALIGNMENTS)[number];
export type WriteLineSpacing = (typeof WRITE_LINE_SPACINGS)[number];
export type WriteTextMarkType = (typeof WRITE_TEXT_MARK_TYPES)[number];
export type WriteFontFamilyMarkType = (typeof WRITE_FONT_FAMILY_MARK_TYPES)[number];
export type WriteFontSizeMarkType = (typeof WRITE_FONT_SIZE_MARK_TYPES)[number];
export type WriteMarkType = (typeof WRITE_MARK_TYPES)[number];

const WRITE_FONT_FAMILY_MARK_BY_VALUE: Record<WriteFontFamily, WriteFontFamilyMarkType> = {
  serif: 'font-family-serif',
  sans: 'font-family-sans',
  mono: 'font-family-mono',
};

const WRITE_FONT_SIZE_MARK_BY_VALUE: Record<WriteFontSize, WriteFontSizeMarkType> = {
  9: 'font-size-9',
  10: 'font-size-10',
  12: 'font-size-12',
  14: 'font-size-14',
  18: 'font-size-18',
  24: 'font-size-24',
};

export const writeFontFamilyMarkType = (family: WriteFontFamily): WriteFontFamilyMarkType =>
  WRITE_FONT_FAMILY_MARK_BY_VALUE[family];

export const writeFontSizeMarkType = (size: WriteFontSize): WriteFontSizeMarkType =>
  WRITE_FONT_SIZE_MARK_BY_VALUE[size];

export const writeMarkFontFamily = (type: WriteMarkType): WriteFontFamily | null => {
  const entry = Object.entries(WRITE_FONT_FAMILY_MARK_BY_VALUE).find(
    ([, markType]) => markType === type,
  );
  return (entry?.[0] as WriteFontFamily | undefined) ?? null;
};

export const writeMarkFontSize = (type: WriteMarkType): WriteFontSize | null => {
  const entry = Object.entries(WRITE_FONT_SIZE_MARK_BY_VALUE).find(
    ([, markType]) => markType === type,
  );
  return entry ? (Number(entry[0]) as WriteFontSize) : null;
};

export interface PlainTextDocumentPayload {
  format: 'plain-text';
  text: string;
}

export interface WriteMark {
  type: WriteMarkType;
}

export interface WriteTextInline {
  type: 'text';
  text: string;
  marks?: WriteMark[];
}

export interface WriteTabInline {
  type: 'tab';
}

export type WriteInline = WriteTextInline | WriteTabInline;

export interface WriteParagraphStyle {
  fontFamily: WriteFontFamily;
  fontSize: WriteFontSize;
  alignment: WriteAlignment;
  leftIndent: number;
  firstLineIndent: number;
  rightIndent: number;
  tabStops: number[];
  lineSpacing: WriteLineSpacing;
}

export interface WriteParagraphBlock {
  type: 'paragraph';
  style: WriteParagraphStyle;
  content: WriteInline[];
}

export interface WritePageBreakBlock {
  type: 'page-break';
}

export type WriteBlock = WriteParagraphBlock | WritePageBreakBlock;

export interface WriteDocumentPayload {
  format: 'write-v1';
  pagePreset: typeof WRITE_PAGE_PRESET;
  blocks: WriteBlock[];
}

export type DocumentPayload = PlainTextDocumentPayload | WriteDocumentPayload;

export const MAX_DOCUMENT_TEXT = 192 * 1024;
export const MAX_WRITE_BLOCKS = 2_048;
export const MAX_WRITE_INLINES = 8_192;

export const defaultWriteTabStops = (): number[] => {
  const stops: number[] = [];
  for (
    let point = WRITE_DEFAULT_TAB_INTERVAL;
    point < WRITE_TEXT_WIDTH;
    point += WRITE_DEFAULT_TAB_INTERVAL
  ) {
    stops.push(point);
  }
  return stops;
};

export const createDefaultWriteParagraphStyle = (): WriteParagraphStyle => ({
  fontFamily: 'sans',
  fontSize: 12,
  alignment: 'left',
  leftIndent: 0,
  firstLineIndent: 0,
  rightIndent: 0,
  tabStops: defaultWriteTabStops(),
  lineSpacing: 1,
});

export const createEmptyWritePayload = (): WriteDocumentPayload => ({
  format: 'write-v1',
  pagePreset: WRITE_PAGE_PRESET,
  blocks: [
    {
      type: 'paragraph',
      style: createDefaultWriteParagraphStyle(),
      content: [],
    },
  ],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <Value extends string | number>(
  value: unknown,
  allowed: readonly Value[],
): value is Value => allowed.some((candidate) => candidate === value);

const finitePoint = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(maximum, Math.max(minimum, value)))
    : fallback;

const sanitizeMarks = (
  value: unknown,
  fallbackFamily: WriteFontFamily,
  fallbackSize: WriteFontSize,
): WriteMark[] | undefined => {
  const seen = new Set<WriteMarkType>();
  const marks: WriteMark[] = [];
  let hasFamily = false;
  let hasSize = false;
  for (const candidate of Array.isArray(value) ? value : []) {
    if (
      !isRecord(candidate) ||
      !isOneOf(candidate.type, WRITE_MARK_TYPES) ||
      seen.has(candidate.type)
    ) {
      continue;
    }
    const family = writeMarkFontFamily(candidate.type);
    const size = writeMarkFontSize(candidate.type);
    if ((family !== null && hasFamily) || (size !== null && hasSize)) continue;
    seen.add(candidate.type);
    marks.push({ type: candidate.type });
    if (family !== null) hasFamily = true;
    if (size !== null) hasSize = true;
  }
  if (!hasFamily && fallbackFamily !== 'sans') {
    marks.push({ type: writeFontFamilyMarkType(fallbackFamily) });
  }
  if (!hasSize && fallbackSize !== 12) marks.push({ type: writeFontSizeMarkType(fallbackSize) });
  return marks.length > 0 ? marks : undefined;
};

export const sanitizeWriteParagraphStyle = (value: unknown): WriteParagraphStyle => {
  const fallback = createDefaultWriteParagraphStyle();
  if (!isRecord(value)) return fallback;
  const leftIndent = finitePoint(value.leftIndent, 0, 0, WRITE_TEXT_WIDTH - 36);
  const rightIndent = finitePoint(value.rightIndent, 0, 0, WRITE_TEXT_WIDTH - leftIndent - 36);
  const minimumFirstLine = -leftIndent;
  const maximumFirstLine = WRITE_TEXT_WIDTH - leftIndent - rightIndent - 18;
  const tabStops = Array.isArray(value.tabStops)
    ? [
        ...new Set(
          value.tabStops
            .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
            .map((item) => Math.round(item))
            .filter((item) => item > 0 && item < WRITE_TEXT_WIDTH),
        ),
      ]
        .sort((left, right) => left - right)
        .slice(0, 32)
    : fallback.tabStops;
  return {
    fontFamily: isOneOf(value.fontFamily, WRITE_FONT_FAMILIES)
      ? value.fontFamily
      : fallback.fontFamily,
    fontSize: isOneOf(value.fontSize, WRITE_FONT_SIZES) ? value.fontSize : fallback.fontSize,
    alignment: isOneOf(value.alignment, WRITE_ALIGNMENTS) ? value.alignment : fallback.alignment,
    leftIndent,
    firstLineIndent: finitePoint(value.firstLineIndent, 0, minimumFirstLine, maximumFirstLine),
    rightIndent,
    tabStops,
    lineSpacing: isOneOf(value.lineSpacing, WRITE_LINE_SPACINGS)
      ? value.lineSpacing
      : fallback.lineSpacing,
  };
};

export const sanitizeDocumentPayload = (value: unknown): DocumentPayload => {
  if (!isRecord(value)) return { format: 'plain-text', text: '' };
  if (value.format === 'plain-text') {
    return {
      format: 'plain-text',
      text: typeof value.text === 'string' ? value.text.slice(0, MAX_DOCUMENT_TEXT) : '',
    };
  }
  if (value.format !== 'write-v1' || value.pagePreset !== WRITE_PAGE_PRESET) {
    return { format: 'plain-text', text: '' };
  }

  let remainingText = MAX_DOCUMENT_TEXT;
  let remainingInlines = MAX_WRITE_INLINES;
  const blocks: WriteBlock[] = [];
  const sourceBlocks = Array.isArray(value.blocks) ? value.blocks.slice(0, MAX_WRITE_BLOCKS) : [];
  for (const source of sourceBlocks) {
    if (!isRecord(source)) continue;
    if (source.type === 'page-break') {
      blocks.push({ type: 'page-break' });
      continue;
    }
    if (source.type !== 'paragraph' || remainingInlines <= 0) continue;
    const style = sanitizeWriteParagraphStyle(source.style);
    const content: WriteInline[] = [];
    const sourceContent = Array.isArray(source.content) ? source.content : [];
    for (const inline of sourceContent) {
      if (remainingInlines <= 0 || !isRecord(inline)) break;
      if (inline.type === 'tab') {
        content.push({ type: 'tab' });
        remainingInlines -= 1;
        continue;
      }
      if (inline.type !== 'text' || typeof inline.text !== 'string' || inline.text.length === 0) {
        continue;
      }
      const text = inline.text.slice(0, remainingText);
      if (!text) break;
      const marks = sanitizeMarks(inline.marks, style.fontFamily, style.fontSize);
      content.push({ type: 'text', text, ...(marks ? { marks } : {}) });
      remainingText -= text.length;
      remainingInlines -= 1;
      if (remainingText <= 0) break;
    }
    blocks.push({
      type: 'paragraph',
      style:
        content.some((inline) => inline.type === 'text') &&
        (style.fontFamily !== 'sans' || style.fontSize !== 12)
          ? { ...style, fontFamily: 'sans', fontSize: 12 }
          : style,
      content,
    });
    if (remainingText <= 0) break;
  }

  return {
    format: 'write-v1',
    pagePreset: WRITE_PAGE_PRESET,
    blocks:
      blocks.length > 0
        ? blocks
        : [
            {
              type: 'paragraph',
              style: createDefaultWriteParagraphStyle(),
              content: [],
            },
          ],
  };
};

export const promotePlainTextPayload = (
  payload: PlainTextDocumentPayload,
): WriteDocumentPayload => ({
  format: 'write-v1',
  pagePreset: WRITE_PAGE_PRESET,
  blocks: payload.text.split('\n').map((text) => ({
    type: 'paragraph',
    style: createDefaultWriteParagraphStyle(),
    content: text
      .split('\t')
      .flatMap((segment, index, segments): WriteInline[] => [
        ...(segment ? [{ type: 'text' as const, text: segment }] : []),
        ...(index < segments.length - 1 ? [{ type: 'tab' as const }] : []),
      ]),
  })),
});

export const documentPayloadText = (payload: DocumentPayload): string =>
  payload.format === 'plain-text'
    ? payload.text
    : payload.blocks
        .map((block) =>
          block.type === 'page-break'
            ? '\f'
            : block.content.map((inline) => (inline.type === 'tab' ? '\t' : inline.text)).join(''),
        )
        .join('\n');

export const documentPayloadEqual = (left: DocumentPayload, right: DocumentPayload): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const reconcileCommittedDocument = (
  draft: DocumentPayload,
  committed: DocumentPayload,
): { draft: DocumentPayload; saved: DocumentPayload; dirty: boolean } => ({
  draft,
  saved: committed,
  dirty: !documentPayloadEqual(draft, committed),
});
