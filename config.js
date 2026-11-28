// config.js
// All tunable numbers for the game live here.
// RULES:
//  - Integers only. Percentages are whole numbers (125 = 125%).
//  - Never read Math.random anywhere; use rng.js with a seed.
//  - Everything is deep-frozen so no script can change it by accident.

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  });
  return Object.freeze(obj);
}

export const CONFIG = deepFreeze({
  // ---------------------------------------------------------------
  // Fixed-point math
  // ---------------------------------------------------------------
  MATH: {
    PERCENT: 100, // 100 = 100%. Multiply, then Math.floor(x / PERCENT).
    XP_SCALE: 100, // XP is stored x100; rounding is always down.
  },

  // ---------------------------------------------------------------
  // Facing and attack angles
  // ---------------------------------------------------------------
  FACING: {
    DIRECTIONS: ["N", "E", "S", "W"],
    // Clockwise order, used to turn and to compare facings.
    OPPOSITE: { N: "S", E: "W", S: "N", W: "E" },
    // Where each facing points on the grid (x grows east, y grows south).
    VECTORS: {
      N: { x: 0, y: -1 },
      E: { x: 1, y: 0 },
      S: { x: 0, y: 1 },
      W: { x: -1, y: 0 },
    },
    // Attack classes, relative to the defender's facing.
    ATTACK_CLASS: { FRONT: "front", SIDE: "side", REAR: "rear" },
  },

  // ---------------------------------------------------------------
  // Combat multipliers (percent)
  // ---------------------------------------------------------------
  COMBAT: {
    // Damage multiplier for the attacker's opening strike.
    ATTACK_MULTIPLIER: { front: 100, side: 125, rear: 150 },

    // Damage multiplier for the defender's counterattack after turning.
    // Rear hits give a WEAKER counter than side hits.
    COUNTER_MULTIPLIER: { front: 100, side: 70, rear: 40 },

    // Face-dependent defenses (e.g. shields) only work against an attack
    // that hits the unit's front (a square counts as front on every side).
    // When this is false, a counterattack ignores the target's face-dependent
    // defenses. When true, the unit that started the exchange is assumed to
    // be facing its target, so its own shield works against the counter.
    FACE_DEFENSES_ACTIVE_ON_COUNTER: false,

    // Order inside one exchange: attacker strikes, then defender counters.
    // Dead defenders do not counter. Reserves enter after both strikes.
    RESERVES_ENTER_AFTER_EXCHANGE: true,

    // Every strike and every counterattack makes a NEW roll for that stack.
    // All units inside the stack deal that same rolled value (30 units deal
    // 30 times the roll). Other stacks of the same type roll separately.
    ONE_ROLL_PER_STACK_ATTACK: true,
  },

  // ---------------------------------------------------------------
  // Formations
  // ---------------------------------------------------------------
  FORMATIONS: {
    TYPES: ["square", "line"],
    DEFAULT: "square",

    // Spending a turn to switch formation (set 0 to make it free).
    SWITCH_COSTS_TURN: true,

    // Reserves (units that did not attack) fill the FRONT first.
    RESERVE_FILL_ORDER: "front",

    // Casualties are removed left to right so all clients agree.
    CASUALTY_ORDER: "left_to_right",

    // Exposed units die first.
    EXPOSED_DIE_FIRST: true,

    SQUARE: {
      // Equal numbers on all four sides where possible.
      // Extras stay in the middle and fill gaps after casualties.
      EXTRAS_GO_TO_CENTER: true,
      // Square has no weak side: flank and rear multipliers do not apply
      // to the attacker, and no counter penalty applies to the defender.
      IGNORES_FLANK_BONUS: true,
    },

    LINE: {
      // Same number in front as in back. Odd totals favor the front.
      ODD_FAVORS: "front",
      // Line is wide: more units attack at once from the front.
      // Side hits only expose the thin end; rear hits expose the whole width.
      IGNORES_FLANK_BONUS: false,
    },
  },

  // ---------------------------------------------------------------
  // Battle grid
  // ---------------------------------------------------------------
  BATTLE_GRID: {
    WIDTH: 10,
    HEIGHT: 8,
    HAS_HEIGHT: false,
    // A stack occupies exactly one square.
    STACK_CELLS: 1,
    // Moves each unit may make on the grid per battle turn.
    DEFAULT_MOVE_POINTS: 3,
    // Starting orientation comes from the overworld attack direction.
    // Flank or rear contact gives the attacker the first strike and turns
    // the defender's units sideways or away.
    FLANK_GIVES_FIRST_STRIKE: true,
    // Show the real unit count above each unit's head.
    SHOW_UNIT_COUNT: true,
    // Turn order: faster units (unitTypes speed) act first. Ties are broken
    // in this order: the side that started the battle, then owner id, then
    // stack id.
    TIE_BREAK: ["initiator_first", "owner_id", "stack_id"],
    // On a flank or rear contact the attacker's units all act before the
    // defender's for this many turns, then normal speed order applies.
    FIRST_STRIKE_TURNS: 1,
    // Safety net against stalemates. After this many turns the side with
    // more total health wins (a draw if equal).
    MAX_TURNS: 30,
  },

  // ---------------------------------------------------------------
  // Overworld
  // ---------------------------------------------------------------
  OVERWORLD: {
    // Integer positions in "sub-tiles" so every client agrees.
    SUBTILES_PER_TILE: 16,
    DEFAULT_MOVE_PER_TURN: 6, // in tiles
    // Contact happens when two armies come within this range (sub-tiles).
    CONTACT_RANGE: 20,
    // Armies of the same owner can hand units to each other, or split into
    // two armies, when they are within this range (in TILES).
    TRANSFER_RANGE: 1,
    // Facing is chosen by the player at the end of the army's turn.
    FACING_CHOSEN_AT_TURN_END: true,

    // A turn of movement is simulated in this many equal steps, so both
    // armies move at the same time and contact is found in a fixed order.
    // More steps = finer contact detection. Must keep each step small enough
    // that two armies cannot pass through each other (overworld.js checks).
    STEPS_PER_TURN: 24,

    // Contact resolution (overworld.js):
    //  - Armies of different owners make contact when they come within
    //    CONTACT_RANGE while at least one of them is closing the distance.
    //  - The army that reaches the contact point LATER is the attacker. In
    //    practice: an army that already stopped (at its destination, after
    //    an earlier contact, or with no order) was there first, so the army
    //    still closing in is the attacker.
    //  - Reaching a neutral thing (not an army) stops movement.
    //  - Equal arrival time (both closing in at the same step): no attacker,
    //    no first strike, both stop.
    LATER_ARRIVAL_IS_ATTACKER: true,
    NEUTRAL_STOPS_MOVEMENT: true,
    ARRIVAL_TIE: "no_first_strike",
    // Fallback ordering if anything else needs a tie-break.
    TIE_BREAK_ORDER: ["arrival_time", "owner_id", "army_id"],
  },

  // ---------------------------------------------------------------
  // Progression (per unit TYPE, not per individual unit)
  // ---------------------------------------------------------------
  PROGRESSION: {
    MAX_LEVEL: 10,
    START_LEVEL: 1,
    // XP needed to REACH each level, stored x100 (index 0 = level 1).
    // Level 2 needs 100.00 XP, level 3 needs 250.00 XP, and so on.
    XP_TO_REACH_LEVEL: [
      0, 10000, 25000, 45000, 70000, 100000, 140000, 190000, 250000, 320000,
    ],
    // Each level above 1 adds this percent to damage and to health.
    DAMAGE_PERCENT_PER_LEVEL: 8,
    HEALTH_PERCENT_PER_LEVEL: 8,

    // XP = roll position (0..100 within the damage range) x XP_SCALE,
    // divided by the number of independent attacking units of that type
    // (stacks count once, across all armies). Rounded DOWN.
    // Only units that attacked contribute. XP is awarded at end of turn.
    XP_FROM_ROLL_BASE: 100,
    XP_ROUNDING: "down",
    XP_AWARDED_AT: "end_of_turn",

    // Design watch-outs, off by default.
    XP_DIMINISHING_VS_WEAK: false,
    XP_PER_BATTLE_CAP: 0, // 0 = no cap

    // Whether levels persist in the Campaign (undecided, easy to change).
    PERSIST_IN_CAMPAIGN: false,
    // World Battle vs Players always starts every unit type at level 1.
    RESET_IN_PVP: true,
    // Unlockables always persist on the account.
    PERSIST_UNLOCKABLES: true,
  },

  // ---------------------------------------------------------------
  // Authority (unit limits)
  // ---------------------------------------------------------------
  AUTHORITY: {
    // Shared pool: every unit costs authority (cost lives in unitTypes.js).
    START_POOL: 20,
    // Extra authority gained per hero or level milestone (placeholder).
    POOL_PER_PLAYER_LEVEL: 0,
    // Each unit type also has its own cap (lives in unitTypes.js).
    PER_TYPE_CAP_ENABLED: true,
    // Any number of armies is allowed. Only the pool and caps limit units.
    MAX_ARMIES: 0, // 0 = unlimited
  },

  // ---------------------------------------------------------------
  // Armies (a stack = one unit entry; an army holds several stacks)
  // ---------------------------------------------------------------
  ARMY: {
    // Each army deploys its stacks into a small local zone on its own side
    // of the battle grid. Row 0 is the front (nearest the enemy), column 0
    // is the left. battleGrid.js rotates it by the attack direction.
    // The zone size is also the maximum number of stacks per army.
    DEPLOY_COLS: 5,
    DEPLOY_ROWS: 2,
  },

  // ---------------------------------------------------------------
  // Economy (integer gold only)
  // ---------------------------------------------------------------
  ECONOMY: {
    START_GOLD: 100,
    // Salaries are paid once per world turn.
    SALARY_PERIOD_TURNS: 1,
    // Insolvency: when gold cannot cover the salaries, the cheapest units are
    // paid first and the rest go unpaid. Their unpaid salary becomes DEBT
    // (back pay owed to the troops). The more debt compared with the army's
    // payroll, the more likely units are to desert each world turn:
    //   chance = (debt / payroll per turn) x PER_MILLE_PER_TURN_OF_DEBT,
    // capped at MAX_PER_MILLE. So a debt of 3 turns of salary with 100 gives
    // 30% (300 per-mille). Expected deserters = units x chance. ALL units
    // are at risk while there is debt, paid or not, and the most expensive
    // desert first.
    DESERTION_PER_MILLE_PER_TURN_OF_DEBT: 100,
    DESERTION_MAX_PER_MILLE: 600,
    // Deserters take their share of the debt with them (it is forgiven), so
    // losing troops does not push the remaining troops into a spiral.
    FORGIVE_DEBT_OF_DESERTERS: true,
    // Spend leftover gold on debt automatically once all salaries are paid.
    // Off: the player repays when they choose (economy.repayDebt).
    AUTO_REPAY_DEBT: false,
    DESERTION_ORDER: ["hire_cost_desc", "type_id_asc", "unit_id_asc"],
    // Gold from winning a battle. Off for now: the loot function exists
    // (economy.calculateLoot) but returns 0 until you enable and tune this.
    LOOT: {
      ENABLED: false,
      // Percent of the defeated units' hire cost.
      PERCENT_OF_HIRE_COST: 0,
      // Flat gold per defeated unit.
      FIXED_PER_UNIT: 0,
    },
    LOANS_ENABLED: false, // added later
    MIN_GOLD: 0, // gold never goes below this
  },

  // ---------------------------------------------------------------
  // Villages and patrons
  // ---------------------------------------------------------------
  VILLAGES: {
    // Gold a new village pays per world turn while it is safe.
    INCOME_PER_TURN: 5,
    // Every village's income grows by this percent each day (compounding),
    // whether or not anyone controls it. Monster raids cut it back.
    INCOME_GROWTH_PERCENT_PER_DAY: 1,
    // Units can be hired at an owned village.
    CAN_HIRE: true,
    // A village is "disturbed" while any army that is not its owner's, or any
    // monster, is within this range (in TILES). While disturbed its income
    // is FROZEN: it keeps piling up in the village but cannot be collected.
    // When the threat is gone, everything saved up is collected at once.
    DISTURB_RANGE: 6,
    // Capture: stand on or within CAPTURE_RANGE (in TILES) of the village
    // until the end of a turn. The number of units does not matter. This is
    // also how close an army must be to hire there.
    CAPTURE_RANGE: 2,
    // If two opposing armies are in reach, they fight. The loser is pushed
    // back to the nearest point outside reach.
    CONTEST_FIGHTS_BATTLE: true,
    // Push-back target ties are broken by this order.
    PUSH_BACK_TIE_BREAK: ["distance", "owner_id", "army_id"],
    // Starting villages per player in World Battle (generator uses this).
    PER_PLAYER_START: 2,
    NEUTRAL_VILLAGES: 6,
  },

  // ---------------------------------------------------------------
  // Roaming monsters
  // ---------------------------------------------------------------
  MONSTERS: {
    // Spawn chance per world turn, in per-mille (1000 = always).
    SPAWN_CHANCE_PER_MILLE: 120,
    MAX_ACTIVE: 4,
    // Placeholder monster type ids (data lives in unitTypes.js). A new
    // monster picks one at random.
    TYPES: ["wolf_pack"],
    // Units in a freshly spawned monster group (inclusive).
    SPAWN_COUNT_MIN: 4,
    SPAWN_COUNT_MAX: 10,
    // Monsters never spawn closer than this to an army (in TILES), nor
    // closer than 3 tiles to a village or another monster.
    MIN_SPAWN_DISTANCE_FROM_ARMIES: 8,
    // Formation monsters fight in.
    FORMATION: "line",

    // Wandering: each monster roams within ROAM_RADIUS tiles of where it
    // spawned, walking up to MOVE_PER_TURN tiles per turn toward a random
    // target, and picking a new target when it arrives or by chance.
    ROAM_RADIUS: 8,
    MOVE_PER_TURN: 3,
    NEW_TARGET_CHANCE_PER_MILLE: 150,

    // Villages: a monster that senses a village within this range (tiles)
    // heads for it instead of wandering. Within RAID_RANGE tiles it raids
    // with this chance each turn. A raid cuts the village's income by a
    // random percent from MIN to MAX, inclusive.
    ATTACKS_VILLAGES: true,
    VILLAGE_SENSE_RANGE: 6,
    RAID_RANGE: 2,
    RAID_CHANCE_PER_MILLE: 300,
    RAID_CUT_MIN_PERCENT: 10,
    RAID_CUT_MAX_PERCENT: 50,
  },
  TURNS: {
    // All players move at the same time.
    SIMULTANEOUS: true,
    // Orders stay hidden until every player has submitted them.
    HIDDEN_ORDERS: true,
    // Fixed resolution order once orders are revealed.
    RESOLUTION_ORDER: [
      "formation_changes",
      "movement",
      "contact_and_battles",
      "village_capture",
      "income_and_salaries",
      "desertion",
      "monster_spawns",
      "xp_awards",
    ],
    // After battles, village contests can start new fights between armies
    // that are still contesting a village. At most this many rounds.
    MAX_CONTEST_ROUNDS: 3,
    // How many world turns make one "day" (village income grows daily).
    TURNS_PER_DAY: 1,
    // Seconds before an unsubmitted turn is auto-submitted (0 = no timer).
    TURN_TIMER_SECONDS: 90,
    // Battle turn timer for the grid (seconds).
    BATTLE_TURN_TIMER_SECONDS: 45,
  },

  // ---------------------------------------------------------------
  // Disconnects and AI takeover
  // ---------------------------------------------------------------
  NETWORK: {
    // How long a player may be gone before the AI takes over.
    AI_TAKEOVER_AFTER_SECONDS: 30,
    // Player may take control back as soon as they reconnect.
    ALLOW_RECONNECT_RETAKE: true,
    // AI moves are written to the match record like normal moves,
    // so both clients replay the same sequence.
    LOG_AI_MOVES_IN_RECORD: true,
    MAX_PLAYERS: 4,
    // AI may fill empty PvP slots.
    ALLOW_AI_FILL: true,
  },

  // ---------------------------------------------------------------
  // Overworld AI (overworldAI.js): enemy armies and AI players
  // ---------------------------------------------------------------
  OVERWORLD_AI: {
    // An army chases an enemy army it sees within this range (in TILES) when
    // its strength is at least ATTACK_STRENGTH_PERCENT of the enemy's.
    AGGRESSION_RANGE: 12,
    ATTACK_STRENGTH_PERCENT: 80,
    // An army runs from a stronger one within FLEE_RANGE tiles when its own
    // strength is below FLEE_STRENGTH_PERCENT of the enemy's.
    FLEE_RANGE: 8,
    FLEE_STRENGTH_PERCENT: 50,
    // With nothing to do an army wanders within this many tiles.
    ROAM_RADIUS: 6,
    // Armies with this many units or fewer (new recruits) join a bigger army.
    SMALL_ARMY_UNITS: 3,
    // AI players with villages hire while they keep this many turns of
    // salary in reserve, up to HIRE_BATCH units at a time, never in debt.
    HIRE_RESERVE_TURNS: 3,
    HIRE_BATCH: 3,
  },

  // ---------------------------------------------------------------
  // Game modes
  // ---------------------------------------------------------------
  MODES: {
    CAMPAIGN: { id: "campaign", handMadeMaps: true, online: "save_only" },
    WORLD_BATTLE_AI: {
      id: "world_battle_ai",
      proceduralMaps: true,
      online: false,
    },
    WORLD_BATTLE_PVP: {
      id: "world_battle_pvp",
      proceduralMaps: true,
      online: true,
    },
  },

  // ---------------------------------------------------------------
  // Procedural maps (seed is stored in the match record)
  // ---------------------------------------------------------------
  MAP_GENERATION: {
    WIDTH_TILES: 48,
    HEIGHT_TILES: 48,
    // Open fields only for now: no blocked terrain, so every point is
    // reachable. (Kept as a flag for when terrain is added.)
    REQUIRE_CONNECTED: true,

    // Where players start.
    //   "ring":      players are spaced evenly around a square ring, with a
    //                random turn of the ring. With 2 players (or 4 on a
    //                square map) the whole map is mirrored by rotation, so
    //                every player gets the same villages the same distance
    //                away: fair.
    //   "irregular": players start at random spots at least
    //                MIN_START_DISTANCE apart. Not mirrored, so luck matters.
    LAYOUT: "ring",
    // Minimum distance between player start points (tiles).
    MIN_START_DISTANCE: 24,
    // The ring runs this many tiles in from the map edge.
    RING_INSET: 6,
    // Irregular starts stay this far from the map edge (tiles).
    START_MARGIN: 6,

    // Villages (counts are in CONFIG.VILLAGES: PER_PLAYER_START and
    // NEUTRAL_VILLAGES). Distances are in tiles.
    VILLAGE_MARGIN: 2,
    VILLAGE_MIN_SPACING: 5,
    START_VILLAGE_MIN_DISTANCE: 3,
    START_VILLAGE_MAX_DISTANCE: 6,
    NEUTRAL_MIN_DISTANCE_FROM_START: 7,

    // Enemy armies for World Battle vs AI (they all belong to one AI owner).
    START_ENEMY_ARMIES: 3,
    ENEMY_OWNER_ID: "ai",
    //   "random":        anywhere away from the players
    //   "near_villages": 2 to 3 tiles from a neutral village
    //   "mixed":         alternates between the two
    ENEMY_PLACEMENT: "mixed",
    ENEMY_MIN_DISTANCE_FROM_START: 10,
    ENEMY_MIN_SPACING: 4,
    ENEMY_NEAR_VILLAGE_MIN: 2,
    ENEMY_NEAR_VILLAGE_MAX: 3,
    // Each enemy army has this many stacks, each this many units, made from
    // the same unit types the player starts with (default-unlocked,
    // hireable ones).
    ENEMY_STACKS_MIN: 1,
    ENEMY_STACKS_MAX: 2,
    ENEMY_STACK_COUNT_MIN: 3,
    ENEMY_STACK_COUNT_MAX: 6,
  },

  // ---------------------------------------------------------------
  // Starting setup (may change later)
  // ---------------------------------------------------------------
  START: {
    // One army containing one swordsman with a shield.
    ARMIES: [
      {
        name: "First Army",
        formation: "square",
        units: [{ typeId: "swordsman", count: 1, stacked: true }],
      },
    ],
  },

  // ---------------------------------------------------------------
  // Auth and saves
  // ---------------------------------------------------------------
  AUTH: {
    START_AS_ANONYMOUS: true,
    // Upgrade guest to Google by linking, which keeps progress.
    GOOGLE_UPGRADE_BY_LINKING: true,
    PREFER_POPUP: true,
  },

  // ---------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------
  DEBUG: {
    LOG_RNG: false,
    LOG_BATTLES: false,
    SHOW_GRID_COORDS: false,
    // Override the match seed while testing (null = normal).
    FORCE_SEED: null,
  },
});

export default CONFIG;
