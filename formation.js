// formation.js
// Square and line formations for ONE stack. Pure logic, no graphics.
// A stack occupies a single grid square (see battleGrid.js). The formation
// is an abstract shape inside that square that decides:
//   1. how many units can attack toward a given side (the exposed units),
//   2. which units die first when the stack is hit from a given side,
//   3. how survivors re-form after an exchange.
//
// Sides use absolute compass directions: "N", "E", "S", "W".
// A "side" always means the side of the formation that faces that way.
// Example: a stack hit from the north is hit on its "N" side, and its
// counterattack comes from the units exposed on its "N" side.
//
// ---------------------------------------------------------------
// RULES IMPLEMENTED
// ---------------------------------------------------------------
// SQUARE (no weak side, so it ignores flank/rear bonuses):
//   - Build the largest ring that fits: side length s, ring size 4(s-1)
//     (s = 1 is a single unit). Examples: 8 units = 3x3 ring, 10 units =
//     3x3 ring + 2 in the middle, 12 units = 4x4 ring.
//   - Extra units stay in the middle as reserves and fill gaps after the
//     exchange. Each side exposes s units.
//   - Stacks of 2 or 3 units are a "ring" of 1 plus reserves (1 attacker
//     per side), since no larger ring fits.
//
// LINE (wide front, weak from the sides and rear):
//   - Two ranks. Front = ceil(N / 2), back = N - front (odd favors front).
//   - The front rank is on the side the stack is FACING. Ranks are
//     left-aligned. The back rank acts as the reserve for the front rank.
//   - Hit from the front: the whole front rank is exposed.
//     Hit from the rear: the back rank plus any front units with nobody
//     behind them are exposed (the whole width).
//     Hit from the side: only the two end units are exposed.
//
// EXPOSURE: a unit is exposed to a side if no other unit stands between it
// and that side in its lane (same column for N/S, same row for E/W).
//
// CASUALTIES: exposed units die first. If there are more casualties than
// exposed units, the next layer becomes exposed and dies, and so on. Units
// in the middle of a square die last. Within a layer, units die in screen
// order from left to right (x ascending, then y ascending).
//
// RE-FORM: after the whole attack and counterattack exchange, survivors
// are rebuilt into a fresh layout for the new count (reserves fill the
// front first). Units that moved up this way did not attack this exchange.
//
// A formation object is plain data and is never edited in place.

import { CONFIG } from "./config.js";

const F = CONFIG.FORMATIONS;
const DIRS = CONFIG.FACING.DIRECTIONS;

// Fail loudly if config asks for rules this file does not implement.
if (F.CASUALTY_ORDER !== "left_to_right") {
  throw new Error(`formation: unsupported CASUALTY_ORDER "${F.CASUALTY_ORDER}"`);
}
if (F.RESERVE_FILL_ORDER !== "front") {
  throw new Error(`formation: unsupported RESERVE_FILL_ORDER "${F.RESERVE_FILL_ORDER}"`);
}
if (F.LINE.ODD_FAVORS !== "front" && F.LINE.ODD_FAVORS !== "back") {
  throw new Error(`formation: unsupported LINE.ODD_FAVORS "${F.LINE.ODD_FAVORS}"`);
}

// ---------------------------------------------------------------
// Building layouts
// ---------------------------------------------------------------

function assertType(type) {
  if (!F.TYPES.includes(type)) throw new Error(`formation: unknown formation type "${type}"`);
}
function assertSide(side) {
  if (!DIRS.includes(side)) throw new Error(`formation: bad side/facing "${side}"`);
}
function assertCount(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`formation: count must be a non-negative integer, got ${count}`);
  }
}

function ringSize(s) {
  return s === 1 ? 1 : 4 * (s - 1);
}

// Largest ring side that fits in `count` units (count >= 1).
function squareSideFor(count) {
  let s = 1;
  while (ringSize(s + 1) <= count) s++;
  return s;
}

// Ring cells in a fixed order: top row left to right, right column going
// down, bottom row right to left, left column going up.
function squareSlots(count) {
  if (count === 0) return [];
  const s = squareSideFor(count);
  const cells = [];
  if (s === 1) {
    cells.push({ x: 0, y: 0 });
  } else {
    for (let x = 0; x < s; x++) cells.push({ x, y: 0 });
    for (let y = 1; y < s; y++) cells.push({ x: s - 1, y });
    for (let x = s - 2; x >= 0; x--) cells.push({ x, y: s - 1 });
    for (let y = s - 2; y >= 1; y--) cells.push({ x: 0, y });
  }
  return cells.map((c, index) => ({ index, x: c.x, y: c.y, filled: true, rank: "ring" }));
}

// Line cells: front rank first (left to right), then back rank.
function lineSlots(count, facing) {
  if (count === 0) return [];
  const front = F.LINE.ODD_FAVORS === "front" ? Math.ceil(count / 2) : Math.floor(count / 2);
  const back = count - front;
  const hasBack = back > 0;

  // Depth coordinate of each rank depends on where the front is.
  let frontDepth;
  let backDepth;
  if (facing === "N") {
    frontDepth = 0;
    backDepth = 1;
  } else if (facing === "W") {
    frontDepth = 0;
    backDepth = 1;
  } else {
    // S or E: front is on the high side.
    frontDepth = hasBack ? 1 : 0;
    backDepth = 0;
  }
  const vertical = facing === "N" || facing === "S"; // line runs along x

  const slots = [];
  let index = 0;
  for (let p = 0; p < front; p++) {
    slots.push({
      index: index++,
      x: vertical ? p : frontDepth,
      y: vertical ? frontDepth : p,
      filled: true,
      rank: "front",
    });
  }
  for (let p = 0; p < back; p++) {
    slots.push({
      index: index++,
      x: vertical ? p : backDepth,
      y: vertical ? backDepth : p,
      filled: true,
      rank: "back",
    });
  }
  return slots;
}

// Creates a formation for `count` units.
//   type    "square" | "line"
//   count   total units in the stack
//   facing  "N" | "E" | "S" | "W" (the line's front; a square ignores it)
export function createFormation(type = F.DEFAULT, count = 0, facing = "N") {
  assertType(type);
  assertCount(count);
  assertSide(facing);
  const slots = type === "square" ? squareSlots(count) : lineSlots(count, facing);
  return {
    type,
    facing,
    count,
    slots,
    reserve: count - slots.length, // units not on the grid layout (square middle)
  };
}

// ---------------------------------------------------------------
// Reading a formation
// ---------------------------------------------------------------

function filledSlots(formation) {
  return formation.slots.filter((s) => s.filled);
}

// Screen order, left to right, then top to bottom, then slot index.
function leftToRight(a, b) {
  return a.x - b.x || a.y - b.y || a.index - b.index;
}

// Which of these slots can be seen from `side` (nothing in front of them
// in their lane). Returned in left-to-right order.
function exposedFrom(slots, side) {
  const vertical = side === "N" || side === "S";
  const towardLow = side === "N" || side === "W";
  const best = new Map();
  for (const slot of slots) {
    const lane = vertical ? slot.x : slot.y;
    const depth = vertical ? slot.y : slot.x;
    const cur = best.get(lane);
    if (!cur || (towardLow ? depth < cur.depth : depth > cur.depth)) {
      best.set(lane, { slot, depth });
    }
  }
  return [...best.values()].map((v) => v.slot).sort(leftToRight);
}

// Filled slots exposed to `side`, left to right.
export function getExposedSlots(formation, side) {
  assertSide(side);
  return exposedFrom(filledSlots(formation), side);
}

// How many units can attack toward `side` (also how many can counter an
// attack that came from that side). Reserves never count.
export function countAttackers(formation, side) {
  return getExposedSlots(formation, side).length;
}

// Attackers per side: { N, E, S, W }.
export function exposureCounts(formation) {
  const out = {};
  for (const d of DIRS) out[d] = countAttackers(formation, d);
  return out;
}

// Units standing in the grid layout right now (not reserves).
export function countOnGrid(formation) {
  return filledSlots(formation).length;
}

// Does this formation type ignore flank and rear bonuses? (square: yes)
export function ignoresFlankBonus(type) {
  assertType(type);
  return type === "square" ? F.SQUARE.IGNORES_FLANK_BONUS : F.LINE.IGNORES_FLANK_BONUS;
}

// ---------------------------------------------------------------
// Casualties
// ---------------------------------------------------------------

// Removes `casualties` units from a stack hit from `hitFromSide`.
// Exposed units die first, layer by layer, left to right. Reserves in the
// middle of a square die last. Survivors do NOT move up yet; call reform()
// after the whole exchange so reserves do not attack in the same exchange.
//
// Returns:
//   formation       new formation (holes left where units died)
//   removedSlots    slot indices removed, in the order they died
//   reservesLost    reserve units that died
//   killed          total units removed (capped at the stack size)
export function applyCasualties(formation, hitFromSide, casualties) {
  assertSide(hitFromSide);
  assertCount(casualties);

  const slots = formation.slots.map((s) => ({ ...s }));
  let remaining = Math.min(casualties, formation.count);
  const removedSlots = [];

  while (remaining > 0) {
    const live = slots.filter((s) => s.filled);
    if (live.length === 0) break;
    const exposed = exposedFrom(live, hitFromSide);
    const take = Math.min(remaining, exposed.length);
    for (let i = 0; i < take; i++) {
      const target = slots.find((s) => s.index === exposed[i].index);
      target.filled = false;
      removedSlots.push(target.index);
    }
    remaining -= take;
  }

  let reservesLost = 0;
  if (remaining > 0) {
    reservesLost = Math.min(remaining, formation.reserve);
    remaining -= reservesLost;
  }

  const killed = Math.min(casualties, formation.count);
  return {
    formation: {
      ...formation,
      count: formation.count - killed,
      slots,
      reserve: formation.reserve - reservesLost,
    },
    removedSlots,
    reservesLost,
    killed,
  };
}

// ---------------------------------------------------------------
// Re-forming and changing the formation
// ---------------------------------------------------------------

// Rebuilds a fresh layout for the survivors (reserves fill front first).
// Call this after the full attack-and-counter exchange.
export function reform(formation) {
  return createFormation(formation.type, formation.count, formation.facing);
}

// Switch between square and line (the turn cost is handled by army.js).
export function switchFormationType(formation, newType) {
  assertType(newType);
  return createFormation(newType, formation.count, formation.facing);
}

// Change which way a line faces. A square does not change shape.
export function setFacing(formation, facing) {
  assertSide(facing);
  return createFormation(formation.type, formation.count, facing);
}

// Change the unit count (merge, split, hire, desertion) and re-form.
export function setCount(formation, count) {
  assertCount(count);
  return createFormation(formation.type, count, formation.facing);
}

// ---------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------

// Draws the layout as text. X = unit, . = empty slot, space = outside.
export function debugString(formation) {
  if (formation.slots.length === 0) return `(empty, reserve ${formation.reserve})`;
  const maxX = Math.max(...formation.slots.map((s) => s.x));
  const maxY = Math.max(...formation.slots.map((s) => s.y));
  const rows = [];
  for (let y = 0; y <= maxY; y++) {
    let row = "";
    for (let x = 0; x <= maxX; x++) {
      const s = formation.slots.find((c) => c.x === x && c.y === y);
      row += s ? (s.filled ? "X" : ".") : " ";
    }
    rows.push(row);
  }
  return `${formation.type} facing ${formation.facing}, ${formation.count} units, reserve ${formation.reserve}\n${rows.join("\n")}`;
}

// Quick self-check. Call formationSelfTest() from the browser console.
// Throws on the first failure and returns true if everything passes.
export function formationSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`formationSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  // Square layouts
  const sq10 = createFormation("square", 10);
  eq(sq10.slots.length, 8, "square 10 ring");
  eq(sq10.reserve, 2, "square 10 reserve");
  eq(exposureCounts(sq10), { N: 3, E: 3, S: 3, W: 3 }, "square 10 exposure");
  eq(createFormation("square", 9).reserve, 1, "square 9 reserve");
  eq(createFormation("square", 12).slots.length, 12, "square 12 ring");
  eq(exposureCounts(createFormation("square", 12)), { N: 4, E: 4, S: 4, W: 4 }, "square 12 exposure");
  eq(exposureCounts(createFormation("square", 1)), { N: 1, E: 1, S: 1, W: 1 }, "square 1 exposure");
  eq(createFormation("square", 3).reserve, 2, "square 3 reserve");

  // Line layouts (facing north, 11 units: 6 front, 5 back)
  const ln11 = createFormation("line", 11, "N");
  eq(ln11.slots.filter((s) => s.rank === "front").length, 6, "line 11 front");
  eq(ln11.slots.filter((s) => s.rank === "back").length, 5, "line 11 back");
  eq(exposureCounts(ln11), { N: 6, E: 2, S: 6, W: 2 }, "line 11 exposure");
  // Facing south flips which side is the front but keeps the counts.
  eq(exposureCounts(createFormation("line", 11, "S")), { N: 6, E: 2, S: 6, W: 2 }, "line 11 S exposure");
  // Line facing east: the line runs up and down.
  eq(exposureCounts(createFormation("line", 11, "E")), { N: 2, E: 6, S: 2, W: 6 }, "line 11 E exposure");

  // Casualties: peel layers, left to right
  const hit = applyCasualties(ln11, "N", 7);
  eq(hit.removedSlots, [0, 1, 2, 3, 4, 5, 6], "line casualties order");
  eq(hit.formation.count, 4, "line casualties count");
  eq(hit.killed, 7, "line casualties killed");

  // Square middle reserves die last
  const sqHit = applyCasualties(sq10, "N", 9);
  eq(sqHit.reservesLost, 1, "square reserve dies last");
  eq(sqHit.formation.count, 1, "square survivors");

  // Overkill is capped
  eq(applyCasualties(createFormation("line", 3, "N"), "N", 99).killed, 3, "overkill cap");

  // Re-form: reserves fill the front first
  const afterHit = applyCasualties(createFormation("line", 11, "N"), "N", 3).formation;
  const re = reform(afterHit);
  eq(re.count, 8, "reform count");
  eq(re.slots.filter((s) => s.rank === "front").length, 4, "reform front");
  eq(re.slots.filter((s) => s.rank === "back").length, 4, "reform back");

  // Square ring shrinks and reserves fill the ring
  eq(reform(applyCasualties(sq10, "N", 1).formation).slots.length, 8, "square reform keeps ring");

  // Flank flags
  eq(ignoresFlankBonus("square"), true, "square ignores flank");
  eq(ignoresFlankBonus("line"), false, "line does not ignore flank");

  return true;
}

export default {
  createFormation,
  getExposedSlots,
  countAttackers,
  exposureCounts,
  countOnGrid,
  ignoresFlankBonus,
  applyCasualties,
  reform,
  switchFormationType,
  setFacing,
  setCount,
  debugString,
  formationSelfTest,
};

