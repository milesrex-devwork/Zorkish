import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { GameDataDebugView } from "./components/GameDataDebugView";
import { WikiDebugView } from "./components/WikiDebugView";
import {
  applyInventoryGuess,
  detectRoomIdFromEngineResponse,
  getRoom,
  getVisibleObjectIds,
  loadGameData,
  type RuntimeContext,
} from "./game/game-data";
import { ZMachineEngineClient } from "./engine/engine-client";
import { mapPlayerInputToIntent } from "./llm/intent-mapper";
import {
  narrateTurn,
  type ExecutedEngineResponse,
  type NarrationResult,
} from "./llm/narrator";
import {
  createRun,
  getActiveObservations,
  getOrCreatePlayer,
  getRecentTurns,
  recordObservation,
  recordTurn,
  updateRunDiscovery,
} from "./wiki/access";
import type { RunRecord, TurnRecord } from "./wiki/schema";

const GAMEPLAY_PLAYER_ID = "local-player";
const START_ROOM_ID = "WEST-OF-HOUSE";

let hasLoggedWikiInitialization = false;

type TerminalEntry = {
  id: number;
  kind: "engine" | "player" | "system" | "narration";
  text: string;
};

type TurnTimingLog = {
  turn_number: number;
  player_input: string;
  intent_ms: number;
  intent_proxy_upstream_ms: number | null;
  intent_browser_request_ms: number | null;
  narration_ms: number;
  narration_first_token_ms: number | null;
  narration_browser_request_ms: number | null;
};

declare global {
  interface Window {
    __zorkishTimingLog?: TurnTimingLog[];
  }
}

export default function App() {
  const engineRef = useRef<ZMachineEngineClient | null>(null);
  const nextEntryId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const currentRoomIdRef = useRef(START_ROOM_ID);
  const inventoryRef = useRef<string[]>([]);
  const previousActionWasFatalRef = useRef(false);
  const mostRecentEngineResponseRef = useRef<string | null>(null);
  const activeObservationsRef = useRef<string[]>([]);
  const recentTurnsRef = useRef<TurnRecord[]>([]);
  const runRef = useRef<RunRecord | null>(null);
  const turnNumberRef = useRef(1);

  const [wikiError, setWikiError] = useState(false);
  const [input, setInput] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [statusText, setStatusText] = useState("Starting engine...");
  const [entries, setEntries] = useState<TerminalEntry[]>([
    {
      id: 0,
      kind: "system",
      text: "Loading the Z-machine...",
    },
  ]);

  const prepareGameplayRun = useCallback(async (initialRoomId: string) => {
    try {
      const player = await getOrCreatePlayer({
        playerId: GAMEPLAY_PLAYER_ID,
        playerProfile: "Zorkish local browser player",
      });
      if (!hasLoggedWikiInitialization) {
        console.log("IndexedDB initialized");
        hasLoggedWikiInitialization = true;
      }

      const run = await createRun({
        playerId: player.player_id,
        livesInitial: 3,
        currentRoom: initialRoomId,
        inventory: [],
        engineSaveId: "checkpoint5-session-start",
      });
      runRef.current = run;
      turnNumberRef.current = 1;
      recentTurnsRef.current = await getRecentTurns(run.run_id, 10);
      activeObservationsRef.current = (
        await getActiveObservations(run.run_id)
      ).map((observation) => observation.text);
    } catch (error) {
      console.error("Wiki gameplay run setup failed", error);
      setWikiError(true);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const engine = new ZMachineEngineClient();
    engineRef.current = engine;

    engine
      .init()
      .then(async (response) => {
        if (!isMounted) {
          return;
        }

        const gameData = await loadGameData();
        const detectedRoomId =
          detectRoomIdFromEngineResponse(response, gameData) ?? START_ROOM_ID;
        currentRoomIdRef.current = detectedRoomId;
        mostRecentEngineResponseRef.current = response.text;

        setEntries([{ id: nextEntryId.current++, kind: "engine", text: response.text }]);
        setStatusText(`Room: ${getRoom(gameData, detectedRoomId)?.name ?? detectedRoomId}`);
        setIsReady(true);
        setIsRunning(false);

        await prepareGameplayRun(detectedRoomId);
      })
      .catch((error: unknown) => {
        if (!isMounted) {
          return;
        }

        console.error("Z-machine startup failed", error);
        setEntries([
          {
            id: nextEntryId.current++,
            kind: "system",
            text: "The Z-machine could not be started.",
          },
        ]);
        setStatusText("Engine startup failed.");
        setIsRunning(false);
      });

    return () => {
      isMounted = false;
      engine.dispose();
    };
  }, [prepareGameplayRun]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const playerInput = String(formData.get("command") ?? "").trim();
    const engine = engineRef.current;
    if (!playerInput || !engine || !isReady || isRunning) {
      return;
    }

    setInput("");
    setIsRunning(true);
    appendEntry("player", `> ${playerInput}`);
    const narrationEntryId = appendEntry("narration", "");
    const turnNumber = turnNumberRef.current;
    const runtimeBeforeIntent = buildRuntimeContext();

    try {
      const intentMapping = await mapPlayerInputToIntent(
        playerInput,
        runtimeBeforeIntent,
      );
      console.log("Zorkish intent mapping", intentMapping);

      const engineResponses = await executeMappedCommands(
        intentMapping.mapping.intent,
        intentMapping.mapping.engine_commands,
        engine,
      );
      const runtimeAfterEngine = buildRuntimeContext();
      const narration = await narrateTurn(
        {
          playerInput,
          intentMapping,
          engineResponses,
          runtimeContext: runtimeAfterEngine,
        },
        (token) => appendToEntry(narrationEntryId, token),
      );

      replaceEntryText(narrationEntryId, narration.text);
      logTurnTiming({
        turnNumber,
        playerInput,
        intentMapping,
        narration,
      });
      await commitTurn({
        turnNumber,
        playerInput,
        intentMapping,
        engineResponses,
        narration,
        runtimeBeforeIntent,
      });
      turnNumberRef.current += 1;
      updateStatusFromCurrentRoom();
    } catch (error) {
      console.error("Checkpoint 5 turn failed", error);
      replaceEntryText(
        narrationEntryId,
        "Something in the machinery failed to answer. Check the proxy and console, then try again.",
      );
    } finally {
      setIsRunning(false);
    }
  }

  async function executeMappedCommands(
    intent: string,
    commands: string[],
    engine: ZMachineEngineClient,
  ) {
    if (!shouldExecuteCommands(intent)) {
      return [];
    }

    const gameData = await loadGameData();
    const responses: ExecutedEngineResponse[] = [];

    for (const command of commands) {
      const response = await engine.sendCommand(command);
      const detectedRoomId = detectRoomIdFromEngineResponse(response, gameData);
      if (detectedRoomId) {
        currentRoomIdRef.current = detectedRoomId;
      }
      responses.push({
        command,
        text: response.text,
        detected_room_id: detectedRoomId,
        current_room_id_after_command: currentRoomIdRef.current,
      });
      inventoryRef.current = applyInventoryGuess(
        command,
        response.text,
        inventoryRef.current,
        gameData,
      );
      mostRecentEngineResponseRef.current = response.text;
      previousActionWasFatalRef.current = response.text
        .toLowerCase()
        .includes("you have died");
    }

    return responses;
  }

  async function commitTurn(input: {
    turnNumber: number;
    playerInput: string;
    intentMapping: Awaited<ReturnType<typeof mapPlayerInputToIntent>>;
    engineResponses: ExecutedEngineResponse[];
    narration: NarrationResult;
    runtimeBeforeIntent: RuntimeContext;
  }) {
    const run = runRef.current;
    if (!run) {
      return;
    }

    const gameData = await loadGameData();
    const engineSaveId = `${run.run_id}-turn-${input.turnNumber}`;
    const turn = await recordTurn({
      runId: run.run_id,
      playerId: run.player_id,
      turnNumber: input.turnNumber,
      playerInput: input.playerInput,
      intentMapping: {
        model_used: input.intentMapping.model_used,
        latency_ms: input.intentMapping.latency_ms,
        proxy_timing: input.intentMapping.proxy_timing,
        context_room_id: input.intentMapping.context_room_id,
        ...input.intentMapping.mapping,
      },
      engineResponses: input.engineResponses.map((response) => ({
        command: response.command,
        text: response.text,
        detected_room_id: response.detected_room_id,
        current_room_id_after_command: response.current_room_id_after_command,
      })),
      narration: {
        text: input.narration.text,
        model_used: input.narration.model_used,
        latency_ms: input.narration.latency_ms,
        proxy_timing: input.narration.proxy_timing,
        dm_observations: input.narration.dm_observations,
        hint_level_emitted: input.narration.hint_level_emitted,
        ascii_art: input.narration.ascii_art,
        metadata: input.narration.metadata,
      },
      engineSaveId,
      wikiContextUsed: {
        recent_turn_ids: input.runtimeBeforeIntent.recentTurns.map(
          (turnRecord) => turnRecord.turn_id,
        ),
        active_observation_count: input.runtimeBeforeIntent.activeObservations.length,
      },
      outcome: {
        current_room_id: currentRoomIdRef.current,
        inventory: inventoryRef.current,
        intent: input.intentMapping.mapping.intent,
        engine_command_count: input.engineResponses.length,
      },
    });

    for (const observation of input.narration.dm_observations) {
      await recordObservation({
        runId: run.run_id,
        playerId: run.player_id,
        turnId: turn.turn_id,
        text: observation,
      });
    }

    const visibleObjectIds = getVisibleObjectIds(
      gameData,
      currentRoomIdRef.current,
      inventoryRef.current,
    );
    const visibleNpcs = visibleObjectIds.filter(
      (objectId) => gameData.objects[objectId]?.is_npc,
    );
    await updateRunDiscovery({
      runId: run.run_id,
      rooms: [currentRoomIdRef.current],
      objects: visibleObjectIds,
      npcs: visibleNpcs,
      currentRoom: currentRoomIdRef.current,
      inventory: inventoryRef.current,
      engineSaveId,
    });

    recentTurnsRef.current = [turn, ...recentTurnsRef.current].slice(0, 10);
  }

  function buildRuntimeContext(): RuntimeContext {
    return {
      currentRoomId: currentRoomIdRef.current,
      inventory: inventoryRef.current,
      livesRemaining: runRef.current?.lives_remaining ?? 3,
      previousActionWasFatal: previousActionWasFatalRef.current,
      mostRecentEngineResponse: mostRecentEngineResponseRef.current,
      recentTurns: recentTurnsRef.current,
      activeObservations: activeObservationsRef.current,
    };
  }

  function shouldExecuteCommands(intent: string) {
    return intent === "action" || intent === "recall";
  }

  async function updateStatusFromCurrentRoom() {
    const gameData = await loadGameData();
    const room = getRoom(gameData, currentRoomIdRef.current);
    setStatusText(
      `Room: ${room?.name ?? currentRoomIdRef.current} | Inventory guess: ${
        inventoryRef.current.length ? inventoryRef.current.join(", ") : "empty"
      }`,
    );
  }

  function appendEntry(kind: TerminalEntry["kind"], text: string) {
    const id = nextEntryId.current++;
    setEntries((currentEntries) => [
      ...currentEntries,
      {
        id,
        kind,
        text,
      },
    ]);
    return id;
  }

  function appendToEntry(id: number, token: string) {
    setEntries((currentEntries) =>
      currentEntries.map((entry) =>
        entry.id === id ? { ...entry, text: `${entry.text}${token}` } : entry,
      ),
    );
  }

  function replaceEntryText(id: number, text: string) {
    setEntries((currentEntries) =>
      currentEntries.map((entry) =>
        entry.id === id ? { ...entry, text } : entry,
      ),
    );
  }

  function logTurnTiming(input: {
    turnNumber: number;
    playerInput: string;
    intentMapping: Awaited<ReturnType<typeof mapPlayerInputToIntent>>;
    narration: NarrationResult;
  }) {
    const timing: TurnTimingLog = {
      turn_number: input.turnNumber,
      player_input: input.playerInput,
      intent_ms: input.intentMapping.latency_ms,
      intent_proxy_upstream_ms:
        input.intentMapping.proxy_timing?.proxy_upstream_ms ?? null,
      intent_browser_request_ms:
        input.intentMapping.proxy_timing?.browser_request_ms ?? null,
      narration_ms: input.narration.latency_ms,
      narration_first_token_ms:
        input.narration.proxy_timing.first_token_ms ?? null,
      narration_browser_request_ms:
        input.narration.proxy_timing.browser_request_ms ?? null,
    };
    window.__zorkishTimingLog = [
      ...(window.__zorkishTimingLog ?? []),
      timing,
    ];
    console.log("Zorkish turn timing", timing);
  }

  return (
    <main className="h-screen overflow-hidden bg-stone-950 text-stone-100">
      <div className="mx-auto flex h-screen max-w-5xl flex-col px-6 py-5">
        <header className="border-b border-amber-200/15 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-normal text-amber-100">
              Zorkish v0.05
            </h1>
            <p className="font-mono text-xs text-stone-400">{statusText}</p>
          </div>
        </header>
        <section
          aria-label="Game surface"
          className="flex min-h-0 flex-1 flex-col py-8"
        >
          <div
            ref={transcriptRef}
            className="min-h-0 flex-1 overflow-y-auto border border-amber-100/10 bg-stone-900/70 p-5 font-mono text-sm leading-6 shadow-2xl shadow-black/30"
          >
            {wikiError ? (
              <p className="mb-4 text-amber-100" role="alert">
                The local Wiki could not be opened. Turns will play, but may not
                persist.
              </p>
            ) : null}
            {entries.map((entry) => (
              <pre
                className={`mb-5 whitespace-pre-wrap ${
                  entry.kind === "player"
                    ? "text-amber-100"
                    : entry.kind === "system"
                      ? "text-stone-400"
                      : "text-stone-100"
                }`}
                key={entry.id}
              >
                {entry.text || (entry.kind === "narration" ? "..." : "")}
              </pre>
            ))}
          </div>
          <form className="mt-4 flex shrink-0 gap-3" onSubmit={handleSubmit}>
            <input
              aria-label="Zork command"
              autoComplete="off"
              className="min-w-0 flex-1 border border-amber-100/15 bg-stone-900 px-4 py-3 font-mono text-sm text-stone-100 outline-none transition focus:border-amber-200/60"
              disabled={!isReady || isRunning}
              name="command"
              onChange={(event) => setInput(event.target.value)}
              placeholder={isReady ? "Say what you want to do..." : "Starting engine..."}
              value={input}
            />
            <button
              className="border border-amber-100/20 px-5 py-3 text-sm font-medium text-amber-100 transition hover:border-amber-100/50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!isReady || isRunning || !input.trim()}
              type="submit"
            >
              Send
            </button>
          </form>
        </section>
        {import.meta.env.DEV ? (
          <div className="max-h-64 overflow-y-auto border-t border-amber-100/10">
            <GameDataDebugView />
            <WikiDebugView />
          </div>
        ) : null}
      </div>
    </main>
  );
}
