import type {
  GameData,
  GameDataObject,
  GameDataRoom,
} from "../llm/types";
import type { TurnRecord } from "../wiki/schema";

let gameDataPromise: Promise<GameData> | null = null;

export type VisibleObjectContext = {
  id: string;
  name: string;
  description: string;
  is_container: boolean;
  is_takeable: boolean;
  is_npc: boolean;
  synonyms: string[];
  adjectives: string[];
};

export type RuntimeContext = {
  currentRoomId: string;
  inventory: string[];
  livesRemaining: number;
  previousActionWasFatal: boolean;
  mostRecentEngineResponse: string | null;
  recentTurns: TurnRecord[];
  activeObservations: string[];
};

export async function loadGameData() {
  gameDataPromise ??= fetch("/zork1-game-data.json").then((response) => {
    if (!response.ok) {
      throw new Error(`Could not load game data: ${response.status}`);
    }
    return response.json() as Promise<GameData>;
  });

  return gameDataPromise;
}

export function getRoom(gameData: GameData, roomId: string) {
  return gameData.rooms[roomId] ?? gameData.rooms["WEST-OF-HOUSE"];
}

export function detectRoomIdFromOutput(text: string, gameData: GameData) {
  const roomNameToId = new Map(
    Object.entries(gameData.rooms).map(([roomId, room]) => [
      normalizeRoomTitle(room.name),
      roomId,
    ]),
  );

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeRoomTitle(rawLine);
    const roomId = roomNameToId.get(line);
    if (roomId) {
      return roomId;
    }
  }

  return null;
}

export function getVisibleObjectIds(
  gameData: GameData,
  roomId: string,
  inventory: string[],
) {
  const room = getRoom(gameData, roomId);
  if (!room) {
    return inventory;
  }

  return Array.from(new Set([...room.objects_starting_here, ...inventory]));
}

export function getVisibleObjects(
  gameData: GameData,
  roomId: string,
  inventory: string[],
) {
  return getVisibleObjectIds(gameData, roomId, inventory)
    .map((objectId) => objectToContext(objectId, gameData.objects[objectId]))
    .filter((object) => object !== null);
}

export function getAdjacentRooms(gameData: GameData, room: GameDataRoom) {
  return Object.fromEntries(
    Object.entries(room.exits)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([direction, roomId]) => [
        direction,
        {
          id: roomId,
          name: gameData.rooms[roomId]?.name ?? roomId,
        },
      ]),
  );
}

export function applyInventoryGuess(
  command: string,
  responseText: string,
  inventory: string[],
  gameData: GameData,
) {
  const objectId = findObjectIdInCommand(command, gameData);
  if (!objectId) {
    return inventory;
  }

  const commandVerb = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const response = responseText.toLowerCase();

  if (
    ["take", "get", "pick", "grab"].includes(commandVerb) &&
    (response.includes("taken.") || response.includes("already taken"))
  ) {
    return Array.from(new Set([...inventory, objectId]));
  }

  if (
    ["drop", "discard"].includes(commandVerb) &&
    (response.includes("dropped.") || response.includes("you drop"))
  ) {
    return inventory.filter((item) => item !== objectId);
  }

  return inventory;
}

export function summarizeTurnForContext(turn: TurnRecord) {
  const engineSummary = turn.engine_responses
    .map((response) => String(response.text ?? response.response ?? ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
  const narration = String(turn.narration.text ?? turn.narration.narration ?? "");

  return {
    turn_number: turn.turn_number,
    player_input: turn.player_input,
    intent: String(turn.intent_mapping.intent ?? "unknown"),
    engine_summary: engineSummary,
    narration_summary: narration.slice(0, 500),
  };
}

function objectToContext(
  objectId: string,
  object: GameDataObject | undefined,
): VisibleObjectContext | null {
  if (!object) {
    return null;
  }

  return {
    id: objectId,
    name: object.name,
    description: object.description,
    is_container: object.is_container,
    is_takeable: object.is_takeable,
    is_npc: object.is_npc,
    synonyms: object.synonyms ?? [],
    adjectives: object.adjectives ?? [],
  };
}

function findObjectIdInCommand(command: string, gameData: GameData) {
  const normalizedCommand = normalizeObjectPhrase(command);
  const candidates = Object.entries(gameData.objects)
    .flatMap(([objectId, object]) =>
      getObjectTerms(objectId, object).map((term) => ({ objectId, term })),
    )
    .sort((left, right) => right.term.length - left.term.length);

  return (
    candidates.find(({ term }) => normalizedCommand.includes(term))?.objectId ??
    null
  );
}

function getObjectTerms(objectId: string, object: GameDataObject) {
  return Array.from(
    new Set([
      objectId,
      object.name,
      ...(object.synonyms ?? []),
      ...(object.adjectives ?? []).map(
        (adjective) => `${adjective} ${object.name}`,
      ),
    ]),
  )
    .map(normalizeObjectPhrase)
    .filter(Boolean);
}

function normalizeRoomTitle(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeObjectPhrase(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
