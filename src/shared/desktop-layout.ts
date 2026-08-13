export const DESKTOP_ICON_WIDTH = 82;
export const DESKTOP_ICON_HEIGHT = 78;

export const DEFAULT_DESKTOP_SURFACE_SIZE = {
  width: 1152,
  height: 746,
} as const;

const DESKTOP_CLEANUP_DISK_Y = 7;
const DESKTOP_CLEANUP_FIRST_ITEM_Y = 77;
const DESKTOP_CLEANUP_ROW_STEP = 83;
const DESKTOP_CLEANUP_TRASH_BOTTOM_INSET = 15;

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

interface LayoutPoint {
  x: number;
  y: number;
}

export const desktopCleanupColumnX = (surface: DesktopSurfaceSize): number =>
  Math.max(0, Math.round(surface.width) - DESKTOP_ICON_WIDTH);

export const desktopCleanupSpecialIconPositions = (
  surface: DesktopSurfaceSize,
): { diskPosition: LayoutPoint; trashPosition: LayoutPoint } => {
  const cleanupColumnX = desktopCleanupColumnX(surface);
  const maximumY = Math.max(0, Math.round(surface.height) - DESKTOP_ICON_HEIGHT);

  return {
    diskPosition: {
      x: cleanupColumnX,
      y: Math.min(DESKTOP_CLEANUP_DISK_Y, maximumY),
    },
    trashPosition: {
      x: cleanupColumnX,
      y: Math.max(0, maximumY - DESKTOP_CLEANUP_TRASH_BOTTOM_INSET),
    },
  };
};

export const desktopCleanupItemPosition = (
  surface: DesktopSurfaceSize,
  index: number,
): LayoutPoint => ({
  x: desktopCleanupColumnX(surface),
  y: DESKTOP_CLEANUP_FIRST_ITEM_Y + Math.max(0, Math.round(index)) * DESKTOP_CLEANUP_ROW_STEP,
});

export const desktopCleanupFirstItemY = DESKTOP_CLEANUP_FIRST_ITEM_Y;
export const desktopCleanupRowStep = DESKTOP_CLEANUP_ROW_STEP;
