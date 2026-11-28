// turnResolver.js
// Resolves one simultaneous world turn from start to finish: orders,
// movement, battles, village capture, income, salaries, monsters, XP and
// victory. It ties every other script together. Pure logic: no graphics, no
// network. Every public function takes a game and returns a NEW game; the
// input is never changed. The game is plain JSON, so it can be saved to
// Firebase or compared between clients.
//
// ---------------------------------------------------------------
// THE GAME (plain JSON)
// ---------------------------------------------------------------
//   {
//     seed, turn, mode,
//     players: [{ ownerId, isAI }], enemyOwnerId,
//     world,                 overworld.js world (positions and facings)
//     armies: [...],         army.js armies (the contents)
//     villages, monsters,
//     economies: { ownerId: { gold, debt } },
//     progression: { ownerId: progression state },
//     unlocked: { ownerId: [unlock ids] },
//     nextId, monsterNextId, // id counters ("g" and "m" ids)
//     battles: { id: battle record },   battles of the turn being resolved
//     resolution,            null, or where the turn in progress has got to
//     lastTurn,              { turn, log, battles } of the last full turn
//     over, winnerOwnerId, eliminated
//   }
//   createGame() builds one from a mapGenerator map.
//
// ---------------------------------------------------------------
// A TURN, STEP BY STEP
// ---------------------------------------------------------------
//   beginTurn(game, orders)         all orders at once (hidden until every
//                                   player has submitted: matchSync.js)
//     1. Orders that change armies: hire, transfer, merge/split stacks,
//        layout, formation switch, repay debt.
//     2. Movement: all armies move at the same time (overworld.js).
//     3. Contacts become BATTLES, all at once.
//   Battles are played on the battle grid by the players (or the AI) AT THE
//   SAME TIME. The turn waits until every battle has finished:
//        submitBattleAction(game, battleId, action)   a player's action
//        runAiBattles(game, aiOwnerIds)               AI (or disconnected)
//   When the last battle ends the resolver continues by itself:
//     4. Village contests: armies of different owners at the same village
//        fight (more rounds if still contested). XP is committed after the
//        combat, so levels never change in the middle of a fight.
//     5. Village capture, income, salaries, debt and desertion.
//     6. Monsters move, raid villages, spawn, and attack armies (a last
//        round of battles).
//     7. Daily income growth, the turn counter, elimination and victory.
//   The status of each call says what is next: "battles" (battles are
//   waiting to be played) or "done" (the turn is finished).
//
// ORDERS: { [ownerId]: [order, ...] }, each order a plain object:
//   { type: "move",        armyId, target?: {x,y}, facing? }
//   { type: "hire",        villageId, typeId, count, armyId?, stackId?, formationType? }
//        Hires at a village you hold. No army needs to be there: a NEW ARMY
//        is created at the village. Give armyId (an army of yours at the
//        village) to join it instead. Several hires at one village in the
//        same turn share the new army.
//   { type: "transfer",    fromArmyId, toArmyId|null, stackId, count, takeWounded? }
//        Hands units to another army of yours within TRANSFER_RANGE. With
//        toArmyId null the units become a new army (a split). An army left
//        with no units is disbanded.
//   { type: "merge_stacks", armyId, stackIdA, stackIdB, formation? }
//   { type: "split_stack",  armyId, stackId, count, takeWounded? }
//   { type: "layout",       armyId, stackId, col, row }
//   { type: "stack_facing", armyId, stackId, facing }
//   { type: "switch",       armyId, stackId, formation }
//   { type: "repay",        amount? }
//   Orders that cannot be carried out are skipped and listed in `rejected`.
//
// EMPTY ARMIES vanish at once, from the army list and the world.
//
// VICTORY: a player is eliminated when it has no armies and no villages (it
// could still hire while it holds a village). The enemy raiders of World
// Battle vs AI have no economy and cannot hire, so they are eliminated as
// soon as they have no armies, even if they hold villages. The game ends
// when one owner is left standing, or none. Monsters never count.
//
// BATTLE RECORDS (for replays and spectators)
//   { id, kind, meta, initial, state, actions, awards, rngState, done, result }
//   `initial` and `actions` are all a spectator needs: replayBattle() plays
//   them back identically. Spectators can only watch.
//
// DETERMINISM: every random number comes from streams forked by turn, id or
// battle (rng.js), and orders are applied owner by owner in id order.

import { CONFIG } from "./config.js";
import { createMatchStreams } from "./rng.js";
import { createProgression, awardTurnXp, commitBattle } from "./progression.js";
import {
  createArmy,
  createIdCounter,
  mergeStacks,
  splitStack,
  setStackCell,
  setStackFacing,
  beginFormationSwitch,
  resolveFormationSwitches,
  transferUnits,
} from "./army.js";
import {
  addArmy,
  removeArmy,
  resolveMovement,
  validateOrder,
  toBattleParams,
  pushOutsideRange,
  distanceSq,
} from "./overworld.js";
import {
  createBattle,
  applyBattleAction,
  getOutcomes,
  applyOutcomesToArmies,
  getActiveUnit,
} from "./battleGrid.js";
import { playAiActivations } from "./battleAI.js";
import { groupAwardsByOwner, getHitFromSide } from "./battleRules.js";
import { hireUnits, repayDebt, runUpkeep } from "./economy.js";
import {
  canHireAtVillage,
  getVillage,
  armiesInCaptureRange,
  processIncome,
  growIncome,
  applyRaids,
  findContests,
  updateCaptures,
  pushLoserOut,
} from "./villages.js";
import {
  MONSTER_OWNER,
  runMonsterTurn,
  monsterToArmy,
  toArmyAttackParams,
  toMonsterAttackParams,
  applyMonsterOutcome,
} from "./monsters.js";

const S = CONFIG.OVERWORLD.SUBTILES_PER_TILE;
const CONTACT_RANGE = CONFIG.OVERWORLD.CONTACT_RANGE;

const fail = (code, reason) => ({ ok: false, code, reason });

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function log(g, event) {
  g.turnLog.push({ turn: g.turn, ...event });
}

function armyById(g, id) {
  return g.armies.find((a) => a.id === id) || null;
}

function armiesMap(g) {
  return Object.fromEntries(g.armies.map((a) => [a.id, a]));
}

function worldArmy(g, id) {
  return g.world.armies.find((a) => a.id === id) || null;
}

function replaceArmy(g, army) {
  g.armies = g.armies.map((a) => (a.id === army.id ? army : a));
}

// Removes an army from the army list and from the world.
function removeArmyEverywhere(g, armyId) {
  g.armies = g.armies.filter((a) => a.id !== armyId);
  g.world = removeArmy(g.world, armyId);
}

// Empty armies vanish.
function pruneEmptyArmies(g) {
  for (const a of g.armies.slice()) {
    if (a.stacks.length === 0) {
      log(g, { type: "army_disbanded", armyId: a.id, ownerId: a.ownerId });
      removeArmyEverywhere(g, a.id);
    }
  }
}

function syncFacings(g) {
  g.armies = g.armies.map((a) => {
    const w = worldArmy(g, a.id);
    return w ? { ...a, facing: w.facing } : a;
  });
}

function idFactory(g) {
  const nextId = createIdCounter("g", g.nextId);
  return { nextId, commit: () => (g.nextId = nextId.value) };
}

function ownerOfAnything(g, id) {
  const a = armyById(g, id);
  if (a) return a.ownerId;
  return g.monsters.some((m) => m.id === id) ? MONSTER_OWNER : null;
}

// ---------------------------------------------------------------
// Creating a game
// ---------------------------------------------------------------

// Builds a game from a mapGenerator.generateWorldBattle() result.
//   seed       the match seed (default: the map's seed)
//   unlocked   { ownerId: [unlock ids] } from the players' saved data
export function createGame({ map, seed = map.seed, unlocked = {} }) {
  const game = {
    seed,
    turn: 1,
    mode: map.mode,
    players: map.players.map((p) => ({ ownerId: p.ownerId, isAI: p.isAI })),
    enemyOwnerId: map.enemyOwnerId,
    world: clone(map.world),
    armies: clone(map.armies),
    villages: clone(map.villages),
    monsters: clone(map.monsters),
    economies: clone(map.economies),
    progression: Object.fromEntries(map.players.map((p) => [p.ownerId, createProgression()])),
    unlocked: Object.fromEntries(map.players.map((p) => [p.ownerId, clone(unlocked[p.ownerId] || [])])),
    nextId: map.nextId,
    monsterNextId: 1,
    battles: {},
    resolution: null,
    lastTurn: null,
    turnLog: [],
    over: false,
    winnerOwnerId: null,
    eliminated: [],
  };
  return game;
}

// ---------------------------------------------------------------
// Orders (everything except movement)
// ---------------------------------------------------------------

function ownedArmy(g, ownerId, armyId) {
  const a = armyById(g, armyId);
  return a && a.ownerId === ownerId ? a : null;
}

function applyHire(g, ownerId, o) {
  const economy = g.economies[ownerId];
  if (!economy) return fail("no_economy", "That player cannot hire.");
  const can = canHireAtVillage(g.villages, ownerId, o.villageId, o.typeId);
  if (!can.ok) return can;
  const village = getVillage(g.villages, o.villageId);
  const ids = idFactory(g);
  const ctx = { unlockedIds: g.unlocked[ownerId] || [], nextId: ids.nextId };

  let army;
  let isNew = false;
  if (o.armyId !== undefined) {
    army = ownedArmy(g, ownerId, o.armyId);
    if (!army) return fail("unknown_army", "That army does not exist or is not yours.");
    if (!armiesInCaptureRange(g.world, village).some((a) => a.id === army.id)) {
      return fail("army_not_at_village", "That army is not at the village.");
    }
  } else {
    // Share the army created at this village earlier this turn, if any.
    const key = `${ownerId}|${village.id}`;
    const existing = g.resolution && g.resolution.newArmies ? g.resolution.newArmies[key] : null;
    army = existing ? armyById(g, existing) : null;
    if (!army) {
      army = createArmy({ id: ids.nextId(), ownerId, name: `${village.name} Garrison`, facing: "N" });
      isNew = true;
    }
  }

  const mine = g.armies.filter((a) => a.ownerId === ownerId && a.id !== army.id).concat([army]);
  const res = hireUnits({
    economy,
    armies: mine,
    armyId: army.id,
    typeId: o.typeId,
    count: o.count,
    stackId: o.stackId,
    formationType: o.formationType,
    ctx,
  });
  ids.commit();
  if (!res.ok) return res;

  g.economies[ownerId] = res.economy;
  const updated = res.armies.find((a) => a.id === army.id);
  if (isNew) {
    g.armies.push(updated);
    g.world = addArmy(g.world, { id: updated.id, ownerId, x: village.x, y: village.y, facing: "N" });
    g.resolution.newArmies[`${ownerId}|${village.id}`] = updated.id;
    log(g, { type: "army_created", armyId: updated.id, ownerId, villageId: village.id });
  } else {
    replaceArmy(g, updated);
  }
  log(g, { type: "hired", ownerId, villageId: village.id, armyId: updated.id, typeId: o.typeId, count: o.count, cost: res.cost });
  return { ok: true };
}

function applyTransfer(g, ownerId, o) {
  const from = ownedArmy(g, ownerId, o.fromArmyId);
  if (!from) return fail("unknown_army", "The giving army does not exist or is not yours.");
  const ids = idFactory(g);
  let to;
  let isNew = false;
  if (o.toArmyId === null || o.toArmyId === undefined) {
    to = createArmy({ id: ids.nextId(), ownerId, name: "Detachment", facing: from.facing });
    isNew = true;
  } else {
    to = ownedArmy(g, ownerId, o.toArmyId);
    if (!to) return fail("unknown_army", "The receiving army does not exist or is not yours.");
    const a = worldArmy(g, from.id);
    const b = worldArmy(g, to.id);
    if (distanceSq(a, b) > (CONFIG.OVERWORLD.TRANSFER_RANGE * S) ** 2) return fail("too_far", "The armies are too far apart.");
  }
  const res = transferUnits(from, to, o.stackId, o.count, { nextId: ids.nextId }, { takeWounded: !!o.takeWounded });
  ids.commit();
  if (!res.ok) return res;

  replaceArmy(g, res.from);
  if (isNew) {
    const w = worldArmy(g, from.id);
    g.armies.push(res.army);
    g.world = addArmy(g.world, { id: res.army.id, ownerId, x: w.x, y: w.y, facing: w.facing });
    log(g, { type: "army_created", armyId: res.army.id, ownerId, fromArmyId: from.id });
  } else {
    replaceArmy(g, res.army);
  }
  log(g, { type: "transferred", ownerId, fromArmyId: from.id, toArmyId: res.army.id, stackId: o.stackId, count: o.count });
  // An army with no units left is disbanded (pruneEmptyArmies after orders).
  return { ok: true };
}

function applyArmyOp(g, ownerId, o) {
  if (o.type === "repay") {
    const economy = g.economies[ownerId];
    if (!economy) return fail("no_economy", "That player has no economy.");
    const res = repayDebt(economy, o.amount);
    if (!res.ok) return res;
    g.economies[ownerId] = res.economy;
    log(g, { type: "debt_repaid", ownerId, amount: res.repaid });
    return { ok: true };
  }
  const army = ownedArmy(g, ownerId, o.armyId);
  if (!army) return fail("unknown_army", "That army does not exist or is not yours.");

  let res;
  if (o.type === "merge_stacks") res = mergeStacks(army, o.stackIdA, o.stackIdB, o.formation);
  else if (o.type === "split_stack") {
    const ids = idFactory(g);
    res = splitStack(army, o.stackId, o.count, { nextId: ids.nextId }, { takeWounded: !!o.takeWounded });
    ids.commit();
  } else if (o.type === "layout") res = setStackCell(army, o.stackId, o.col, o.row);
  else if (o.type === "stack_facing") res = setStackFacing(army, o.stackId, o.facing);
  else if (o.type === "switch") {
    res = beginFormationSwitch(army, o.stackId, o.formation);
    if (res.ok) res = { ok: true, army: resolveFormationSwitches(res.army).army };
  } else return fail("unknown_order", `Unknown order type "${o.type}".`);
  if (!res.ok) return res;
  replaceArmy(g, res.army);
  return { ok: true };
}

const ARMY_OPS = new Set(["merge_stacks", "split_stack", "layout", "stack_facing", "switch", "repay"]);

// ---------------------------------------------------------------
// Battles
// ---------------------------------------------------------------

function pendingIds(g) {
  return Object.values(g.battles)
    .filter((b) => !b.done)
    .map((b) => b.id)
    .sort(cmp);
}

function addBattle(g, kind, params, meta) {
  const id = `t${g.turn}b${Object.keys(g.battles).length + 1}`;
  const state = createBattle({ id, ...params, progression: g.progression });
  g.battles[id] = {
    id,
    kind,
    meta: { ...meta, attackerArmyId: params.attackerArmy.id, defenderArmyId: params.defenderArmy.id, attackerOwnerId: params.attackerArmy.ownerId, defenderOwnerId: params.defenderArmy.ownerId },
    initial: clone(state),
    state,
    actions: [],
    awards: [],
    rngState: null,
    done: false,
    result: null,
  };
  for (const aid of [params.attackerArmy.id, params.defenderArmy.id]) {
    if (!g.resolution.fought.includes(aid)) g.resolution.fought.push(aid);
  }
  log(g, { type: "battle_started", battleId: id, kind, attackerArmyId: params.attackerArmy.id, defenderArmyId: params.defenderArmy.id });
  return id;
}

// Turns overworld events (and monster contacts) into battles, one per army
// and one per monster.
function startBattlesFromEvents(g, events) {
  const engaged = new Set();
  const byId = armiesMap(g);
  let made = 0;
  for (const ev of events) {
    if (ev.type === "army_contact") {
      if (engaged.has(ev.attackerId) || engaged.has(ev.defenderId)) continue;
      engaged.add(ev.attackerId).add(ev.defenderId);
      addBattle(g, "army", toBattleParams(ev, byId, g.world), {});
      made++;
    } else if (ev.type === "thing_contact" && ev.kind === "monster") {
      if (engaged.has(ev.armyId) || engaged.has(ev.thingId)) continue;
      engaged.add(ev.armyId).add(ev.thingId);
      addBattle(g, "monster", toArmyAttackParams(ev, g.monsters, byId, g.world), { monsterId: ev.thingId });
      made++;
    } else if (ev.type === "monster_contact") {
      if (engaged.has(ev.armyId) || engaged.has(ev.monsterId)) continue;
      engaged.add(ev.armyId).add(ev.monsterId);
      addBattle(g, "monster", toMonsterAttackParams(ev, g.monsters, byId, g.world), { monsterId: ev.monsterId });
      made++;
    }
  }
  return made;
}

// Village contests: opposing armies in range of the same village fight.
// Armies that already fought this turn sit this round out.
function startContestBattles(g) {
  let made = 0;
  const byId = armiesMap(g);
  for (const c of findContests(g.world, g.villages)) {
    const pair = c.pairs.find(([a, b]) => !g.resolution.fought.includes(a) && !g.resolution.fought.includes(b));
    if (!pair) continue;
    const [aId, bId] = pair;
    const pa = worldArmy(g, aId);
    const pb = worldArmy(g, bId);
    const event = {
      type: "army_contact",
      attackerId: aId,
      defenderId: bId,
      initiator: false,
      tie: true,
      hitFromSide: getHitFromSide({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }) || "S",
    };
    addBattle(g, "village_contest", toBattleParams(event, byId, g.world), { villageId: c.villageId });
    made++;
  }
  return made;
}

function battleRng(g, battle) {
  const rng = createMatchStreams(g.seed).battle(battle.id);
  if (battle.rngState) rng.setState(battle.rngState);
  return rng;
}

// After a battle that ended by time-out both sides may still be alive and
// close together: push the loser (or both after a draw) away.
function separateSurvivors(g, battle) {
  const m = battle.meta;
  const alive = (id) => armyById(g, id) !== null || g.monsters.some((x) => x.id === id);
  if (!alive(m.attackerArmyId) || !alive(m.defenderArmyId)) return;
  const pos = (id) => {
    const mon = g.monsters.find((x) => x.id === id);
    return mon ? { x: mon.x, y: mon.y } : worldArmy(g, id);
  };
  const winner = battle.state.winnerOwnerId;
  const pa = { ...pos(m.attackerArmyId) };
  const pb = { ...pos(m.defenderArmyId) };
  const push = (id, center) => {
    if (g.monsters.some((x) => x.id === id)) return; // monsters stay where they are
    if (battle.kind === "village_contest") {
      g.world = pushLoserOut(g.world, getVillage(g.villages, m.villageId), id);
    } else {
      g.world = pushOutsideRange(g.world, id, center, CONTACT_RANGE);
    }
  };
  if (winner === null) {
    push(m.attackerArmyId, pb);
    push(m.defenderArmyId, pa);
  } else if (ownerOfAnything(g, m.attackerArmyId) !== winner) push(m.attackerArmyId, pb);
  else push(m.defenderArmyId, pa);
}

// Writes a finished battle's results back to the game.
function finishBattle(g, battle) {
  const state = battle.state;
  const outcomes = getOutcomes(state);
  const armyIds = [...new Set(outcomes.map((o) => o.armyId))].sort(cmp);

  for (const id of armyIds) {
    const mine = outcomes.filter((o) => o.armyId === id);
    const monster = g.monsters.find((m) => m.id === id);
    if (monster) {
      const after = applyOutcomesToArmies([monsterToArmy(monster)], mine)[0];
      const res = applyMonsterOutcome(g.monsters, g.world, id, after);
      g.monsters = res.monsters;
      g.world = res.world;
      if (res.defeated) log(g, { type: "monster_defeated", monsterId: id });
      continue;
    }
    const army = armyById(g, id);
    if (!army) continue;
    replaceArmy(g, applyOutcomesToArmies([army], mine)[0]);
  }
  pruneEmptyArmies(g);

  // XP is stored now and becomes levels once all the fighting is over.
  const byOwner = groupAwardsByOwner(battle.awards);
  for (const ownerId of Object.keys(byOwner).sort()) {
    if (!g.progression[ownerId]) continue; // monsters and the enemy do not level
    g.progression[ownerId] = awardTurnXp(g.progression[ownerId], byOwner[ownerId]).state;
  }

  separateSurvivors(g, battle);
  battle.done = true;
  battle.result = { winnerOwnerId: state.winnerOwnerId, turns: state.turn };
  log(g, { type: "battle_finished", battleId: battle.id, kind: battle.kind, winnerOwnerId: state.winnerOwnerId });
}

// Turns pending XP into levels (after combat).
function commitProgression(g) {
  for (const ownerId of Object.keys(g.progression).sort()) {
    const res = commitBattle(g.progression[ownerId]);
    g.progression[ownerId] = res.state;
    for (const up of res.levelUps) log(g, { type: "level_up", ownerId, ...up });
  }
}

// ---------------------------------------------------------------
// The turn's stages
// ---------------------------------------------------------------

function runEconomyStage(g) {
  const streams = createMatchStreams(g.seed);

  const captured = updateCaptures(g.villages, g.world);
  g.villages = captured.villages;
  for (const e of captured.events) log(g, e);

  const income = processIncome(g.villages, g.world);
  g.villages = income.villages;
  for (const e of income.events) log(g, { type: "village_income", ...e });

  for (const ownerId of Object.keys(g.economies).sort()) {
    const mine = g.armies.filter((a) => a.ownerId === ownerId);
    const res = runUpkeep(g.economies[ownerId], mine, {
      income: income.incomeByOwner[ownerId] || 0,
      turn: g.turn,
      ownerId,
      rng: streams.economy,
    });
    g.economies[ownerId] = res.economy;
    const byId = new Map(res.armies.map((a) => [a.id, a]));
    g.armies = g.armies.map((a) => (a.ownerId === ownerId ? byId.get(a.id) || a : a));
    log(g, { type: "upkeep", ownerId, ...res.report });
  }
  pruneEmptyArmies(g);
}

function runMonsterStage(g) {
  const streams = createMatchStreams(g.seed);
  const counter = createIdCounter("m", g.monsterNextId);
  const res = runMonsterTurn({ monsters: g.monsters, world: g.world, villages: g.villages }, streams.monsters, {
    turn: g.turn,
    nextId: counter,
  });
  g.monsters = res.monsters;
  g.world = res.world;
  g.monsterNextId = counter.value;
  g.villages = applyRaids(g.villages, res.raids);
  for (const r of res.raids) log(g, r);
  for (const s of res.spawned) log(g, s);
  return startBattlesFromEvents(g, res.contacts);
}

function evaluateVictory(g) {
  const owners = g.players.map((p) => p.ownerId).concat(g.enemyOwnerId ? [g.enemyOwnerId] : []);
  const alive = owners.filter(
    (o) => g.armies.some((a) => a.ownerId === o) || (g.economies[o] && g.villages.some((v) => v.ownerId === o))
  );
  g.eliminated = owners.filter((o) => !alive.includes(o));
  if ((owners.length >= 2 && alive.length <= 1) || alive.length === 0) {
    g.over = true;
    g.winnerOwnerId = alive.length === 1 ? alive[0] : null;
    log(g, { type: "game_over", winnerOwnerId: g.winnerOwnerId });
  }
}

// Runs the turn forward until battles are waiting or the turn is done.
function progress(g) {
  for (let guard = 0; guard < 100; guard++) {
    if (pendingIds(g).length > 0) return "battles";
    commitProgression(g);
    const r = g.resolution;

    if (r.stage === "after_movement") {
      r.stage = "contests";
      r.round = 0;
    } else if (r.stage === "contests") {
      if (r.round < CONFIG.TURNS.MAX_CONTEST_ROUNDS && startContestBattles(g) > 0) r.round++;
      else r.stage = "economy";
    } else if (r.stage === "economy") {
      runEconomyStage(g);
      r.stage = "monsters";
    } else if (r.stage === "monsters") {
      runMonsterStage(g);
      r.stage = "finalize";
    } else if (r.stage === "finalize") {
      g.villages = growIncome(g.villages, g.turn);
      evaluateVictory(g);
      g.lastTurn = { turn: g.turn, log: g.turnLog, battles: g.battles };
      g.battles = {};
      g.turnLog = [];
      g.turn += 1;
      g.resolution = null;
      return "done";
    }
  }
  throw new Error("turnResolver: the turn did not finish (too many stages)");
}

// ---------------------------------------------------------------
// Public: starting a turn
// ---------------------------------------------------------------

// Applies all orders and starts the turn.
//   orders   { [ownerId]: [order, ...] }
// Returns { ok, game, status, battles, rejected } where status is "battles"
// (play them) or "done", battles lists the new battle ids, and rejected lists
// orders that were skipped: [{ ownerId, type, code, reason }].
export function beginTurn(game, orders = {}) {
  if (game.over) return fail("game_over", "The game is over.");
  if (game.resolution) return fail("turn_in_progress", "The turn is still being resolved.");
  const g = clone(game);
  g.turnLog = [];
  g.battles = {};
  g.resolution = { stage: "orders", round: 0, newArmies: {}, fought: [] };
  const rejected = [];
  const reject = (ownerId, o, res) => rejected.push({ ownerId, type: o && o.type, code: res.code, reason: res.reason });

  // 1. Orders that change armies, owner by owner.
  const owners = Object.keys(orders).sort();
  const moves = [];
  for (const ownerId of owners) {
    for (const o of orders[ownerId] || []) {
      if (!o || typeof o !== "object") {
        reject(ownerId, o, { code: "bad_order", reason: "That is not an order." });
        continue;
      }
      let res;
      if (o.type === "move") {
        res = validateOrder(g.world, { armyId: o.armyId, target: o.target, facing: o.facing }, ownerId);
        if (res.ok) moves.push({ armyId: o.armyId, target: o.target, facing: o.facing });
      } else if (o.type === "hire") res = applyHire(g, ownerId, o);
      else if (o.type === "transfer") res = applyTransfer(g, ownerId, o);
      else if (ARMY_OPS.has(o.type)) res = applyArmyOp(g, ownerId, o);
      else res = fail("unknown_order", `Unknown order type "${o.type}".`);
      if (!res.ok) reject(ownerId, o, res);
    }
  }
  pruneEmptyArmies(g);
  // Move orders for armies that no longer exist are dropped.
  const liveMoves = moves.filter((m) => armyById(g, m.armyId));

  // 2. Movement, all armies at once.
  const move = resolveMovement(g.world, liveMoves);
  g.world = move.world;
  syncFacings(g);
  for (const r of move.rejected) rejected.push({ ownerId: ownerOfAnything(g, r.armyId), type: "move", code: r.code, reason: r.reason });
  for (const e of move.events) log(g, e);

  // 3. Contacts become battles.
  g.resolution.stage = "after_movement";
  startBattlesFromEvents(g, move.events);

  const status = progress(g);
  return { ok: true, game: g, status, battles: pendingIds(g), rejected };
}

// ---------------------------------------------------------------
// Public: playing battles
// ---------------------------------------------------------------

export function getPendingBattles(game) {
  return pendingIds(game);
}

export function getBattle(game, battleId) {
  return game.battles[battleId] || (game.lastTurn && game.lastTurn.battles[battleId]) || null;
}

// One action in one battle (a player's click). `action` is a battleGrid
// action: move, attack, switch or end. Pass actorOwnerId (from matchSync)
// to make sure only the owner of the active unit can act.
// Returns { ok, game, report, battleOver, status } or { ok: false, code, reason }.
export function submitBattleAction(game, battleId, action, actorOwnerId) {
  const g = clone(game);
  const battle = g.battles[battleId];
  if (!battle || battle.done) return fail("no_such_battle", "That battle is not being played.");
  const active = getActiveUnit(battle.state);
  if (!active) return fail("no_active_unit", "There is no unit to act.");
  if (actorOwnerId !== undefined && active.ownerId !== actorOwnerId) return fail("not_your_unit", "It is not your unit's turn.");

  const rng = battleRng(g, battle);
  const res = applyBattleAction(battle.state, action, rng);
  if (!res.ok) return res;
  battle.state = res.state;
  battle.rngState = rng.getState();
  battle.actions.push({ unitId: active.id, ...action });
  if (res.awards) battle.awards.push(...res.awards);

  const battleOver = battle.state.over;
  if (battleOver) finishBattle(g, battle);
  const status = pendingIds(g).length === 0 ? progress(g) : "battles";
  return { ok: true, game: g, report: res.report || null, battleOver, status };
}

// Lets the AI play every battle activation that belongs to `aiOwnerIds`:
// enemy armies, monsters, AI players, or a player who disconnected. It stops
// at a unit that a human must play. When all battles are done the turn
// continues by itself (and its next battles are played too if they are AI's).
// Returns { ok, game, status }.
export function runAiBattles(game, aiOwnerIds) {
  const g = clone(game);
  for (let guard = 0; guard < 200 && g.resolution; guard++) {
    let acted = false;
    for (const id of pendingIds(g)) {
      const battle = g.battles[id];
      const active = getActiveUnit(battle.state);
      if (!active || !aiOwnerIds.includes(active.ownerId)) continue;
      const rng = battleRng(g, battle);
      const res = playAiActivations(battle.state, aiOwnerIds, rng);
      if (!res.ok) return res;
      battle.state = res.state;
      battle.rngState = rng.getState();
      battle.actions.push(...res.actions);
      battle.awards.push(...res.awards);
      if (battle.state.over) finishBattle(g, battle);
      acted = true;
    }
    if (pendingIds(g).length === 0 && g.resolution) {
      progress(g);
      acted = true;
    }
    if (!acted) break;
  }
  return { ok: true, game: g, status: g.resolution ? "battles" : "done" };
}

// Replays a recorded battle exactly, for spectators and for checking.
// `record` is a battle record (game.battles[id] or game.lastTurn.battles[id]).
// Returns { states } where states[i] is the state after i actions (states[0]
// is the start), so a viewer can scrub through the fight.
export function replayBattle(seed, record) {
  const rng = createMatchStreams(seed).battle(record.id);
  let state = clone(record.initial);
  const states = [clone(state)];
  for (const a of record.actions) {
    const res = applyBattleAction(state, a, rng);
    if (!res.ok) throw new Error(`turnResolver: replay failed at action ${states.length}: ${res.reason}`);
    state = res.state;
    states.push(clone(state));
  }
  return { states };
}

// ---------------------------------------------------------------
// Self test (call turnResolverSelfTest() from the browser console)
// ---------------------------------------------------------------

import { generateWorldBattle } from "./mapGenerator.js";
import { placeArmy, tileToPoint } from "./overworld.js";
import { createMonster, withMonsterThings } from "./monsters.js";

export function turnResolverSelfTest() {
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`turnResolverSelfTest "${label}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const two = [{ ownerId: "p1" }, { ownerId: "p2" }];
  const mk = (seed = "t") => createGame({ map: generateWorldBattle({ seed, mode: "pvp", players: two }) });
  const armyOf = (g, ownerId) => g.armies.filter((a) => a.ownerId === ownerId);
  const place = (g, id, x, y) => ({ ...g, world: placeArmy(g.world, id, x, y) });
  // Plays every battle with the AI until the turn is done.
  const playOut = (g, owners) => {
    let cur = g;
    for (let i = 0; i < 50 && cur.resolution; i++) cur = runAiBattles(cur, owners).game;
    return cur;
  };

  // --- An empty turn: income in, salaries out, day growth ---
  const g0 = mk();
  const r0 = beginTurn(g0, {});
  eq([r0.ok, r0.status, r0.game.turn, g0.turn], [true, "done", 2, 1], "empty turn, input untouched");
  eq(r0.game.economies.p1.gold, 100 + 2 * 5 - 2, "gold = 100 + 2 villages x 5 - 1 swordsman salary");
  eq(r0.game.villages[0].incomeMilli, 5050, "villages grew 1%");
  eq(r0.game.resolution, null, "no turn in progress");
  eq(JSON.parse(JSON.stringify(r0.game)), r0.game, "the game is plain JSON");

  // --- Hiring creates an army at the village ---
  const v1 = g0.villages.find((v) => v.ownerId === "p1");
  const hire = beginTurn(g0, { p1: [{ type: "hire", villageId: v1.id, typeId: "swordsman", count: 2 }] });
  eq(hire.rejected, [], "hire accepted");
  eq(armyOf(hire.game, "p1").length, 2, "a new army was created");
  const garrison = armyOf(hire.game, "p1").find((a) => a.name.endsWith("Garrison"));
  eq([garrison.stacks[0].typeId, garrison.stacks[0].count], ["swordsman", 2], "units in the new army");
  eq([hire.game.world.armies.find((a) => a.id === garrison.id).x, hire.game.world.armies.find((a) => a.id === garrison.id).y], [v1.x, v1.y], "army stands at the village");
  eq(hire.game.economies.p1.gold, 100 - 60 + 10 - 3 * 2, "paid 60, then income and salaries of 3 units");
  // Two hires at one village share the new army
  const hire2 = beginTurn(g0, { p1: [
    { type: "hire", villageId: v1.id, typeId: "swordsman", count: 1 },
    { type: "hire", villageId: v1.id, typeId: "spearman", count: 1 },
  ] });
  eq(armyOf(hire2.game, "p1").length, 2, "one new army for both hires");
  eq(armyOf(hire2.game, "p1").find((a) => a.name.endsWith("Garrison")).stacks.map((s) => s.typeId), ["swordsman", "spearman"], "two stacks");
  // Hires that are refused
  const v2 = g0.villages.find((v) => v.ownerId === "p2");
  const bad = beginTurn(g0, { p1: [
    { type: "hire", villageId: v2.id, typeId: "swordsman", count: 1 },
    { type: "hire", villageId: v1.id, typeId: "archer", count: 1 },
    { type: "hire", villageId: v1.id, typeId: "swordsman", count: 10 },
    { type: "hire", villageId: v1.id, typeId: "swordsman", count: 1, armyId: armyOf(g0, "p1")[0].id },
  ] });
  eq(bad.rejected.map((x) => x.code), ["not_yours", "type_locked", "not_enough_gold", "army_not_at_village"], "refused hires and why");
  eq(armyOf(bad.game, "p1").length, 1, "nothing was hired");

  // --- Transfers and splits ---
  const h = hire.game;
  const home = armyOf(h, "p1").find((a) => !a.name.endsWith("Garrison"));
  const tooFar = beginTurn(h, { p1: [{ type: "transfer", fromArmyId: garrison.id, toArmyId: home.id, stackId: garrison.stacks[0].id, count: 2 }] });
  eq(tooFar.rejected.map((x) => x.code), ["too_far"], "armies must be close to transfer");
  const gw = h.world.armies.find((a) => a.id === garrison.id);
  const together = place(h, home.id, gw.x + 8, gw.y);
  const split = beginTurn(together, { p1: [{ type: "transfer", fromArmyId: garrison.id, toArmyId: null, stackId: garrison.stacks[0].id, count: 1 }] });
  eq(split.rejected, [], "split accepted");
  eq(armyOf(split.game, "p1").length, 3, "a detachment was created");
  eq(armyOf(split.game, "p1").find((a) => a.name === "Detachment").stacks[0].count, 1, "detachment holds the split units");
  const all = beginTurn(together, { p1: [{ type: "transfer", fromArmyId: garrison.id, toArmyId: home.id, stackId: garrison.stacks[0].id, count: 2 }] });
  eq(armyOf(all.game, "p1").length, 1, "an army with no units is disbanded");
  eq(armyOf(all.game, "p1")[0].stacks.map((s) => s.count), [1, 2], "units joined the other army");
  eq(all.game.world.armies.filter((a) => a.ownerId === "p1").length, 1, "and it left the world");

  // --- Other orders ---
  const stackId = home.stacks[0].id;
  const ops = beginTurn(g0, { p1: [
    { type: "switch", armyId: home.id, stackId, formation: "line" },
    { type: "stack_facing", armyId: home.id, stackId, facing: "E" },
    { type: "layout", armyId: home.id, stackId, col: 0, row: 1 },
  ] });
  eq(ops.rejected, [], "stack orders accepted");
  const opStack = armyOf(ops.game, "p1")[0].stacks[0];
  eq([opStack.formationType, opStack.facing, opStack.cell], ["line", "E", { col: 0, row: 1 }], "stack orders applied");
  const debtGame = { ...g0, economies: { ...g0.economies, p1: { gold: 100, debt: 50 } } };
  eq(beginTurn(debtGame, { p1: [{ type: "repay" }] }).game.economies.p1.debt <= 50, true, "repay accepted");
  const rej = beginTurn(g0, { p1: [{ type: "move", armyId: armyOf(g0, "p2")[0].id, target: { x: 5, y: 5 } }, { type: "move", armyId: "nope", target: { x: 5, y: 5 } }, { type: "dance" }, null] });
  eq(rej.rejected.map((x) => x.code), ["not_yours", "unknown_army", "unknown_order", "bad_order"], "bad orders are rejected");

  // --- Army vs army: concurrent battles, XP, replay ---
  const A = armyOf(g0, "p1")[0].id;
  const B = armyOf(g0, "p2")[0].id;
  const clash = place(place(g0, A, 200, 200), B, 260, 200);
  const started = beginTurn(clash, { p1: [{ type: "move", armyId: A, target: { x: 400, y: 200 } }] });
  eq([started.status, started.battles.length], ["battles", 1], "contact starts a battle");
  eq(beginTurn(started.game, {}).code, "turn_in_progress", "cannot start a turn while battles are pending");
  const bid = started.battles[0];
  const active = getActiveUnit(started.game.battles[bid].state);
  const other = active.ownerId === "p1" ? "p2" : "p1";
  eq(submitBattleAction(started.game, bid, { type: "end" }, other).code, "not_your_unit", "only the active unit's owner can act");
  const one = submitBattleAction(started.game, bid, { type: "end" }, active.ownerId);
  eq([one.ok, one.status], [true, "battles"], "a player's action");
  eq(one.game.battles[bid].actions.length, 1, "the action was recorded");
  const done = playOut(started.game, ["p1", "p2"]);
  eq([done.resolution, done.turn], [null, 2], "battle finished and the turn went on");
  const rec = done.lastTurn.battles[bid];
  eq([rec.done, rec.actions.length > 0, rec.awards.length > 0], [true, true, true], "battle record with actions and XP awards");
  eq(armyOf(done, "p1").length + armyOf(done, "p2").length <= 2, true, "armies only disappear");
  const replay = replayBattle(done.seed, rec);
  eq(JSON.stringify(replay.states[replay.states.length - 1]), JSON.stringify(rec.state), "a replay ends in the same state");
  eq(replay.states.length, rec.actions.length + 1, "one state per action");
  eq(JSON.stringify(playOut(started.game, ["p1", "p2"])), JSON.stringify(done), "the same turn gives the same result");
  eq(Object.values(done.progression.p1.pendingXp).every((x) => x === 0), true, "XP was committed after combat");
  eq(getPendingBattles(done), [], "no battles left");

  // --- Contested village: fight, winner captures ---
  const vn = g0.villages.find((v) => v.ownerId === null);
  const contest = place(place(g0, A, vn.x - 25, vn.y), B, vn.x + 25, vn.y);
  const cs = beginTurn(contest, {});
  eq([cs.status, cs.game.battles[cs.battles[0]].kind], ["battles", "village_contest"], "opposing armies at a village fight");
  const cd = playOut(cs.game, ["p1", "p2"]);
  const winner = cd.lastTurn.battles[cs.battles[0]].result.winnerOwnerId;
  eq(cd.villages.find((v) => v.id === vn.id).ownerId, winner, "the winner captures the village");
  // A lone army captures without a fight
  const lone = beginTurn(place(g0, A, vn.x + 10, vn.y), {});
  eq([lone.status, lone.game.villages.find((v) => v.id === vn.id).ownerId], ["done", "p1"], "standing at a village captures it");

  // --- Victory: the enemy is eliminated ---
  let win = place(place(g0, A, 200, 200), B, 260, 200);
  win = { ...win, villages: win.villages.map((v) => (v.ownerId === "p2" ? { ...v, ownerId: null } : v)) };
  win = { ...win, armies: win.armies.map((a) => (a.id === A ? { ...a, stacks: a.stacks.map((s) => ({ ...s, count: 30 })) } : a)) };
  const w1 = beginTurn(win, { p1: [{ type: "move", armyId: A, target: { x: 400, y: 200 } }] });
  const w2 = playOut(w1.game, ["p1", "p2"]);
  eq([w2.over, w2.winnerOwnerId, w2.eliminated], [true, "p1", ["p2"]], "eliminating the enemy wins");
  eq(beginTurn(w2, {}).code, "game_over", "no turns after the game is over");
  // An owner with no army but a village is still alive (it can hire)
  const alive = beginTurn({ ...g0, armies: g0.armies.filter((a) => a.ownerId !== "p2"), world: { ...g0.world, armies: g0.world.armies.filter((a) => a.ownerId !== "p2") } }, {});
  eq(alive.game.over, false, "villages keep a player alive");

  // --- Monsters: an army walks into one ---
  let mg = place(g0, A, 200, 200);
  mg = { ...mg, armies: mg.armies.map((a) => (a.id === A ? { ...a, stacks: a.stacks.map((s) => ({ ...s, count: 30 })) } : a)) };
  const monsters = [createMonster({ id: "mx", typeId: "wolf_pack", count: 3, x: 300, y: 200 })];
  mg = { ...mg, monsters, world: withMonsterThings(mg.world, monsters) };
  const ms = beginTurn(mg, { p1: [{ type: "move", armyId: A, target: { x: 500, y: 200 } }] });
  eq([ms.status, ms.game.battles[ms.battles[0]].kind], ["battles", "monster"], "walking into a monster starts a battle");
  const md = playOut(ms.game, ["p1", "monsters"]);
  eq(md.monsters.some((m) => m.id === "mx"), false, "the defeated monster is gone");
  eq(md.world.things.some((t) => t.id === "mx"), false, "and gone from the world");

  // --- Many turns of an AI game: nothing breaks ---
  let ai = createGame({ map: generateWorldBattle({ seed: "long", mode: "ai", players: [{ ownerId: "p1" }] }) });
  for (let t = 0; t < 25 && !ai.over; t++) {
    const res = beginTurn(ai, {});
    if (!res.ok) throw new Error(`turnResolverSelfTest: turn ${t} failed: ${res.reason}`);
    ai = playOut(res.game, ["p1", "ai", "monsters"]);
    const ids = ai.armies.map((a) => a.id).sort();
    eq(ai.world.armies.map((a) => a.id).sort(), ids, `world and armies agree on turn ${t}`);
    eq(new Set(ids).size, ids.length, `army ids are unique on turn ${t}`);
    eq(ai.armies.every((a) => a.stacks.length > 0), true, `no empty armies on turn ${t}`);
  }
  eq(ai.turn > 1, true, "the AI game progressed");

  return true;
}

export default {
  createGame,
  beginTurn,
  getPendingBattles,
  getBattle,
  submitBattleAction,
  runAiBattles,
  replayBattle,
  turnResolverSelfTest,
};
