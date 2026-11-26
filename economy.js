// economy.js
// Gold, hiring, salaries and desertion. Pure logic: no graphics, no network.
// Every function returns new objects and never edits its inputs. Gold is
// always an integer.
//
// ---------------------------------------------------------------
// WHAT THIS FILE OWNS
// ---------------------------------------------------------------
//  - One player's gold (the economy state).
//  - Hiring units (gold + the authority and unit-type limits of army.js).
//  - The per-turn upkeep: village income in, salaries out.
//  - Desertion when salaries cannot be paid.
//  - The loot function for battle victories (off for now, returns 0).
// It does NOT decide WHERE units can be hired or how much villages pay:
// villages.js does that and passes the amounts in. It does not call
// itself: turnResolver.js runs runUpkeep() at the right step of the turn.
//
// ECONOMY STATE (plain JSON, one per player)
//   { gold }
//
// ---------------------------------------------------------------
// UPKEEP EACH WORLD TURN (CONFIG.TURNS.RESOLUTION_ORDER)
// ---------------------------------------------------------------
//  1. INCOME. Village income is added to gold first.
//  2. SALARIES (every SALARY_PERIOD_TURNS turns). Each unit costs its
//     type's salary. If gold covers everything, everyone is paid. If not,
//     units are paid CHEAPEST FIRST (the reverse of the desertion order)
//     until the gold runs out. Everything after that point is unpaid.
//     There is no debt: unpaid salary is simply not paid.
//  3. DESERTION. Unpaid units desert gradually. Each turn the expected
//     number of deserters is
//         unpaid units x CONFIG.ECONOMY.DESERTION_CHANCE_PER_MILLE / 1000
//     The whole part always deserts, and the fractional part is a chance
//     of one more (one random draw, so the result is deterministic and
//     cheap even for stacks of 100). Deserters are taken from the unpaid
//     units in the desertion order: the most expensive units first.
//  Wounds stay with the stack. A stack that loses all its units disappears.
//
// DETERMINISM
//  Integer math only. The single random draw per player per turn comes from
//  a stream forked from the economy stream by owner and turn, so it never
//  depends on the order players are processed in.

import { CONFIG } from "./config.js";
import { getUnitType, compareForDesertion } from "./unitTypes.js";
import { addStack, addToStack, removeUnits, maxAddable } from "./army.js";

const E = CONFIG.ECONOMY;

if (!Number.isInteger(E.DESERTION_CHANCE_PER_MILLE) || E.DESERTION_CHANCE_PER_MILLE < 0 || E.DESERTION_CHANCE_PER_MILLE > 1000) {
  throw new Error("economy: DESERTION_CHANCE_PER_MILLE must be an integer from 0 to 1000");
}
if (E.LOANS_ENABLED) throw new Error("economy: loans are not implemented yet");

const fail = (code, reason) => ({ ok: false, code, reason });

// ---------------------------------------------------------------
// Gold
// ---------------------------------------------------------------

export function createEconomy(gold = E.START_GOLD) {
  if (!Number.isInteger(gold) || gold < E.MIN_GOLD) throw new Error("economy: gold must be an integer");
  return { gold };
}

export function canAfford(economy, cost) {
  return Number.isInteger(cost) && cost >= 0 && economy.gold >= cost;
}

export function addGold(economy, amount) {
  if (!Number.isInteger(amount) || amount < 0) throw new Error("economy: addGold needs a non-negative integer");
  return { ...economy, gold: economy.gold + amount };
}

// Returns { ok, economy } or { ok: false, code, reason }.
export function spendGold(economy, cost) {
  if (!Number.isInteger(cost) || cost < 0) return fail("bad_amount", "Cost must be a non-negative integer.");
  if (economy.gold < cost) return fail("not_enough_gold", `You need ${cost} gold but have ${economy.gold}.`);
  return { ok: true, economy: { ...economy, gold: economy.gold - cost } };
}

// Makes any saved/received economy state safe.
export function deserializeEconomy(raw) {
  const gold = Math.floor(Number(raw && raw.gold));
  return { gold: Number.isFinite(gold) && gold >= E.MIN_GOLD ? gold : E.START_GOLD };
}

// ---------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------

function replaceArmy(armies, army) {
  return armies.map((a) => (a.id === army.id ? army : a));
}

// Hires `count` units into one of the player's armies.
//   economy, armies   the player's gold and ALL of their armies
//   armyId            which army receives the units
//   typeId, count     what to hire
//   stackId           add to this existing stack; leave out to make a new
//                     stack (then formationType and facing may be given)
//   ctx               { unlockedIds, authorityPool, nextId, enforceLimits }
//                     as in army.js (nextId is needed for a new stack)
// Where hiring is allowed (a village you own) is checked by the caller.
// Returns { ok, economy, armies, cost, stackId } or { ok: false, code, reason }.
export function hireUnits({ economy, armies, armyId, typeId, count, stackId, formationType, facing, ctx = {} }) {
  const army = armies.find((a) => a.id === armyId);
  if (!army) return fail("unknown_army", "That army does not exist.");
  let type;
  try {
    type = getUnitType(typeId);
  } catch (e) {
    return fail("unknown_type", `Unknown unit type "${typeId}".`);
  }
  if (!type.hireable) return fail("not_hireable", `${type.name} cannot be hired.`);
  if (!Number.isInteger(count) || count < 1) return fail("bad_count", "Count must be a whole number of at least 1.");

  const cost = type.hireCost * count;
  if (economy.gold < cost) return fail("not_enough_gold", `You need ${cost} gold but have ${economy.gold}.`);

  const limitCtx = { ...ctx, armies };
  const res = stackId !== undefined
    ? addToStack(army, stackId, count, limitCtx)
    : addStack(army, { typeId, count, formationType, facing }, limitCtx);
  if (!res.ok) return res;

  return {
    ok: true,
    economy: { ...economy, gold: economy.gold - cost },
    armies: replaceArmy(armies, res.army),
    cost,
    stackId: res.stackId,
  };
}

// The most units of a type the player could hire right now (for hire
// screens): limited by gold, authority and the unit-type cap.
export function maxHireable({ economy, armies, armyId, typeId, ctx = {} }) {
  const army = armies.find((a) => a.id === armyId);
  if (!army) return 0;
  const type = getUnitType(typeId);
  if (!type.hireable) return 0;
  const byGold = type.hireCost === 0 ? Infinity : Math.floor(economy.gold / type.hireCost);
  return Math.max(0, Math.min(byGold, maxAddable(army, typeId, { ...ctx, armies })));
}

// ---------------------------------------------------------------
// Upkeep: income and salaries
// ---------------------------------------------------------------

export function isSalaryTurn(turn) {
  return turn % E.SALARY_PERIOD_TURNS === 0;
}

// Total salary of a set of armies for one salary payment.
export function totalSalary(armies) {
  let sum = 0;
  for (const a of armies) for (const s of a.stacks) sum += getUnitType(s.typeId).salary * s.count;
  return sum;
}

// Adds income, then pays salaries cheapest-first until the gold runs out.
//   income   gold from villages this turn (villages.js)
//   turn     the world turn number (decides if salaries are due)
// Returns { economy, report } where report is
//   {
//     salaryTurn, income, salaryDue, salaryPaid,
//     unpaid: [{ armyId, stackId, typeId, units }]   // desertion order
//     unpaidUnits
//   }
// It never changes the armies. Use it with previewUpkeep() to warn the
// player before desertion happens.
export function payUpkeep(economy, armies, { income = 0, turn = 1 } = {}) {
  if (!Number.isInteger(income) || income < 0) throw new Error("economy: income must be a non-negative integer");
  let gold = economy.gold + income;
  const salaryTurn = isSalaryTurn(turn);

  const entries = [];
  for (const a of armies) {
    for (const s of a.stacks) {
      entries.push({ armyId: a.id, stackId: s.id, typeId: s.typeId, count: s.count, salary: getUnitType(s.typeId).salary });
    }
  }
  const byDesertion = entries.slice().sort((x, y) => compareForDesertion({ typeId: x.typeId, id: x.stackId }, { typeId: y.typeId, id: y.stackId }));
  const salaryDue = entries.reduce((n, e) => n + e.salary * e.count, 0);

  if (!salaryTurn) {
    return {
      economy: { ...economy, gold },
      report: { salaryTurn, income, salaryDue: 0, salaryPaid: 0, unpaid: [], unpaidUnits: 0 },
    };
  }

  // Pay in the reverse of the desertion order: the units most likely to
  // desert are paid last.
  let paid = 0;
  let stopped = false;
  const unpaid = [];
  for (const e of byDesertion.slice().reverse()) {
    if (stopped) {
      unpaid.push({ armyId: e.armyId, stackId: e.stackId, typeId: e.typeId, units: e.count });
      continue;
    }
    if (e.salary === 0) continue;
    const payable = Math.min(e.count, Math.floor(gold / e.salary));
    gold -= payable * e.salary;
    paid += payable * e.salary;
    if (payable < e.count) {
      unpaid.push({ armyId: e.armyId, stackId: e.stackId, typeId: e.typeId, units: e.count - payable });
      stopped = true;
    }
  }
  // Back to desertion order (most expensive first).
  unpaid.sort((x, y) => compareForDesertion({ typeId: x.typeId, id: x.stackId }, { typeId: y.typeId, id: y.stackId }));

  return {
    economy: { ...economy, gold },
    report: {
      salaryTurn,
      income,
      salaryDue,
      salaryPaid: paid,
      unpaid,
      unpaidUnits: unpaid.reduce((n, u) => n + u.units, 0),
    },
  };
}

// What would happen next turn, for a warning in the UI. Same numbers as
// payUpkeep plus the expected number of deserters (a fraction is a chance).
export function previewUpkeep(economy, armies, options = {}) {
  const { report } = payUpkeep(economy, armies, options);
  return { ...report, expectedDeserters: (report.unpaidUnits * E.DESERTION_CHANCE_PER_MILLE) / 1000 };
}

// ---------------------------------------------------------------
// Desertion
// ---------------------------------------------------------------

// Removes deserters from the unpaid units.
//   unpaid   report.unpaid from payUpkeep
//   rng      a stream already forked for this player and turn
// Returns { armies, deserters, count }; deserters is
//   [{ armyId, stackId, typeId, count }] in the order they left.
export function applyDesertion(armies, unpaid, rng) {
  const total = unpaid.reduce((n, u) => n + u.units, 0);
  if (total === 0) return { armies, deserters: [], count: 0 };

  const expected = total * E.DESERTION_CHANCE_PER_MILLE; // per-mille units
  const whole = Math.floor(expected / 1000);
  const remainder = expected % 1000;
  // One draw every time there are unpaid units, so call order never varies.
  const extra = rng.nextInt(0, 999) < remainder ? 1 : 0;
  let left = Math.min(total, whole + extra);

  let result = armies;
  const deserters = [];
  for (const u of unpaid) {
    if (left === 0) break;
    const army = result.find((a) => a.id === u.armyId);
    if (!army) continue;
    const take = Math.min(left, u.units);
    const res = removeUnits(army, u.stackId, take);
    if (!res.ok) continue;
    result = replaceArmy(result, res.army);
    deserters.push({ armyId: u.armyId, stackId: u.stackId, typeId: u.typeId, count: res.removed });
    left -= res.removed;
  }
  return { armies: result, deserters, count: deserters.reduce((n, d) => n + d.count, 0) };
}

// Income, salaries and desertion in one call, for turnResolver.js.
//   rng   the economy stream (createMatchStreams(...).economy); it is
//         forked by owner and turn, so players can be processed in any order
// Returns { economy, armies, report } where report also has `deserters`.
export function runUpkeep(economy, armies, { income = 0, turn, ownerId, rng }) {
  const paid = payUpkeep(economy, armies, { income, turn });
  const stream = rng.fork(`upkeep:${ownerId}:${turn}`);
  const out = applyDesertion(armies, paid.report.unpaid, stream);
  return {
    economy: paid.economy,
    armies: out.armies,
    report: { ...paid.report, deserters: out.deserters, deserterCount: out.count },
  };
}

// ---------------------------------------------------------------
// Loot (off for now)
// ---------------------------------------------------------------

// Units an army lost in a battle: [{ typeId, count }], sorted by type.
// Compare the army before the battle with the army after it.
export function lossesBetween(armyBefore, armyAfter) {
  const after = new Map(armyAfter.stacks.map((s) => [s.id, s.count]));
  const byType = {};
  for (const s of armyBefore.stacks) {
    const lost = s.count - (after.get(s.id) ?? 0);
    if (lost > 0) byType[s.typeId] = (byType[s.typeId] || 0) + lost;
  }
  return Object.keys(byType)
    .sort()
    .map((typeId) => ({ typeId, count: byType[typeId] }));
}

// Gold the winner takes from the units it defeated.
//   defeated   [{ typeId, count }] (see lossesBetween)
//   settings   defaults to CONFIG.ECONOMY.LOOT; pass others only in tests
// Returns { gold }. With CONFIG.ECONOMY.LOOT.ENABLED = false (the default)
// this is always 0, so nothing is added to the game yet.
export function calculateLoot(defeated, settings = E.LOOT) {
  if (!settings.ENABLED) return { gold: 0 };
  let hireValue = 0;
  let units = 0;
  for (const d of defeated) {
    hireValue += getUnitType(d.typeId).hireCost * d.count;
    units += d.count;
  }
  const gold = Math.floor((hireValue * settings.PERCENT_OF_HIRE_COST) / CONFIG.MATH.PERCENT) + settings.FIXED_PER_UNIT * units;
  return { gold };
}

// Self test (call from the browser console:
//   import("./rng.js").then(m => economySelfTest(m.createRng)) )
import { createArmy, createIdCounter } from "./army.js";

export function economySelfTest(createRng) {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`economySelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mk = (id, stacks) => {
    let army = createArmy({ id, ownerId: "p1" });
    for (const spec of stacks) army = addStack(army, spec, { nextId: () => spec.id, enforceLimits: false }).army;
    return army;
  };

  // Gold basics
  eq(createEconomy().gold, E.START_GOLD, "start gold");
  eq(spendGold(createEconomy(100), 30).economy.gold, 70, "spend");
  eq(spendGold(createEconomy(10), 30).code, "not_enough_gold", "cannot overspend");
  eq(deserializeEconomy({ gold: "abc" }).gold, E.START_GOLD, "bad saved gold");

  // Salaries covered: swordsman 6 x2 + archer 2 x3 = 18
  const army = mk("A", [
    { id: "s1", typeId: "swordsman", count: 6 },
    { id: "a1", typeId: "archer", count: 2 },
  ]);
  eq(totalSalary([army]), 18, "total salary");
  let up = payUpkeep(createEconomy(100), [army], { income: 5, turn: 1 });
  eq(up.economy.gold, 100 + 5 - 18, "income then salaries");
  eq(up.report.unpaid, [], "everyone paid");

  // Not enough gold: cheapest are paid first, the expensive archers are not
  up = payUpkeep(createEconomy(10), [army], { turn: 1 });
  eq(up.economy.gold, 0, "all gold spent");
  eq(up.report.salaryPaid, 10, "paid 5 swordsmen");
  eq(up.report.unpaid, [
    { armyId: "A", stackId: "a1", typeId: "archer", units: 2 },
    { armyId: "A", stackId: "s1", typeId: "swordsman", units: 1 },
  ], "unpaid in desertion order");
  eq(previewUpkeep(createEconomy(10), [army], { turn: 1 }).expectedDeserters, 3 * 250 / 1000, "expected deserters");

  // Desertion is gradual and prefers expensive units
  const big = mk("A", [
    { id: "s1", typeId: "swordsman", count: 32 },
    { id: "a1", typeId: "archer", count: 8 },
  ]);
  const poor = createEconomy(0);
  const paid = payUpkeep(poor, [big], { turn: 1 });
  eq(paid.report.unpaidUnits, 40, "everyone unpaid");
  const gone = applyDesertion([big], paid.report.unpaid, createRng("d1"));
  eq(gone.count, 10, "40 x 25% = 10 deserters");
  eq(gone.deserters.map((d) => [d.typeId, d.count]), [["archer", 8], ["swordsman", 2]], "most expensive leave first");
  eq(gone.armies[0].stacks.map((s) => [s.id, s.count]), [["s1", 30]], "empty stack disappears");

  // A small unpaid group: deserters are 0 or 1 (a fraction is a chance)
  const counts = new Set();
  for (let i = 0; i < 30; i++) counts.add(applyDesertion([army], up.report.unpaid, createRng("s" + i)).count);
  eq([...counts].sort(), [0, 1], "fractional chance gives 0 or 1");
  eq(applyDesertion([army], [], createRng(1)).count, 0, "nothing unpaid, nobody leaves");

  // Full turn, deterministic and independent of player order
  const streams = createRng("eco");
  const a = runUpkeep(poor, [big], { income: 0, turn: 3, ownerId: "p1", rng: streams });
  const b = runUpkeep(poor, [big], { income: 0, turn: 3, ownerId: "p1", rng: createRng("eco") });
  eq(a, b, "same seed, same turn");
  runUpkeep(poor, [big], { income: 0, turn: 3, ownerId: "p2", rng: streams }); // another player first
  eq(runUpkeep(poor, [big], { income: 0, turn: 3, ownerId: "p1", rng: streams }), a, "player order does not matter");
  eq(a.report.deserterCount, 10, "report has deserters");

  // Hiring
  const nextId = createIdCounter("h");
  const eco = createEconomy(100);
  const base = mk("A", [{ id: "s1", typeId: "swordsman", count: 1 }]);
  let h = hireUnits({ economy: eco, armies: [base], armyId: "A", typeId: "swordsman", count: 2, ctx: { nextId } });
  eq(h.ok, true, "hire ok");
  eq([h.cost, h.economy.gold], [60, 40], "hire cost");
  eq(h.armies[0].stacks.length, 2, "new stack");
  h = hireUnits({ economy: eco, armies: [base], armyId: "A", typeId: "swordsman", count: 2, stackId: "s1", ctx: { nextId } });
  eq(h.armies[0].stacks[0].count, 3, "added to the existing stack");
  eq(hireUnits({ economy: createEconomy(10), armies: [base], armyId: "A", typeId: "swordsman", count: 1, ctx: { nextId } }).code, "not_enough_gold", "too poor");
  eq(hireUnits({ economy: eco, armies: [base], armyId: "A", typeId: "archer", count: 1, ctx: { nextId } }).code, "type_locked", "locked unit");
  eq(hireUnits({ economy: eco, armies: [base], armyId: "A", typeId: "wolf_pack", count: 1, ctx: { nextId } }).code, "not_hireable", "monsters cannot be hired");
  eq(hireUnits({ economy: createEconomy(1000), armies: [base], armyId: "A", typeId: "swordsman", count: 6, ctx: { nextId } }).code, "type_cap", "unit-type cap applies");
  eq(maxHireable({ economy: eco, armies: [base], armyId: "A", typeId: "swordsman", ctx: {} }), 3, "limited by gold (100 / 30)");
  eq(maxHireable({ economy: createEconomy(1000), armies: [base], armyId: "A", typeId: "swordsman", ctx: {} }), 5, "limited by the type cap");

  // Loot is off by default
  const defeated = [{ typeId: "swordsman", count: 4 }];
  eq(calculateLoot(defeated), { gold: 0 }, "loot is 0 for now");
  eq(calculateLoot(defeated, { ENABLED: true, PERCENT_OF_HIRE_COST: 50, FIXED_PER_UNIT: 1 }), { gold: 64 }, "loot formula when enabled");
  const after = mk("A", [{ id: "s1", typeId: "swordsman", count: 2 }, { id: "a1", typeId: "archer", count: 2 }]);
  eq(lossesBetween(army, after), [{ typeId: "swordsman", count: 4 }], "losses between armies");

  return true;
}

export default {
  createEconomy,
  canAfford,
  addGold,
  spendGold,
  deserializeEconomy,
  hireUnits,
  maxHireable,
  isSalaryTurn,
  totalSalary,
  payUpkeep,
  previewUpkeep,
  applyDesertion,
  runUpkeep,
  lossesBetween,
  calculateLoot,
  economySelfTest,
};
