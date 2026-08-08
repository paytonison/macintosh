import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import importedMacintoshCss from '../styles/macintosh.css?raw';
import { DesktopIcon } from './DesktopIcon';
import { PixelIcon, type PixelIconName } from './PixelIcon';

type Pixel = ' ' | '#' | '.';

interface RenderedBitmap {
  bitmap: string;
  bounds: string | undefined;
  fills: string[];
  markup: string;
  paintedBounds: { bottom: number; left: number; right: number; top: number };
  signature: string;
  silhouette: string;
}

const macintoshCss =
  importedMacintoshCss ||
  readFileSync(new URL('../styles/macintosh.css', import.meta.url), { encoding: 'utf8' });

const cssRules = [...macintoshCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selectorList, declarations]) => ({
    selectors: selectorList.split(',').map((selector) => selector.trim()),
    declarations,
  }),
);

const declarationsFor = (selector: string): string => {
  const rule = cssRules.find((candidate) => candidate.selectors.includes(selector));
  expect(rule, `Missing stylesheet rule for ${selector}`).toBeDefined();
  return rule?.declarations ?? '';
};

const backgroundFor = (selector: string): string => {
  const rule = cssRules.find(
    (candidate) =>
      candidate.selectors.includes(selector) && /background\s*:/.test(candidate.declarations),
  );
  expect(rule, `Missing background rule for ${selector}`).toBeDefined();
  const declaration = rule?.declarations.match(/background:\s*([^;]+);/)?.[1]?.trim();
  expect(declaration, `Missing background declaration for ${selector}`).toBeDefined();
  return declaration ?? '';
};

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
  const paintedPixels = pixels.flatMap((row, y) =>
    row.flatMap((pixel, x) => (pixel === ' ' ? [] : [{ x, y }])),
  );
  return {
    bitmap,
    bounds,
    fills: [...fills].sort(),
    markup,
    paintedBounds: {
      bottom: Math.max(...paintedPixels.map(({ y }) => y)),
      left: Math.min(...paintedPixels.map(({ x }) => x)),
      right: Math.max(...paintedPixels.map(({ x }) => x)),
      top: Math.min(...paintedPixels.map(({ y }) => y)),
    },
    signature: createHash('sha256').update(bitmap).digest('hex'),
    silhouette: bitmap.replace(/[.#]/g, '#'),
  };
};

describe('Folder pixel icons', () => {
  const folder = renderBitmap('folder');
  const systemFolder = renderBitmap('system-folder');

  it('keeps deterministic ordinary and System Folder artwork', () => {
    expect(folder.signature).toBe(
      '3e6f7e5a1cf216a83d03302be25bdb08bfcf38e860513e98ac5a32757493ac82',
    );
    expect(systemFolder.signature).toBe(
      'be49392a36dc0a76bc927d94dc551c85300f0c541b1b8171a3c1e93ce9e510aa',
    );
    expect(systemFolder.bitmap).not.toBe(folder.bitmap);
  });

  it('leaves unused canvas transparent without removing intentional white artwork', () => {
    for (const icon of [folder, systemFolder]) {
      expect(icon.fills).toEqual(['#000', '#fff']);
      expect(icon.paintedBounds).toEqual({ bottom: 24, left: 2, right: 28, top: 7 });
      expect(icon.markup).not.toContain('<rect fill="#fff" height="32"');
    }
  });
});

describe('Icon surface backgrounds', () => {
  it('keeps free-placement icon tiles transparent and backs only their labels', () => {
    expect(backgroundFor('.desktop-icon')).toBe('transparent');
    expect(backgroundFor('.finder-item')).toBe('transparent');
    expect(backgroundFor('.finder-item span')).toBe('#fff');
    expect(backgroundFor('.finder-list-row')).toBe('#fff');
    expect(declarationsFor('.pixel-icon')).not.toMatch(/background(?:-color)?\s*:/);
  });

  it('retains bounded selected and drop-target feedback', () => {
    expect(backgroundFor('.desktop-icon.is-selected .desktop-icon-glyph')).toBe('#000');
    expect(backgroundFor('.finder-item.is-selected .pixel-icon')).toBe('#000');
    expect(declarationsFor('.finder-item.is-selected .pixel-icon')).toContain('filter: invert(1)');
    expect(backgroundFor('.finder-item.is-file-drop-target .pixel-icon')).toBe('#000');
    expect(declarationsFor('.finder-item.is-file-drop-target .pixel-icon')).toContain(
      'filter: invert(1)',
    );
  });
});

describe('System Disk ejection feedback', () => {
  it('exposes an inverted flash phase without assigning motion to the desktop icon', () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopIcon, {
        ejecting: true,
        ejectionFlashPhase: { appearance: 'inverted', flashNumber: 1 },
        icon: 'disk',
        id: 'system-disk',
        interactionCancelToken: 0,
        label: 'System Disk',
        onDrag: () => undefined,
        onDragCancel: () => undefined,
        onDragEnd: () => undefined,
        onDragStart: () => undefined,
        onInteractionChange: () => undefined,
        onOpen: () => undefined,
        onSelect: () => undefined,
        position: { x: 12, y: 34 },
        selected: true,
      }),
    );

    expect(markup).toContain('class="desktop-icon is-selected is-ejecting is-ejection-inverted"');
    expect(markup).toContain('data-ejection-flash-appearance="inverted"');
    expect(markup).toContain('data-ejection-flash-number="1"');
    expect(declarationsFor('.desktop-icon.is-ejecting')).not.toMatch(
      /animation|transform|visibility/,
    );
    expect(backgroundFor('.desktop-icon.is-ejecting .desktop-icon-glyph')).toBe('transparent');
    expect(declarationsFor('.desktop-icon.is-ejecting .desktop-icon-glyph .pixel-icon')).toContain(
      'filter: none',
    );
    expect(
      backgroundFor('.desktop-icon.is-ejecting.is-ejection-inverted .desktop-icon-glyph'),
    ).toBe('#000');
    expect(
      declarationsFor(
        '.desktop-icon.is-ejecting.is-ejection-inverted .desktop-icon-glyph .pixel-icon',
      ),
    ).toContain('filter: invert(1)');
  });
});

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
