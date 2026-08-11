import test from "node:test";
import assert from "node:assert/strict";
import {
  TAB_ORDER,
  canStartTabPager,
  createTabPagerGesture,
  finishTabPagerGesture,
  moveTabPagerGesture
} from "../src/tabPager.js";

test("pager starts only for a single non-interactive touch inside an active tab surface", () => {
  const allowed = {
    blocked: false,
    currentIndex: 1,
    interactive: false,
    startX: 120,
    touchCount: 1,
    viewportWidth: 390
  };

  assert.equal(canStartTabPager(allowed), true);
  assert.equal(canStartTabPager({ ...allowed, blocked: true }), false);
  assert.equal(canStartTabPager({ ...allowed, interactive: true }), false);
  assert.equal(canStartTabPager({ ...allowed, touchCount: 2 }), false);
  assert.equal(canStartTabPager({ ...allowed, currentIndex: -1 }), false);
  assert.equal(canStartTabPager({ ...allowed, startX: 10 }), false);
  assert.equal(canStartTabPager({ ...allowed, startX: 380 }), false);
});

test("pager locks to horizontal intent and follows the finger one to one", () => {
  const start = createTabPagerGesture({ currentIndex: 1, startX: 300, startY: 240, width: 390 });
  const moved = moveTabPagerGesture(start, { x: 190, y: 248 });

  assert.equal(moved.phase, "dragging");
  assert.equal(moved.deltaX, -110);
  assert.equal(moved.visualDeltaX, -110);
  assert.equal(moved.neighborIndex, 2);
  assert.equal(TAB_ORDER[moved.neighborIndex], "plan");
});

test("pager yields to vertical scrolling before horizontal intent is locked", () => {
  const start = createTabPagerGesture({ currentIndex: 1, startX: 180, startY: 200, width: 390 });
  const moved = moveTabPagerGesture(start, { x: 187, y: 250 });

  assert.equal(moved.phase, "cancelled");
  assert.deepEqual(finishTabPagerGesture(moved), { action: "cancel" });
});

test("pager resists missing neighbors at both ends", () => {
  const first = moveTabPagerGesture(
    createTabPagerGesture({ currentIndex: 0, startX: 100, startY: 100, width: 390 }),
    { x: 200, y: 102 }
  );
  const last = moveTabPagerGesture(
    createTabPagerGesture({ currentIndex: TAB_ORDER.length - 1, startX: 250, startY: 100, width: 390 }),
    { x: 150, y: 102 }
  );

  assert.equal(first.neighborIndex, null);
  assert.equal(first.visualDeltaX, 18);
  assert.equal(last.neighborIndex, null);
  assert.equal(last.visualDeltaX, -18);
  assert.deepEqual(finishTabPagerGesture(first), { action: "snapback", currentIndex: 0 });
  assert.deepEqual(finishTabPagerGesture(last), { action: "snapback", currentIndex: 3 });
});

test("pager commits past its responsive threshold and otherwise snaps back", () => {
  const start = createTabPagerGesture({ currentIndex: 1, startX: 300, startY: 200, width: 390 });
  const committed = moveTabPagerGesture(start, { x: 205, y: 204 });
  const returned = moveTabPagerGesture(start, { x: 245, y: 204 });

  assert.deepEqual(finishTabPagerGesture(committed), { action: "commit", currentIndex: 1, nextIndex: 2 });
  assert.deepEqual(finishTabPagerGesture(returned), { action: "snapback", currentIndex: 1 });
});
