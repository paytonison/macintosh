import { ditherPixelSilhouette, rasterizeOneBitBitmap, type PixelRun } from '../model/pixel-bitmap';

export type PixelIconName =
  'computer' | 'disk' | 'trash' | 'trash-full' | 'folder' | 'document' | 'system-folder';

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

const shadowDrawings = Object.fromEntries(
  Object.entries(drawings).map(([name, runs]) => [name, ditherPixelSilhouette(runs)]),
) as Record<PixelIconName, PixelRun[]>;

export type PixelIconVariant = 'artwork' | 'shadow';

interface PixelIconProps {
  name: PixelIconName;
  size?: number;
  className?: string;
  variant?: PixelIconVariant;
}

export function PixelIcon({
  name,
  size = 48,
  className = '',
  variant = 'artwork',
}: PixelIconProps) {
  const drawing = variant === 'shadow' ? shadowDrawings[name] : drawings[name];
  return (
    <svg
      aria-hidden="true"
      className={`pixel-icon ${className}`}
      data-pixel-icon={name}
      data-pixel-icon-variant={variant}
      height={size}
      shapeRendering="crispEdges"
      viewBox="0 0 32 32"
      width={size}
    >
      {drawing.map((run, index) => (
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
