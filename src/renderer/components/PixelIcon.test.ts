import { createHash } from 'node:crypto';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DesktopIcon } from './DesktopIcon';
import { PixelIcon, type PixelIconName } from './PixelIcon';

type Pixel = ' ' | '#' | '.';

interface RenderedBitmap {
  bitmap: string;
  bounds: string | undefined;
  fills: string[];
  markup: string;
  signature: string;
  silhouette: string;
}

const renderBitmap = (name: PixelIconName): RenderedBitmap => {
  const markup = renderToStaticMarkup(createElement(PixelIcon, { name, size: 32 }));
  const pixels = Array.from({ length: 32 }, () => Array<Pixel>(32).fill(' '));
  const fills = new Set<string>();
  let bounds: string | undefined;

  for (const rect of markup.matchAll(/<rect ([^>]*)><\/rect>/g)) {
    const attributes = Object.fromEntries(
      [...rect[1].matchAll(/([a-z-]+)="([^"]+)"/g)].map((attribute) => [
        attribute[1],
        attribute[2],
      ]),
    );
    if (attributes['data-trash-drop-bounds'] === 'true') {
      bounds = `${attributes.x},${attributes.y},${attributes.width},${attributes.height}`;
      continue;
    }

    const fill = attributes.fill;
    const width = Number(attributes.width);
    const x = Number(attributes.x);
    const y = Number(attributes.y);
    if ((fill !== '#000' && fill !== '#fff') || !Number.isInteger(width)) {
      throw new Error(`Invalid ${name} pixel run: ${rect[0]}`);
    }
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x + width > 32 ||
      y >= 32
    ) {
      throw new Error(`Out-of-bounds ${name} pixel run: ${rect[0]}`);
    }

    fills.add(fill);
    for (let column = x; column < x + width; column += 1) {
      if (pixels[y][column] !== ' ') {
        throw new Error(`Overlapping ${name} pixel run at ${column},${y}.`);
      }
      pixels[y][column] = fill === '#000' ? '#' : '.';
    }
  }

  const bitmap = pixels.map((row) => row.join('')).join('\n');
  return {
    bitmap,
    bounds,
    fills: [...fills].sort(),
    markup,
    signature: createHash('sha256').update(bitmap).digest('hex'),
    silhouette: bitmap.replace(/[.#]/g, '#'),
  };
};

describe('Trash pixel icons', () => {
  const empty = renderBitmap('trash');
  const full = renderBitmap('trash-full');

  it('keeps deterministic and distinct empty and full artwork', () => {
    expect(empty.signature).toBe(
      '4e3ce3481e2054adfc72426044d6ffb614b6cc6ff04c83ac703fcca2ccd84241',
    );
    expect(full.signature).toBe('7bebe9cf1bd2d304cef6423575c85128f17344f99314e5562b4d612003776773');
    expect(full.bitmap).not.toBe(empty.bitmap);
  });

  it('uses one native-size black-and-white silhouette and drop region for both states', () => {
    expect(empty.markup).toContain('height="32"');
    expect(empty.markup).toContain('viewBox="0 0 32 32"');
    expect(empty.markup).toContain('width="32"');
    expect(empty.fills).toEqual(['#000', '#fff']);
    expect(full.fills).toEqual(['#000', '#fff']);
    expect(full.silhouette).toBe(empty.silhouette);
    expect(empty.bounds).toBe('2,1,28,28');
    expect(full.bounds).toBe(empty.bounds);
  });

  it('retains the selected, dragging, and drop-target interaction hooks', () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopIcon, {
        dragging: true,
        icon: 'trash-full',
        id: 'trash',
        interactionCancelToken: 0,
        label: 'Trash',
        onDrag: () => undefined,
        onDragCancel: () => undefined,
        onDragEnd: () => undefined,
        onDragStart: () => undefined,
        onInteractionChange: () => undefined,
        onOpen: () => undefined,
        onSelect: () => undefined,
        position: { x: 0, y: 0 },
        selected: true,
        validDropTarget: true,
      }),
    );

    expect(markup).toContain('class="desktop-icon is-selected is-dragging is-drop-target"');
    expect(markup).toContain('data-pixel-icon="trash-full"');
    expect(markup).toContain('height="32"');
    expect(markup).toContain('width="32"');
    expect(markup).toContain('data-trash-drop-tolerance="4"');
  });
});
