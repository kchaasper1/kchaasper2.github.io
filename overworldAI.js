// overworldAI.js
// Decides what AI-controlled owners do on the overworld each world turn:
// the enemy armies of World Battle vs AI, AI players in PvP, and a player who
// disconnected. It only produces ORDERS, the same plain objects a player
// submits to turnResolver.beginTurn(), so everything it wants goes through
// the same checks and rules as a human's orders. (Fights are played by
// battleAI.js, not here.)
//
// ---------------------------------------------------------------
// WHAT IT DOES (version 1, deliberately simple)
// ---------------------------------------------------------------
//  Each army, one at a time (in id order):
//   1. SMALL ARMIES JOIN. An army with SMALL_ARMY_UNITS units or fewer (fresh
//      recruits) walks to the nearest bigger army of its owner and, once
//      within transfer range, hands over all its stacks (it then vanishes).
//   2. ENEMIES NEARBY. If an enemy army is within AGGRESSION_RANGE tiles:
//        - strong enough (strength >= ATTACK_STRENGTH_PERCENT of the enemy's):
//          chase it;
//        - much weaker (below FLEE_STRENGTH_PERCENT) and within FLEE_RANGE:
//          run straight away from it;
//        - otherwise hold its ground.
//   3. VILLAGES. Otherwise head for the nearest village it does not own.
//      Two of its armies never go for the same village while another is free.
//      Once within capture range it stays put until the end of the turn,
//      which captures the village.
//   4. If it owns every village, it hunts the nearest enemy army it is strong
//      enough to beat, or else wanders within ROAM_RADIUS tiles.
//  Armies end the turn facing the way they are going.
//
//  An owner with an economy (a player) also HIRES: at one village it holds,
//  up to HIRE_BATCH units of the type it has the fewest of, while it keeps
//  HIRE_RESERVE_TURNS turns of salary in reserve and has no debt. The new
//  army appears at the village and joins a bigger army next turn (step 1).
//
//  Strength is a rough number: for each stack, units x average damage x
//  health (with the owner's levels). It is compared with integers only.
//
// DETERMINISM
//  Decisions depend only on the game state and the seed (wandering uses a
//  stream forked by owner, turn and army). Every client therefore computes
//  the same orders. In PvP, still write the orders into the match record like
//  a player's, so a later change to this file never alters an old match.
//
// LIMITS
//  It goes straight lines (no pathfinding yet), ignores monsters, does not
//  switch formations, and does not coordinate attacks between armies.

import { CONFIG } from "./config.js";
import { createMatchStreams } from "./rng.js";
import { listAvailableTypes } from "./unitTypes.js";
import { statsAtLevel, statsFromState } from "./progression.js";
import { distanceSq, isqrt, getMoveDistance } from "./overworld.js";
import { CAPTURE_RANGE_SUBTILES } from "./villages.js";
import { createArmy, maxAddable, armyUnitCount, getRosterUsage, MAX_STACKS_PER_ARMY } from "./army.js";
import { totalSalary } from "./economy.js";

const AI = CONFIG.OVERWORLD_AI;
const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;
const PERCENT = CONFIG.MATH.PERCENT;

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function divTrunc(a, b) {
  return (a - (a % b)) / b;
}

function facingToward(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return "N";
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

// ---------------------------------------------------------------
// Strength
// ---------------------------------------------------------------

// A rough fighting strength for an army, as an integer.
export function armyStrength(game, army) {
  const progression = game.progression[army.ownerId];
  let total = 0;
  for (const s of army.stacks) {
    const stats = progression ? statsFromState(progression, s.typeId) : statsAtLevel(s.typeId, 1);
    const average = Math.floor((stats.damageMin + stats.damageMax) / 2);
    total += s.count * average * stats.health;
  }
  return total;
}

// ---------------------------------------------------------------
// Planning one owner's orders
// ---------------------------------------------------------------

// Returns { orders, notes }. notes are short strings saying why, for
// debugging and for a "what is the AI doing" log.
export function planOwnerOrders(game, ownerId) {
  const orders = [];
  const notes = [];
  if (game.over) return { orders, notes };

  const world = game.world;
  const maxX = world.widthTiles * S - 1;
  const maxY = world.heightTiles * S - 1;
  const clamp = (p) => ({ x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) });
  const where = (id) => world.armies.find((a) => a.id === id);

  const mine = game.armies.filter((a) => a.ownerId === ownerId).sort((a, b) => cmp(a.id, b.id));
  const enemies = game.armies.filter((a) => a.ownerId !== ownerId).sort((a, b) => cmp(a.id, b.id));
  const power = new Map(game.armies.map((a) => [a.id, armyStrength(game, a)]));
  const rng = createMatchStreams(game.seed).ai.fork(`overworld:${ownerId}:${game.turn}`);

  const goTo = (army, target, why) => {
    const me = where(army.id);
    const t = clamp(target);
    if (t.x === me.x && t.y === me.y) return;
    orders.push({ type: "move", armyId: army.id, target: t, facing: facingToward(me, t) });
    notes.push(`${army.id}: ${why}`);
  };

  const nearestOf = (me, list) =>
    list
      .map((e) => ({ e, d2: distanceSq(me, where(e.id)) }))
      .sort((a, b) => a.d2 - b.d2 || cmp(a.e.id, b.e.id))[0] || null;

  const big = mine.filter((a) => armyUnitCount(a) > AI.SMALL_ARMY_UNITS);
  const claimed = new Set();

  for (const army of mine) {
    const me = where(army.id);
    const myPower = power.get(army.id);

    // 1. Small armies join a bigger one.
    if (armyUnitCount(army) <= AI.SMALL_ARMY_UNITS) {
      const room = big.filter((b) => b.stacks.length + army.stacks.length <= MAX_STACKS_PER_ARMY);
      const near = nearestOf(me, room);
      if (near) {
        if (near.d2 <= (CONFIG.OVERWORLD.TRANSFER_RANGE * S) ** 2) {
          for (const s of army.stacks) {
            orders.push({ type: "transfer", fromArmyId: army.id, toArmyId: near.e.id, stackId: s.id, count: s.count });
          }
          notes.push(`${army.id}: joins ${near.e.id}`);
        } else {
          goTo(army, where(near.e.id), `walks to join ${near.e.id}`);
        }
        continue;
      }
    }

    // 2. Enemy armies nearby.
    const foe = nearestOf(me, enemies);
    if (foe && foe.d2 <= (AI.AGGRESSION_RANGE * S) ** 2) {
      const foePower = power.get(foe.e.id);
      if (myPower * PERCENT >= foePower * AI.ATTACK_STRENGTH_PERCENT) {
        goTo(army, where(foe.e.id), `chases ${foe.e.id}`);
      } else if (foe.d2 <= (AI.FLEE_RANGE * S) ** 2 && myPower * PERCENT < foePower * AI.FLEE_STRENGTH_PERCENT) {
        const fp = where(foe.e.id);
        const dx = me.x - fp.x;
        const dy = me.y - fp.y;
        const len = isqrt(dx * dx + dy * dy);
        const step = getMoveDistance(me);
        const away = len === 0 ? { x: me.x, y: me.y + step } : { x: me.x + divTrunc(dx * step, len), y: me.y + divTrunc(dy * step, len) };
        goTo(army, away, `runs from ${foe.e.id}`);
      } else {
        notes.push(`${army.id}: holds against ${foe.e.id}`);
      }
      continue;
    }

    // 3. Villages it does not own.
    const targets = game.villages
      .filter((v) => v.ownerId !== ownerId && !claimed.has(v.id))
      .map((v) => ({ v, d2: distanceSq(me, v) }))
      .sort((a, b) => a.d2 - b.d2 || cmp(a.v.id, b.v.id));
    if (targets.length > 0) {
      const { v, d2 } = targets[0];
      claimed.add(v.id);
      if (d2 <= CAPTURE_RANGE_SUBTILES * CAPTURE_RANGE_SUBTILES) notes.push(`${army.id}: captures ${v.id}`);
      else goTo(army, { x: v.x, y: v.y }, `heads for village ${v.id}`);
      continue;
    }

    // 4. Everything is owned: hunt, or wander.
    if (foe && myPower * PERCENT >= power.get(foe.e.id) * AI.ATTACK_STRENGTH_PERCENT) {
      goTo(army, where(foe.e.id), `hunts ${foe.e.id}`);
      continue;
    }
    const r = rng.fork(army.id);
    const R = AI.ROAM_RADIUS * S;
    goTo(army, { x: me.x + r.nextInt(-R, R), y: me.y + r.nextInt(-R, R) }, "wanders");
  }

  planHiring(game, ownerId, mine, orders, notes);
  return { orders, notes };
}

// Hiring for owners with an economy.
function planHiring(game, ownerId, mine, orders, notes) {
  const economy = game.economies[ownerId];
  if (!economy || economy.debt > 0) return;
  const villages = game.villages.filter((v) => v.ownerId === ownerId && v.canHire).sort((a, b) => cmp(a.id, b.id));
  if (villages.length === 0) return;

  const unlockedIds = game.unlocked[ownerId] || [];
  const types = listAvailableTypes(unlockedIds).filter((t) => t.hireable);
  if (types.length === 0) return;

  const have = getRosterUsage(mine).byType;
  const pick = types
    .slice()
    .sort((a, b) => (have[a.id] || 0) - (have[b.id] || 0) || a.hireCost - b.hireCost || cmp(a.id, b.id))[0];

  const reserve = totalSalary(mine) * AI.HIRE_RESERVE_TURNS;
  const byGold = Math.floor((economy.gold - reserve) / pick.hireCost);
  const dummy = createArmy({ id: "__ai_planning__", ownerId });
  const byLimits = maxAddable(dummy, pick.id, { armies: mine, unlockedIds });
  const count = Math.min(AI.HIRE_BATCH, byGold, byLimits);
  if (count < 1) return;

  orders.push({ type: "hire", villageId: villages[0].id, typeId: pick.id, count });
  notes.push(`${ownerId}: hires ${count} ${pick.id} at ${villages[0].id}`);
}

// ---------------------------------------------------------------
// Planning for several owners
// ---------------------------------------------------------------

// Orders for every AI-controlled owner: { [ownerId]: [order, ...] }.
// aiOwnerIds: the enemy owner, AI players, a disconnected player...
// Pass the result (merged with the humans' orders) to turnResolver.beginTurn.
export function planOrders(game, aiOwnerIds) {
  const out = {};
  for (const ownerId of [...new Set(aiOwnerIds)].sort()) out[ownerId] = planOwnerOrders(game, ownerId).orders;
  return out;
}

// Same, with the reasons: { orders, notes } where notes is a flat list.
export function planOrdersDetailed(game, aiOwnerIds) {
  const orders = {};
  const notes = [];
  for (const ownerId of [...new Set(aiOwnerIds)].sort()) {
    const r = planOwnerOrders(game, ownerId);
    orders[ownerId] = r.orders;
    notes.push(...r.notes);
  }
  return { orders, notes };
}

// ---------------------------------------------------------------
// Self test (call overworldAISelfTest() from the browser console)
// ---------------------------------------------------------------

import { generateWorldBattle } from "./mapGenerator.js";
import { createGame, beginTurn, runAiBattles } from "./turnResolver.js";
import { placeArmy, tileToPoint } from "./overworld.js";

export function overworldAISelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`overworldAISelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const aiGame = (seed = "oa") => createGame({ map: generateWorldBattle({ seed, mode: "ai", players: [{ ownerId: "p1" }] }) });
  const enemyIds = (g) => g.armies.filter((a) => a.ownerId === "ai").map((a) => a.id);
  const setStacks = (g, id, count) => ({ ...g, armies: g.armies.map((a) => (a.id === id ? { ...a, stacks: a.stacks.map((s) => ({ ...s, count })) } : a)) });
  const place = (g, id, x, y) => ({ ...g, world: placeArmy(g.world, id, x, y) });

  // Each enemy army heads for a different village
  const g = aiGame();
  const plan = planOrdersDetailed(g, ["ai"]);
  const moves = plan.orders.ai.filter((o) => o.type === "move");
  eq(moves.length > 0, true, "enemy armies get move orders");
  eq(plan.notes.every((n) => /village|chases|wanders|captures|holds|runs/.test(n)), true, "every order has a reason");
  const villageTargets = new Set(moves.map((m) => `${m.target.x},${m.target.y}`));
  eq(villageTargets.size, moves.length, "no two armies go to the same place");
  eq(planOrders(g, ["ai"]), planOrders(g, ["ai", "ai"]), "owners are deduplicated");
  eq(JSON.stringify(planOrders(g, ["ai"])), JSON.stringify(planOrders(g, ["ai"])), "deterministic");

  // Chase a weaker enemy, run from a stronger one
  const [e1] = enemyIds(g);
  const mine = g.armies.find((a) => a.ownerId === "p1").id;
  const e1pos = g.world.armies.find((a) => a.id === e1);
  const near = place(g, mine, e1pos.x + 10 * S, e1pos.y);
  const weakMe = setStacks(near, mine, 1);
  const strongEnemy = setStacks(weakMe, e1, 30);
  const chase = planOwnerOrders(setStacks(near, mine, 1), "ai").orders.find((o) => o.armyId === e1);
  const me = near.world.armies.find((a) => a.id === mine);
  eq(chase.target, { x: me.x, y: me.y }, "a stronger army chases the player");
  const flee = planOwnerOrders(setStacks(place(g, mine, e1pos.x + 6 * S, e1pos.y), mine, 40), "ai").orders.find((o) => o.armyId === e1);
  eq(flee.target.x < e1pos.x, true, "a much weaker army runs away from the player");
  eq(flee.facing === "W" || flee.facing === "N" || flee.facing === "S", true, "and faces the way it runs");
  // Neither strong nor weak enough (50% to 80% of the player's strength): it holds
  const base = place(g, mine, e1pos.x + 6 * S, e1pos.y);
  let holdGame = null;
  for (let k = 1; k <= 300 && !holdGame; k++) {
    const trial = setStacks(base, mine, k);
    const e = armyStrength(trial, trial.armies.find((a) => a.id === e1));
    const p = armyStrength(trial, trial.armies.find((a) => a.id === mine));
    if (e * 100 >= p * AI.FLEE_STRENGTH_PERCENT && e * 100 < p * AI.ATTACK_STRENGTH_PERCENT) holdGame = trial;
  }
  eq(holdGame !== null, true, "found an evenly matched case");
  eq(planOwnerOrders(holdGame, "ai").orders.some((o) => o.armyId === e1), false, "an evenly matched army holds");

  // Within capture range of its target village: stay put to capture it
  const vil = g.villages.find((v) => v.ownerId === null);
  const camped = place(g, e1, vil.x + 10, vil.y);
  const campedPlan = planOwnerOrders({ ...camped, villages: camped.villages.filter((v) => v.id === vil.id || v.ownerId !== null) }, "ai");
  eq(campedPlan.orders.some((o) => o.armyId === e1 && o.type === "move"), false, "armies at their village wait to capture it");

  // Small armies join a bigger one
  const [a1, a2] = enemyIds(g);
  const small = setStacks(g, a2, 2);
  const smallPos = small.world.armies.find((a) => a.id === a1);
  const walking = planOwnerOrders(setStacks(small, a1, 6), "ai").orders.find((o) => o.armyId === a2);
  eq(walking.type, "move", "a small army walks to a bigger one");
  const joined = planOwnerOrders(place(setStacks(setStacks(g, a2, 2), a1, 6), a2, smallPos.x + 8, smallPos.y), "ai").orders.filter((o) => o.type === "transfer");
  eq(joined.length > 0 && joined.every((o) => o.fromArmyId === a2 && o.toArmyId === a1), true, "and hands over its stacks when close");

  // AI players hire, within their means
  const pvp = createGame({ map: generateWorldBattle({ seed: "hire", mode: "pvp", players: [{ ownerId: "p1" }, { ownerId: "p2", isAI: true }] }) });
  const hires = planOwnerOrders(pvp, "p2").orders.filter((o) => o.type === "hire");
  eq(hires.length, 1, "an AI player with gold hires");
  eq(["swordsman", "spearman"].includes(hires[0].typeId) && hires[0].count >= 1 && hires[0].count <= AI.HIRE_BATCH, true, "a sensible hire");
  const broke = { ...pvp, economies: { ...pvp.economies, p2: { gold: 5, debt: 0 } } };
  eq(planOwnerOrders(broke, "p2").orders.some((o) => o.type === "hire"), false, "no hiring without gold to spare");
  const indebted = { ...pvp, economies: { ...pvp.economies, p2: { gold: 500, debt: 10 } } };
  eq(planOwnerOrders(indebted, "p2").orders.some((o) => o.type === "hire"), false, "no hiring while in debt");
  eq(planOwnerOrders(g, "ai").orders.some((o) => o.type === "hire"), false, "enemy raiders have no economy, so no hiring");

  // Raiders are eliminated when they have no armies, even holding villages
  let dead = { ...g, armies: g.armies.filter((a) => a.ownerId !== "ai"), world: { ...g.world, armies: g.world.armies.filter((a) => a.ownerId !== "ai") } };
  dead = { ...dead, villages: dead.villages.map((v, i) => (v.ownerId === null && i % 2 === 0 ? { ...v, ownerId: "ai" } : v)) };
  const after = beginTurn(dead, {});
  eq([after.game.over, after.game.winnerOwnerId], [true, "p1"], "eliminating the raiders' armies wins even if they hold villages");

  // The AI plays whole games: every order it makes is accepted
  const rejects = [];
  let play = createGame({ map: generateWorldBattle({ seed: "play", mode: "ai", players: [{ ownerId: "p1" }] }) });
  let enemyVillages = 0;
  let playerHires = 0;
  for (let t = 0; t < 40 && !play.over; t++) {
    const orders = planOrders(play, ["p1", "ai"]);
    playerHires += orders.p1.filter((o) => o.type === "hire").length;
    const res = beginTurn(play, orders);
    if (!res.ok) throw new Error(`overworldAISelfTest: turn ${t} failed: ${res.reason}`);
    rejects.push(...res.rejected.map((r) => `${r.ownerId}/${r.type}/${r.code}`));
    play = res.game;
    for (let i = 0; i < 50 && play.resolution; i++) play = runAiBattles(play, ["p1", "ai", "monsters"]).game;
    enemyVillages = Math.max(enemyVillages, play.villages.filter((v) => v.ownerId === "ai").length);
  }
  eq(rejects, [], "all AI orders were accepted over a whole game");
  eq(play.turn > 5, true, "the game progressed");
  eq(enemyVillages > 0 || play.over, true, "the raiders captured villages (or the game ended)");
  eq(playerHires > 0, true, "the AI player hired troops");

  return true;
}

export default {
  armyStrength,
  planOwnerOrders,
  planOrders,
  planOrdersDetailed,
  overworldAISelfTest,
};
