// mapGenerator.js
// Builds the starting situation of a World Battle (vs AI or vs Players) from
// a seed. Pure and deterministic: the same seed and settings give exactly the
// same map on every client, so in PvP only the seed and the settings need to
// be stored in the match record.
//
// ---------------------------------------------------------------
// WHAT IT MAKES
// ---------------------------------------------------------------
//  - The overworld world (overworld.js): an open field, no obstacles.
//  - Each player's start point and starting armies (army.js, CONFIG.START).
//  - Villages (villages.js): each player's starting villages plus neutral
//    ones, with names.
//  - In "ai" mode, enemy armies owned by one AI owner, built from the same
//    unit types the player starts with.
//  - An empty monster list (monsters.js spawns them during play) and a fresh
//    economy for each player.
//
// START LAYOUTS (CONFIG.MAP_GENERATION.LAYOUT or the `layout` option)
//  "ring"       Players are spaced evenly around a square ring and the ring
//               is turned by a random amount. With 2 players (or 4 on a
//               square map) the map is mirrored by rotating it: every
//               player's starting villages are rotated copies of each
//               other, and so are the neutral villages that divide evenly.
//               That is the fair layout for PvP. Extra neutral villages that
//               do not divide evenly are placed at random.
//  "irregular"  Players start at random spots at least MIN_START_DISTANCE
//               apart. Nothing is mirrored, so luck decides how good a start
//               is (see `balance` in the result to compare them).
//  If a ring cannot be built, the generator falls back to irregular and adds
//  a warning.
//
// ENEMY PLACEMENT (ai mode; the `enemyPlacement` option)
//  "random", "near_villages" (2 to 3 tiles from a neutral village) or
//  "mixed" (alternating). Enemies never start close to a player.
//
// RANDOMNESS
//  Only the seeded generator from rng.js is used, with a separate stream for
//  each stage, so changing one stage never changes the others. No
//  Math.random and no trigonometry (browsers can differ there): the ring is
//  a square loop and rotations are exact integer turns of the tile grid.
//
// IDS
//  Armies and stacks get ids "g1", "g2", ... from a counter. The result's
//  `nextId` is the counter's value afterwards: start your own counter with
//  createIdCounter("g", map.nextId) so later ids never clash. Villages are
//  "v1", "v2", ...
//
// Use hashMap() to compare maps between clients (desync check).

import { CONFIG } from "./config.js";
import { createRng, hashSeed } from "./rng.js";
import { listAvailableTypes } from "./unitTypes.js";
import { createArmy, addStack, createStartingArmies, createIdCounter, validateRoster } from "./army.js";
import { createWorld, addArmy, tileToPoint, pointToTile, isqrt } from "./overworld.js";
import { createVillage } from "./villages.js";
import { createEconomy } from "./economy.js";

const MG = CONFIG.MAP_GENERATION;
const V = CONFIG.VILLAGES;
const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;
const DIRS = CONFIG.FACING.DIRECTIONS;
const ATTEMPTS = 300;

const VILLAGE_NAMES = [
  "Oakfield", "Riverbend", "Stonebridge", "Ashford", "Millbrook", "Hollowmere", "Eastwatch", "Brackenhill",
  "Wolfden", "Thornwick", "Greywater", "Highmeadow", "Marshgate", "Cinderford", "Larkspur", "Dunmore",
  "Fernhollow", "Saltmarsh", "Ironvale", "Willowmere",
];

// ---------------------------------------------------------------
// Small helpers (tiles are { x, y } integers)
// ---------------------------------------------------------------

function d2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function inside(t, W, H, margin) {
  return t.x >= margin && t.y >= margin && t.x <= W - 1 - margin && t.y <= H - 1 - margin;
}

// Turns a tile k quarter turns clockwise about the map center. Exact in
// integers. Odd turns need a square map.
export function rotateTile(t, k, W, H) {
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return { x: t.x, y: t.y };
  if (q === 2) return { x: W - 1 - t.x, y: H - 1 - t.y };
  if (W !== H) throw new Error("mapGenerator: quarter turns need a square map");
  return q === 1 ? { x: W - 1 - t.y, y: t.x } : { x: t.y, y: W - 1 - t.x };
}

function rotateVector(v, k) {
  let { x, y } = v;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return { x, y };
}

// A point on the rectangular ring, going clockwise from the top-left corner.
function loopPoint(t, a, bx, by) {
  const Lx = bx - a;
  const Ly = by - a;
  if (t < Lx) return { x: a + t, y: a };
  if (t < Lx + Ly) return { x: bx, y: a + (t - Lx) };
  if (t < 2 * Lx + Ly) return { x: bx - (t - Lx - Ly), y: by };
  return { x: a, y: by - (t - 2 * Lx - Ly) };
}

function facingToward(from, W, H) {
  const dx = Math.floor(W / 2) - from.x;
  const dy = Math.floor(H / 2) - from.y;
  if (dx === 0 && dy === 0) return "N";
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

function spaced(tile, others, spacing) {
  return others.every((o) => d2(tile, o) >= spacing * spacing);
}

// ---------------------------------------------------------------
// Start points
// ---------------------------------------------------------------

function startsAreFarEnough(points) {
  const min2 = MG.MIN_START_DISTANCE * MG.MIN_START_DISTANCE;
  return points.every((p, i) => points.every((q, j) => j <= i || d2(p, q) >= min2));
}

function ringStarts(rng, W, H, n) {
  const a = MG.RING_INSET;
  const bx = W - 1 - a;
  const by = H - 1 - a;
  if (bx - a < 1 || by - a < 1) return null;
  const P = 2 * ((bx - a) + (by - a));
  const spacing = Math.floor(P / n);
  const symmetric = n === 2 || (n === 4 && W === H);
  const rotations = symmetric ? (n === 2 ? [0, 2] : [0, 1, 2, 3]) : null;

  const offsets = rng.shuffle(Array.from({ length: spacing }, (_, i) => i));
  for (const t0 of offsets) {
    const pts = Array.from({ length: n }, (_, i) => loopPoint((t0 + Math.floor((i * P) / n)) % P, a, bx, by));
    if (n >= 2 && !startsAreFarEnough(pts)) continue;
    return { starts: pts, symmetric, rotations, layout: "ring" };
  }
  return null;
}

function irregularStarts(rng, W, H, n) {
  const m = MG.START_MARGIN;
  if (W - 1 - 2 * m < 1 || H - 1 - 2 * m < 1) return null;
  const min2 = MG.MIN_START_DISTANCE * MG.MIN_START_DISTANCE;
  const pts = [];
  for (let i = 0; i < n; i++) {
    let placed = null;
    for (let attempt = 0; attempt < ATTEMPTS && !placed; attempt++) {
      const p = { x: rng.nextInt(m, W - 1 - m), y: rng.nextInt(m, H - 1 - m) };
      if (pts.every((q) => d2(p, q) >= min2)) placed = p;
    }
    if (!placed) return null;
    pts.push(placed);
  }
  return { starts: pts, symmetric: false, rotations: null, layout: "irregular" };
}

function chooseStarts(rng, W, H, n, layout, warnings) {
  if (layout === "ring") {
    const r = ringStarts(rng.fork("ring"), W, H, n);
    if (r) return r;
    warnings.push("A ring layout did not fit; used irregular starts instead.");
  }
  const irr = irregularStarts(rng.fork("irregular"), W, H, n);
  if (!irr) throw new Error("mapGenerator: the map is too small to place that many players");
  return irr;
}

// ---------------------------------------------------------------
// Villages
// ---------------------------------------------------------------

// Places villages. Returns [{ tile, ownerId }] in creation order.
function placeVillages(rng, W, H, players, starts, symmetric, rotations, warnings) {
  const out = [];
  const tiles = () => out.map((v) => v.tile);
  const VM = MG.VILLAGE_MARGIN;
  const spacing = MG.VILLAGE_MIN_SPACING;
  const farFromStarts = (t, exceptIndex) =>
    starts.every((s, i) => i === exceptIndex || d2(t, s) >= MG.NEUTRAL_MIN_DISTANCE_FROM_START ** 2);

  // --- Starting villages ---
  const startRng = rng.fork("start-villages");
  for (let k = 0; k < V.PER_PLAYER_START; k++) {
    let done = false;
    for (let attempt = 0; attempt < ATTEMPTS && !done; attempt++) {
      const R = MG.START_VILLAGE_MAX_DISTANCE;
      if (symmetric) {
        const c = { x: starts[0].x + startRng.nextInt(-R, R), y: starts[0].y + startRng.nextInt(-R, R) };
        const dist2 = d2(c, starts[0]);
        if (dist2 < MG.START_VILLAGE_MIN_DISTANCE ** 2 || dist2 > R * R) continue;
        const copies = rotations.map((q) => rotateTile(c, q, W, H));
        const ok =
          copies.every((t, j) => inside(t, W, H, VM) && farFromStarts(t, j)) &&
          copies.every((t) => spaced(t, tiles(), spacing)) &&
          copies.every((t, i) => copies.every((u, j) => j <= i || d2(t, u) >= spacing * spacing));
        if (!ok) continue;
        copies.forEach((t, j) => out.push({ tile: t, ownerId: players[j].ownerId }));
        done = true;
      } else {
        // Asymmetric: every player gets their own village, one at a time.
        const batch = [];
        let allPlaced = true;
        for (let j = 0; j < players.length; j++) {
          let placed = null;
          for (let a2 = 0; a2 < ATTEMPTS && !placed; a2++) {
            const c = { x: starts[j].x + startRng.nextInt(-R, R), y: starts[j].y + startRng.nextInt(-R, R) };
            const dist2 = d2(c, starts[j]);
            if (dist2 < MG.START_VILLAGE_MIN_DISTANCE ** 2 || dist2 > R * R) continue;
            if (!inside(c, W, H, VM) || !farFromStarts(c, j)) continue;
            if (!spaced(c, tiles().concat(batch.map((b) => b.tile)), spacing)) continue;
            placed = c;
          }
          if (!placed) {
            allPlaced = false;
            warnings.push(`Could not place starting village ${k + 1} for ${players[j].ownerId}.`);
            continue;
          }
          batch.push({ tile: placed, ownerId: players[j].ownerId });
        }
        batch.forEach((b) => out.push(b));
        done = true;
        if (!allPlaced) break;
      }
    }
    if (!done) warnings.push(`Could not place starting village ${k + 1}.`);
  }

  // --- Neutral villages ---
  const neutralRng = rng.fork("neutral-villages");
  const total = V.NEUTRAL_VILLAGES;
  const families = symmetric ? Math.floor(total / players.length) : 0;
  let placedNeutral = 0;

  for (let f = 0; f < families; f++) {
    let done = false;
    for (let attempt = 0; attempt < ATTEMPTS && !done; attempt++) {
      const c = { x: neutralRng.nextInt(VM, W - 1 - VM), y: neutralRng.nextInt(VM, H - 1 - VM) };
      const copies = rotations.map((q) => rotateTile(c, q, W, H));
      const ok =
        copies.every((t) => farFromStarts(t, -1)) &&
        copies.every((t) => spaced(t, tiles(), spacing)) &&
        copies.every((t, i) => copies.every((u, j) => j <= i || d2(t, u) >= spacing * spacing));
      if (!ok) continue;
      copies.forEach((t) => out.push({ tile: t, ownerId: null }));
      placedNeutral += copies.length;
      done = true;
    }
    if (!done) warnings.push("Could not place a mirrored set of neutral villages.");
  }
  // The rest (everything when not mirrored) are placed one by one.
  while (placedNeutral < total) {
    let done = false;
    for (let attempt = 0; attempt < ATTEMPTS && !done; attempt++) {
      const c = { x: neutralRng.nextInt(VM, W - 1 - VM), y: neutralRng.nextInt(VM, H - 1 - VM) };
      if (!farFromStarts(c, -1) || !spaced(c, tiles(), spacing)) continue;
      out.push({ tile: c, ownerId: null });
      placedNeutral++;
      done = true;
    }
    if (!done) {
      warnings.push(`Placed ${placedNeutral} of ${total} neutral villages.`);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------
// Enemy armies (ai mode)
// ---------------------------------------------------------------

function enemyTypePool() {
  return listAvailableTypes([]).filter((t) => t.hireable).map((t) => t.id);
}

function placeEnemies(rng, W, H, count, placement, starts, neutralVillages, warnings) {
  const tiles = [];
  const unusedVillages = rng.fork("which-villages").shuffle(neutralVillages);
  const minStart2 = MG.ENEMY_MIN_DISTANCE_FROM_START ** 2;
  const spacing2 = MG.ENEMY_MIN_SPACING ** 2;
  const okSpot = (t) =>
    inside(t, W, H, 1) && starts.every((s) => d2(t, s) >= minStart2) && tiles.every((o) => d2(t, o) >= spacing2);

  for (let i = 0; i < count; i++) {
    const r = rng.fork(`enemy:${i}`);
    const wantVillage = placement === "near_villages" || (placement === "mixed" && i % 2 === 0);
    let spot = null;

    if (wantVillage) {
      while (unusedVillages.length > 0 && !spot) {
        const v = unusedVillages.shift();
        for (let attempt = 0; attempt < 60 && !spot; attempt++) {
          const lo = MG.ENEMY_NEAR_VILLAGE_MIN;
          const hi = MG.ENEMY_NEAR_VILLAGE_MAX;
          const c = { x: v.x + r.nextInt(-hi, hi), y: v.y + r.nextInt(-hi, hi) };
          const dist2 = d2(c, v);
          if (dist2 >= lo * lo && dist2 <= hi * hi && okSpot(c)) spot = c;
        }
      }
    }
    for (let attempt = 0; attempt < ATTEMPTS && !spot; attempt++) {
      const c = { x: r.nextInt(1, W - 2), y: r.nextInt(1, H - 2) };
      if (okSpot(c)) spot = c;
    }
    if (!spot) {
      warnings.push(`Could not place enemy army ${i + 1}.`);
      continue;
    }
    tiles.push(spot);
  }
  return tiles;
}

function makeEnemyArmy(rng, nextId, ownerId, index, facing) {
  let army = createArmy({ id: nextId(), ownerId, name: `Raiders ${index + 1}`, facing });
  const types = enemyTypePool();
  const stacks = rng.nextInt(MG.ENEMY_STACKS_MIN, MG.ENEMY_STACKS_MAX);
  for (let i = 0; i < stacks; i++) {
    const res = addStack(
      army,
      {
        typeId: rng.pick(types),
        count: rng.nextInt(MG.ENEMY_STACK_COUNT_MIN, MG.ENEMY_STACK_COUNT_MAX),
        formationType: rng.pick(CONFIG.FORMATIONS.TYPES),
      },
      { nextId, enforceLimits: false }
    );
    if (!res.ok) throw new Error(`mapGenerator: could not build an enemy army: ${res.reason}`);
    army = res.army;
  }
  return army;
}

// ---------------------------------------------------------------
// The generator
// ---------------------------------------------------------------

// Options:
//   seed             any string or number
//   players          [{ ownerId, isAI? }]   (1 to CONFIG.NETWORK.MAX_PLAYERS)
//   mode             "ai" (enemy armies roam the map) or "pvp" (none)
//   layout           "ring" | "irregular"   (default CONFIG.MAP_GENERATION.LAYOUT)
//   enemyPlacement   "random" | "near_villages" | "mixed"
//   enemyArmies      how many enemy armies (default: START_ENEMY_ARMIES in ai
//                    mode, 0 in pvp mode)
//   width, height    map size in tiles (default from the config)
//
// Returns {
//   seed, mode, layout, symmetric, width, height,
//   players: [{ ownerId, isAI, start: { x, y }, armyIds }],
//   armies, world, villages, monsters, economies, enemyOwnerId,
//   nextId, warnings, balance
// }
export function generateWorldBattle({
  seed,
  players,
  mode = "ai",
  layout = MG.LAYOUT,
  enemyPlacement = MG.ENEMY_PLACEMENT,
  enemyArmies,
  width = MG.WIDTH_TILES,
  height = MG.HEIGHT_TILES,
}) {
  if (!Array.isArray(players) || players.length < 1 || players.length > CONFIG.NETWORK.MAX_PLAYERS) {
    throw new Error(`mapGenerator: needs 1 to ${CONFIG.NETWORK.MAX_PLAYERS} players`);
  }
  if (new Set(players.map((p) => p.ownerId)).size !== players.length) throw new Error("mapGenerator: duplicate player ids");
  if (!["ai", "pvp"].includes(mode)) throw new Error(`mapGenerator: bad mode "${mode}"`);
  if (!["ring", "irregular"].includes(layout)) throw new Error(`mapGenerator: bad layout "${layout}"`);
  if (!["random", "near_villages", "mixed"].includes(enemyPlacement)) throw new Error(`mapGenerator: bad enemyPlacement "${enemyPlacement}"`);
  const W = width;
  const H = height;
  const n = players.length;
  const enemyCount = enemyArmies ?? (mode === "ai" ? MG.START_ENEMY_ARMIES : 0);

  const root = createRng(seed).fork("world-battle");
  const warnings = [];

  // 1. Start points
  const placed = chooseStarts(root.fork("starts"), W, H, n, layout, warnings);
  const { starts, symmetric, rotations } = placed;

  // 2. Villages
  const villageSpots = placeVillages(root.fork("villages"), W, H, players, starts, symmetric, rotations, warnings);
  const names = root.fork("names").shuffle(VILLAGE_NAMES);
  const villages = villageSpots.map((v, i) =>
    createVillage({ id: `v${i + 1}`, name: names[i] || `Village ${i + 1}`, tx: v.tile.x, ty: v.tile.y, ownerId: v.ownerId })
  );

  // 3. Armies
  const nextId = createIdCounter("g");
  const armies = [];
  const facings = new Map();
  const where = new Map(); // army id -> tile
  const playerInfo = players.map((p, i) => {
    const rot = symmetric ? rotations[i] : 0;
    const made = createStartingArmies(p.ownerId, nextId);
    const facing = facingToward(starts[i], W, H);
    made.forEach((army, a) => {
      const off = rotateVector({ x: a, y: 0 }, rot);
      const tile = { x: Math.min(W - 1, Math.max(0, starts[i].x + off.x)), y: Math.min(H - 1, Math.max(0, starts[i].y + off.y)) };
      armies.push({ ...army, facing });
      facings.set(army.id, facing);
      where.set(army.id, tile);
    });
    return { ownerId: p.ownerId, isAI: !!p.isAI, start: { ...starts[i] }, armyIds: made.map((a) => a.id) };
  });

  // 4. Enemy armies (ai mode)
  const neutral = villageSpots.filter((v) => v.ownerId === null).map((v) => v.tile);
  const enemyOwnerId = enemyCount > 0 ? MG.ENEMY_OWNER_ID : null;
  if (enemyCount > 0) {
    if (players.some((p) => p.ownerId === enemyOwnerId)) throw new Error(`mapGenerator: "${enemyOwnerId}" is reserved for the enemy`);
    const spots = placeEnemies(root.fork("enemies"), W, H, enemyCount, enemyPlacement, starts, neutral, warnings);
    spots.forEach((tile, i) => {
      const r = root.fork(`enemy-army:${i}`);
      const facing = r.pick(DIRS);
      const army = makeEnemyArmy(r, nextId, enemyOwnerId, i, facing);
      armies.push(army);
      facings.set(army.id, facing);
      where.set(army.id, tile);
    });
  }

  // 5. The overworld world
  let world = createWorld({ widthTiles: W, heightTiles: H });
  for (const army of armies) {
    const t = where.get(army.id);
    world = addArmy(world, { id: army.id, ownerId: army.ownerId, ...tileToPoint(t.x, t.y), facing: facings.get(army.id) });
  }

  // 6. Information for comparing starts
  const neutralTiles = neutral;
  const balance = players.map((p, i) => {
    const near = neutralTiles.length ? Math.min(...neutralTiles.map((t) => d2(t, starts[i]))) : null;
    const others = starts.filter((_, j) => j !== i);
    const far = others.length ? Math.min(...others.map((s) => d2(s, starts[i]))) : null;
    return {
      ownerId: p.ownerId,
      startVillages: villageSpots.filter((v) => v.ownerId === p.ownerId).length,
      nearestNeutralVillage: near === null ? null : isqrt(near),
      nearestOtherStart: far === null ? null : isqrt(far),
    };
  });

  return {
    seed,
    mode,
    layout: placed.layout,
    symmetric,
    rotations,
    width: W,
    height: H,
    players: playerInfo,
    armies,
    world,
    villages,
    monsters: [],
    economies: Object.fromEntries(players.map((p) => [p.ownerId, createEconomy()])),
    enemyOwnerId,
    nextId: nextId.value,
    warnings,
    balance,
  };
}

// A number that is the same on every client for the same map. Compare it
// between players to catch a desync.
export function hashMap(map) {
  return hashSeed(JSON.stringify(map));
}

// ---------------------------------------------------------------
// Checking a map
// ---------------------------------------------------------------

// Returns a list of problems (an empty list means the map is valid).
export function validateGeneratedMap(map) {
  const problems = [];
  const W = map.width;
  const H = map.height;
  const tileOf = (e) => pointToTile(e);

  // Villages
  const villageTiles = map.villages.map(tileOf);
  const ids = new Set();
  map.villages.forEach((v, i) => {
    if (ids.has(v.id)) problems.push(`Duplicate village id ${v.id}.`);
    ids.add(v.id);
    if (!inside(villageTiles[i], W, H, 0)) problems.push(`Village ${v.id} is outside the map.`);
  });
  for (let i = 0; i < villageTiles.length; i++) {
    for (let j = i + 1; j < villageTiles.length; j++) {
      if (d2(villageTiles[i], villageTiles[j]) < MG.VILLAGE_MIN_SPACING ** 2) {
        problems.push(`Villages ${map.villages[i].id} and ${map.villages[j].id} are too close.`);
      }
    }
  }

  // Starts
  const starts = map.players.map((p) => p.start);
  if (starts.length > 1 && !startsAreFarEnough(starts)) problems.push("Two players start too close together.");
  starts.forEach((s) => {
    if (!inside(s, W, H, 0)) problems.push("A start point is outside the map.");
  });

  // Armies and ids
  const armyIds = new Set();
  const stackIds = new Set();
  for (const a of map.armies) {
    if (armyIds.has(a.id) || stackIds.has(a.id)) problems.push(`Duplicate id ${a.id}.`);
    armyIds.add(a.id);
    for (const s of a.stacks) {
      if (stackIds.has(s.id) || armyIds.has(s.id)) problems.push(`Duplicate id ${s.id}.`);
      stackIds.add(s.id);
    }
  }
  if (map.world.armies.length !== map.armies.length || !map.world.armies.every((w) => armyIds.has(w.id))) {
    problems.push("The world and the army list do not match.");
  }
  for (const p of map.players) {
    const mine = map.armies.filter((a) => a.ownerId === p.ownerId);
    for (const issue of validateRoster(mine)) problems.push(`${p.ownerId}: ${issue}`);
  }

  // Enemies stay away from the players
  for (const w of map.world.armies) {
    if (w.ownerId !== map.enemyOwnerId) continue;
    const t = tileOf(w);
    if (!starts.every((s) => d2(t, s) >= MG.ENEMY_MIN_DISTANCE_FROM_START ** 2)) problems.push(`Enemy army ${w.id} starts too close to a player.`);
  }

  // Mirroring
  if (map.symmetric) {
    const key = (t) => `${t.x},${t.y}`;
    const owned = (ownerId) => new Set(map.villages.filter((v) => v.ownerId === ownerId).map((v) => key(tileOf(v))));
    const base = map.villages.filter((v) => v.ownerId === map.players[0].ownerId).map(tileOf);
    map.players.forEach((p, i) => {
      const expected = new Set(base.map((t) => key(rotateTile(t, map.rotations[i], W, H))));
      const actual = owned(p.ownerId);
      if (expected.size !== actual.size || [...expected].some((k) => !actual.has(k))) {
        problems.push(`Starting villages of ${p.ownerId} are not a mirror of the first player's.`);
      }
      const rotatedStart = rotateTile(starts[0], map.rotations[i], W, H);
      if (rotatedStart.x !== starts[i].x || rotatedStart.y !== starts[i].y) problems.push(`Start of ${p.ownerId} is not a mirror of the first start.`);
    });
  }
  return problems;
}

// ---------------------------------------------------------------
// Self test (call mapGeneratorSelfTest() from the browser console)
// ---------------------------------------------------------------

import { resolveMovement } from "./overworld.js";

export function mapGeneratorSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`mapGeneratorSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const two = [{ ownerId: "p1" }, { ownerId: "p2" }];
  const key = (t) => `${t.x},${t.y}`;

  // Determinism
  const a = generateWorldBattle({ seed: "abc", players: [{ ownerId: "p1" }] });
  const b = generateWorldBattle({ seed: "abc", players: [{ ownerId: "p1" }] });
  eq(JSON.stringify(a), JSON.stringify(b), "same seed, same map");
  eq(hashMap(a), hashMap(b), "same hash");
  eq(hashMap(a) !== hashMap(generateWorldBattle({ seed: "abd", players: [{ ownerId: "p1" }] })), true, "different seed, different map");
  eq(validateGeneratedMap(a), [], "ai map is valid");

  // World Battle vs AI
  eq(a.mode, "ai", "mode");
  eq(a.villages.length, V.PER_PLAYER_START + V.NEUTRAL_VILLAGES, "village count");
  eq(a.villages.filter((v) => v.ownerId === "p1").length, V.PER_PLAYER_START, "player starting villages");
  eq(a.armies.filter((x) => x.ownerId === MG.ENEMY_OWNER_ID).length, MG.START_ENEMY_ARMIES, "enemy armies");
  eq(a.armies.filter((x) => x.ownerId === "p1").length, CONFIG.START.ARMIES.length, "player army");
  const types = new Set(a.armies.filter((x) => x.ownerId === MG.ENEMY_OWNER_ID).flatMap((x) => x.stacks.map((s) => s.typeId)));
  eq([...types].every((t) => ["swordsman", "spearman"].includes(t)), true, "enemies use the player's unit types");
  eq(a.monsters, [], "no monsters at the start");
  eq(a.economies.p1.gold, CONFIG.ECONOMY.START_GOLD, "player economy");
  eq(a.world.armies.length, a.armies.length, "everyone is in the world");
  eq(a.warnings, [], "no warnings");
  eq(a.nextId > 1, true, "id counter advanced");
  // Player starts facing the center
  const myWorld = a.world.armies.find((x) => x.ownerId === "p1");
  eq(["N", "E", "S", "W"].includes(myWorld.facing), true, "player army has a facing");

  // Fair PvP: 2 players on a ring, mirrored by a half turn
  const pvp = generateWorldBattle({ seed: 7, mode: "pvp", players: two });
  eq(validateGeneratedMap(pvp), [], "ring pvp map is valid");
  eq([pvp.layout, pvp.symmetric, pvp.armies.filter((x) => x.ownerId === MG.ENEMY_OWNER_ID).length], ["ring", true, 0], "ring, mirrored, no enemies in pvp");
  eq(pvp.villages.length, 2 * V.PER_PLAYER_START + V.NEUTRAL_VILLAGES, "pvp village count");
  eq(pvp.balance[0].nearestNeutralVillage, pvp.balance[1].nearestNeutralVillage, "both players have the same nearest neutral village");
  eq(pvp.balance[0].startVillages, pvp.balance[1].startVillages, "same number of starting villages");
  const startDist = isqrt(d2(pvp.players[0].start, pvp.players[1].start));
  eq(startDist >= MG.MIN_START_DISTANCE, true, "starts far apart");
  eq(rotateTile(pvp.players[0].start, 2, 48, 48), pvp.players[1].start, "starts are a half turn apart");
  // Neutral villages mirror too (6 divides evenly by 2)
  const neutralKeys = new Set(pvp.villages.filter((v) => v.ownerId === null).map((v) => key(pointToTile(v))));
  eq([...neutralKeys].every((k) => { const [x, y] = k.split(",").map(Number); return neutralKeys.has(key(rotateTile({ x, y }, 2, 48, 48))); }), true, "neutral villages are mirrored");

  // 4 players on a ring: quarter turns
  const four = generateWorldBattle({ seed: "four", mode: "pvp", players: [{ ownerId: "a" }, { ownerId: "b" }, { ownerId: "c" }, { ownerId: "d" }] });
  eq(validateGeneratedMap(four), [], "4-player ring map is valid");
  eq(four.symmetric, true, "4 players on a square map are mirrored");
  eq(rotateTile(four.players[0].start, 1, 48, 48), four.players[1].start, "quarter turn between neighbors");
  eq(four.villages.length, 4 * V.PER_PLAYER_START + V.NEUTRAL_VILLAGES, "4-player village count");

  // 3 players: ring without mirroring
  const three = generateWorldBattle({ seed: "three", mode: "pvp", players: [{ ownerId: "a" }, { ownerId: "b" }, { ownerId: "c" }] });
  eq(validateGeneratedMap(three), [], "3-player map is valid");
  eq(three.symmetric, false, "3 players cannot be mirrored");

  // Irregular starts
  const irr = generateWorldBattle({ seed: "irr", mode: "pvp", layout: "irregular", players: two });
  eq(validateGeneratedMap(irr), [], "irregular map is valid");
  eq([irr.layout, irr.symmetric], ["irregular", false], "irregular layout");
  eq(irr.balance.every((x) => x.startVillages === V.PER_PLAYER_START), true, "balance info present");

  // Enemy placement modes
  const nearV = generateWorldBattle({ seed: "near", players: [{ ownerId: "p1" }], enemyPlacement: "near_villages" });
  const neutralNear = nearV.villages.filter((v) => v.ownerId === null).map((v) => pointToTile(v));
  const enemyTiles = nearV.world.armies.filter((w) => w.ownerId === MG.ENEMY_OWNER_ID).map((w) => pointToTile(w));
  eq(enemyTiles.every((t) => neutralNear.some((v) => d2(t, v) <= MG.ENEMY_NEAR_VILLAGE_MAX ** 2)), true, "near_villages: every enemy is by a village");
  const rnd = generateWorldBattle({ seed: "rnd", players: [{ ownerId: "p1" }], enemyPlacement: "random" });
  eq(validateGeneratedMap(rnd), [], "random placement is valid");
  eq(generateWorldBattle({ seed: "none", players: [{ ownerId: "p1" }], enemyArmies: 0 }).armies.length, 1, "no enemies when asked");

  // Many seeds: always valid, no failures
  let warned = 0;
  for (let i = 0; i < 60; i++) {
    for (const [mode, layout, players] of [["ai", "ring", [{ ownerId: "p1" }]], ["pvp", "ring", two], ["pvp", "irregular", two], ["pvp", "ring", [{ ownerId: "a" }, { ownerId: "b" }, { ownerId: "c" }, { ownerId: "d" }]]]) {
      const m = generateWorldBattle({ seed: `s${i}`, mode, layout, players });
      const problems = validateGeneratedMap(m);
      if (problems.length) throw new Error(`mapGeneratorSelfTest: seed s${i} ${mode}/${layout}: ${problems.join("; ")}`);
      warned += m.warnings.length;
    }
  }
  eq(warned, 0, "no warnings over 240 maps");

  // Errors
  const fails = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  eq(fails(() => generateWorldBattle({ seed: 1, players: [] })), true, "needs players");
  eq(fails(() => generateWorldBattle({ seed: 1, players: [{ ownerId: "x" }, { ownerId: "x" }] })), true, "duplicate players");
  eq(fails(() => generateWorldBattle({ seed: 1, players: [{ ownerId: MG.ENEMY_OWNER_ID }] })), true, "enemy id is reserved");
  eq(fails(() => generateWorldBattle({ seed: 1, players: two, width: 20, height: 20 })), true, "tiny map fails clearly");

  // The generated world works with the overworld rules
  const res = resolveMovement(a.world, [{ armyId: a.players[0].armyIds[0], target: tileToPoint(24, 24) }]);
  eq(res.rejected, [], "generated world accepts orders");

  return true;
}

export default {
  generateWorldBattle,
  hashMap,
  validateGeneratedMap,
  rotateTile,
  mapGeneratorSelfTest,
};
