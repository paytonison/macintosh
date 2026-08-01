import { describe, expect, it } from 'vitest';

import {
  WRITE_ALIGNMENTS,
  WRITE_FONT_FAMILIES,
  WRITE_FONT_SIZES,
  WRITE_LINE_SPACINGS,
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
  });

  it('promotes plain text without changing its line boundaries or whitespace', () => {
    const payload = promotePlainTextPayload({
      format: 'plain-text',
      text: '  first\n\nlast  ',
    });

    expect(payload.blocks).toHaveLength(3);
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
