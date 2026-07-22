export type PixelIconName =
  'computer' | 'disk' | 'trash' | 'trash-full' | 'folder' | 'document' | 'system-folder';

interface PixelBitmap {
  x: number;
  y: number;
  rows: string[];
}

interface PixelRun {
  x: number;
  y: number;
  width: number;
  color: 'black' | 'gray' | 'white';
}

const rasterize = ({ x, y, rows }: PixelBitmap): PixelRun[] =>
  rows.flatMap((row, rowIndex) => {
    const runs: PixelRun[] = [];
    let start = 0;
    while (start < row.length) {
      const pixel = row[start];
      if (pixel !== '#' && pixel !== '.' && pixel !== 'g') {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < row.length && row[end] === pixel) end += 1;
      runs.push({
        x: x + start,
        y: y + rowIndex,
        width: end - start,
        color: pixel === '#' ? 'black' : pixel === 'g' ? 'gray' : 'white',
      });
      start = end;
    }
    return runs;
  });

const drawings: Record<PixelIconName, PixelRun[]> = {
  computer: rasterize({
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
  disk: rasterize({
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
  trash: rasterize({
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
  'trash-full': rasterize({
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
  folder: rasterize({
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
  'system-folder': rasterize({
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
  document: rasterize({
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
      {drawings[name].map((run, index) => (
        <rect
          fill={run.color === 'white' ? '#fff' : run.color === 'gray' ? '#aaa' : '#000'}
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
