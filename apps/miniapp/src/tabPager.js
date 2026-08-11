export const TAB_ORDER = ["dashboard", "history", "plan", "settings"];

const INTENT_DISTANCE = 8;
const HORIZONTAL_DOMINANCE = 1.15;
const EDGE_GUTTER = 16;
const EDGE_RESISTANCE = 0.18;

export function canStartTabPager({ blocked, currentIndex, interactive, startX, touchCount, viewportWidth }) {
  return !blocked
    && !interactive
    && touchCount === 1
    && currentIndex >= 0
    && startX >= EDGE_GUTTER
    && startX <= viewportWidth - EDGE_GUTTER;
}

export function createTabPagerGesture({ currentIndex, startX, startY, width }) {
  return {
    phase: "pending",
    currentIndex,
    startX,
    startY,
    width,
    deltaX: 0,
    visualDeltaX: 0,
    neighborIndex: null
  };
}

export function moveTabPagerGesture(gesture, { x, y }) {
  if (!gesture || gesture.phase === "cancelled") return gesture;
  const deltaX = x - gesture.startX;
  const deltaY = y - gesture.startY;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  if (gesture.phase === "pending") {
    if (absX < INTENT_DISTANCE && absY < INTENT_DISTANCE) return gesture;
    if (absY >= absX * HORIZONTAL_DOMINANCE) return { ...gesture, phase: "cancelled" };
    if (absX < absY * HORIZONTAL_DOMINANCE) return gesture;
  }

  const direction = deltaX < 0 ? 1 : -1;
  const candidateIndex = gesture.currentIndex + direction;
  const neighborIndex = candidateIndex >= 0 && candidateIndex < TAB_ORDER.length ? candidateIndex : null;
  return {
    ...gesture,
    phase: "dragging",
    deltaX,
    visualDeltaX: neighborIndex == null ? deltaX * EDGE_RESISTANCE : deltaX,
    neighborIndex
  };
}

export function finishTabPagerGesture(gesture) {
  if (!gesture || gesture.phase === "cancelled" || gesture.phase === "pending") return { action: "cancel" };
  if (gesture.neighborIndex == null) return { action: "snapback", currentIndex: gesture.currentIndex };
  const threshold = Math.min(96, gesture.width * 0.22);
  if (Math.abs(gesture.deltaX) < threshold) return { action: "snapback", currentIndex: gesture.currentIndex };
  return { action: "commit", currentIndex: gesture.currentIndex, nextIndex: gesture.neighborIndex };
}
