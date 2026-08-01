import { describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';

import { createDefaultWriteParagraphStyle, MAX_DOCUMENT_TEXT } from '../../shared/write';
import { editorContext } from '../components/WriteEditor';
import {
  editorDocumentToPayload,
  insertManualPageBreak,
  payloadToEditorDocument,
  projectBlockHeightsToPages,
  setParagraphAttribute,
  writeSchema,
} from './write-document';

describe('Write editor projection', () => {
  it('round-trips plain text without promoting it', () => {
    const payload = { format: 'plain-text' as const, text: 'First\n\nThird\tcolumn' };
    const document = payloadToEditorDocument(payload);

    expect(editorDocumentToPayload(document, false)).toEqual(payload);
    expect(document.child(2).child(1).type).toBe(writeSchema.nodes.tab);
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

  it('round-trips rich paragraphs, marks, tabs, styles, and manual page breaks', () => {
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

    expect(editorDocumentToPayload(payloadToEditorDocument(payload), true)).toEqual(payload);
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

    expect(editorContext(state).canFormat).toBe(false);
  });
});
