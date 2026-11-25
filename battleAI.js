// battleAI.js
// A simple battle AI. It plays the ACTIVE unit's activation using only the
// same actions a player has (battleGrid.js), so it can run enemy armies in
// World Battle vs AI, fill empty PvP slots, and take over a player who
// disconnected.
//
// ---------------------------------------------------------------
// WHAT IT DOES (version 1, deliberately simple)
// ---------------------------------------------------------------
//  For the active unit it looks at every square it could stand on (where it
//  is now plus everything reachable) and every enemy it could attack from
//  there, and scores each option:
//      score = estimated damage (capped at the target's remaining health)
//              + 100 if the attack would destroy the target
//              - estimated counterattack damage (0 if the attack kills the
//                target, or if the target cannot reach back)
//  The estimate uses the real rules: average roll, attackers exposed on that
//  side, the front/side/rear multiplier, and the target's shield. Because of
//  that it prefers flank and rear attacks, finishing weak stacks, and
//  shooting from range at melee units, without any special code for them.
//  Ties go to the smaller move, then y, then x, then target id.
//
//  If nothing can be attacked this activation, it moves as close as it can
//  to the nearest enemy. At the end of the activation a line formation turns
//  to face the nearest enemy (a square keeps its facing).
//
//  It does not switch formations, protect its ranged units, or plan ahead.
//
// DETERMINISM
//  Decisions use no randomness and no clocks, only the battle state, so the
//  same state always gives the same plan. The only random numbers come from
//  the attack itself (the battle's rng stream, as for a player).
//
// LOGGING
//  Every function returns the actions it took as plain data:
//      { unitId, type: "move" | "attack" | "end", ... }
//  Write these to the match record like any player action, so every client
//  replays the same sequence with battleGrid.applyBattleAction().

import { CONFIG } from "./config.js";
import { getUnitType } from "./unitTypes.js";
import { statsAtLevel } from "./progression.js";
import { countAttackers } from "./formation.js";
import { calcDamage, getAttackClass, getHitFromSide, totalHealth } from "./battleRules.js";
import {
  getActiveUnit,
  getReachableCells,
  listLivingUnits,
  manhattan,
  applyBattleAction,
} from "./battleGrid.js";

const OPPOSITE = CONFIG.FACING.OPPOSITE;
const CLASS = CONFIG.FACING.ATTACK_CLASS;
const C = CONFIG.COMBAT;
const KILL_BONUS = 100;

const ok = (extra) => ({ ok: true, ...extra });
const fail = (code, reason) => ({ ok: false, code, reason });

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------
// Estimating an attack
// ---------------------------------------------------------------

function averageRoll(unit) {
  const s = statsAtLevel(unit.typeId, unit.level);
  return Math.floor((s.damageMin + s.damageMax) / 2);
}

// Scores attacking `target` from `cell`. Returns null if it is not possible.
function evaluateAttack(unit, cell, target) {
  const distance = manhattan(cell, target);
  if (distance > getUnitType(unit.typeId).attackRange) return null;
  const hitFromSide = getHitFromSide(cell, { x: target.x, y: target.y });
  if (hitFromSide === null) return null;
  const attackers = countAttackers(unit.formation, OPPOSITE[hitFromSide]);
  if (attackers === 0) return null;

  const attackClass = getAttackClass(target, hitFromSide);
  const targetType = getUnitType(target.typeId);

  const damage = calcDamage({
    rollValue: averageRoll(unit),
    attackers,
    multiplierPercent: C.ATTACK_MULTIPLIER[attackClass],
    reductionPercent: attackClass === CLASS.FRONT ? targetType.faceDefense : 0,
  });
  const health = totalHealth(target);
  const kills = damage >= health;

  let counter = 0;
  if (!kills && targetType.attackRange >= distance) {
    const counterers = countAttackers(target.formation, hitFromSide);
    if (counterers > 0) {
      counter = calcDamage({
        rollValue: averageRoll(target),
        attackers: counterers,
        multiplierPercent: C.COUNTER_MULTIPLIER[attackClass],
        reductionPercent: C.FACE_DEFENSES_ACTIVE_ON_COUNTER ? getUnitType(unit.typeId).faceDefense : 0,
      });
    }
  }

  const score = Math.min(damage, health) + (kills ? KILL_BONUS : 0) - counter;
  return { targetId: target.id, hitFromSide, attackClass, distance, score };
}

// Better option first: higher score, smaller move, then y, x, target id.
function compareOptions(a, b) {
  return b.score - a.score || a.cell.cost - b.cell.cost || a.cell.y - b.cell.y || a.cell.x - b.cell.x || cmp(a.targetId, b.targetId);
}

function nearestEnemy(from, enemies) {
  return enemies
    .slice()
    .sort((a, b) => manhattan(from, a) - manhattan(from, b) || cmp(a.id, b.id))[0];
}

// ---------------------------------------------------------------
// Planning one activation
// ---------------------------------------------------------------

// The actions the AI would take for the active unit, as data (without
// unitId). Does not change the state.
export function planActivation(state) {
  const unit = getActiveUnit(state);
  if (!unit || state.over) return [];
  const act = state.active;
  const enemies = listLivingUnits(state).filter((u) => u.ownerId !== unit.ownerId);
  if (enemies.length === 0) return [{ type: "end" }];

  const plan = [];
  let pos = { x: unit.x, y: unit.y };
  let focus = nearestEnemy(pos, enemies);

  if (!act.attacked && !act.switched) {
    const cells = [{ x: unit.x, y: unit.y, cost: 0 }].concat(getReachableCells(state));

    // Best (square, target) pair.
    let best = null;
    for (const cell of cells) {
      for (const target of enemies) {
        const ev = evaluateAttack(unit, cell, target);
        if (!ev) continue;
        const option = { ...ev, cell };
        if (best === null || compareOptions(option, best) < 0) best = option;
      }
    }

    if (best) {
      if (best.cell.cost > 0) plan.push({ type: "move", x: best.cell.x, y: best.cell.y });
      plan.push({ type: "attack", targetId: best.targetId });
      pos = { x: best.cell.x, y: best.cell.y };
      focus = enemies.find((e) => e.id === best.targetId);
    } else {
      // Nothing to attack: get as close as possible to the nearest enemy.
      const here = manhattan(pos, focus);
      let bestCell = null;
      for (const cell of cells) {
        const d = manhattan(cell, focus);
        if (d >= here) continue;
        if (
          bestCell === null ||
          d < bestCell.d ||
          (d === bestCell.d && (cell.cost < bestCell.cell.cost || (cell.cost === bestCell.cell.cost && (cell.y < bestCell.cell.y || (cell.y === bestCell.cell.y && cell.x < bestCell.cell.x)))))
        ) {
          bestCell = { cell, d };
        }
      }
      if (bestCell) {
        plan.push({ type: "move", x: bestCell.cell.x, y: bestCell.cell.y });
        pos = { x: bestCell.cell.x, y: bestCell.cell.y };
      }
    }
  }

  // End the activation. A line turns its front toward the focus enemy.
  const end = { type: "end" };
  if (unit.formation.type === "line") {
    const side = getHitFromSide({ x: focus.x, y: focus.y }, pos);
    if (side !== null) end.facing = side;
  }
  plan.push(end);
  return plan;
}

// ---------------------------------------------------------------
// Playing activations
// ---------------------------------------------------------------

// Plays the active unit's whole activation. Returns
//   { ok, state, actions, reports, awards, turnEnded, over }
// actions: what was done, as data, each with the unitId.
// reports: the battle report of each attack (for animation).
// awards:  XP awards from any turn or battle that ended (progression.js).
export function takeTurn(state, rng) {
  const unit = getActiveUnit(state);
  if (!unit || state.over) return fail("no_active_unit", "There is no unit to play.");
  const unitId = unit.id;

  let s = state;
  const actions = [];
  const reports = [];
  let awards = [];
  let turnEnded = false;
  let over = false;

  for (const step of planActivation(state)) {
    const res = applyBattleAction(s, step, rng);
    if (!res.ok) {
      // A failed move or attack is skipped. Failing to end is a real error.
      if (step.type === "end") return fail("ai_error", `The AI could not end its activation: ${res.reason}`);
      continue;
    }
    s = res.state;
    actions.push({ unitId, ...step });
    if (res.report) reports.push(res.report);
    if (res.awards) awards = awards.concat(res.awards);
    if (res.turnEnded) turnEnded = true;
    if (s.over) {
      over = true;
      break;
    }
  }
  return ok({ state: s, actions, reports, awards, turnEnded, over });
}

// Is the active unit controlled by the AI?
export function isAiTurn(state, aiOwnerIds) {
  const unit = getActiveUnit(state);
  return !!unit && aiOwnerIds.includes(unit.ownerId);
}

// Plays activations for as long as the active unit belongs to an AI owner,
// then stops (at a human's unit, or when the battle ends).
//   aiOwnerIds   owners the AI controls: enemy armies, empty PvP slots, or a
//                player who disconnected. To hand control back when they
//                reconnect, just remove them from this list; the AI will not
//                touch their next activation.
// Returns { ok, state, actions, reports, awards, turnEnded, over }.
export function playAiActivations(state, aiOwnerIds, rng, { maxActivations = 200 } = {}) {
  let s = state;
  const actions = [];
  const reports = [];
  let awards = [];
  let turnEnded = false;
  let over = s.over;

  for (let i = 0; i < maxActivations && !s.over && isAiTurn(s, aiOwnerIds); i++) {
    const res = takeTurn(s, rng);
    if (!res.ok) return res;
    s = res.state;
    actions.push(...res.actions);
    reports.push(...res.reports);
    awards = awards.concat(res.awards);
    turnEnded = turnEnded || res.turnEnded;
    over = res.over;
  }
  return ok({ state: s, actions, reports, awards, turnEnded, over });
}

// ---------------------------------------------------------------
// Self test (from the browser console:
//   import("./rng.js").then(m => battleAISelfTest(m.createRng)) )
// ---------------------------------------------------------------

import { createArmy, addStack } from "./army.js";
import { createBattle, placeUnit, getUnit } from "./battleGrid.js";

export function battleAISelfTest(createRng) {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`battleAISelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mkArmy = (id, ownerId, facing, stacks) => {
    let army = createArmy({ id, ownerId, facing });
    for (const spec of stacks) {
      const r = addStack(army, spec, { nextId: () => spec.id, enforceLimits: false });
      if (!r.ok) throw new Error(r.reason);
      army = r.army;
    }
    return army;
  };

  // --- Prefers the rear: a swordsman can reach the rear (cost 2) or a side (cost 2) ---
  const attackerArmy = mkArmy("A", "p1", "N", [{ id: "s1", typeId: "swordsman", count: 6, formationType: "square" }]);
  const defenderArmy = mkArmy("B", "p2", "N", [{ id: "e1", typeId: "spearman", count: 6, formationType: "line" }]);
  let b = createBattle({ id: "t1", attackerArmy, defenderArmy, hitFromSide: "S" });
  b = placeUnit(placeUnit(b, "e1", 3, 1), "s1", 4, 3);
  eq(getActiveUnit(b).id, "s1", "attacker acts first (flank)");
  const plan = planActivation(b);
  eq(plan[0], { type: "move", x: 3, y: 2 }, "moves to the rear of the line");
  eq(plan[1], { type: "attack", targetId: "e1" }, "then attacks");
  eq(plan[2].type, "end", "then ends");

  // --- Archers shoot from range, with no counter ---
  const archers = mkArmy("A", "p1", "N", [{ id: "a1", typeId: "archer", count: 3, formationType: "line" }]);
  const sword = mkArmy("B", "p2", "N", [{ id: "e1", typeId: "swordsman", count: 5, formationType: "line" }]);
  let r = createBattle({ id: "t2", attackerArmy: archers, defenderArmy: sword, hitFromSide: "S" });
  r = placeUnit(placeUnit(r, "e1", 3, 1), "a1", 3, 4);
  const shot = takeTurn(r, createRng("archer"));
  eq(shot.ok, true, "archer turn ok");
  eq(shot.actions.map((a) => a.type), ["attack", "end"], "archer shoots without moving");
  eq(shot.reports[0].counter, null, "no counter at range");
  eq(shot.actions[1].facing, "N", "line turns to face the enemy");

  // --- Approaches when nothing is in reach ---
  const far1 = mkArmy("A", "p1", "N", [{ id: "s1", typeId: "swordsman", count: 4, formationType: "square" }]);
  const far2 = mkArmy("B", "p2", "N", [{ id: "e1", typeId: "swordsman", count: 4, formationType: "square" }]);
  let f = createBattle({ id: "t3", attackerArmy: far1, defenderArmy: far2, hitFromSide: "S" });
  f = placeUnit(placeUnit(f, "e1", 0, 0), "s1", 9, 7);
  const approach = planActivation(f);
  eq(approach.map((a) => a.type), ["move", "end"], "moves toward the enemy");
  eq(approach.length === 2 && !("facing" in approach[1]), true, "a square keeps its facing");

  // --- A full AI vs AI battle ends and is deterministic ---
  const fullBattle = (seed) => {
    const a = mkArmy("A1", "p1", "N", [
      { id: "s1", typeId: "swordsman", count: 6, formationType: "square" },
      { id: "a1", typeId: "archer", count: 3, formationType: "line" },
    ]);
    const d = mkArmy("A2", "p2", "N", [
      { id: "e1", typeId: "spearman", count: 6, formationType: "line" },
      { id: "e2", typeId: "swordsman", count: 4, formationType: "square" },
    ]);
    const battle = createBattle({ id: "t4", attackerArmy: a, defenderArmy: d, hitFromSide: "S" });
    return playAiActivations(battle, ["p1", "p2"], createRng(seed));
  };
  const one = fullBattle("seed-1");
  eq(one.ok, true, "full battle ok");
  eq(one.over, true, "full battle ends");
  eq(one.actions.length > 5, true, "the AI did things");
  eq(one.awards.length > 0, true, "XP awards produced");
  eq(fullBattle("seed-1").actions, one.actions, "same seed, same actions");
  eq(one.state.winnerOwnerId === "p1" || one.state.winnerOwnerId === "p2" || one.state.winnerOwnerId === null, true, "valid winner");

  // --- Takeover: the AI plays p1 only and stops at a human unit ---
  const a2 = mkArmy("A1", "p1", "N", [{ id: "s1", typeId: "swordsman", count: 6, formationType: "square" }]);
  const d2 = mkArmy("A2", "p2", "N", [{ id: "e1", typeId: "spearman", count: 6, formationType: "line" }]);
  const t = createBattle({ id: "t5", attackerArmy: a2, defenderArmy: d2, hitFromSide: "S" });
  const handoff = playAiActivations(t, ["p1"], createRng("handoff"));
  eq(handoff.actions.every((x) => x.unitId === "s1"), true, "AI only played its own unit");
  eq(getActiveUnit(handoff.state).ownerId, "p2", "stopped at the human's unit");
  eq(isAiTurn(handoff.state, ["p1"]), false, "not the AI's turn any more");
  eq(getUnit(handoff.state, "s1") !== null, true, "state intact");

  return true;
}

export default {
  planActivation,
  takeTurn,
  isAiTurn,
  playAiActivations,
  battleAISelfTest,
};

