import { describe, expect, it } from 'vitest';

import {
  WRITE_ALIGNMENTS,
  WRITE_FONT_FAMILY_MARK_TYPES,
  WRITE_FONT_FAMILIES,
  WRITE_FONT_SIZE_MARK_TYPES,
  WRITE_FONT_SIZES,
  WRITE_LINE_SPACINGS,
  WRITE_TEXT_MARK_TYPES,
  createDefaultWriteParagraphStyle,
  defaultWriteTabStops,
  documentPayloadText,
  promotePlainTextPayload,
  reconcileCommittedDocument,
  sanitizeDocumentPayload,
} from './write';

describe('Write document payloads', () => {
  it('keeps the supported formatting surface finite and explicit', () => {
    expect(WRITE_FONT_FAMILIES).toEqual(['serif', 'sans', 'mono']);
    expect(WRITE_FONT_SIZES).toEqual([9, 10, 12, 14, 18, 24]);
    expect(WRITE_ALIGNMENTS).toEqual(['left', 'center', 'right']);
    expect(WRITE_LINE_SPACINGS).toEqual([1, 1.5, 2]);
    expect(WRITE_TEXT_MARK_TYPES).toEqual(['bold', 'italic', 'underline']);
    expect(WRITE_FONT_FAMILY_MARK_TYPES).toEqual([
      'font-family-serif',
      'font-family-sans',
      'font-family-mono',
    ]);
    expect(WRITE_FONT_SIZE_MARK_TYPES).toEqual([
      'font-size-9',
      'font-size-10',
      'font-size-12',
      'font-size-14',
      'font-size-18',
      'font-size-24',
    ]);
  });

  it('keeps sans/12 implicit while upgrading a legacy serif paragraph without changing its face', () => {
    expect(createDefaultWriteParagraphStyle()).toMatchObject({
      fontFamily: 'sans',
      fontSize: 12,
      alignment: 'left',
      lineSpacing: 1,
    });

    const serif = sanitizeDocumentPayload({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: { ...createDefaultWriteParagraphStyle(), fontFamily: 'serif' },
          content: [{ type: 'text', text: 'Deliberately serif.' }],
        },
      ],
    });

    expect(serif).toMatchObject({
      format: 'write-v1',
      blocks: [
        {
          type: 'paragraph',
          style: { fontFamily: 'sans', fontSize: 12 },
          content: [
            {
              type: 'text',
              text: 'Deliberately serif.',
              marks: [{ type: 'font-family-serif' }],
            },
          ],
        },
      ],
    });

    expect(
      sanitizeDocumentPayload({
        format: 'write-v1',
        pagePreset: 'us-letter-1in',
        blocks: [
          {
            type: 'paragraph',
            style: createDefaultWriteParagraphStyle(),
            content: [{ type: 'text', text: 'Implicit Helvetica.' }],
          },
        ],
      }),
    ).toMatchObject({
      blocks: [{ content: [{ type: 'text', text: 'Implicit Helvetica.' }] }],
    });
  });

  it('preserves valid inline family and size marks while dropping invalid or duplicate values', () => {
    const payload = sanitizeDocumentPayload({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: {
            ...createDefaultWriteParagraphStyle(),
            fontFamily: 'serif',
            fontSize: 18,
          },
          content: [
            {
              type: 'text',
              text: 'Mixed',
              marks: [
                { type: 'font-family-mono' },
                { type: 'font-family-serif' },
                { type: 'font-size-24' },
                { type: 'font-size-18' },
                { type: 'sparkle' },
                { type: 'bold' },
              ],
            },
          ],
        },
      ],
    });

    expect(payload).toMatchObject({
      blocks: [
        {
          style: { fontFamily: 'sans', fontSize: 12 },
          content: [
            {
              text: 'Mixed',
              marks: [{ type: 'font-family-mono' }, { type: 'font-size-24' }, { type: 'bold' }],
            },
          ],
        },
      ],
    });
  });

  it('retains a legacy family and size fallback on an empty paragraph', () => {
    const payload = sanitizeDocumentPayload({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: {
            ...createDefaultWriteParagraphStyle(),
            fontFamily: 'serif',
            fontSize: 24,
          },
          content: [],
        },
      ],
    });

    expect(payload).toMatchObject({
      blocks: [{ style: { fontFamily: 'serif', fontSize: 24 }, content: [] }],
    });
  });

  it('promotes plain text without changing its line boundaries or whitespace', () => {
    const payload = promotePlainTextPayload({
      format: 'plain-text',
      text: '  first\n\nlast  ',
    });

    expect(payload.blocks).toHaveLength(3);
    expect(payload.blocks[0]).toMatchObject({ style: { fontFamily: 'sans', fontSize: 12 } });
    expect(documentPayloadText(payload)).toBe('  first\n\nlast  ');
  });

  it('promotes literal tabs to semantic ruler tabs without changing plain text', () => {
    const payload = promotePlainTextPayload({ format: 'plain-text', text: 'a\t\tb' });

    expect(payload.blocks[0]).toMatchObject({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a' },
        { type: 'tab' },
        { type: 'tab' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(documentPayloadText(payload)).toBe('a\t\tb');
  });

  it('keeps post-submit edits dirty when an older draft finishes saving', () => {
    const submitted = { format: 'plain-text' as const, text: 'submitted' };
    const edited = { format: 'plain-text' as const, text: 'edited while saving' };

    expect(reconcileCommittedDocument(edited, submitted)).toEqual({
      draft: edited,
      saved: submitted,
      dirty: true,
    });
    expect(reconcileCommittedDocument(submitted, submitted).dirty).toBe(false);
  });

  it('sanitizes rich formatting, bounds geometry, and drops unknown marks', () => {
    const payload = sanitizeDocumentPayload({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: {
            fontFamily: 'comic-sans',
            fontSize: 900,
            alignment: 'justify',
            leftIndent: 999,
            firstLineIndent: -999,
            rightIndent: 999,
            tabStops: [-4, 36.2, 36.4, 999],
            lineSpacing: 7,
          },
          content: [
            {
              type: 'text',
              text: 'Hello',
              marks: [{ type: 'bold' }, { type: 'sparkle' }, { type: 'bold' }],
            },
            { type: 'tab' },
          ],
        },
        { type: 'page-break' },
      ],
    });

    expect(payload).toEqual({
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: {
            ...createDefaultWriteParagraphStyle(),
            leftIndent: 432,
            firstLineIndent: -432,
            rightIndent: 0,
            tabStops: [36],
          },
          content: [{ type: 'text', text: 'Hello', marks: [{ type: 'bold' }] }, { type: 'tab' }],
        },
        { type: 'page-break' },
      ],
    });
  });

  it('uses half-inch default tab stops across the live text width', () => {
    expect(defaultWriteTabStops()).toEqual([
      36, 72, 108, 144, 180, 216, 252, 288, 324, 360, 396, 432,
    ]);
  });
});
