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
    // Insolvency: the most expensive units desert first.
    DESERTION_ORDER: ["hire_cost_desc", "type_id_asc", "unit_id_asc"],
    // How many units desert per world turn while unpaid (0 = all unpaid).
    DESERTERS_PER_TURN: 0,
    LOANS_ENABLED: false, // added later
    MIN_GOLD: 0, // gold never goes below this
  },

  // ---------------------------------------------------------------
  // Villages and patrons
  // ---------------------------------------------------------------
  VILLAGES: {
    // Gold the owner earns per world turn while the village is safe.
    INCOME_PER_TURN: 5,
    // Units can be hired at an owned village.
    CAN_HIRE: true,
    // A village is "disturbed" (no income) while a hostile army or monster
    // is within this range (tiles) or it was attacked within this many turns.
    DISTURB_RANGE: 6,
    RECENT_ATTACK_TURNS: 2,
    // Capture: stand on or within CAPTURE_RANGE until the end of a turn.
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
    // Monsters may attack villages and disturb them nearby.
    ATTACKS_VILLAGES: true,
    // Monster is a neutral thing: reaching it stops movement.
    ROAM_RADIUS: 8,
    // Placeholder monster type ids (data lives in unitTypes.js).
    TYPES: ["wolf_pack"],
  },

  // ---------------------------------------------------------------
  // World turns and multiplayer
  // ---------------------------------------------------------------
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
    // Minimum distance between player start points (tiles).
    MIN_START_DISTANCE: 24,
    // Guarantee every village and start is reachable.
    REQUIRE_CONNECTED: true,
    // Enemies placed at the start of a World Battle vs AI map.
    START_ENEMY_ARMIES: 3,
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
