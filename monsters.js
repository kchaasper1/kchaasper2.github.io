// monsters.js
// Roaming monsters: they spawn now and then, wander, raid villages, and
// fight armies in regular battles. Pure logic: no graphics, no network,
// integers only. Every function returns new objects and never edits its
// inputs.
//
// ---------------------------------------------------------------
// MONSTER (plain JSON; keep the list next to the overworld world)
// ---------------------------------------------------------------
//   {
//     id, typeId,        a unit type with isMonster (e.g. "wolf_pack")
//     count, carry,      units left and the wound on the wounded one
//     x, y,              position in overworld sub-tiles
//     homeX, homeY,      where it spawned (its roaming center)
//     facing,            direction it last walked ("N" | "E" | "S" | "W")
//     target             wander destination, or null
//   }
//   Monsters are also kept in the overworld world as things of kind
//   "monster" that stop armies (withMonsterThings keeps them in sync), so an
//   army that walks into one stops and overworld.js reports a thing_contact.
//   Villages treat any monster nearby as a threat (their income freezes).
//
// ---------------------------------------------------------------
// WHAT A MONSTER DOES EACH WORLD TURN (runMonsterTurn)
// ---------------------------------------------------------------
//  1. MOVE. A monster that senses a village within VILLAGE_SENSE_RANGE tiles
//     heads for it and stays once it is within RAID_RANGE tiles. Otherwise it
//     wanders: it walks up to MOVE_PER_TURN tiles toward a random target
//     within ROAM_RADIUS tiles of its home, picking a new target when it
//     arrives or by chance.
//  2. CONTACT. If a monster ends its move within contact range of an army,
//     it attacks that army: a monster_contact event. The monster is the
//     attacker. Use toMonsterAttackParams() and battleGrid.createBattle().
//     An army that walks into a monster is the attacker instead (see
//     toArmyAttackParams for the overworld thing_contact event).
//  3. RAID. A monster that is not fighting and is within RAID_RANGE tiles of
//     a village raids it with a chance each turn. A raid cuts the village's
//     income by a random 10% to 50%: apply it with villages.applyRaids().
//  4. SPAWN. With a chance each turn, if fewer than MAX_ACTIVE monsters
//     exist, a new group appears at a random spot away from armies,
//     villages and other monsters. It does not act on the turn it spawns.
//
// A fight with a monster is a regular battle on the battle grid. Afterwards
// call applyMonsterOutcome(): the monster keeps its survivors and wounds, or
// disappears if none are left.
//
// DETERMINISM
//  Each monster and each spawn uses a stream forked from the monsters stream
//  by monster id and turn, so results never depend on processing order.

import { CONFIG } from "./config.js";
import { getUnitType } from "./unitTypes.js";
import { createArmy, addStack } from "./army.js";
import { distanceSq, isqrt, tileToPoint } from "./overworld.js";
import { getHitFromSide } from "./battleRules.js";

const M = CONFIG.MONSTERS;
const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;
const CONTACT_RANGE = CONFIG.OVERWORLD.CONTACT_RANGE;
const DIRS = CONFIG.FACING.DIRECTIONS;

// The owner id monsters fight under in battles.
export const MONSTER_OWNER = "monsters";

if (M.SPAWN_COUNT_MIN < 1 || M.SPAWN_COUNT_MAX < M.SPAWN_COUNT_MIN) throw new Error("monsters: bad SPAWN_COUNT range");
if (M.RAID_CUT_MIN_PERCENT < 0 || M.RAID_CUT_MAX_PERCENT > 100 || M.RAID_CUT_MAX_PERCENT < M.RAID_CUT_MIN_PERCENT) {
  throw new Error("monsters: bad RAID_CUT range");
}
for (const t of M.TYPES) {
  if (!getUnitType(t).isMonster) throw new Error(`monsters: "${t}" is not a monster unit type`);
}
if (!CONFIG.FORMATIONS.TYPES.includes(M.FORMATION)) throw new Error(`monsters: bad FORMATION "${M.FORMATION}"`);

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

function cmpId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function divTrunc(a, b) {
  return (a - (a % b)) / b;
}

function clampToMap(world, p) {
  return {
    x: Math.min(world.widthTiles * S - 1, Math.max(0, p.x)),
    y: Math.min(world.heightTiles * S - 1, Math.max(0, p.y)),
  };
}

// A step of at most maxDist toward `to`, in integers.
function stepToward(from, to, maxDist) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = isqrt(dx * dx + dy * dy);
  if (len <= maxDist) return { x: to.x, y: to.y };
  return { x: from.x + divTrunc(dx * maxDist, len), y: from.y + divTrunc(dy * maxDist, len) };
}

function facingFromMove(dx, dy, previous) {
  if (dx === 0 && dy === 0) return previous;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

function nearestWithin(list, p, range) {
  const r2 = range * range;
  return list
    .filter((e) => distanceSq(e, p) <= r2)
    .sort((a, b) => distanceSq(a, p) - distanceSq(b, p) || cmpId(a.id, b.id))[0] || null;
}

function replaceMonster(monsters, monster) {
  return monsters.map((m) => (m.id === monster.id ? monster : m));
}

// ---------------------------------------------------------------
// Creating and syncing
// ---------------------------------------------------------------

export function createMonster({ id, typeId, count, x, y, facing = "N", carry = 0 }) {
  if (!id) throw new Error("monsters: createMonster needs an id");
  if (!getUnitType(typeId).isMonster) throw new Error(`monsters: "${typeId}" is not a monster unit type`);
  if (!Number.isInteger(count) || count < 1) throw new Error("monsters: count must be an integer >= 1");
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("monsters: position must be integers");
  if (!DIRS.includes(facing)) throw new Error(`monsters: bad facing "${facing}"`);
  return { id, typeId, count, carry, x, y, homeX: x, homeY: y, facing, target: null };
}

export function getMonster(monsters, id) {
  return monsters.find((m) => m.id === id) || null;
}

// Keeps the overworld world's monster things in step with the monster list:
// other things are kept, monster things are rebuilt. Returns a new world.
export function withMonsterThings(world, monsters) {
  const others = world.things.filter((t) => t.kind !== "monster");
  const things = monsters
    .slice()
    .sort((a, b) => cmpId(a.id, b.id))
    .map((m) => ({ id: m.id, kind: "monster", x: m.x, y: m.y, stops: true, range: CONTACT_RANGE }));
  return { ...world, things: others.concat(things) };
}

// ---------------------------------------------------------------
// Moving
// ---------------------------------------------------------------

// Wanders and heads for villages. villages: villages.js list.
// Returns { monsters, world }.
export function moveMonsters(monsters, world, villages, rng, turn) {
  let next = monsters;
  const senseRange = M.VILLAGE_SENSE_RANGE * S;
  const raidRange = M.RAID_RANGE * S;

  for (const m of monsters.slice().sort((a, b) => cmpId(a.id, b.id))) {
    const r = rng.fork(`move:${m.id}:${turn}`);
    let dest = null;
    let target = m.target;

    const village = M.ATTACKS_VILLAGES ? nearestWithin(villages, m, senseRange) : null;
    if (village) {
      // Stay put once close enough to raid; otherwise walk to the village.
      dest = distanceSq(m, village) <= raidRange * raidRange ? null : { x: village.x, y: village.y };
    } else {
      // Wander. Always draw once so the stream is used the same way.
      const repick = r.chancePerMille(M.NEW_TARGET_CHANCE_PER_MILLE);
      const arrived = !target || distanceSq(m, target) <= (S / 2) * (S / 2);
      if (arrived || repick) {
        const R = M.ROAM_RADIUS * S;
        target = clampToMap(world, { x: m.homeX + r.nextInt(-R, R), y: m.homeY + r.nextInt(-R, R) });
      }
      dest = target;
    }

    let moved = { x: m.x, y: m.y };
    if (dest) moved = clampToMap(world, stepToward(m, dest, M.MOVE_PER_TURN * S));
    next = replaceMonster(next, {
      ...m,
      x: moved.x,
      y: moved.y,
      facing: facingFromMove(moved.x - m.x, moved.y - m.y, m.facing),
      target,
    });
  }
  return { monsters: next, world: withMonsterThings(world, next) };
}

// ---------------------------------------------------------------
// Contact with armies
// ---------------------------------------------------------------

// Monsters that ended their move within contact range of an army. Each
// monster attacks the nearest free army; an army is attacked by at most one
// monster per turn. Returns events:
//   { type: "monster_contact", monsterId, armyId, hitFromSide, point }
// hitFromSide is the side of the ARMY the monster is on.
export function findMonsterContacts(monsters, world) {
  const taken = new Set();
  const events = [];
  for (const m of monsters.slice().sort((a, b) => cmpId(a.id, b.id))) {
    const free = world.armies.filter((a) => !taken.has(a.id));
    const army = nearestWithin(free, m, CONTACT_RANGE);
    if (!army) continue;
    taken.add(army.id);
    events.push({
      type: "monster_contact",
      monsterId: m.id,
      armyId: army.id,
      hitFromSide: getHitFromSide({ x: m.x, y: m.y }, { x: army.x, y: army.y }) || "S",
      point: { x: Math.floor((m.x + army.x) / 2), y: Math.floor((m.y + army.y) / 2) },
    });
  }
  return events;
}

// ---------------------------------------------------------------
// Raiding villages
// ---------------------------------------------------------------

// Monsters that are not fighting and are close to a village may raid it.
//   engagedIds   ids of monsters already in a fight this turn
// Returns events { type: "village_raid", monsterId, villageId, cutPercent }.
// Apply them with villages.applyRaids(villages, events).
export function findRaids(monsters, villages, engagedIds, rng, turn) {
  if (!M.ATTACKS_VILLAGES) return [];
  const events = [];
  for (const m of monsters.slice().sort((a, b) => cmpId(a.id, b.id))) {
    if (engagedIds.has(m.id)) continue;
    const village = nearestWithin(villages, m, M.RAID_RANGE * S);
    if (!village) continue;
    const r = rng.fork(`raid:${m.id}:${turn}`);
    if (!r.chancePerMille(M.RAID_CHANCE_PER_MILLE)) continue;
    events.push({
      type: "village_raid",
      monsterId: m.id,
      villageId: village.id,
      cutPercent: r.nextInt(M.RAID_CUT_MIN_PERCENT, M.RAID_CUT_MAX_PERCENT),
    });
  }
  return events;
}

// ---------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------

// Maybe spawns one new group. Returns { monsters, world, events } where
// events is [{ type: "monster_spawned", monsterId, typeId, count, x, y }].
//   nextId   id factory (army.createIdCounter("m")); store its counter in
//            the match record so every client makes the same ids
export function spawnMonsters(monsters, world, villages, rng, { turn, nextId }) {
  const none = { monsters, world: withMonsterThings(world, monsters), events: [] };
  if (monsters.length >= M.MAX_ACTIVE) return none;
  const r = rng.fork(`spawn:${turn}`);
  if (!r.chancePerMille(M.SPAWN_CHANCE_PER_MILLE)) return none;

  const typeId = r.pick(M.TYPES);
  const count = r.nextInt(M.SPAWN_COUNT_MIN, M.SPAWN_COUNT_MAX);
  const facing = r.pick(DIRS);
  const margin = 2 * S;
  const farFromArmies = M.MIN_SPAWN_DISTANCE_FROM_ARMIES * S;
  const nearLimit = 3 * S;

  for (let attempt = 0; attempt < 12; attempt++) {
    const p = {
      x: r.nextInt(margin, world.widthTiles * S - 1 - margin),
      y: r.nextInt(margin, world.heightTiles * S - 1 - margin),
    };
    const clear =
      world.armies.every((a) => distanceSq(a, p) >= farFromArmies * farFromArmies) &&
      villages.every((v) => distanceSq(v, p) >= nearLimit * nearLimit) &&
      monsters.every((m) => distanceSq(m, p) >= nearLimit * nearLimit);
    if (!clear) continue;
    const monster = createMonster({ id: nextId(), typeId, count, x: p.x, y: p.y, facing });
    const next = monsters.concat([monster]);
    return {
      monsters: next,
      world: withMonsterThings(world, next),
      events: [{ type: "monster_spawned", monsterId: monster.id, typeId, count, x: p.x, y: p.y }],
    };
  }
  return none; // no free spot found this turn
}

// ---------------------------------------------------------------
// One whole monster turn
// ---------------------------------------------------------------

// Runs the monsters' part of a world turn: move, contact, raid, spawn.
//   state   { monsters, world, villages }
//   rng     the monsters stream (createMatchStreams(...).monsters)
// Returns {
//   monsters, world,
//   contacts   monster_contact events: fight these on the battle grid
//   raids      village_raid events: villages.applyRaids(villages, raids)
//   spawned    monster_spawned events
// }
export function runMonsterTurn({ monsters, world, villages }, rng, { turn, nextId }) {
  const moved = moveMonsters(monsters, world, villages, rng, turn);
  const contacts = findMonsterContacts(moved.monsters, moved.world);
  const engaged = new Set(contacts.map((c) => c.monsterId));
  const raids = findRaids(moved.monsters, villages, engaged, rng, turn);
  const spawn = spawnMonsters(moved.monsters, moved.world, villages, rng, { turn, nextId });
  return { monsters: spawn.monsters, world: spawn.world, contacts, raids, spawned: spawn.events };
}

// ---------------------------------------------------------------
// Fighting
// ---------------------------------------------------------------

// The monster as an army.js army, for battleGrid.createBattle().
export function monsterToArmy(monster) {
  const type = getUnitType(monster.typeId);
  const stackId = `${monster.id}:s1`;
  let army = createArmy({ id: monster.id, ownerId: MONSTER_OWNER, name: type.name, facing: monster.facing });
  const res = addStack(army, { typeId: monster.typeId, count: monster.count, formationType: M.FORMATION }, { nextId: () => stackId, enforceLimits: false });
  army = res.army;
  return { ...army, stacks: army.stacks.map((s) => ({ ...s, carry: monster.carry })) };
}

function withWorldFacing(army, world) {
  const w = world.armies.find((a) => a.id === army.id);
  if (!w) throw new Error(`monsters: army "${army.id}" is not in the world`);
  return { ...army, facing: w.facing };
}

// A monster attacks an army (monster_contact event). Returns what
// battleGrid.createBattle() takes. The army keeps the facing it has in the
// world, so a flanked army starts the battle turned the way it was facing.
export function toMonsterAttackParams(event, monsters, armiesById, world) {
  const monster = getMonster(monsters, event.monsterId);
  const army = armiesById[event.armyId];
  if (!monster || !army) throw new Error("monsters: unknown monster or army in the event");
  return {
    attackerArmy: monsterToArmy(monster),
    defenderArmy: withWorldFacing(army, world),
    hitFromSide: event.hitFromSide,
    attackerIsInitiator: true,
  };
}

// An army walked into a monster (overworld thing_contact event with
// kind "monster"). The army is the attacker.
export function toArmyAttackParams(event, monsters, armiesById, world) {
  const monster = getMonster(monsters, event.thingId);
  const army = armiesById[event.armyId];
  if (!monster || !army) throw new Error("monsters: unknown monster or army in the event");
  const armyPos = world.armies.find((a) => a.id === army.id);
  return {
    attackerArmy: withWorldFacing(army, world),
    defenderArmy: monsterToArmy(monster),
    // The side of the MONSTER the army is on.
    hitFromSide: getHitFromSide({ x: armyPos.x, y: armyPos.y }, { x: monster.x, y: monster.y }) || "S",
    attackerIsInitiator: true,
  };
}

// Writes a battle's result back. armyAfter is the monster's army after
// battleGrid.applyOutcomesToArmies(). With no units left the monster is
// removed; otherwise it keeps its survivors and wound.
// Returns { monsters, world, defeated }.
export function applyMonsterOutcome(monsters, world, monsterId, armyAfter) {
  const stack = armyAfter.stacks[0];
  const next = !stack
    ? monsters.filter((m) => m.id !== monsterId)
    : replaceMonster(monsters, { ...getMonster(monsters, monsterId), count: stack.count, carry: stack.carry });
  return { monsters: next, world: withMonsterThings(world, next), defeated: !stack };
}

// ---------------------------------------------------------------
// Saving and loading
// ---------------------------------------------------------------

// Makes a saved or received monster list safe. Bad entries are dropped.
export function deserializeMonsters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || !r.id || seen.has(r.id)) continue;
    let type;
    try {
      type = getUnitType(r.typeId);
    } catch (e) {
      continue;
    }
    const count = Math.floor(Number(r.count));
    if (!type.isMonster || !Number.isFinite(count) || count < 1) continue;
    if (![r.x, r.y, r.homeX, r.homeY].every(Number.isInteger)) continue;
    const carry = Math.floor(Number(r.carry));
    seen.add(r.id);
    out.push({
      id: String(r.id),
      typeId: r.typeId,
      count,
      carry: Number.isFinite(carry) && carry > 0 ? carry : 0,
      x: r.x,
      y: r.y,
      homeX: r.homeX,
      homeY: r.homeY,
      facing: DIRS.includes(r.facing) ? r.facing : "N",
      target: r.target && Number.isInteger(r.target.x) && Number.isInteger(r.target.y) ? { x: r.target.x, y: r.target.y } : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------
// Self test (call from the browser console:
//   import("./rng.js").then(m => monstersSelfTest(m.createRng)) )
// ---------------------------------------------------------------

import { createWorld, addArmy, addThing, resolveMovement } from "./overworld.js";
import { createVillage, getThreats, applyRaids, villageIncome } from "./villages.js";
import { createIdCounter, applyBattleOutcome } from "./army.js";
import { createBattle, getOutcomes } from "./battleGrid.js";

export function monstersSelfTest(createRng) {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`monstersSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const world0 = () => createWorld({ widthTiles: 48, heightTiles: 48 });
  const P = tileToPoint;

  // Creating and syncing
  const m1 = createMonster({ id: "m1", typeId: "wolf_pack", count: 5, ...P(20, 20) });
  eq([m1.homeX, m1.facing, m1.target], [m1.x, "N", null], "new monster");
  let threw = false;
  try {
    createMonster({ id: "x", typeId: "swordsman", count: 1, x: 1, y: 1 });
  } catch (e) {
    threw = true;
  }
  eq(threw, true, "only monster types allowed");
  let w = addThing(world0(), { id: "rock", kind: "rock", ...P(5, 5), stops: true });
  w = withMonsterThings(w, [m1]);
  eq(w.things.map((t) => t.id), ["rock", "m1"], "monster thing added, others kept");
  eq(withMonsterThings(w, []).things.map((t) => t.id), ["rock"], "monster things removed");
  eq(getThreats(w, createVillage({ id: "v", ...P(22, 20), ownerId: "p1" })).map((t) => t.kind), ["monster"], "villages see monsters as threats");

  // Spawning: now and then, never above the limit, away from armies
  const nextId = createIdCounter("m", 100);
  let ms = [];
  let world = addArmy(world0(), { id: "A", ownerId: "p1", ...P(10, 10) });
  const villages = [createVillage({ id: "v1", ...P(30, 30), ownerId: "p1" })];
  const streams = createRng("spawns");
  let spawnedTurns = 0;
  let maxSeen = 0;
  for (let turn = 1; turn <= 400; turn++) {
    const res = spawnMonsters(ms, world, villages, streams, { turn, nextId });
    if (res.events.length) spawnedTurns++;
    ms = res.monsters;
    maxSeen = Math.max(maxSeen, ms.length);
    for (const e of res.events) {
      eq(e.count >= M.SPAWN_COUNT_MIN && e.count <= M.SPAWN_COUNT_MAX, true, "spawn count in range");
      eq(distanceSq(e, world.armies[0]) >= (M.MIN_SPAWN_DISTANCE_FROM_ARMIES * S) ** 2, true, "spawned away from armies");
    }
    if (ms.length >= M.MAX_ACTIVE) ms = ms.slice(0, 2); // make room so spawning continues
  }
  eq(spawnedTurns > 10 && spawnedTurns < 120, true, "monsters spawn occasionally");
  eq(maxSeen <= M.MAX_ACTIVE, true, "never above MAX_ACTIVE");
  const again = createRng("spawns");
  const idB = createIdCounter("m", 100);
  eq(spawnMonsters([], world, villages, again, { turn: 1, nextId: idB }), spawnMonsters([], world, villages, createRng("spawns"), { turn: 1, nextId: createIdCounter("m", 100) }), "spawning is deterministic");

  // Wandering: stays near home, never too fast, and actually moves
  let wm = [createMonster({ id: "m1", typeId: "wolf_pack", count: 5, ...P(24, 24) })];
  let ww = withMonsterThings(world0(), wm);
  const wr = createRng("wander");
  let moved = false;
  for (let turn = 1; turn <= 60; turn++) {
    const before = wm[0];
    const r = moveMonsters(wm, ww, [], wr, turn);
    wm = r.monsters;
    ww = r.world;
    const step = isqrt(distanceSq(before, wm[0]));
    eq(step <= M.MOVE_PER_TURN * S, true, "no faster than MOVE_PER_TURN");
    eq(isqrt(distanceSq(wm[0], { x: wm[0].homeX, y: wm[0].homeY })) <= (M.ROAM_RADIUS + M.MOVE_PER_TURN) * S, true, "stays near home");
    if (step > 0) moved = true;
  }
  eq(moved, true, "wanders");
  eq(ww.things.find((t) => t.id === "m1").x, wm[0].x, "world things follow the monster");

  // Heads for a village it senses, then stays to raid
  let vm = [createMonster({ id: "m1", typeId: "wolf_pack", count: 5, ...P(24, 24) })];
  const vill = [createVillage({ id: "v1", ...P(28, 24), ownerId: "p1" })]; // 4 tiles away
  let vw = withMonsterThings(world0(), vm);
  const vr = createRng("village");
  for (let turn = 1; turn <= 4; turn++) {
    const r = moveMonsters(vm, vw, vill, vr, turn);
    vm = r.monsters;
    vw = r.world;
  }
  eq(distanceSq(vm[0], vill[0]) <= (M.RAID_RANGE * S) ** 2, true, "monster reached the village");
  const stayed = moveMonsters(vm, vw, vill, vr, 5).monsters[0];
  eq([stayed.x, stayed.y], [vm[0].x, vm[0].y], "monster stays at the village");

  // Raids: a chance each turn, a 10%-50% cut, none while fighting
  const raidRng = createRng("raids");
  let raids = 0;
  let villagesNow = vill;
  for (let turn = 1; turn <= 100; turn++) {
    const found = findRaids(vm, villagesNow, new Set(), raidRng, turn);
    for (const e of found) {
      raids++;
      eq(e.cutPercent >= M.RAID_CUT_MIN_PERCENT && e.cutPercent <= M.RAID_CUT_MAX_PERCENT, true, "cut within range");
      eq(e.villageId, "v1", "raids the village");
    }
    villagesNow = applyRaids(villagesNow, found);
  }
  eq(raids > 10 && raids < 60, true, "raids happen now and then (about 30% of turns)");
  eq(villageIncome(villagesNow[0]) < villageIncome(vill[0]), true, "raids reduced the income");
  eq(findRaids(vm, vill, new Set(["m1"]), createRng("raids"), 1), [], "a fighting monster does not raid");
  eq(findRaids(vm, [createVillage({ id: "far", ...P(2, 2) })], new Set(), createRng("raids"), 1), [], "no raid from far away");

  // Contact with armies: the monster attacks the nearest free army
  const cm = [createMonster({ id: "m1", typeId: "wolf_pack", count: 5, x: 200, y: 200 })];
  let cw = withMonsterThings(addArmy(addArmy(world0(), { id: "A", ownerId: "p1", x: 210, y: 200 }), { id: "B", ownerId: "p2", x: 206, y: 203 }), cm);
  const contacts = findMonsterContacts(cm, cw);
  eq(contacts.length, 1, "one contact per monster");
  eq([contacts[0].armyId, contacts[0].hitFromSide], ["B", "W"], "nearest army, monster is west of it");
  eq(findMonsterContacts(cm, withMonsterThings(addArmy(world0(), { id: "A", ownerId: "p1", x: 400, y: 400 }), cm)), [], "far armies are left alone");

  // A whole turn
  const idC = createIdCounter("m", 500);
  const turnRng = createRng("turn");
  let state = { monsters: [createMonster({ id: "m1", typeId: "wolf_pack", count: 5, x: 200, y: 200 })], world: addArmy(world0(), { id: "A", ownerId: "p1", x: 212, y: 200 }), villages: [] };
  state = { ...state, world: withMonsterThings(state.world, state.monsters) };
  const t = runMonsterTurn(state, turnRng, { turn: 1, nextId: idC });
  eq(t.contacts.length >= 0 && Array.isArray(t.raids) && Array.isArray(t.spawned), true, "turn result shape");
  eq(runMonsterTurn(state, createRng("turn"), { turn: 1, nextId: createIdCounter("m", 500) }), t, "monster turn is deterministic");

  // Fighting: monster attacks an army, then the outcome is written back
  const army = (() => {
    let a = createArmy({ id: "A", ownerId: "p1", facing: "N" });
    a = addStack(a, { typeId: "swordsman", count: 6, formationType: "square" }, { nextId: () => "s1", enforceLimits: false }).army;
    return a;
  })();
  const fm = [createMonster({ id: "m1", typeId: "wolf_pack", count: 3, x: 200, y: 200 })];
  const fw = withMonsterThings(addArmy(world0(), { id: "A", ownerId: "p1", x: 210, y: 200, facing: "N" }), fm);
  const ev = findMonsterContacts(fm, fw)[0];
  const params = toMonsterAttackParams(ev, fm, { A: army }, fw);
  eq([params.attackerArmy.ownerId, params.defenderArmy.id, params.attackerIsInitiator], [MONSTER_OWNER, "A", true], "monster attack params");
  const battle = createBattle({ id: "mb", ...params });
  eq(battle.units.length, 2, "monster fights on the battle grid");
  eq(battle.units.some((u) => u.ownerId === MONSTER_OWNER), true, "monster unit present");
  // The outcome
  const outcomes = getOutcomes(battle);
  const after = applyBattleOutcome(monsterToArmy(fm[0]), outcomes.filter((o) => o.armyId === "m1"));
  const kept = applyMonsterOutcome(fm, fw, "m1", after);
  eq([kept.defeated, kept.monsters[0].count], [false, 3], "survivors stay");
  const dead = applyMonsterOutcome(fm, fw, "m1", { ...after, stacks: [] });
  eq([dead.defeated, dead.monsters.length, dead.world.things.length], [true, 0, 0], "defeated monster disappears");
  const wounded = applyMonsterOutcome(fm, fw, "m1", { ...after, stacks: [{ ...after.stacks[0], count: 2, carry: 7 }] });
  eq([wounded.monsters[0].count, wounded.monsters[0].carry], [2, 7], "wounds persist on the monster");
  eq(monsterToArmy({ ...fm[0], carry: 7 }).stacks[0].carry, 7, "wound goes into the battle army");

  // An army walks into a monster (overworld thing_contact)
  const mw0 = withMonsterThings(addArmy(world0(), { id: "A", ownerId: "p1", x: 100, y: 200, facing: "E" }), [createMonster({ id: "m1", typeId: "wolf_pack", count: 4, x: 200, y: 200, facing: "W" })]);
  const walk = resolveMovement(mw0, [{ armyId: "A", target: { x: 400, y: 200 } }]);
  eq(walk.events[0].type, "thing_contact", "army stops at the monster");
  const wp = toArmyAttackParams(walk.events[0], [mw0.things.length ? createMonster({ id: "m1", typeId: "wolf_pack", count: 4, x: 200, y: 200, facing: "W" }) : null], { A: army }, walk.world);
  eq([wp.attackerArmy.id, wp.defenderArmy.id, wp.hitFromSide, wp.attackerIsInitiator], ["A", "m1", "W", true], "army attack params");

  // Loading
  eq(deserializeMonsters([{ id: "a", typeId: "wolf_pack", count: 3, x: 1, y: 2, homeX: 1, homeY: 2 }, { id: "b", typeId: "swordsman", count: 3, x: 1, y: 2, homeX: 1, homeY: 2 }, { id: "c", typeId: "wolf_pack", count: 0, x: 1, y: 2, homeX: 1, homeY: 2 }]).map((m) => m.id), ["a"], "bad saved monsters dropped");

  return true;
}

export default {
  MONSTER_OWNER,
  createMonster,
  getMonster,
  withMonsterThings,
  moveMonsters,
  findMonsterContacts,
  findRaids,
  spawnMonsters,
  runMonsterTurn,
  monsterToArmy,
  toMonsterAttackParams,
  toArmyAttackParams,
  applyMonsterOutcome,
  deserializeMonsters,
  monstersSelfTest,
};
