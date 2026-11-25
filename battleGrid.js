// battleGrid.js
// The battle map: a flat grid, deployment by attack direction, turn order by
// speed, movement, and the actions a unit can take. Pure logic, no graphics,
// no network. Every function returns a NEW state and never edits its input.
// The rules of an individual attack live in battleRules.js.
//
// ---------------------------------------------------------------
// HOW A BATTLE RUNS
// ---------------------------------------------------------------
//  DEPLOYMENT. Two armies, one per side. The attacker deploys on the grid
//  edge it came from (hitFromSide) facing the defender. The defender
//  deploys on the opposite edge, turned the way its army was FACING on the
//  overworld. So a defender caught from the side or from behind starts the
//  battle with its flank or back toward the attacker. Each army's stacks
//  keep their relative layout (army.js cells; row 0 is the front).
//
//  FIRST STRIKE. If the attacker flanked or rear-attacked on the overworld
//  (and the defender is not made only of squares, which have no weak side),
//  all of the attacker's units act before the defender's for
//  CONFIG.BATTLE_GRID.FIRST_STRIKE_TURNS turns.
//
//  TURN ORDER. A turn is one activation per living unit, in order of unit
//  speed (faster first). Ties go to the side that started the battle, then
//  owner id, then stack id. The order is fixed at the start of the turn;
//  units that die before their slot are skipped.
//
//  ACTIVATION (the active unit may do any of these, in this order):
//    move    up to its movePoints, one orthogonal step costs 1, units block
//    attack  one attack on an enemy in range (resolveExchange)
//    OR      switch formation, which uses the whole activation
//    end     optionally choose the facing it ends the activation with
//  A unit cannot move after it has attacked.
//
//  XP. Rolls are logged during the turn. When the turn ends (or the battle
//  does), the awards come back so you can call progression.awardTurnXp().
//  Levels only change after the battle (progression.commitBattle).
//
//  END. The battle is over when only one owner has living units. After
//  CONFIG.BATTLE_GRID.MAX_TURNS the side with more total health wins.
//  getOutcomes() returns each stack's survivors and wounds, to be written
//  back with army.applyBattleOutcome (wounds persist until healed).
//
// LIMITS FOR NOW: exactly two armies per battle, a flat grid, no terrain
// (state.obstacles is supported by movement for later).
//
// STATE (plain JSON)
//   {
//     id, width, height, obstacles: [{x,y}],
//     turn, order: [unitId...], cursor, active: null | {
//       unitId, moveLeft, attacked, switched },
//     units: [ combatant + { armyId, x, y } ],
//     initiatorOwnerId, firstStrikeOwnerId, hitFromSide,
//     log (battleRules turn log), over, winnerOwnerId
//   }
//
// RESULTS
//   Actions return { ok: true, state, ... } or { ok: false, code, reason }.
//   They never throw on a bad order. Whether the right PLAYER may act for
//   the active unit is checked by matchSync.js, not here.

import { CONFIG } from "./config.js";
import { getUnitType } from "./unitTypes.js";
import { getLevel } from "./progression.js";
import { createArmy, addStack, createIdCounter, applyBattleOutcome } from "./army.js";
import { ignoresFlankBonus, countAttackers, switchFormationType, setFacing } from "./formation.js";
import {
  combatantFromStack,
  combatantCount,
  isAlive,
  totalHealth,
  getHitFromSide,
  getAttackClass,
  resolveExchange,
  createTurnLog,
  finishTurn,
} from "./battleRules.js";

const G = CONFIG.BATTLE_GRID;
const W = G.WIDTH;
const H = G.HEIGHT;
const COLS = CONFIG.ARMY.DEPLOY_COLS;
const ROWS = CONFIG.ARMY.DEPLOY_ROWS;
const DIRS = CONFIG.FACING.DIRECTIONS;
const OPPOSITE = CONFIG.FACING.OPPOSITE;

// The deployment zone must fit on the grid in any orientation.
if (Math.max(COLS, ROWS) > Math.min(W, H)) {
  throw new Error("battleGrid: CONFIG.ARMY deployment zone does not fit on the battle grid");
}
if (G.STACK_CELLS !== 1) throw new Error("battleGrid: only STACK_CELLS = 1 is supported");

const ok = (extra) => ({ ok: true, ...extra });
const fail = (code, reason) => ({ ok: false, code, reason });

// ---------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------

export function inBounds(state, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < state.width && y < state.height;
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function getUnit(state, unitId) {
  return state.units.find((u) => u.id === unitId) || null;
}

export function listLivingUnits(state) {
  return state.units.filter(isAlive);
}

export function unitAt(state, x, y) {
  return state.units.find((u) => isAlive(u) && u.x === x && u.y === y) || null;
}

function isBlocked(state, x, y) {
  return state.obstacles.some((o) => o.x === x && o.y === y) || unitAt(state, x, y) !== null;
}

function replaceUnit(state, unit) {
  return { ...state, units: state.units.map((u) => (u.id === unit.id ? unit : u)) };
}

// ---------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------

// How many quarter turns clockwise from "N" to a facing.
export function quarterTurnsFor(facing) {
  return DIRS.indexOf(facing);
}

function rotateCW(p, k) {
  let x = p.x;
  let y = p.y;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return { x, y };
}

// Grid cell for an army's deployment cell (col, row).
//   facing  the way the army faces on the grid ("N" = row 0 points north)
//   edge    the grid edge the zone sits against ("N", "E", "S" or "W")
// The zone is centered along that edge.
export function deploymentCell(col, row, facing, edge) {
  const k = quarterTurnsFor(facing);
  const corners = [
    [0, 0],
    [COLS - 1, 0],
    [0, ROWS - 1],
    [COLS - 1, ROWS - 1],
  ].map(([c, r]) => rotateCW({ x: c, y: r }, k));
  const minX = Math.min(...corners.map((p) => p.x));
  const maxX = Math.max(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxY = Math.max(...corners.map((p) => p.y));
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  let left;
  let top;
  if (edge === "N") {
    left = Math.floor((W - w) / 2);
    top = 0;
  } else if (edge === "S") {
    left = Math.floor((W - w) / 2);
    top = H - h;
  } else if (edge === "W") {
    left = 0;
    top = Math.floor((H - h) / 2);
  } else if (edge === "E") {
    left = W - w;
    top = Math.floor((H - h) / 2);
  } else {
    throw new Error(`battleGrid: bad edge "${edge}"`);
  }
  const p = rotateCW({ x: col, y: row }, k);
  return { x: left + p.x - minX, y: top + p.y - minY };
}

function deployArmy(army, facing, edge, progression) {
  const k = quarterTurnsFor(facing);
  return army.stacks.map((stack) => {
    const level = progression[army.ownerId] ? getLevel(progression[army.ownerId], stack.typeId) : 1;
    const unit = combatantFromStack(stack, { ownerId: army.ownerId, level, quarterTurns: k });
    const cell = deploymentCell(stack.cell.col, stack.cell.row, facing, edge);
    return { ...unit, armyId: army.id, x: cell.x, y: cell.y };
  });
}

// ---------------------------------------------------------------
// Creating a battle
// ---------------------------------------------------------------

// attackerArmy, defenderArmy   army.js armies (different owners, with stacks)
// hitFromSide                  the side of the DEFENDER the attacker came
//                              from on the overworld ("N", "E", "S", "W")
// attackerIsInitiator          false when both armies arrived at the same
//                              time: no first strike, both face each other
// progression                  { ownerId: progression state } for levels
export function createBattle({ id, attackerArmy, defenderArmy, hitFromSide, attackerIsInitiator = true, progression = {} }) {
  if (!DIRS.includes(hitFromSide)) throw new Error(`battleGrid: bad hitFromSide "${hitFromSide}"`);
  if (attackerArmy.ownerId === defenderArmy.ownerId) throw new Error("battleGrid: both armies have the same owner");
  if (attackerArmy.stacks.length === 0 || defenderArmy.stacks.length === 0) {
    throw new Error("battleGrid: an army with no stacks cannot fight");
  }

  const attackerFacing = OPPOSITE[hitFromSide];
  // A defender that was ambushed keeps its overworld facing.
  const defenderFacing = attackerIsInitiator ? defenderArmy.facing : hitFromSide;

  const units = deployArmy(attackerArmy, attackerFacing, hitFromSide, progression).concat(
    deployArmy(defenderArmy, defenderFacing, OPPOSITE[hitFromSide], progression)
  );

  const ids = new Set();
  const cells = new Set();
  for (const u of units) {
    if (ids.has(u.id)) throw new Error(`battleGrid: duplicate stack id "${u.id}"`);
    ids.add(u.id);
    const key = `${u.x},${u.y}`;
    if (cells.has(key)) throw new Error(`battleGrid: two units deployed on cell ${key}`);
    cells.add(key);
  }

  // First strike: a flank or rear contact, unless the defender cannot be
  // flanked (every stack is a square).
  let firstStrikeOwnerId = null;
  if (attackerIsInitiator && G.FLANK_GIVES_FIRST_STRIKE && defenderFacing !== hitFromSide) {
    const flankable = defenderArmy.stacks.some((s) => !ignoresFlankBonus(s.formationType));
    if (flankable) firstStrikeOwnerId = attackerArmy.ownerId;
  }

  let state = {
    id,
    width: W,
    height: H,
    obstacles: [],
    turn: 1,
    order: [],
    cursor: 0,
    active: null,
    units,
    initiatorOwnerId: attackerIsInitiator ? attackerArmy.ownerId : null,
    firstStrikeOwnerId,
    hitFromSide,
    log: createTurnLog(),
    over: false,
    winnerOwnerId: null,
  };
  state = { ...state, order: computeOrder(state) };
  return { ...state, active: newActive(getUnit(state, state.order[0])) };
}

// ---------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Unit ids in the order they act this turn.
function computeOrder(state) {
  const firstStrikeActive =
    state.firstStrikeOwnerId !== null && state.turn <= G.FIRST_STRIKE_TURNS;

  return listLivingUnits(state)
    .slice()
    .sort((a, b) => {
      if (firstStrikeActive) {
        const d = (a.ownerId === state.firstStrikeOwnerId ? 0 : 1) - (b.ownerId === state.firstStrikeOwnerId ? 0 : 1);
        if (d !== 0) return d;
      }
      const speed = getUnitType(b.typeId).speed - getUnitType(a.typeId).speed;
      if (speed !== 0) return speed;
      for (const rule of G.TIE_BREAK) {
        let d = 0;
        if (rule === "initiator_first") {
          d = (a.ownerId === state.initiatorOwnerId ? 0 : 1) - (b.ownerId === state.initiatorOwnerId ? 0 : 1);
        } else if (rule === "owner_id") d = cmp(a.ownerId, b.ownerId);
        else if (rule === "stack_id") d = cmp(a.id, b.id);
        if (d !== 0) return d;
      }
      return 0;
    })
    .map((u) => u.id);
}

function newActive(unit) {
  return { unitId: unit.id, moveLeft: getUnitType(unit.typeId).movePoints, attacked: false, switched: false };
}

export function getActiveUnit(state) {
  return state.active ? getUnit(state, state.active.unitId) : null;
}

// The units still to act this turn, in order (the active unit first).
export function getUpcomingOrder(state) {
  return state.order.slice(Math.max(0, state.cursor)).filter((id) => {
    const u = getUnit(state, id);
    return u && isAlive(u);
  });
}

// ---------------------------------------------------------------
// Checking for the end of the battle
// ---------------------------------------------------------------

function checkOver(state) {
  const owners = [...new Set(listLivingUnits(state).map((u) => u.ownerId))];
  if (owners.length > 1) return state;
  return { ...state, over: true, winnerOwnerId: owners.length === 1 ? owners[0] : null, active: null };
}

// After MAX_TURNS the side with more total health wins.
function resolveTimeout(state) {
  const health = {};
  for (const u of listLivingUnits(state)) health[u.ownerId] = (health[u.ownerId] || 0) + totalHealth(u);
  const ranked = Object.entries(health).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  return { ...state, over: true, winnerOwnerId: tie ? null : ranked[0][0], active: null };
}

// ---------------------------------------------------------------
// Moving to the next unit
// ---------------------------------------------------------------

// Closes the current activation and opens the next living unit's. Returns
// { state, turnEnded, awards }. `awards` has the XP awards of a finished
// turn (empty when the turn did not end).
function advance(state) {
  let s = { ...state, active: null };
  let cursor = s.cursor + 1;
  let awards = [];
  let turnEnded = false;

  for (let guard = 0; guard < 4; guard++) {
    while (cursor < s.order.length) {
      const u = getUnit(s, s.order[cursor]);
      if (u && isAlive(u)) return { state: { ...s, cursor, active: newActive(u) }, turnEnded, awards };
      cursor++;
    }
    // Everyone has acted: the turn is over.
    awards = awards.concat(finishTurn(s.log));
    turnEnded = true;
    s = { ...s, turn: s.turn + 1, log: createTurnLog() };
    if (s.turn > G.MAX_TURNS) return { state: resolveTimeout(s), turnEnded, awards };
    s = { ...s, order: computeOrder(s), cursor: -1 };
    cursor = 0;
  }
  throw new Error("battleGrid: could not find a unit to act (no living units?)");
}

// ---------------------------------------------------------------
// Movement
// ---------------------------------------------------------------

// Cells the active unit can reach with its remaining movement.
// Returns [{ x, y, cost }], sorted by cost then y then x.
export function getReachableCells(state) {
  const unit = getActiveUnit(state);
  const act = state.active;
  if (!unit || state.over || act.attacked || act.switched) return [];

  const best = new Map([[`${unit.x},${unit.y}`, 0]]);
  const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
  const out = [];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur.cost >= act.moveLeft) continue;
    for (const d of DIRS) {
      const v = CONFIG.FACING.VECTORS[d];
      const nx = cur.x + v.x;
      const ny = cur.y + v.y;
      const key = `${nx},${ny}`;
      if (!inBounds(state, nx, ny) || best.has(key) || isBlocked(state, nx, ny)) continue;
      best.set(key, cur.cost + 1);
      const cell = { x: nx, y: ny, cost: cur.cost + 1 };
      queue.push(cell);
      out.push(cell);
    }
  }
  return out.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
}

// Moves the active unit to (x, y) if it can get there.
export function moveActive(state, x, y) {
  if (state.over) return fail("battle_over", "The battle is over.");
  const unit = getActiveUnit(state);
  if (!unit) return fail("no_active_unit", "No unit is active.");
  if (state.active.attacked) return fail("already_attacked", "A unit cannot move after attacking.");
  if (state.active.switched) return fail("switched", "The unit spent its turn changing formation.");
  const cell = getReachableCells(state).find((c) => c.x === x && c.y === y);
  if (!cell) return fail("unreachable", "The unit cannot reach that square.");

  const moved = { ...unit, x, y };
  const next = replaceUnit(state, moved);
  return ok({ state: { ...next, active: { ...state.active, moveLeft: state.active.moveLeft - cell.cost } }, cost: cell.cost });
}

// ---------------------------------------------------------------
// Attacking
// ---------------------------------------------------------------

// Everything the active unit could attack right now (for the UI and AI).
// [{ targetId, distance, hitFromSide, attackClass, attackers }], nearest
// first, then by id.
export function getAttackableTargets(state) {
  const unit = getActiveUnit(state);
  if (!unit || state.over || state.active.attacked || state.active.switched) return [];
  const range = getUnitType(unit.typeId).attackRange;
  const out = [];
  for (const t of listLivingUnits(state)) {
    if (t.ownerId === unit.ownerId) continue;
    const distance = manhattan(unit, t);
    if (distance > range) continue;
    const hitFromSide = getHitFromSide({ x: unit.x, y: unit.y }, { x: t.x, y: t.y });
    if (hitFromSide === null) continue;
    const attackers = countAttackers(unit.formation, OPPOSITE[hitFromSide]);
    if (attackers === 0) continue;
    out.push({ targetId: t.id, distance, hitFromSide, attackClass: getAttackClass(t, hitFromSide), attackers });
  }
  return out.sort((a, b) => a.distance - b.distance || cmp(a.targetId, b.targetId));
}

// The active unit attacks `targetId`. Returns
// { ok, state, report, awards, over }. `awards` is only filled if this
// attack ended the battle (otherwise XP comes when the turn ends).
export function attackActive(state, targetId, rng) {
  if (state.over) return fail("battle_over", "The battle is over.");
  const attacker = getActiveUnit(state);
  if (!attacker) return fail("no_active_unit", "No unit is active.");
  if (state.active.attacked) return fail("already_attacked", "This unit has already attacked.");
  if (state.active.switched) return fail("switched", "The unit spent its turn changing formation.");
  const target = getUnit(state, targetId);
  if (!target || !isAlive(target)) return fail("bad_target", "That target does not exist.");
  if (target.ownerId === attacker.ownerId) return fail("friendly_target", "That is one of your own units.");

  const hitFromSide = getHitFromSide({ x: attacker.x, y: attacker.y }, { x: target.x, y: target.y });
  if (hitFromSide === null) return fail("bad_target", "That target is on the same square.");
  const distance = manhattan(attacker, target);

  // Work on a copy of the log so the old state stays untouched.
  const log = { events: state.log.events.slice() };
  const res = resolveExchange({ attacker, defender: target, hitFromSide, distance, log, rng });
  if (!res.ok) return res;

  let next = replaceUnit(replaceUnit(state, res.attacker), res.defender);
  next = { ...next, log, active: { ...state.active, attacked: true, moveLeft: 0 } };
  next = checkOver(next);

  let awards = [];
  if (next.over) {
    awards = finishTurn(next.log);
    next = { ...next, log: createTurnLog() };
  }
  return ok({ state: next, report: res.report, awards, over: next.over });
}

// ---------------------------------------------------------------
// Switching formation (uses the whole activation)
// ---------------------------------------------------------------

export function switchFormationActive(state, newType) {
  if (state.over) return fail("battle_over", "The battle is over.");
  const unit = getActiveUnit(state);
  if (!unit) return fail("no_active_unit", "No unit is active.");
  if (!CONFIG.FORMATIONS.TYPES.includes(newType)) return fail("bad_formation", `Unknown formation "${newType}".`);
  if (newType === unit.formation.type) return fail("same_formation", "The unit already has that formation.");
  const act = state.active;
  if (act.attacked) return fail("already_attacked", "This unit has already attacked.");

  if (CONFIG.FORMATIONS.SWITCH_COSTS_TURN) {
    const full = getUnitType(unit.typeId).movePoints;
    if (act.moveLeft !== full || act.switched) return fail("already_acted", "Switching formation must be the unit's only action.");
  }
  const changed = { ...unit, formation: switchFormationType(unit.formation, newType) };
  const next = replaceUnit(state, changed);
  return ok({
    state: CONFIG.FORMATIONS.SWITCH_COSTS_TURN ? { ...next, active: { ...act, switched: true, moveLeft: 0 } } : next,
  });
}

// ---------------------------------------------------------------
// Ending an activation
// ---------------------------------------------------------------

// Ends the active unit's activation. `facing` ("N","E","S","W") is the
// facing it ends with (optional, and a square does not care). Returns
// { ok, state, turnEnded, awards }. `awards` has the finished turn's XP
// awards when the turn ended.
export function endActivation(state, facing) {
  if (state.over) return fail("battle_over", "The battle is over.");
  const unit = getActiveUnit(state);
  if (!unit) return fail("no_active_unit", "No unit is active.");
  if (facing !== undefined && !DIRS.includes(facing)) return fail("bad_facing", `Bad facing "${facing}".`);

  let s = state;
  if (facing !== undefined && facing !== unit.formation.facing) {
    s = replaceUnit(s, { ...unit, formation: setFacing(unit.formation, facing) });
  }
  const adv = advance(s);
  return ok(adv);
}

// ---------------------------------------------------------------
// Results
// ---------------------------------------------------------------

export function isOver(state) {
  return state.over;
}

export function getWinner(state) {
  return state.winnerOwnerId;
}

// Survivors and wounds for every stack that fought, to write back to the
// armies: [{ armyId, stackId, ownerId, count, carry }].
export function getOutcomes(state) {
  return state.units
    .map((u) => ({ armyId: u.armyId, stackId: u.id, ownerId: u.ownerId, count: combatantCount(u), carry: u.carry }))
    .sort((a, b) => cmp(a.armyId, b.armyId) || cmp(a.stackId, b.stackId));
}

// Applies getOutcomes() to a list of armies. Returns new armies (empty
// armies are kept; remove them with isArmyEmpty if you want).
export function applyOutcomesToArmies(armies, outcomes) {
  return armies.map((army) =>
    applyBattleOutcome(
      army,
      outcomes.filter((o) => o.armyId === army.id)
    )
  );
}

// Moves a unit without any checks. For setting up tests and scenarios only.
export function placeUnit(state, unitId, x, y) {
  const u = getUnit(state, unitId);
  if (!u) throw new Error(`battleGrid: unknown unit "${unitId}"`);
  return replaceUnit(state, { ...u, x, y });
}

// ---------------------------------------------------------------
// Self test (call from the browser console:
//   import("./rng.js").then(m => battleGridSelfTest(m.createRng)) )
// ---------------------------------------------------------------

export function battleGridSelfTest(createRng) {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`battleGridSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  const nextId = createIdCounter("z");
  const mkArmy = (id, ownerId, facing, stacks) => {
    let army = createArmy({ id, ownerId, facing });
    for (const s of stacks) {
      const r = addStack(army, s, { nextId: () => s.id, enforceLimits: false });
      if (!r.ok) throw new Error(r.reason);
      army = r.army;
    }
    return army;
  };
  const p1 = () =>
    mkArmy("A1", "p1", "N", [
      { id: "s1", typeId: "swordsman", count: 6, formationType: "square" },
      { id: "a1", typeId: "archer", count: 2, formationType: "line" },
    ]);
  const p2 = (facing) =>
    mkArmy("A2", "p2", facing, [
      { id: "e1", typeId: "spearman", count: 5, formationType: "line" },
      { id: "e2", typeId: "swordsman", count: 3, formationType: "square" },
    ]);

  // --- Deployment: attacker comes from the south ---
  let b = createBattle({ id: "b1", attackerArmy: p1(), defenderArmy: p2("N"), hitFromSide: "S" });
  eq(b.units.filter((u) => u.ownerId === "p1").every((u) => u.y >= H - ROWS), true, "attacker on the south edge");
  eq(b.units.filter((u) => u.ownerId === "p2").every((u) => u.y < ROWS), true, "defender on the north edge");
  eq(getUnit(b, "s1").formation.facing, "N", "attacker faces the defender");
  // Defender faces north, attacked from the south: rear attack, first strike
  eq(b.firstStrikeOwnerId, "p1", "flank gives first strike");
  eq(b.order, ["s1", "a1", "e1", "e2"], "first strike, then speed");
  eq(getActiveUnit(b).id, "s1", "first unit active");

  // Melee stacks deploy in the front row, ranged behind
  // The attacker faces north, so the front row is the smaller y.
  eq(getUnit(b, "s1").y < getUnit(b, "a1").y, true, "swordsman in front of archer");

  // Head-on: defender faces the attacker, no first strike, speed order
  const head = createBattle({ id: "b2", attackerArmy: p1(), defenderArmy: p2("S"), hitFromSide: "S" });
  eq(head.firstStrikeOwnerId, null, "no first strike head-on");
  eq(head.order, ["e1", "s1", "e2", "a1"], "speed order, initiator wins the tie");
  eq(getUnit(head, "e1").formation.facing, "S", "defender faces the attacker");

  // Sideways defender (facing east) with the attacker coming from the east edge
  const side = createBattle({ id: "b3", attackerArmy: p1(), defenderArmy: p2("N"), hitFromSide: "E" });
  eq(side.firstStrikeOwnerId, "p1", "side contact gives first strike");
  eq(side.units.filter((u) => u.ownerId === "p1").every((u) => u.x >= W - ROWS), true, "attacker on the east edge");
  eq(getUnit(side, "e1").formation.facing, "N", "ambushed defender keeps its facing");

  // Squares cannot be flanked
  const squares = mkArmy("A3", "p3", "N", [{ id: "q1", typeId: "swordsman", count: 4, formationType: "square" }]);
  eq(createBattle({ id: "b4", attackerArmy: p1(), defenderArmy: squares, hitFromSide: "S" }).firstStrikeOwnerId, null, "squares have no weak side");

  // --- Movement ---
  const reach = getReachableCells(b);
  eq(reach.length > 0, true, "has reachable cells");
  eq(reach.every((c) => c.cost <= 3), true, "within move points");
  const blockedCell = getUnit(b, "a1");
  eq(moveActive(b, blockedCell.x, blockedCell.y).code, "unreachable", "cannot move onto a unit");
  const target = reach[0];
  const moved = moveActive(b, target.x, target.y);
  eq(moved.ok, true, "move ok");
  eq(moved.state.active.moveLeft, 3 - target.cost, "move points spent");
  eq(getUnit(b, "s1").x === getUnit(moved.state, "s1").x && getUnit(b, "s1").y === getUnit(moved.state, "s1").y, false, "old state untouched? (moved copy differs)");

  // --- Attack with first strike: s1 (p1 square) hits e1 (p2 line facing N) from the south ---
  let s = placeUnit(b, "e1", 3, 1);
  s = placeUnit(s, "s1", 3, 2);
  const rng = createRng("grid-test");
  const targets = getAttackableTargets(s);
  eq(targets.map((t) => t.targetId), ["e1"], "only e1 in reach");
  eq(targets[0].attackClass, "rear", "rear attack");
  const atk = attackActive(s, "e1", rng);
  eq(atk.ok, true, "attack ok");
  eq(atk.report.attackClass, "rear", "report class");
  eq(atk.state.log.events.length >= 1, true, "rolls logged");
  eq(s.log.events.length, 0, "input state log untouched");
  eq(atk.state.active.attacked, true, "attacked flag");
  eq(moveActive(atk.state, 0, 0).code, "already_attacked", "no move after attack");
  eq(attackActive(atk.state, "e1", rng).code, "already_attacked", "one attack per activation");

  // --- Finish the turn: everyone ends; XP awards come back ---
  let cur = atk.state;
  let end = endActivation(cur, "E");
  eq(getUnit(end.state, "s1").formation.facing, "E", "facing chosen at end of activation (square keeps its shape)");
  let guard = 0;
  let turnAwards = [];
  cur = end.state;
  while (guard++ < 10 && !end.turnEnded && !cur.over) {
    end = endActivation(cur);
    cur = end.state;
  }
  eq(end.turnEnded, true, "turn ended");
  eq(cur.turn, 2, "turn counter");
  eq(end.awards.length >= 1, true, "awards at turn end");
  eq(cur.log.events.length, 0, "log reset for the new turn");
  eq(getUpcomingOrder(cur).length > 0, true, "new order built");

  // --- Switching formation uses the activation ---
  const sw = switchFormationActive(b, "line");
  eq(sw.ok, true, "switch ok");
  eq(getUnit(sw.state, "s1").formation.type, "line", "formation switched");
  eq(moveActive(sw.state, 0, 0).code, "switched", "cannot move after switching");
  eq(switchFormationActive(moved.state, "line").code, "already_acted", "switch must be the only action");

  // --- Wounds persist in the outcome ---
  const out = getOutcomes(atk.state);
  const e1out = out.find((o) => o.stackId === "e1");
  eq(e1out.count <= 5, true, "defender took casualties or none");
  const armiesAfter = applyOutcomesToArmies([p1(), p2("N")], out);
  const e1stack = armiesAfter[1].stacks.find((st) => st.id === "e1");
  eq(e1stack ? [e1stack.count, e1stack.carry] : [0, 0], [e1out.count, e1out.carry], "outcome written to army (count and wound)");

  // --- A battle that ends ---
  const lone = mkArmy("A4", "p4", "N", [{ id: "w1", typeId: "swordsman", count: 1, formationType: "line" }]);
  const killer = mkArmy("A5", "p5", "N", [{ id: "k1", typeId: "spearman", count: 10, formationType: "line" }]);
  let fin = createBattle({ id: "b5", attackerArmy: killer, defenderArmy: lone, hitFromSide: "S" });
  fin = placeUnit(placeUnit(fin, "w1", 3, 1), "k1", 3, 2);
  const kill = attackActive(fin, "w1", createRng("finish"));
  eq(kill.ok, true, "finishing attack ok");
  eq(kill.over, true, "battle over");
  eq(getWinner(kill.state), "p5", "winner");
  eq(kill.awards.length >= 1, true, "awards when the battle ends");
  eq(getActiveUnit(kill.state), null, "no active unit after the end");

  return true;
}

export default {
  inBounds,
  manhattan,
  getUnit,
  listLivingUnits,
  unitAt,
  quarterTurnsFor,
  deploymentCell,
  createBattle,
  getActiveUnit,
  getUpcomingOrder,
  getReachableCells,
  moveActive,
  getAttackableTargets,
  attackActive,
  switchFormationActive,
  endActivation,
  isOver,
  getWinner,
  getOutcomes,
  applyOutcomesToArmies,
  placeUnit,
  battleGridSelfTest,
};

