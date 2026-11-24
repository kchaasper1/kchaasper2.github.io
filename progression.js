// progression.js
// Per-unit-TYPE levels and fixed-point XP. Pure logic, no graphics, no
// network. Every function returns a NEW state and never edits the one passed
// in, so states are easy to save, compare between PvP clients, and replay.
//
// Core rules (from the design):
//  - Levels belong to unit types: leveling swordsmen levels ALL swordsmen.
//  - XP is stored x100 (fixed point) and always rounded DOWN.
//  - Only units that attacked contribute. XP is awarded at the end of a turn.
//  - XP of one roll = roll position / number of independent attacking units
//    of that type (stacks count once, across all armies).
//  - Level-ups apply AFTER combat. During a battle XP goes into a pending
//    pool, and levels only change when commitBattle() is called.
//
// State shape (plain JSON, safe to save to Firebase):
//   {
//     levels:    { swordsman: 1, spearman: 1, ... },   // effective levels
//     xp:        { swordsman: 0, ... },                // committed XP (x100)
//     pendingXp: { swordsman: 0, ... }                 // this battle (x100)
//   }

import { CONFIG } from "./config.js";
import { listUnitTypes, hasUnitType, getUnitType } from "./unitTypes.js";

const { MAX_LEVEL, START_LEVEL, XP_TO_REACH_LEVEL } = CONFIG.PROGRESSION;
const { PERCENT, XP_SCALE } = CONFIG.MATH;

// Fail loudly if the config table does not match MAX_LEVEL.
if (XP_TO_REACH_LEVEL.length !== MAX_LEVEL) {
  throw new Error(
    `progression: XP_TO_REACH_LEVEL has ${XP_TO_REACH_LEVEL.length} entries, MAX_LEVEL is ${MAX_LEVEL}`
  );
}

// Types that can level (monsters do not).
function progressionTypeIds() {
  return listUnitTypes()
    .filter((t) => !t.isMonster)
    .map((t) => t.id);
}

// ---------------------------------------------------------------
// Creating and loading state
// ---------------------------------------------------------------

// Fresh state: every type at level 1 with no XP.
export function createProgression() {
  const levels = {};
  const xp = {};
  const pendingXp = {};
  for (const id of progressionTypeIds()) {
    levels[id] = START_LEVEL;
    xp[id] = 0;
    pendingXp[id] = 0;
  }
  return { levels, xp, pendingXp };
}

// Which state a new game starts with, depending on the mode.
//  - Campaign: keeps saved levels only if PERSIST_IN_CAMPAIGN is on.
//  - Every other mode (World Battle vs AI / vs Players): always level 1.
// Unlockables are NOT stored here. saveData.js keeps them separately.
export function createProgressionForMode(modeId, savedState = null) {
  if (modeId === CONFIG.MODES.CAMPAIGN.id) {
    if (CONFIG.PROGRESSION.PERSIST_IN_CAMPAIGN && savedState) {
      return deserializeProgression(savedState);
    }
    return createProgression();
  }
  return createProgression();
}

// Makes any saved/received object safe: right shape, integers, in range.
// Unknown unit types are dropped, missing ones are added at level 1.
export function deserializeProgression(raw) {
  const state = createProgression();
  if (!raw || typeof raw !== "object") return state;

  for (const id of progressionTypeIds()) {
    const xp = toNonNegativeInt(raw.xp && raw.xp[id]);
    const pending = toNonNegativeInt(raw.pendingXp && raw.pendingXp[id]);
    state.xp[id] = xp;
    state.pendingXp[id] = pending;
    // Level is always recomputed from committed XP, never trusted.
    state.levels[id] = levelFromXp(xp);
  }
  return state;
}

export function serializeProgression(state) {
  // The state is already plain JSON. Return a deep copy.
  return JSON.parse(JSON.stringify(state));
}

function toNonNegativeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function cloneState(state) {
  return {
    levels: { ...state.levels },
    xp: { ...state.xp },
    pendingXp: { ...state.pendingXp },
  };
}

// ---------------------------------------------------------------
// Levels and XP math
// ---------------------------------------------------------------

// Level reached with a given total XP (x100).
export function levelFromXp(xp) {
  let level = START_LEVEL;
  for (let l = START_LEVEL + 1; l <= MAX_LEVEL; l++) {
    if (xp >= XP_TO_REACH_LEVEL[l - 1]) level = l;
    else break;
  }
  return level;
}

export function getLevel(state, typeId) {
  assertType(typeId);
  return state.levels[typeId] ?? START_LEVEL;
}

// XP (x100) still needed for the next level, or 0 at max level.
// Counts committed XP only, matching what the level actually is.
export function xpToNextLevel(state, typeId) {
  assertType(typeId);
  const level = getLevel(state, typeId);
  if (level >= MAX_LEVEL) return 0;
  return Math.max(0, XP_TO_REACH_LEVEL[level] - state.xp[typeId]);
}

// XP (x100) from ONE shared roll.
//   position     0..100, from rng.rollRange(...).position
//   contributors number of independent units of that type that attacked
//                (stacks count once, across all armies). Must be at least 1.
//   modifierPercent optional, 100 = normal. Reserved for diminishing XP
//                against much weaker enemies (CONFIG.PROGRESSION flag).
// Result is rounded DOWN, in fixed point (x XP_SCALE).
export function computeXpAward(position, contributors, modifierPercent = 100) {
  if (!Number.isInteger(position) || position < 0 || position > 100) {
    throw new Error(`progression: roll position must be an integer 0..100, got ${position}`);
  }
  if (!Number.isInteger(contributors) || contributors < 1) {
    throw new Error(`progression: contributors must be an integer >= 1, got ${contributors}`);
  }
  if (!Number.isInteger(modifierPercent) || modifierPercent < 0) {
    throw new Error(`progression: modifierPercent must be a non-negative integer`);
  }
  const base = CONFIG.PROGRESSION.XP_FROM_ROLL_BASE; // 100 = position x1
  // position * XP_SCALE * base / (PERCENT * contributors), then the modifier.
  const raw = Math.floor((position * XP_SCALE * base) / (PERCENT * contributors));
  return Math.floor((raw * modifierPercent) / PERCENT);
}

// ---------------------------------------------------------------
// Awarding XP during a battle (levels do NOT change here)
// ---------------------------------------------------------------

// Call once at the END of each turn with every type that attacked:
//   awards = [{ typeId, position, contributors, modifierPercent? }, ...]
// XP goes to the pending pool. Returns { state, gained } where gained maps
// typeId -> XP (x100) actually added (after the per-battle cap, if any).
export function awardTurnXp(state, awards) {
  const next = cloneState(state);
  const gained = {};
  const cap = CONFIG.PROGRESSION.XP_PER_BATTLE_CAP; // 0 = no cap

  // Sort so the result never depends on the order the caller used.
  const ordered = awards.slice().sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0));

  for (const a of ordered) {
    assertType(a.typeId);
    let add = computeXpAward(a.position, a.contributors, a.modifierPercent ?? 100);
    const pending = next.pendingXp[a.typeId] ?? 0;
    if (cap > 0) add = Math.max(0, Math.min(add, cap - pending));
    next.pendingXp[a.typeId] = pending + add;
    gained[a.typeId] = (gained[a.typeId] ?? 0) + add;
  }
  return { state: next, gained };
}

// ---------------------------------------------------------------
// Ending a battle: this is where levels actually change
// ---------------------------------------------------------------

// Moves pending XP into committed XP and recomputes levels.
// Returns { state, levelUps } where levelUps lists every type that rose:
//   [{ typeId, from, to }]  (sorted by typeId, so UI order is stable)
export function commitBattle(state) {
  const next = cloneState(state);
  const levelUps = [];

  for (const id of progressionTypeIds()) {
    const before = next.levels[id] ?? START_LEVEL;
    next.xp[id] = (next.xp[id] ?? 0) + (next.pendingXp[id] ?? 0);
    next.pendingXp[id] = 0;
    next.levels[id] = levelFromXp(next.xp[id]);
    if (next.levels[id] > before) {
      levelUps.push({ typeId: id, from: before, to: next.levels[id] });
    }
  }
  return { state: next, levelUps };
}

// Discards pending XP (for example a battle abandoned without a result).
export function discardPendingXp(state) {
  const next = cloneState(state);
  for (const id of Object.keys(next.pendingXp)) next.pendingXp[id] = 0;
  return next;
}

// ---------------------------------------------------------------
// Stats at a level
// ---------------------------------------------------------------

// Percent multiplier for a level (level 1 = 100).
export function damagePercentAtLevel(level) {
  return PERCENT + CONFIG.PROGRESSION.DAMAGE_PERCENT_PER_LEVEL * (clampLevel(level) - 1);
}

export function healthPercentAtLevel(level) {
  return PERCENT + CONFIG.PROGRESSION.HEALTH_PERCENT_PER_LEVEL * (clampLevel(level) - 1);
}

// Level-scaled stats for one unit of a type. Rounded down; health is never
// below 1 and damage is never below 0. Other stats do not scale.
export function statsAtLevel(typeId, level) {
  const t = getUnitType(typeId);
  const dmg = damagePercentAtLevel(level);
  const hp = healthPercentAtLevel(level);
  return {
    typeId,
    level: clampLevel(level),
    damageMin: Math.floor((t.damageMin * dmg) / PERCENT),
    damageMax: Math.floor((t.damageMax * dmg) / PERCENT),
    health: Math.max(1, Math.floor((t.health * hp) / PERCENT)),
  };
}

// Convenience: stats using the level stored in a progression state.
export function statsFromState(state, typeId) {
  return statsAtLevel(typeId, getLevel(state, typeId));
}

function clampLevel(level) {
  if (!Number.isInteger(level)) return START_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(START_LEVEL, level));
}

function assertType(typeId) {
  if (!hasUnitType(typeId)) throw new Error(`progression: unknown unit type "${typeId}"`);
}

export default {
  createProgression,
  createProgressionForMode,
  deserializeProgression,
  serializeProgression,
  levelFromXp,
  getLevel,
  xpToNextLevel,
  computeXpAward,
  awardTurnXp,
  commitBattle,
  discardPendingXp,
  damagePercentAtLevel,
  healthPercentAtLevel,
  statsAtLevel,
  statsFromState,
};

