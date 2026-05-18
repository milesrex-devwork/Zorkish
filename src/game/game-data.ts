import type {
  GameData,
  GameDataObject,
  GameDataRoom,
} from "../llm/types";
import type { EngineCommandResponse } from "../engine/types";
import type { TurnRecord } from "../wiki/schema";

let gameDataPromise: Promise<GameData> | null = null;

export type VisibleObjectContext = {
  id: string;
  name: string;
  description: string;
  containing_object_id: string | null;
  is_container: boolean;
  is_takeable: boolean;
  is_npc: boolean;
  container_state: ContainerState;
  contents_visible: boolean;
  synonyms: string[];
  adjectives: string[];
};

export type ContainerState = "open" | "closed" | "surface" | "transparent" | "unknown";
export type ContainerStateMap = Record<string, ContainerState>;

export type RuntimeContext = {
  currentRoomId: string;
  inventory: string[];
  containerStates: ContainerStateMap;
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

export function detectRoomIdFromEngineResponse(
  response: Pick<EngineCommandResponse, "text" | "rawUpdate">,
  gameData: GameData,
) {
  return (
    detectRoomIdFromStatusWindow(response.rawUpdate, gameData) ??
    detectRoomIdFromOutput(response.text, gameData)
  );
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

function detectRoomIdFromStatusWindow(rawUpdate: unknown, gameData: GameData) {
  const roomNameToId = new Map(
    Object.entries(gameData.rooms).map(([roomId, room]) => [
      normalizeRoomTitle(room.name),
      roomId,
    ]),
  );

  for (const statusLine of readStatusLines(rawUpdate)) {
    const roomId = roomNameToId.get(normalizeStatusRoomTitle(statusLine));
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
  containerStates: ContainerStateMap = getInitialContainerStates(gameData),
) {
  const visibleIds = new Set(inventory);
  const stack = getDirectRoomObjectIds(gameData, roomId);

  for (const objectId of stack) {
    revealObjectAndVisibleContents(
      gameData,
      objectId,
      containerStates,
      visibleIds,
      new Set(),
    );
  }

  for (const objectId of inventory) {
    revealVisibleContents(
      gameData,
      objectId,
      containerStates,
      visibleIds,
      new Set([objectId]),
    );
  }

  return Array.from(visibleIds);
}

export function getVisibleObjects(
  gameData: GameData,
  roomId: string,
  inventory: string[],
  containerStates: ContainerStateMap = getInitialContainerStates(gameData),
) {
  return getVisibleObjectIds(gameData, roomId, inventory, containerStates)
    .map((objectId) =>
      objectToContext(
        objectId,
        gameData.objects[objectId],
        getObjectContainerId(gameData, objectId),
        containerStates,
      ),
    )
    .filter((object) => object !== null);
}

export function getInitialContainerStates(gameData: GameData): ContainerStateMap {
  return Object.fromEntries(
    Object.entries(gameData.objects)
      .filter((entry) => entry[1].is_container)
      .map(([objectId, object]) => [objectId, getStaticContainerState(object)]),
  );
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
  roomId?: string,
) {
  const preferredObjectIds = roomId
    ? getVisibleObjectIds(gameData, roomId, inventory)
    : inventory;
  const objectId = findObjectIdInCommand(command, gameData, preferredObjectIds);
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

export function applyContainerStateGuess(
  command: string,
  responseText: string,
  containerStates: ContainerStateMap,
  gameData: GameData,
  roomId: string,
  inventory: string[],
): ContainerStateMap {
  const commandVerb = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!["open", "close", "shut"].includes(commandVerb)) {
    return containerStates;
  }

  const candidateIds = getVisibleObjectIds(
    gameData,
    roomId,
    inventory,
    containerStates,
  ).filter((objectId) => gameData.objects[objectId]?.is_container);
  const objectId = findObjectIdInCommand(command, gameData, candidateIds);
  if (!objectId) {
    return containerStates;
  }

  const response = responseText.toLowerCase();
  if (commandVerb === "open" && looksLikeOpenSucceeded(response)) {
    return {
      ...containerStates,
      [objectId]: "open",
    };
  }

  if (["close", "shut"].includes(commandVerb) && looksLikeCloseSucceeded(response)) {
    return {
      ...containerStates,
      [objectId]: "closed",
    };
  }

  return containerStates;
}

function looksLikeOpenSucceeded(response: string) {
  return (
    response.includes("opened") ||
    response.includes("you open") ||
    response.includes("is open") ||
    response.includes("already open") ||
    response.includes("reveals")
  );
}

function looksLikeCloseSucceeded(response: string) {
  return (
    response.includes("closed") ||
    response.includes("you close") ||
    response.includes("you shut") ||
    response.includes("already closed")
  );
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
  containingObjectId: string | null,
  containerStates: ContainerStateMap,
): VisibleObjectContext | null {
  if (!object) {
    return null;
  }

  const containerState = object.is_container
    ? (containerStates[objectId] ?? getStaticContainerState(object))
    : "unknown";

  return {
    id: objectId,
    name: object.name,
    description: object.description,
    containing_object_id: containingObjectId,
    is_container: object.is_container,
    is_takeable: object.is_takeable,
    is_npc: object.is_npc,
    container_state: containerState,
    contents_visible: canSeeContainerContents(object, containerState),
    synonyms: object.synonyms ?? [],
    adjectives: object.adjectives ?? [],
  };
}

function revealObjectAndVisibleContents(
  gameData: GameData,
  objectId: string,
  containerStates: ContainerStateMap,
  visibleIds: Set<string>,
  visitedIds: Set<string>,
) {
  if (visitedIds.has(objectId) || !gameData.objects[objectId]) {
    return;
  }

  visibleIds.add(objectId);
  revealVisibleContents(
    gameData,
    objectId,
    containerStates,
    visibleIds,
    new Set([...visitedIds, objectId]),
  );
}

function revealVisibleContents(
  gameData: GameData,
  containerId: string,
  containerStates: ContainerStateMap,
  visibleIds: Set<string>,
  visitedIds: Set<string>,
) {
  const container = gameData.objects[containerId];
  if (!container?.is_container) {
    return;
  }

  const state = containerStates[containerId] ?? getStaticContainerState(container);
  if (!canSeeContainerContents(container, state)) {
    return;
  }

  for (const childId of getChildObjectIds(gameData, containerId)) {
    revealObjectAndVisibleContents(
      gameData,
      childId,
      containerStates,
      visibleIds,
      visitedIds,
    );
  }
}

function getDirectRoomObjectIds(gameData: GameData, roomId: string) {
  return Object.entries(gameData.objects)
    .filter(([, object]) => object.starting_location === roomId)
    .map(([objectId]) => objectId);
}

function getChildObjectIds(gameData: GameData, containerId: string) {
  return Object.entries(gameData.objects)
    .filter(([, object]) => object.starting_location === containerId)
    .map(([objectId]) => objectId);
}

function getObjectContainerId(gameData: GameData, objectId: string) {
  const startingLocation = gameData.objects[objectId]?.starting_location ?? null;
  return startingLocation && gameData.objects[startingLocation]
    ? startingLocation
    : null;
}

function getStaticContainerState(object: GameDataObject): ContainerState {
  const flags = object.flags ?? [];
  if (flags.includes("SURFACEBIT")) {
    return "surface";
  }
  if (flags.includes("TRANSBIT")) {
    return "transparent";
  }
  if (flags.includes("OPENBIT")) {
    return "open";
  }
  if (object.is_container) {
    return "closed";
  }

  return "unknown";
}

function canSeeContainerContents(
  object: GameDataObject,
  state: ContainerState,
) {
  if (!object.is_container) {
    return false;
  }

  return state === "open" || state === "surface" || state === "transparent";
}

function findObjectIdInCommand(
  command: string,
  gameData: GameData,
  preferredObjectIds: string[],
) {
  const normalizedCommand = normalizeObjectPhrase(command);
  const preferredMatch = findObjectIdInCandidates(
    normalizedCommand,
    preferredObjectIds
      .map((objectId) => [objectId, gameData.objects[objectId]] as const)
      .filter((entry): entry is readonly [string, GameDataObject] => entry[1] !== undefined),
  );

  if (preferredMatch) {
    return preferredMatch;
  }

  return findObjectIdInCandidates(
    normalizedCommand,
    Object.entries(gameData.objects),
  );
}

function findObjectIdInCandidates(
  normalizedCommand: string,
  objects: ReadonlyArray<readonly [string, GameDataObject]>,
) {
  const candidates = objects
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

function normalizeStatusRoomTitle(value: string) {
  return normalizeRoomTitle(
    value
      .replace(/\s+(Score|Moves|Time):.*$/i, "")
      .replace(/\s{2,}.*/, ""),
  );
}

function normalizeObjectPhrase(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readStatusLines(rawUpdate: unknown) {
  if (!isRecord(rawUpdate) || !Array.isArray(rawUpdate.content)) {
    return [];
  }

  const lines: string[] = [];
  for (const content of rawUpdate.content) {
    if (!isRecord(content) || !Array.isArray(content.lines)) {
      continue;
    }

    for (const line of content.lines) {
      if (!isRecord(line) || !Array.isArray(line.content)) {
        continue;
      }

      const text = line.content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
      if (text.trim()) {
        lines.push(text);
      }
    }
  }

  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
