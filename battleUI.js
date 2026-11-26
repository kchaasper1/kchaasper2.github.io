// battleUI.js
// Draws the battle grid and takes the player's clicks. Canvas 2D only: no
// images, no libraries, no DOM besides the canvas you give it.
//
// ---------------------------------------------------------------
// THE UI NEVER CHANGES THE BATTLE
// ---------------------------------------------------------------
// It reads a battleGrid state and EMITS plain action objects through
// onAction. Whoever owns the battle (single-player controller, or
// matchSync.js in PvP) applies the action with battleGrid.applyBattleAction()
// and then calls ui.setState(newState). Actions are:
//     { type: "move",   x, y }
//     { type: "attack", targetId }
//     { type: "switch", formation: "square" | "line" }
//     { type: "end",    facing? }
// After emitting, the UI ignores input until the next setState(), so a slow
// network or a double click cannot send two actions.
//
// ---------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------
//   const ui = createBattleUI({
//     canvas, state, localOwnerId: "p1",
//     ownerNames: { p1: "You", p2: "Enemy" },
//     width: 960, height: 560,            // CSS pixels
//     onAction: (action) => { ...apply it, then ui.setState(next) },
//   });
//   // After an attack, to animate it:
//   ui.setState(next);
//   ui.showAttack({ attackerId, targetId, report });   // report from the result
//   // While the AI or the opponent is playing:
//   ui.setInputEnabled(false);
//   // On window resize:
//   ui.resize(newWidth, newHeight, window.devicePixelRatio);
//   // When leaving the screen:
//   ui.destroy();
//
// WHAT YOU SEE
//   - The grid, with a small number above each unit's head showing how many
//     units are really in the stack, a red pip when the stack is wounded,
//     the formation icon (square or line) and, for a line, a bright bar on
//     the edge it faces.
//   - Your active unit's reachable squares (blue) and attackable enemies
//     (red), with the hit class and multiplier when you hover an enemy.
//   - A panel with whose move it is, the turn order, details of the hovered
//     or active unit, End / Switch formation / facing buttons and a short log.
//   - Wide screens put the panel on the right. Narrow screens (phones) put a
//     compact panel at the bottom.
//
// KEYS: Enter or Space ends the active unit's activation.
//
// The pure functions (computeLayout, buildViewModel, actionForClick...) are
// exported so they can be tested without a canvas. See battleUISelfTest().

import { CONFIG } from "./config.js";
import { getUnitType } from "./unitTypes.js";
import { statsAtLevel } from "./progression.js";
import { totalHealth } from "./battleRules.js";
import {
  getActiveUnit,
  getReachableCells,
  getAttackableTargets,
  getUpcomingOrder,
  listLivingUnits,
  getUnit,
} from "./battleGrid.js";

const DIRS = CONFIG.FACING.DIRECTIONS;
const VECTORS = CONFIG.FACING.VECTORS;

const THEME = {
  bg: "#12161c",
  panel: "#181e26",
  cellA: "#1d252f",
  cellB: "#222b36",
  gridLine: "#2e3946",
  text: "#e8edf3",
  muted: "#8b98a8",
  reachable: "rgba(79, 143, 247, 0.30)",
  reachableLine: "rgba(79, 143, 247, 0.75)",
  target: "rgba(239, 91, 91, 0.32)",
  targetLine: "#ef5b5b",
  active: "#ffd166",
  hover: "rgba(255, 255, 255, 0.10)",
  wound: "#ff5c5c",
  button: "#2a3544",
  buttonOn: "#3b82f6",
  buttonOff: "#1f2630",
  buttonText: "#e8edf3",
  buttonTextOff: "#5d6b7c",
};
const OWNER_COLORS = ["#4f8ff7", "#ef5b5b", "#3ecf8e", "#f5b83d"];
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ---------------------------------------------------------------
// Layout (pure)
// ---------------------------------------------------------------

const PAD = 12;
const BADGE_MARGIN = 14; // room above the top row for the unit-count numbers

// Splits the canvas into the grid area and the panel.
// Wide canvases: panel on the right. Narrow canvases: compact panel below.
export function computeLayout(canvasW, canvasH, gridW, gridH) {
  const wide = canvasW >= 720 && canvasW >= canvasH * 1.05;
  let panel;
  let areaW;
  let areaH;
  if (wide) {
    const panelW = Math.max(220, Math.min(300, Math.round(canvasW * 0.28)));
    panel = { x: canvasW - panelW, y: 0, w: panelW, h: canvasH };
    areaW = canvasW - panelW;
    areaH = canvasH;
  } else {
    const panelH = Math.max(150, Math.min(190, Math.round(canvasH * 0.28)));
    panel = { x: 0, y: canvasH - panelH, w: canvasW, h: panelH };
    areaW = canvasW;
    areaH = canvasH - panelH;
  }
  const availW = areaW - 2 * PAD;
  const availH = areaH - 2 * PAD - BADGE_MARGIN;
  const cell = Math.max(8, Math.floor(Math.min(availW / gridW, availH / gridH)));
  const gridX = PAD + Math.floor((availW - cell * gridW) / 2);
  const gridY = PAD + BADGE_MARGIN + Math.floor((availH - cell * gridH) / 2);
  return { mode: wide ? "side" : "bottom", cell, gridX, gridY, gridW, gridH, panel, width: canvasW, height: canvasH };
}

export function cellRect(layout, x, y) {
  return { x: layout.gridX + x * layout.cell, y: layout.gridY + y * layout.cell, w: layout.cell, h: layout.cell };
}

// Canvas pixel to grid cell, or null outside the grid.
export function pixelToCell(layout, px, py) {
  const cx = Math.floor((px - layout.gridX) / layout.cell);
  const cy = Math.floor((py - layout.gridY) / layout.cell);
  if (px < layout.gridX || py < layout.gridY || cx < 0 || cy < 0 || cx >= layout.gridW || cy >= layout.gridH) return null;
  return { x: cx, y: cy };
}

function inRect(r, px, py) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// Rectangles for the panel's parts.
export function layoutPanel(layout, showFacing) {
  const p = layout.panel;
  const x = p.x + PAD;
  const w = p.w - 2 * PAD;
  const gap = 6;
  const facingRects = (y, h) => {
    const bw = Math.floor((w - 3 * gap) / 4);
    const out = {};
    DIRS.forEach((d, i) => (out[d] = { x: x + i * (bw + gap), y, w: bw, h }));
    return out;
  };

  if (layout.mode === "side") {
    let y = p.y + PAD;
    const status = { x, y, w, h: 40 };
    y += 46;
    const chips = { x, y, size: 30, gap, max: Math.max(1, Math.floor((w + gap) / (30 + gap))) };
    y += 38;
    const info = { x, y, w, h: 96 };
    y += 104;
    const end = { x, y, w, h: 34 };
    y += 40;
    const sw = { x, y, w, h: 30 };
    y += 36;
    let facing = null;
    if (showFacing) {
      facing = facingRects(y, 28);
      y += 34;
    }
    const log = { x, y, w, h: Math.max(0, p.y + p.h - PAD - y) };
    return { status, chips, info, buttons: { end, switch: sw, facing }, log };
  }

  let y = p.y + 8;
  const status = { x, y, w, h: 22 };
  y += 26;
  const chips = { x, y, size: 24, gap: 5, max: Math.max(1, Math.floor((w + 5) / 29)) };
  y += 30;
  const endW = Math.floor(w * 0.42);
  const end = { x, y, w: endW, h: 32 };
  const sw = { x: x + endW + gap, y, w: w - endW - gap, h: 32 };
  y += 38;
  const facing = showFacing ? facingRects(y, 28) : null;
  return { status, chips, info: null, buttons: { end, switch: sw, facing }, log: null };
}

// ---------------------------------------------------------------
// View model (pure): everything the drawing code needs
// ---------------------------------------------------------------

// Stable colors per owner: the same owner always gets the same color.
export function assignOwnerColors(state) {
  const owners = [...new Set(state.units.map((u) => u.ownerId))].sort();
  const out = {};
  owners.forEach((o, i) => (out[o] = OWNER_COLORS[i % OWNER_COLORS.length]));
  return out;
}

export function unitCode(typeId) {
  const name = getUnitType(typeId).name;
  return name.slice(0, 2);
}

function ownerLabel(names, ownerId) {
  return (names && names[ownerId]) || String(ownerId);
}

// Can the active unit switch formation right now?
function canSwitchFormation(state, active) {
  if (!active || state.over) return false;
  const act = state.active;
  if (act.attacked || act.switched) return false;
  if (CONFIG.FORMATIONS.SWITCH_COSTS_TURN) return act.moveLeft === getUnitType(active.typeId).movePoints;
  return true;
}

export function buildViewModel({
  state,
  layout,
  localOwnerId = null,
  inputEnabled = true,
  pendingFacing = null,
  hoverCell = null,
  colors = null,
  names = {},
}) {
  const palette = colors || assignOwnerColors(state);
  const active = getActiveUnit(state);
  const canAct = !!active && !state.over && inputEnabled && active.ownerId === localOwnerId;

  const reachable = new Map();
  const targets = new Map();
  if (canAct) {
    for (const c of getReachableCells(state)) reachable.set(`${c.x},${c.y}`, c.cost);
    for (const t of getAttackableTargets(state)) targets.set(t.targetId, t);
  }

  const units = listLivingUnits(state).map((u) => ({
    id: u.id,
    ownerId: u.ownerId,
    x: u.x,
    y: u.y,
    color: palette[u.ownerId],
    code: unitCode(u.typeId),
    count: u.formation.count,
    formationType: u.formation.type,
    facing: u.formation.facing,
    wounded: u.carry > 0,
    isActive: !!active && active.id === u.id,
    isLocal: u.ownerId === localOwnerId,
  }));

  const order = getUpcomingOrder(state)
    .map((id) => getUnit(state, id))
    .map((u) => ({ id: u.id, color: palette[u.ownerId], code: unitCode(u.typeId), isActive: !!active && active.id === u.id }));

  const hoverUnit = hoverCell
    ? listLivingUnits(state).find((u) => u.x === hoverCell.x && u.y === hoverCell.y) || null
    : null;

  // Status line
  let status;
  if (state.over) {
    if (state.winnerOwnerId === null) status = "Draw";
    else if (state.winnerOwnerId === localOwnerId) status = "Victory!";
    else status = `${ownerLabel(names, state.winnerOwnerId)} wins`;
  } else if (!active) {
    status = "";
  } else if (canAct) {
    status = `Your move: ${getUnitType(active.typeId).name} (${active.formation.count})`;
  } else if (active.ownerId === localOwnerId) {
    status = "Please wait…";
  } else {
    status = `${ownerLabel(names, active.ownerId)} is moving…`;
  }

  // Buttons
  const showFacing = !!active && !state.over && active.formation.type === "line";
  const panelRects = layoutPanel(layout, showFacing && canAct);
  const buttons = [];
  const currentFacing = active ? active.formation.facing : "N";
  const chosen = pendingFacing || currentFacing;

  const endAction = { type: "end" };
  if (active && active.formation.type === "line" && chosen !== currentFacing) endAction.facing = chosen;
  buttons.push({
    id: "end",
    label: "End activation",
    rect: panelRects.buttons.end,
    enabled: canAct,
    selected: false,
    result: { kind: "action", action: endAction },
  });

  const otherFormation = active && active.formation.type === "square" ? "line" : "square";
  buttons.push({
    id: "switch",
    label: active ? `Switch to ${otherFormation}` : "Switch formation",
    rect: panelRects.buttons.switch,
    enabled: canAct && canSwitchFormation(state, active),
    selected: false,
    result: { kind: "action", action: { type: "switch", formation: otherFormation } },
  });

  if (panelRects.buttons.facing) {
    for (const d of DIRS) {
      buttons.push({
        id: `face_${d}`,
        label: d,
        rect: panelRects.buttons.facing[d],
        enabled: canAct,
        selected: d === chosen,
        result: { kind: "facing", facing: d },
      });
    }
  }

  return {
    layout,
    panelRects,
    status,
    canAct,
    active,
    units,
    order,
    reachable,
    targets,
    hoverCell,
    hoverUnit,
    buttons,
    colors: palette,
    pendingFacing: chosen,
    over: state.over,
  };
}

// What a click at (px, py) means. Returns null, or
//   { kind: "action", action }   send this action
//   { kind: "facing", facing }   only changes the facing you will end with
export function actionForClick(vm, px, py) {
  for (const b of vm.buttons) {
    if (inRect(b.rect, px, py)) return b.enabled ? b.result : null;
  }
  if (!vm.canAct) return null;
  const cell = pixelToCell(vm.layout, px, py);
  if (!cell) return null;
  const unit = vm.units.find((u) => u.x === cell.x && u.y === cell.y);
  if (unit) {
    return vm.targets.has(unit.id) ? { kind: "action", action: { type: "attack", targetId: unit.id } } : null;
  }
  if (vm.reachable.has(`${cell.x},${cell.y}`)) return { kind: "action", action: { type: "move", x: cell.x, y: cell.y } };
  return null;
}

// ---------------------------------------------------------------
// Drawing helpers
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

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function drawGrid(ctx, layout) {
  for (let y = 0; y < layout.gridH; y++) {
    for (let x = 0; x < layout.gridW; x++) {
      const r = cellRect(layout, x, y);
      ctx.fillStyle = (x + y) % 2 === 0 ? THEME.cellA : THEME.cellB;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  ctx.strokeStyle = THEME.gridLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(layout.gridX + 0.5, layout.gridY + 0.5, layout.cell * layout.gridW, layout.cell * layout.gridH);
}

function drawHighlights(ctx, vm) {
  const L = vm.layout;
  for (const key of vm.reachable.keys()) {
    const [x, y] = key.split(",").map(Number);
    const r = cellRect(L, x, y);
    ctx.fillStyle = THEME.reachable;
    ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.strokeStyle = THEME.reachableLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
  }
  if (vm.hoverCell && (vm.reachable.has(`${vm.hoverCell.x},${vm.hoverCell.y}`) || !vm.units.some((u) => u.x === vm.hoverCell.x && u.y === vm.hoverCell.y))) {
    const r = cellRect(L, vm.hoverCell.x, vm.hoverCell.y);
    ctx.fillStyle = THEME.hover;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

function drawUnit(ctx, vm, u) {
  const L = vm.layout;
  const r = cellRect(L, u.x, u.y);
  const inset = Math.max(2, Math.round(L.cell * 0.09));
  const x = r.x + inset;
  const y = r.y + inset;
  const w = r.w - 2 * inset;
  const h = r.h - 2 * inset;

  // Attackable target: red tint and outline under the body.
  if (vm.targets.has(u.id)) {
    ctx.fillStyle = THEME.target;
    ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }

  roundRect(ctx, x, y, w, h, L.cell * 0.16);
  ctx.fillStyle = u.color;
  ctx.fill();
  ctx.strokeStyle = vm.targets.has(u.id) ? THEME.targetLine : "rgba(0,0,0,0.45)";
  ctx.lineWidth = vm.targets.has(u.id) ? 3 : 1.5;
  ctx.stroke();

  if (u.isActive) {
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, L.cell * 0.19);
    ctx.strokeStyle = THEME.active;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Type code
  ctx.fillStyle = "#0e1217";
  ctx.font = font(L.cell * 0.32, "bold");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(u.code, x + w / 2, y + h / 2 + L.cell * 0.02);

  // Formation icon (bottom left): square = 2x2 blocks, line = two bars
  const ix = x + w * 0.1;
  const iy = y + h - h * 0.3;
  const is = Math.max(3, L.cell * 0.075);
  ctx.fillStyle = "rgba(14,18,23,0.85)";
  if (u.formationType === "square") {
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) ctx.fillRect(ix + a * (is + 1.5), iy + b * (is + 1.5), is, is);
  } else {
    ctx.fillRect(ix, iy, is * 2 + 1.5, is);
    ctx.fillRect(ix, iy + is + 1.5, is * 2 + 1.5, is);
  }

  // Facing bar (lines only; a square faces every side): a bright bar along
  // the edge the line's front points to. A bar, not an arrow, so the count
  // number above the unit's head never hides it.
  if (u.formationType === "line") {
    const f = VECTORS[u.isActive && vm.canAct && vm.pendingFacing ? vm.pendingFacing : u.facing];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const thick = Math.max(4, L.cell * 0.09);
    const len = L.cell * 0.62;
    const ex = cx + f.x * (w / 2 - thick / 2);
    const ey = cy + f.y * (h / 2 - thick / 2);
    ctx.fillStyle = "#f4f7fb";
    if (f.y !== 0) ctx.fillRect(ex - len / 2, ey - thick / 2, len, thick);
    else ctx.fillRect(ex - thick / 2, ey - len / 2, thick, len);
  }

  // Wound pip (top right)
  if (u.wounded) {
    ctx.beginPath();
    ctx.arc(x + w - L.cell * 0.12, y + L.cell * 0.12, Math.max(3, L.cell * 0.07), 0, Math.PI * 2);
    ctx.fillStyle = THEME.wound;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Small number above the unit's head: how many units are in the stack.
function drawCountBadge(ctx, vm, u) {
  const L = vm.layout;
  const r = cellRect(L, u.x, u.y);
  const text = String(u.count);
  ctx.font = font(Math.max(10, L.cell * 0.24), "bold");
  const tw = ctx.measureText(text).width;
  const bw = Math.max(L.cell * 0.34, tw + 8);
  const bh = Math.max(14, L.cell * 0.28);
  const bx = r.x + r.w / 2 - bw / 2;
  const by = r.y - bh * 0.55;
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  ctx.fillStyle = "#0b0e12";
  ctx.fill();
  ctx.strokeStyle = u.color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = THEME.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + bw / 2, by + bh / 2 + 0.5);
}

// Hit class and multiplier when hovering an attackable enemy.
function drawTargetLabel(ctx, vm, state) {
  const u = vm.hoverUnit;
  if (!u || !vm.targets.has(u.id)) return;
  const t = vm.targets.get(u.id);
  const L = vm.layout;
  const r = cellRect(L, u.x, u.y);
  const mult = CONFIG.COMBAT.ATTACK_MULTIPLIER[t.attackClass];
  const text = `${t.attackClass[0].toUpperCase()}${t.attackClass.slice(1)} ×${mult}%`;
  ctx.font = font(Math.max(10, L.cell * 0.22), "bold");
  const tw = ctx.measureText(text).width + 12;
  const bh = Math.max(16, L.cell * 0.3);
  let bx = r.x + r.w / 2 - tw / 2;
  bx = Math.max(L.gridX, Math.min(bx, L.gridX + L.cell * L.gridW - tw));
  const by = r.y + r.h - bh * 0.5;
  roundRect(ctx, bx, by, tw, bh, 4);
  ctx.fillStyle = t.attackClass === "front" ? "#3a4656" : t.attackClass === "side" ? "#9a6a12" : "#a32b2b";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + tw / 2, by + bh / 2 + 0.5);
}

function drawButton(ctx, b) {
  const r = b.rect;
  roundRect(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.fillStyle = !b.enabled ? THEME.buttonOff : b.selected ? THEME.buttonOn : THEME.button;
  ctx.fill();
  ctx.fillStyle = b.enabled ? THEME.buttonText : THEME.buttonTextOff;
  ctx.font = font(Math.min(14, r.h * 0.46), b.selected ? "bold" : "normal");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, b.label, r.w - 8), r.x + r.w / 2, r.y + r.h / 2 + 0.5);
}

function drawPanel(ctx, vm, state, logLines, names) {
  const L = vm.layout;
  const p = L.panel;
  const R = vm.panelRects;
  ctx.fillStyle = THEME.panel;
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = THEME.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (L.mode === "side") {
    ctx.moveTo(p.x + 0.5, p.y);
    ctx.lineTo(p.x + 0.5, p.y + p.h);
  } else {
    ctx.moveTo(p.x, p.y + 0.5);
    ctx.lineTo(p.x + p.w, p.y + 0.5);
  }
  ctx.stroke();

  // Status
  ctx.fillStyle = vm.canAct ? THEME.active : THEME.text;
  ctx.font = font(L.mode === "side" ? 16 : 15, "bold");
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const turnText = state.over ? "" : `Turn ${state.turn}`;
  ctx.fillText(fitText(ctx, vm.status, R.status.w), R.status.x, R.status.y);
  if (L.mode === "side" && turnText) {
    ctx.fillStyle = THEME.muted;
    ctx.font = font(12);
    ctx.fillText(turnText, R.status.x, R.status.y + 22);
  }

  // Turn order chips
  const c = R.chips;
  vm.order.slice(0, c.max).forEach((o, i) => {
    const x = c.x + i * (c.size + c.gap);
    roundRect(ctx, x, c.y, c.size, c.size, 5);
    ctx.fillStyle = o.color;
    ctx.fill();
    if (o.isActive) {
      ctx.strokeStyle = THEME.active;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.fillStyle = "#0e1217";
    ctx.font = font(c.size * 0.4, "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.code, x + c.size / 2, c.y + c.size / 2 + 0.5);
  });

  // Details of the hovered unit, otherwise the active one
  if (R.info) {
    const u = vm.hoverUnit || vm.active;
    if (u && u.formation) {
      const type = getUnitType(u.typeId);
      const stats = statsAtLevel(u.typeId, u.level);
      const count = u.formation.count;
      const hp = totalHealth(u);
      const lines = [
        `${type.name} · Lv ${u.level} · ${names[u.ownerId] || u.ownerId}`,
        `Units ${count} · HP ${hp}/${count * stats.health}`,
        `Damage ${stats.damageMin}-${stats.damageMax} · Range ${type.attackRange}`,
        `${u.formation.type[0].toUpperCase()}${u.formation.type.slice(1)}${u.formation.type === "line" ? ` facing ${u.formation.facing}` : ""} · Speed ${type.speed}`,
        u.carry > 0 ? `Wounded: ${u.carry} damage` : "No wounds",
      ];
      ctx.font = font(12);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? THEME.text : i === 4 && u.carry > 0 ? THEME.wound : THEME.muted;
        ctx.font = font(12, i === 0 ? "bold" : "normal");
        ctx.fillText(fitText(ctx, line, R.info.w), R.info.x, R.info.y + i * 18);
      });
    }
  }

  for (const b of vm.buttons) drawButton(ctx, b);

  // Log
  if (R.log && R.log.h > 20) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(R.log.x, R.log.y, R.log.w, R.log.h);
    ctx.clip();
    ctx.font = font(11);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    // Newest at the bottom; wrap lines and keep what fits.
    const wrapped = [];
    for (const line of logLines) for (const w of wrapText(ctx, line, R.log.w, 3)) wrapped.push(w);
    const lineH = 14;
    const fit = Math.floor(R.log.h / lineH);
    const shown = wrapped.slice(-fit);
    shown.forEach((line, i) => {
      ctx.fillStyle = THEME.muted;
      ctx.fillText(line, R.log.x, R.log.y + i * lineH);
    });
    ctx.restore();
  }
}

function drawFloaters(ctx, layout, floaters) {
  for (const f of floaters) {
    const t = f.age / f.ttl;
    const alpha = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
    ctx.globalAlpha = alpha;
    ctx.font = font(Math.max(13, layout.cell * 0.3), "bold");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const y = f.y - t * layout.cell * 0.7;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.strokeText(f.text, f.x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, y);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------
// The UI object
// ---------------------------------------------------------------

export function createBattleUI({ canvas, state, localOwnerId = null, ownerNames = {}, onAction = () => {}, width, height, dpr = 1 }) {
  const ctx = canvas.getContext("2d");
  let S = state;
  let local = localOwnerId;
  let names = ownerNames;
  let enabled = true;
  let busy = false;
  let hoverCell = null;
  let pendingFacing = null;
  let pendingKey = null;
  const floaters = [];
  const logLines = [];
  let size = { w: width ?? canvas.width, h: height ?? canvas.height };
  let layout = computeLayout(size.w, size.h, S.width, S.height);
  let colors = assignOwnerColors(S);
  let frame = null;
  let lastTime = null;
  let destroyed = false;

  function applySize() {
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    if (canvas.style) {
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout = computeLayout(size.w, size.h, S.width, S.height);
  }
  applySize();

  function currentVM() {
    const active = getActiveUnit(S);
    const key = active ? `${S.turn}:${active.id}` : null;
    if (key !== pendingKey) {
      pendingKey = key;
      pendingFacing = active ? active.formation.facing : null;
    }
    return buildViewModel({
      state: S,
      layout,
      localOwnerId: local,
      inputEnabled: enabled && !busy,
      pendingFacing,
      hoverCell,
      colors,
      names,
    });
  }

  function render() {
    if (destroyed) return;
    const vm = currentVM();
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    drawGrid(ctx, layout);
    drawHighlights(ctx, vm);
    // Units first, then all badges so no tile covers another unit's number.
    for (const u of vm.units) drawUnit(ctx, vm, u);
    for (const u of vm.units) drawCountBadge(ctx, vm, u);
    drawTargetLabel(ctx, vm, S);
    drawFloaters(ctx, layout, floaters);
    // The panel needs full unit objects for details.
    drawPanel(ctx, vmWithUnits(vm), S, logLines, names);
  }

  // drawPanel wants the full combatant for details, not the slim view unit.
  function vmWithUnits(vm) {
    return {
      ...vm,
      active: vm.active,
      hoverUnit: vm.hoverUnit,
    };
  }

  function startLoop() {
    if (frame !== null || typeof requestAnimationFrame !== "function" || destroyed) return;
    const step = (now) => {
      frame = null;
      if (destroyed) return;
      const dt = lastTime === null ? 16 : Math.min(60, now - lastTime);
      lastTime = now;
      tick(dt);
      if (floaters.length > 0) frame = requestAnimationFrame(step);
      else lastTime = null;
    };
    frame = requestAnimationFrame(step);
  }

  // Advances floating numbers by dt milliseconds and redraws.
  function tick(dt) {
    for (const f of floaters) f.age += dt;
    for (let i = floaters.length - 1; i >= 0; i--) if (floaters[i].age >= floaters[i].ttl) floaters.splice(i, 1);
    render();
  }

  function pushLog(line) {
    logLines.push(line);
    while (logLines.length > 12) logLines.shift();
  }

  function unitName(u) {
    return `${getUnitType(u.typeId).name} (${names[u.ownerId] || u.ownerId})`;
  }

  function addFloater(unit, text, color) {
    const r = cellRect(layout, unit.x, unit.y);
    floaters.push({ x: r.x + r.w / 2, y: r.y + r.h * 0.62, text, color, age: 0, ttl: 1300 });
  }

  // Animate and log one attack. Call it after setState() with the report
  // that battleGrid.attackActive() returned.
  function showAttack({ attackerId, targetId, report }) {
    const attacker = getUnit(S, attackerId);
    const target = getUnit(S, targetId);
    if (!attacker || !target || !report) return;
    const s = report.strike;
    let line = `${unitName(attacker)} hit ${unitName(target)} (${report.attackClass} ×${s.multiplierPercent}%): ${s.damage} damage, ${s.killed} lost.`;
    addFloater(target, s.killed > 0 ? `-${s.damage}  (${s.killed} lost)` : `-${s.damage}`, "#ff8a8a");
    if (report.counter) {
      const c = report.counter;
      line += ` Counter: ${c.damage} damage, ${c.killed} lost.`;
      addFloater(attacker, c.killed > 0 ? `-${c.damage}  (${c.killed} lost)` : `-${c.damage}`, "#ffc266");
    }
    pushLog(line);
    startLoop();
    render();
  }

  function emit(result) {
    if (result.kind === "facing") {
      pendingFacing = result.facing;
      render();
      return null;
    }
    busy = true;
    render();
    onAction(result.action);
    return result.action;
  }

  // Pointer position in canvas CSS pixels.
  function toCanvasPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width ? size.w / rect.width : 1;
    const sy = rect.height ? size.h / rect.height : 1;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }

  function handleClick(px, py) {
    if (destroyed || busy || !enabled || S.over) return null;
    const result = actionForClick(currentVM(), px, py);
    return result ? emit(result) : null;
  }

  function handleHover(px, py) {
    const cell = pixelToCell(layout, px, py);
    const same = (!cell && !hoverCell) || (cell && hoverCell && cell.x === hoverCell.x && cell.y === hoverCell.y);
    if (same) return;
    hoverCell = cell;
    render();
  }

  const onDown = (ev) => {
    const p = toCanvasPoint(ev);
    handleClick(p.x, p.y);
  };
  const onMove = (ev) => {
    const p = toCanvasPoint(ev);
    handleHover(p.x, p.y);
  };
  const onLeave = () => {
    hoverCell = null;
    render();
  };
  const onKey = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      const vm = currentVM();
      const end = vm.buttons.find((b) => b.id === "end");
      if (end && end.enabled && !busy) {
        ev.preventDefault();
        emit(end.result);
      }
    }
  };

  if (canvas.addEventListener) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
  }
  if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("keydown", onKey);

  render();

  return {
    // Give the UI a new battle state (after any action was applied).
    setState(next) {
      S = next;
      busy = false;
      colors = assignOwnerColors(S);
      layout = computeLayout(size.w, size.h, S.width, S.height);
      render();
    },
    showAttack,
    // Which owner this player controls (null = spectator).
    setLocalOwner(ownerId) {
      local = ownerId;
      render();
    },
    setOwnerNames(map) {
      names = map;
      render();
    },
    // Turn input off while an AI, an animation or the opponent is playing.
    setInputEnabled(value) {
      enabled = !!value;
      render();
    },
    resize(w, h, ratio = 1) {
      size = { w, h };
      dpr = ratio;
      applySize();
      render();
    },
    log: pushLog,
    render,
    tick,
    // For tests and custom input: same as the real pointer events.
    handleClick,
    handleHover,
    getViewModel: currentVM,
    destroy() {
      destroyed = true;
      if (canvas.removeEventListener) {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
      }
      if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("keydown", onKey);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    },
  };
}

// ---------------------------------------------------------------
// Self test (pure parts only; no canvas needed)
//   import("./rng.js").then(m => battleUISelfTest())
// ---------------------------------------------------------------

import { createArmy, addStack } from "./army.js";
import { createBattle, placeUnit, moveActive, attackActive } from "./battleGrid.js";
import { createRng } from "./rng.js";

export function battleUISelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`battleUISelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const mkArmy = (id, ownerId, facing, stacks) => {
    let army = createArmy({ id, ownerId, facing });
    for (const spec of stacks) army = addStack(army, spec, { nextId: () => spec.id, enforceLimits: false }).army;
    return army;
  };

  // Layout
  for (const [w, h] of [[960, 560], [420, 700], [1280, 720], [360, 640]]) {
    const L = computeLayout(w, h, 10, 8);
    eq(L.cell >= 8, true, `cell size ${w}x${h}`);
    eq(L.gridX >= 0 && L.gridY >= 0, true, `grid inside canvas ${w}x${h}`);
    eq(L.gridX + L.cell * 10 <= (L.mode === "side" ? L.panel.x : w), true, `grid clear of panel ${w}x${h}`);
    eq(L.gridY + L.cell * 8 <= (L.mode === "side" ? h : L.panel.y), true, `grid above panel ${w}x${h}`);
    const mid = cellRect(L, 3, 2);
    eq(pixelToCell(L, mid.x + mid.w / 2, mid.y + mid.h / 2), { x: 3, y: 2 }, `pixel round trip ${w}x${h}`);
    eq(pixelToCell(L, L.gridX - 1, L.gridY + 1), null, `outside grid ${w}x${h}`);
  }
  eq(computeLayout(960, 560, 10, 8).mode, "side", "wide uses a side panel");
  eq(computeLayout(420, 700, 10, 8).mode, "bottom", "narrow uses a bottom panel");

  // A battle: attacker p1 (swordsman square + spearman line) hits p2 from the south
  const a = mkArmy("A", "p1", "N", [
    { id: "s1", typeId: "swordsman", count: 6, formationType: "square" },
    { id: "l1", typeId: "archer", count: 4, formationType: "line" },
  ]);
  const d = mkArmy("B", "p2", "N", [{ id: "e1", typeId: "spearman", count: 5, formationType: "line" }]);
  let b = createBattle({ id: "ui", attackerArmy: a, defenderArmy: d, hitFromSide: "S" });
  b = placeUnit(placeUnit(b, "e1", 3, 1), "s1", 4, 3);
  const L = computeLayout(960, 560, b.width, b.height);

  // It is p1's turn (first strike), so p1 can act and p2 cannot
  let vm = buildViewModel({ state: b, layout: L, localOwnerId: "p1" });
  eq(vm.canAct, true, "local owner can act");
  eq(vm.status.startsWith("Your move"), true, "status for the local player");
  eq(vm.reachable.size > 0, true, "reachable squares shown");
  eq([...vm.targets.keys()], [], "nothing attackable yet");
  eq(buildViewModel({ state: b, layout: L, localOwnerId: "p2" }).canAct, false, "opponent cannot act");
  eq(buildViewModel({ state: b, layout: L, localOwnerId: "p1", inputEnabled: false }).canAct, false, "input can be disabled");
  eq(vm.units.find((u) => u.id === "s1").count, 6, "unit count for the badge");
  eq(vm.order[0].id, "s1", "order starts with the active unit");

  // Clicking a reachable square moves
  const target = [...vm.reachable.keys()][0].split(",").map(Number);
  const tr = cellRect(L, target[0], target[1]);
  eq(actionForClick(vm, tr.x + 5, tr.y + 5), { kind: "action", action: { type: "move", x: target[0], y: target[1] } }, "click to move");
  // Clicking a square that is not reachable does nothing
  const far = cellRect(L, 9, 0);
  eq(actionForClick(vm, far.x + 5, far.y + 5), null, "unreachable square");
  // Opponent view: clicks do nothing
  const vmOpp = buildViewModel({ state: b, layout: L, localOwnerId: "p2" });
  eq(actionForClick(vmOpp, tr.x + 5, tr.y + 5), null, "no clicks on the opponent's turn");

  // Move next to the enemy and attack by clicking
  const moved = moveActive(b, 3, 2);
  eq(moved.ok, true, "move applied by the controller");
  vm = buildViewModel({ state: moved.state, layout: L, localOwnerId: "p1" });
  eq([...vm.targets.keys()], ["e1"], "enemy attackable");
  eq(vm.targets.get("e1").attackClass, "rear", "rear attack shown");
  const er = cellRect(L, 3, 1);
  eq(actionForClick(vm, er.x + er.w / 2, er.y + er.h / 2), { kind: "action", action: { type: "attack", targetId: "e1" } }, "click to attack");
  // Own unit is not a target
  const own = cellRect(L, moved.state.units.find((u) => u.id === "l1").x, moved.state.units.find((u) => u.id === "l1").y);
  eq(actionForClick(vm, own.x + own.w / 2, own.y + own.h / 2), null, "own unit is not clickable");

  // Buttons: switch is disabled after moving (it must be the only action)
  const sw = vm.buttons.find((x) => x.id === "switch");
  eq(sw.enabled, false, "switch disabled after moving");
  const swFresh = buildViewModel({ state: b, layout: L, localOwnerId: "p1" }).buttons.find((x) => x.id === "switch");
  eq(swFresh.enabled, true, "switch enabled at the start of the activation");
  eq(swFresh.result.action, { type: "switch", formation: "line" }, "switch offers the other formation");
  const endBtn = vm.buttons.find((x) => x.id === "end");
  eq(actionForClick(vm, endBtn.rect.x + 3, endBtn.rect.y + 3), { kind: "action", action: { type: "end" } }, "end button");

  // Lines get facing buttons and send the chosen facing when ending
  const lineBattle = createBattle({ id: "ui2", attackerArmy: mkArmy("A", "p1", "N", [{ id: "l1", typeId: "spearman", count: 4, formationType: "line" }]), defenderArmy: d, hitFromSide: "S" });
  const L2 = computeLayout(960, 560, lineBattle.width, lineBattle.height);
  const vmLine = buildViewModel({ state: lineBattle, layout: L2, localOwnerId: "p1", pendingFacing: "E" });
  eq(vmLine.buttons.filter((x) => x.id.startsWith("face_")).length, 4, "four facing buttons for a line");
  eq(vmLine.buttons.find((x) => x.id === "face_E").selected, true, "chosen facing selected");
  eq(vmLine.buttons.find((x) => x.id === "end").result.action, { type: "end", facing: "E" }, "end carries the chosen facing");
  const fb = vmLine.buttons.find((x) => x.id === "face_W").rect;
  eq(actionForClick(vmLine, fb.x + 2, fb.y + 2), { kind: "facing", facing: "W" }, "facing button changes only the UI");
  eq(vm.buttons.filter((x) => x.id.startsWith("face_")).length, 0, "no facing buttons for a square");

  // Finished battle
  const over = { ...b, over: true, winnerOwnerId: "p1", active: null };
  eq(buildViewModel({ state: over, layout: L, localOwnerId: "p1" }).status, "Victory!", "victory text");
  eq(buildViewModel({ state: over, layout: L, localOwnerId: "p2", names: { p1: "Ana" } }).status, "Ana wins", "defeat text");
  eq(buildViewModel({ state: over, layout: L, localOwnerId: "p1" }).canAct, false, "no actions after the end");

  // Colors are stable per owner
  eq(assignOwnerColors(b), { p1: OWNER_COLORS[0], p2: OWNER_COLORS[1] }, "owner colors");

  // An attack result can be shown (uses a fake canvas context)
  const noop = new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true });
  const fakeCanvas = { width: 960, height: 560, getContext: () => noop };
  let emitted = null;
  const ui = createBattleUI({ canvas: fakeCanvas, state: moved.state, localOwnerId: "p1", onAction: (x) => (emitted = x) });
  eq(ui.handleClick(er.x + er.w / 2, er.y + er.h / 2), { type: "attack", targetId: "e1" }, "ui emits the attack");
  eq(emitted, { type: "attack", targetId: "e1" }, "onAction called");
  eq(ui.handleClick(er.x + er.w / 2, er.y + er.h / 2), null, "ignores input until the next state");
  const res = attackActive(moved.state, "e1", createRng("ui"));
  ui.setState(res.state);
  ui.showAttack({ attackerId: "s1", targetId: "e1", report: res.report });
  ui.tick(500);
  ui.tick(2000);
  ui.destroy();

  return true;
}

export default {
  computeLayout,
  cellRect,
  pixelToCell,
  layoutPanel,
  buildViewModel,
  actionForClick,
  assignOwnerColors,
  createBattleUI,
  battleUISelfTest,
};
