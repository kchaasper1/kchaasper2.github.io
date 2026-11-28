// overworldUI.js
// The overworld screen: the map with armies, villages and monsters, a panel
// for the selected army or village, and the buttons that give orders.
// Canvas 2D only, no libraries, no images. Like battleUI.js, it NEVER changes
// the game: it stages the player's orders and, when the player ends the turn,
// hands them to you through onSubmit(orders). You pass them to
// turnResolver.beginTurn(game, { [ownerId]: orders, ... }) and then call
// ui.setGame(newGame).
//
// ---------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------
//   const ui = createOverworldUI({
//     canvas, game, localOwnerId: "p1",
//     ownerNames: { p1: "You", ai: "Raiders" },
//     width: 960, height: 560,                 // CSS pixels
//     getBattleMarkers: () => viewer.getMarkers(),      // battleViewer.js
//     onToggleBattle: (id) => viewer.toggle(id),        // click a battle icon
//     onOpenBattle: (id) => showFullBattleScreen(id),   // "Fight!" button
//     onSubmit: (orders) => { ...send to the game / matchSync... },
//   });
//   ui.setGame(game);          // after every game update (turn, battle...)
//   ui.worldToScreen(point)    // for battleViewer's getAnchor
//   ui.resize(w, h, dpr);      // when the window changes size
//   ui.destroy();
//
// WHAT THE PLAYER DOES
//   - Click one of your armies to COMMAND it (gold ring). Click empty ground
//     to order it to walk there (a straight line, up to its move range, shown
//     as a dashed circle). Pick its facing for the end of the turn in the
//     panel. Dashed lines and ghost tokens show staged moves.
//   - Click anything else (an enemy army, a village, a monster) to INSPECT it
//     in the panel without losing the army you command. With an army
//     commanded, the panel offers "Move here" for what you inspect.
//   - Click one of your villages to hire: pick a unit type and a count. The
//     units appear next turn in a NEW army at the village.
//   - The army panel also has: change a stack's formation, merge two stacks of
//     the same type, detach units into a new army, and join a nearby army of
//     yours.
//   - Orders are only staged. "Undo" removes the last one, "Clear" removes
//     all, "End turn" sends them. After that the screen waits for the others.
//   - Drag the map to pan, wheel or pinch to zoom, the buttons on the map
//     zoom, fit the whole map, or center on the commanded army.
//   - Battle icons (crossed swords) on the map open spectator popups
//     (battleViewer.js). When you are in a battle, the panel offers "Fight!".
//   Keys: arrows pan, + and - zoom, Esc deselects, Enter ends the turn.
//
// WIDE screens put the panel on the right, narrow screens (phones) below.
//
// The pure functions (camera math, staging, the panel rows, hit testing,
// the turn status) are exported so they can be tested without a canvas. See
// overworldUISelfTest().

import { CONFIG } from "./config.js";
import { getUnitType, listHireableTypes } from "./unitTypes.js";
import { distanceSq, isqrt, getMoveDistance, tileToPoint, pointToTile } from "./overworld.js";
import { CAPTURE_RANGE_SUBTILES, DISTURB_RANGE_SUBTILES, villageIncome, getVillageStatus } from "./villages.js";
import { totalSalary, desertionChancePerMille } from "./economy.js";
import { getRosterUsage, getAuthorityPool, armyUnitCount, MAX_STACKS_PER_ARMY } from "./army.js";

const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;
const DIRS = CONFIG.FACING.DIRECTIONS;
const VECTORS = CONFIG.FACING.VECTORS;
const TRANSFER_RANGE = CONFIG.OVERWORLD.TRANSFER_RANGE * S;

const THEME = {
  bg: "#0f1418",
  field: "#16211c",
  fieldAlt: "#192620",
  grid: "rgba(255,255,255,0.045)",
  border: "#2e3946",
  panel: "#181e26",
  text: "#e8edf3",
  muted: "#8b98a8",
  good: "#7bd88f",
  warn: "#ffcc66",
  bad: "#ff7b7b",
  gold: "#ffd166",
  moveRange: "rgba(79,143,247,0.85)",
  capture: "rgba(62,207,142,0.85)",
  disturb: "rgba(239,91,91,0.55)",
  order: "rgba(255,209,102,0.95)",
  button: "#2a3544",
  buttonOn: "#3b82f6",
  buttonOff: "#1f2630",
  buttonText: "#e8edf3",
  buttonTextOff: "#5d6b7c",
};
const OWNER_COLORS = ["#4f8ff7", "#ef5b5b", "#3ecf8e", "#f5b83d"];
const MONSTER_COLOR = "#b57edc";
const NEUTRAL_COLOR = "#7a8794";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const MAX_ZOOM = 80; // pixels per tile
const TAP_SLOP = 6; // pixels a pointer may move and still count as a tap

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function facingToward(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return "N";
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

// ---------------------------------------------------------------
// Layout (pure)
// ---------------------------------------------------------------

const PAD = 12;

// Splits the canvas into the map and the panel. Wide: panel on the right.
// Narrow: panel below.
export function computeLayout(width, height) {
  const wide = width >= 720 && width >= height * 1.05;
  if (wide) {
    const panelW = clamp(Math.round(width * 0.3), 260, 340);
    return { mode: "side", width, height, map: { x: 0, y: 0, w: width - panelW, h: height }, panel: { x: width - panelW, y: 0, w: panelW, h: height } };
  }
  const panelH = clamp(Math.round(height * 0.42), 210, 330);
  return { mode: "bottom", width, height, map: { x: 0, y: 0, w: width, h: height - panelH }, panel: { x: 0, y: height - panelH, w: width, h: panelH } };
}

function inRect(r, px, py) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// The little buttons in the corner of the map.
export function mapButtons(layout) {
  const size = 34;
  const gap = 6;
  const x = layout.map.x + layout.map.w - size - 8;
  const ids = [
    ["zoom_in", "+"],
    ["zoom_out", "−"],
    ["fit", "⌂"],
    ["center", "◎"],
  ];
  return ids.map(([id, label], i) => ({ id, label, rect: { x, y: layout.map.y + 8 + i * (size + gap), w: size, h: size } }));
}

// ---------------------------------------------------------------
// Camera (pure). zoom = pixels per tile; cx, cy = the world point (in
// sub-tiles) at the middle of the map area.
// ---------------------------------------------------------------

export function fitZoom(world, rect) {
  return Math.min(rect.w / world.widthTiles, rect.h / world.heightTiles);
}

function scaleOf(cam) {
  return cam.zoom / S; // pixels per sub-tile
}

export function clampCamera(cam, world, rect) {
  const k = scaleOf(cam);
  const mapW = world.widthTiles * S;
  const mapH = world.heightTiles * S;
  const halfW = rect.w / 2 / k;
  const halfH = rect.h / 2 / k;
  return {
    zoom: cam.zoom,
    cx: halfW * 2 >= mapW ? mapW / 2 : clamp(cam.cx, halfW, mapW - halfW),
    cy: halfH * 2 >= mapH ? mapH / 2 : clamp(cam.cy, halfH, mapH - halfH),
  };
}

// A camera showing about `tilesAcross` tiles around a point.
export function createCamera(world, rect, focus, tilesAcross = 22) {
  const fit = fitZoom(world, rect);
  const zoom = clamp(Math.min(rect.w, rect.h) / tilesAcross, fit, MAX_ZOOM);
  const p = focus || { x: (world.widthTiles * S) / 2, y: (world.heightTiles * S) / 2 };
  return clampCamera({ zoom, cx: p.x, cy: p.y }, world, rect);
}

export function worldToScreen(cam, rect, p) {
  const k = scaleOf(cam);
  return { x: rect.x + rect.w / 2 + (p.x - cam.cx) * k, y: rect.y + rect.h / 2 + (p.y - cam.cy) * k };
}

// Screen point to a world point in integer sub-tiles.
export function screenToWorld(cam, rect, px, py) {
  const k = scaleOf(cam);
  return { x: Math.round(cam.cx + (px - rect.x - rect.w / 2) / k), y: Math.round(cam.cy + (py - rect.y - rect.h / 2) / k) };
}

export function panCamera(cam, world, rect, dxPx, dyPx) {
  const k = scaleOf(cam);
  return clampCamera({ ...cam, cx: cam.cx - dxPx / k, cy: cam.cy - dyPx / k }, world, rect);
}

// Zooms by `factor` keeping the point under (fx, fy) where it is.
export function zoomCamera(cam, world, rect, factor, fx, fy) {
  const k = scaleOf(cam);
  const ox = fx - rect.x - rect.w / 2;
  const oy = fy - rect.y - rect.h / 2;
  const wx = cam.cx + ox / k;
  const wy = cam.cy + oy / k;
  const zoom = clamp(cam.zoom * factor, fitZoom(world, rect), MAX_ZOOM);
  const k2 = zoom / S;
  return clampCamera({ zoom, cx: wx - ox / k2, cy: wy - oy / k2 }, world, rect);
}

// ---------------------------------------------------------------
// Colors and names
// ---------------------------------------------------------------

export function ownerColors(game, localOwnerId) {
  const owners = [...new Set(game.players.map((p) => p.ownerId).concat(game.enemyOwnerId ? [game.enemyOwnerId] : []))];
  const ordered = owners.filter((o) => o === localOwnerId).concat(owners.filter((o) => o !== localOwnerId).sort());
  const out = {};
  ordered.forEach((o, i) => (out[o] = OWNER_COLORS[i % OWNER_COLORS.length]));
  return out;
}

function nameOf(names, ownerId) {
  if (ownerId === null || ownerId === undefined) return "Nobody";
  return (names && names[ownerId]) || String(ownerId);
}

// ---------------------------------------------------------------
// UI state and staging orders (pure)
// ---------------------------------------------------------------
// ui = {
//   camera, actorId, selected: {kind, id} | null,
//   staged: [order, ...],        // orders for turnResolver (moves included)
//   hire: { typeId, count },     // the hire panel
//   dialog: null | { kind: "detach", stackId, count },
//   panelScroll, submitted, turn, message
// }

export function createUIState({ game, localOwnerId, layout }) {
  const mine = game.world.armies.find((a) => a.ownerId === localOwnerId);
  const army = mine ? game.armies.find((a) => a.id === mine.id) : null;
  return {
    camera: createCamera(game.world, layout.map, mine ? { x: mine.x, y: mine.y } : null),
    actorId: army ? army.id : null,
    selected: army ? { kind: "army", id: army.id } : null,
    staged: [],
    hire: { typeId: null, count: 1 },
    dialog: null,
    panelScroll: 0,
    submitted: false,
    turn: game.turn,
    message: null,
  };
}

function patch(ui, p) {
  return { ...ui, ...p };
}

const ok = (ui, extra = {}) => ({ ok: true, ui, ...extra });
const no = (ui, reason) => ({ ok: false, ui: patch(ui, { message: { text: reason, tone: "warn" } }), reason });

function ownArmy(game, localOwnerId, id) {
  const a = game.armies.find((x) => x.id === id);
  return a && a.ownerId === localOwnerId ? a : null;
}

function worldArmy(game, id) {
  return game.world.armies.find((a) => a.id === id) || null;
}

function armyLabel(game, id) {
  const a = game.armies.find((x) => x.id === id);
  return a ? a.name : id;
}

// The turn after a game update: staged orders and the "submitted" flag only
// last for one turn.
export function syncUIWithGame(ui, game, localOwnerId, layout) {
  let next = ui;
  if (game.turn !== ui.turn) {
    next = patch(next, { staged: [], submitted: false, turn: game.turn, dialog: null, message: null });
  }
  // The commanded army may be gone (destroyed, joined another).
  if (next.actorId && !game.armies.some((a) => a.id === next.actorId)) next = patch(next, { actorId: null });
  if (next.selected) {
    const gone =
      (next.selected.kind === "army" && !game.armies.some((a) => a.id === next.selected.id)) ||
      (next.selected.kind === "monster" && !game.monsters.some((m) => m.id === next.selected.id)) ||
      (next.selected.kind === "village" && !game.villages.some((v) => v.id === next.selected.id));
    if (gone) next = patch(next, { selected: null });
  }
  next = patch(next, { staged: next.staged.filter((o) => orderStillMakesSense(game, o)) });
  return patch(next, { camera: clampCamera(next.camera, game.world, layout.map) });
}

function orderStillMakesSense(game, o) {
  if (o.armyId && !game.armies.some((a) => a.id === o.armyId)) return false;
  if (o.fromArmyId && !game.armies.some((a) => a.id === o.fromArmyId)) return false;
  return true;
}

// ----- moves -----

export function stageMove(ui, game, localOwnerId, armyId, target, facing) {
  const army = ownArmy(game, localOwnerId, armyId);
  if (!army) return no(ui, "That is not your army.");
  const w = worldArmy(game, armyId);
  const maxX = game.world.widthTiles * S - 1;
  const maxY = game.world.heightTiles * S - 1;
  const t = { x: clamp(Math.round(target.x), 0, maxX), y: clamp(Math.round(target.y), 0, maxY) };
  const existing = ui.staged.find((o) => o.type === "move" && o.armyId === armyId);
  const face = facing || facingToward(w, t) || (existing && existing.facing) || w.facing;
  const order = { type: "move", armyId, target: t, facing: face };
  return ok(patch(ui, { staged: ui.staged.filter((o) => !(o.type === "move" && o.armyId === armyId)).concat([order]), message: null }));
}

export function cancelMove(ui, armyId) {
  return patch(ui, { staged: ui.staged.filter((o) => !(o.type === "move" && o.armyId === armyId)) });
}

// Sets the facing the army ends the turn with (with or without a move).
export function setMoveFacing(ui, game, localOwnerId, armyId, facing) {
  if (!ownArmy(game, localOwnerId, armyId)) return no(ui, "That is not your army.");
  if (!DIRS.includes(facing)) return no(ui, "Bad facing.");
  const existing = ui.staged.find((o) => o.type === "move" && o.armyId === armyId);
  const order = existing ? { ...existing, facing } : { type: "move", armyId, facing };
  return ok(patch(ui, { staged: ui.staged.filter((o) => !(o.type === "move" && o.armyId === armyId)).concat([order]) }));
}

export function getStagedMove(ui, armyId) {
  return ui.staged.find((o) => o.type === "move" && o.armyId === armyId) || null;
}

// ----- hiring -----

function stagedHireTotals(ui) {
  const out = { gold: 0, units: 0, authority: 0, salary: 0, byType: {} };
  for (const o of ui.staged) {
    if (o.type !== "hire") continue;
    const t = getUnitType(o.typeId);
    out.gold += t.hireCost * o.count;
    out.units += o.count;
    out.authority += t.authorityCost * o.count;
    out.salary += t.salary * o.count;
    out.byType[o.typeId] = (out.byType[o.typeId] || 0) + o.count;
  }
  return out;
}

// The unit types a village offers this player.
export function hireOptions(game, localOwnerId, village) {
  const types = listHireableTypes(game.unlocked[localOwnerId] || []);
  return types.filter((t) => village.hireTypes === null || village.hireTypes.includes(t.id));
}

// How many more units of a type could be hired, counting orders already
// staged: limited by gold, the unit-type cap and the authority pool.
export function maxHireCount(ui, game, localOwnerId, typeId) {
  const economy = game.economies[localOwnerId];
  if (!economy) return 0;
  const t = getUnitType(typeId);
  const mine = game.armies.filter((a) => a.ownerId === localOwnerId);
  const usage = getRosterUsage(mine);
  const staged = stagedHireTotals(ui);
  const byGold = t.hireCost === 0 ? Infinity : Math.floor((economy.gold - staged.gold) / t.hireCost);
  const byCap = CONFIG.AUTHORITY.PER_TYPE_CAP_ENABLED ? t.authorityCap - (usage.byType[typeId] || 0) - (staged.byType[typeId] || 0) : Infinity;
  const byPool = Math.floor((getAuthorityPool() - usage.authority - staged.authority) / t.authorityCost);
  return Math.max(0, Math.min(byGold, byCap, byPool));
}

export function stageHire(ui, game, localOwnerId, villageId, typeId, count) {
  const village = game.villages.find((v) => v.id === villageId);
  if (!village || village.ownerId !== localOwnerId) return no(ui, "You do not hold that village.");
  if (!village.canHire) return no(ui, "Nobody can be hired here.");
  if (!hireOptions(game, localOwnerId, village).some((t) => t.id === typeId)) return no(ui, "This village does not offer that unit.");
  if (!Number.isInteger(count) || count < 1) return no(ui, "Pick at least 1 unit.");
  const max = maxHireCount(ui, game, localOwnerId, typeId);
  if (count > max) return no(ui, max === 0 ? "You cannot hire any more of those." : `You can hire at most ${max} more.`);
  const existing = ui.staged.find((o) => o.type === "hire" && o.villageId === villageId && o.typeId === typeId);
  const staged = existing
    ? ui.staged.map((o) => (o === existing ? { ...o, count: o.count + count } : o))
    : ui.staged.concat([{ type: "hire", villageId, typeId, count }]);
  return ok(patch(ui, { staged, message: null, hire: { ...ui.hire, count: 1 } }));
}

// ----- stack and army orders -----

export function stageSwitch(ui, game, localOwnerId, armyId, stackId, formation) {
  const army = ownArmy(game, localOwnerId, armyId);
  const stack = army && army.stacks.find((s) => s.id === stackId);
  if (!stack) return no(ui, "That stack does not exist.");
  const existing = ui.staged.find((o) => o.type === "switch" && o.stackId === stackId);
  // Choosing the current formation again cancels the staged switch.
  const rest = ui.staged.filter((o) => o !== existing);
  if (formation === stack.formationType) return ok(patch(ui, { staged: rest }));
  return ok(patch(ui, { staged: rest.concat([{ type: "switch", armyId, stackId, formation }]) }));
}

// The other stack of the same type a stack could merge with, or null.
export function mergePartner(army, stackId) {
  const s = army.stacks.find((x) => x.id === stackId);
  if (!s) return null;
  return army.stacks.find((o) => o.id !== stackId && o.typeId === s.typeId && !(o.carry > 0 && s.carry > 0)) || null;
}

export function stageMerge(ui, game, localOwnerId, armyId, stackIdA, stackIdB) {
  const army = ownArmy(game, localOwnerId, armyId);
  if (!army) return no(ui, "That is not your army.");
  const a = army.stacks.find((s) => s.id === stackIdA);
  const b = army.stacks.find((s) => s.id === stackIdB);
  if (!a || !b || a.typeId !== b.typeId) return no(ui, "Only stacks of the same unit type can merge.");
  if (a.carry > 0 && b.carry > 0) return no(ui, "Two wounded stacks cannot merge.");
  if (ui.staged.some((o) => o.type === "merge_stacks" && (o.stackIdA === stackIdA || o.stackIdB === stackIdA || o.stackIdA === stackIdB || o.stackIdB === stackIdB))) {
    return no(ui, "A merge is already staged for those stacks.");
  }
  return ok(patch(ui, { staged: ui.staged.concat([{ type: "merge_stacks", armyId, stackIdA, stackIdB }]) }));
}

// Detach units into a new army.
export function stageDetach(ui, game, localOwnerId, armyId, stackId, count) {
  const army = ownArmy(game, localOwnerId, armyId);
  const stack = army && army.stacks.find((s) => s.id === stackId);
  if (!stack) return no(ui, "That stack does not exist.");
  const max = stack.count - (army.stacks.length === 1 ? 1 : 0);
  if (!Number.isInteger(count) || count < 1 || count > max) return no(ui, `Detach between 1 and ${max} units.`);
  return ok(patch(ui, { staged: ui.staged.concat([{ type: "transfer", fromArmyId: armyId, toArmyId: null, stackId, count }]), dialog: null }));
}

// Armies of mine within transfer range of an army, nearest first.
export function nearbyOwnArmies(game, localOwnerId, armyId) {
  const me = worldArmy(game, armyId);
  if (!me) return [];
  return game.armies
    .filter((a) => a.ownerId === localOwnerId && a.id !== armyId)
    .map((a) => ({ army: a, d2: distanceSq(me, worldArmy(game, a.id)) }))
    .filter((x) => x.d2 <= TRANSFER_RANGE * TRANSFER_RANGE)
    .sort((a, b) => a.d2 - b.d2 || cmp(a.army.id, b.army.id))
    .map((x) => x.army);
}

// Join another army of mine: hand over every stack, which disbands this one.
export function stageJoin(ui, game, localOwnerId, armyId, toArmyId) {
  const from = ownArmy(game, localOwnerId, armyId);
  const to = nearbyOwnArmies(game, localOwnerId, armyId).find((a) => a.id === toArmyId);
  if (!from || !to) return no(ui, "That army is not close enough.");
  if (from.stacks.length + to.stacks.length > MAX_STACKS_PER_ARMY) return no(ui, "The other army has no room for all your stacks.");
  const orders = from.stacks.map((s) => ({ type: "transfer", fromArmyId: armyId, toArmyId, stackId: s.id, count: s.count }));
  const kept = ui.staged.filter((o) => !(o.type === "move" && o.armyId === armyId));
  return ok(patch(ui, { staged: kept.concat(orders), actorId: null }));
}

// ----- the whole list -----

export function undoLast(ui) {
  return patch(ui, { staged: ui.staged.slice(0, -1) });
}

export function clearOrders(ui) {
  return patch(ui, { staged: [], dialog: null });
}

// The orders to send to turnResolver.beginTurn for this player: everything
// that changes armies first, in the order it was staged, then the moves.
export function buildOrders(ui) {
  return ui.staged.filter((o) => o.type !== "move").concat(ui.staged.filter((o) => o.type === "move"));
}

export function describeOrder(game, o, names = {}) {
  const tile = (p) => {
    const t = pointToTile(p);
    return `${t.x},${t.y}`;
  };
  switch (o.type) {
    case "move":
      return o.target ? `${armyLabel(game, o.armyId)} → ${tile(o.target)} (face ${o.facing})` : `${armyLabel(game, o.armyId)} faces ${o.facing}`;
    case "hire": {
      const v = game.villages.find((x) => x.id === o.villageId);
      return `Hire ${o.count} ${getUnitType(o.typeId).name} at ${v ? v.name : o.villageId}`;
    }
    case "switch":
      return `${armyLabel(game, o.armyId)}: stack → ${o.formation}`;
    case "merge_stacks":
      return `${armyLabel(game, o.armyId)}: merge two stacks`;
    case "transfer":
      return o.toArmyId ? `${armyLabel(game, o.fromArmyId)} → joins ${armyLabel(game, o.toArmyId)}` : `${armyLabel(game, o.fromArmyId)}: detach ${o.count}`;
    default:
      return o.type;
  }
}

// ---------------------------------------------------------------
// Turn status and the economy line (pure)
// ---------------------------------------------------------------

// Where the game is, for this player:
//   { phase: "planning" | "submitted" | "resolving" | "over" | "eliminated",
//     text, canPlan, myBattles: [battleId], battleCount }
export function getTurnStatus(game, ui, localOwnerId, names = {}) {
  const pending = Object.values(game.battles || {}).filter((b) => !b.done);
  const mine = pending.filter((b) => b.meta.attackerOwnerId === localOwnerId || b.meta.defenderOwnerId === localOwnerId).map((b) => b.id).sort();
  if (game.over) {
    const text = game.winnerOwnerId === null ? "Game over: a draw" : game.winnerOwnerId === localOwnerId ? "Victory!" : `Game over: ${nameOf(names, game.winnerOwnerId)} won`;
    return { phase: "over", text, canPlan: false, myBattles: [], battleCount: 0 };
  }
  if (game.resolution) {
    return {
      phase: "resolving",
      text: pending.length > 0 ? `Battles in progress (${pending.length})` : "Resolving the turn…",
      canPlan: false,
      myBattles: mine,
      battleCount: pending.length,
    };
  }
  if (game.eliminated.includes(localOwnerId)) {
    return { phase: "eliminated", text: "You were eliminated. You can watch.", canPlan: false, myBattles: [], battleCount: 0 };
  }
  if (ui.submitted) return { phase: "submitted", text: "Orders sent. Waiting for the others…", canPlan: false, myBattles: [], battleCount: 0 };
  return { phase: "planning", text: `Plan turn ${game.turn}`, canPlan: true, myBattles: [], battleCount: 0 };
}

// Gold now, what the staged orders cost, expected village income, salaries,
// and whether the salaries will be covered.
export function summarizeEconomy(game, ui, localOwnerId) {
  const economy = game.economies[localOwnerId];
  if (!economy) return null;
  const mine = game.armies.filter((a) => a.ownerId === localOwnerId);
  const staged = stagedHireTotals(ui);
  const income = game.villages
    .filter((v) => v.ownerId === localOwnerId)
    .reduce((n, v) => n + getVillageStatus(game.world, v).nextCollection, 0);
  const salary = totalSalary(mine) + staged.salary;
  const goldAfter = economy.gold - staged.gold + income;
  const shortfall = Math.max(0, salary - goldAfter);
  return {
    gold: economy.gold,
    debt: economy.debt,
    stagedCost: staged.gold,
    income,
    salary,
    projectedGold: Math.max(0, goldAfter - salary),
    shortfall,
    desertionPerMille: desertionChancePerMille(economy.debt + shortfall, salary),
  };
}

// ---------------------------------------------------------------
// The panel (pure): rows of text and buttons
// ---------------------------------------------------------------
// Row kinds: title, text, buttons, stack, stepper, divider, spacer.

const ROW_H = { title: 26, text: 18, buttons: 32, stack: 56, stepper: 32, divider: 10, spacer: 8 };
const ROW_GAP = 2;

function text(textValue, tone) {
  return { kind: "text", text: textValue, tone };
}
function title(textValue) {
  return { kind: "title", text: textValue };
}
function buttons(items) {
  return { kind: "buttons", items };
}

function describeArmyLines(game, army, names) {
  const w = worldArmy(game, army.id);
  const t = w ? pointToTile(w) : { x: 0, y: 0 };
  return [
    `${nameOf(names, army.ownerId)} · ${armyUnitCount(army)} units in ${army.stacks.length} stack${army.stacks.length === 1 ? "" : "s"}`,
    `At ${t.x},${t.y} · facing ${army.facing}`,
  ];
}

function stackSub(s) {
  return `${s.formationType === "line" ? "Line" : "Square"}${s.carry > 0 ? " · wounded" : ""}`;
}

// Everything the panel shows: a fixed header and a scrolling body.
export function buildPanelRows(game, ui, localOwnerId, names = {}) {
  const status = getTurnStatus(game, ui, localOwnerId, names);
  const header = [];
  const body = [];

  // --- Header: status, economy, End turn ---
  header.push({ kind: "title", text: status.text, tone: status.canPlan ? "gold" : status.phase === "over" ? "good" : "muted" });
  const eco = summarizeEconomy(game, ui, localOwnerId);
  if (eco) {
    const parts = [`Gold ${eco.gold}`];
    if (eco.stagedCost > 0) parts.push(`−${eco.stagedCost} staged`);
    parts.push(`+${eco.income} income`, `−${eco.salary} salaries`);
    header.push(text(parts.join(" · "), eco.shortfall > 0 ? "warn" : "muted"));
    if (eco.shortfall > 0) header.push(text(`Short by ${eco.shortfall}: debt grows and troops may desert`, "warn"));
    else if (eco.debt > 0) header.push(text(`Debt ${eco.debt} · desertion risk ${Math.round(eco.desertionPerMille / 10)}%`, "warn"));
  }
  if (status.phase === "resolving" && status.myBattles.length > 0) {
    header.push(buttons(status.myBattles.slice(0, 2).map((id) => ({ id: `battle:${id}`, label: `Fight! (${id})`, enabled: true, selected: true }))));
  } else {
    header.push(
      buttons([
        { id: "submit", label: "End turn", enabled: status.canPlan, selected: status.canPlan },
        { id: "undo", label: "Undo", enabled: status.canPlan && ui.staged.length > 0 },
        { id: "clear", label: "Clear", enabled: status.canPlan && ui.staged.length > 0 },
      ])
    );
  }
  if (ui.message) header.push(text(ui.message.text, ui.message.tone || "warn"));

  // --- Body ---
  const canPlan = status.canPlan;
  const actor = ui.actorId ? game.armies.find((a) => a.id === ui.actorId) : null;
  const sel = ui.selected;

  if (!sel && !actor) {
    body.push(title("Nothing selected"));
    body.push(text("Click one of your armies to command it,"));
    body.push(text("then click the map to send it there."));
    body.push(text("Click a village of yours to hire troops."));
  }

  // The commanded army.
  if (actor && (!sel || (sel.kind === "army" && sel.id === actor.id))) {
    appendActorRows(body, game, ui, localOwnerId, actor, canPlan, names);
  }

  // Something else being inspected.
  if (sel && !(sel.kind === "army" && actor && sel.id === actor.id)) {
    if (actor) body.push(text(`Commanding: ${actor.name}`, "muted"));
    appendInspectRows(body, game, ui, localOwnerId, sel, actor, canPlan, names);
  }

  // Staged orders.
  if (ui.staged.length > 0) {
    body.push({ kind: "divider" });
    body.push(title(`Staged orders (${ui.staged.length})`));
    for (const o of ui.staged) body.push(text(`• ${describeOrder(game, o, names)}`, "muted"));
  }
  return { header, body, status };
}

function appendActorRows(body, game, ui, localOwnerId, actor, canPlan, names) {
  body.push(title(actor.name));
  for (const line of describeArmyLines(game, actor, names)) body.push(text(line, "muted"));
  const move = getStagedMove(ui, actor.id);
  if (move && move.target) {
    const t = pointToTile(move.target);
    body.push(text(`Ordered to ${t.x},${t.y}`, "gold"));
  } else body.push(text("No move ordered. Click the map.", "muted"));

  const chosen = move ? move.facing : actor.facing;
  body.push(text("Face at the end of the turn:", "muted"));
  body.push(buttons(DIRS.map((d) => ({ id: `face:${d}`, label: d, enabled: canPlan, selected: d === chosen }))));
  body.push(
    buttons([
      { id: "cancel_move", label: "Cancel move", enabled: canPlan && !!move },
      { id: "center", label: "Center", enabled: true },
      { id: "deselect", label: "Deselect", enabled: true },
    ])
  );

  const near = nearbyOwnArmies(game, localOwnerId, actor.id).slice(0, 2);
  if (near.length > 0) {
    body.push(
      buttons(
        near.map((a) => ({
          id: `join:${a.id}`,
          label: `Join ${a.name}`,
          enabled: canPlan && actor.stacks.length + a.stacks.length <= MAX_STACKS_PER_ARMY,
        }))
      )
    );
  }

  body.push({ kind: "divider" });
  body.push(title("Stacks"));
  for (const s of actor.stacks) {
    const type = getUnitType(s.typeId);
    const stagedSwitch = ui.staged.find((o) => o.type === "switch" && o.stackId === s.id);
    const target = stagedSwitch ? stagedSwitch.formation : s.formationType === "square" ? "line" : "square";
    const partner = mergePartner(actor, s.id);
    const items = [{ id: `switch:${s.id}:${target}`, label: stagedSwitch ? `→ ${stagedSwitch.formation} ✓` : `→ ${target}`, enabled: canPlan, selected: !!stagedSwitch }];
    if (partner) items.push({ id: `merge:${s.id}:${partner.id}`, label: "Merge", enabled: canPlan });
    items.push({ id: `detach:${s.id}`, label: "Detach", enabled: canPlan && s.count - (actor.stacks.length === 1 ? 1 : 0) >= 1 });
    body.push({ kind: "stack", label: `${type.name} ×${s.count}`, sub: stackSub(s), items });
  }

  if (ui.dialog && ui.dialog.kind === "detach") {
    const stack = actor.stacks.find((s) => s.id === ui.dialog.stackId);
    if (stack) {
      const max = stack.count - (actor.stacks.length === 1 ? 1 : 0);
      body.push(text(`Detach units from ${getUnitType(stack.typeId).name} into a new army:`, "gold"));
      body.push({ kind: "stepper", id: "detach", label: "Units", value: ui.dialog.count, min: 1, max });
      body.push(
        buttons([
          { id: "detach_ok", label: "Detach", enabled: canPlan, selected: true },
          { id: "detach_cancel", label: "Cancel", enabled: true },
        ])
      );
    }
  }
}

function appendInspectRows(body, game, ui, localOwnerId, sel, actor, canPlan, names) {
  if (sel.kind === "army") {
    const a = game.armies.find((x) => x.id === sel.id);
    if (!a) return;
    body.push(title(a.name));
    for (const line of describeArmyLines(game, a, names)) body.push(text(line, "muted"));
    for (const s of a.stacks) body.push(text(`${getUnitType(s.typeId).name} ×${s.count} · ${stackSub(s)}`));
    if (actor && a.ownerId !== localOwnerId) body.push(buttons([{ id: "move_here", label: `Attack with ${actor.name}`, enabled: canPlan }]));
    body.push(buttons([{ id: "deselect", label: "Close", enabled: true }]));
  } else if (sel.kind === "monster") {
    const m = game.monsters.find((x) => x.id === sel.id);
    if (!m) return;
    body.push(title(getUnitType(m.typeId).name));
    body.push(text(`${m.count} units${m.carry > 0 ? " · wounded" : ""}`, "muted"));
    body.push(text("Monsters raid villages and attack armies.", "muted"));
    if (actor) body.push(buttons([{ id: "move_here", label: `Attack with ${actor.name}`, enabled: canPlan }]));
    body.push(buttons([{ id: "deselect", label: "Close", enabled: true }]));
  } else if (sel.kind === "village") {
    const v = game.villages.find((x) => x.id === sel.id);
    if (!v) return;
    const st = getVillageStatus(game.world, v);
    body.push(title(v.name));
    body.push(text(v.ownerId === null ? "Nobody holds this village." : `Held by ${nameOf(names, v.ownerId)}`, "muted"));
    body.push(text(`Pays ${villageIncome(v)} gold per turn`, "muted"));
    if (v.ownerId !== null) {
      body.push(
        text(
          st.frozen ? `Income frozen: ${v.stored} saved up (threat nearby)` : v.stored > 0 ? `${v.stored} saved up` : "Income flows normally",
          st.frozen ? "warn" : "muted"
        )
      );
    }
    if (actor) body.push(buttons([{ id: "move_here", label: `Go there with ${actor.name}`, enabled: canPlan }]));
    if (v.ownerId === localOwnerId && v.canHire) appendHireRows(body, game, ui, localOwnerId, v, canPlan);
    body.push(buttons([{ id: "deselect", label: "Close", enabled: true }]));
  }
}

function appendHireRows(body, game, ui, localOwnerId, village, canPlan) {
  const options = hireOptions(game, localOwnerId, village);
  if (options.length === 0) return;
  body.push({ kind: "divider" });
  body.push(title("Hire troops"));
  const typeId = options.some((t) => t.id === ui.hire.typeId) ? ui.hire.typeId : options[0].id;
  body.push(
    buttons(
      options.slice(0, 3).map((t) => ({ id: `hire_type:${t.id}`, label: `${t.name} ${t.hireCost}g`, enabled: true, selected: t.id === typeId }))
    )
  );
  const type = getUnitType(typeId);
  const max = maxHireCount(ui, game, localOwnerId, typeId);
  const count = clamp(ui.hire.count, 1, Math.max(1, max));
  body.push({ kind: "stepper", id: "hire", label: "Count", value: count, min: 1, max: Math.max(1, max) });
  body.push(text(`Cost ${type.hireCost * count} · salary ${type.salary * count}/turn · up to ${max} more`, max === 0 ? "warn" : "muted"));
  body.push(buttons([{ id: "hire_ok", label: `Hire ${count}`, enabled: canPlan && max >= 1 && count <= max, selected: true }]));
  body.push(text("They arrive next turn in a new army here.", "muted"));
}

// ---------------------------------------------------------------
// Panel layout (pure): rectangles for rows and their buttons
// ---------------------------------------------------------------

// Places rows from the top of `rect`, shifted up by `scroll`.
// Returns { placed: [{ row, rect, items: [{ id, label, enabled, selected, rect }] }], contentHeight }.
export function layoutRows(rows, rect, scroll = 0) {
  const placed = [];
  let y = rect.y - scroll;
  const gap = 6;
  for (const row of rows) {
    const h = ROW_H[row.kind] || 18;
    const r = { x: rect.x, y, w: rect.w, h };
    let items = [];
    if (row.kind === "buttons") {
      const n = row.items.length;
      const bw = Math.floor((rect.w - gap * (n - 1)) / n);
      items = row.items.map((it, i) => ({ ...it, rect: { x: rect.x + i * (bw + gap), y, w: bw, h: h - 2 } }));
    } else if (row.kind === "stack") {
      const n = row.items.length;
      const bw = Math.floor((rect.w - gap * (n - 1)) / n);
      items = row.items.map((it, i) => ({ ...it, rect: { x: rect.x + i * (bw + gap), y: y + 28, w: bw, h: 24 } }));
    } else if (row.kind === "stepper") {
      const bw = 36;
      items = [
        { id: `${row.id}_dec`, label: "−", enabled: row.value > row.min, rect: { x: rect.x + rect.w - 2 * bw - 70, y, w: bw, h: h - 2 } },
        { id: `${row.id}_inc`, label: "+", enabled: row.value < row.max, rect: { x: rect.x + rect.w - bw, y, w: bw, h: h - 2 } },
      ];
    }
    placed.push({ row, rect: r, items });
    y += h + ROW_GAP;
  }
  return { placed, contentHeight: y - (rect.y - scroll) };
}

// The panel split into its fixed header and scrolling body.
export function layoutPanel(layout, panelModel, scroll = 0) {
  const p = layout.panel;
  const inner = { x: p.x + PAD, y: p.y + PAD, w: p.w - 2 * PAD };
  const head = layoutRows(panelModel.header, { x: inner.x, y: inner.y, w: inner.w }, 0);
  const bodyTop = inner.y + head.contentHeight + 6;
  const bodyRect = { x: inner.x, y: bodyTop, w: inner.w, h: Math.max(0, p.y + p.h - PAD - bodyTop) };
  const maxScroll = Math.max(0, layoutRows(panelModel.body, bodyRect, 0).contentHeight - bodyRect.h);
  const s = clamp(scroll, 0, maxScroll);
  const body = layoutRows(panelModel.body, bodyRect, s);
  return { header: head, body, bodyRect, maxScroll, scroll: s };
}

// ---------------------------------------------------------------
// View model and hit testing (pure)
// ---------------------------------------------------------------

function tokenRadius(cam) {
  return clamp(cam.zoom * 0.42, 9, 26);
}

function villageHalf(cam) {
  return clamp(cam.zoom * 0.38, 8, 22);
}

// Everything to draw on the map, in screen coordinates.
export function buildViewModel({ game, ui, layout, localOwnerId, names = {}, battleMarkers = [], hover = null }) {
  const cam = ui.camera;
  const rect = layout.map;
  const colors = ownerColors(game, localOwnerId);
  const toScreen = (p) => worldToScreen(cam, rect, p);
  const status = getTurnStatus(game, ui, localOwnerId, names);

  const armies = game.armies.map((a) => {
    const w = worldArmy(game, a.id);
    const s = toScreen(w);
    const move = a.ownerId === localOwnerId ? getStagedMove(ui, a.id) : null;
    return {
      id: a.id,
      ownerId: a.ownerId,
      name: a.name,
      x: s.x,
      y: s.y,
      world: { x: w.x, y: w.y },
      color: colors[a.ownerId] || NEUTRAL_COLOR,
      units: armyUnitCount(a),
      facing: a.facing,
      isMine: a.ownerId === localOwnerId,
      isActor: ui.actorId === a.id,
      isSelected: !!ui.selected && ui.selected.kind === "army" && ui.selected.id === a.id,
      wounded: a.stacks.some((s2) => s2.carry > 0),
      hasOrder: !!move,
    };
  });

  const monsters = game.monsters.map((m) => {
    const s = toScreen(m);
    return { id: m.id, x: s.x, y: s.y, world: { x: m.x, y: m.y }, units: m.count, facing: m.facing, isSelected: !!ui.selected && ui.selected.kind === "monster" && ui.selected.id === m.id };
  });

  const villages = game.villages.map((v) => {
    const s = toScreen(v);
    const st = v.ownerId === null ? null : getVillageStatus(game.world, v);
    return {
      id: v.id,
      name: v.name,
      x: s.x,
      y: s.y,
      world: { x: v.x, y: v.y },
      ownerId: v.ownerId,
      color: v.ownerId === null ? NEUTRAL_COLOR : colors[v.ownerId] || NEUTRAL_COLOR,
      stored: v.stored,
      frozen: !!st && st.frozen,
      isMine: v.ownerId === localOwnerId,
      isSelected: !!ui.selected && ui.selected.kind === "village" && ui.selected.id === v.id,
    };
  });

  // Staged moves of the local player.
  const orders = [];
  for (const o of ui.staged) {
    if (o.type !== "move" || !o.target) continue;
    const w = worldArmy(game, o.armyId);
    if (!w) continue;
    const dist = isqrt(distanceSq(w, o.target));
    const reach = getMoveDistance(w);
    orders.push({
      armyId: o.armyId,
      from: toScreen(w),
      to: toScreen(o.target),
      // Where the army actually ends the turn (it walks up to its move range).
      reach: dist <= reach ? toScreen(o.target) : toScreen({ x: w.x + Math.trunc(((o.target.x - w.x) * reach) / dist), y: w.y + Math.trunc(((o.target.y - w.y) * reach) / dist) }),
      facing: o.facing,
      fullTrip: dist <= reach,
    });
  }

  const markers = battleMarkers
    .filter((m) => m.worldPosition)
    .map((m) => {
      const s = toScreen(m.worldPosition);
      return { battleId: m.battleId, x: s.x, y: s.y, over: m.over, windowState: m.windowState, unread: m.unread, title: m.title };
    });

  const actor = ui.actorId ? worldArmy(game, ui.actorId) : null;
  const panelModel = buildPanelRows(game, ui, localOwnerId, names);
  const panel = layoutPanel(layout, panelModel, ui.panelScroll);

  return {
    layout,
    camera: cam,
    colors,
    status,
    armies,
    monsters,
    villages,
    orders,
    markers,
    mapButtons: mapButtons(layout),
    moveRange: actor ? { center: toScreen(actor), radius: getMoveDistance(actor) * scaleOf(cam) } : null,
    selectedVillage: ui.selected && ui.selected.kind === "village" ? villages.find((v) => v.id === ui.selected.id) || null : null,
    panelModel,
    panel,
    hover,
    tokenR: tokenRadius(cam),
    villageHalf: villageHalf(cam),
    scale: scaleOf(cam),
  };
}

// What is at a screen point? Returns one of
//   { kind: "panel", id }       a panel button
//   { kind: "mapButton", id }
//   { kind: "marker", id }      a battle icon
//   { kind: "army" | "monster" | "village", id }
//   { kind: "ground", world }   empty map
//   { kind: "panel_area" }      the panel, but not a button
//   null                        outside everything
export function hitTest(vm, px, py) {
  const L = vm.layout;
  if (inRect(L.panel, px, py)) {
    const bodyRect = vm.panel.bodyRect;
    for (const part of [vm.panel.header, vm.panel.body]) {
      for (const p of part.placed) {
        for (const it of p.items) {
          const visible = part === vm.panel.header || (it.rect.y >= bodyRect.y - 1 && it.rect.y + it.rect.h <= bodyRect.y + bodyRect.h + 1);
          if (visible && inRect(it.rect, px, py)) return it.enabled === false ? { kind: "panel_area" } : { kind: "panel", id: it.id };
        }
      }
    }
    return { kind: "panel_area" };
  }
  if (!inRect(L.map, px, py)) return null;
  for (const b of vm.mapButtons) if (inRect(b.rect, px, py)) return { kind: "mapButton", id: b.id };
  const near = (e, r) => (e.x - px) ** 2 + (e.y - py) ** 2 <= r * r;
  for (const m of vm.markers) if (near(m, 16)) return { kind: "marker", id: m.battleId };
  const armies = vm.armies.filter((a) => near(a, vm.tokenR + 4)).sort((a, b) => (a.x - px) ** 2 + (a.y - py) ** 2 - ((b.x - px) ** 2 + (b.y - py) ** 2) || cmp(a.id, b.id));
  if (armies.length > 0) return { kind: "army", id: armies[0].id };
  for (const m of vm.monsters) if (near(m, vm.tokenR + 4)) return { kind: "monster", id: m.id };
  const h = vm.villageHalf + 3;
  for (const v of vm.villages) if (Math.abs(v.x - px) <= h && Math.abs(v.y - py) <= h) return { kind: "village", id: v.id };
  return { kind: "ground", world: screenToWorld(vm.camera, L.map, px, py) };
}

// ---------------------------------------------------------------
// Acting on taps and buttons (pure)
// ---------------------------------------------------------------
// Both return { ui, effect } where effect is null or
//   { type: "submit", orders } | { type: "open_battle", battleId }
//   | { type: "toggle_battle", battleId }

function moveHere(ui, game, localOwnerId, point) {
  if (!ui.actorId) return { ui, effect: null };
  const res = stageMove(ui, game, localOwnerId, ui.actorId, point);
  return { ui: res.ui, effect: null };
}

export function handleTapOnMap(ui, game, localOwnerId, hit, layout) {
  const canPlan = getTurnStatus(game, ui, localOwnerId).canPlan;
  if (hit.kind === "marker") return { ui, effect: { type: "toggle_battle", battleId: hit.id } };
  if (hit.kind === "army") {
    const mine = ownArmy(game, localOwnerId, hit.id);
    if (mine) return { ui: patch(ui, { actorId: mine.id, selected: { kind: "army", id: mine.id }, dialog: null, message: null }), effect: null };
    return { ui: patch(ui, { selected: { kind: "army", id: hit.id }, dialog: null, message: null }), effect: null };
  }
  if (hit.kind === "monster" || hit.kind === "village") {
    const village = hit.kind === "village" ? game.villages.find((v) => v.id === hit.id) : null;
    const hireType = village ? hireOptions(game, localOwnerId, village)[0] : null;
    return {
      ui: patch(ui, {
        selected: { kind: hit.kind, id: hit.id },
        dialog: null,
        message: null,
        hire: hireType ? { typeId: hireType.id, count: 1 } : ui.hire,
      }),
      effect: null,
    };
  }
  if (hit.kind === "ground") {
    if (ui.actorId && canPlan) return moveHere(ui, game, localOwnerId, hit.world);
    return { ui: patch(ui, { selected: null, message: null }), effect: null };
  }
  return { ui, effect: null };
}

// A panel or map button was pressed.
export function handleButton(ui, game, localOwnerId, id, layout) {
  const status = getTurnStatus(game, ui, localOwnerId);
  const canPlan = status.canPlan;
  const actor = ui.actorId ? game.armies.find((a) => a.id === ui.actorId) : null;
  const done = (res) => ({ ui: res.ui, effect: null });

  if (id === "zoom_in" || id === "zoom_out") {
    const f = id === "zoom_in" ? 1.35 : 1 / 1.35;
    const c = { x: layout.map.x + layout.map.w / 2, y: layout.map.y + layout.map.h / 2 };
    return { ui: patch(ui, { camera: zoomCamera(ui.camera, game.world, layout.map, f, c.x, c.y) }), effect: null };
  }
  if (id === "fit") {
    return { ui: patch(ui, { camera: clampCamera({ zoom: fitZoom(game.world, layout.map), cx: 0, cy: 0 }, game.world, layout.map) }), effect: null };
  }
  if (id === "center" && actor) {
    const w = worldArmy(game, actor.id);
    return { ui: patch(ui, { camera: clampCamera({ ...ui.camera, cx: w.x, cy: w.y }, game.world, layout.map) }), effect: null };
  }
  if (id === "center") return { ui, effect: null };
  if (id === "deselect") return { ui: patch(ui, { actorId: null, selected: null, dialog: null, message: null }), effect: null };
  if (id.startsWith("battle:")) return { ui, effect: { type: "open_battle", battleId: id.slice(7) } };

  if (!canPlan) return { ui, effect: null };

  if (id === "submit") {
    return { ui: patch(ui, { submitted: true, dialog: null, message: null }), effect: { type: "submit", orders: buildOrders(ui) } };
  }
  if (id === "undo") return { ui: undoLast(ui), effect: null };
  if (id === "clear") return { ui: clearOrders(ui), effect: null };
  if (id === "cancel_move" && actor) return { ui: cancelMove(ui, actor.id), effect: null };
  if (id.startsWith("face:") && actor) return done(setMoveFacing(ui, game, localOwnerId, actor.id, id.slice(5)));
  if (id === "move_here" && actor && ui.selected) {
    const target =
      ui.selected.kind === "army" ? worldArmy(game, ui.selected.id)
      : ui.selected.kind === "monster" ? game.monsters.find((m) => m.id === ui.selected.id)
      : game.villages.find((v) => v.id === ui.selected.id);
    return target ? moveHere(ui, game, localOwnerId, { x: target.x, y: target.y }) : { ui, effect: null };
  }
  if (id.startsWith("join:") && actor) return done(stageJoin(ui, game, localOwnerId, actor.id, id.slice(5)));
  if (id.startsWith("switch:") && actor) {
    const [, stackId, formation] = id.split(":");
    return done(stageSwitch(ui, game, localOwnerId, actor.id, stackId, formation));
  }
  if (id.startsWith("merge:") && actor) {
    const [, a, b] = id.split(":");
    return done(stageMerge(ui, game, localOwnerId, actor.id, a, b));
  }
  if (id.startsWith("detach:") && actor) {
    return { ui: patch(ui, { dialog: { kind: "detach", stackId: id.slice(7), count: 1 }, message: null }), effect: null };
  }
  if (id === "detach_cancel") return { ui: patch(ui, { dialog: null }), effect: null };
  if ((id === "detach_dec" || id === "detach_inc") && ui.dialog && actor) {
    const stack = actor.stacks.find((s) => s.id === ui.dialog.stackId);
    const max = stack ? stack.count - (actor.stacks.length === 1 ? 1 : 0) : 1;
    const count = clamp(ui.dialog.count + (id === "detach_inc" ? 1 : -1), 1, Math.max(1, max));
    return { ui: patch(ui, { dialog: { ...ui.dialog, count } }), effect: null };
  }
  if (id === "detach_ok" && ui.dialog && actor) return done(stageDetach(ui, game, localOwnerId, actor.id, ui.dialog.stackId, ui.dialog.count));
  if (id.startsWith("hire_type:")) return { ui: patch(ui, { hire: { typeId: id.slice(10), count: 1 } }), effect: null };
  if ((id === "hire_dec" || id === "hire_inc") && ui.selected && ui.selected.kind === "village") {
    const typeId = ui.hire.typeId;
    const max = typeId ? maxHireCount(ui, game, localOwnerId, typeId) : 1;
    const count = clamp(ui.hire.count + (id === "hire_inc" ? 1 : -1), 1, Math.max(1, max));
    return { ui: patch(ui, { hire: { ...ui.hire, count } }), effect: null };
  }
  if (id === "hire_ok" && ui.selected && ui.selected.kind === "village") {
    const typeId = ui.hire.typeId || (hireOptions(game, localOwnerId, game.villages.find((v) => v.id === ui.selected.id) || { hireTypes: null })[0] || {}).id;
    if (!typeId) return { ui, effect: null };
    return done(stageHire(ui, game, localOwnerId, ui.selected.id, typeId, ui.hire.count));
  }
  return { ui, effect: null };
}

// ---------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------

function font(size, weight = "normal") {
  return `${weight} ${Math.round(size)}px ${FONT}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitText(ctx, t, maxWidth) {
  if (ctx.measureText(t).width <= maxWidth) return t;
  let s = t;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxWidth) s = s.slice(0, -1);
  return s + "…";
}

function drawMap(ctx, vm, game) {
  const L = vm.layout;
  const rect = L.map;
  const cam = vm.camera;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // The field
  const a = worldToScreen(cam, rect, { x: 0, y: 0 });
  const b = worldToScreen(cam, rect, { x: game.world.widthTiles * S, y: game.world.heightTiles * S });
  ctx.fillStyle = THEME.field;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  const tile = cam.zoom;
  if (tile >= 12) {
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= game.world.widthTiles; i++) {
      const x = a.x + i * tile;
      if (x >= rect.x && x <= rect.x + rect.w) {
        ctx.moveTo(Math.round(x) + 0.5, Math.max(a.y, rect.y));
        ctx.lineTo(Math.round(x) + 0.5, Math.min(b.y, rect.y + rect.h));
      }
    }
    for (let j = 0; j <= game.world.heightTiles; j++) {
      const y = a.y + j * tile;
      if (y >= rect.y && y <= rect.y + rect.h) {
        ctx.moveTo(Math.max(a.x, rect.x), Math.round(y) + 0.5);
        ctx.lineTo(Math.min(b.x, rect.x + rect.w), Math.round(y) + 0.5);
      }
    }
    ctx.stroke();
  } else {
    // Zoomed out: a coarser checker so the field is not a flat block.
    ctx.fillStyle = THEME.fieldAlt;
    const step = tile * 4;
    for (let j = 0; j * 4 < game.world.heightTiles; j++) {
      for (let i = 0; i * 4 < game.world.widthTiles; i++) {
        if ((i + j) % 2 === 0) ctx.fillRect(a.x + i * step, a.y + j * step, Math.min(step, b.x - (a.x + i * step)), Math.min(step, b.y - (a.y + j * step)));
      }
    }
  }
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

  // Rings: capture range of the inspected village, move range of the actor.
  if (vm.selectedVillage) {
    const v = vm.selectedVillage;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = THEME.capture;
    ctx.beginPath();
    ctx.arc(v.x, v.y, CAPTURE_RANGE_SUBTILES * vm.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = THEME.disturb;
    ctx.beginPath();
    ctx.arc(v.x, v.y, DISTURB_RANGE_SUBTILES * vm.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (vm.moveRange) {
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = THEME.moveRange;
    ctx.beginPath();
    ctx.arc(vm.moveRange.center.x, vm.moveRange.center.y, vm.moveRange.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Staged moves
  for (const o of vm.orders) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = THEME.order;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(o.from.x, o.from.y);
    ctx.lineTo(o.to.x, o.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Where the army will really be at the end of the turn.
    ctx.beginPath();
    ctx.arc(o.reach.x, o.reach.y, vm.tokenR * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,209,102,0.25)";
    ctx.fill();
    ctx.stroke();
    if (!o.fullTrip) {
      ctx.beginPath();
      ctx.arc(o.to.x, o.to.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawArrow(ctx, o.reach.x, o.reach.y, o.facing, vm.tokenR * 0.7, THEME.order);
  }

  for (const v of vm.villages) drawVillage(ctx, vm, v);
  for (const m of vm.monsters) drawMonster(ctx, vm, m);
  for (const a2 of vm.armies) drawArmy(ctx, vm, a2);
  for (const m of vm.markers) drawMarker(ctx, m);

  // Tooltip
  if (vm.hover && vm.hover.lines && vm.hover.lines.length > 0) drawTooltip(ctx, vm, vm.hover);
  ctx.restore();

  for (const bt of vm.mapButtons) {
    roundRect(ctx, bt.rect.x, bt.rect.y, bt.rect.w, bt.rect.h, 6);
    ctx.fillStyle = "rgba(24,30,38,0.92)";
    ctx.fill();
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = THEME.text;
    ctx.font = font(18, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(bt.label, bt.rect.x + bt.rect.w / 2, bt.rect.y + bt.rect.h / 2 + 1);
  }
}

function drawArrow(ctx, x, y, facing, r, color) {
  const v = VECTORS[facing];
  if (!v) return;
  const tx = x + v.x * r * 1.5;
  const ty = y + v.y * r * 1.5;
  const bx = x + v.x * r * 0.95;
  const by = y + v.y * r * 0.95;
  const px = -v.y * r * 0.4;
  const py = v.x * r * 0.4;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx + px, by + py);
  ctx.lineTo(bx - px, by - py);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawVillage(ctx, vm, v) {
  const h = vm.villageHalf;
  const x = v.x;
  const y = v.y;
  // Body and roof
  ctx.fillStyle = v.color;
  ctx.fillRect(x - h * 0.8, y - h * 0.2, h * 1.6, h * 1.0);
  ctx.beginPath();
  ctx.moveTo(x - h, y - h * 0.15);
  ctx.lineTo(x, y - h * 0.95);
  ctx.lineTo(x + h, y - h * 0.15);
  ctx.closePath();
  ctx.fillStyle = v.ownerId === null ? "#5b6672" : v.color;
  ctx.fill();
  ctx.strokeStyle = v.isSelected ? THEME.gold : "rgba(0,0,0,0.55)";
  ctx.lineWidth = v.isSelected ? 3 : 1.5;
  ctx.strokeRect(x - h * 0.8, y - h * 0.2, h * 1.6, h * 1.0);
  ctx.fillStyle = "rgba(14,18,23,0.8)";
  ctx.fillRect(x - h * 0.18, y + h * 0.25, h * 0.36, h * 0.55);
  if (vm.camera.zoom >= 18) {
    ctx.font = font(11, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = THEME.text;
    ctx.fillText(v.name, x, y + h * 0.95);
    if (v.stored > 0) {
      ctx.fillStyle = v.frozen ? THEME.bad : THEME.gold;
      ctx.fillText(`${v.frozen ? "frozen " : "+"}${v.stored}`, x, y + h * 0.95 + 13);
    }
  } else if (v.frozen) {
    ctx.fillStyle = THEME.bad;
    ctx.font = font(12, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", x, y - h * 1.2);
  }
}

function drawMonster(ctx, vm, m) {
  const r = vm.tokenR;
  ctx.beginPath();
  ctx.moveTo(m.x, m.y - r);
  ctx.lineTo(m.x + r, m.y + r * 0.8);
  ctx.lineTo(m.x - r, m.y + r * 0.8);
  ctx.closePath();
  ctx.fillStyle = MONSTER_COLOR;
  ctx.fill();
  ctx.strokeStyle = m.isSelected ? THEME.gold : "rgba(0,0,0,0.6)";
  ctx.lineWidth = m.isSelected ? 3 : 1.5;
  ctx.stroke();
  ctx.fillStyle = "#0e1217";
  ctx.font = font(r * 0.8, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(m.units), m.x, m.y + r * 0.2);
}

function drawArmy(ctx, vm, a) {
  const r = vm.tokenR;
  drawArrow(ctx, a.x, a.y, a.facing, r, "#f4f7fb");
  ctx.beginPath();
  ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.lineWidth = a.isActor ? 4 : a.isSelected ? 3 : 1.5;
  ctx.strokeStyle = a.isActor || a.isSelected ? THEME.gold : "rgba(0,0,0,0.6)";
  ctx.stroke();
  ctx.fillStyle = "#0e1217";
  ctx.font = font(r * 0.85, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(a.units), a.x, a.y + 1);
  if (a.wounded) {
    ctx.beginPath();
    ctx.arc(a.x + r * 0.75, a.y - r * 0.75, Math.max(3, r * 0.25), 0, Math.PI * 2);
    ctx.fillStyle = THEME.bad;
    ctx.fill();
  }
  if (a.hasOrder) {
    ctx.beginPath();
    ctx.arc(a.x - r * 0.75, a.y - r * 0.75, Math.max(3, r * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = THEME.gold;
    ctx.fill();
  }
}

function drawMarker(ctx, m) {
  ctx.globalAlpha = m.over ? 0.55 : 1;
  ctx.beginPath();
  ctx.arc(m.x, m.y, 14, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(11,14,18,0.92)";
  ctx.fill();
  ctx.lineWidth = m.unread ? 3 : 1.5;
  ctx.strokeStyle = m.unread ? THEME.gold : m.windowState === "open" ? THEME.moveRange : THEME.bad;
  ctx.stroke();
  // Crossed swords
  ctx.strokeStyle = THEME.text;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(m.x - 6, m.y - 6);
  ctx.lineTo(m.x + 6, m.y + 6);
  ctx.moveTo(m.x + 6, m.y - 6);
  ctx.lineTo(m.x - 6, m.y + 6);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawTooltip(ctx, vm, hover) {
  ctx.font = font(12);
  const w = Math.min(280, Math.max(...hover.lines.map((l) => ctx.measureText(l).width)) + 16);
  const h = hover.lines.length * 16 + 10;
  const rect = vm.layout.map;
  const x = clamp(hover.x + 14, rect.x + 4, rect.x + rect.w - w - 4);
  const y = clamp(hover.y + 14, rect.y + 4, rect.y + rect.h - h - 4);
  roundRect(ctx, x, y, w, h, 6);
  ctx.fillStyle = "rgba(11,14,18,0.94)";
  ctx.fill();
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  hover.lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? THEME.text : THEME.muted;
    ctx.font = font(12, i === 0 ? "bold" : "normal");
    ctx.fillText(fitText(ctx, l, w - 12), x + 8, y + 6 + i * 16);
  });
}

function toneColor(tone) {
  return tone === "gold" ? THEME.gold : tone === "warn" ? THEME.warn : tone === "good" ? THEME.good : tone === "muted" ? THEME.muted : THEME.text;
}

function drawRows(ctx, part) {
  for (const p of part.placed) {
    const r = p.rect;
    const row = p.row;
    if (row.kind === "title") {
      ctx.fillStyle = row.tone ? toneColor(row.tone) : THEME.text;
      ctx.font = font(15, "bold");
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fitText(ctx, row.text, r.w), r.x, r.y + r.h / 2);
    } else if (row.kind === "text") {
      ctx.fillStyle = row.tone ? toneColor(row.tone) : THEME.text;
      ctx.font = font(12);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fitText(ctx, row.text, r.w), r.x, r.y + r.h / 2);
    } else if (row.kind === "divider") {
      ctx.strokeStyle = THEME.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.h / 2 + 0.5);
      ctx.lineTo(r.x + r.w, r.y + r.h / 2 + 0.5);
      ctx.stroke();
    } else if (row.kind === "stack") {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = THEME.text;
      ctx.font = font(13, "bold");
      ctx.fillText(fitText(ctx, row.label, r.w * 0.55), r.x, r.y + 8);
      ctx.fillStyle = THEME.muted;
      ctx.font = font(12);
      ctx.textAlign = "right";
      ctx.fillText(fitText(ctx, row.sub, r.w * 0.45), r.x + r.w, r.y + 8);
    } else if (row.kind === "stepper") {
      ctx.fillStyle = THEME.text;
      ctx.font = font(13);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(row.label, r.x, r.y + r.h / 2);
      ctx.textAlign = "center";
      ctx.font = font(15, "bold");
      const mid = (p.items[0].rect.x + p.items[0].rect.w + p.items[1].rect.x) / 2;
      ctx.fillText(String(row.value), mid, r.y + r.h / 2);
    }
    for (const it of p.items) drawButton(ctx, it);
  }
}

function drawButton(ctx, it) {
  const r = it.rect;
  roundRect(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.fillStyle = it.enabled === false ? THEME.buttonOff : it.selected ? THEME.buttonOn : THEME.button;
  ctx.fill();
  ctx.fillStyle = it.enabled === false ? THEME.buttonTextOff : THEME.buttonText;
  ctx.font = font(Math.min(13, r.h * 0.5), it.selected ? "bold" : "normal");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, it.label, r.w - 8), r.x + r.w / 2, r.y + r.h / 2 + 0.5);
}

function drawPanel(ctx, vm) {
  const p = vm.layout.panel;
  ctx.fillStyle = THEME.panel;
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (vm.layout.mode === "side") {
    ctx.moveTo(p.x + 0.5, p.y);
    ctx.lineTo(p.x + 0.5, p.y + p.h);
  } else {
    ctx.moveTo(p.x, p.y + 0.5);
    ctx.lineTo(p.x + p.w, p.y + 0.5);
  }
  ctx.stroke();
  drawRows(ctx, vm.panel.header);
  ctx.save();
  ctx.beginPath();
  ctx.rect(vm.panel.bodyRect.x - 2, vm.panel.bodyRect.y, vm.panel.bodyRect.w + 4, vm.panel.bodyRect.h);
  ctx.clip();
  drawRows(ctx, vm.panel.body);
  ctx.restore();
  // A hint that the body scrolls
  if (vm.panel.maxScroll > 0) {
    const b = vm.panel.bodyRect;
    const trackH = b.h;
    const thumbH = Math.max(24, (trackH * trackH) / (trackH + vm.panel.maxScroll));
    const thumbY = b.y + ((trackH - thumbH) * vm.panel.scroll) / vm.panel.maxScroll;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, p.x + p.w - 6, thumbY, 3, thumbH, 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------
// Tooltip text (pure)
// ---------------------------------------------------------------

export function describeHover(game, hit, names = {}) {
  if (!hit) return [];
  if (hit.kind === "army") {
    const a = game.armies.find((x) => x.id === hit.id);
    if (!a) return [];
    return [a.name, `${nameOf(names, a.ownerId)} · ${armyUnitCount(a)} units`, ...a.stacks.map((s) => `${getUnitType(s.typeId).name} ×${s.count}${s.carry > 0 ? " (wounded)" : ""}`)];
  }
  if (hit.kind === "monster") {
    const m = game.monsters.find((x) => x.id === hit.id);
    return m ? [getUnitType(m.typeId).name, `${m.count} units`] : [];
  }
  if (hit.kind === "village") {
    const v = game.villages.find((x) => x.id === hit.id);
    if (!v) return [];
    return [v.name, v.ownerId === null ? "Neutral" : `Held by ${nameOf(names, v.ownerId)}`, `Pays ${villageIncome(v)} per turn`];
  }
  if (hit.kind === "marker") return ["Battle", "Click to watch"];
  return [];
}

// ---------------------------------------------------------------
// The UI object
// ---------------------------------------------------------------

export function createOverworldUI({
  canvas,
  game,
  localOwnerId,
  ownerNames = {},
  getBattleMarkers = () => [],
  onSubmit = () => {},
  onOpenBattle = () => {},
  onToggleBattle = () => {},
  width,
  height,
  dpr = 1,
}) {
  const ctx = canvas.getContext("2d");
  let G = game;
  let names = ownerNames;
  let size = { w: width ?? canvas.width, h: height ?? canvas.height };
  let layout = computeLayout(size.w, size.h);
  let ui = createUIState({ game: G, localOwnerId, layout });
  let hover = null; // { x, y, lines }
  let destroyed = false;
  const pointers = new Map(); // active pointers for pan and pinch
  let gesture = null;

  function applySize() {
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    if (canvas.style) {
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      canvas.style.touchAction = "none";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = computeLayout(size.w, size.h);
  }
  applySize();

  function currentVM() {
    return buildViewModel({ game: G, ui, layout, localOwnerId, names, battleMarkers: getBattleMarkers(), hover });
  }

  function render() {
    if (destroyed) return;
    const vm = currentVM();
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    drawMap(ctx, vm, G);
    drawPanel(ctx, vm);
  }

  function applyResult(res) {
    ui = res.ui;
    if (res.effect) {
      const e = res.effect;
      if (e.type === "submit") onSubmit(e.orders);
      else if (e.type === "open_battle") onOpenBattle(e.battleId);
      else if (e.type === "toggle_battle") onToggleBattle(e.battleId);
    }
    render();
    return res.effect;
  }

  // A tap or click at a canvas point.
  function handleTap(px, py) {
    if (destroyed) return null;
    const vm = currentVM();
    const hit = hitTest(vm, px, py);
    if (!hit) return null;
    if (hit.kind === "panel") return applyResult(handleButton(ui, G, localOwnerId, hit.id, layout));
    if (hit.kind === "mapButton") return applyResult(handleButton(ui, G, localOwnerId, hit.id, layout));
    if (hit.kind === "panel_area") return null;
    return applyResult(handleTapOnMap(ui, G, localOwnerId, hit, layout));
  }

  function handleHover(px, py) {
    const vm = currentVM();
    const hit = hitTest(vm, px, py);
    const lines = describeHover(G, hit, names);
    const next = lines.length ? { x: px, y: py, lines } : null;
    if (JSON.stringify(next) !== JSON.stringify(hover)) {
      hover = next;
      render();
    }
  }

  function pan(dx, dy) {
    ui = patch(ui, { camera: panCamera(ui.camera, G.world, layout.map, dx, dy) });
    render();
  }

  function zoomBy(factor, fx, fy) {
    const c = fx === undefined ? { x: layout.map.x + layout.map.w / 2, y: layout.map.y + layout.map.h / 2 } : { x: fx, y: fy };
    ui = patch(ui, { camera: zoomCamera(ui.camera, G.world, layout.map, factor, c.x, c.y) });
    render();
  }

  function scrollPanel(dy) {
    const vm = currentVM();
    ui = patch(ui, { panelScroll: clamp(ui.panelScroll + dy, 0, vm.panel.maxScroll) });
    render();
  }

  // ----- pointer input: tap, drag to pan, pinch to zoom -----
  function toPoint(ev) {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: size.w, height: size.h };
    const sx = r.width ? size.w / r.width : 1;
    const sy = r.height ? size.h / r.height : 1;
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
  }

  const onDown = (ev) => {
    const p = toPoint(ev);
    pointers.set(ev.pointerId ?? 0, { ...p, startX: p.x, startY: p.y });
    if (canvas.setPointerCapture && ev.pointerId !== undefined) {
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (e) {
        /* some pointers cannot be captured */
      }
    }
    gesture = { moved: false, startOnMap: inRect(layout.map, p.x, p.y), startOnPanel: inRect(layout.panel, p.x, p.y), pinch: pointers.size > 1 ? pinchDistance() : null, lastY: p.y };
  };
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const onMove = (ev) => {
    const p = toPoint(ev);
    const prev = pointers.get(ev.pointerId ?? 0);
    if (!prev) {
      handleHover(p.x, p.y);
      return;
    }
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    pointers.set(ev.pointerId ?? 0, { ...prev, x: p.x, y: p.y });
    if (!gesture) return;
    if (pointers.size > 1 && gesture.startOnMap) {
      const d = pinchDistance();
      if (gesture.pinch) {
        const [a, b] = [...pointers.values()];
        zoomBy(d / gesture.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      gesture.pinch = d;
      gesture.moved = true;
      return;
    }
    const total = Math.hypot(p.x - prev.startX, p.y - prev.startY);
    if (total > TAP_SLOP) gesture.moved = true;
    if (gesture.moved && gesture.startOnMap) pan(dx, dy);
    else if (gesture.moved && gesture.startOnPanel) scrollPanel(-dy);
  };
  const onUp = (ev) => {
    const id = ev.pointerId ?? 0;
    const p = toPoint(ev);
    const wasTap = gesture && !gesture.moved && pointers.size === 1;
    pointers.delete(id);
    if (wasTap) handleTap(p.x, p.y);
    if (pointers.size === 0) gesture = null;
  };
  const onCancel = (ev) => {
    pointers.delete(ev.pointerId ?? 0);
    if (pointers.size === 0) gesture = null;
  };
  const onLeave = () => {
    if (hover) {
      hover = null;
      render();
    }
  };
  const onWheel = (ev) => {
    const p = toPoint(ev);
    if (inRect(layout.panel, p.x, p.y)) {
      scrollPanel(ev.deltaY);
    } else {
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }
    if (ev.preventDefault) ev.preventDefault();
  };
  const onKey = (ev) => {
    const step = 60;
    if (ev.key === "ArrowLeft") pan(step, 0);
    else if (ev.key === "ArrowRight") pan(-step, 0);
    else if (ev.key === "ArrowUp") pan(0, step);
    else if (ev.key === "ArrowDown") pan(0, -step);
    else if (ev.key === "+" || ev.key === "=") zoomBy(1.2);
    else if (ev.key === "-") zoomBy(1 / 1.2);
    else if (ev.key === "Escape") applyResult(handleButton(ui, G, localOwnerId, "deselect", layout));
    else if (ev.key === "Enter") applyResult(handleButton(ui, G, localOwnerId, "submit", layout));
    else return;
    if (ev.preventDefault) ev.preventDefault();
  };

  if (canvas.addEventListener) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
  }
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("keydown", onKey);

  render();

  return {
    // Give the UI the latest game (after every update).
    setGame(next) {
      G = next;
      ui = syncUIWithGame(ui, G, localOwnerId, layout);
      render();
    },
    setOwnerNames(map) {
      names = map;
      render();
    },
    // Screen position (in the canvas) of an overworld point (sub-tiles).
    worldToScreen(point) {
      return worldToScreen(ui.camera, layout.map, point);
    },
    resize(w, h, ratio = 1) {
      size = { w, h };
      dpr = ratio;
      applySize();
      ui = patch(ui, { camera: clampCamera({ ...ui.camera, zoom: Math.max(ui.camera.zoom, fitZoom(G.world, layout.map)) }, G.world, layout.map) });
      render();
    },
    render,
    // For tests and custom input: the same as the real pointer events.
    handleTap,
    handleHover,
    pan,
    zoomBy,
    scrollPanel,
    getState: () => ui,
    getViewModel: currentVM,
    getLayout: () => layout,
    destroy() {
      destroyed = true;
      if (canvas.removeEventListener) {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onCancel);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("wheel", onWheel);
      }
      if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("keydown", onKey);
    },
  };
}

// ---------------------------------------------------------------
// Self test (call overworldUISelfTest() from the browser console)
// ---------------------------------------------------------------

import { generateWorldBattle } from "./mapGenerator.js";
import { createGame, beginTurn, runAiBattles } from "./turnResolver.js";
import { placeArmy } from "./overworld.js";

export function overworldUISelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`overworldUISelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mkGame = (seed = "ow", mode = "ai", players = [{ ownerId: "p1" }]) => createGame({ map: generateWorldBattle({ seed, mode, players }) });
  const layoutW = computeLayout(960, 560);
  const layoutN = computeLayout(390, 720);

  // --- Layout ---
  eq([layoutW.mode, layoutN.mode], ["side", "bottom"], "wide and narrow layouts");
  eq(layoutW.map.w + layoutW.panel.w, 960, "map and panel fill the width");
  eq(layoutN.map.h + layoutN.panel.h, 720, "map and panel fill the height");

  // --- Camera ---
  const g = mkGame();
  const cam0 = createCamera(g.world, layoutW.map, { x: 400, y: 400 });
  const wp = { x: 500, y: 450 };
  const sp = worldToScreen(cam0, layoutW.map, wp);
  eq(screenToWorld(cam0, layoutW.map, sp.x, sp.y), wp, "screen and world round trip");
  const zoomed = zoomCamera(cam0, g.world, layoutW.map, 1.5, sp.x, sp.y);
  const sp2 = worldToScreen(zoomed, layoutW.map, wp);
  eq([Math.abs(sp2.x - sp.x) < 1.5, Math.abs(sp2.y - sp.y) < 1.5], [true, true], "zooming keeps the point under the cursor");
  eq(zoomed.zoom > cam0.zoom, true, "zoomed in");
  const out = zoomCamera(cam0, g.world, layoutW.map, 0.001, 100, 100);
  eq(out.zoom, fitZoom(g.world, layoutW.map), "cannot zoom out past the whole map");
  eq(zoomCamera(cam0, g.world, layoutW.map, 1000, 100, 100).zoom, MAX_ZOOM, "cannot zoom in forever");
  const panned = panCamera(cam0, g.world, layoutW.map, -100000, -100000);
  eq(panned.cx <= g.world.widthTiles * S && panned.cx > 0, true, "panning stays on the map");
  const fit = clampCamera({ zoom: fitZoom(g.world, layoutW.map), cx: 0, cy: 0 }, g.world, layoutW.map);
  eq([fit.cx, fit.cy].every((v) => v > 0), true, "a camera showing everything is centered");

  // --- View model and hit testing ---
  let ui = createUIState({ game: g, localOwnerId: "p1", layout: layoutW });
  const mine = g.armies.find((a) => a.ownerId === "p1");
  eq([ui.actorId, ui.selected], [mine.id, { kind: "army", id: mine.id }], "starts commanding the player's army");
  const vm = buildViewModel({ game: g, ui, layout: layoutW, localOwnerId: "p1", names: { p1: "You" } });
  eq([vm.armies.length, vm.villages.length, vm.monsters.length], [g.armies.length, g.villages.length, 0], "everything is drawn");
  eq(vm.armies.find((a) => a.id === mine.id).isActor, true, "the commanded army is marked");
  eq(vm.colors.p1, OWNER_COLORS[0], "the local player is blue");
  const me = vm.armies.find((a) => a.id === mine.id);
  eq(hitTest(vm, me.x, me.y), { kind: "army", id: mine.id }, "hit an army");
  const vill = vm.villages[0];
  eq(hitTest(vm, vill.x, vill.y), { kind: "village", id: vill.id }, "hit a village");
  const emptySpot = { x: layoutW.map.x + 6, y: layoutW.map.y + layoutW.map.h - 6 };
  eq(hitTest(vm, emptySpot.x, emptySpot.y).kind === "ground" || hitTest(vm, emptySpot.x, emptySpot.y).kind === "village", true, "hit the ground");
  eq(hitTest(vm, layoutW.map.x + layoutW.map.w + 5, 5).kind, "panel_area", "the panel is not the map");
  eq(hitTest(vm, mapButtons(layoutW)[0].rect.x + 3, mapButtons(layoutW)[0].rect.y + 3), { kind: "mapButton", id: "zoom_in" }, "map button");
  eq(hitTest(vm, -5, -5), null, "outside everything");
  const submitBtn = vm.panel.header.placed.flatMap((p) => p.items).find((i) => i.id === "submit");
  eq(hitTest(vm, submitBtn.rect.x + 4, submitBtn.rect.y + 4), { kind: "panel", id: "submit" }, "panel button");

  // --- Staging moves ---
  const start = worldArmy(g, mine.id);
  const target = { x: start.x + 200, y: start.y };
  let r = stageMove(ui, g, "p1", mine.id, target);
  eq([r.ok, r.ui.staged.length, r.ui.staged[0].facing], [true, 1, "E"], "a move is staged and faces its way");
  r = stageMove(r.ui, g, "p1", mine.id, { x: start.x, y: start.y + 200 });
  eq([r.ui.staged.length, r.ui.staged[0].facing], [1, "S"], "a new move replaces the old one");
  eq(stageMove(ui, g, "p1", g.armies.find((a) => a.ownerId === "ai").id, target).ok, false, "cannot move someone else's army");
  eq(stageMove(ui, g, "p1", mine.id, { x: -50, y: 999999 }).ui.staged[0].target.x, 0, "targets are kept on the map");
  r = setMoveFacing(r.ui, g, "p1", mine.id, "W");
  eq([r.ui.staged[0].facing, r.ui.staged[0].target.y], ["W", start.y + 200], "facing changes without losing the target");
  eq(cancelMove(r.ui, mine.id).staged, [], "cancel move");
  const facingOnly = setMoveFacing(ui, g, "p1", mine.id, "N");
  eq(facingOnly.ui.staged, [{ type: "move", armyId: mine.id, facing: "N" }], "facing-only order");

  // --- Hiring ---
  const myVillage = g.villages.find((v) => v.ownerId === "p1");
  const opts = hireOptions(g, "p1", myVillage).map((t) => t.id);
  eq(opts.includes("swordsman") && !opts.includes("archer"), true, "only unlocked types are offered");
  const maxSword = maxHireCount(ui, g, "p1", "swordsman");
  eq(maxSword, 3, "limited by gold: 100 / 30");
  let h = stageHire(ui, g, "p1", myVillage.id, "swordsman", 2);
  eq([h.ok, h.ui.staged[0]], [true, { type: "hire", villageId: myVillage.id, typeId: "swordsman", count: 2 }], "hire staged");
  eq(maxHireCount(h.ui, g, "p1", "swordsman"), 1, "staged hires use up gold");
  eq(stageHire(h.ui, g, "p1", myVillage.id, "swordsman", 2).ok, false, "cannot stage more than allowed");
  h = stageHire(h.ui, g, "p1", myVillage.id, "swordsman", 1);
  eq(h.ui.staged[0].count, 3, "hires of the same type add up");
  eq(stageHire(ui, g, "p1", myVillage.id, "archer", 1).ok, false, "locked units cannot be hired");
  const neutralVillage = g.villages.find((v) => v.ownerId === null);
  eq(stageHire(ui, g, "p1", neutralVillage.id, "swordsman", 1).ok, false, "only villages you hold");
  const eco = summarizeEconomy(g, h.ui, "p1");
  eq([eco.gold, eco.stagedCost, eco.income, eco.salary], [100, 90, 10, 2 + 6], "economy summary counts staged hires");
  eq(eco.shortfall, 0, "salaries are covered");
  const poor = { ...g, economies: { p1: { gold: 5, debt: 0 } } };
  eq(maxHireCount(ui, poor, "p1", "swordsman"), 0, "no gold, no hires");

  // --- Stack and army orders ---
  const stack = mine.stacks[0];
  let s = stageSwitch(ui, g, "p1", mine.id, stack.id, "line");
  eq(s.ui.staged[0], { type: "switch", armyId: mine.id, stackId: stack.id, formation: "line" }, "formation switch staged");
  eq(stageSwitch(s.ui, g, "p1", mine.id, stack.id, stack.formationType).ui.staged, [], "choosing the current formation cancels it");
  eq(mergePartner(mine, stack.id), null, "no merge partner with one stack");
  const two = { ...g, armies: g.armies.map((a) => (a.id === mine.id ? { ...a, stacks: [{ ...a.stacks[0], count: 4 }, { ...a.stacks[0], id: "extra", count: 2, cell: { col: 0, row: 1 } }] } : a)) };
  eq(mergePartner(two.armies.find((a) => a.id === mine.id), stack.id).id, "extra", "merge partner found");
  eq(stageMerge(ui, two, "p1", mine.id, stack.id, "extra").ui.staged[0].type, "merge_stacks", "merge staged");
  eq(stageDetach(ui, two, "p1", mine.id, stack.id, 2).ui.staged[0], { type: "transfer", fromArmyId: mine.id, toArmyId: null, stackId: stack.id, count: 2 }, "detach staged");
  eq(stageDetach(ui, g, "p1", mine.id, stack.id, 1).ok, false, "cannot detach the only unit of the only stack");
  // Join a nearby army
  const near = { ...two, world: placeArmy(two.world, g.armies.find((a) => a.id === mine.id).id, start.x, start.y) };
  const second = { id: "buddy", ownerId: "p1", name: "Buddy", facing: "N", stacks: [{ ...stack, id: "bs", cell: { col: 2, row: 0 } }] };
  const withBuddy = { ...near, armies: near.armies.concat([second]), world: { ...near.world, armies: near.world.armies.concat([{ id: "buddy", ownerId: "p1", x: start.x + 6, y: start.y, facing: "N" }]) } };
  eq(nearbyOwnArmies(withBuddy, "p1", mine.id).map((a) => a.id), ["buddy"], "a nearby army is found");
  const joined = stageJoin(stageMove(ui, withBuddy, "p1", mine.id, target).ui, withBuddy, "p1", mine.id, "buddy");
  eq(joined.ok, true, "join staged");
  eq(joined.ui.staged.every((o) => o.type === "transfer"), true, "joining replaces the move with transfers");
  eq(joined.ui.staged.length, 2, "one transfer per stack");

  // --- Order list ---
  let all = stageMove(h.ui, g, "p1", mine.id, target).ui;
  all = stageSwitch(all, g, "p1", mine.id, stack.id, "line").ui;
  eq(buildOrders(all).map((o) => o.type), ["hire", "switch", "move"], "moves go last");
  eq(undoLast(all).staged.length, 2, "undo removes the last order");
  eq(clearOrders(all).staged, [], "clear removes everything");
  eq(describeOrder(g, all.staged[0]).startsWith("Hire 3 Swordsman"), true, "orders are described");

  // --- The staged orders really work in the resolver ---
  const played = beginTurn(g, { p1: buildOrders(all) });
  eq(played.rejected, [], "the resolver accepts every staged order");
  eq(played.game.armies.filter((a) => a.ownerId === "p1").length, 2, "the hired army appeared");

  // --- Panel rows ---
  const model = buildPanelRows(g, ui, "p1", { p1: "You" });
  const ids = (part) => model[part].flatMap((r2) => (r2.items || []).map((i) => i.id)).concat(model[part].flatMap((r2) => (r2.kind === "buttons" ? r2.items.map((i) => i.id) : [])));
  const bodyIds = model.body.flatMap((r2) => (r2.kind === "buttons" || r2.kind === "stack" ? r2.items.map((i) => i.id) : []));
  eq(bodyIds.includes("face:N") && bodyIds.includes("cancel_move") && bodyIds.some((i) => i.startsWith("switch:")) && bodyIds.some((i) => i.startsWith("detach:")), true, "the army panel has its controls");
  eq(model.header.some((r2) => r2.kind === "buttons" && r2.items.some((i) => i.id === "submit" && i.enabled)), true, "End turn is enabled while planning");
  const villageUi = handleTapOnMap(ui, g, "p1", { kind: "village", id: myVillage.id }, layoutW).ui;
  const vModel = buildPanelRows(g, villageUi, "p1");
  const vIds = vModel.body.flatMap((r2) => (r2.kind === "buttons" ? r2.items.map((i) => i.id) : [])).concat(vModel.body.filter((r2) => r2.kind === "stepper").map((r2) => r2.id));
  eq(vIds.includes("hire_ok") && vIds.includes("move_here") && vIds.includes("hire") && vIds.some((i) => i.startsWith("hire_type:")), true, "the village panel offers hiring and moving there");
  const neutralModel = buildPanelRows(g, handleTapOnMap(ui, g, "p1", { kind: "village", id: neutralVillage.id }, layoutW).ui, "p1");
  eq(neutralModel.body.flatMap((r2) => (r2.kind === "buttons" ? r2.items.map((i) => i.id) : [])).some((i) => i.startsWith("hire")), false, "no hiring in a village you do not hold");
  const foe = g.armies.find((a) => a.ownerId === "ai");
  const foeModel = buildPanelRows(g, handleTapOnMap(ui, g, "p1", { kind: "army", id: foe.id }, layoutW).ui, "p1");
  eq(foeModel.body.flatMap((r2) => (r2.kind === "buttons" ? r2.items.map((i) => i.id) : [])).includes("move_here"), true, "an enemy can be attacked with the commanded army");
  // The panel scrolls and its buttons never leave it
  const placed = layoutPanel(layoutN, model, 0);
  eq(placed.bodyRect.y + placed.bodyRect.h <= layoutN.height, true, "the panel body is inside the screen");
  eq(placed.maxScroll >= 0, true, "scroll limit");
  const scrolled = layoutPanel(layoutN, model, 99999);
  eq(scrolled.scroll, scrolled.maxScroll, "scroll is clamped");

  // --- Tapping ---
  const tapMine = handleTapOnMap({ ...ui, actorId: null, selected: null }, g, "p1", { kind: "army", id: mine.id }, layoutW);
  eq([tapMine.ui.actorId, tapMine.ui.selected.kind], [mine.id, "army"], "tapping your army commands it");
  const tapFoe = handleTapOnMap(ui, g, "p1", { kind: "army", id: foe.id }, layoutW);
  eq([tapFoe.ui.actorId, tapFoe.ui.selected.id], [mine.id, foe.id], "tapping an enemy inspects it and keeps your army commanded");
  const tapGround = handleTapOnMap(ui, g, "p1", { kind: "ground", world: target }, layoutW);
  eq(tapGround.ui.staged.length, 1, "tapping the ground orders the army");
  eq(handleTapOnMap({ ...ui, actorId: null }, g, "p1", { kind: "ground", world: target }, layoutW).ui.staged, [], "without a commanded army the ground does nothing");
  eq(handleTapOnMap(ui, g, "p1", { kind: "marker", id: "b1" }, layoutW).effect, { type: "toggle_battle", battleId: "b1" }, "battle icons toggle the popup");

  // --- Buttons ---
  const sub = handleButton(all, g, "p1", "submit", layoutW);
  eq([sub.effect.type, sub.effect.orders.length, sub.ui.submitted], ["submit", 3, true], "End turn submits the orders");
  const after = buildPanelRows(g, sub.ui, "p1");
  eq(after.header[0].text, "Orders sent. Waiting for the others…", "waiting after submitting");
  eq(handleButton(sub.ui, g, "p1", "clear", layoutW).ui.staged.length, 3, "orders are locked after submitting");
  eq(handleButton(ui, g, "p1", "zoom_in", layoutW).ui.camera.zoom > ui.camera.zoom, true, "zoom button");
  eq(handleButton(ui, g, "p1", "fit", layoutW).ui.camera.zoom, fitZoom(g.world, layoutW.map), "fit button");
  eq(handleButton(ui, g, "p1", "deselect", layoutW).ui.actorId, null, "deselect");
  let dlg = handleButton(ui, two, "p1", `detach:${stack.id}`, layoutW).ui;
  dlg = handleButton(dlg, two, "p1", "detach_inc", layoutW).ui;
  eq(dlg.dialog.count, 2, "detach stepper");
  eq(handleButton(dlg, two, "p1", "detach_ok", layoutW).ui.staged[0].count, 2, "detach confirmed");
  let hv = handleButton(villageUi, g, "p1", "hire_inc", layoutW).ui;
  hv = handleButton(hv, g, "p1", "hire_ok", layoutW).ui;
  eq(hv.staged[0], { type: "hire", villageId: myVillage.id, typeId: "swordsman", count: 2 }, "hire from the panel");

  // --- Status ---
  eq(getTurnStatus(g, ui, "p1").phase, "planning", "planning");
  eq(getTurnStatus(g, { ...ui, submitted: true }, "p1").phase, "submitted", "submitted");
  eq(getTurnStatus({ ...g, over: true, winnerOwnerId: "p1" }, ui, "p1").text, "Victory!", "victory");
  eq(getTurnStatus({ ...g, over: true, winnerOwnerId: "ai" }, ui, "p1", { ai: "Raiders" }).text, "Game over: Raiders won", "defeat");
  eq(getTurnStatus({ ...g, eliminated: ["p1"] }, ui, "p1").phase, "eliminated", "eliminated");
  // Battles in progress
  const A = g.armies.find((a) => a.ownerId === "p1").id;
  const B = g.armies.find((a) => a.ownerId === "ai").id;
  const clash = { ...g, world: placeArmy(placeArmy(g.world, A, 200, 200), B, 260, 200) };
  const started = beginTurn(clash, { p1: [{ type: "move", armyId: A, target: { x: 400, y: 200 } }] });
  const st = getTurnStatus(started.game, ui, "p1");
  eq([st.phase, st.myBattles, st.canPlan], ["resolving", started.battles, false], "battles block planning and offer Fight!");
  const fightRows = buildPanelRows(started.game, ui, "p1");
  eq(fightRows.header.some((r2) => r2.kind === "buttons" && r2.items.some((i) => i.id === `battle:${started.battles[0]}`)), true, "Fight! button for your battle");
  eq(handleButton(ui, started.game, "p1", `battle:${started.battles[0]}`, layoutW).effect, { type: "open_battle", battleId: started.battles[0] }, "Fight! opens the battle");
  eq(handleButton(ui, started.game, "p1", "submit", layoutW).effect, null, "cannot submit while battles are pending");

  // --- A new turn clears staged orders and the submitted flag ---
  let finished = started.game;
  for (let i = 0; i < 30 && finished.resolution; i++) finished = runAiBattles(finished, ["p1", "ai"]).game;
  const synced = syncUIWithGame(sub.ui, finished, "p1", layoutW);
  eq([synced.staged, synced.submitted, synced.turn], [[], false, finished.turn], "staged orders last one turn");

  // --- The UI object, with a fake canvas ---
  const noop = new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true });
  const listeners = {};
  const fake = { width: 960, height: 560, getContext: () => noop, addEventListener: (n, f) => (listeners[n] = f), removeEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 560 }), style: {} };
  const submitted = [];
  const toggled = [];
  const game1 = mkGame("ui-obj");
  const ow = createOverworldUI({
    canvas: fake,
    game: game1,
    localOwnerId: "p1",
    getBattleMarkers: () => [{ battleId: "bx", worldPosition: { x: 300, y: 300 }, over: false, windowState: "closed", unread: false, title: "Battle" }],
    onSubmit: (o) => submitted.push(o),
    onToggleBattle: (id) => toggled.push(id),
    width: 960,
    height: 560,
  });
  const vm2 = ow.getViewModel();
  const myArmy = vm2.armies.find((a) => a.isMine);
  ow.handleTap(myArmy.x, myArmy.y);
  eq(ow.getState().actorId, myArmy.id, "tap selects your army");
  // Click empty ground a bit to the side of the army
  const spot = { x: myArmy.x + 60, y: myArmy.y + 10 };
  const hit = hitTest(ow.getViewModel(), spot.x, spot.y);
  if (hit.kind === "ground") {
    ow.handleTap(spot.x, spot.y);
    eq(ow.getState().staged.length, 1, "tapping the ground stages a move");
  }
  // Markers toggle popups
  const mk = ow.getViewModel().markers[0];
  ow.handleTap(mk.x, mk.y);
  eq(toggled, ["bx"], "battle icon tap reaches onToggleBattle");
  // Dragging pans, the wheel zooms
  const cam = ow.getState().camera;
  listeners.pointerdown({ clientX: 400, clientY: 300, pointerId: 1 });
  listeners.pointermove({ clientX: 360, clientY: 280, pointerId: 1 });
  listeners.pointerup({ clientX: 360, clientY: 280, pointerId: 1 });
  const cam2 = ow.getState().camera;
  eq(cam2.cx !== cam.cx || cam2.cy !== cam.cy, true, "dragging pans the map");
  eq(ow.getState().staged.length <= 1, true, "a drag is not a tap");
  listeners.wheel({ clientX: 400, clientY: 300, deltaY: -120 });
  eq(ow.getState().camera.zoom > cam2.zoom, true, "the wheel zooms");
  // End turn
  const endBtn = ow.getViewModel().panel.header.placed.flatMap((p) => p.items).find((i) => i.id === "submit");
  ow.handleTap(endBtn.rect.x + 5, endBtn.rect.y + 5);
  eq([submitted.length, ow.getState().submitted], [1, true], "End turn calls onSubmit once");
  ow.handleTap(endBtn.rect.x + 5, endBtn.rect.y + 5);
  eq(submitted.length, 1, "and not twice");
  ow.setGame(beginTurn(game1, {}).game);
  eq([ow.getState().submitted, ow.getState().staged], [false, []], "a new turn unlocks the screen");
  ow.resize(390, 720, 2);
  eq(ow.getLayout().mode, "bottom", "resizing to a phone switches the layout");
  const sc = ow.worldToScreen({ x: 100, y: 100 });
  eq(typeof sc.x === "number" && typeof sc.y === "number", true, "worldToScreen is exposed for popups");
  ow.destroy();

  return true;
}

export default {
  computeLayout,
  mapButtons,
  createCamera,
  worldToScreen,
  screenToWorld,
  panCamera,
  zoomCamera,
  fitZoom,
  clampCamera,
  ownerColors,
  createUIState,
  syncUIWithGame,
  stageMove,
  cancelMove,
  setMoveFacing,
  getStagedMove,
  hireOptions,
  maxHireCount,
  stageHire,
  stageSwitch,
  mergePartner,
  stageMerge,
  stageDetach,
  nearbyOwnArmies,
  stageJoin,
  undoLast,
  clearOrders,
  buildOrders,
  describeOrder,
  getTurnStatus,
  summarizeEconomy,
  buildPanelRows,
  layoutRows,
  layoutPanel,
  buildViewModel,
  hitTest,
  handleTapOnMap,
  handleButton,
  describeHover,
  createOverworldUI,
  overworldUISelfTest,
};
