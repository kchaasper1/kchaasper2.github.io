// villages.js
// Villages: patronage income, capture, contests and hiring points.
// Pure logic: no graphics, no network, integers only. Every function returns
// new objects and never edits its inputs.
//
// ---------------------------------------------------------------
// VILLAGE (plain JSON, kept in its own list next to the overworld world)
// ---------------------------------------------------------------
//   {
//     id, name,
//     x, y,             position in overworld sub-tiles
//     ownerId,          null while neutral
//     stored,           income saved up and not yet collected (gold)
//     incomeMilli,      income per world turn x 1000 (so 1% growth is exact);
//                       the gold paid is floor(incomeMilli / 1000)
//     canHire,          can troops be hired here?
//     hireTypes         null (any hireable type) or a list of unit type ids
//   }
//
// ---------------------------------------------------------------
// RULES
// ---------------------------------------------------------------
// GROWTH. Every village's income grows by INCOME_GROWTH_PERCENT_PER_DAY
//  (1%) each day, compounding, whether or not anyone controls it
//  (growIncome). A monster raid cuts it by 10% to 50% (applyRaids).
//
// INCOME. An owned village adds its income in gold to its `stored` pile every
//  world turn. If the village is safe, everything stored is collected by its
//  owner that turn. If it is DISTURBED the income is FROZEN: it keeps piling
//  up in the village but cannot be collected. As soon as the threat is gone,
//  everything saved up is collected at once. Neutral villages pay nothing.
//
// DISTURBED. Any army that is not the owner's, or any monster (an overworld
//  thing with kind "monster"), within CONFIG.VILLAGES.DISTURB_RANGE tiles.
//  It lasts only as long as the threat is nearby.
//
// CAPTURE. An army that stands on or within CAPTURE_RANGE tiles of a village
//  at the END of a turn captures it, if no army of another owner is also
//  within that range. The number of units does not matter. The village's
//  stored income does not go to the captor (it resets to 0).
//
// CONTEST. If armies of different owners are both within capture range, they
//  must fight. findContests() lists the pairs. The turn resolver runs the
//  battle, removes or pushes the loser out of reach (pushLoserOut), and the
//  winner must STILL be standing there at the end of the turn: only then does
//  updateCaptures() give it the village.
//
// HIRING. An army can hire at a village that its owner holds, if it is within
//  capture range, the village can hire, and (optionally) offers that unit
//  type. A disturbed village can still hire.
//
// ORDER OF A TURN (CONFIG.TURNS.RESOLUTION_ORDER)
//   movement -> contacts and battles -> village contests -> updateCaptures()
//   -> processIncome() -> economy.runUpkeep(income = incomeByOwner[owner])
//
// Ranges in CONFIG are in tiles; positions are in sub-tiles (overworld.js).

import { CONFIG } from "./config.js";
import { distanceSq, isqrt, tileToPoint, pushOutsideRange } from "./overworld.js";

const V = CONFIG.VILLAGES;
const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;

export const CAPTURE_RANGE_SUBTILES = V.CAPTURE_RANGE * S;
export const DISTURB_RANGE_SUBTILES = V.DISTURB_RANGE * S;

if (!V.CONTEST_FIGHTS_BATTLE) throw new Error("villages: only CONTEST_FIGHTS_BATTLE = true is supported");

const fail = (code, reason) => ({ ok: false, code, reason });

function cmpId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------
// Creating and reading villages
// ---------------------------------------------------------------

// Give the position as a tile (tx, ty) or as sub-tiles (x, y).
// income is whole gold per turn; incomeMilli (x1000) overrides it.
export function createVillage({ id, name = "Village", tx, ty, x, y, ownerId = null, income = V.INCOME_PER_TURN, incomeMilli, canHire = V.CAN_HIRE, hireTypes = null, stored = 0 }) {
  if (!id) throw new Error("villages: createVillage needs an id");
  const p = tx !== undefined ? tileToPoint(tx, ty) : { x, y };
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new Error("villages: village needs an integer position");
  const milli = incomeMilli !== undefined ? incomeMilli : income * 1000;
  if (!Number.isInteger(milli) || milli < 0) throw new Error("villages: income must be a non-negative integer");
  if (!Number.isInteger(stored) || stored < 0) throw new Error("villages: stored must be a non-negative integer");
  return { id, name, x: p.x, y: p.y, ownerId, stored, incomeMilli: milli, canHire, hireTypes };
}

// Gold this village pays per world turn right now.
export function villageIncome(village) {
  return Math.floor(village.incomeMilli / 1000);
}

export function getVillage(villages, villageId) {
  return villages.find((v) => v.id === villageId) || null;
}

export function listOwnedVillages(villages, ownerId) {
  return villages.filter((v) => v.ownerId === ownerId).sort((a, b) => cmpId(a.id, b.id));
}

function replaceVillage(villages, village) {
  return villages.map((v) => (v.id === village.id ? village : v));
}

// Armies within `range` sub-tiles of the village, sorted by id.
function armiesWithin(world, village, range) {
  const r2 = range * range;
  return world.armies.filter((a) => distanceSq(a, village) <= r2).sort((a, b) => cmpId(a.id, b.id));
}

// Armies close enough to capture or hire.
export function armiesInCaptureRange(world, village) {
  return armiesWithin(world, village, CAPTURE_RANGE_SUBTILES);
}

// ---------------------------------------------------------------
// Threats
// ---------------------------------------------------------------

// Everything that disturbs the village right now: armies of other owners
// and monsters within the disturb range. [{ kind, id, ownerId?, distance }]
// sorted by distance, then id.
export function getThreats(world, village) {
  const r2 = DISTURB_RANGE_SUBTILES * DISTURB_RANGE_SUBTILES;
  const out = [];
  for (const a of world.armies) {
    if (a.ownerId === village.ownerId) continue;
    const d2 = distanceSq(a, village);
    if (d2 <= r2) out.push({ kind: "army", id: a.id, ownerId: a.ownerId, distance: isqrt(d2) });
  }
  for (const t of world.things) {
    if (t.kind !== "monster") continue;
    const d2 = distanceSq(t, village);
    if (d2 <= r2) out.push({ kind: "monster", id: t.id, distance: isqrt(d2) });
  }
  return out.sort((a, b) => a.distance - b.distance || cmpId(a.id, b.id));
}

export function isDisturbed(world, village) {
  return getThreats(world, village).length > 0;
}

// Everything a village panel needs.
export function getVillageStatus(world, village) {
  const threats = village.ownerId === null ? [] : getThreats(world, village);
  const owned = village.ownerId !== null;
  return {
    ownerId: village.ownerId,
    stored: village.stored,
    incomePerTurn: owned ? villageIncome(village) : 0,
    disturbed: threats.length > 0,
    frozen: owned && threats.length > 0,
    threats,
    // What the owner would receive at the next income step.
    nextCollection: owned && threats.length === 0 ? village.stored + villageIncome(village) : 0,
  };
}

// ---------------------------------------------------------------
// Income
// ---------------------------------------------------------------

// The income step of a world turn. Every owned village adds its income to
// its stored pile; safe villages then pay the whole pile to their owner.
// Returns {
//   villages,
//   incomeByOwner,   { ownerId: gold }  -> economy.runUpkeep({ income })
//   events           [{ villageId, ownerId, stored, collected, frozen }]
// }
export function processIncome(villages, world) {
  const incomeByOwner = {};
  const events = [];
  let next = villages;

  for (const v of villages.slice().sort((a, b) => cmpId(a.id, b.id))) {
    if (v.ownerId === null) continue;
    const stored = v.stored + villageIncome(v);
    const frozen = isDisturbed(world, v);
    if (frozen) {
      next = replaceVillage(next, { ...v, stored });
      events.push({ villageId: v.id, ownerId: v.ownerId, stored, collected: 0, frozen: true });
    } else {
      next = replaceVillage(next, { ...v, stored: 0 });
      incomeByOwner[v.ownerId] = (incomeByOwner[v.ownerId] || 0) + stored;
      events.push({ villageId: v.id, ownerId: v.ownerId, stored: 0, collected: stored, frozen: false });
    }
  }
  return { villages: next, incomeByOwner, events };
}

// ---------------------------------------------------------------
// Growth and raids
// ---------------------------------------------------------------

// Daily growth of every village's income, owned or not. Call it once per
// world turn with the turn number; it only acts on the last turn of a day
// (CONFIG.TURNS.TURNS_PER_DAY). Compounds: +1% of the current income.
export function growIncome(villages, turn) {
  if (turn % CONFIG.TURNS.TURNS_PER_DAY !== 0) return villages;
  return villages.map((v) => ({
    ...v,
    incomeMilli: Math.floor((v.incomeMilli * (CONFIG.MATH.PERCENT + V.INCOME_GROWTH_PERCENT_PER_DAY)) / CONFIG.MATH.PERCENT),
  }));
}

// Applies monster raids (events from monsters.js): each cuts the village's
// income by cutPercent. raids: [{ villageId, cutPercent }].
export function applyRaids(villages, raids) {
  let next = villages;
  for (const r of raids) {
    if (!Number.isInteger(r.cutPercent) || r.cutPercent < 0 || r.cutPercent > 100) {
      throw new Error(`villages: bad raid cut ${r.cutPercent}`);
    }
    next = next.map((v) =>
      v.id === r.villageId
        ? { ...v, incomeMilli: Math.floor((v.incomeMilli * (CONFIG.MATH.PERCENT - r.cutPercent)) / CONFIG.MATH.PERCENT) }
        : v
    );
  }
  return next;
}

// ---------------------------------------------------------------
// Contests and capture
// ---------------------------------------------------------------

// Villages where armies of different owners are both in capture range.
// Returns [{ villageId, armyIds, owners, pairs }] sorted by village id.
// pairs are every opposing pair [armyIdA, armyIdB], sorted, for the turn
// resolver to fight one by one (then call findContests again).
export function findContests(world, villages) {
  const out = [];
  for (const v of villages.slice().sort((a, b) => cmpId(a.id, b.id))) {
    const here = armiesInCaptureRange(world, v);
    const owners = [...new Set(here.map((a) => a.ownerId))].sort();
    if (owners.length < 2) continue;
    const pairs = [];
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        if (here[i].ownerId !== here[j].ownerId) pairs.push([here[i].id, here[j].id]);
      }
    }
    out.push({ villageId: v.id, armyIds: here.map((a) => a.id), owners, pairs });
  }
  return out;
}

// Kicks a defeated army back out of the village's capture range.
// Returns a new overworld world.
export function pushLoserOut(world, village, armyId) {
  return pushOutsideRange(world, armyId, { x: village.x, y: village.y }, CAPTURE_RANGE_SUBTILES);
}

// The capture step, at the END of a turn (after contests were fought).
// A village is captured when armies of exactly one owner, who is not its
// owner, are within capture range. Contested villages do not change hands.
// Returns { villages, events } where events are
//   { type: "captured", villageId, from, to, armyIds }
//   { type: "contested", villageId, owners }
export function updateCaptures(villages, world) {
  const events = [];
  let next = villages;
  for (const v of villages.slice().sort((a, b) => cmpId(a.id, b.id))) {
    const here = armiesInCaptureRange(world, v);
    if (here.length === 0) continue;
    const owners = [...new Set(here.map((a) => a.ownerId))].sort();
    if (owners.length > 1) {
      events.push({ type: "contested", villageId: v.id, owners });
      continue;
    }
    if (owners[0] === v.ownerId) continue;
    next = replaceVillage(next, { ...v, ownerId: owners[0], stored: 0 });
    events.push({ type: "captured", villageId: v.id, from: v.ownerId, to: owners[0], armyIds: here.map((a) => a.id) });
  }
  return { villages: next, events };
}

// ---------------------------------------------------------------
// Hiring points
// ---------------------------------------------------------------

// Can this army hire right now? It must be within capture range of a
// village its owner holds that can hire (and offers `typeId`, if given).
// Returns { ok: true, villageId } or { ok: false, code, reason }.
// The nearest suitable village wins; ties go to the smaller id.
export function canHireAt(world, villages, armyId, typeId) {
  const army = world.armies.find((a) => a.id === armyId);
  if (!army) return fail("unknown_army", "That army does not exist.");

  const near = villages
    .filter((v) => v.ownerId === army.ownerId && distanceSq(army, v) <= CAPTURE_RANGE_SUBTILES * CAPTURE_RANGE_SUBTILES)
    .sort((a, b) => distanceSq(army, a) - distanceSq(army, b) || cmpId(a.id, b.id));
  if (near.length === 0) return fail("no_village", "This army is not at a village you hold.");

  const hiring = near.filter((v) => v.canHire);
  if (hiring.length === 0) return fail("village_cannot_hire", "Nobody can be hired at this village.");

  if (typeId !== undefined) {
    const offering = hiring.filter((v) => v.hireTypes === null || v.hireTypes.includes(typeId));
    if (offering.length === 0) return fail("type_not_offered", "This village does not offer that unit.");
    return { ok: true, villageId: offering[0].id };
  }
  return { ok: true, villageId: hiring[0].id };
}

// Can this owner hire at this village? No army needs to be there: the units
// appear in a new army at the village (turnResolver.js). The village must be
// held by the owner, be able to hire, and offer the unit type (if given).
// Returns { ok: true, villageId } or { ok: false, code, reason }.
export function canHireAtVillage(villages, ownerId, villageId, typeId) {
  const village = getVillage(villages, villageId);
  if (!village) return fail("unknown_village", "That village does not exist.");
  if (village.ownerId !== ownerId) return fail("not_yours", "You do not hold that village.");
  if (!village.canHire) return fail("village_cannot_hire", "Nobody can be hired at this village.");
  if (typeId !== undefined && village.hireTypes !== null && !village.hireTypes.includes(typeId)) {
    return fail("type_not_offered", "This village does not offer that unit.");
  }
  return { ok: true, villageId };
}

// ---------------------------------------------------------------
// Saving and loading
// ---------------------------------------------------------------

// Makes a saved or received list of villages safe. Bad entries are dropped.
export function deserializeVillages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || !r.id || seen.has(r.id)) continue;
    const x = Number(r.x);
    const y = Number(r.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    const milliRaw = r.incomeMilli !== undefined ? Number(r.incomeMilli) : Number(r.income) * 1000;
    const incomeMilli = Math.floor(milliRaw);
    const stored = Math.floor(Number(r.stored));
    seen.add(r.id);
    out.push({
      id: String(r.id),
      name: typeof r.name === "string" ? r.name : "Village",
      x,
      y,
      ownerId: r.ownerId ?? null,
      stored: Number.isFinite(stored) && stored > 0 ? stored : 0,
      incomeMilli: Number.isFinite(incomeMilli) && incomeMilli >= 0 ? incomeMilli : V.INCOME_PER_TURN * 1000,
      canHire: typeof r.canHire === "boolean" ? r.canHire : V.CAN_HIRE,
      hireTypes: Array.isArray(r.hireTypes) ? r.hireTypes.filter((t) => typeof t === "string") : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------
// Self test (call villagesSelfTest() from the browser console)
// ---------------------------------------------------------------

import { createWorld, addArmy, addThing, removeArmy } from "./overworld.js";

export function villagesSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`villagesSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const world = () => createWorld({ widthTiles: 48, heightTiles: 48 });
  const withArmy = (w, id, ownerId, tx, ty) => addArmy(w, { id, ownerId, ...tileToPoint(tx, ty) });
  const owned = (ownerId, extra = {}) => createVillage({ id: "v1", tx: 10, ty: 10, ownerId, ...extra });

  // Creating
  const n = createVillage({ id: "v1", tx: 10, ty: 10 });
  eq([n.x, n.y], [tileToPoint(10, 10).x, tileToPoint(10, 10).y], "position from tile");
  eq([n.ownerId, n.stored, villageIncome(n)], [null, 0, V.INCOME_PER_TURN], "neutral village defaults");
  eq(CAPTURE_RANGE_SUBTILES, V.CAPTURE_RANGE * S, "capture range in sub-tiles");

  // Daily growth: every village, owned or not, compounding
  let grown = [n, owned("p1")];
  grown = growIncome(grown, 1);
  eq(grown.map((v) => v.incomeMilli), [5050, 5050], "+1% on day 1, for everyone");
  eq(villageIncome(grown[0]), 5, "5.05 pays 5 gold");
  for (let day = 2; day <= 30; day++) grown = growIncome(grown, day);
  eq(grown[0].incomeMilli, grown[1].incomeMilli, "owned and neutral grow the same");
  eq(villageIncome(grown[0]) > 5, true, "income has grown after 30 days");
  eq(grown[0].incomeMilli >= 6700 && grown[0].incomeMilli <= 6730, true, "about 5 x 1.01^30 = 6.74");

  // Raids cut the income by a percent
  const raided = applyRaids([createVillage({ id: "v1", tx: 1, ty: 1, income: 6 }), createVillage({ id: "v2", tx: 2, ty: 2, income: 6 })], [{ villageId: "v1", cutPercent: 50 }]);
  eq(raided.map((v) => v.incomeMilli), [3000, 6000], "raid halves one village only");
  eq(applyRaids([n], [{ villageId: "v1", cutPercent: 10 }])[0].incomeMilli, 4500, "10% cut");
  eq(applyRaids([n], [{ villageId: "v1", cutPercent: 10 }, { villageId: "v1", cutPercent: 10 }])[0].incomeMilli, 4050, "raids stack");
  // Growth then recovers it
  eq(growIncome(applyRaids([n], [{ villageId: "v1", cutPercent: 50 }]), 1)[0].incomeMilli, 2525, "growth continues after a raid");

  // Safe income is collected
  let w = withArmy(world(), "far", "p1", 40, 40);
  let r = processIncome([owned("p1")], w);
  eq(r.incomeByOwner, { p1: V.INCOME_PER_TURN }, "safe village pays");
  eq(r.villages[0].stored, 0, "pile collected");
  eq(r.events[0].frozen, false, "not frozen");
  eq(processIncome([n], w).incomeByOwner, {}, "neutral village pays nothing");

  // An enemy nearby freezes income, which piles up
  w = withArmy(withArmy(world(), "mine", "p1", 40, 40), "foe", "p2", 15, 10); // 5 tiles away
  eq(getThreats(w, owned("p1")).map((t) => [t.kind, t.id]), [["army", "foe"]], "enemy is a threat");
  r = processIncome([owned("p1")], w);
  eq([r.incomeByOwner, r.villages[0].stored, r.events[0].frozen], [{}, V.INCOME_PER_TURN, true], "income frozen, not lost");
  r = processIncome(r.villages, w);
  eq(r.villages[0].stored, 2 * V.INCOME_PER_TURN, "keeps piling up while frozen");
  eq(getVillageStatus(w, r.villages[0]).frozen, true, "status shows frozen");
  // The threat leaves: everything saved is collected at once
  const cleared = removeArmy(w, "foe");
  r = processIncome(r.villages, cleared);
  eq(r.incomeByOwner, { p1: 3 * V.INCOME_PER_TURN }, "unfrozen: collects the whole pile");
  eq(r.villages[0].stored, 0, "pile empty again");

  // Distance and owner matter
  eq(getThreats(withArmy(world(), "foe", "p2", 17, 10), owned("p1")), [], "7 tiles is out of range");
  eq(getThreats(withArmy(world(), "ally", "p1", 12, 10), owned("p1")), [], "own army is no threat");
  const monsterWorld = addThing(world(), { id: "wolves", kind: "monster", ...tileToPoint(14, 10), stops: true });
  eq(getThreats(monsterWorld, owned("p1")).map((t) => t.kind), ["monster"], "monster is a threat");
  eq(processIncome([owned("p1")], monsterWorld).events[0].frozen, true, "monster freezes income");
  const rock = addThing(world(), { id: "rock", kind: "rock", ...tileToPoint(11, 10), stops: true });
  eq(getThreats(rock, owned("p1")), [], "other things are not threats");

  // Capture: standing close enough at the end of the turn
  w = withArmy(world(), "A", "p1", 10, 11); // 1 tile away
  let c = updateCaptures([n], w);
  eq(c.villages[0].ownerId, "p1", "neutral village captured");
  eq(c.events, [{ type: "captured", villageId: "v1", from: null, to: "p1", armyIds: ["A"] }], "capture event");
  eq(updateCaptures(c.villages, w).events, [], "already held: nothing happens");
  eq(updateCaptures([n], withArmy(world(), "A", "p1", 10, 13)).events, [], "3 tiles is too far");
  // Taking an enemy village resets its stored income
  c = updateCaptures([owned("p2", { stored: 20 })], w);
  eq([c.villages[0].ownerId, c.villages[0].stored], ["p1", 0], "captured village loses its pile");
  // Several armies of one owner capture once
  c = updateCaptures([n], withArmy(w, "B", "p1", 11, 10));
  eq(c.events.length, 1, "one capture event");
  eq(c.events[0].armyIds, ["A", "B"], "both armies listed");

  // Contest: opposing armies in range must fight, the winner must stay
  w = withArmy(withArmy(world(), "A", "p1", 10, 11), "B", "p2", 11, 10);
  const contests = findContests(w, [n]);
  eq(contests.length, 1, "contested village found");
  eq(contests[0].pairs, [["A", "B"]], "opposing pair");
  eq(updateCaptures([n], w).events[0].type, "contested", "no capture while contested");
  eq(updateCaptures([n], w).villages[0].ownerId, null, "ownership unchanged");
  // B loses and is pushed out of reach; A still stands there: captures
  const afterBattle = pushLoserOut(w, n, "B");
  const bPos = afterBattle.armies.find((a) => a.id === "B");
  eq(distanceSq(bPos, n) > CAPTURE_RANGE_SUBTILES * CAPTURE_RANGE_SUBTILES, true, "loser is out of reach");
  eq(findContests(afterBattle, [n]), [], "no contest after the push");
  eq(updateCaptures([n], afterBattle).villages[0].ownerId, "p1", "winner captures at the end of the turn");
  eq(findContests(withArmy(withArmy(world(), "A", "p1", 10, 11), "C", "p1", 10, 9), [n]), [], "same owner is no contest");

  // Hiring points
  w = withArmy(world(), "A", "p1", 10, 11);
  eq(canHireAt(w, [owned("p1")], "A"), { ok: true, villageId: "v1" }, "hire at your village");
  eq(canHireAt(w, [n], "A").code, "no_village", "neutral village: no hiring");
  eq(canHireAt(w, [owned("p2")], "A").code, "no_village", "enemy village: no hiring");
  eq(canHireAt(withArmy(world(), "A", "p1", 10, 14), [owned("p1")], "A").code, "no_village", "too far");
  eq(canHireAt(w, [owned("p1", { canHire: false })], "A").code, "village_cannot_hire", "village that cannot hire");
  eq(canHireAt(w, [owned("p1", { hireTypes: ["spearman"] })], "A", "swordsman").code, "type_not_offered", "unit not offered");
  eq(canHireAt(w, [owned("p1", { hireTypes: ["spearman"] })], "A", "spearman").ok, true, "unit offered");
  eq(canHireAt(w, [owned("p1")], "Z").code, "unknown_army", "unknown army");
  // Hiring still works while disturbed
  eq(canHireAt(withArmy(w, "foe", "p2", 14, 10), [owned("p1")], "A").ok, true, "disturbed villages can hire");

  // Hiring at a village needs no army
  eq(canHireAtVillage([owned("p1")], "p1", "v1", "swordsman"), { ok: true, villageId: "v1" }, "hire without an army");
  eq(canHireAtVillage([owned("p1")], "p2", "v1").code, "not_yours", "someone else's village");
  eq(canHireAtVillage([n], "p1", "v1").code, "not_yours", "neutral village");
  eq(canHireAtVillage([owned("p1")], "p1", "zz").code, "unknown_village", "unknown village");
  eq(canHireAtVillage([owned("p1", { canHire: false })], "p1", "v1").code, "village_cannot_hire", "cannot hire");
  eq(canHireAtVillage([owned("p1", { hireTypes: ["spearman"] })], "p1", "v1", "swordsman").code, "type_not_offered", "type not offered");

  // Status for the UI
  const st = getVillageStatus(world(), owned("p1", { stored: 7 }));
  eq([st.frozen, st.nextCollection, st.incomePerTurn], [false, 7 + V.INCOME_PER_TURN, V.INCOME_PER_TURN], "status when safe");

  // Loading
  eq(deserializeVillages([{ id: "a", x: 1, y: 2, stored: -3 }, { id: "a", x: 5, y: 5 }, { x: 1, y: 1 }, { id: "b", x: 1.5, y: 2 }]).map((v) => [v.id, v.stored]), [["a", 0]], "bad entries dropped");

  return true;
}

export default {
  CAPTURE_RANGE_SUBTILES,
  DISTURB_RANGE_SUBTILES,
  createVillage,
  getVillage,
  listOwnedVillages,
  armiesInCaptureRange,
  villageIncome,
  getThreats,
  isDisturbed,
  getVillageStatus,
  processIncome,
  growIncome,
  applyRaids,
  findContests,
  pushLoserOut,
  updateCaptures,
  canHireAt,
  canHireAtVillage,
  deserializeVillages,
  villagesSelfTest,
};
