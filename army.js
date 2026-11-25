// army.js
// Armies and stacks. Pure logic, no graphics, no network.
//
// VOCABULARY
//   stack  one unit entry: a unit type, a count, and a formation. A stack
//          of 10 swordsmen occupies ONE grid square in battle.
//   army   a group of stacks that moves on the overworld together.
//   roster all the armies one player owns. Authority limits apply to the
//          roster, not to a single army. Any number of armies is allowed.
//
// DATA (plain JSON, safe to save to Firebase)
//   stack = {
//     id, typeId, count,
//     formationType: "square" | "line",
//     facing: "N" | "E" | "S" | "W",   // local facing; "N" = toward the enemy
//     switchingTo: null | "square" | "line",   // pending formation switch
//     carry,                           // damage on the wounded unit (persists
//                                      // after battle until healed)
//     cell: { col, row }               // place in the army's deployment zone
//   }
//   army = { id, ownerId, name, facing, stacks: [stack, ...] }
//
//   army.facing is the overworld facing, chosen at the end of the army's
//   turn. stack.facing is local to the army (so a line's front is "N" when
//   the army faces the enemy). battleGrid.js rotates both by the attack
//   direction: use rotateDir() and getStackFormation() for that.
//
// DEPLOYMENT ZONE
//   Each army deploys into a small local grid (CONFIG.ARMY). Row 0 is the
//   front (nearest the enemy), column 0 is the left. The player may place
//   stacks freely. The zone size is also the maximum stacks per army.
//
// RESULTS
//   Every player-facing action returns { ok: true, army, ... } or
//   { ok: false, code, reason }. Nothing here throws on a bad order, so a
//   rejected PvP order can never crash a client. Nothing edits its inputs.
//
// IDS
//   Actions that create stacks need ctx.nextId(): a function returning a new
//   unique string. Both PvP clients must produce the same ids, so build it
//   from a counter stored in the match record (see createIdCounter).
//
// CTX (limit checks)
//   {
//     armies,          all of this owner's armies (the one being edited may
//                      be old or missing; it is replaced by the army passed in)
//     authorityPool,   total authority (default: getAuthorityPool())
//     unlockedIds,     unlock ids the player owns (default: none)
//     enforceLimits,   set false for AI/monster armies (default: true)
//     nextId,          id factory, needed when stacks are created
//   }

import { CONFIG } from "./config.js";
import { getUnitType, hasUnitType, isTypeAvailable } from "./unitTypes.js";
import { createFormation } from "./formation.js";

const DIRS = CONFIG.FACING.DIRECTIONS;
const FORMATION_TYPES = CONFIG.FORMATIONS.TYPES;
const COLS = CONFIG.ARMY.DEPLOY_COLS;
const ROWS = CONFIG.ARMY.DEPLOY_ROWS;
export const MAX_STACKS_PER_ARMY = COLS * ROWS;

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

const ok = (army, extra = {}) => ({ ok: true, army, ...extra });
const fail = (code, reason) => ({ ok: false, code, reason });

// Returns a function that makes ids like "p1:s1", "p1:s2"... Store the
// counter value in the match record (counter.value) and restore it later.
export function createIdCounter(prefix, start = 1) {
  let n = start;
  const nextId = () => `${prefix}${n++}`;
  Object.defineProperty(nextId, "value", { get: () => n });
  return nextId;
}

// Turns a direction clockwise by quarter turns (negative turns go left).
export function rotateDir(dir, quarterTurns) {
  const i = DIRS.indexOf(dir);
  if (i < 0) throw new Error(`army: bad direction "${dir}"`);
  const k = ((quarterTurns % 4) + 4) % 4;
  return DIRS[(i + k) % 4];
}

function isDir(d) {
  return DIRS.includes(d);
}
function isFormationType(t) {
  return FORMATION_TYPES.includes(t);
}

function cloneStack(s) {
  return { ...s, cell: { ...s.cell } };
}
function cloneArmy(a) {
  return { ...a, stacks: a.stacks.map(cloneStack) };
}
function withStacks(army, stacks) {
  return { ...army, stacks };
}

export function getAuthorityPool(playerLevel = 0) {
  return CONFIG.AUTHORITY.START_POOL + CONFIG.AUTHORITY.POOL_PER_PLAYER_LEVEL * playerLevel;
}

// ---------------------------------------------------------------
// Deployment zone cells
// ---------------------------------------------------------------

// Columns from the middle outward (5 columns: 2, 1, 3, 0, 4).
const COL_ORDER = Array.from({ length: COLS }, (_, c) => c).sort((a, b) => {
  const mid = (COLS - 1) / 2;
  return Math.abs(a - mid) - Math.abs(b - mid) || a - b;
});

// First free cell. Melee stacks prefer the front row, ranged the back.
function findFreeCell(stacks, typeId) {
  const taken = new Set(stacks.map((s) => `${s.cell.col},${s.cell.row}`));
  const rowOrder = Array.from({ length: ROWS }, (_, r) => r);
  if (getUnitType(typeId).category === "ranged") rowOrder.reverse();
  for (const row of rowOrder) {
    for (const col of COL_ORDER) {
      if (!taken.has(`${col},${row}`)) return { col, row };
    }
  }
  return null;
}

function validCell(col, row) {
  return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < COLS && row >= 0 && row < ROWS;
}

// ---------------------------------------------------------------
// Creating armies and stacks
// ---------------------------------------------------------------

export function createArmy({ id, ownerId, name = "Army", facing = "N" }) {
  if (!id) throw new Error("army: createArmy needs an id");
  if (!isDir(facing)) throw new Error(`army: bad facing "${facing}"`);
  return { id, ownerId, name, facing, stacks: [] };
}

function makeStack({ id, typeId, count, formationType, facing, cell, carry = 0 }) {
  return { id, typeId, count, formationType, facing, switchingTo: null, carry, cell };
}

// The armies a new game starts with (CONFIG.START). `stacked: true` makes
// one stack with the whole count; `stacked: false` makes one stack per unit.
export function createStartingArmies(ownerId, nextId) {
  const armies = [];
  for (const cfg of CONFIG.START.ARMIES) {
    let army = createArmy({ id: nextId(), ownerId, name: cfg.name });
    for (const u of cfg.units) {
      const groups = u.stacked ? [u.count] : Array.from({ length: u.count }, () => 1);
      for (const count of groups) {
        const res = addStack(
          army,
          { typeId: u.typeId, count, formationType: cfg.formation },
          { nextId, enforceLimits: false }
        );
        if (!res.ok) throw new Error(`army: CONFIG.START is invalid: ${res.reason}`);
        army = res.army;
      }
    }
    armies.push(army);
  }
  return armies;
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

export function getStack(army, stackId) {
  return army.stacks.find((s) => s.id === stackId) || null;
}

export function armyUnitCount(army) {
  return army.stacks.reduce((n, s) => n + s.count, 0);
}

export function armyAuthority(army) {
  return army.stacks.reduce((n, s) => n + getUnitType(s.typeId).authorityCost * s.count, 0);
}

// Gold per world turn for the whole army.
export function armySalary(army) {
  return army.stacks.reduce((n, s) => n + getUnitType(s.typeId).salary * s.count, 0);
}

export function isArmyEmpty(army) {
  return army.stacks.length === 0;
}

// Flat list of { armyId, stack } across armies, in a fixed order.
export function listStacks(armies) {
  const out = [];
  for (const a of armies) for (const s of a.stacks) out.push({ armyId: a.id, stack: s });
  return out;
}

// Totals across a roster: { byType: { typeId: count }, authority, units }.
export function getRosterUsage(armies) {
  const byType = {};
  let authority = 0;
  let units = 0;
  for (const a of armies) {
    for (const s of a.stacks) {
      byType[s.typeId] = (byType[s.typeId] || 0) + s.count;
      authority += getUnitType(s.typeId).authorityCost * s.count;
      units += s.count;
    }
  }
  return { byType, authority, units };
}

// The formation object for a stack, for battle use. Pass the number of
// quarter turns the army is rotated by (from the attack direction) so a
// line's front points the right way on the grid.
export function getStackFormation(stack, quarterTurns = 0) {
  return createFormation(stack.formationType, stack.count, rotateDir(stack.facing, quarterTurns));
}

// ---------------------------------------------------------------
// Authority and unit-type limits
// ---------------------------------------------------------------

// The roster as the limit checks see it: other armies plus this one.
function rosterWith(army, ctx) {
  const others = (ctx.armies || []).filter((a) => a.id !== army.id);
  return others.concat([army]);
}

// Can `count` more units of `typeId` be added to this army?
export function checkCanAdd(army, typeId, count, ctx = {}) {
  if (!hasUnitType(typeId)) return fail("unknown_type", `Unknown unit type "${typeId}".`);
  if (!Number.isInteger(count) || count < 1) return fail("bad_count", "Count must be a whole number of at least 1.");
  if (ctx.enforceLimits === false) return { ok: true };

  const type = getUnitType(typeId);
  if (!isTypeAvailable(typeId, ctx.unlockedIds || [])) {
    return fail("type_locked", `${type.name} is not unlocked.`);
  }
  const usage = getRosterUsage(rosterWith(army, ctx));
  const have = usage.byType[typeId] || 0;
  if (CONFIG.AUTHORITY.PER_TYPE_CAP_ENABLED && have + count > type.authorityCap) {
    return fail("type_cap", `You can only have ${type.authorityCap} ${type.name} units.`);
  }
  const pool = ctx.authorityPool ?? getAuthorityPool();
  if (usage.authority + type.authorityCost * count > pool) {
    return fail("authority_pool", "Not enough authority.");
  }
  return { ok: true };
}

// The most units of a type that could still be added (for hire screens).
export function maxAddable(army, typeId, ctx = {}) {
  if (!hasUnitType(typeId)) return 0;
  if (ctx.enforceLimits === false) return Infinity;
  const type = getUnitType(typeId);
  if (!isTypeAvailable(typeId, ctx.unlockedIds || [])) return 0;
  const usage = getRosterUsage(rosterWith(army, ctx));
  const capLeft = CONFIG.AUTHORITY.PER_TYPE_CAP_ENABLED
    ? type.authorityCap - (usage.byType[typeId] || 0)
    : Infinity;
  const poolLeft = Math.floor(((ctx.authorityPool ?? getAuthorityPool()) - usage.authority) / type.authorityCost);
  return Math.max(0, Math.min(capLeft, poolLeft));
}

// ---------------------------------------------------------------
// Adding units (hiring, rewards)
// ---------------------------------------------------------------

// Adds a NEW stack. spec = { typeId, count, formationType?, facing? }.
export function addStack(army, spec, ctx = {}) {
  const { typeId, count } = spec;
  const formationType = spec.formationType ?? CONFIG.FORMATIONS.DEFAULT;
  const facing = spec.facing ?? "N";

  const check = checkCanAdd(army, typeId, count, ctx);
  if (!check.ok) return check;
  if (!isFormationType(formationType)) return fail("bad_formation", `Unknown formation "${formationType}".`);
  if (!isDir(facing)) return fail("bad_facing", `Bad facing "${facing}".`);
  if (army.stacks.length >= MAX_STACKS_PER_ARMY) {
    return fail("max_stacks", `An army holds at most ${MAX_STACKS_PER_ARMY} stacks.`);
  }
  if (typeof ctx.nextId !== "function") throw new Error("army: addStack needs ctx.nextId");

  const cell = findFreeCell(army.stacks, typeId);
  const stack = makeStack({ id: ctx.nextId(), typeId, count, formationType, facing, cell });
  return ok(withStacks(army, army.stacks.map(cloneStack).concat([stack])), { stackId: stack.id });
}

// Adds units to an EXISTING stack (the stack just grows).
export function addToStack(army, stackId, count, ctx = {}) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  const check = checkCanAdd(army, stack.typeId, count, ctx);
  if (!check.ok) return check;
  return ok(
    withStacks(
      army,
      army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), count: s.count + count } : cloneStack(s)))
    ),
    { stackId }
  );
}

// ---------------------------------------------------------------
// Removing units (casualties, desertion)
// ---------------------------------------------------------------

// Removes up to `count` units from a stack. A stack that reaches 0 is
// deleted. Returns { removed } (the number actually removed).
export function removeUnits(army, stackId, count) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  if (!Number.isInteger(count) || count < 1) return fail("bad_count", "Count must be a whole number of at least 1.");
  const removed = Math.min(count, stack.count);
  const stacks =
    removed >= stack.count
      ? army.stacks.filter((s) => s.id !== stackId).map(cloneStack)
      : army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), count: s.count - removed } : cloneStack(s)));
  return ok(withStacks(army, stacks), { removed });
}

// ---------------------------------------------------------------
// Merge and split
// ---------------------------------------------------------------

// Merges stack B into stack A. Both must be the same unit type. The player
// chooses the merged stack's formation (default: A's). The merged stack
// keeps A's id, facing and cell; B's cell is freed.
export function mergeStacks(army, stackIdA, stackIdB, formationType) {
  if (stackIdA === stackIdB) return fail("same_stack", "Pick two different stacks.");
  const a = getStack(army, stackIdA);
  const b = getStack(army, stackIdB);
  if (!a || !b) return fail("unknown_stack", "That stack does not exist.");
  if (a.typeId !== b.typeId) return fail("type_mismatch", "Only stacks of the same unit type can merge.");
  if (a.carry > 0 && b.carry > 0) {
    return fail("wounded", "Two wounded stacks cannot merge. Heal one of them first.");
  }
  const chosen = formationType ?? a.formationType;
  if (!isFormationType(chosen)) return fail("bad_formation", `Unknown formation "${chosen}".`);

  const stacks = army.stacks
    .filter((s) => s.id !== stackIdB)
    .map((s) =>
      s.id === stackIdA
        ? { ...cloneStack(s), count: a.count + b.count, carry: a.carry + b.carry, formationType: chosen, switchingTo: null }
        : cloneStack(s)
    );
  return ok(withStacks(army, stacks), { stackId: stackIdA });
}

// Splits `splitCount` units off a stack into a new stack with the same
// formation and facing. Authority does not change.
// A stack has one wounded unit (its `carry`). By default the wound stays
// with the original stack. With options.takeWounded the wounded unit goes
// into the NEW stack and keeps its wound (the original is left unwounded).
// Splitting off a single wounded unit gives you a stack of 1 wounded unit.
export function splitStack(army, stackId, splitCount, ctx = {}, options = {}) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  if (options.takeWounded && stack.carry === 0) return fail("not_wounded", "That stack has no wounded unit.");
  if (!Number.isInteger(splitCount) || splitCount < 1 || splitCount >= stack.count) {
    return fail("bad_count", "The split must leave at least 1 unit in each stack.");
  }
  if (army.stacks.length >= MAX_STACKS_PER_ARMY) {
    return fail("max_stacks", `An army holds at most ${MAX_STACKS_PER_ARMY} stacks.`);
  }
  if (typeof ctx.nextId !== "function") throw new Error("army: splitStack needs ctx.nextId");

  const cell = findFreeCell(army.stacks, stack.typeId);
  const newStack = makeStack({
    id: ctx.nextId(),
    typeId: stack.typeId,
    count: splitCount,
    formationType: stack.formationType,
    facing: stack.facing,
    cell,
    carry: options.takeWounded ? stack.carry : 0,
  });
  const stacks = army.stacks
    .map((s) =>
      s.id === stackId
        ? { ...cloneStack(s), count: s.count - splitCount, carry: options.takeWounded ? 0 : s.carry }
        : cloneStack(s)
    )
    .concat([newStack]);
  return ok(withStacks(army, stacks), { newStackId: newStack.id });
}

// ---------------------------------------------------------------
// Formation and facing
// ---------------------------------------------------------------

// Starts a formation switch. If CONFIG.FORMATIONS.SWITCH_COSTS_TURN is on,
// the stack only switches when resolveFormationSwitches() runs (the
// "formation_changes" step of the world turn). Otherwise it is immediate.
export function beginFormationSwitch(army, stackId, newType) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  if (!isFormationType(newType)) return fail("bad_formation", `Unknown formation "${newType}".`);
  if (newType === stack.formationType) {
    // Choosing the current formation cancels a pending switch.
    return ok(
      withStacks(army, army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), switchingTo: null } : cloneStack(s))))
    );
  }
  const immediate = !CONFIG.FORMATIONS.SWITCH_COSTS_TURN;
  return ok(
    withStacks(
      army,
      army.stacks.map((s) => {
        if (s.id !== stackId) return cloneStack(s);
        return immediate
          ? { ...cloneStack(s), formationType: newType, switchingTo: null }
          : { ...cloneStack(s), switchingTo: newType };
      })
    )
  );
}

export function cancelFormationSwitch(army, stackId) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  return ok(
    withStacks(army, army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), switchingTo: null } : cloneStack(s))))
  );
}

export function isSwitching(stack) {
  return stack.switchingTo !== null;
}

export function hasPendingSwitch(army) {
  return army.stacks.some(isSwitching);
}

// Applies every pending switch. Returns { army, switched: [stackId...] }.
export function resolveFormationSwitches(army) {
  const switched = [];
  const stacks = army.stacks.map((s) => {
    if (s.switchingTo === null) return cloneStack(s);
    switched.push(s.id);
    return { ...cloneStack(s), formationType: s.switchingTo, switchingTo: null };
  });
  return { army: withStacks(army, stacks), switched };
}

// Local facing of one stack (a line's front). "N" = toward the enemy.
export function setStackFacing(army, stackId, facing) {
  if (!getStack(army, stackId)) return fail("unknown_stack", "That stack does not exist.");
  if (!isDir(facing)) return fail("bad_facing", `Bad facing "${facing}".`);
  return ok(
    withStacks(army, army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), facing } : cloneStack(s))))
  );
}

// Overworld facing of the whole army, chosen at the end of its turn.
export function setArmyFacing(army, facing) {
  if (!isDir(facing)) return fail("bad_facing", `Bad facing "${facing}".`);
  return ok({ ...cloneArmy(army), facing });
}

// ---------------------------------------------------------------
// Layout in the deployment zone
// ---------------------------------------------------------------

// Moves a stack to a cell. If another stack is there, the two swap.
export function setStackCell(army, stackId, col, row) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  if (!validCell(col, row)) return fail("bad_cell", `Cell ${col},${row} is outside the deployment zone.`);
  const other = army.stacks.find((s) => s.id !== stackId && s.cell.col === col && s.cell.row === row);
  const stacks = army.stacks.map((s) => {
    if (s.id === stackId) return { ...cloneStack(s), cell: { col, row } };
    if (other && s.id === other.id) return { ...cloneStack(s), cell: { ...stack.cell } };
    return cloneStack(s);
  });
  return ok(withStacks(army, stacks));
}

// Default layout: melee in the front row, ranged in the back, middle
// columns first. Order is by category, then type id, then stack id, so it
// is identical on every client.
export function autoLayout(army) {
  const sorted = army.stacks
    .slice()
    .sort((a, b) => {
      const ca = getUnitType(a.typeId).category === "ranged" ? 1 : 0;
      const cb = getUnitType(b.typeId).category === "ranged" ? 1 : 0;
      return ca - cb || (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  const placed = [];
  for (const s of sorted) {
    const cell = findFreeCell(placed, s.typeId);
    placed.push({ ...cloneStack(s), cell });
  }
  const byId = new Map(placed.map((s) => [s.id, s]));
  return withStacks(army, army.stacks.map((s) => byId.get(s.id)));
}

// ---------------------------------------------------------------
// Wounds and battle results
// ---------------------------------------------------------------

// Heals a stack's wounded unit. `amount` is the damage to remove; leave it
// out for a full heal. Dead units are never brought back.
export function healStack(army, stackId, amount = Number.MAX_SAFE_INTEGER) {
  const stack = getStack(army, stackId);
  if (!stack) return fail("unknown_stack", "That stack does not exist.");
  if (!Number.isInteger(amount) || amount < 1) return fail("bad_count", "Heal amount must be a whole number of at least 1.");
  const healed = Math.min(amount, stack.carry);
  return ok(
    withStacks(army, army.stacks.map((s) => (s.id === stackId ? { ...cloneStack(s), carry: s.carry - healed } : cloneStack(s)))),
    { healed }
  );
}

export function healArmy(army, amount = Number.MAX_SAFE_INTEGER) {
  let total = 0;
  const stacks = army.stacks.map((s) => {
    const healed = Math.min(amount, s.carry);
    total += healed;
    return { ...cloneStack(s), carry: s.carry - healed };
  });
  return ok(withStacks(army, stacks), { healed: total });
}

export function isWounded(stack) {
  return stack.carry > 0;
}

// Writes battle results back into an army (trusted input from battleGrid).
// outcomes: [{ stackId, count, carry }]. Stacks at 0 are removed. Stacks
// that were not in the battle are untouched. Returns the new army.
export function applyBattleOutcome(army, outcomes) {
  const byId = new Map(outcomes.map((o) => [o.stackId, o]));
  const stacks = [];
  for (const s of army.stacks) {
    const o = byId.get(s.id);
    if (!o) stacks.push(cloneStack(s));
    else if (o.count > 0) stacks.push({ ...cloneStack(s), count: o.count, carry: o.carry, switchingTo: null });
  }
  return withStacks(army, stacks);
}

// ---------------------------------------------------------------
// Validation and loading
// ---------------------------------------------------------------

// Checks a whole roster (use on saved data and on received PvP state).
// Returns a list of problems. An empty list means everything is valid.
export function validateRoster(armies, ctx = {}) {
  const problems = [];
  const armyIds = new Set();
  const stackIds = new Set();

  for (const a of armies) {
    if (armyIds.has(a.id)) problems.push(`Duplicate army id "${a.id}".`);
    armyIds.add(a.id);
    if (!isDir(a.facing)) problems.push(`Army "${a.id}" has a bad facing.`);
    if (a.stacks.length > MAX_STACKS_PER_ARMY) problems.push(`Army "${a.id}" has too many stacks.`);

    const cells = new Set();
    for (const s of a.stacks) {
      if (stackIds.has(s.id)) problems.push(`Duplicate stack id "${s.id}".`);
      stackIds.add(s.id);
      if (!hasUnitType(s.typeId)) problems.push(`Stack "${s.id}" has an unknown type.`);
      if (!Number.isInteger(s.count) || s.count < 1) problems.push(`Stack "${s.id}" has a bad count.`);
      if (!isFormationType(s.formationType)) problems.push(`Stack "${s.id}" has a bad formation.`);
      if (!isDir(s.facing)) problems.push(`Stack "${s.id}" has a bad facing.`);
      if (s.switchingTo !== null && !isFormationType(s.switchingTo)) problems.push(`Stack "${s.id}" has a bad pending switch.`);
      if (!Number.isInteger(s.carry) || s.carry < 0) problems.push(`Stack "${s.id}" has a bad wound value.`);
      if (!s.cell || !validCell(s.cell.col, s.cell.row)) problems.push(`Stack "${s.id}" has a bad cell.`);
      else {
        const key = `${s.cell.col},${s.cell.row}`;
        if (cells.has(key)) problems.push(`Army "${a.id}" has two stacks in cell ${key}.`);
        cells.add(key);
      }
    }
  }
  if (problems.length > 0) return problems;
  if (ctx.enforceLimits === false) return problems;

  const usage = getRosterUsage(armies);
  const pool = ctx.authorityPool ?? getAuthorityPool();
  if (usage.authority > pool) problems.push(`Authority ${usage.authority} is above the limit of ${pool}.`);
  if (CONFIG.AUTHORITY.PER_TYPE_CAP_ENABLED) {
    for (const [typeId, n] of Object.entries(usage.byType)) {
      const cap = getUnitType(typeId).authorityCap;
      if (n > cap) problems.push(`${typeId}: ${n} units is above the cap of ${cap}.`);
    }
  }
  return problems;
}

// Makes any saved/received army object safe. Invalid stacks are dropped,
// bad fields are reset, and cells are reassigned if they clash. Returns
// null if the input is not an army at all. Limits are NOT checked here:
// run validateRoster() afterwards.
export function deserializeArmy(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const stacks = [];
  const used = new Set();
  const list = Array.isArray(raw.stacks) ? raw.stacks : [];

  for (const r of list) {
    if (!r || !r.id || !hasUnitType(r.typeId)) continue;
    const count = Math.floor(Number(r.count));
    if (!Number.isFinite(count) || count < 1) continue;
    if (stacks.length >= MAX_STACKS_PER_ARMY) break;
    const stack = makeStack({
      id: String(r.id),
      typeId: r.typeId,
      count,
      formationType: isFormationType(r.formationType) ? r.formationType : CONFIG.FORMATIONS.DEFAULT,
      facing: isDir(r.facing) ? r.facing : "N",
      cell: { col: -1, row: -1 },
    });
    stack.switchingTo = isFormationType(r.switchingTo) ? r.switchingTo : null;
    const carry = Math.floor(Number(r.carry));
    stack.carry = Number.isFinite(carry) && carry > 0 ? carry : 0;
    if (r.cell && validCell(r.cell.col, r.cell.row) && !used.has(`${r.cell.col},${r.cell.row}`)) {
      stack.cell = { col: r.cell.col, row: r.cell.row };
      used.add(`${stack.cell.col},${stack.cell.row}`);
    }
    stacks.push(stack);
  }
  // Give a free cell to any stack that had none or a clashing one.
  const placedSoFar = stacks.filter((s) => s.cell.col >= 0);
  for (const s of stacks) {
    if (s.cell.col < 0) {
      s.cell = findFreeCell(placedSoFar, s.typeId);
      placedSoFar.push(s);
    }
  }
  return {
    id: String(raw.id),
    ownerId: raw.ownerId ?? null,
    name: typeof raw.name === "string" ? raw.name : "Army",
    facing: isDir(raw.facing) ? raw.facing : "N",
    stacks,
  };
}

export function serializeArmy(army) {
  return JSON.parse(JSON.stringify(army));
}

// ---------------------------------------------------------------
// Self test (call armySelfTest() from the browser console)
// ---------------------------------------------------------------

export function armySelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`armySelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const nextId = createIdCounter("t");

  // Starting armies
  let armies = createStartingArmies("p1", nextId);
  eq(armies.length, 1, "start armies");
  eq(armies[0].stacks.length, 1, "start stacks");
  eq(armies[0].stacks[0].typeId, "swordsman", "start type");
  eq(validateRoster(armies), [], "start roster valid");

  // Adding with limits: swordsman cost 2, cap 6, pool 20
  const ctx = () => ({ armies, nextId });
  let army = armies[0];
  let r = addToStack(army, army.stacks[0].id, 5, ctx());
  eq(r.ok, true, "grow to 6 swordsmen");
  armies = [r.army];
  army = r.army;
  eq(addToStack(army, army.stacks[0].id, 1, ctx()).code, "type_cap", "swordsman cap");

  // Archers are locked until unlocked
  eq(addStack(army, { typeId: "archer", count: 1 }, ctx()).code, "type_locked", "archer locked");
  const unlocked = { ...ctx(), unlockedIds: ["unlock_archers"] };
  r = addStack(army, { typeId: "archer", count: 2 }, unlocked);
  eq(r.ok, true, "add archers");
  army = r.army;
  armies = [army];
  eq(armyAuthority(army), 6 * 2 + 2 * 3, "authority used");
  // Pool is 20: 18 used, so 2 spearmen (cost 4) do not fit
  eq(addStack(army, { typeId: "spearman", count: 2 }, { ...unlocked, armies }).code, "authority_pool", "pool limit");
  // Archers go to the back row
  eq(getStack(army, r.stackId).cell.row, ROWS - 1, "archer back row");

  // Split and merge (player chooses the formation)
  const swordsId = army.stacks[0].id;
  r = splitStack(army, swordsId, 2, { nextId });
  eq(r.ok, true, "split");
  army = r.army;
  eq(getStack(army, swordsId).count, 4, "split remaining");
  eq(armyUnitCount(army), 6 + 2, "units unchanged by split");
  r = mergeStacks(army, swordsId, r.newStackId, "line");
  eq(r.ok, true, "merge");
  army = r.army;
  eq(getStack(army, swordsId).count, 6, "merged count");
  eq(getStack(army, swordsId).formationType, "line", "chosen formation");
  eq(mergeStacks(army, swordsId, army.stacks[1].id).code, "type_mismatch", "merge needs same type");

  // Formation switch takes effect at resolution
  r = beginFormationSwitch(army, swordsId, "square");
  eq(getStack(r.army, swordsId).formationType, "line", "switch pending");
  eq(hasPendingSwitch(r.army), true, "pending flag");
  const res = resolveFormationSwitches(r.army);
  eq(getStack(res.army, swordsId).formationType, "square", "switch resolved");
  eq(res.switched, [swordsId], "switched list");

  // Removing units deletes empty stacks
  r = removeUnits(army, swordsId, 99);
  eq(r.removed, 6, "removed capped");
  eq(getStack(r.army, swordsId), null, "empty stack deleted");

  // Layout swap
  const other = army.stacks[1];
  const a0 = getStack(army, swordsId).cell;
  r = setStackCell(army, swordsId, other.cell.col, other.cell.row);
  eq(getStack(r.army, other.id).cell, a0, "cells swap");

  // Rotation and formation
  eq(rotateDir("N", 1), "E", "rotate right");
  eq(rotateDir("N", -1), "W", "rotate left");
  eq(getStackFormation({ ...getStack(army, swordsId), formationType: "line" }, 2).facing, "S", "formation rotated");

  // Wounds persist, block merging, and heal
  const w = deserializeArmy({
    id: "w",
    stacks: [
      { id: "a", typeId: "swordsman", count: 2, carry: 5 },
      { id: "b", typeId: "swordsman", count: 2, carry: 7 },
    ],
  });
  eq(mergeStacks(w, "a", "b").code, "wounded", "two wounded stacks cannot merge");
  const healedB = healStack(w, "b");
  eq(healedB.healed, 7, "heal amount");
  eq(mergeStacks(healedB.army, "a", "b").army.stacks[0].carry, 5, "merged keeps the wound");
  eq(healStack(w, "a", 2).army.stacks[0].carry, 3, "partial heal");
  const after = applyBattleOutcome(w, [
    { stackId: "a", count: 0, carry: 0 },
    { stackId: "b", count: 1, carry: 3 },
  ]);
  eq(after.stacks.length, 1, "dead stack removed");
  eq([after.stacks[0].count, after.stacks[0].carry], [1, 3], "outcome written back");
  eq(splitStack(w, "a", 1, { nextId }).army.stacks[2].carry, 0, "split-off units are unwounded by default");
  const takeW = splitStack(w, "a", 1, { nextId }, { takeWounded: true });
  eq([takeW.army.stacks[0].carry, takeW.army.stacks[2].carry, takeW.army.stacks[2].count], [0, 5, 1], "split can take the wounded unit");
  eq(splitStack(healedB.army, "b", 1, { nextId }, { takeWounded: true }).code, "not_wounded", "nothing to take");

  // Loading sanitizes bad data
  const dirty = deserializeArmy({ id: "x", stacks: [{ id: "a", typeId: "swordsman", count: 3 }, { id: "b", typeId: "nope", count: 1 }] });
  eq(dirty.stacks.length, 1, "dirty drops bad stacks");
  eq(validateRoster([dirty]), [], "dirty becomes valid");

  return true;
}

export default {
  MAX_STACKS_PER_ARMY,
  createIdCounter,
  rotateDir,
  getAuthorityPool,
  createArmy,
  createStartingArmies,
  getStack,
  armyUnitCount,
  armyAuthority,
  armySalary,
  isArmyEmpty,
  listStacks,
  getRosterUsage,
  getStackFormation,
  checkCanAdd,
  maxAddable,
  addStack,
  addToStack,
  removeUnits,
  mergeStacks,
  splitStack,
  beginFormationSwitch,
  cancelFormationSwitch,
  isSwitching,
  hasPendingSwitch,
  resolveFormationSwitches,
  healStack,
  healArmy,
  isWounded,
  applyBattleOutcome,
  setStackFacing,
  setArmyFacing,
  setStackCell,
  autoLayout,
  validateRoster,
  deserializeArmy,
  serializeArmy,
  armySelfTest,
};
