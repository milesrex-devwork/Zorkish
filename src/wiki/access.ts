import { openDB, type IDBPDatabase } from "idb";
import {
  WIKI_DB_NAME,
  WIKI_SCHEMA_VERSION,
  type DeathRecord,
  type Disposition,
  type ObservationRecord,
  type PlayerRecord,
  type RunRecord,
  type SaveRecord,
  type SchemaMetaRecord,
  type TurnRecord,
  type VoiceId,
  type ZorkishWikiDB,
} from "./schema";

let dbPromise: Promise<IDBPDatabase<ZorkishWikiDB>> | null = null;

const DEFAULT_VOICE: VoiceId = "modernized_classic";
const DEFAULT_DISPOSITION: Disposition = {
  helpfulness: "middle",
  playfulness: "moderate",
};

export type CreatePlayerOptions = {
  playerId?: string;
  defaultVoice?: VoiceId;
  defaultDisposition?: Disposition;
  audioEnabled?: boolean;
  playerProfile?: string;
};

export type CreateRunInput = {
  playerId: string;
  voice?: VoiceId;
  disposition?: Disposition;
  livesInitial?: number;
  isHardcore?: boolean;
  isNewGamePlus?: boolean;
  ngpSourceRunId?: string | null;
  currentRoom?: string;
  inventory?: string[];
  engineSaveId?: string;
};

export type RecordTurnInput = {
  runId: string;
  playerId: string;
  turnNumber: number;
  playerInput: string;
  intentMapping?: Record<string, unknown>;
  engineResponses?: Array<Record<string, unknown>>;
  narration?: Record<string, unknown>;
  engineSaveId?: string;
  wikiContextUsed?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

export type RecordDeathInput = {
  runId: string;
  playerId: string;
  turnId: string;
  origin: DeathRecord["origin"];
  deathType: string;
  location: string;
  cause?: Record<string, unknown>;
  narration?: Record<string, unknown>;
  wasUndone?: boolean;
  lifeSpentId?: string | null;
  spendLife?: boolean;
};

export type RecordObservationInput = {
  runId: string;
  playerId: string;
  turnId: string;
  text: string;
  category?: ObservationRecord["category"];
  isActive?: boolean;
  compactedInto?: string | null;
};

export type RecordSaveInput = {
  runId: string;
  turnId: string;
  turnNumber: number;
  quetzalBlob: ArrayBuffer | Blob;
};

export type UpdateRunDiscoveryInput = {
  runId: string;
  rooms?: string[];
  objects?: string[];
  npcs?: string[];
  puzzlesCompleted?: string[];
  deathsExperienced?: string[];
  currentRoom?: string;
  inventory?: string[];
  engineSaveId?: string;
  score?: number;
};

export type MarkDeathUndoneInput = {
  runId: string;
  deathId: string;
  lifeSpentId?: string;
};

export type EndRunInput = {
  runId: string;
  reason: RunRecord["ended_reason"];
  summary?: string;
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function createSchemaMetaRecord(): SchemaMetaRecord {
  return {
    id: "schema_meta",
    current_version: WIKI_SCHEMA_VERSION,
    migrations_applied: [],
    last_export_at: null,
    last_export_format: null,
    diagnostics: {
      total_storage_bytes: 0,
      last_compaction_at: null,
    },
  };
}

function createStores(database: IDBPDatabase<ZorkishWikiDB>) {
  if (!database.objectStoreNames.contains("player")) {
    database.createObjectStore("player", { keyPath: "player_id" });
  }

  if (!database.objectStoreNames.contains("runs")) {
    database.createObjectStore("runs", { keyPath: "run_id" });
  }

  if (!database.objectStoreNames.contains("turns")) {
    const turns = database.createObjectStore("turns", { keyPath: "turn_id" });
    turns.createIndex("by-run-turn", ["run_id", "turn_number"]);
    turns.createIndex("by-player", "player_id");
  }

  if (!database.objectStoreNames.contains("deaths")) {
    const deaths = database.createObjectStore("deaths", {
      keyPath: "death_id",
    });
    deaths.createIndex("by-run", "run_id");
    deaths.createIndex("by-player", "player_id");
    deaths.createIndex("by-death-type", "death_type");
  }

  if (!database.objectStoreNames.contains("observations")) {
    const observations = database.createObjectStore("observations", {
      keyPath: "observation_id",
    });
    observations.createIndex("by-run", "run_id");
    observations.createIndex("by-active", "is_active");
  }

  if (!database.objectStoreNames.contains("saves")) {
    const saves = database.createObjectStore("saves", { keyPath: "save_id" });
    saves.createIndex("by-run-turn", ["run_id", "turn_number"]);
  }

  if (!database.objectStoreNames.contains("schema_meta")) {
    database.createObjectStore("schema_meta", { keyPath: "id" });
  }
}

export async function initWiki() {
  if (!dbPromise) {
    dbPromise = openDB<ZorkishWikiDB>(WIKI_DB_NAME, WIKI_SCHEMA_VERSION, {
      upgrade(database) {
        createStores(database);
      },
    });
  }

  const database = await dbPromise;
  const existingMeta = await database.get("schema_meta", "schema_meta");

  if (!existingMeta) {
    await database.put("schema_meta", createSchemaMetaRecord());
  }

  return database;
}

function createPlayerRecord(options: CreatePlayerOptions = {}): PlayerRecord {
  const now = Date.now();
  const defaultVoice = options.defaultVoice ?? DEFAULT_VOICE;

  return {
    player_id: options.playerId ?? createId("player"),
    created_at: now,
    last_active_at: now,
    preferences: {
      default_voice: defaultVoice,
      default_disposition:
        options.defaultDisposition ?? DEFAULT_DISPOSITION,
      audio_enabled: options.audioEnabled ?? true,
    },
    stats: {
      total_runs: 0,
      total_turns: 0,
      total_deaths: 0,
      wins: 0,
      favorite_voice: defaultVoice,
      first_run_at: null,
      first_win_at: null,
    },
    player_profile: options.playerProfile ?? "",
    schema_version: 1,
  };
}

export async function getOrCreatePlayer(options: CreatePlayerOptions = {}) {
  const database = await initWiki();
  const playerId = options.playerId ?? "local-player";
  const existingPlayer = await database.get("player", playerId);

  if (existingPlayer) {
    return existingPlayer;
  }

  const player = createPlayerRecord({
    ...options,
    playerId,
  });
  await database.put("player", player);
  return player;
}

export async function createRun(input: CreateRunInput) {
  const database = await initWiki();
  const now = Date.now();
  const player = await getOrCreatePlayer({ playerId: input.playerId });
  const livesInitial = input.livesInitial ?? (input.isHardcore ? 1 : 3);
  const run: RunRecord = {
    run_id: createId("run"),
    player_id: player.player_id,
    started_at: now,
    ended_at: null,
    ended_reason: null,
    voice: input.voice ?? player.preferences.default_voice,
    disposition: input.disposition ?? player.preferences.default_disposition,
    lives_initial: livesInitial,
    lives_remaining: livesInitial,
    is_hardcore: input.isHardcore ?? false,
    is_new_game_plus: input.isNewGamePlus ?? false,
    ngp_source_run_id: input.ngpSourceRunId ?? null,
    stats: {
      turn_count: 0,
      death_count: 0,
      lives_spent: 0,
      score: 0,
      rooms_discovered: 0,
      objects_discovered: 0,
      hints_received: 0,
      off_rails_attempts: 0,
      injection_attempts: 0,
    },
    discovered: {
      rooms: [],
      objects: [],
      npcs: [],
      puzzles_completed: [],
      deaths_experienced: [],
    },
    current_state: {
      current_room: input.currentRoom ?? "unknown",
      inventory: input.inventory ?? [],
      engine_save_id: input.engineSaveId ?? "",
      last_input_at: now,
    },
    ended_summary: "",
    schema_version: 1,
  };

  const tx = database.transaction(["player", "runs"], "readwrite");
  const playerForUpdate = await tx.objectStore("player").get(player.player_id);
  if (playerForUpdate) {
    playerForUpdate.last_active_at = now;
    playerForUpdate.stats.total_runs += 1;
    playerForUpdate.stats.favorite_voice = run.voice;
    playerForUpdate.stats.first_run_at ??= now;
    await tx.objectStore("player").put(playerForUpdate);
  }
  await tx.objectStore("runs").put(run);
  await tx.done;

  return run;
}

export async function getRun(runId: string) {
  const database = await initWiki();
  return database.get("runs", runId);
}

export async function getMostRecentResumableRun(playerId: string) {
  const database = await initWiki();
  const runs = await database.getAll("runs");

  return (
    runs
      .filter(
        (run) =>
          run.player_id === playerId &&
          run.ended_at === null &&
          run.stats.turn_count > 0,
      )
      .sort(
        (left, right) =>
          right.current_state.last_input_at - left.current_state.last_input_at,
      )[0] ?? null
  );
}

export async function recordTurn(input: RecordTurnInput) {
  const database = await initWiki();
  const now = Date.now();
  const turn: TurnRecord = {
    turn_id: createId("turn"),
    run_id: input.runId,
    player_id: input.playerId,
    turn_number: input.turnNumber,
    timestamp: now,
    player_input: input.playerInput,
    intent_mapping: input.intentMapping ?? {},
    engine_responses: input.engineResponses ?? [],
    narration: input.narration ?? {},
    engine_save_id: input.engineSaveId ?? "",
    wiki_context_used: input.wikiContextUsed ?? {},
    outcome: input.outcome ?? {},
    schema_version: 1,
  };

  const tx = database.transaction(["player", "runs", "turns"], "readwrite");
  const [player, run] = await Promise.all([
    tx.objectStore("player").get(input.playerId),
    tx.objectStore("runs").get(input.runId),
  ]);

  if (player) {
    player.last_active_at = now;
    player.stats.total_turns += 1;
    await tx.objectStore("player").put(player);
  }

  if (run) {
    run.stats.turn_count = Math.max(run.stats.turn_count, input.turnNumber);
    run.current_state.engine_save_id = turn.engine_save_id;
    run.current_state.last_input_at = now;
    await tx.objectStore("runs").put(run);
  }

  await tx.objectStore("turns").put(turn);
  await tx.done;

  return turn;
}

export async function mergeTurnOutcome(
  turnId: string,
  outcomePatch: Record<string, unknown>,
) {
  const database = await initWiki();
  const tx = database.transaction("turns", "readwrite");
  const turn = await tx.store.get(turnId);

  if (!turn) {
    await tx.done;
    return null;
  }

  turn.outcome = {
    ...turn.outcome,
    ...outcomePatch,
  };
  await tx.store.put(turn);
  await tx.done;

  return turn;
}

export async function getRecentTurns(runId: string, limit = 10) {
  const database = await initWiki();
  const turns: TurnRecord[] = [];
  let cursor = await database
    .transaction("turns")
    .store.index("by-run-turn")
    .openCursor(IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]), "prev");

  while (cursor && turns.length < limit) {
    turns.push(cursor.value);
    cursor = await cursor.continue();
  }

  return turns;
}

export async function getTurnsForRun(runId: string) {
  const database = await initWiki();
  const turns: TurnRecord[] = [];
  let cursor = await database
    .transaction("turns")
    .store.index("by-run-turn")
    .openCursor(
      IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]),
      "next",
    );

  while (cursor) {
    turns.push(cursor.value);
    cursor = await cursor.continue();
  }

  return turns;
}

export async function recordDeath(input: RecordDeathInput) {
  const database = await initWiki();
  const now = Date.now();
  const death: DeathRecord = {
    death_id: createId("death"),
    run_id: input.runId,
    player_id: input.playerId,
    turn_id: input.turnId,
    occurred_at: now,
    origin: input.origin,
    death_type: input.deathType,
    location: input.location,
    cause: input.cause ?? {},
    narration: input.narration ?? {},
    was_undone: input.wasUndone ?? false,
    life_spent_id: input.lifeSpentId ?? null,
    schema_version: 1,
  };

  const tx = database.transaction(["player", "runs", "deaths"], "readwrite");
  const [player, run] = await Promise.all([
    tx.objectStore("player").get(input.playerId),
    tx.objectStore("runs").get(input.runId),
  ]);

  if (player) {
    player.last_active_at = now;
    player.stats.total_deaths += 1;
    await tx.objectStore("player").put(player);
  }

  if (run) {
    run.stats.death_count += 1;
    if (input.spendLife) {
      run.stats.lives_spent += 1;
      run.lives_remaining = Math.max(0, run.lives_remaining - 1);
    }
    if (!run.discovered.deaths_experienced.includes(input.deathType)) {
      run.discovered.deaths_experienced.push(input.deathType);
    }
    await tx.objectStore("runs").put(run);
  }

  await tx.objectStore("deaths").put(death);
  await tx.done;

  return death;
}

export async function markDeathUndoneAndSpendLife(
  input: MarkDeathUndoneInput,
) {
  const database = await initWiki();
  const tx = database.transaction(["runs", "deaths"], "readwrite");
  const [run, death] = await Promise.all([
    tx.objectStore("runs").get(input.runId),
    tx.objectStore("deaths").get(input.deathId),
  ]);

  if (!run || !death) {
    await tx.done;
    return {
      ok: false as const,
      reason: "missing_record" as const,
      run: run ?? null,
      death: death ?? null,
    };
  }

  if (run.lives_remaining <= 0) {
    await tx.done;
    return {
      ok: false as const,
      reason: "no_lives" as const,
      run,
      death,
    };
  }

  if (!death.was_undone) {
    death.was_undone = true;
    death.life_spent_id = input.lifeSpentId ?? createId("life_spent");
    run.stats.lives_spent += 1;
    run.lives_remaining = Math.max(0, run.lives_remaining - 1);
    await Promise.all([
      tx.objectStore("deaths").put(death),
      tx.objectStore("runs").put(run),
    ]);
  }

  await tx.done;

  return {
    ok: true as const,
    run,
    death,
  };
}

export async function getDeathsForRun(runId: string) {
  const database = await initWiki();
  return database.getAllFromIndex("deaths", "by-run", runId);
}

export async function getDeathsForPlayer(playerId: string) {
  const database = await initWiki();
  return database.getAllFromIndex("deaths", "by-player", playerId);
}

export async function recordObservation(input: RecordObservationInput) {
  const database = await initWiki();
  const observation: ObservationRecord = {
    observation_id: createId("observation"),
    run_id: input.runId,
    player_id: input.playerId,
    turn_id: input.turnId,
    created_at: Date.now(),
    text: input.text,
    category: input.category ?? "other",
    is_active: input.isActive ?? true,
    compacted_into: input.compactedInto ?? null,
    schema_version: 1,
  };

  await database.put("observations", observation);
  return observation;
}

export async function getActiveObservations(runId: string) {
  const database = await initWiki();
  const observations = await database.getAllFromIndex(
    "observations",
    "by-run",
    runId,
  );

  return observations.filter((observation) => observation.is_active);
}

export async function recordSave(input: RecordSaveInput) {
  const database = await initWiki();
  const blobSizeBytes =
    input.quetzalBlob instanceof Blob
      ? input.quetzalBlob.size
      : input.quetzalBlob.byteLength;
  const save: SaveRecord = {
    save_id: createId("save"),
    run_id: input.runId,
    turn_id: input.turnId,
    turn_number: input.turnNumber,
    created_at: Date.now(),
    quetzal_blob: input.quetzalBlob,
    blob_size_bytes: blobSizeBytes,
    schema_version: 1,
  };

  await database.put("saves", save);
  return save;
}

export async function getLatestSaveForRun(runId: string) {
  const database = await initWiki();
  const cursor = await database
    .transaction("saves")
    .store.index("by-run-turn")
    .openCursor(IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]), "prev");

  return cursor?.value ?? null;
}

export async function updateRunDiscovery(input: UpdateRunDiscoveryInput) {
  const database = await initWiki();
  const tx = database.transaction("runs", "readwrite");
  const run = await tx.store.get(input.runId);

  if (!run) {
    await tx.done;
    return null;
  }

  addUnique(run.discovered.rooms, input.rooms);
  addUnique(run.discovered.objects, input.objects);
  addUnique(run.discovered.npcs, input.npcs);
  addUnique(run.discovered.puzzles_completed, input.puzzlesCompleted);
  addUnique(run.discovered.deaths_experienced, input.deathsExperienced);

  run.stats.rooms_discovered = run.discovered.rooms.length;
  run.stats.objects_discovered = run.discovered.objects.length;
  run.current_state.current_room =
    input.currentRoom ?? run.current_state.current_room;
  run.current_state.inventory = input.inventory ?? run.current_state.inventory;
  run.current_state.engine_save_id =
    input.engineSaveId ?? run.current_state.engine_save_id;
  run.current_state.last_input_at = Date.now();
  run.stats.score = input.score ?? run.stats.score;

  await tx.store.put(run);
  await tx.done;

  return run;
}

export async function endRun(input: EndRunInput) {
  const database = await initWiki();
  const tx = database.transaction("runs", "readwrite");
  const run = await tx.store.get(input.runId);

  if (!run) {
    await tx.done;
    return null;
  }

  run.ended_at = Date.now();
  run.ended_reason = input.reason;
  run.ended_summary = input.summary ?? run.ended_summary;
  if (input.reason === "death" || input.reason === "hardcore_reset") {
    run.lives_remaining = 0;
  }

  await tx.store.put(run);
  await tx.done;

  return run;
}

function addUnique(target: string[], values: string[] | undefined) {
  if (!values) {
    return;
  }

  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}
