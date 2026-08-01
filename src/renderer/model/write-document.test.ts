import { describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { AllSelection, EditorState, NodeSelection, TextSelection } from 'prosemirror-state';

import { createDefaultWriteParagraphStyle, MAX_DOCUMENT_TEXT } from '../../shared/write';
import { editorContext } from '../components/WriteEditor';
import {
  advancePageLayoutConvergence,
  clearSelection,
  clearTextFormatting,
  createPageLayoutSignature,
  editorDocumentToPayload,
  insertManualPageBreak,
  parseWriteFontFamilyCss,
  parseWriteFontFamilyData,
  parseWriteFontSizeCss,
  payloadToEditorDocument,
  projectBlockHeightsToPages,
  sanitizePastedWriteSlice,
  selectionStyle,
  setInlineStyleMark,
  setParagraphAttribute,
  sliceHasRichWriteSemantics,
  writeSchema,
} from './write-document';

describe('Write editor projection', () => {
  it('round-trips plain text without promoting it', () => {
    const payload = { format: 'plain-text' as const, text: 'First\n\nThird\tcolumn' };
    const document = payloadToEditorDocument(payload);

    expect(editorDocumentToPayload(document, false)).toEqual(payload);
    expect(document.child(2).child(1).type).toBe(writeSchema.nodes.tab);
  });

  it('keeps default sans/12 implicit when a plain editor document becomes rich', () => {
    const document = payloadToEditorDocument({
      format: 'plain-text',
      text: 'Helvetica by default',
    });

    expect(editorDocumentToPayload(document, true)).toMatchObject({
      blocks: [
        {
          style: { fontFamily: 'sans', fontSize: 12 },
          content: [{ type: 'text', text: 'Helvetica by default' }],
        },
      ],
    });
    const payload = editorDocumentToPayload(document, true);
    if (payload.format !== 'write-v1' || payload.blocks[0]?.type !== 'paragraph') {
      throw new Error('Expected a rich paragraph.');
    }
    expect(payload.blocks[0].content[0]).toEqual({
      type: 'text',
      text: 'Helvetica by default',
    });
  });

  it('does not truncate a live draft before the canonical save boundary can reject it', () => {
    const oversizedText = 'x'.repeat(MAX_DOCUMENT_TEXT + 1);
    const textDocument = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(
        createDefaultWriteParagraphStyle(),
        writeSchema.text(oversizedText),
      ),
    ]);
    const structuralDocument = writeSchema.nodes.doc.create(
      null,
      Array.from({ length: 2_049 }, () =>
        writeSchema.nodes.paragraph.create(createDefaultWriteParagraphStyle()),
      ),
    );

    expect(editorDocumentToPayload(textDocument, false)).toEqual({
      format: 'plain-text',
      text: oversizedText,
    });
    const structuralPayload = editorDocumentToPayload(structuralDocument, true);
    expect(structuralPayload.format).toBe('write-v1');
    if (structuralPayload.format === 'write-v1')
      expect(structuralPayload.blocks).toHaveLength(2_049);
  });

  it('upgrades legacy paragraph fonts while round-tripping inline marks and structure', () => {
    const payload = {
      format: 'write-v1' as const,
      pagePreset: 'us-letter-1in' as const,
      blocks: [
        {
          type: 'paragraph' as const,
          style: {
            fontFamily: 'mono' as const,
            fontSize: 14 as const,
            alignment: 'center' as const,
            leftIndent: 18,
            firstLineIndent: 9,
            rightIndent: 36,
            tabStops: [72, 144],
            lineSpacing: 1.5 as const,
          },
          content: [
            { type: 'text' as const, text: 'Bold', marks: [{ type: 'bold' as const }] },
            { type: 'tab' as const },
            { type: 'text' as const, text: 'under', marks: [{ type: 'underline' as const }] },
          ],
        },
        { type: 'page-break' as const },
      ],
    };

    expect(editorDocumentToPayload(payloadToEditorDocument(payload), true)).toEqual({
      ...payload,
      blocks: [
        {
          ...payload.blocks[0],
          style: {
            ...payload.blocks[0].style,
            fontFamily: 'sans',
            fontSize: 12,
          },
          content: [
            {
              type: 'text',
              text: 'Bold',
              marks: [{ type: 'bold' }, { type: 'font-family-mono' }, { type: 'font-size-14' }],
            },
            { type: 'tab' },
            {
              type: 'text',
              text: 'under',
              marks: [
                { type: 'underline' },
                { type: 'font-family-mono' },
                { type: 'font-size-14' },
              ],
            },
          ],
        },
        { type: 'page-break' },
      ],
    });
  });

  it('adds and removes automatic page margins as block heights reflow', () => {
    const overflow = projectBlockHeightsToPages([400, 300], new Set());
    const backflow = projectBlockHeightsToPages([300, 300], new Set());
    const manual = projectBlockHeightsToPages([200, 0, 200], new Set([1]));

    expect(overflow).toMatchObject({ pageCount: 2, marginBefore: [0, 416] });
    expect(backflow).toMatchObject({ pageCount: 1, marginBefore: [0, 0] });
    expect(manual.pageCount).toBe(2);
    expect(manual.manualBreakHeights[1]).toBe(616);

    const longParagraph = projectBlockHeightsToPages([1_300], new Set());
    expect(longParagraph.pageCount).toBe(3);
    expect(longParagraph.internalBreakOffsets[0]).toEqual([648, 1_296]);
  });

  it('keeps automatic gaps out of logical boundary and multi-page measurements', () => {
    expect(projectBlockHeightsToPages([648], new Set())).toMatchObject({
      pageCount: 1,
      marginBefore: [0],
      internalBreakOffsets: [[]],
    });
    expect(projectBlockHeightsToPages([649], new Set())).toMatchObject({
      pageCount: 2,
      internalBreakOffsets: [[648]],
    });
    expect(projectBlockHeightsToPages([648, 1], new Set())).toMatchObject({
      pageCount: 2,
      marginBefore: [0, 168],
    });
    expect(projectBlockHeightsToPages([647, 1], new Set())).toMatchObject({
      pageCount: 1,
      marginBefore: [0, 0],
    });
    expect(projectBlockHeightsToPages([1_300], new Set()).internalBreakOffsets[0]).toEqual([
      648, 1_296,
    ]);
  });

  it('treats manual page breaks as barriers even at exact page boundaries', () => {
    const afterFullPage = projectBlockHeightsToPages([648, 0, 700], new Set([1]));
    const atDocumentStart = projectBlockHeightsToPages([0, 20], new Set([0]));

    expect(afterFullPage.manualBreakHeights[1]).toBe(168);
    expect(afterFullPage.internalBreakOffsets[2]).toEqual([648]);
    expect(afterFullPage.pageCount).toBe(3);
    expect(atDocumentStart.manualBreakHeights[0]).toBe(816);
    expect(atDocumentStart.pageCount).toBe(2);
  });

  it('requires consecutive matching page-layout signatures and fails on pass four', () => {
    const start = { pass: 0, previousSignature: null };
    const first = advancePageLayoutConvergence(start, 'A');
    expect(first).toEqual({
      status: 'repeat',
      state: { pass: 1, previousSignature: 'A' },
    });
    if (first.status !== 'repeat') throw new Error('Expected a second layout pass.');
    expect(advancePageLayoutConvergence(first.state, 'A')).toEqual({
      status: 'stable',
      pass: 2,
    });

    const second = advancePageLayoutConvergence(first.state, 'B');
    if (second.status !== 'repeat') throw new Error('Expected a third layout pass.');
    expect(advancePageLayoutConvergence(second.state, 'B')).toEqual({
      status: 'stable',
      pass: 3,
    });

    const third = advancePageLayoutConvergence(second.state, 'A');
    if (third.status !== 'repeat') throw new Error('Expected a fourth layout pass.');
    expect(advancePageLayoutConvergence(third.state, 'B')).toEqual({
      status: 'error',
      pass: 4,
    });
  });

  it('includes every projection input that can change rendered page layout in its signature', () => {
    const projection = projectBlockHeightsToPages([400, 300], new Set());
    const baseline = createPageLayoutSignature([400, 300], new Set(), projection, [10]);

    expect(createPageLayoutSignature([400, 300], new Set(), projection, [11])).not.toBe(baseline);
    expect(
      createPageLayoutSignature(
        [400, 300],
        new Set(),
        { ...projection, marginBefore: [0, 417] },
        [10],
      ),
    ).not.toBe(baseline);
    expect(
      createPageLayoutSignature(
        [400, 300],
        new Set([1]),
        { ...projection, manualBreakHeights: [0, 416] },
        [10],
      ),
    ).not.toBe(baseline);
  });

  it('clamps paragraph geometry before it enters the live editor state', () => {
    const state = EditorState.create({
      schema: writeSchema,
      doc: payloadToEditorDocument({ format: 'plain-text', text: 'bounded' }),
    });
    let next = state;

    expect(
      setParagraphAttribute(
        state,
        (transaction) => {
          next = state.apply(transaction);
        },
        'leftIndent',
        999,
      ),
    ).toBe(true);
    expect(next.doc.firstChild?.attrs.leftIndent).toBe(432);
    expect(next.doc.firstChild?.attrs.rightIndent).toBe(0);
  });

  it('does not dispatch or promote an implicit default inline format change', () => {
    const state = EditorState.create({
      schema: writeSchema,
      doc: payloadToEditorDocument({ format: 'plain-text', text: 'unchanged' }),
    });
    let dispatched = false;

    expect(
      setInlineStyleMark(
        state,
        () => {
          dispatched = true;
        },
        'fontFamily',
        'sans',
      ),
    ).toBe(false);
    expect(dispatched).toBe(false);
  });

  it('reports common paragraph values and tri-state marks across a mixed selection', () => {
    const defaults = createDefaultWriteParagraphStyle();
    const bold = writeSchema.marks.bold.create();
    const document = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(defaults, writeSchema.text('bold', [bold])),
      writeSchema.nodes.paragraph.create(
        { ...defaults, fontFamily: 'mono', alignment: 'center' },
        writeSchema.text('plain'),
      ),
    ]);
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, document.content.size - 1),
    });

    expect(selectionStyle(state)).toMatchObject({
      fontFamily: null,
      fontSize: 12,
      alignment: null,
      lineSpacing: 1,
      bold: 'mixed',
      italic: false,
      underline: false,
    });
    expect(editorContext(state)).toMatchObject({ canFormat: true, canClear: true });
  });

  it('reports and changes mixed inline family and size runs within one paragraph', () => {
    const defaults = createDefaultWriteParagraphStyle();
    const serif14 = [
      writeSchema.marks.font_family.create({ family: 'serif' }),
      writeSchema.marks.font_size.create({ size: 14 }),
    ];
    const mono18 = [
      writeSchema.marks.font_family.create({ family: 'mono' }),
      writeSchema.marks.font_size.create({ size: 18 }),
    ];
    const document = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(defaults, [
        writeSchema.text('serif', serif14),
        writeSchema.text('mono', mono18),
      ]),
    ]);
    const mixed = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, document.content.size - 1),
    });

    expect(selectionStyle(mixed)).toMatchObject({ fontFamily: null, fontSize: null });

    const firstRun = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, 6),
    });
    expect(selectionStyle(firstRun)).toMatchObject({ fontFamily: 'serif', fontSize: 14 });
    expect(setInlineStyleMark(firstRun, undefined, 'fontFamily', 'serif')).toBe(false);

    let next = mixed;
    expect(
      setInlineStyleMark(
        mixed,
        (transaction) => {
          next = mixed.apply(transaction);
        },
        'fontFamily',
        'sans',
      ),
    ).toBe(true);
    expect(selectionStyle(next)).toMatchObject({ fontFamily: 'sans', fontSize: null });
    expect(editorDocumentToPayload(next.doc, true)).toMatchObject({
      blocks: [
        {
          content: [
            {
              text: 'serif',
              marks: [{ type: 'font-family-sans' }, { type: 'font-size-14' }],
            },
            {
              text: 'mono',
              marks: [{ type: 'font-family-sans' }, { type: 'font-size-18' }],
            },
          ],
        },
      ],
    });
  });

  it('applies family and size as stored marks at a cursor', () => {
    const document = payloadToEditorDocument({ format: 'plain-text', text: 'typing' });
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 3),
    });
    let next = state;

    expect(
      setInlineStyleMark(
        state,
        (transaction) => {
          next = state.apply(transaction);
        },
        'fontSize',
        18,
      ),
    ).toBe(true);
    expect(selectionStyle(next).fontSize).toBe(18);
    expect(
      next.storedMarks?.find((mark) => mark.type === writeSchema.marks.font_size)?.attrs,
    ).toEqual({ size: 18 });
    expect(setInlineStyleMark(next, undefined, 'fontSize', 18)).toBe(false);
  });

  it('preserves explicit typing marks across paragraph formatting at a cursor', () => {
    const document = payloadToEditorDocument({ format: 'plain-text', text: 'body' });
    let state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1),
    });
    const dispatch = (transaction: Parameters<typeof state.apply>[0]): void => {
      state = state.apply(transaction);
    };

    expect(setInlineStyleMark(state, dispatch, 'fontFamily', 'serif')).toBe(true);
    expect(setInlineStyleMark(state, dispatch, 'fontSize', 18)).toBe(true);
    expect(setParagraphAttribute(state, dispatch, 'leftIndent', 18)).toBe(true);
    expect(selectionStyle(state)).toMatchObject({
      fontFamily: 'serif',
      fontSize: 18,
      leftIndent: 18,
    });

    state = state.apply(state.tr.insertText('A'));
    expect(editorDocumentToPayload(state.doc, true)).toMatchObject({
      blocks: [
        {
          style: { leftIndent: 18 },
          content: [
            {
              text: 'A',
              marks: [{ type: 'font-family-serif' }, { type: 'font-size-18' }],
            },
            { type: 'text', text: 'body' },
          ],
        },
      ],
    });
  });

  it('preserves the typing fallback of an empty legacy styled paragraph', () => {
    const legacyStyle = {
      ...createDefaultWriteParagraphStyle(),
      fontFamily: 'serif' as const,
      fontSize: 24 as const,
    };
    const empty = payloadToEditorDocument({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [{ type: 'paragraph', style: legacyStyle, content: [] }],
    });
    const emptyState = EditorState.create({ schema: writeSchema, doc: empty });
    expect(selectionStyle(emptyState)).toMatchObject({ fontFamily: 'serif', fontSize: 24 });

    const typed = emptyState.apply(emptyState.tr.insertText('A'));
    expect(editorDocumentToPayload(typed.doc, true)).toMatchObject({
      blocks: [
        {
          style: { fontFamily: 'sans', fontSize: 12 },
          content: [
            {
              text: 'A',
              marks: [{ type: 'font-family-serif' }, { type: 'font-size-24' }],
            },
          ],
        },
      ],
    });
  });

  it('updates text-less paragraph typing fallbacks inside an inline-format selection', () => {
    const defaults = createDefaultWriteParagraphStyle();
    const legacyEmpty = { ...defaults, fontFamily: 'serif' as const, fontSize: 24 as const };
    const document = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(defaults, writeSchema.text('text')),
      writeSchema.nodes.paragraph.create(legacyEmpty),
    ]);
    let state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: new AllSelection(document),
    });
    expect(selectionStyle(state)).toMatchObject({ fontFamily: null, fontSize: null });

    expect(
      setInlineStyleMark(
        state,
        (transaction) => {
          state = state.apply(transaction);
        },
        'fontFamily',
        'sans',
      ),
    ).toBe(true);
    expect(selectionStyle(state)).toMatchObject({ fontFamily: 'sans', fontSize: null });
    expect(state.doc.child(1).attrs.fontFamily).toBe('sans');

    expect(
      setInlineStyleMark(
        state,
        (transaction) => {
          state = state.apply(transaction);
        },
        'fontSize',
        12,
      ),
    ).toBe(true);
    expect(selectionStyle(state)).toMatchObject({ fontFamily: 'sans', fontSize: 12 });
    expect(state.doc.child(1).attrs).toMatchObject({ fontFamily: 'sans', fontSize: 12 });

    const emptyDocument = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(defaults),
    ]);
    const emptyState = EditorState.create({
      schema: writeSchema,
      doc: emptyDocument,
      selection: new AllSelection(emptyDocument),
    });
    let formattedEmpty = emptyState;
    expect(
      setInlineStyleMark(
        emptyState,
        (transaction) => {
          formattedEmpty = emptyState.apply(transaction);
        },
        'fontFamily',
        'mono',
      ),
    ).toBe(true);
    expect(formattedEmpty.doc.firstChild?.attrs.fontFamily).toBe('mono');

    const tabDocument = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(legacyEmpty, writeSchema.nodes.tab.create()),
    ]);
    let tabState = EditorState.create({
      schema: writeSchema,
      doc: tabDocument,
      selection: new AllSelection(tabDocument),
    });
    expect(selectionStyle(tabState)).toMatchObject({ fontFamily: 'serif', fontSize: 24 });
    expect(
      setInlineStyleMark(
        tabState,
        (transaction) => {
          tabState = tabState.apply(transaction);
        },
        'fontFamily',
        'mono',
      ),
    ).toBe(true);
    expect(
      setInlineStyleMark(
        tabState,
        (transaction) => {
          tabState = tabState.apply(transaction);
        },
        'fontSize',
        18,
      ),
    ).toBe(true);
    expect(selectionStyle(tabState)).toMatchObject({ fontFamily: 'mono', fontSize: 18 });
    expect(editorDocumentToPayload(tabState.doc, true)).toMatchObject({
      blocks: [
        {
          style: { fontFamily: 'mono', fontSize: 18 },
          content: [{ type: 'tab' }],
        },
      ],
    });
  });

  it('reports all-on marks for a uniformly formatted selection', () => {
    const bold = writeSchema.marks.bold.create();
    const document = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(
        createDefaultWriteParagraphStyle(),
        writeSchema.text('entirely bold', [bold]),
      ),
    ]);
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, document.content.size - 1),
    });

    expect(selectionStyle(state).bold).toBe(true);
  });

  it('removes face marks while retaining inline family, size, and paragraph formatting', () => {
    const style = {
      ...createDefaultWriteParagraphStyle(),
      fontFamily: 'mono' as const,
      fontSize: 14 as const,
      alignment: 'right' as const,
      lineSpacing: 2 as const,
    };
    const marks = [
      writeSchema.marks.bold.create(),
      writeSchema.marks.italic.create(),
      writeSchema.marks.underline.create(),
      writeSchema.marks.font_family.create({ family: 'mono' }),
      writeSchema.marks.font_size.create({ size: 14 }),
    ];
    const document = writeSchema.nodes.doc.create(null, [
      writeSchema.nodes.paragraph.create(style, writeSchema.text('marked', marks)),
    ]);
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, 7),
    });
    let next = state;

    expect(
      clearTextFormatting(state, (transaction) => {
        next = state.apply(transaction);
      }),
    ).toBe(true);
    expect(next.doc.firstChild?.attrs).toMatchObject(style);
    expect(next.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'font_family',
      'font_size',
    ]);
    expect(clearTextFormatting(next)).toBe(false);
  });

  it('clears only non-empty selections', () => {
    const document = payloadToEditorDocument({ format: 'plain-text', text: 'remove me' });
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1, document.content.size - 1),
    });
    let next = state;

    expect(
      clearSelection(state, (transaction) => {
        next = state.apply(transaction);
      }),
    ).toBe(true);
    expect(next.doc.textContent).toBe('');
    expect(clearSelection(next)).toBe(false);
  });

  it('promotes only pasted slices that retain supported Write semantics', () => {
    const defaults = createDefaultWriteParagraphStyle();
    const plain = new Slice(
      Fragment.from(writeSchema.nodes.paragraph.create(defaults, writeSchema.text('plain'))),
      0,
      0,
    );
    const bold = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create(
          defaults,
          writeSchema.text('bold', [writeSchema.marks.bold.create()]),
        ),
      ),
      0,
      0,
    );
    const styled = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create({ ...defaults, fontSize: 18 }, writeSchema.text('big')),
      ),
      0,
      0,
    );
    const inlineStyled = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create(
          defaults,
          writeSchema.text('inline', [
            writeSchema.marks.font_family.create({ family: 'mono' }),
            writeSchema.marks.font_size.create({ size: 18 }),
          ]),
        ),
      ),
      0,
      0,
    );
    const inlineDefaults = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create(
          defaults,
          writeSchema.text('defaults', [
            writeSchema.marks.font_family.create({ family: 'sans' }),
            writeSchema.marks.font_size.create({ size: 12 }),
          ]),
        ),
      ),
      0,
      0,
    );
    const unsupportedStyle = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create(
          { ...defaults, fontFamily: 'comic-sans', color: 'red' },
          writeSchema.text('safe'),
        ),
      ),
      0,
      0,
    );
    const structural = new Slice(
      Fragment.fromArray([
        writeSchema.nodes.paragraph.create(defaults, writeSchema.nodes.tab.create()),
        writeSchema.nodes.page_break.create(),
      ]),
      0,
      0,
    );

    expect(sliceHasRichWriteSemantics(plain)).toBe(false);
    expect(sliceHasRichWriteSemantics(bold)).toBe(true);
    expect(sliceHasRichWriteSemantics(styled)).toBe(true);
    expect(sliceHasRichWriteSemantics(inlineStyled)).toBe(true);
    expect(sliceHasRichWriteSemantics(inlineDefaults)).toBe(false);
    expect(sliceHasRichWriteSemantics(unsupportedStyle)).toBe(false);
    expect(sliceHasRichWriteSemantics(structural)).toBe(true);
  });

  it('sanitizes pasted family and size runs while upgrading legacy paragraph values', () => {
    const legacy = {
      ...createDefaultWriteParagraphStyle(),
      fontFamily: 'serif' as const,
      fontSize: 18 as const,
    };
    const pasted = new Slice(
      Fragment.from(
        writeSchema.nodes.paragraph.create(legacy, [
          writeSchema.text('explicit', [
            writeSchema.marks.font_family.create({ family: 'mono' }),
            writeSchema.marks.font_size.create({ size: 24 }),
          ]),
          writeSchema.text('legacy', [
            writeSchema.marks.font_family.create({ family: 'papyrus' }),
            writeSchema.marks.font_size.create({ size: 13 }),
          ]),
        ]),
      ),
      0,
      0,
    );

    const sanitized = sanitizePastedWriteSlice(pasted);
    const paragraph = sanitized.content.firstChild;
    expect(paragraph?.attrs).toMatchObject({ fontFamily: 'sans', fontSize: 12 });
    expect(paragraph?.child(0).marks.map((mark) => [mark.type.name, mark.attrs])).toEqual([
      ['font_family', { family: 'mono' }],
      ['font_size', { size: 24 }],
    ]);
    expect(paragraph?.child(1).marks.map((mark) => [mark.type.name, mark.attrs])).toEqual([
      ['font_family', { family: 'serif' }],
      ['font_size', { size: 18 }],
    ]);

    const tabOnly = sanitizePastedWriteSlice(
      new Slice(
        Fragment.from(writeSchema.nodes.paragraph.create(legacy, writeSchema.nodes.tab.create())),
        0,
        0,
      ),
    );
    expect(tabOnly.content.firstChild?.attrs).toMatchObject({ fontFamily: 'serif', fontSize: 18 });
    expect(tabOnly.content.firstChild?.firstChild?.type).toBe(writeSchema.nodes.tab);
  });

  it('accepts only the logical family stacks and allowlisted point sizes from pasted CSS', () => {
    expect(parseWriteFontFamilyData('serif')).toBe('serif');
    expect(parseWriteFontFamilyData('sans')).toBe('sans');
    expect(parseWriteFontFamilyData('mono')).toBe('mono');
    expect(parseWriteFontFamilyData('sans-serif')).toBeNull();
    expect(parseWriteFontFamilyCss('Helvetica, Arial, sans-serif')).toBe('sans');
    expect(parseWriteFontFamilyCss("'Times New Roman', Times, serif")).toBe('serif');
    expect(parseWriteFontFamilyCss("Monaco, 'Courier New', monospace")).toBe('mono');
    expect(parseWriteFontFamilyCss('Helvetica, Papyrus')).toBeNull();
    expect(parseWriteFontFamilyCss('Papyrus')).toBeNull();
    expect(parseWriteFontSizeCss('14px')).toBe(14);
    expect(parseWriteFontSizeCss('18pt')).toBe(18);
    expect(parseWriteFontSizeCss('13px')).toBeNull();
    expect(parseWriteFontSizeCss('14px; color: red')).toBeNull();
  });

  it.each([
    { label: 'middle', position: 4, before: 'abc', after: 'def' },
    { label: 'end', position: 7, before: 'abcdef', after: '' },
  ])(
    'inserts one manual page break at the $label cursor and selects the following text',
    (sample) => {
      const document = payloadToEditorDocument({ format: 'plain-text', text: 'abcdef' });
      const state = EditorState.create({
        schema: writeSchema,
        doc: document,
        selection: TextSelection.create(document, sample.position),
      });
      let next = state;

      expect(
        insertManualPageBreak(state, (transaction) => {
          next = state.apply(transaction);
        }),
      ).toBe(true);

      const blocks = Array.from({ length: next.doc.childCount }, (_, index) =>
        next.doc.child(index),
      );
      expect(blocks.map((block) => block.type.name)).toEqual([
        'paragraph',
        'page_break',
        'paragraph',
      ]);
      expect(blocks[0]?.textContent).toBe(sample.before);
      expect(blocks[2]?.textContent).toBe(sample.after);
      expect(next.selection.$from.parent).toBe(blocks[2]);
      expect(next.selection.$from.parentOffset).toBe(0);
    },
  );

  it('inserts a manual page break before a paragraph without moving into its text', () => {
    const document = payloadToEditorDocument({ format: 'plain-text', text: 'abcdef' });
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: TextSelection.create(document, 1),
    });
    let next = state;

    insertManualPageBreak(state, (transaction) => {
      next = state.apply(transaction);
    });

    expect(
      Array.from({ length: next.doc.childCount }, (_, index) => next.doc.child(index).type.name),
    ).toEqual(['page_break', 'paragraph']);
    expect(next.doc.child(1).textContent).toBe('abcdef');
    expect(next.selection.$from.parent).toBe(next.doc.child(1));
    expect(next.selection.$from.parentOffset).toBe(0);
  });

  it('reports formatting unavailable when a manual page break owns selection', () => {
    const document = payloadToEditorDocument({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: createDefaultWriteParagraphStyle(),
          content: [{ type: 'text', text: 'before' }],
        },
        { type: 'page-break' },
        {
          type: 'paragraph',
          style: createDefaultWriteParagraphStyle(),
          content: [{ type: 'text', text: 'after' }],
        },
      ],
    });
    const breakPosition = document.child(0).nodeSize;
    const state = EditorState.create({
      schema: writeSchema,
      doc: document,
      selection: NodeSelection.create(document, breakPosition),
    });

    expect(editorContext(state)).toMatchObject({
      canFormat: false,
      canClear: true,
      style: {
        fontFamily: null,
        fontSize: null,
        alignment: null,
        bold: false,
        italic: false,
        underline: false,
      },
    });
  });
});
