import type { LlmTiming } from "./client";

export const INTENT_VALUES = [
  "action",
  "undo",
  "recall",
  "off_rails_harmless",
  "off_rails_fatal",
  "injection",
  "unclear",
] as const;

export type IntentValue = (typeof INTENT_VALUES)[number];

export type IntentMappingResult = {
  intent: IntentValue;
  engine_commands: string[];
  off_rails_flavor: string | null;
  undo_request: {
    is_undo: boolean;
    target_action_index: number | null;
    is_death_undo: boolean;
  };
  recall_request: {
    is_recall: boolean;
    topic: "inventory" | "history" | "deaths" | "hints" | "lives" | "other" | null;
  };
  creative_death: {
    proposed: boolean;
    reason: string | null;
    method: string | null;
  };
  injection_attempt: {
    detected: boolean;
    severity: "low" | "medium" | "high" | null;
  };
  clarification_needed: string | null;
  reasoning: string;
};

export type IntentMappingDebugResult = {
  model_used: string;
  latency_ms: number;
  proxy_timing: LlmTiming | null;
  context_room_id: string;
  mapping: IntentMappingResult;
};

export type GameDataRoom = {
  name: string;
  description: string;
  exits: Record<string, string | null>;
  is_dark: boolean;
  objects_starting_here: string[];
};

export type GameDataObject = {
  name: string;
  description: string;
  starting_location: string | null;
  is_container: boolean;
  is_takeable: boolean;
  is_npc: boolean;
  synonyms?: string[];
  adjectives?: string[];
};

export type GameData = {
  schema_version: 1;
  rooms: Record<string, GameDataRoom>;
  objects: Record<string, GameDataObject>;
  verbs: string[];
  verb_object_combinations: Array<{
    verb: string;
    preposition: string;
  }>;
};
