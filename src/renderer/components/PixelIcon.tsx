import { rasterizeOneBitBitmap, type PixelRun } from '../model/pixel-bitmap';
import { TRASH_DROP_TOLERANCE_CSS_PX } from '../model/desktop-drop-target';

export type PixelIconName =
  'computer' | 'disk' | 'trash' | 'trash-full' | 'folder' | 'document' | 'system-folder';

// Stable painted-area union for the empty and full Trash drawings. Keeping one
// box prevents the drop target from changing when hover swaps the bitmap.
const trashArtworkBounds = { x: 3, y: 3, width: 22, height: 25 } as const;

const drawings: Record<PixelIconName, PixelRun[]> = {
  computer: rasterizeOneBitBitmap({
    x: 3,
    y: 2,
    rows: [
      '   ##################   ',
      '  #..................#  ',
      ' #....................# ',
      ' #..################..# ',
      ' #..#..............#..# ',
      ' #..#..............#..# ',
      ' #..#..............#..# ',
      ' #..#..............#..# ',
      ' #..#..............#..# ',
      ' #..#..............#..# ',
      ' #..#.....#........#..# ',
      ' #..#......####....#..# ',
      ' #..#..............#..# ',
      ' #..################..# ',
      ' #....................# ',
      ' ###################### ',
      '   #................#   ',
      '   ##################   ',
      '      ###......###      ',
      '      #..........#      ',
      '    ################    ',
      '   #................#   ',
      '  ####################  ',
    ],
  }),
  disk: rasterizeOneBitBitmap({
    x: 5,
    y: 2,
    rows: [
      '####################  ',
      '#..................## ',
      '#..##############...# ',
      '#..#............#...# ',
      '#..#..........###...# ',
      '#..#..........#.#...# ',
      '#..#..........###...# ',
      '#..#............#...# ',
      '#..##############...# ',
      '#....................#',
      '#....................#',
      '#....############....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....#..........#....#',
      '#....############....#',
      '#....................#',
      '######################',
    ],
  }),
  trash: rasterizeOneBitBitmap({
    x: 0,
    y: 3,
    rows: [
      '            #####             ',
      '      ######ggg######         ',
      '    ##gggggggggggggggg##      ',
      '   ######################     ',
      '     ##gggggggggggggg##       ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##g#ggg#ggg#ggg#g##      ',
      '     ##gggggggggggggg##       ',
      '      ################        ',
    ],
  }),
  'trash-full': rasterizeOneBitBitmap({
    x: 0,
    y: 3,
    rows: [
      '            #####             ',
      '      ######ggg######         ',
      '    ##gggggggggggggggg##      ',
      '   ######################     ',
      '     ##gggggggggggggg##       ',
      '     ##g#gggggg#ggg###        ',
      '    ###g#gggggg#ggg####       ',
      '   ##gg#gg#gggg#gg#g###       ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '   #gg#gggg#gggg#ggg#gg##     ',
      '    #gg#ggg#gggg#ggggg##      ',
      '     ##gg#gggggg#ggg#g##      ',
      '      ##g#gggggg#ggg###       ',
      '       #ggggggggggggg#        ',
      '       ###############        ',
    ],
  }),
  folder: rasterizeOneBitBitmap({
    x: 2,
    y: 7,
    rows: [
      '   ########                 ',
      '  #........#                ',
      '  #........############     ',
      ' ########################   ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '#........................#  ',
      '##########################  ',
      '  #.#.#.#.#.#.#.#.#.#.#.#  ',
      '   ######################## ',
    ],
  }),
  'system-folder': rasterizeOneBitBitmap({
    x: 2,
    y: 7,
    rows: [
      '   ########                 ',
      '  #........#                ',
      '  #........############     ',
      ' ########################   ',
      '#........................#  ',
      '#.........########.......#  ',
      '#.........#......#.......#  ',
      '#.........#.####.#.......#  ',
      '#.........#.#..#.#.......#  ',
      '#.........#.####.#.......#  ',
      '#.........#......#.......#  ',
      '#.........#.####.#.......#  ',
      '#.........#......#.......#  ',
      '#.........########.......#  ',
      '#........................#  ',
      '##########################  ',
      '  #.#.#.#.#.#.#.#.#.#.#.#  ',
      '   ######################## ',
    ],
  }),
  document: rasterizeOneBitBitmap({
    x: 7,
    y: 2,
    rows: [
      '##############     ',
      '#............##    ',
      '#.............##   ',
      '#..............##  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#..##########...#  ',
      '#...............#  ',
      '#..##########...#  ',
      '#...............#  ',
      '#..##########...#  ',
      '#...............#  ',
      '#..########.....#  ',
      '#...............#  ',
      '#..##########...#  ',
      '#...............#  ',
      '#..######.......#  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#...............#  ',
      '#################  ',
    ],
  }),
};

interface PixelIconProps {
  name: PixelIconName;
  size?: number;
  className?: string;
}

export function PixelIcon({ name, size = 48, className = '' }: PixelIconProps) {
  const isTrash = name === 'trash' || name === 'trash-full';

  return (
    <svg
      aria-hidden="true"
      className={`pixel-icon ${className}`}
      data-pixel-icon={name}
      height={size}
      shapeRendering="crispEdges"
      viewBox="0 0 32 32"
      width={size}
    >
      {isTrash ? (
        <rect
          data-trash-drop-bounds="true"
          data-trash-drop-tolerance={TRASH_DROP_TOLERANCE_CSS_PX}
          fill="none"
          height={trashArtworkBounds.height}
          pointerEvents="none"
          width={trashArtworkBounds.width}
          x={trashArtworkBounds.x}
          y={trashArtworkBounds.y}
        />
      ) : null}
      {drawings[name].map((run, index) => (
        <rect
          fill={run.color === 'white' ? '#fff' : '#000'}
          height="1"
          key={`${name}-${index}`}
          width={run.width}
          x={run.x}
          y={run.y}
        />
      ))}
    </svg>
  );
}
