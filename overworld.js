// overworld.js
// Free movement on the wide map, simultaneous turn movement, and contact
// detection. Pure logic: no graphics, no network, integers only.
//
// ---------------------------------------------------------------
// WHAT THIS FILE OWNS
// ---------------------------------------------------------------
//  - Positions of armies and neutral "things" (monsters, villages...).
//  - Movement orders (go to a point, end the turn facing a direction).
//  - Resolving one world turn of movement for ALL armies at once.
//  - Finding contacts: who meets whom, who attacks, from which side.
// It does NOT own the armies' contents (army.js), battles (battleGrid.js),
// gold, villages or monsters' behavior (their own scripts), or hiding the
// orders until everyone has submitted (matchSync.js).
//
// ---------------------------------------------------------------
// COORDINATES
// ---------------------------------------------------------------
//  Positions are integer SUB-TILES: CONFIG.OVERWORLD.SUBTILES_PER_TILE (16)
//  per tile. x grows east, y grows south, (0, 0) is the top-left corner.
//  Use tileToPoint() and pointToTile() to convert. Integer math only, and
//  our own integer square root, so every PvP client computes the same map.
//
// WORLD (plain JSON)
//   {
//     widthTiles, heightTiles,
//     armies: [{ id, ownerId, x, y, facing, moveTiles? }],
//     things: [{ id, kind, x, y, stops, range? }]
//   }
//   army.id is the same id as the army.js army it stands for. moveTiles is
//   an optional per-army override of CONFIG.OVERWORLD.DEFAULT_MOVE_PER_TURN.
//   A thing with stops = true halts any army that reaches it (a monster).
//   A thing with stops = false is ignored by movement (a village: capture
//   is decided by distance at the end of the turn, see armiesNear()).
//
// ORDERS (one per army per turn; an army with no order stays put)
//   { armyId, target?: { x, y }, facing?: "N" | "E" | "S" | "W" }
//   target is in sub-tiles. The army walks a STRAIGHT line toward it, up to
//   its move distance for the turn (pathfinding comes later). facing is the
//   direction the army ends the turn facing, chosen by the player.
//
// ---------------------------------------------------------------
// HOW A TURN IS RESOLVED
// ---------------------------------------------------------------
//  The turn is simulated in CONFIG.OVERWORLD.STEPS_PER_TURN equal steps.
//  At every step all moving armies advance together, each by its move
//  distance divided by the number of steps (an army stops early if it
//  reaches its target), then contacts are checked in a fixed order (by army
//  id). So nobody gets an advantage from the order the orders were
//  submitted or processed.
//
//  ARMY CONTACT: two armies of different owners come within CONTACT_RANGE
//  while at least one of them is closing the distance. Both stop there.
//    - Only one is closing in: the other was already there (it had stopped,
//      had no order, or was moving away), so the one closing in reaches the
//      contact point LATER and is the ATTACKER.
//    - Both close in at the same step: equal arrival. There is no attacker
//      and no first strike (event.tie = true, event.initiator = false).
//  An army can only be in one contact per turn. Extra contacts at the same
//  step go to the army pair that comes first by id; the others are simply
//  not triggered this turn (they are still in range next turn only if one of
//  them closes in again). Armies of the SAME owner never make contact.
//
//  THING CONTACT: an army closing in on a stopping thing halts when it gets
//  within the thing's range and a thing_contact event is reported. What that
//  means (a fight with a monster, nothing for a rock) is up to the caller.
//
//  FACING: applied at the end of the turn for armies that were not in a
//  contact. An army in a contact keeps the facing it had when the turn
//  started, because the battle uses it (a flanked defender starts the
//  battle turned the way it was facing).
//
//  After a battle the winner and loser may still be inside CONTACT_RANGE;
//  use pushOutsideRange() to separate them (for example the loser of a
//  fight over a village).

import { CONFIG } from "./config.js";
import { getHitFromSide } from "./battleRules.js";

const O = CONFIG.OVERWORLD;
const S = O.SUBTILES_PER_TILE;
const STEPS = O.STEPS_PER_TURN;
const RANGE = O.CONTACT_RANGE;
const DIRS = CONFIG.FACING.DIRECTIONS;

if (!Number.isInteger(S) || S < 1 || !Number.isInteger(STEPS) || STEPS < 1) {
  throw new Error("overworld: SUBTILES_PER_TILE and STEPS_PER_TURN must be positive integers");
}
if (O.ARRIVAL_TIE !== "no_first_strike") {
  throw new Error(`overworld: unsupported ARRIVAL_TIE "${O.ARRIVAL_TIE}"`);
}

// Biggest per-turn move (in tiles) that cannot make two armies step over
// each other: two armies closing in together must not cover more than
// CONTACT_RANGE in one step.
export const MAX_SAFE_MOVE_TILES = Math.floor((STEPS * Math.floor(RANGE / 2)) / S);
if (O.DEFAULT_MOVE_PER_TURN > MAX_SAFE_MOVE_TILES) {
  throw new Error(
    `overworld: DEFAULT_MOVE_PER_TURN (${O.DEFAULT_MOVE_PER_TURN}) is above ${MAX_SAFE_MOVE_TILES}; raise STEPS_PER_TURN or CONTACT_RANGE`
  );
}

// ---------------------------------------------------------------
// Integer math
// ---------------------------------------------------------------

// floor(sqrt(n)) for integers, exact on every browser.
export function isqrt(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`overworld: isqrt needs a non-negative integer, got ${n}`);
  if (n < 2) return n;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

// Integer division rounding toward zero (b > 0).
function divTrunc(a, b) {
  return (a - (a % b)) / b;
}

export function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a, b) {
  return isqrt(distanceSq(a, b));
}

// ---------------------------------------------------------------
// World
// ---------------------------------------------------------------

export function tileToPoint(tx, ty) {
  return { x: tx * S + Math.floor(S / 2), y: ty * S + Math.floor(S / 2) };
}

export function pointToTile(p) {
  return { x: Math.floor(p.x / S), y: Math.floor(p.y / S) };
}

export function createWorld({ widthTiles = CONFIG.MAP_GENERATION.WIDTH_TILES, heightTiles = CONFIG.MAP_GENERATION.HEIGHT_TILES } = {}) {
  return { widthTiles, heightTiles, armies: [], things: [] };
}

function inMap(world, p) {
  return (
    Number.isInteger(p.x) &&
    Number.isInteger(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < world.widthTiles * S &&
    p.y < world.heightTiles * S
  );
}

// Adds an army at a point (sub-tiles). Returns a new world.
export function addArmy(world, { id, ownerId, x, y, facing = "N", moveTiles }) {
  if (world.armies.some((a) => a.id === id)) throw new Error(`overworld: duplicate army id "${id}"`);
  if (!inMap(world, { x, y })) throw new Error(`overworld: army "${id}" is outside the map`);
  if (!DIRS.includes(facing)) throw new Error(`overworld: bad facing "${facing}"`);
  const army = { id, ownerId, x, y, facing };
  if (moveTiles !== undefined) army.moveTiles = moveTiles;
  return { ...world, armies: world.armies.concat([army]) };
}

export function removeArmy(world, armyId) {
  return { ...world, armies: world.armies.filter((a) => a.id !== armyId) };
}

export function addThing(world, { id, kind, x, y, stops = false, range = RANGE }) {
  if (world.things.some((t) => t.id === id)) throw new Error(`overworld: duplicate thing id "${id}"`);
  if (!inMap(world, { x, y })) throw new Error(`overworld: thing "${id}" is outside the map`);
  return { ...world, things: world.things.concat([{ id, kind, x, y, stops, range }]) };
}

export function removeThing(world, thingId) {
  return { ...world, things: world.things.filter((t) => t.id !== thingId) };
}

export function getArmy(world, armyId) {
  return world.armies.find((a) => a.id === armyId) || null;
}

// Moves an army to a point without any rules (setup, teleports, after
// battles). Clamped to the map.
export function placeArmy(world, armyId, x, y) {
  const cx = Math.min(world.widthTiles * S - 1, Math.max(0, x));
  const cy = Math.min(world.heightTiles * S - 1, Math.max(0, y));
  return { ...world, armies: world.armies.map((a) => (a.id === armyId ? { ...a, x: cx, y: cy } : a)) };
}

// How far an army may walk this turn, in sub-tiles.
export function getMoveDistance(army) {
  const tiles = Math.min(army.moveTiles ?? O.DEFAULT_MOVE_PER_TURN, MAX_SAFE_MOVE_TILES);
  return tiles * S;
}

// Armies of any owner within `range` sub-tiles of a point, sorted by id.
// For village capture: "standing on or close to it".
export function armiesNear(world, point, range) {
  const r2 = range * range;
  return world.armies.filter((a) => distanceSq(a, point) <= r2).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------
// Orders
// ---------------------------------------------------------------

// Checks one order. Pass ownerId to also check the army belongs to that
// player (matchSync does this when it receives an order).
// Returns { ok: true } or { ok: false, code, reason }.
export function validateOrder(world, order, ownerId) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!order || typeof order !== "object") return fail("bad_order", "That is not an order.");
  const army = getArmy(world, order.armyId);
  if (!army) return fail("unknown_army", "That army does not exist.");
  if (ownerId !== undefined && army.ownerId !== ownerId) return fail("not_yours", "That army belongs to another player.");
  if (order.target === undefined && order.facing === undefined) return fail("empty_order", "The order does nothing.");
  if (order.target !== undefined) {
    if (!order.target || !inMap(world, order.target)) return fail("bad_target", "The target is outside the map.");
  }
  if (order.facing !== undefined && !DIRS.includes(order.facing)) return fail("bad_facing", `Bad facing "${order.facing}".`);
  return { ok: true };
}

// ---------------------------------------------------------------
// Resolving a turn of movement
// ---------------------------------------------------------------

// Resolves all orders at once.
// Returns {
//   world,      new world (positions and facings updated)
//   events,     contacts, in the order they happened (see below)
//   paths,      { armyId: [{x,y}, ...] } positions at the start and after
//               each step until the army stopped (for animation)
//   arrived,    ids of armies that reached their target
//   rejected    [{ armyId, code, reason }] for orders that were not used
// }
//
// events:
//   { type: "army_contact", step, attackerId, defenderId, initiator, tie,
//     hitFromSide, point }
//        hitFromSide is the side of the DEFENDER the attacker is on. When
//        tie is true there is no real attacker: the two armies are listed
//        by id (attackerId is the smaller id) and initiator is false. Feed
//        it to toBattleParams() and then battleGrid.createBattle().
//   { type: "thing_contact", step, armyId, thingId, kind, point }
export function resolveMovement(world, orders) {
  const rejected = [];

  // One order per army. Conflicting duplicates are all rejected, so the
  // result never depends on the order of the list.
  const counts = new Map();
  for (const o of orders) counts.set(o && o.armyId, (counts.get(o && o.armyId) || 0) + 1);
  const orderById = new Map();
  for (const o of orders) {
    if (counts.get(o && o.armyId) > 1) {
      if (!rejected.some((r) => r.armyId === o.armyId)) {
        rejected.push({ armyId: o.armyId, code: "duplicate_order", reason: "More than one order for the same army." });
      }
      continue;
    }
    const v = validateOrder(world, o);
    if (!v.ok) rejected.push({ armyId: o && o.armyId, code: v.code, reason: v.reason });
    else orderById.set(o.armyId, o);
  }
  rejected.sort((a, b) => (String(a.armyId) < String(b.armyId) ? -1 : String(a.armyId) > String(b.armyId) ? 1 : 0));

  const armies = world.armies.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const things = world.things.filter((t) => t.stops).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Straight-line plans.
  const plans = new Map();
  for (const a of armies) {
    const o = orderById.get(a.id);
    if (!o || o.target === undefined) continue;
    const dx = o.target.x - a.x;
    const dy = o.target.y - a.y;
    const len = isqrt(dx * dx + dy * dy);
    if (len === 0) continue;
    plans.set(a.id, { ox: a.x, oy: a.y, dx, dy, len, move: getMoveDistance(a) });
  }

  const pos = new Map(armies.map((a) => [a.id, { x: a.x, y: a.y }]));
  const owner = new Map(armies.map((a) => [a.id, a.ownerId]));
  const stopped = new Set(); // armies that are in a contact this turn
  const paths = {};
  const active = new Set(); // armies still recording a path
  for (const a of armies) {
    paths[a.id] = [{ x: a.x, y: a.y }];
    active.add(a.id);
  }
  const events = [];

  for (let step = 1; step <= STEPS; step++) {
    const oldPos = new Map([...pos].map(([id, p]) => [id, { ...p }]));

    // 1. Everyone moves together.
    for (const a of armies) {
      const plan = plans.get(a.id);
      if (!plan || stopped.has(a.id)) continue;
      // Every army walks at the same pace (its move distance / steps) and
      // stops when it reaches its target, so a short trip arrives early.
      const d = Math.min(plan.len, divTrunc(plan.move * step, STEPS));
      pos.set(a.id, { x: plan.ox + divTrunc(plan.dx * d, plan.len), y: plan.oy + divTrunc(plan.dy * d, plan.len) });
    }

    // 2. Army contacts, pairs in id order.
    const closing = (id, otherOldPos) => distanceSq(pos.get(id), otherOldPos) < distanceSq(oldPos.get(id), otherOldPos);
    for (let i = 0; i < armies.length; i++) {
      for (let j = i + 1; j < armies.length; j++) {
        const A = armies[i];
        const B = armies[j];
        if (owner.get(A.id) === owner.get(B.id)) continue;
        if (stopped.has(A.id) || stopped.has(B.id)) continue;
        if (distanceSq(pos.get(A.id), pos.get(B.id)) > RANGE * RANGE) continue;
        const aCloses = closing(A.id, oldPos.get(B.id));
        const bCloses = closing(B.id, oldPos.get(A.id));
        if (!aCloses && !bCloses) continue;

        const tie = aCloses && bCloses;
        // The one still closing in arrives later and attacks. On a tie the
        // smaller id is only used to give the pair a fixed order.
        const attacker = tie || aCloses ? A : B;
        const defender = attacker === A ? B : A;
        const pa = pos.get(attacker.id);
        const pd = pos.get(defender.id);
        events.push({
          type: "army_contact",
          step,
          attackerId: attacker.id,
          defenderId: defender.id,
          initiator: !tie,
          tie,
          hitFromSide: getHitFromSide(pa, pd) || "S",
          point: { x: Math.floor((pa.x + pd.x) / 2), y: Math.floor((pa.y + pd.y) / 2) },
        });
        stopped.add(A.id);
        stopped.add(B.id);
      }
    }

    // 3. Contacts with stopping things.
    if (O.NEUTRAL_STOPS_MOVEMENT) {
      for (const a of armies) {
        if (stopped.has(a.id)) continue;
        for (const t of things) {
          const r2 = (t.range ?? RANGE) * (t.range ?? RANGE);
          if (distanceSq(pos.get(a.id), t) > r2) continue;
          if (distanceSq(pos.get(a.id), t) >= distanceSq(oldPos.get(a.id), t)) continue; // not closing in
          events.push({ type: "thing_contact", step, armyId: a.id, thingId: t.id, kind: t.kind, point: { x: t.x, y: t.y } });
          stopped.add(a.id);
          break;
        }
      }
    }

    // 4. Record paths (until each army has stopped moving for good).
    for (const a of armies) {
      if (!active.has(a.id)) continue;
      paths[a.id].push({ ...pos.get(a.id) });
      const plan = plans.get(a.id);
      const done = !plan || stopped.has(a.id) || step === STEPS;
      if (done) active.delete(a.id);
    }
  }

  // Final world: positions, then facing for armies not in a contact.
  const arrived = [];
  const nextArmies = world.armies.map((a) => {
    const p = pos.get(a.id);
    const o = orderById.get(a.id);
    const out = { ...a, x: p.x, y: p.y };
    if (o && o.facing !== undefined && !stopped.has(a.id)) out.facing = o.facing;
    if (o && o.target !== undefined && !stopped.has(a.id) && p.x === o.target.x && p.y === o.target.y) arrived.push(a.id);
    return out;
  });
  arrived.sort();

  return { world: { ...world, armies: nextArmies }, events, paths, arrived, rejected };
}

// ---------------------------------------------------------------
// After a contact
// ---------------------------------------------------------------

// Everything battleGrid.createBattle() needs for an army_contact event.
//   armiesById   { armyId: army.js army } for the armies in the event
//   world        the world returned by resolveMovement (armies in contact
//                keep their turn-start facing, which the battle uses)
export function toBattleParams(event, armiesById, world) {
  if (event.type !== "army_contact") throw new Error("overworld: toBattleParams needs an army_contact event");
  const withFacing = (id) => {
    const army = armiesById[id];
    const w = getArmy(world, id);
    if (!army || !w) throw new Error(`overworld: unknown army "${id}"`);
    return { ...army, facing: w.facing };
  };
  return {
    attackerArmy: withFacing(event.attackerId),
    defenderArmy: withFacing(event.defenderId),
    hitFromSide: event.hitFromSide,
    attackerIsInitiator: event.initiator,
  };
}

// Pushes an army straight away from `center` until it is just outside
// `range` (distance of range + 1), clamped to the map. If it is exactly on
// the center it is pushed south. For the loser of a fight over a village.
export function pushOutsideRange(world, armyId, center, range) {
  const a = getArmy(world, armyId);
  if (!a) throw new Error(`overworld: unknown army "${armyId}"`);
  const dx = a.x - center.x;
  const dy = a.y - center.y;
  const len = isqrt(dx * dx + dy * dy);
  const want = range + 1;
  if (len >= want) return world;
  const nx = len === 0 ? center.x : center.x + divTrunc(dx * want, len);
  const ny = len === 0 ? center.y + want : center.y + divTrunc(dy * want, len);
  return placeArmy(world, armyId, nx, ny);
}

// ---------------------------------------------------------------
// Self test (call overworldSelfTest() from the browser console)
// ---------------------------------------------------------------

export function overworldSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`overworldSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const P = (tx, ty) => tileToPoint(tx, ty);

  // Integer math
  eq([isqrt(0), isqrt(1), isqrt(15), isqrt(16), isqrt(99999999)], [0, 1, 3, 4, 9999], "isqrt");
  eq(pointToTile(P(5, 7)), { x: 5, y: 7 }, "tile round trip");

  const base = () => createWorld({ widthTiles: 48, heightTiles: 48 });
  const build = (list) => list.reduce((w, a) => addArmy(w, a), base());

  // --- Straight-line movement, limited by move distance ---
  let w = build([{ id: "A", ownerId: "p1", ...P(5, 5) }]);
  let r = resolveMovement(w, [{ armyId: "A", target: P(30, 5) }]);
  eq(getArmy(r.world, "A").x - P(5, 5).x, 6 * S, "walks 6 tiles in a turn");
  eq(getArmy(r.world, "A").y, P(5, 5).y, "stays on the line");
  eq(r.arrived, [], "did not arrive");
  eq(r.paths.A.length, STEPS + 1, "path has every step");

  // Reaches a close target exactly
  r = resolveMovement(w, [{ armyId: "A", target: P(8, 7) }]);
  eq([getArmy(r.world, "A").x, getArmy(r.world, "A").y], [P(8, 7).x, P(8, 7).y], "arrives exactly");
  eq(r.arrived, ["A"], "arrived list");

  // Diagonal movement stays on the line and within range
  r = resolveMovement(w, [{ armyId: "A", target: P(30, 30) }]);
  const moved = distance(P(5, 5), getArmy(r.world, "A"));
  eq(moved <= 6 * S && moved >= 6 * S - 2, true, "diagonal move length");

  // Facing is applied at the end of the turn
  r = resolveMovement(w, [{ armyId: "A", target: P(7, 5), facing: "E" }]);
  eq(getArmy(r.world, "A").facing, "E", "facing applied");
  eq(resolveMovement(w, [{ armyId: "A", facing: "S" }]).world.armies[0].facing, "S", "facing-only order");

  // --- Contact: only one army closing in. The other had no order. ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200 },
    { id: "B", ownerId: "p2", x: 200, y: 200, facing: "N" },
  ]);
  r = resolveMovement(w, [{ armyId: "A", target: { x: 400, y: 200 } }]);
  eq(r.events.length, 1, "one contact");
  eq(r.events[0].type, "army_contact", "contact type");
  eq([r.events[0].attackerId, r.events[0].defenderId, r.events[0].initiator, r.events[0].tie], ["A", "B", true, false], "mover attacks the one who waited");
  eq(r.events[0].hitFromSide, "W", "attacker came from the west");
  eq(distanceSq(getArmy(r.world, "A"), getArmy(r.world, "B")) <= RANGE * RANGE, true, "within contact range");
  eq(getArmy(r.world, "B").x, 200, "waiting army did not move");

  // --- Head-on: both close in at once, so it is a tie ---
  r = resolveMovement(w, [
    { armyId: "A", target: { x: 200, y: 200 } },
    { armyId: "B", target: { x: 100, y: 200 } },
  ]);
  eq(r.events.length, 1, "head-on contact");
  eq([r.events[0].tie, r.events[0].initiator], [true, false], "head-on is a tie");
  eq(r.events[0].attackerId, "A", "tie lists the smaller id first");
  // Same result when the orders arrive in the other order
  eq(resolveMovement(w, [
    { armyId: "B", target: { x: 100, y: 200 } },
    { armyId: "A", target: { x: 200, y: 200 } },
  ]), r, "order of orders does not matter");

  // --- One army arrived earlier and waits; the other arrives later and attacks ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200 },
    { id: "B", ownerId: "p2", x: 190, y: 200 },
  ]);
  r = resolveMovement(w, [
    { armyId: "A", target: { x: 130, y: 200 } },
    { armyId: "B", target: { x: 100, y: 200 } },
  ]);
  eq(r.events.length, 1, "later arrival contact");
  eq([r.events[0].attackerId, r.events[0].tie], ["B", false], "the later arrival attacks");
  eq(r.events[0].step > 8, true, "contact after A had stopped");

  // --- Same owner never makes contact ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200 },
    { id: "B", ownerId: "p1", x: 160, y: 200 },
  ]);
  eq(resolveMovement(w, [{ armyId: "A", target: { x: 300, y: 200 } }]).events, [], "no friendly contact");

  // --- An army moving away does not trigger contact, the one chasing does ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200 },
    { id: "B", ownerId: "p2", x: 110, y: 200 },
  ]);
  eq(resolveMovement(w, []).events, [], "already in range, nobody moves: no new contact");
  r = resolveMovement(w, [
    { armyId: "A", target: { x: 400, y: 200 } },
    { armyId: "B", target: { x: 500, y: 200 } },
  ]);
  eq(r.events.length, 1, "chase contact");
  eq([r.events[0].attackerId, r.events[0].tie], ["A", false], "the chaser attacks");

  // --- Stopping things ---
  w = addThing(build([{ id: "A", ownerId: "p1", x: 100, y: 200 }]), { id: "wolves", kind: "monster", x: 160, y: 200, stops: true });
  r = resolveMovement(w, [{ armyId: "A", target: { x: 400, y: 200 } }]);
  eq(r.events.map((e) => e.type), ["thing_contact"], "monster stops the army");
  eq(getArmy(r.world, "A").x < 160, true, "army stopped before the monster");
  eq(r.events[0].kind, "monster", "thing kind reported");
  // A village does not stop movement
  w = addThing(build([{ id: "A", ownerId: "p1", x: 100, y: 200 }]), { id: "v1", kind: "village", x: 160, y: 200, stops: false });
  r = resolveMovement(w, [{ armyId: "A", target: { x: 180, y: 200 } }]);
  eq([r.events, r.arrived], [[], ["A"]], "village does not stop movement");
  eq(armiesNear(r.world, { x: 160, y: 200 }, 30).map((a) => a.id), ["A"], "armiesNear finds the army");

  // --- Facing: engaged armies keep their old facing ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200, facing: "N" },
    { id: "B", ownerId: "p2", x: 200, y: 200, facing: "W" },
  ]);
  r = resolveMovement(w, [
    { armyId: "A", target: { x: 400, y: 200 }, facing: "E" },
    { armyId: "B", facing: "S" },
  ]);
  eq([getArmy(r.world, "A").facing, getArmy(r.world, "B").facing], ["N", "W"], "engaged armies keep their facing");

  // --- Orders are checked ---
  w = build([{ id: "A", ownerId: "p1", x: 100, y: 200 }]);
  eq(validateOrder(w, { armyId: "A", target: { x: 5, y: 5 } }, "p2").code, "not_yours", "wrong owner");
  eq(validateOrder(w, { armyId: "Z", target: { x: 5, y: 5 } }).code, "unknown_army", "unknown army");
  eq(validateOrder(w, { armyId: "A", target: { x: -1, y: 5 } }).code, "bad_target", "outside map");
  eq(validateOrder(w, { armyId: "A", target: { x: 5.5, y: 5 } }).code, "bad_target", "not an integer");
  eq(validateOrder(w, { armyId: "A", facing: "Q" }).code, "bad_facing", "bad facing");
  eq(validateOrder(w, { armyId: "A" }).code, "empty_order", "empty order");
  r = resolveMovement(w, [{ armyId: "A", target: { x: 300, y: 200 } }, { armyId: "A", target: { x: 100, y: 300 } }]);
  eq(r.rejected.map((x) => x.code), ["duplicate_order"], "conflicting orders rejected");
  eq(getArmy(r.world, "A").x, 100, "rejected orders do nothing");

  // --- Battle parameters ---
  w = build([
    { id: "A", ownerId: "p1", x: 100, y: 200, facing: "N" },
    { id: "B", ownerId: "p2", x: 200, y: 200, facing: "N" },
  ]);
  r = resolveMovement(w, [{ armyId: "A", target: { x: 400, y: 200 } }]);
  const params = toBattleParams(r.events[0], { A: { id: "A", ownerId: "p1", facing: "S", stacks: [] }, B: { id: "B", ownerId: "p2", facing: "S", stacks: [] } }, r.world);
  eq([params.attackerArmy.id, params.defenderArmy.id, params.hitFromSide, params.attackerIsInitiator], ["A", "B", "W", true], "battle params");
  eq(params.defenderArmy.facing, "N", "defender facing comes from the world");

  // --- Pushing an army out of range ---
  w = build([{ id: "A", ownerId: "p1", x: 100, y: 100 }]);
  const pushed = pushOutsideRange(w, "A", { x: 90, y: 100 }, 30);
  eq(distance(getArmy(pushed, "A"), { x: 90, y: 100 }) >= 30, true, "pushed outside the range");
  eq(getArmy(pushed, "A").x > 100, true, "pushed away from the center");
  eq(pushOutsideRange(w, "A", { x: 0, y: 0 }, 30), w, "already outside: unchanged");

  // --- Determinism ---
  const again = resolveMovement(w, []);
  eq(resolveMovement(w, []), again, "deterministic");

  return true;
}

export default {
  MAX_SAFE_MOVE_TILES,
  isqrt,
  distanceSq,
  distance,
  tileToPoint,
  pointToTile,
  createWorld,
  addArmy,
  removeArmy,
  addThing,
  removeThing,
  getArmy,
  placeArmy,
  getMoveDistance,
  armiesNear,
  validateOrder,
  resolveMovement,
  toBattleParams,
  pushOutsideRange,
  overworldSelfTest,
};
