import type { DBSchema } from "idb";

export const WIKI_DB_NAME = "zorkish-wiki";
export const WIKI_SCHEMA_VERSION = 1;

export type VoiceId = "modernized_classic";
export type Helpfulness = "generous" | "middle" | "cruel" | "hardcore";
export type Playfulness = "dry" | "moderate" | "unhinged";

export interface Disposition {
  helpfulness: Helpfulness;
  playfulness: Playfulness;
}

export interface PlayerRecord {
  player_id: string;
  created_at: number;
  last_active_at: number;
  preferences: {
    default_voice: VoiceId;
    default_disposition: Disposition;
    audio_enabled: boolean;
  };
  stats: {
    total_runs: number;
    total_turns: number;
    total_deaths: number;
    wins: number;
    favorite_voice: VoiceId;
    first_run_at: number | null;
    first_win_at: number | null;
  };
  player_profile: string;
  schema_version: 1;
}

export interface RunRecord {
  run_id: string;
  player_id: string;
  started_at: number;
  ended_at: number | null;
  ended_reason: "win" | "death" | "abandoned" | "hardcore_reset" | null;
  voice: VoiceId;
  disposition: Disposition;
  lives_initial: number;
  lives_remaining: number;
  is_hardcore: boolean;
  is_new_game_plus: boolean;
  ngp_source_run_id: string | null;
  stats: {
    turn_count: number;
    death_count: number;
    lives_spent: number;
    score: number;
    rooms_discovered: number;
    objects_discovered: number;
    hints_received: number;
    off_rails_attempts: number;
    injection_attempts: number;
  };
  discovered: {
    rooms: string[];
    objects: string[];
    npcs: string[];
    puzzles_completed: string[];
    deaths_experienced: string[];
  };
  current_state: {
    current_room: string;
    inventory: string[];
    engine_save_id: string;
    last_input_at: number;
  };
  ended_summary: string;
  schema_version: 1;
}

export interface TurnRecord {
  turn_id: string;
  run_id: string;
  player_id: string;
  turn_number: number;
  timestamp: number;
  player_input: string;
  intent_mapping: Record<string, unknown>;
  engine_responses: Array<Record<string, unknown>>;
  narration: Record<string, unknown>;
  engine_save_id: string;
  wiki_context_used: Record<string, unknown>;
  outcome: Record<string, unknown>;
  schema_version: 1;
}

export interface DeathRecord {
  death_id: string;
  run_id: string;
  player_id: string;
  turn_id: string;
  occurred_at: number;
  origin: "engine" | "creative";
  death_type: string;
  location: string;
  cause: Record<string, unknown>;
  narration: Record<string, unknown>;
  was_undone: boolean;
  life_spent_id: string | null;
  schema_version: 1;
}

export interface ObservationRecord {
  observation_id: string;
  run_id: string;
  player_id: string;
  turn_id: string;
  created_at: number;
  text: string;
  category: "pattern" | "skill" | "behavior" | "preference" | "other";
  is_active: boolean;
  compacted_into: string | null;
  schema_version: 1;
}

export interface SaveRecord {
  save_id: string;
  run_id: string;
  turn_id: string;
  turn_number: number;
  created_at: number;
  quetzal_blob: ArrayBuffer | Blob;
  blob_size_bytes: number;
  schema_version: 1;
}

export interface SchemaMetaRecord {
  id: "schema_meta";
  current_version: 1;
  migrations_applied: Array<{
    from_version: number;
    to_version: number;
    applied_at: number;
  }>;
  last_export_at: number | null;
  last_export_format: string | null;
  diagnostics: {
    total_storage_bytes: number;
    last_compaction_at: number | null;
  };
}

export interface ZorkishWikiDB extends DBSchema {
  player: {
    key: string;
    value: PlayerRecord;
  };
  runs: {
    key: string;
    value: RunRecord;
  };
  turns: {
    key: string;
    value: TurnRecord;
    indexes: {
      "by-run-turn": [string, number];
      "by-player": string;
    };
  };
  deaths: {
    key: string;
    value: DeathRecord;
    indexes: {
      "by-run": string;
      "by-player": string;
      "by-death-type": string;
    };
  };
  observations: {
    key: string;
    value: ObservationRecord;
    indexes: {
      "by-run": string;
      "by-active": number;
    };
  };
  saves: {
    key: string;
    value: SaveRecord;
    indexes: {
      "by-run-turn": [string, number];
    };
  };
  schema_meta: {
    key: string;
    value: SchemaMetaRecord;
  };
}
