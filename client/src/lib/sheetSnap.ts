// A bottom sheet that rests at three heights (collapsed, half, expanded), like the sheet in any maps app. Pure helpers, so the
// behaviour can be tested; MapPage does the pointer handling.

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const HANDLE = 28;      // the drag handle row
const STRIP_PAD = 12;   // breathing room under the friends strip when collapsed
const SEARCH_ROOM = 130; // the search bar and filter chips stay visible above an expanded sheet

/** [collapsed, half, expanded] heights in px, always strictly increasing. Collapsed is exactly the handle plus the friends strip. */
export function sheetHeights(mapHeight: number, stripHeight: number): [number, number, number] {
  const peek = Math.max(100, Math.round(HANDLE + stripHeight + STRIP_PAD));
  const full = Math.max(peek + 120, Math.min(Math.round(mapHeight * 0.86), mapHeight - SEARCH_ROOM));
  const half = clamp(Math.round(mapHeight * 0.46), peek + 60, full - 60);
  return [peek, half, full];
}

/** The sheet's height while a finger is dragging it: dragging up (negative dy) grows it, kept between collapsed and expanded. */
export const dragHeight = (heights: number[], startHeight: number, dy: number): number =>
  clamp(startHeight - dy, heights[0], heights[heights.length - 1]);

const FLICK = 0.5; // px per ms

/** Where the sheet settles when the finger lifts: the nearest position, or one position further in the direction of a quick flick. */
export function settleSnap(heights: number[], heightAtRelease: number, velocity: number): number {
  let nearest = 0;
  heights.forEach((h, i) => { if (Math.abs(h - heightAtRelease) < Math.abs(heights[nearest] - heightAtRelease)) nearest = i; });
  if (Math.abs(velocity) < FLICK) return nearest;
  return clamp(nearest + (velocity > 0 ? 1 : -1), 0, heights.length - 1);
}

/** A tap on the handle: open sheets collapse, a collapsed one opens to half. */
export const tapSnap = (current: number): number => (current === 0 ? 1 : 0);

/** Keyboard: one position up or down, never out of range. */
export const stepSnap = (current: number, dir: 1 | -1, max: number): number => clamp(current + dir, 0, max);
