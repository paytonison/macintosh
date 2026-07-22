export type PixelIconName =
  'computer' | 'disk' | 'trash' | 'trash-open' | 'folder' | 'document' | 'system-folder';

interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: 'black' | 'white';
}

const drawings: Record<PixelIconName, PixelRect[]> = {
  computer: [
    { x: 5, y: 3, width: 22, height: 20 },
    { x: 7, y: 5, width: 18, height: 14, color: 'white' },
    { x: 9, y: 7, width: 14, height: 10 },
    { x: 10, y: 8, width: 12, height: 8, color: 'white' },
    { x: 4, y: 23, width: 24, height: 6 },
    { x: 6, y: 24, width: 12, height: 2, color: 'white' },
    { x: 22, y: 25, width: 3, height: 2, color: 'white' },
    { x: 2, y: 29, width: 28, height: 2 },
  ],
  disk: [
    { x: 5, y: 2, width: 22, height: 28 },
    { x: 7, y: 4, width: 18, height: 24, color: 'white' },
    { x: 8, y: 5, width: 16, height: 10 },
    { x: 10, y: 7, width: 12, height: 6, color: 'white' },
    { x: 10, y: 8, width: 8, height: 1 },
    { x: 10, y: 11, width: 10, height: 1 },
    { x: 9, y: 18, width: 14, height: 9 },
    { x: 11, y: 20, width: 10, height: 5, color: 'white' },
    { x: 21, y: 3, width: 4, height: 5, color: 'white' },
    { x: 23, y: 2, width: 4, height: 4 },
  ],
  trash: [
    { x: 7, y: 7, width: 18, height: 2 },
    { x: 10, y: 4, width: 12, height: 2 },
    { x: 6, y: 10, width: 20, height: 3 },
    { x: 8, y: 13, width: 2, height: 15 },
    { x: 22, y: 13, width: 2, height: 15 },
    { x: 10, y: 27, width: 12, height: 2 },
    { x: 11, y: 14, width: 2, height: 12 },
    { x: 15, y: 14, width: 2, height: 12 },
    { x: 19, y: 14, width: 2, height: 12 },
    { x: 10, y: 16, width: 12, height: 2, color: 'white' },
    { x: 10, y: 22, width: 12, height: 2, color: 'white' },
  ],
  'trash-open': [
    { x: 4, y: 3, width: 18, height: 2 },
    { x: 7, y: 1, width: 10, height: 2 },
    { x: 8, y: 9, width: 18, height: 3 },
    { x: 10, y: 12, width: 2, height: 16 },
    { x: 24, y: 12, width: 2, height: 16 },
    { x: 12, y: 27, width: 12, height: 2 },
    { x: 13, y: 13, width: 2, height: 12 },
    { x: 17, y: 13, width: 2, height: 12 },
    { x: 21, y: 13, width: 2, height: 12 },
    { x: 12, y: 16, width: 12, height: 2, color: 'white' },
    { x: 12, y: 22, width: 12, height: 2, color: 'white' },
  ],
  folder: [
    { x: 3, y: 8, width: 12, height: 4 },
    { x: 3, y: 11, width: 26, height: 18 },
    { x: 5, y: 13, width: 22, height: 14, color: 'white' },
    { x: 5, y: 24, width: 22, height: 3 },
    { x: 7, y: 25, width: 2, height: 1, color: 'white' },
    { x: 11, y: 25, width: 2, height: 1, color: 'white' },
    { x: 15, y: 25, width: 2, height: 1, color: 'white' },
    { x: 19, y: 25, width: 2, height: 1, color: 'white' },
    { x: 23, y: 25, width: 2, height: 1, color: 'white' },
  ],
  'system-folder': [
    { x: 3, y: 8, width: 12, height: 4 },
    { x: 3, y: 11, width: 26, height: 18 },
    { x: 5, y: 13, width: 22, height: 14, color: 'white' },
    { x: 14, y: 15, width: 4, height: 10 },
    { x: 11, y: 18, width: 10, height: 4 },
    { x: 15, y: 16, width: 2, height: 8, color: 'white' },
    { x: 12, y: 19, width: 8, height: 2, color: 'white' },
  ],
  document: [
    { x: 7, y: 3, width: 18, height: 27 },
    { x: 9, y: 5, width: 12, height: 23, color: 'white' },
    { x: 21, y: 5, width: 2, height: 6, color: 'white' },
    { x: 21, y: 9, width: 4, height: 2 },
    { x: 11, y: 14, width: 10, height: 1 },
    { x: 11, y: 18, width: 10, height: 1 },
    { x: 11, y: 22, width: 8, height: 1 },
  ],
};

interface PixelIconProps {
  name: PixelIconName;
  size?: number;
  className?: string;
}

export function PixelIcon({ name, size = 48, className = '' }: PixelIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`pixel-icon ${className}`}
      height={size}
      shapeRendering="crispEdges"
      viewBox="0 0 32 32"
      width={size}
    >
      {drawings[name].map((rect, index) => (
        <rect
          key={`${name}-${index}`}
          fill={rect.color === 'white' ? '#fff' : '#000'}
          height={rect.height}
          width={rect.width}
          x={rect.x}
          y={rect.y}
        />
      ))}
    </svg>
  );
}
