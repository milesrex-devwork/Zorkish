import { openDB, type IDBPDatabase } from "idb";
import {
  WIKI_DB_NAME,
  WIKI_SCHEMA_VERSION,
  type SchemaMetaRecord,
  type ZorkishWikiDB,
} from "./schema";

let dbPromise: Promise<IDBPDatabase<ZorkishWikiDB>> | null = null;

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

