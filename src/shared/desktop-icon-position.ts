const INITIAL_DESKTOP_ICON_MINIMUM = { x: 24, y: 36 };
const INITIAL_DESKTOP_ICON_SPAN = { x: 695, y: 425 };

const hashNodeId = (nodeId: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash = Math.imul(hash ^ nodeId.charCodeAt(index), 0x01000193);
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
};

export const initialDesktopIconPosition = (nodeId: string): { x: number; y: number } => ({
  x:
    INITIAL_DESKTOP_ICON_MINIMUM.x + (hashNodeId(nodeId, 0x811c9dc5) % INITIAL_DESKTOP_ICON_SPAN.x),
  y:
    INITIAL_DESKTOP_ICON_MINIMUM.y + (hashNodeId(nodeId, 0x9e3779b9) % INITIAL_DESKTOP_ICON_SPAN.y),
});
