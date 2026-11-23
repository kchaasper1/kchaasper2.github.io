// rng.js
// Seeded, deterministic random numbers. Every client that starts from the
// same seed and makes the same calls in the same order gets the same values.
//
// RULES FOR THE WHOLE PROJECT:
//  - Never call Math.random() for anything that affects game state.
//  - Only createSeed() is allowed to be non-deterministic, and its result
//    must be stored in the match record so all clients share it.
//  - Use fork(label) to give each system its own independent stream
//    (map generation, battles, monster spawns...) so a change in one
//    system never shifts the numbers used by another.
//
// Algorithm: mulberry32 (32-bit integer math only, via Math.imul), so the
// results are identical in every browser.

import { CONFIG } from "./config.js";

const TWO_32 = 4294967296;

// ---------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------

// FNV-1a hash: turns any string or number into an unsigned 32-bit integer.
export function hashSeed(input) {
  const str = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Creates a brand new seed for a new match or campaign run.
// This is the ONLY non-deterministic function. Store the result.
export function createSeed() {
  if (CONFIG.DEBUG.FORCE_SEED !== null) return hashSeed(CONFIG.DEBUG.FORCE_SEED);
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  } catch (e) {
    return hashSeed(Date.now() + ":" + (typeof performance !== "undefined" ? performance.now() : 0));
  }
}

// ---------------------------------------------------------------
// Generator
// ---------------------------------------------------------------

export function createRng(seed, label = "root") {
  const baseSeed = hashSeed(seed);
  let a = baseSeed;
  let draws = 0;

  // Core: next unsigned 32-bit integer.
  function nextUint32() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    draws++;
    const out = (t ^ (t >>> 14)) >>> 0;
    if (CONFIG.DEBUG.LOG_RNG) console.log(`[rng:${label}] #${draws} = ${out}`);
    return out;
  }

  // Integer in [min, max], both inclusive, with no modulo bias.
  function nextInt(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(`rng.nextInt needs integers, got ${min}, ${max}`);
    }
    if (max < min) throw new Error(`rng.nextInt: max (${max}) < min (${min})`);
    const n = max - min + 1;
    if (n > TWO_32) throw new Error("rng.nextInt: range too large");
    if (n === 1) {
      // Still consume a draw so call order stays identical everywhere.
      nextUint32();
      return min;
    }
    const limit = Math.floor(TWO_32 / n) * n;
    let r = nextUint32();
    while (r >= limit) r = nextUint32();
    return min + (r % n);
  }

  // True with probability perMille / 1000 (0 = never, 1000 = always).
  function chancePerMille(perMille) {
    return nextInt(0, 999) < perMille;
  }

  // True with probability percent / 100.
  function chancePercent(percent) {
    return nextInt(0, 99) < percent;
  }

  // Picks one element of an array.
  function pick(array) {
    if (array.length === 0) throw new Error("rng.pick: empty array");
    return array[nextInt(0, array.length - 1)];
  }

  // Returns a NEW shuffled array (Fisher-Yates). Original is untouched.
  function shuffle(array) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = nextInt(0, i);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // Combat roll for a unit type's damage range [min, max], inclusive.
  // Returns the damage value and the roll position (0..100) inside the
  // range, which progression.js uses to decide how much XP the roll gives.
  // If min === max the position is 50.
  function rollRange(min, max) {
    const value = nextInt(min, max);
    const span = max - min;
    const position = span === 0 ? 50 : Math.floor(((value - min) * 100) / span);
    return { value, position };
  }

  // Independent child stream. Depends only on the base seed and the label,
  // NOT on how many numbers this generator has already produced. That keeps
  // replays stable even if call counts differ between systems.
  function fork(childLabel) {
    return createRng(hashSeed(`${baseSeed}:${childLabel}`), `${label}/${childLabel}`);
  }

  // State access, for saving a match mid-way or comparing clients.
  function getState() {
    return { baseSeed, state: a >>> 0, draws };
  }

  function setState(saved) {
    a = saved.state | 0;
    draws = saved.draws;
  }

  return {
    nextUint32,
    nextInt,
    chancePerMille,
    chancePercent,
    pick,
    shuffle,
    rollRange,
    fork,
    getState,
    setState,
    get seed() {
      return baseSeed;
    },
    get draws() {
      return draws;
    },
  };
}

// ---------------------------------------------------------------
// Convenience: the named streams a match uses
// ---------------------------------------------------------------
// Both PvP clients call this with the seed stored in the match record.
// Battles get their own stream per battle id, so two battles resolved in a
// different order on different clients still produce identical results.
export function createMatchStreams(matchSeed) {
  const root = createRng(matchSeed, "match");
  return {
    root,
    map: root.fork("map"),
    monsters: root.fork("monsters"),
    villages: root.fork("villages"),
    ai: root.fork("ai"),
    battle: (battleId) => root.fork(`battle:${battleId}`),
  };
}

export default createRng;

