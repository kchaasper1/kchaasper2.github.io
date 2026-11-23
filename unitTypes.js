// unitTypes.js
// Static data for every unit type, plus lookup helpers.
// All numbers are PLACEHOLDERS to balance later. Integers only.
//
// A unit TYPE is what levels up (all swordsmen share one level), so nothing
// about levels or XP is stored here. progression.js owns that.
//
// How one attack works (battleRules.js will implement it):
//   - Each unit type that attacks makes ONE shared roll in [damageMin, damageMax].
//   - Every attacking unit of that type deals that rolled value.
//   - Health is per unit. A stack's total health = health x count.
//
// Field reference:
//   id               unique string, used everywhere else
//   name             display name
//   category         "melee" | "ranged" (for AI and UI)
//   damageMin/Max    damage range of the shared roll (per attacking unit)
//   health           health of ONE unit
//   attackRange      grid squares the unit can hit (1 = adjacent only)
//   movePoints       grid squares moved per battle turn
//   faceDefense      percent damage reduction while FACING the attacker and
//                    NOT countering (shield). 0 = none.
//   authorityCost    authority used by ONE unit
//   authorityCap     max units of this type a player may have in total
//   hireCost         gold to hire ONE unit
//   salary           gold per world turn for ONE unit
//   hireable         can be hired at villages
//   unlockedByDefault available at the start of every account
//   unlockId         unlockable id that grants this type (if not default)
//   isMonster        roaming neutral monster (never hired, no authority)

import { CONFIG } from "./config.js";

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

const RAW_UNIT_TYPES = [
  {
    id: "swordsman",
    name: "Swordsman",
    category: "melee",
    damageMin: 8,
    damageMax: 14,
    health: 30,
    attackRange: 1,
    movePoints: 3,
    faceDefense: 30, // shield
    authorityCost: 2,
    authorityCap: 6,
    hireCost: 30,
    salary: 2,
    hireable: true,
    unlockedByDefault: true,
    unlockId: null,
    isMonster: false,
  },
  {
    id: "spearman",
    name: "Spearman",
    category: "melee",
    damageMin: 6,
    damageMax: 12,
    health: 28,
    attackRange: 1,
    movePoints: 3,
    faceDefense: 0,
    authorityCost: 2,
    authorityCap: 6,
    hireCost: 25,
    salary: 2,
    hireable: true,
    unlockedByDefault: true,
    unlockId: null,
    isMonster: false,
  },
  {
    id: "archer",
    name: "Archer",
    category: "ranged",
    damageMin: 5,
    damageMax: 11,
    health: 18,
    attackRange: 3,
    movePoints: 3,
    faceDefense: 0,
    authorityCost: 3,
    authorityCap: 4,
    hireCost: 40,
    salary: 3,
    hireable: true,
    unlockedByDefault: false,
    unlockId: "unlock_archers", // granted by a campaign mission (placeholder)
    isMonster: false,
  },
  {
    id: "wolf_pack",
    name: "Wolf Pack",
    category: "melee",
    damageMin: 4,
    damageMax: 9,
    health: 20,
    attackRange: 1,
    movePoints: 4,
    faceDefense: 0,
    authorityCost: 0,
    authorityCap: 0,
    hireCost: 0,
    salary: 0,
    hireable: false,
    unlockedByDefault: false,
    unlockId: null,
    isMonster: true,
  },
];

// ---------------------------------------------------------------
// Validation (runs once on load, so bad data fails loudly)
// ---------------------------------------------------------------

const INTEGER_FIELDS = [
  "damageMin",
  "damageMax",
  "health",
  "attackRange",
  "movePoints",
  "faceDefense",
  "authorityCost",
  "authorityCap",
  "hireCost",
  "salary",
];

function validate(list) {
  const seen = new Set();
  for (const t of list) {
    if (!t.id || typeof t.id !== "string") throw new Error("unitTypes: unit without id");
    if (seen.has(t.id)) throw new Error(`unitTypes: duplicate id "${t.id}"`);
    seen.add(t.id);

    for (const f of INTEGER_FIELDS) {
      if (!Number.isInteger(t[f]) || t[f] < 0) {
        throw new Error(`unitTypes: "${t.id}.${f}" must be a non-negative integer`);
      }
    }
    if (t.damageMin > t.damageMax) throw new Error(`unitTypes: "${t.id}" damageMin > damageMax`);
    if (t.health < 1) throw new Error(`unitTypes: "${t.id}" health must be at least 1`);
    if (t.attackRange < 1) throw new Error(`unitTypes: "${t.id}" attackRange must be at least 1`);
    if (t.faceDefense > 100) throw new Error(`unitTypes: "${t.id}" faceDefense above 100`);
    if (!["melee", "ranged"].includes(t.category)) {
      throw new Error(`unitTypes: "${t.id}" bad category "${t.category}"`);
    }
    if (!t.unlockedByDefault && !t.unlockId && !t.isMonster) {
      throw new Error(`unitTypes: "${t.id}" is locked but has no unlockId`);
    }
    if (!t.isMonster && t.authorityCost < 1) {
      throw new Error(`unitTypes: "${t.id}" needs authorityCost of at least 1`);
    }
    if (!t.isMonster && t.authorityCap < 1) {
      throw new Error(`unitTypes: "${t.id}" needs authorityCap of at least 1`);
    }
  }

  // Every unit used by config must exist.
  for (const army of CONFIG.START.ARMIES) {
    for (const u of army.units) {
      if (!seen.has(u.typeId)) {
        throw new Error(`unitTypes: CONFIG.START references unknown type "${u.typeId}"`);
      }
    }
  }
  for (const id of CONFIG.MONSTERS.TYPES) {
    if (!seen.has(id)) throw new Error(`unitTypes: CONFIG.MONSTERS references unknown type "${id}"`);
  }
}

validate(RAW_UNIT_TYPES);

export const UNIT_TYPES = deepFreeze(
  Object.fromEntries(RAW_UNIT_TYPES.map((t) => [t.id, t]))
);

// ---------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------

export function getUnitType(id) {
  const t = UNIT_TYPES[id];
  if (!t) throw new Error(`unitTypes: unknown unit type "${id}"`);
  return t;
}

export function hasUnitType(id) {
  return Object.prototype.hasOwnProperty.call(UNIT_TYPES, id);
}

// All type ids in a fixed order (alphabetical), so loops are deterministic.
export function listUnitTypeIds() {
  return Object.keys(UNIT_TYPES).sort();
}

export function listUnitTypes() {
  return listUnitTypeIds().map((id) => UNIT_TYPES[id]);
}

// Types a player may use, given the set of unlock ids they own.
// Monsters are never available to players.
export function listAvailableTypes(unlockedIds = []) {
  const owned = new Set(unlockedIds);
  return listUnitTypes().filter(
    (t) => !t.isMonster && (t.unlockedByDefault || owned.has(t.unlockId))
  );
}

// Types a player may hire right now.
export function listHireableTypes(unlockedIds = []) {
  return listAvailableTypes(unlockedIds).filter((t) => t.hireable);
}

export function isTypeAvailable(id, unlockedIds = []) {
  const t = getUnitType(id);
  if (t.isMonster) return false;
  return t.unlockedByDefault || unlockedIds.includes(t.unlockId);
}

// ---------------------------------------------------------------
// Shared sorting rules (so every client orders things identically)
// ---------------------------------------------------------------

// Desertion order from CONFIG.ECONOMY.DESERTION_ORDER:
// most expensive hire cost first, then type id A-Z.
// Pass two objects that each have a typeId (and optionally an id for the
// final tie-break). Returns negative when "a" should desert before "b".
export function compareForDesertion(a, b) {
  const ta = getUnitType(a.typeId);
  const tb = getUnitType(b.typeId);
  for (const rule of CONFIG.ECONOMY.DESERTION_ORDER) {
    let diff = 0;
    if (rule === "hire_cost_desc") diff = tb.hireCost - ta.hireCost;
    else if (rule === "type_id_asc") diff = ta.id < tb.id ? -1 : ta.id > tb.id ? 1 : 0;
    else if (rule === "unit_id_asc") {
      const ia = String(a.id ?? "");
      const ib = String(b.id ?? "");
      diff = ia < ib ? -1 : ia > ib ? 1 : 0;
    }
    if (diff !== 0) return diff;
  }
  return 0;
}

// Total authority used by a list of { typeId, count } entries.
export function authorityUsed(entries) {
  let total = 0;
  for (const e of entries) total += getUnitType(e.typeId).authorityCost * e.count;
  return total;
}

export default UNIT_TYPES;

