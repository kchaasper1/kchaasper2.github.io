// battleViewer.js
// Lets players WATCH battles they are not playing: small popups over the
// overworld, one per battle, that can be minimized to a strip and restored,
// scrubbed back and forth, and followed live. Watching is read-only: a
// popup can never send an action.
//
// ---------------------------------------------------------------
// HOW IT WORKS
// ---------------------------------------------------------------
//  Every battle is recorded by turnResolver.js as its starting state plus
//  the list of actions (battle.initial and battle.actions). The viewer only
//  needs that: it replays the actions with the battle's own random stream,
//  so what a spectator sees is exactly what the fighters saw. New actions
//  arrive whenever you call viewer.sync(game) with the latest game.
//
//  A BATTLE FEED (createBattleFeed) holds the replayed states of one battle
//  and a playback position. It plays at STEP_MS per action toward the live
//  end, so a watcher who opens a busy battle sees it unfold; "pause", step
//  back/forward and "LIVE" work as you would expect. A late watcher starts
//  at the live end, not at the beginning.
//
//  THE WINDOW MANAGER (pure functions on a plain layout state) decides where
//  popups go: near the battle's spot on the map without covering it when
//  there is room, never on top of another popup when avoidable, always inside
//  the screen, and at most MAX_OPEN_WINDOWS open at once (opening one more
//  minimizes the oldest). Minimized battles wait as chips in a strip at the
//  bottom; a chip shows a dot when something happened while it was minimized.
//
//  THE VIEWER (createBattleViewer) joins the two to the page: it builds the
//  popups as small DOM windows around a battleUI canvas in compact mode,
//  wires the buttons (step back, play/pause, step forward, LIVE, minimize,
//  close), lets popups be dragged by their title, and keeps playback going
//  while a popup is minimized.
//
// WHO MAY WATCH: CONFIG.OBSERVERS.WHO_CAN_WATCH (see canWatch). Watching an
//  enemy battle reveals their army, so you may want to restrict it.
//
// USAGE
//   const viewer = createBattleViewer({
//     container,                 // a positioned element over the overworld
//     viewerOwnerId: "p1",       // who is watching (null = a pure spectator)
//     ownerNames: { p1: "You", p2: "Ana" },
//     getAnchor: (battle, game) => ({ x, y }) // screen position of the battle
//     onChange: () => redraw markers,
//   });
//   viewer.sync(game);                 // after every game update
//   viewer.getMarkers();               // battle icons for the overworld map
//   viewer.toggle(battleId);           // open / minimize / restore (marker click)
//   viewer.resize(width, height);      // when the container changes size
//   viewer.destroy();
//   battleWorldPosition(game, battle)  // where on the map a battle is
//                                      // (overworld sub-tiles), for getAnchor
//
// No DOM is needed for the pure parts: createBattleFeed, canWatch, the
// window-manager functions and battleWorldPosition.

import { CONFIG } from "./config.js";
import { createMatchStreams } from "./rng.js";
import { applyBattleAction } from "./battleGrid.js";
import { createBattleUI } from "./battleUI.js";

const O = CONFIG.OBSERVERS;

if (!["everyone", "not_involved", "eliminated_only", "none"].includes(O.WHO_CAN_WATCH)) {
  throw new Error(`battleViewer: bad WHO_CAN_WATCH "${O.WHO_CAN_WATCH}"`);
}

// ---------------------------------------------------------------
// Who may watch
// ---------------------------------------------------------------

// May this player watch this battle? viewerOwnerId null means a pure
// spectator (not a player).
export function canWatch(game, viewerOwnerId, battle) {
  switch (O.WHO_CAN_WATCH) {
    case "none":
      return false;
    case "everyone":
      return true;
    case "not_involved":
      return viewerOwnerId === null || ![battle.meta.attackerOwnerId, battle.meta.defenderOwnerId].includes(viewerOwnerId);
    case "eliminated_only":
      return viewerOwnerId !== null && game.eliminated.includes(viewerOwnerId);
    default:
      return false;
  }
}

// Where on the overworld a battle is happening: the middle of the two
// fighters, in overworld sub-tiles, or null if neither can be found. Convert
// it to screen pixels in your overworld UI.
export function battleWorldPosition(game, battle) {
  const find = (id) => {
    const a = game.world.armies.find((x) => x.id === id);
    if (a) return { x: a.x, y: a.y };
    const m = game.monsters.find((x) => x.id === id);
    return m ? { x: m.x, y: m.y } : null;
  };
  const pts = [find(battle.meta.attackerArmyId), find(battle.meta.defenderArmyId)].filter(Boolean);
  if (pts.length === 0) return null;
  return {
    x: Math.floor(pts.reduce((n, p) => n + p.x, 0) / pts.length),
    y: Math.floor(pts.reduce((n, p) => n + p.y, 0) / pts.length),
  };
}

// ---------------------------------------------------------------
// Battle feed: replay and playback of one battle
// ---------------------------------------------------------------

// seed     the match seed (game.seed)
// record   a battle record: { id, initial, actions, ... }
// A new feed starts at the live end (or at the start with startAtLive false).
export function createBattleFeed({ seed, record, delayActions = O.DELAY_ACTIONS, stepMs = O.STEP_MS, startAtLive = true }) {
  const rng = createMatchStreams(seed).battle(record.id);
  const states = [record.initial];
  const steps = []; // { action, report } for each applied action
  let index = 0;
  let playing = true;
  let acc = 0;
  let error = null;

  const target = () => Math.max(0, steps.length - delayActions);

  // Applies any actions of `rec` the feed has not seen yet. Returns how many.
  function sync(rec) {
    if (error) return 0;
    let added = 0;
    for (let i = steps.length; i < rec.actions.length; i++) {
      const action = rec.actions[i];
      const res = applyBattleAction(states[states.length - 1], action, rng);
      if (!res.ok) {
        error = `Could not replay action ${i + 1}: ${res.reason}`;
        break;
      }
      states.push(res.state);
      steps.push({ action, report: res.report || null });
      added++;
    }
    return added;
  }
  sync(record);
  if (startAtLive) index = target();

  const shown = (i) => ({ index: i, action: steps[i - 1].action, report: steps[i - 1].report });

  return {
    id: record.id,
    sync,
    // Advances the playback by dtMs. Returns the actions that were just
    // shown: [{ index, action, report }] (for floating numbers and sounds).
    tick(dtMs) {
      const out = [];
      if (!playing || index >= target()) {
        acc = 0;
        return out;
      }
      acc += dtMs;
      while (acc >= stepMs && index < target()) {
        acc -= stepMs;
        index++;
        out.push(shown(index));
      }
      return out;
    },
    pause() {
      playing = false;
    },
    play() {
      playing = true;
    },
    togglePlay() {
      playing = !playing;
      return playing;
    },
    // One action forward or back. Pauses playback. Returns the action shown
    // when stepping forward, otherwise null.
    stepForward() {
      playing = false;
      if (index >= target()) return null;
      index++;
      return shown(index);
    },
    stepBack() {
      playing = false;
      index = Math.max(0, index - 1);
      return null;
    },
    goTo(i) {
      playing = false;
      index = Math.min(target(), Math.max(0, i));
    },
    // Jump to the live end and keep following.
    goLive() {
      index = target();
      playing = true;
      acc = 0;
    },
    get state() {
      return states[index];
    },
    get index() {
      return index;
    },
    get total() {
      return steps.length;
    },
    get liveIndex() {
      return target();
    },
    get playing() {
      return playing;
    },
    get behind() {
      return target() - index;
    },
    get over() {
      return states[index].over;
    },
    get winnerOwnerId() {
      return states[index].winnerOwnerId;
    },
    get error() {
      return error;
    },
  };
}

// ---------------------------------------------------------------
// Window manager (pure)
// ---------------------------------------------------------------
// state: { width, height, windows: [{ battleId, mode, rect, z }], nextZ }
//   mode "open" | "minimized". Windows are listed in the order they were
//   first opened.

const MARGIN = 8;
const CHIP_H = 28;
const CHIP_GAP = 6;

export function createViewerState({ width, height }) {
  return { width, height, windows: [], nextZ: 1 };
}

function windowSize(vs) {
  const w = Math.max(200, Math.min(O.WINDOW_WIDTH, vs.width - 2 * MARGIN));
  const h = Math.max(160, Math.min(O.WINDOW_HEIGHT, vs.height - O.TRAY_HEIGHT - 2 * MARGIN));
  return { w, h };
}

function clampRect(r, vs) {
  const maxX = Math.max(MARGIN, vs.width - r.w - MARGIN);
  const maxY = Math.max(MARGIN, vs.height - O.TRAY_HEIGHT - r.h - MARGIN);
  return { x: Math.round(Math.min(maxX, Math.max(MARGIN, r.x))), y: Math.round(Math.min(maxY, Math.max(MARGIN, r.y))), w: r.w, h: r.h };
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// A place for a new window near `anchor` (screen pixels): above the anchor
// so the battle stays visible, else below, right, left, else a cascade.
function findSpot(vs, size, anchor) {
  const open = vs.windows.filter((w) => w.mode === "open").map((w) => w.rect);
  const gap = 24;
  const tries = [
    { x: anchor.x - size.w / 2, y: anchor.y - size.h - gap },
    { x: anchor.x - size.w / 2, y: anchor.y + gap },
    { x: anchor.x + gap, y: anchor.y - size.h / 2 },
    { x: anchor.x - size.w - gap, y: anchor.y - size.h / 2 },
  ];
  for (const t of tries) {
    const r = clampRect({ ...t, w: size.w, h: size.h }, vs);
    if (!open.some((o) => rectsOverlap(o, r))) return r;
  }
  for (let k = 1; k <= 12; k++) {
    const r = clampRect({ x: tries[0].x + 28 * k, y: tries[0].y + 28 * k, w: size.w, h: size.h }, vs);
    if (!open.some((o) => rectsOverlap(o, r))) return r;
  }
  return clampRect({ ...tries[0], w: size.w, h: size.h }, vs);
}

function withWindows(vs, windows, extra = {}) {
  return { ...vs, windows, ...extra };
}

// Keeps at most MAX_OPEN_WINDOWS open: the oldest ones are minimized.
function enforceMaxOpen(vs, keepId) {
  let windows = vs.windows;
  for (;;) {
    const open = windows.filter((w) => w.mode === "open" && w.battleId !== keepId);
    if (windows.filter((w) => w.mode === "open").length <= O.MAX_OPEN_WINDOWS || open.length === 0) break;
    const oldest = open.reduce((a, b) => (a.z <= b.z ? a : b));
    windows = windows.map((w) => (w.battleId === oldest.battleId ? { ...w, mode: "minimized" } : w));
  }
  return withWindows(vs, windows);
}

// Opens a battle's popup (or restores and raises it). anchor is the battle's
// position on screen; it defaults to the middle of the container.
export function openBattle(vs, battleId, anchor = { x: vs.width / 2, y: vs.height / 2 }) {
  const existing = vs.windows.find((w) => w.battleId === battleId);
  let next;
  if (existing) {
    const rect = existing.mode === "minimized" ? clampRect(existing.rect, vs) : existing.rect;
    next = withWindows(
      vs,
      vs.windows.map((w) => (w.battleId === battleId ? { ...w, mode: "open", rect, z: vs.nextZ } : w)),
      { nextZ: vs.nextZ + 1 }
    );
  } else {
    const size = windowSize(vs);
    const rect = findSpot(vs, size, anchor);
    next = withWindows(vs, vs.windows.concat([{ battleId, mode: "open", rect, z: vs.nextZ }]), { nextZ: vs.nextZ + 1 });
  }
  return enforceMaxOpen(next, battleId);
}

export function minimizeBattle(vs, battleId) {
  return withWindows(vs, vs.windows.map((w) => (w.battleId === battleId ? { ...w, mode: "minimized" } : w)));
}

export function restoreBattle(vs, battleId) {
  const w = vs.windows.find((x) => x.battleId === battleId);
  return w ? openBattle(vs, battleId) : vs;
}

export function closeBattle(vs, battleId) {
  return withWindows(vs, vs.windows.filter((w) => w.battleId !== battleId));
}

// Clicking a battle marker: open it, or minimize it if it is open, or
// restore it if it is minimized.
export function toggleBattle(vs, battleId, anchor) {
  const w = vs.windows.find((x) => x.battleId === battleId);
  if (!w) return openBattle(vs, battleId, anchor);
  return w.mode === "open" ? minimizeBattle(vs, battleId) : openBattle(vs, battleId);
}

export function bringToFront(vs, battleId) {
  return withWindows(vs, vs.windows.map((w) => (w.battleId === battleId ? { ...w, z: vs.nextZ } : w)), { nextZ: vs.nextZ + 1 });
}

// Moves a window (dragging by its title), kept inside the container.
export function moveWindow(vs, battleId, x, y) {
  return withWindows(vs, vs.windows.map((w) => (w.battleId === battleId ? { ...w, rect: clampRect({ ...w.rect, x, y }, vs) } : w)));
}

// The container changed size: windows shrink and slide to stay inside.
export function resizeContainer(vs, width, height) {
  const next = { ...vs, width, height };
  const size = windowSize(next);
  return withWindows(next, next.windows.map((w) => ({ ...w, rect: clampRect({ ...w.rect, w: size.w, h: size.h }, next) })));
}

// Open windows, back to front.
export function getOpenWindows(vs) {
  return vs.windows.filter((w) => w.mode === "open").sort((a, b) => a.z - b.z);
}

// The strip of minimized battles: [{ battleId, rect }] along the bottom.
export function getTray(vs) {
  const mins = vs.windows.filter((w) => w.mode === "minimized");
  if (mins.length === 0) return [];
  const chipW = Math.max(60, Math.min(150, Math.floor((vs.width - 2 * MARGIN - (mins.length - 1) * CHIP_GAP) / mins.length)));
  const y = vs.height - CHIP_H - MARGIN / 2;
  return mins.map((w, i) => ({ battleId: w.battleId, rect: { x: MARGIN + i * (chipW + CHIP_GAP), y, w: chipW, h: CHIP_H } }));
}

// ---------------------------------------------------------------
// The viewer (DOM)
// ---------------------------------------------------------------

const HEADER_H = 60; // title row + controls row

const STYLE = {
  win: "position:absolute;box-sizing:border-box;background:#181e26;border:1px solid #3a4756;border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.45);overflow:hidden;font:12px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e8edf3;",
  head: "display:flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 10px;background:#222b36;cursor:move;user-select:none;touch-action:none;",
  title: "flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  controls: "display:flex;align-items:center;gap:4px;height:30px;padding:0 6px;background:#1d242d;",
  status: "flex:1;text-align:right;color:#8b98a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  button: "min-width:28px;height:24px;padding:0 6px;border:0;border-radius:5px;background:#2a3544;color:#e8edf3;font:inherit;cursor:pointer;",
  chip: "position:absolute;box-sizing:border-box;border:1px solid #3a4756;border-radius:14px;background:#222b36;color:#e8edf3;font:12px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 10px;",
};

function px(n) {
  return `${Math.round(n)}px`;
}

export function createBattleViewer({
  container,
  viewerOwnerId = null,
  ownerNames = {},
  getAnchor = () => null,
  onChange = () => {},
  document: doc = typeof document !== "undefined" ? document : null,
  width,
  height,
}) {
  if (!doc) throw new Error("battleViewer: needs a document");
  if (container.style && !container.style.position) container.style.position = "relative";

  let seed = null;
  let game = null;
  let destroyed = false;
  let vs = createViewerState({
    width: width ?? (container.clientWidth || 800),
    height: height ?? (container.clientHeight || 600),
  });
  const feeds = new Map(); // battleId -> feed
  const records = new Map(); // battleId -> battle record (latest)
  const windows = new Map(); // battleId -> { root, canvas, ui, parts }
  const chips = new Map(); // battleId -> button
  const unread = new Set();
  let layer = null;
  let frame = null;
  let lastTime = null;

  function el(tag, style, attrs = {}) {
    const e = doc.createElement(tag);
    if (style) e.style.cssText = style;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  layer = el("div", "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;");
  layer.setAttribute("data-battle-viewer", "");
  container.appendChild(layer);

  // ----- names and text -----
  const name = (ownerId) => ownerNames[ownerId] || String(ownerId);
  function titleOf(record) {
    return `${name(record.meta.attackerOwnerId)} vs ${name(record.meta.defenderOwnerId)}`;
  }
  function statusOf(feed) {
    if (feed.error) return "Cannot replay";
    if (feed.over) return feed.winnerOwnerId === null ? "Finished: draw" : `Finished: ${name(feed.winnerOwnerId)} won`;
    if (feed.behind > 0) return `Catching up (${feed.behind})`;
    if (feed.index < feed.liveIndex) return `Replay ${feed.index}/${feed.liveIndex}`;
    return `Live · turn ${feed.state.turn}`;
  }

  // ----- window DOM -----
  function buildWindow(battleId) {
    const root = el("div", STYLE.win + "pointer-events:auto;", { role: "dialog", "aria-label": "Battle viewer" });
    const head = el("div", STYLE.head);
    const title = el("span", STYLE.title);
    const minimize = el("button", STYLE.button, { type: "button", "data-act": "minimize", "aria-label": "Minimize battle", title: "Minimize" });
    minimize.textContent = "—";
    const close = el("button", STYLE.button, { type: "button", "data-act": "close", "aria-label": "Close battle", title: "Close" });
    close.textContent = "✕";
    head.append(title, minimize, close);

    const controls = el("div", STYLE.controls);
    const back = el("button", STYLE.button, { type: "button", "data-act": "back", "aria-label": "Step back", title: "Step back" });
    back.textContent = "◀";
    const play = el("button", STYLE.button, { type: "button", "data-act": "play", "aria-label": "Pause or play", title: "Pause / play" });
    const forward = el("button", STYLE.button, { type: "button", "data-act": "forward", "aria-label": "Step forward", title: "Step forward" });
    forward.textContent = "▶";
    const live = el("button", STYLE.button, { type: "button", "data-act": "live", "aria-label": "Jump to live", title: "Jump to live" });
    live.textContent = "LIVE";
    const status = el("span", STYLE.status);
    controls.append(back, play, forward, live, status);

    const canvas = el("canvas", "display:block;");
    root.append(head, controls, canvas);
    layer.appendChild(root);

    const parts = { head, title, minimize, close, back, play, forward, live, status };
    const entry = { root, canvas, ui: null, parts };
    windows.set(battleId, entry);

    minimize.addEventListener("click", () => act(battleId, "minimize"));
    close.addEventListener("click", () => act(battleId, "close"));
    back.addEventListener("click", () => act(battleId, "back"));
    play.addEventListener("click", () => act(battleId, "play"));
    forward.addEventListener("click", () => act(battleId, "forward"));
    live.addEventListener("click", () => act(battleId, "live"));
    root.addEventListener("pointerdown", () => {
      vs = bringToFront(vs, battleId);
      layoutDom();
    });
    wireDrag(battleId, head);
    return entry;
  }

  function wireDrag(battleId, head) {
    let drag = null;
    head.addEventListener("pointerdown", (ev) => {
      if (ev.target && ev.target.tagName === "BUTTON") return;
      const w = vs.windows.find((x) => x.battleId === battleId);
      if (!w) return;
      drag = { dx: ev.clientX - w.rect.x, dy: ev.clientY - w.rect.y };
      if (head.setPointerCapture && ev.pointerId !== undefined) {
        try {
          head.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* not all pointers can be captured */
        }
      }
    });
    head.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      vs = moveWindow(vs, battleId, ev.clientX - drag.dx, ev.clientY - drag.dy);
      layoutDom();
    });
    const end = () => {
      drag = null;
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

  function destroyWindow(battleId) {
    const w = windows.get(battleId);
    if (!w) return;
    if (w.ui) w.ui.destroy();
    if (w.root.parentNode) w.root.parentNode.removeChild(w.root);
    windows.delete(battleId);
  }

  function buildChip(battleId) {
    const chip = el("button", STYLE.chip, { type: "button", "data-battle": battleId });
    chip.addEventListener("click", () => act(battleId, "restore"));
    chip.style.pointerEvents = "auto";
    layer.appendChild(chip);
    chips.set(battleId, chip);
    return chip;
  }

  function destroyChip(battleId) {
    const c = chips.get(battleId);
    if (c && c.parentNode) c.parentNode.removeChild(c);
    chips.delete(battleId);
  }

  // ----- keeping DOM and state in step -----
  function refreshWindow(battleId) {
    const feed = feeds.get(battleId);
    const record = records.get(battleId);
    const w = windows.get(battleId);
    if (!feed || !record || !w) return;
    w.parts.title.textContent = titleOf(record);
    w.parts.status.textContent = statusOf(feed);
    w.parts.play.textContent = feed.playing ? "⏸" : "▶︎";
    w.parts.play.setAttribute("aria-label", feed.playing ? "Pause" : "Play");
    w.parts.live.disabled = feed.index === feed.liveIndex && feed.playing;
    w.root.setAttribute("aria-label", `Battle: ${titleOf(record)}`);
    if (w.ui) w.ui.setState(feed.state);
  }

  function layoutDom() {
    if (destroyed) return;
    // Open windows
    const open = getOpenWindows(vs);
    const openIds = new Set(open.map((w) => w.battleId));
    for (const id of [...windows.keys()]) if (!openIds.has(id)) destroyWindow(id);
    for (const win of open) {
      let entry = windows.get(win.battleId);
      const isNew = !entry;
      if (!entry) entry = buildWindow(win.battleId);
      const r = win.rect;
      entry.root.style.left = px(r.x);
      entry.root.style.top = px(r.y);
      entry.root.style.width = px(r.w);
      entry.root.style.height = px(r.h);
      entry.root.style.zIndex = String(win.z);
      const cw = r.w - 2;
      const ch = r.h - HEADER_H - 2;
      if (isNew) {
        const feed = feeds.get(win.battleId);
        entry.ui = createBattleUI({
          canvas: entry.canvas,
          state: feed.state,
          localOwnerId: null,
          ownerNames,
          width: cw,
          height: ch,
          compact: true,
        });
        refreshWindow(win.battleId);
      } else if (entry.ui && (entry.lastW !== cw || entry.lastH !== ch)) {
        entry.ui.resize(cw, ch);
      }
      entry.lastW = cw;
      entry.lastH = ch;
    }
    // Minimized chips
    const tray = getTray(vs);
    const trayIds = new Set(tray.map((t) => t.battleId));
    for (const id of [...chips.keys()]) if (!trayIds.has(id)) destroyChip(id);
    for (const t of tray) {
      const chip = chips.get(t.battleId) || buildChip(t.battleId);
      chip.style.left = px(t.rect.x);
      chip.style.top = px(t.rect.y);
      chip.style.width = px(t.rect.w);
      chip.style.height = px(t.rect.h);
      const record = records.get(t.battleId);
      const feed = feeds.get(t.battleId);
      const dot = unread.has(t.battleId) ? "● " : "";
      chip.textContent = `${dot}${record ? titleOf(record) : t.battleId}`;
      chip.title = feed ? `${record ? titleOf(record) : ""} — ${statusOf(feed)}. Click to open.` : "Open battle";
      chip.setAttribute("aria-label", chip.title);
    }
  }

  function anchorFor(battleId) {
    const record = records.get(battleId);
    if (!record || !game) return null;
    return getAnchor(record, game) || null;
  }

  function changed() {
    layoutDom();
    onChange();
  }

  // Button actions
  function act(battleId, what) {
    const feed = feeds.get(battleId);
    if (what === "minimize") vs = minimizeBattle(vs, battleId);
    else if (what === "close") {
      vs = closeBattle(vs, battleId);
      unread.delete(battleId);
    } else if (what === "restore") {
      vs = openBattle(vs, battleId, anchorFor(battleId) || undefined);
      unread.delete(battleId);
    } else if (feed) {
      let shown = null;
      if (what === "back") feed.stepBack();
      else if (what === "forward") shown = feed.stepForward();
      else if (what === "play") feed.togglePlay();
      else if (what === "live") feed.goLive();
      const w = windows.get(battleId);
      if (w && w.ui) {
        w.ui.setState(feed.state);
        if (shown) showStep(w, shown);
      }
      refreshWindow(battleId);
      startLoop();
    }
    changed();
  }

  function showStep(w, step) {
    const a = step.action;
    if (a && a.type === "attack" && step.report && w.ui) {
      w.ui.showAttack({ attackerId: a.unitId, targetId: a.targetId, report: step.report });
    }
  }

  // ----- playback -----
  function tick(dtMs) {
    let moved = false;
    for (const [id, feed] of feeds) {
      const wasOver = feed.over;
      const steps = feed.tick(dtMs);
      if (steps.length === 0 && wasOver === feed.over) continue;
      moved = true;
      const w = windows.get(id);
      if (w) {
        if (w.ui) w.ui.setState(feed.state);
        for (const s of steps) showStep(w, s);
        refreshWindow(id);
      } else if (steps.length > 0 || feed.over !== wasOver) {
        unread.add(id); // something happened while minimized
      }
    }
    if (moved) layoutDom();
    return moved;
  }

  function needsLoop() {
    return [...feeds.values()].some((f) => f.playing && f.index < f.liveIndex);
  }

  function startLoop() {
    if (frame !== null || destroyed || typeof requestAnimationFrame !== "function") return;
    const step = (now) => {
      frame = null;
      if (destroyed) return;
      const dt = lastTime === null ? 16 : Math.min(100, now - lastTime);
      lastTime = now;
      tick(dt);
      if (needsLoop()) frame = requestAnimationFrame(step);
      else lastTime = null;
    };
    frame = requestAnimationFrame(step);
  }

  // ----- the game -----
  function visibleRecords(g) {
    const out = new Map();
    for (const r of Object.values(g.battles)) out.set(r.id, r);
    if (O.KEEP_LAST_TURN && g.lastTurn) for (const r of Object.values(g.lastTurn.battles)) if (!out.has(r.id)) out.set(r.id, r);
    for (const [id, r] of [...out]) if (!canWatch(g, viewerOwnerId, r)) out.delete(id);
    return out;
  }

  function sync(newGame) {
    if (destroyed) return;
    game = newGame;
    seed = newGame.seed;
    const visible = visibleRecords(newGame);

    // Battles that are gone (a new turn resolved) disappear with their windows.
    for (const id of [...feeds.keys()]) {
      if (visible.has(id)) continue;
      feeds.delete(id);
      records.delete(id);
      unread.delete(id);
      vs = closeBattle(vs, id);
    }
    for (const [id, rec] of visible) {
      records.set(id, rec);
      const feed = feeds.get(id);
      if (!feed) feeds.set(id, createBattleFeed({ seed, record: rec }));
      else if (feed.sync(rec) > 0 && vs.windows.some((w) => w.battleId === id && w.mode === "minimized")) unread.add(id);
    }
    for (const id of feeds.keys()) refreshWindow(id);
    startLoop();
    changed();
  }

  return {
    sync,
    tick,
    // Battle icons for the overworld map.
    getMarkers() {
      if (!game) return [];
      return [...records.values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => {
          const w = vs.windows.find((x) => x.battleId === r.id);
          const feed = feeds.get(r.id);
          return {
            battleId: r.id,
            kind: r.kind,
            title: titleOf(r),
            worldPosition: battleWorldPosition(game, r),
            over: feed ? feed.over : r.done,
            windowState: w ? w.mode : "closed",
            unread: unread.has(r.id),
          };
        });
    },
    open(battleId) {
      if (!feeds.has(battleId)) return false;
      vs = openBattle(vs, battleId, anchorFor(battleId) || undefined);
      unread.delete(battleId);
      changed();
      return true;
    },
    minimize(battleId) {
      act(battleId, "minimize");
    },
    restore(battleId) {
      if (feeds.has(battleId)) act(battleId, "restore");
    },
    close(battleId) {
      act(battleId, "close");
    },
    // Marker click: open, minimize or restore.
    toggle(battleId) {
      if (!feeds.has(battleId)) return false;
      const w = vs.windows.find((x) => x.battleId === battleId);
      if (w && w.mode === "open") act(battleId, "minimize");
      else act(battleId, "restore");
      return true;
    },
    list() {
      return [...feeds.keys()].sort().map((id) => {
        const w = vs.windows.find((x) => x.battleId === id);
        const f = feeds.get(id);
        return { battleId: id, windowState: w ? w.mode : "closed", index: f.index, live: f.liveIndex, over: f.over, unread: unread.has(id) };
      });
    },
    getFeed(battleId) {
      return feeds.get(battleId) || null;
    },
    getLayout() {
      return vs;
    },
    resize(w, h) {
      vs = resizeContainer(vs, w, h);
      layoutDom();
    },
    destroy() {
      destroyed = true;
      for (const id of [...windows.keys()]) destroyWindow(id);
      for (const id of [...chips.keys()]) destroyChip(id);
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      feeds.clear();
      records.clear();
    },
  };
}

// ---------------------------------------------------------------
// Self test (pure parts; the DOM part is tested in the project's test runs)
//   battleViewerSelfTest()
// ---------------------------------------------------------------

import { generateWorldBattle } from "./mapGenerator.js";
import { createGame, beginTurn, runAiBattles, submitBattleAction } from "./turnResolver.js";
import { placeArmy } from "./overworld.js";

export function battleViewerSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`battleViewerSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  // A real battle to watch
  const base = createGame({ map: generateWorldBattle({ seed: "view", mode: "pvp", players: [{ ownerId: "p1" }, { ownerId: "p2" }] }) });
  const A = base.armies.find((a) => a.ownerId === "p1").id;
  const B = base.armies.find((a) => a.ownerId === "p2").id;
  const clash = { ...base, world: placeArmy(placeArmy(base.world, A, 200, 200), B, 260, 200) };
  const started = beginTurn(clash, { p1: [{ type: "move", armyId: A, target: { x: 400, y: 200 } }] });
  const bid = started.battles[0];
  const finished = (() => {
    let g = started.game;
    for (let i = 0; i < 30 && g.resolution; i++) g = runAiBattles(g, ["p1", "p2"]).game;
    return g;
  })();
  const full = finished.lastTurn.battles[bid];
  const n = full.actions.length;
  eq(n > 3, true, "the battle has several actions");

  // --- Feed: replay ---
  const seed = finished.seed;
  const feed = createBattleFeed({ seed, record: full, stepMs: 500, startAtLive: false });
  eq([feed.index, feed.total, feed.liveIndex], [0, n, n], "feed starts at the beginning when asked");
  eq(JSON.stringify(feed.state), JSON.stringify(full.initial), "first state is the initial state");
  const late = createBattleFeed({ seed, record: full });
  eq(late.index, n, "a late watcher starts at the live end");
  eq(JSON.stringify(late.state), JSON.stringify(full.state), "the replay ends in the real final state");
  eq([late.over, late.winnerOwnerId], [full.state.over, full.state.winnerOwnerId], "result matches");

  // --- Feed: playback ---
  eq(feed.tick(499), [], "not enough time for a step");
  const one = feed.tick(1);
  eq([one.length, feed.index], [1, 1], "one step after STEP_MS");
  eq(one[0].action, full.actions[0], "the step is the first action");
  const several = feed.tick(1500);
  eq([several.length, feed.index], [3, 4], "long frames play several steps");
  feed.pause();
  eq(feed.tick(5000), [], "paused feeds do not advance");
  feed.stepBack();
  eq(feed.index, 3, "step back");
  eq(feed.stepForward().index, 4, "step forward");
  feed.goTo(0);
  eq(feed.index, 0, "go to start");
  feed.goLive();
  eq([feed.index, feed.playing, feed.behind], [n, true, 0], "jump to live");
  feed.goTo(9999);
  eq(feed.index, n, "cannot go past the live end");

  // --- Feed: live updates and delay ---
  const partial = { ...full, actions: full.actions.slice(0, 3) };
  const live = createBattleFeed({ seed, record: partial, stepMs: 100, startAtLive: false });
  eq(live.total, 3, "partial record");
  live.tick(1000);
  eq(live.index, 3, "caught up to the live end");
  eq(live.sync(full), n - 3, "new actions arrive");
  eq(live.behind, n - 3, "the feed is behind by the new actions");
  live.tick(100);
  eq(live.index, 4, "and plays them");
  eq(live.sync(full), 0, "syncing again adds nothing");
  const delayed = createBattleFeed({ seed, record: full, delayActions: 2 });
  eq([delayed.liveIndex, delayed.index], [n - 2, n - 2], "a delayed watcher stays behind");
  const bad = createBattleFeed({ seed, record: { ...full, actions: [{ type: "move", x: 0, y: 0 }] } });
  eq(typeof bad.error, "string", "a bad record is reported, not thrown");

  // --- Who may watch ---
  const rec = { meta: { attackerOwnerId: "p1", defenderOwnerId: "p2" } };
  eq(canWatch({ eliminated: [] }, "p3", rec), O.WHO_CAN_WATCH !== "none" && O.WHO_CAN_WATCH !== "eliminated_only", "default policy for a third player");
  eq(canWatch({ eliminated: ["p3"] }, "p3", rec), O.WHO_CAN_WATCH !== "none", "eliminated players can watch");

  // --- Where a battle is ---
  const pos = battleWorldPosition(started.game, started.game.battles[bid]);
  eq(pos !== null && pos.x >= 200 && pos.x <= 400, true, "battle position is between the armies");
  eq(battleWorldPosition({ world: { armies: [] }, monsters: [] }, full), null, "no position when both are gone");

  // --- Window manager ---
  let vs = createViewerState({ width: 960, height: 560 });
  vs = openBattle(vs, "b1", { x: 480, y: 300 });
  const w1 = vs.windows[0];
  eq([w1.mode, w1.rect.w, w1.rect.h], ["open", O.WINDOW_WIDTH, O.WINDOW_HEIGHT], "a window opens at full size");
  eq(w1.rect.y + w1.rect.h <= 300, true, "above the battle, so the armies stay visible");
  const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= vs.width && r.y + r.h <= vs.height - O.TRAY_HEIGHT;
  eq(inside(w1.rect), true, "inside the container");
  vs = openBattle(vs, "b2", { x: 480, y: 300 });
  vs = openBattle(vs, "b3", { x: 480, y: 300 });
  const open3 = getOpenWindows(vs);
  eq(open3.every((w, i) => open3.every((v, j) => j <= i || !rectsOverlap(w.rect, v.rect))), true, "popups avoid each other");
  eq(open3.every((w) => inside(w.rect)), true, "all inside the container");
  // Edge anchors are clamped
  const edge = openBattle(createViewerState({ width: 960, height: 560 }), "e", { x: 0, y: 0 });
  eq([edge.windows[0].rect.x >= 0, edge.windows[0].rect.y >= 0], [true, true], "anchor at the corner stays on screen");
  // Too many open: the oldest is minimized
  let many = createViewerState({ width: 1400, height: 900 });
  for (let i = 1; i <= O.MAX_OPEN_WINDOWS + 1; i++) many = openBattle(many, `m${i}`, { x: 100 * i, y: 400 });
  eq(getOpenWindows(many).length, O.MAX_OPEN_WINDOWS, "at most MAX_OPEN_WINDOWS open");
  eq(many.windows.find((w) => w.battleId === "m1").mode, "minimized", "the oldest was minimized");
  eq(many.windows.find((w) => w.battleId === `m${O.MAX_OPEN_WINDOWS + 1}`).mode, "open", "the newest stays open");
  // Minimize, tray, restore, close
  const min = minimizeBattle(vs, "b2");
  eq(getOpenWindows(min).length, 2, "minimized windows are not open");
  const tray = getTray(min);
  eq(tray.map((t) => t.battleId), ["b2"], "minimized battles wait in the tray");
  eq(tray[0].rect.y + tray[0].rect.h <= min.height && tray[0].rect.x >= 0, true, "chips are inside the container");
  const back = restoreBattle(min, "b2");
  eq([back.windows.find((w) => w.battleId === "b2").mode, getTray(back)], ["open", []], "restored");
  eq(closeBattle(vs, "b1").windows.map((w) => w.battleId), ["b2", "b3"], "closed windows disappear");
  eq(toggleBattle(createViewerState({ width: 960, height: 560 }), "t").windows[0].mode, "open", "toggle opens");
  eq(toggleBattle(toggleBattle(createViewerState({ width: 960, height: 560 }), "t"), "t").windows[0].mode, "minimized", "toggle minimizes");
  eq(toggleBattle(minimizeBattle(vs, "b1"), "b1").windows.find((w) => w.battleId === "b1").mode, "open", "toggle restores");
  // Raising and moving
  const front = bringToFront(vs, "b1");
  eq(getOpenWindows(front).slice(-1)[0].battleId, "b1", "bring to front");
  const moved = moveWindow(vs, "b1", -500, 9999);
  eq(inside(moved.windows.find((w) => w.battleId === "b1").rect), true, "dragging is clamped");
  // Small screens (a phone)
  let phone = createViewerState({ width: 390, height: 700 });
  phone = openBattle(phone, "p", { x: 195, y: 350 });
  eq(phone.windows[0].rect.w <= 390 - 16, true, "windows shrink on a phone");
  eq(phone.windows[0].rect.x >= 0 && phone.windows[0].rect.x + phone.windows[0].rect.w <= 390, true, "and stay inside");
  // The container shrinks while windows are open
  const shrunk = resizeContainer(vs, 500, 400);
  eq(getOpenWindows(shrunk).every((w) => w.rect.x + w.rect.w <= 500 && w.rect.y + w.rect.h <= 400 - O.TRAY_HEIGHT), true, "windows follow a smaller container");

  // The feed plays a live game too: a player's action shows up for spectators
  const act = submitBattleAction(started.game, bid, { type: "end" }, undefined);
  eq(act.ok, true, "a player acted");
  const watching = createBattleFeed({ seed, record: started.game.battles[bid], stepMs: 10, startAtLive: false });
  eq(watching.total, 0, "no actions yet");
  eq(watching.sync(act.game.battles[bid]), 1, "the spectator receives the new action");
  eq(watching.tick(10).length, 1, "and plays it");

  return true;
}

export default {
  canWatch,
  battleWorldPosition,
  createBattleFeed,
  createViewerState,
  openBattle,
  minimizeBattle,
  restoreBattle,
  closeBattle,
  toggleBattle,
  bringToFront,
  moveWindow,
  resizeContainer,
  getOpenWindows,
  getTray,
  rectsOverlap,
  createBattleViewer,
  battleViewerSelfTest,
};
