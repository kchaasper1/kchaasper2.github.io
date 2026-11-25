// battleRules.js
// The rules of one attack-and-counterattack exchange between two stacks.
// Pure logic: no graphics, no grid, no network. battleGrid.js decides WHO
// attacks WHOM and from which side; this file decides what happens.
//
// ---------------------------------------------------------------
// HOW AN EXCHANGE WORKS
// ---------------------------------------------------------------
//  1. ATTACK CLASS. The defender is hit from a side. Compared with the
//     defender's facing that is "front", "side" or "rear". A square has no
//     weak side, so it always counts as "front".
//  2. STRIKE. The attacker's exposed units (formation.js) all deal the
//     SAME shared roll for their unit type. Total damage =
//         roll x attackers x attack multiplier (front 100, side 125, rear 150)
//     then the defender's face defense (shield) reduces it, but only when
//     the hit is "front".
//  3. CASUALTIES. Total damage is turned into dead units using the unit's
//     health. The leftover damage is NOT discarded: it stays on the stack
//     as `carry` (damage on the currently wounded unit). Exposed units die
//     first (formation.js).
//  4. COUNTERATTACK. If the defender survives, still has exposed units on
//     that side, and the attacker is within the defender's range, the
//     defender strikes back with its own shared roll. Counter multiplier is
//     front 100, side 70, rear 40 (a rear hit gives the weakest counter).
//     Per CONFIG.COMBAT.FACE_DEFENSES_ACTIVE_ON_COUNTER the counter ignores
//     face-dependent defenses by default. The defender does NOT stay turned:
//     its facing is unchanged, so it cannot be rear-attacked twice.
//  5. RE-FORM. Both stacks re-form (formation.js). Reserves that step up
//     did not attack in this exchange.
//
// DAMAGE TO DEAD UNITS (carry)
//   health per unit comes from progression.statsAtLevel(). A stack's total
//   health is count x health - carry. Example: 5 swordsmen (30 hp), 40
//   damage = 1 dead + carry 10. Next hit of 25 = total 110 - 25 = 85, so 3
//   alive and carry 5.
//
// ROLLS AND XP
//   Every strike and every counterattack makes a NEW roll for that stack.
//   All units inside the stack deal the same rolled value, so 30 units deal
//   30 times the roll. Other stacks of the same type roll for themselves.
//   Each roll is written to the turn log. XP is worked out at the END of the
//   turn, once it is known how many stacks of each type attacked:
//     contributors = distinct stacks of that (owner, type) that rolled
//     XP per roll  = roll position / contributors   (progression.js)
//   finishTurn() returns one award per roll. Feed them to
//   progression.awardTurnXp() grouped by owner (groupAwardsByOwner).
//
// DETERMINISM
//   All math is integer. The only randomness is rng.rollRange() on the
//   battle's own stream. One draw per strike and one per counterattack,
//   strike first, so both PvP clients replaying the same moves get the same
//   numbers.
//
// COMBATANT (one stack inside a battle)
//   { id, ownerId, typeId, level, carry, formation, ...extras }
//   (extras such as armyId, x, y are kept untouched by every function here)
//   - id          the stack id
//   - level       the owner's level for that type (fixed during the battle,
//                 because levels only change after combat)
//   - carry       damage already on the wounded unit (0..health-1)
//   - formation   formation.js object (count lives in formation.count)
//   Wounds persist: carry comes from the army stack and goes back to it after
//   the battle (see army.applyBattleOutcome) until the stack is healed.
//
// Nothing here edits its inputs. resolveExchange() does append to the turn
// log it is given, so pass a copy if you need the old log (battleGrid does).

import { CONFIG } from "./config.js";
import { getUnitType } from "./unitTypes.js";
import { statsAtLevel } from "./progression.js";
import {
  createFormation,
  applyCasualties,
  countAttackers,
  reform,
  ignoresFlankBonus,
} from "./formation.js";
import { rotateDir } from "./army.js";

const C = CONFIG.COMBAT;
const PERCENT = CONFIG.MATH.PERCENT;
const OPPOSITE = CONFIG.FACING.OPPOSITE;
const DIRS = CONFIG.FACING.DIRECTIONS;
const CLASS = CONFIG.FACING.ATTACK_CLASS;

if (!C.ONE_ROLL_PER_STACK_ATTACK) {
  throw new Error("battleRules: only ONE_ROLL_PER_STACK_ATTACK = true is supported");
}

const ok = (extra) => ({ ok: true, ...extra });
const fail = (code, reason) => ({ ok: false, code, reason });

// ---------------------------------------------------------------
// Combatants
// ---------------------------------------------------------------

export function createCombatant({ id, ownerId, typeId, level = 1, count, formationType, facing = "N", carry = 0 }) {
  getUnitType(typeId); // throws on an unknown type
  if (!Number.isInteger(count) || count < 1) throw new Error("battleRules: count must be an integer >= 1");
  if (!Number.isInteger(carry) || carry < 0) throw new Error("battleRules: carry must be an integer >= 0");
  // A wound can never be as large as a whole unit's health.
  const health = statsAtLevel(typeId, level).health;
  return {
    id,
    ownerId,
    typeId,
    level,
    carry: Math.min(carry, health - 1),
    formation: createFormation(formationType ?? CONFIG.FORMATIONS.DEFAULT, count, facing),
  };
}

// Builds a combatant from an army.js stack. `quarterTurns` rotates the
// stack's local facing onto the battle grid (from the attack direction).
export function combatantFromStack(stack, { ownerId, level = 1, quarterTurns = 0 }) {
  return createCombatant({
    id: stack.id,
    ownerId,
    typeId: stack.typeId,
    level,
    count: stack.count,
    formationType: stack.formationType,
    facing: rotateDir(stack.facing, quarterTurns),
    carry: stack.carry ?? 0,
  });
}

export function combatantCount(c) {
  return c.formation.count;
}

export function isAlive(c) {
  return c.formation.count > 0;
}

function unitHealth(c) {
  return statsAtLevel(c.typeId, c.level).health;
}

// Health left in the whole stack, including the effect of carry.
export function totalHealth(c) {
  const n = combatantCount(c);
  return n === 0 ? 0 : n * unitHealth(c) - c.carry;
}

// ---------------------------------------------------------------
// Sides and attack class
// ---------------------------------------------------------------

// Which side of the defender the attacker is on, from grid cells
// ({ x, y }, x grows east, y grows south). Returns null for the same cell.
// On an exact diagonal the vertical axis wins (N or S), always.
export function getHitFromSide(attackerCell, defenderCell) {
  const dx = attackerCell.x - defenderCell.x;
  const dy = attackerCell.y - defenderCell.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

// "front", "side" or "rear" for a hit on `defender` from `hitFromSide`.
export function getAttackClass(defender, hitFromSide) {
  if (!DIRS.includes(hitFromSide)) throw new Error(`battleRules: bad side "${hitFromSide}"`);
  if (ignoresFlankBonus(defender.formation.type)) return CLASS.FRONT;
  const facing = defender.formation.facing;
  if (hitFromSide === facing) return CLASS.FRONT;
  if (hitFromSide === OPPOSITE[facing]) return CLASS.REAR;
  return CLASS.SIDE;
}

// ---------------------------------------------------------------
// Damage math (integers only)
// ---------------------------------------------------------------

// roll x attackers x multiplier%, then the target's reduction%.
// Each step rounds down.
export function calcDamage({ rollValue, attackers, multiplierPercent, reductionPercent = 0 }) {
  const raw = rollValue * attackers;
  const boosted = Math.floor((raw * multiplierPercent) / PERCENT);
  return Math.floor((boosted * (PERCENT - reductionPercent)) / PERCENT);
}

// Turns damage into dead units. The remainder stays as carry.
// Returns { combatant, killed, damageDealt }. Exposed units die first.
export function applyDamage(combatant, damage, hitFromSide) {
  if (!Number.isInteger(damage) || damage < 0) throw new Error("battleRules: damage must be an integer >= 0");
  const health = unitHealth(combatant);
  const count = combatantCount(combatant);
  const total = totalHealth(combatant);

  const damageDealt = Math.min(damage, total);
  const newTotal = total - damageDealt;
  const newCount = Math.ceil(newTotal / health);
  const newCarry = newCount === 0 ? 0 : newCount * health - newTotal;
  const killed = count - newCount;

  const formation = killed > 0 ? applyCasualties(combatant.formation, hitFromSide, killed).formation : combatant.formation;
  return {
    combatant: { ...combatant, carry: newCarry, formation },
    killed,
    damageDealt,
  };
}

// ---------------------------------------------------------------
// The turn log (rolls and XP)
// ---------------------------------------------------------------

// One per battle turn. Plain JSON, safe to save with the match record.
export function createTurnLog() {
  return { events: [] };
}

// Makes this stack's roll and records it in the log.
function rollForStack(log, combatant, rng, kind) {
  const stats = statsAtLevel(combatant.typeId, combatant.level);
  const r = rng.rollRange(stats.damageMin, stats.damageMax);
  const event = {
    ownerId: combatant.ownerId,
    typeId: combatant.typeId,
    stackId: combatant.id,
    kind,
    value: r.value,
    position: r.position,
  };
  log.events.push(event);
  return event;
}

// Call at the END of a turn. Returns one XP award per roll, in the order the
// rolls happened, grouped by owner and type:
//   [{ ownerId, typeId, position, contributors }]
// contributors = how many distinct stacks of that owner and type rolled
// this turn (counterattacks included).
export function finishTurn(log) {
  const stacks = {};
  for (const e of log.events) {
    const key = `${e.ownerId}|${e.typeId}`;
    (stacks[key] ||= new Set()).add(e.stackId);
  }
  return log.events
    .map((e, i) => ({
      ownerId: e.ownerId,
      typeId: e.typeId,
      position: e.position,
      contributors: stacks[`${e.ownerId}|${e.typeId}`].size,
      i,
    }))
    .sort((a, b) =>
      a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : a.i - b.i
    )
    .map(({ i, ...award }) => award);
}

// { ownerId: [{ typeId, position, contributors }, ...] }
export function groupAwardsByOwner(awards) {
  const out = {};
  for (const a of awards) {
    (out[a.ownerId] ||= []).push({ typeId: a.typeId, position: a.position, contributors: a.contributors });
  }
  return out;
}

// ---------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------

// Resolves one attack and its counterattack.
//   attacker, defender   combatants (different owners)
//   hitFromSide          the side of the DEFENDER the attacker is on
//   distance             grid distance (default 1). The attacker's range
//                        must reach it, and so must the defender's for a
//                        counter.
//   log                  the current turn's log (createTurnLog); rolls are appended
//   rng                  the battle's rng stream
//
// Returns { ok: true, attacker, defender, report } or { ok: false, code, reason }.
export function resolveExchange({ attacker, defender, hitFromSide, distance = 1, log, rng }) {
  if (!DIRS.includes(hitFromSide)) return fail("bad_side", `Bad side "${hitFromSide}".`);
  if (!Number.isInteger(distance) || distance < 1) return fail("bad_distance", "Distance must be a whole number of at least 1.");
  if (!isAlive(attacker) || !isAlive(defender)) return fail("dead_unit", "A destroyed stack cannot fight.");
  if (attacker.ownerId === defender.ownerId) return fail("same_owner", "A stack cannot attack its own side.");

  const attackerType = getUnitType(attacker.typeId);
  const defenderType = getUnitType(defender.typeId);
  if (attackerType.attackRange < distance) return fail("out_of_range", `${attackerType.name} cannot reach that far.`);

  // The attacker faces the defender through this side of its own formation.
  const attackerSide = OPPOSITE[hitFromSide];
  const strikers = countAttackers(attacker.formation, attackerSide);
  if (strikers === 0) return fail("no_attackers", "No unit can attack from that side.");

  const attackClass = getAttackClass(defender, hitFromSide);

  // --- 1. Strike ---------------------------------------------------
  const strikeRoll = rollForStack(log, attacker, rng, "strike");
  const strikeMultiplier = C.ATTACK_MULTIPLIER[attackClass];
  // A shield only works when the hit lands on the front.
  const strikeReduction = attackClass === CLASS.FRONT ? defenderType.faceDefense : 0;
  const strikeDamage = calcDamage({
    rollValue: strikeRoll.value,
    attackers: strikers,
    multiplierPercent: strikeMultiplier,
    reductionPercent: strikeReduction,
  });
  const struck = applyDamage(defender, strikeDamage, hitFromSide);
  let newDefender = struck.combatant;

  const report = {
    attackClass,
    hitFromSide,
    distance,
    strike: {
      ownerId: attacker.ownerId,
      typeId: attacker.typeId,
      rollValue: strikeRoll.value,
      rollPosition: strikeRoll.position,
      attackers: strikers,
      multiplierPercent: strikeMultiplier,
      reductionPercent: strikeReduction,
      damage: strikeDamage,
      killed: struck.killed,
    },
    counter: null,
  };

  // --- 2. Counterattack --------------------------------------------
  let newAttacker = attacker;
  if (isAlive(newDefender) && defenderType.attackRange >= distance) {
    // Survivors counter in place (reserves have not moved up yet).
    const counterers = countAttackers(newDefender.formation, hitFromSide);
    if (counterers > 0) {
      const counterRoll = rollForStack(log, defender, rng, "counter");
      const counterMultiplier = C.COUNTER_MULTIPLIER[attackClass];
      // The attacker is assumed to be facing its target.
      const counterReduction = C.FACE_DEFENSES_ACTIVE_ON_COUNTER ? attackerType.faceDefense : 0;
      const counterDamage = calcDamage({
        rollValue: counterRoll.value,
        attackers: counterers,
        multiplierPercent: counterMultiplier,
        reductionPercent: counterReduction,
      });
      const countered = applyDamage(attacker, counterDamage, attackerSide);
      newAttacker = countered.combatant;
      report.counter = {
        ownerId: defender.ownerId,
        typeId: defender.typeId,
        rollValue: counterRoll.value,
        rollPosition: counterRoll.position,
        attackers: counterers,
        multiplierPercent: counterMultiplier,
        reductionPercent: counterReduction,
        damage: counterDamage,
        killed: countered.killed,
      };
    }
  }

  // --- 3. Re-form --------------------------------------------------
  if (C.RESERVES_ENTER_AFTER_EXCHANGE) {
    newAttacker = { ...newAttacker, formation: reform(newAttacker.formation) };
    newDefender = { ...newDefender, formation: reform(newDefender.formation) };
  }

  return ok({ attacker: newAttacker, defender: newDefender, report });
}

// ---------------------------------------------------------------
// Self test (call battleRulesSelfTest() from the browser console)
// ---------------------------------------------------------------

export function battleRulesSelfTest(createRng) {
  // createRng is passed in so this file does not depend on rng.js.
  // Browser console: import("./rng.js").then(m => battleRulesSelfTest(m.createRng))
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`battleRulesSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mk = (id, ownerId, typeId, count, formationType, facing) =>
    createCombatant({ id, ownerId, typeId, count, formationType, facing });

  // Damage carry: 5 swordsmen, 30 hp each
  let s = mk("s1", "p1", "swordsman", 5, "line", "N");
  let r = applyDamage(s, 40, "N");
  eq([r.killed, r.combatant.carry, combatantCount(r.combatant)], [1, 10, 4], "carry after 40");
  r = applyDamage(r.combatant, 25, "N");
  eq([r.killed, r.combatant.carry, combatantCount(r.combatant)], [1, 5, 3], "carry after 25 more");
  r = applyDamage(s, 9999, "N");
  eq([combatantCount(r.combatant), r.combatant.carry, r.damageDealt], [0, 0, 150], "overkill");

  // Attack class
  const lineN = mk("a", "p1", "spearman", 10, "line", "N");
  eq(getAttackClass(lineN, "N"), "front", "line hit from front");
  eq(getAttackClass(lineN, "S"), "rear", "line hit from rear");
  eq(getAttackClass(lineN, "E"), "side", "line hit from side");
  eq(getAttackClass(mk("b", "p1", "spearman", 10, "square", "N"), "S"), "front", "square always front");

  // Hit side from cells
  eq(getHitFromSide({ x: 3, y: 1 }, { x: 1, y: 1 }), "E", "attacker east");
  eq(getHitFromSide({ x: 2, y: 2 }, { x: 1, y: 1 }), "S", "diagonal goes vertical");

  // Damage formula
  eq(calcDamage({ rollValue: 10, attackers: 5, multiplierPercent: 150, reductionPercent: 30 }), 52, "calcDamage");

  // Exchange: rear attack, with a counter
  const run = (seed) => {
    const rng = createRng(seed);
    const log = createTurnLog();
    const att = mk("att", "p1", "spearman", 10, "line", "N");
    const def = mk("def", "p2", "swordsman", 10, "line", "N");
    // Attacker is south of the defender, so the defender is hit from the rear.
    const res = resolveExchange({ attacker: att, defender: def, hitFromSide: "S", log, rng });
    return { res, log };
  };
  const { res, log } = run("test-seed");
  eq(res.ok, true, "exchange ok");
  eq(res.report.attackClass, "rear", "exchange class");
  eq(res.report.strike.multiplierPercent, 150, "rear strike multiplier");
  eq(res.report.strike.reductionPercent, 0, "shield off on rear hit");
  eq(res.report.counter.multiplierPercent, 40, "rear counter multiplier");
  eq(res.report.counter.reductionPercent, 0, "no shield on counter");
  const expectedStrike = calcDamage({
    rollValue: res.report.strike.rollValue,
    attackers: res.report.strike.attackers,
    multiplierPercent: 150,
  });
  eq(res.report.strike.damage, expectedStrike, "strike damage matches formula");
  eq(log.events.map((e) => e.kind), ["strike", "counter"], "one roll per strike and counter");
  // Determinism
  eq(run("test-seed").res.report, res.report, "same seed, same report");

  // Shield works on a front hit
  const front = resolveExchange({
    attacker: mk("att", "p1", "spearman", 10, "line", "N"),
    defender: mk("def", "p2", "swordsman", 10, "line", "S"),
    hitFromSide: "S", // defender faces S, so this is a front hit
    log: createTurnLog(),
    rng: createRng("shield"),
  });
  eq(front.report.attackClass, "front", "front class");
  eq(front.report.strike.reductionPercent, 30, "shield reduces front hit");

  // Every stack rolls for itself; XP contributors are counted at turn end
  const rng3 = createRng("rolls");
  const turn = createTurnLog();
  const target = mk("t", "p2", "swordsman", 60, "square", "N");
  const first = resolveExchange({ attacker: mk("sp1", "p1", "spearman", 4, "square", "N"), defender: target, hitFromSide: "S", log: turn, rng: rng3 });
  const second = resolveExchange({ attacker: mk("sp2", "p1", "spearman", 4, "square", "N"), defender: first.defender, hitFromSide: "S", log: turn, rng: rng3 });
  eq(turn.events.length, 4, "two strikes and two counters, each rolled");
  const awards = finishTurn(turn);
  const spear = awards.filter((a) => a.ownerId === "p1" && a.typeId === "spearman");
  eq(spear.length, 2, "one award per spearman roll");
  eq(spear.every((a) => a.contributors === 2), true, "two contributing stacks");
  const sword = awards.filter((a) => a.ownerId === "p2");
  eq(sword.length, 2, "counter rolls give XP too");
  eq(sword.every((a) => a.contributors === 1), true, "the defender stack counts once");
  eq(groupAwardsByOwner(awards).p1.length, 2, "grouped by owner");

  // Wounds carry in from the stack
  const wounded = combatantFromStack(
    { id: "w", typeId: "swordsman", count: 3, formationType: "square", facing: "N", carry: 12 },
    { ownerId: "p1" }
  );
  eq(wounded.carry, 12, "carry loaded from the stack");
  eq(totalHealth(wounded), 3 * 30 - 12, "total health includes the wound");

  // Failures
  eq(resolveExchange({ attacker: mk("x", "p1", "spearman", 3, "line", "N"), defender: mk("y", "p1", "swordsman", 3, "line", "N"), hitFromSide: "S", log: createTurnLog(), rng: createRng(1) }).code, "same_owner", "same owner");
  eq(resolveExchange({ attacker: mk("x", "p1", "spearman", 3, "line", "N"), defender: mk("y", "p2", "swordsman", 3, "line", "N"), hitFromSide: "S", distance: 2, log: createTurnLog(), rng: createRng(1) }).code, "out_of_range", "spear range");

  // Archer shoots from distance 3, melee defender cannot counter
  const archer = resolveExchange({
    attacker: mk("ar", "p1", "archer", 4, "line", "N"),
    defender: mk("sw", "p2", "swordsman", 10, "square", "N"),
    hitFromSide: "S",
    distance: 3,
    log: createTurnLog(),
    rng: createRng("arrows"),
  });
  eq(archer.ok, true, "archer ok");
  eq(archer.report.counter, null, "no counter at range");

  return true;
}

export default {
  createCombatant,
  combatantFromStack,
  combatantCount,
  isAlive,
  totalHealth,
  getHitFromSide,
  getAttackClass,
  calcDamage,
  applyDamage,
  createTurnLog,
  finishTurn,
  groupAwardsByOwner,
  resolveExchange,
  battleRulesSelfTest,
};
