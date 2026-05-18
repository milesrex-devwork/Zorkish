import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
import type { IntentValue } from "./llm/types";
import {
  createRun,
  endRun,
  getActiveObservations,
  getRun,
  getOrCreatePlayer,
  getRecentTurns,
  markDeathUndoneAndSpendLife,
  mergeTurnOutcome,
  recordDeath,
  recordObservation,
  recordTurn,
  updateRunDiscovery,
} from "./wiki/access";
import type { DeathRecord, RunRecord, TurnRecord } from "./wiki/schema";

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

type TurnIntentMapping = Awaited<ReturnType<typeof mapPlayerInputToIntent>>;

type UndoSnapshot = {
  commandHistory: string[];
  roomId: string;
  inventory: string[];
  previousActionWasFatal: boolean;
  mostRecentEngineResponse: string | null;
  label: string;
};

type DeathPromptState = {
  deathId: string;
  deathType: string;
  locationId: string;
  livesRemaining: number;
  snapshot: UndoSnapshot;
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
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const currentRoomIdRef = useRef(START_ROOM_ID);
  const inventoryRef = useRef<string[]>([]);
  const previousActionWasFatalRef = useRef(false);
  const mostRecentEngineResponseRef = useRef<string | null>(null);
  const committedEngineCommandsRef = useRef<string[]>([]);
  const lastUndoSnapshotRef = useRef<UndoSnapshot | null>(null);
  const queuedCommandsRef = useRef<string[]>([]);
  const isProcessingCommandRef = useRef(false);
  const scrollbarFadeTimeoutRef = useRef<number | null>(null);
  const activeObservationsRef = useRef<string[]>([]);
  const recentTurnsRef = useRef<TurnRecord[]>([]);
  const runRef = useRef<RunRecord | null>(null);
  const turnNumberRef = useRef(1);

  const [wikiError, setWikiError] = useState(false);
  const [input, setInput] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [statusText, setStatusText] = useState("Starting engine...");
  const [deathPrompt, setDeathPrompt] = useState<DeathPromptState | null>(null);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const [queuedCommands, setQueuedCommands] = useState<string[]>([]);
  const [isTranscriptScrolling, setIsTranscriptScrolling] = useState(false);
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
      committedEngineCommandsRef.current = [];
      lastUndoSnapshotRef.current = null;
      queuedCommandsRef.current = [];
      setQueuedCommands([]);
      setDeathPrompt(null);
      setTerminalMessage(null);
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
      behavior: isRunning ? "auto" : "smooth",
    });
  }, [deathPrompt, entries, isRunning, queuedCommands, terminalMessage]);

  useEffect(() => {
    if (!isReady || terminalMessage) {
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      commandInputRef.current?.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(animationFrameId);
  }, [deathPrompt, isReady, isRunning, terminalMessage]);

  useEffect(() => {
    return () => {
      if (scrollbarFadeTimeoutRef.current !== null) {
        window.clearTimeout(scrollbarFadeTimeoutRef.current);
      }
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const playerInput = String(formData.get("command") ?? "").trim();
    if (!playerInput || !engineRef.current || !isReady || terminalMessage) {
      return;
    }

    setInput("");
    focusCommandInput();

    if (isProcessingCommandRef.current) {
      enqueueCommand(playerInput);
      return;
    }

    void processCommand(playerInput);
  }

  async function processCommand(playerInput: string) {
    const engine = engineRef.current;
    if (!engine || !isReady || terminalMessage) {
      return;
    }

    isProcessingCommandRef.current = true;
    setIsRunning(true);
    appendEntry("player", `> ${playerInput}`);
    const narrationEntryId = appendEntry("narration", "");
    const turnNumber = turnNumberRef.current;
    const runtimeBeforeIntent = buildRuntimeContext();
    let shouldProcessQueuedCommand = true;

    try {
      if (deathPrompt) {
        shouldProcessQueuedCommand = await handleDeathPromptSubmit({
          playerInput,
          narrationEntryId,
          prompt: deathPrompt,
          runtimeBeforeIntent,
          turnNumber,
        });
        return;
      }

      const undoSnapshotBeforeTurn = createUndoSnapshot(playerInput);
      const intentMapping = await mapPlayerInputToIntent(
        playerInput,
        runtimeBeforeIntent,
      );
      console.log("Zorkish intent mapping", intentMapping);

      const engineResponses =
        intentMapping.mapping.intent === "undo"
          ? await executeUndoIntent()
          : await executeMappedCommands(
              intentMapping.mapping.intent,
              intentMapping.mapping.engine_commands,
              engine,
              undoSnapshotBeforeTurn,
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
      const commitResult = await commitTurn({
        turnNumber,
        playerInput,
        intentMapping,
        engineResponses,
        narration,
        runtimeBeforeIntent,
        undoSnapshotBeforeTurn,
      });
      turnNumberRef.current += 1;
      await handlePostCommitDeath(commitResult);
      if (commitResult.death) {
        shouldProcessQueuedCommand = false;
        clearQueuedCommands();
      }
      updateStatusFromCurrentRoom();
    } catch (error) {
      console.error("Checkpoint 5 turn failed", error);
      replaceEntryText(
        narrationEntryId,
        "Something in the machinery failed to answer. Check the proxy and console, then try again.",
      );
    } finally {
      isProcessingCommandRef.current = false;
      setIsRunning(false);
      focusCommandInput();
      if (shouldProcessQueuedCommand) {
        processNextQueuedCommand();
      }
    }
  }

  async function executeMappedCommands(
    intent: string,
    commands: string[],
    engine: ZMachineEngineClient,
    undoSnapshotBeforeTurn: UndoSnapshot,
  ) {
    if (!shouldExecuteCommands(intent)) {
      return [];
    }

    const gameData = await loadGameData();
    const responses: ExecutedEngineResponse[] = [];
    lastUndoSnapshotRef.current = undoSnapshotBeforeTurn;

    for (const command of commands) {
      const roomBeforeCommand = currentRoomIdRef.current;
      const response = await engine.sendCommand(command);
      const isDeath = isEngineDeathResponse(response.text);
      const detectedRoomId = detectRoomIdFromEngineResponse(response, gameData);
      if (detectedRoomId && !isDeath) {
        currentRoomIdRef.current = detectedRoomId;
      }
      responses.push({
        command,
        text: response.text,
        detected_room_id: detectedRoomId,
        current_room_id_after_command: currentRoomIdRef.current,
        source: "engine",
        was_death: isDeath,
        death_type: isDeath ? classifyDeathType(response.text) : null,
        death_location_id: isDeath ? roomBeforeCommand : null,
      });
      committedEngineCommandsRef.current = [
        ...committedEngineCommandsRef.current,
        command,
      ];
      if (!isDeath) {
        inventoryRef.current = applyInventoryGuess(
          command,
          response.text,
          inventoryRef.current,
          gameData,
          currentRoomIdRef.current,
        );
      }
      mostRecentEngineResponseRef.current = response.text;
      previousActionWasFatalRef.current = isDeath;
      if (isDeath) {
        currentRoomIdRef.current = roomBeforeCommand;
        break;
      }
    }

    return responses;
  }

  async function executeUndoIntent() {
    const snapshot = lastUndoSnapshotRef.current;

    if (!snapshot) {
      return [
        createSyntheticEngineResponse(
          "No previous action is available to undo.",
          false,
        ),
      ];
    }

    await restoreEngineSnapshot(snapshot);
    lastUndoSnapshotRef.current = null;
    previousActionWasFatalRef.current = false;

    return [
      createSyntheticEngineResponse(
        `Undone. Restored to before: ${snapshot.label}.`,
        false,
      ),
    ];
  }

  async function handleDeathPromptSubmit(input: {
    playerInput: string;
    narrationEntryId: number;
    prompt: DeathPromptState;
    runtimeBeforeIntent: RuntimeContext;
    turnNumber: number;
  }): Promise<boolean> {
    const normalized = input.playerInput.trim().toLowerCase();

    if (["y", "yes", "undo", "u"].includes(normalized)) {
      return handleDeathUndo(input);
    }

    if (["n", "no", "quit", "q"].includes(normalized)) {
      return handleDeathDecline(input);
    }

    replaceEntryText(
      input.narrationEntryId,
      "Answer Y to spend a life and undo, or N to let the run end.",
    );
    return false;
  }

  async function handleDeathUndo(input: {
    playerInput: string;
    narrationEntryId: number;
    prompt: DeathPromptState;
    runtimeBeforeIntent: RuntimeContext;
    turnNumber: number;
  }): Promise<boolean> {
    const run = runRef.current;

    if (!run) {
      replaceEntryText(input.narrationEntryId, "The run record is missing.");
      return false;
    }

    const result = await markDeathUndoneAndSpendLife({
      runId: run.run_id,
      deathId: input.prompt.deathId,
    });

    if (!result.ok) {
      await endCurrentRun("death", "Death undo refused: no lives remaining.");
      replaceEntryText(
        input.narrationEntryId,
        "No lives remain. This death stands, and the run ends here.",
      );
      setDeathPrompt(null);
      setTerminalMessage("Out of lives. The run has ended.");
      clearQueuedCommands();
      return false;
    }

    runRef.current = result.run;
    await restoreEngineSnapshot(input.prompt.snapshot);
    setDeathPrompt(null);
    lastUndoSnapshotRef.current = null;
    previousActionWasFatalRef.current = false;

    const intentMapping = createLocalIntentMapping(
      input.playerInput,
      "undo",
      "Spending a life to undo the most recent death.",
    );
    const engineResponses = [
      createSyntheticEngineResponse(
        `A life is spent. Restored to before: ${input.prompt.snapshot.label}.`,
        false,
      ),
    ];
    const narration = await narrateTurn(
      {
        playerInput: input.playerInput,
        intentMapping,
        engineResponses,
        runtimeContext: buildRuntimeContext(),
      },
      (token) => appendToEntry(input.narrationEntryId, token),
    );

    replaceEntryText(input.narrationEntryId, narration.text);
    logTurnTiming({
      turnNumber: input.turnNumber,
      playerInput: input.playerInput,
      intentMapping,
      narration,
    });
    await commitTurn({
      turnNumber: input.turnNumber,
      playerInput: input.playerInput,
      intentMapping,
      engineResponses,
      narration,
      runtimeBeforeIntent: input.runtimeBeforeIntent,
      undoSnapshotBeforeTurn: input.prompt.snapshot,
    });
    turnNumberRef.current += 1;
    updateStatusFromCurrentRoom();
    return true;
  }

  async function handleDeathDecline(input: {
    playerInput: string;
    narrationEntryId: number;
    runtimeBeforeIntent: RuntimeContext;
    turnNumber: number;
  }): Promise<boolean> {
    const intentMapping = createLocalIntentMapping(
      input.playerInput,
      "action",
      "The player declined the death undo prompt and let the run end.",
    );
    const engineResponses = [
      createSyntheticEngineResponse(
        "The player declined to undo the death. The run ends.",
        false,
      ),
    ];
    const narration = await narrateTurn(
      {
        playerInput: input.playerInput,
        intentMapping,
        engineResponses,
        runtimeContext: buildRuntimeContext(),
      },
      (token) => appendToEntry(input.narrationEntryId, token),
    );

    replaceEntryText(input.narrationEntryId, narration.text);
    await commitTurn({
      turnNumber: input.turnNumber,
      playerInput: input.playerInput,
      intentMapping,
      engineResponses,
      narration,
      runtimeBeforeIntent: input.runtimeBeforeIntent,
      undoSnapshotBeforeTurn: null,
    });
    turnNumberRef.current += 1;
    await endCurrentRun("death", "Player declined death undo.");
    setDeathPrompt(null);
    setTerminalMessage("Run ended. The death stands.");
    clearQueuedCommands();
    updateStatusFromCurrentRoom();
    return false;
  }

  async function commitTurn(input: {
    turnNumber: number;
    playerInput: string;
    intentMapping: TurnIntentMapping;
    engineResponses: ExecutedEngineResponse[];
    narration: NarrationResult;
    runtimeBeforeIntent: RuntimeContext;
    undoSnapshotBeforeTurn: UndoSnapshot | null;
  }) {
    const run = runRef.current;
    if (!run) {
      return { turn: null, death: null, undoSnapshotBeforeTurn: null };
    }

    const gameData = await loadGameData();
    const engineSaveId = `${run.run_id}-turn-${input.turnNumber}`;
    const deathResponse = input.engineResponses.find(
      (response) => response.was_death,
    );
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
        source: response.source ?? "engine",
        was_death: response.was_death ?? false,
        death_type: response.death_type ?? null,
        death_location_id: response.death_location_id ?? null,
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
        was_death: Boolean(deathResponse),
        death_origin: deathResponse ? "engine" : null,
        death_type: deathResponse?.death_type ?? null,
        death_id: null,
        was_undo: input.intentMapping.mapping.intent === "undo",
        lives_remaining: runRef.current?.lives_remaining ?? run.lives_remaining,
      },
    });

    let committedTurn = turn;
    let death: DeathRecord | null = null;

    if (deathResponse) {
      death = await recordDeath({
        runId: run.run_id,
        playerId: run.player_id,
        turnId: turn.turn_id,
        origin: "engine",
        deathType: deathResponse.death_type ?? "engine_death",
        location: deathResponse.death_location_id ?? currentRoomIdRef.current,
        cause: {
          player_action: input.playerInput,
          engine_commands: input.engineResponses.map((response) => response.command),
          engine_response: deathResponse.text,
          creative_seed: null,
        },
        narration: {
          voiced_prose: input.narration.text,
          ascii_art: input.narration.ascii_art,
          voice_used: "modernized_classic",
          disposition_used: {
            helpfulness: "middle",
            playfulness: "moderate",
          },
        },
        spendLife: false,
      });
      committedTurn =
        (await mergeTurnOutcome(turn.turn_id, {
          death_id: death.death_id,
          lives_remaining: runRef.current?.lives_remaining ?? run.lives_remaining,
        })) ?? turn;
    }

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
    const updatedRun = await updateRunDiscovery({
      runId: run.run_id,
      rooms: [currentRoomIdRef.current],
      objects: visibleObjectIds,
      npcs: visibleNpcs,
      currentRoom: currentRoomIdRef.current,
      inventory: inventoryRef.current,
      engineSaveId,
    });
    if (updatedRun) {
      runRef.current = updatedRun;
    } else if (death) {
      const refreshedRun = await getRun(run.run_id);
      runRef.current = refreshedRun ?? runRef.current;
    }

    recentTurnsRef.current = [committedTurn, ...recentTurnsRef.current].slice(
      0,
      10,
    );
    activeObservationsRef.current = (
      await getActiveObservations(run.run_id)
    ).map((observation) => observation.text);

    return {
      turn: committedTurn,
      death,
      undoSnapshotBeforeTurn: input.undoSnapshotBeforeTurn,
    };
  }

  function createUndoSnapshot(label: string): UndoSnapshot {
    return {
      commandHistory: [...committedEngineCommandsRef.current],
      roomId: currentRoomIdRef.current,
      inventory: [...inventoryRef.current],
      previousActionWasFatal: previousActionWasFatalRef.current,
      mostRecentEngineResponse: mostRecentEngineResponseRef.current,
      label,
    };
  }

  async function restoreEngineSnapshot(snapshot: UndoSnapshot) {
    const restoredEngine = new ZMachineEngineClient();
    await restoredEngine.init();

    for (const command of snapshot.commandHistory) {
      await restoredEngine.sendCommand(command);
    }

    engineRef.current?.dispose();
    engineRef.current = restoredEngine;
    committedEngineCommandsRef.current = [...snapshot.commandHistory];
    currentRoomIdRef.current = snapshot.roomId;
    inventoryRef.current = [...snapshot.inventory];
    previousActionWasFatalRef.current = snapshot.previousActionWasFatal;
    mostRecentEngineResponseRef.current = snapshot.mostRecentEngineResponse;
  }

  async function handlePostCommitDeath(input: {
    turn: TurnRecord | null;
    death: DeathRecord | null;
    undoSnapshotBeforeTurn: UndoSnapshot | null;
  }) {
    if (!input.death || !input.undoSnapshotBeforeTurn) {
      return;
    }

    const run = await getRun(input.death.run_id);
    if (run) {
      runRef.current = run;
    }

    const livesRemaining = run?.lives_remaining ?? 0;
    if (livesRemaining > 0) {
      setDeathPrompt({
        deathId: input.death.death_id,
        deathType: input.death.death_type,
        locationId: input.death.location,
        livesRemaining,
        snapshot: input.undoSnapshotBeforeTurn,
      });
      return;
    }

    await endCurrentRun("death", "Death occurred with no lives remaining.");
    setTerminalMessage("Out of lives. The run has ended.");
  }

  async function endCurrentRun(
    reason: NonNullable<RunRecord["ended_reason"]>,
    summary: string,
  ) {
    const run = runRef.current;
    if (!run) {
      return null;
    }

    const endedRun = await endRun({
      runId: run.run_id,
      reason,
      summary,
    });
    if (endedRun) {
      runRef.current = endedRun;
    }

    return endedRun;
  }

  function createSyntheticEngineResponse(
    text: string,
    wasDeath: boolean,
  ): ExecutedEngineResponse {
    return {
      command: "[zorkish]",
      text,
      detected_room_id: null,
      current_room_id_after_command: currentRoomIdRef.current,
      source: "zorkish",
      was_death: wasDeath,
      death_type: wasDeath ? "engine_death" : null,
      death_location_id: wasDeath ? currentRoomIdRef.current : null,
    };
  }

  function createLocalIntentMapping(
    playerInput: string,
    intent: IntentValue,
    reasoning: string,
  ): TurnIntentMapping {
    return {
      model_used: "zorkish-local",
      latency_ms: 0,
      proxy_timing: null,
      context_room_id: currentRoomIdRef.current,
      mapping: {
        intent,
        engine_commands: [],
        off_rails_flavor:
          intent === "off_rails_harmless" ? reasoning : null,
        undo_request: {
          is_undo: intent === "undo",
          target_action_index: null,
          is_death_undo: intent === "undo",
        },
        recall_request: {
          is_recall: false,
          topic: null,
        },
        creative_death: {
          proposed: false,
          reason: null,
          method: null,
        },
        injection_attempt: {
          detected: false,
          severity: null,
        },
        clarification_needed: null,
        reasoning: `${reasoning} Input: ${playerInput}`,
      },
    };
  }

  function isEngineDeathResponse(text: string) {
    return text.toLowerCase().includes("you have died");
  }

  function classifyDeathType(text: string) {
    const normalized = text.toLowerCase();
    if (normalized.includes("grue")) {
      return "grue";
    }
    if (normalized.includes("troll")) {
      return "troll";
    }
    if (normalized.includes("drown")) {
      return "drowning";
    }
    if (normalized.includes("fall")) {
      return "falling";
    }
    if (normalized.includes("burn")) {
      return "burning";
    }

    return "engine_death";
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
    const run = runRef.current;
    const livesText = run ? ` | Lives: ${run.lives_remaining}` : "";
    const terminalText = run?.ended_reason ? " | Run ended" : "";
    setStatusText(
      `Room: ${room?.name ?? currentRoomIdRef.current} | Inventory guess: ${
        inventoryRef.current.length ? inventoryRef.current.join(", ") : "empty"
      }${livesText}${terminalText}`,
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

  function enqueueCommand(command: string) {
    queuedCommandsRef.current = [...queuedCommandsRef.current, command];
    setQueuedCommands(queuedCommandsRef.current);
  }

  function processNextQueuedCommand() {
    const [nextCommand, ...remainingCommands] = queuedCommandsRef.current;
    if (!nextCommand) {
      return;
    }

    queuedCommandsRef.current = remainingCommands;
    setQueuedCommands(remainingCommands);
    window.setTimeout(() => void processCommand(nextCommand), 0);
  }

  function clearQueuedCommands() {
    queuedCommandsRef.current = [];
    setQueuedCommands([]);
  }

  function focusCommandInput() {
    requestAnimationFrame(() => {
      commandInputRef.current?.focus({ preventScroll: true });
    });
  }

  function handleTranscriptScroll() {
    setIsTranscriptScrolling(true);

    if (scrollbarFadeTimeoutRef.current !== null) {
      window.clearTimeout(scrollbarFadeTimeoutRef.current);
    }

    scrollbarFadeTimeoutRef.current = window.setTimeout(() => {
      setIsTranscriptScrolling(false);
      scrollbarFadeTimeoutRef.current = null;
    }, 900);
  }

  function handleTranscriptPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button,input,textarea,select,summary,a")
    ) {
      return;
    }

    focusCommandInput();
  }

  function logTurnTiming(input: {
    turnNumber: number;
    playerInput: string;
    intentMapping: TurnIntentMapping;
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
            className={`terminal-scrollbar min-h-0 flex-1 overflow-y-auto border border-amber-100/10 bg-black p-5 font-mono text-sm leading-6 shadow-2xl shadow-black/30 ${
              isTranscriptScrolling ? "terminal-scrollbar-active" : ""
            }`}
            onPointerDown={handleTranscriptPointerDown}
            onScroll={handleTranscriptScroll}
            ref={transcriptRef}
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
            {deathPrompt ? (
              <pre
                className="mb-5 whitespace-pre-wrap text-red-100"
                role="alert"
              >
                {`Death recorded: ${deathPrompt.deathType} in ${deathPrompt.locationId}. Lives available: ${deathPrompt.livesRemaining}. Undo? Y/N`}
              </pre>
            ) : null}
            {terminalMessage ? (
              <pre
                className="mb-5 whitespace-pre-wrap text-amber-100"
                role="status"
              >
                {terminalMessage}
              </pre>
            ) : null}
            {queuedCommands.length ? (
              <pre className="mb-3 whitespace-pre-wrap text-stone-500">
                {queuedCommands
                  .map((queuedCommand) => `queued> ${queuedCommand}`)
                  .join("\n")}
              </pre>
            ) : null}
            <form
              className="flex items-baseline text-stone-100"
              onSubmit={handleSubmit}
            >
              <span className="shrink-0 text-amber-100" aria-hidden="true">
                &gt;
              </span>
              <input
                aria-label="Zork command"
                autoComplete="off"
                className="terminal-command-input ml-1 min-w-0 flex-1 bg-transparent p-0 text-stone-100 outline-none"
                disabled={!isReady || Boolean(terminalMessage)}
                name="command"
                onChange={(event) => setInput(event.target.value)}
                placeholder={
                  deathPrompt
                    ? "Y/N"
                    : isReady
                      ? ""
                      : "starting engine..."
                }
                ref={commandInputRef}
                value={input}
              />
              <button
                className="sr-only"
                disabled={!isReady || !input.trim() || Boolean(terminalMessage)}
                type="submit"
              >
                Send
              </button>
            </form>
          </div>
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
