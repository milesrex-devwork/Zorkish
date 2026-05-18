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
  applyContainerStateGuess,
  detectRoomIdFromEngineResponse,
  getInitialContainerStates,
  getRoom,
  getVisibleObjectIds,
  loadGameData,
  type ContainerStateMap,
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
  getLatestSaveForRun,
  getMostRecentResumableRun,
  getRun,
  getOrCreatePlayer,
  getRecentTurns,
  getTurnsForRun,
  markDeathUndoneAndSpendLife,
  mergeTurnOutcome,
  recordDeath,
  recordObservation,
  recordSave,
  recordTurn,
  updateRunDiscovery,
} from "./wiki/access";
import type {
  DeathRecord,
  RunRecord,
  SaveRecord,
  TurnRecord,
} from "./wiki/schema";

const GAMEPLAY_PLAYER_ID = "local-player";
const START_ROOM_ID = "WEST-OF-HOUSE";
const SCROLLBACK_TURN_LIMIT = 12;
const REPLAY_SAVE_FORMAT = "zorkish-command-history-v1";

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
  containerStates: ContainerStateMap;
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

type ReplaySavePayload = {
  format: typeof REPLAY_SAVE_FORMAT;
  source: "command-history-replay";
  commands: string[];
  roomId: string;
  inventory: string[];
  containerStates: ContainerStateMap;
  previousActionWasFatal: boolean;
  mostRecentEngineResponse: string | null;
  savedAt: number;
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
  const containerStatesRef = useRef<ContainerStateMap>({});
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

  const restoreEngineSnapshot = useCallback(async (snapshot: UndoSnapshot) => {
    const gameData = await loadGameData();
    const restoredEngine = new ZMachineEngineClient();
    const initResponse = await restoredEngine.init();
    let actualRoomId =
      detectRoomIdFromEngineResponse(initResponse, gameData) ?? START_ROOM_ID;
    let lastResponseText = initResponse.text;

    for (const command of snapshot.commandHistory) {
      const response = await restoredEngine.sendCommand(command);
      const detectedRoomId = detectRoomIdFromEngineResponse(response, gameData);
      if (detectedRoomId) {
        actualRoomId = detectedRoomId;
      }
      lastResponseText = response.text;
    }

    engineRef.current?.dispose();
    engineRef.current = restoredEngine;
    committedEngineCommandsRef.current = [...snapshot.commandHistory];
    currentRoomIdRef.current = actualRoomId;
    inventoryRef.current = [...snapshot.inventory];
    containerStatesRef.current = { ...snapshot.containerStates };
    previousActionWasFatalRef.current = snapshot.previousActionWasFatal;
    mostRecentEngineResponseRef.current =
      snapshot.mostRecentEngineResponse ?? lastResponseText;

    if (actualRoomId !== snapshot.roomId) {
      console.warn("Zorkish replay restored a different room than expected", {
        expected_room_id: snapshot.roomId,
        actual_room_id: actualRoomId,
        replay_command_count: snapshot.commandHistory.length,
        replay_tail: snapshot.commandHistory.slice(-5),
      });
    }

    return {
      expectedRoomId: snapshot.roomId,
      actualRoomId,
      commandHistory: [...snapshot.commandHistory],
    };
  }, []);

  const createNewGameplayRun = useCallback(async (initialRoomId: string) => {
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
        inventory: inventoryRef.current,
        engineSaveId: "pending-first-turn",
      });
      runRef.current = run;
      turnNumberRef.current = 1;
      lastUndoSnapshotRef.current = null;
      queuedCommandsRef.current = [];
      setQueuedCommands([]);
      setDeathPrompt(null);
      setTerminalMessage(null);
      recentTurnsRef.current = [];
      activeObservationsRef.current = (
        await getActiveObservations(run.run_id)
      ).map((observation) => observation.text);
      console.log("Zorkish created gameplay run", {
        run_id: run.run_id,
        room_id: initialRoomId,
      });

      return run;
    } catch (error) {
      console.error("Wiki gameplay run setup failed", error);
      setWikiError(true);
      return null;
    }
  }, []);

  const prepareGameplaySession = useCallback(
    async (input: { initialRoomId: string; initialEngineText: string }) => {
      const gameData = await loadGameData();
      const initialContainerStates = getInitialContainerStates(gameData);

      currentRoomIdRef.current = input.initialRoomId;
      inventoryRef.current = [];
      containerStatesRef.current = initialContainerStates;
      previousActionWasFatalRef.current = false;
      mostRecentEngineResponseRef.current = input.initialEngineText;
      committedEngineCommandsRef.current = [];
      lastUndoSnapshotRef.current = null;
      queuedCommandsRef.current = [];
      setQueuedCommands([]);
      setDeathPrompt(null);
      setTerminalMessage(null);

      try {
        const player = await getOrCreatePlayer({
          playerId: GAMEPLAY_PLAYER_ID,
          playerProfile: "Zorkish local browser player",
        });
        if (!hasLoggedWikiInitialization) {
          console.log("IndexedDB initialized");
          hasLoggedWikiInitialization = true;
        }

        const resumableRun = await getMostRecentResumableRun(player.player_id);
        if (resumableRun) {
          const [latestSave, recentTurns, observations] = await Promise.all([
            getLatestSaveForRun(resumableRun.run_id),
            getRecentTurns(resumableRun.run_id, SCROLLBACK_TURN_LIMIT),
            getActiveObservations(resumableRun.run_id),
          ]);
          const replayPayload =
            (await readReplaySavePayload(latestSave)) ??
            (await buildReplaySavePayloadFromTurns(resumableRun));

          if (replayPayload) {
            const snapshot: UndoSnapshot = {
              commandHistory: replayPayload.commands,
              roomId: resumableRun.current_state.current_room,
              inventory:
                resumableRun.current_state.inventory.length > 0
                  ? resumableRun.current_state.inventory
                  : replayPayload.inventory,
              containerStates:
                Object.keys(replayPayload.containerStates).length > 0
                  ? replayPayload.containerStates
                  : initialContainerStates,
              previousActionWasFatal: replayPayload.previousActionWasFatal,
              mostRecentEngineResponse: replayPayload.mostRecentEngineResponse,
              label: `resume run ${resumableRun.run_id}`,
            };
            const restoreResult = await restoreEngineSnapshot(snapshot);
            const refreshedRun =
              (await getRun(resumableRun.run_id)) ?? resumableRun;

            runRef.current = refreshedRun;
            turnNumberRef.current = refreshedRun.stats.turn_count + 1;
            recentTurnsRef.current = recentTurns;
            activeObservationsRef.current = observations.map(
              (observation) => observation.text,
            );
            setEntries(
              createScrollbackEntries(recentTurns, () => nextEntryId.current++),
            );
            setStatusText(
              formatStatusText(
                gameData,
                currentRoomIdRef.current,
                inventoryRef.current,
                refreshedRun,
              ),
            );
            console.log("Zorkish resumed gameplay run", {
              run_id: refreshedRun.run_id,
              next_turn_number: turnNumberRef.current,
              replay_command_count: replayPayload.commands.length,
              restored_room_id: restoreResult.actualRoomId,
              save_id: latestSave?.save_id ?? "turn-history-fallback",
            });
            return;
          }

          console.warn("Zorkish found a resumable run with no replayable save", {
            run_id: resumableRun.run_id,
            turn_count: resumableRun.stats.turn_count,
          });
        }
      } catch (error) {
        console.error("Wiki resume lookup failed", error);
        setWikiError(true);
      }

      runRef.current = null;
      turnNumberRef.current = 1;
      recentTurnsRef.current = [];
      activeObservationsRef.current = [];
      setEntries([
        {
          id: nextEntryId.current++,
          kind: "engine",
          text: input.initialEngineText,
        },
      ]);
      setStatusText(formatStatusText(gameData, input.initialRoomId, [], null));
      console.log("Zorkish ready for a new run on first command");
    },
    [restoreEngineSnapshot],
  );

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
        await prepareGameplaySession({
          initialRoomId: detectedRoomId,
          initialEngineText: response.text,
        });
        setIsReady(true);
        setIsRunning(false);
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
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [prepareGameplaySession]);

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
    if (!runRef.current) {
      const run = await createNewGameplayRun(currentRoomIdRef.current);
      if (!run) {
        replaceEntryText(
          narrationEntryId,
          "The local Wiki could not create a run record. Check IndexedDB and try again.",
        );
        isProcessingCommandRef.current = false;
        setIsRunning(false);
        focusCommandInput();
        return;
      }
    }
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
      mostRecentEngineResponseRef.current = response.text;
      previousActionWasFatalRef.current = isDeath;
      if (isDeath) {
        const restoreResult = await restoreEngineSnapshot(undoSnapshotBeforeTurn);
        currentRoomIdRef.current = roomBeforeCommand;
        previousActionWasFatalRef.current = true;
        mostRecentEngineResponseRef.current = response.text;
        console.log("Zorkish restored engine after death", {
          death_command: command,
          detected_resurrection_room_id: detectedRoomId,
          restored_room_id: restoreResult.actualRoomId,
          replay_command_count: undoSnapshotBeforeTurn.commandHistory.length,
          replay_tail: undoSnapshotBeforeTurn.commandHistory.slice(-5),
        });
        break;
      }

      committedEngineCommandsRef.current = [
        ...committedEngineCommandsRef.current,
        command,
      ];
      containerStatesRef.current = applyContainerStateGuess(
        command,
        response.text,
        containerStatesRef.current,
        gameData,
        currentRoomIdRef.current,
        inventoryRef.current,
      );
      inventoryRef.current = applyInventoryGuess(
        command,
        response.text,
        inventoryRef.current,
        gameData,
        currentRoomIdRef.current,
      );
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

    const save = await recordSave({
      runId: run.run_id,
      turnId: committedTurn.turn_id,
      turnNumber: input.turnNumber,
      quetzalBlob: createReplaySaveBlob({
        format: REPLAY_SAVE_FORMAT,
        source: "command-history-replay",
        commands: [...committedEngineCommandsRef.current],
        roomId: currentRoomIdRef.current,
        inventory: [...inventoryRef.current],
        containerStates: { ...containerStatesRef.current },
        previousActionWasFatal: previousActionWasFatalRef.current,
        mostRecentEngineResponse: mostRecentEngineResponseRef.current,
        savedAt: Date.now(),
      }),
    });

    const visibleObjectIds = getVisibleObjectIds(
      gameData,
      currentRoomIdRef.current,
      inventoryRef.current,
      containerStatesRef.current,
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
      engineSaveId: save.save_id,
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
      containerStates: { ...containerStatesRef.current },
      previousActionWasFatal: previousActionWasFatalRef.current,
      mostRecentEngineResponse: mostRecentEngineResponseRef.current,
      label,
    };
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
      containerStates: containerStatesRef.current,
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
            <WikiDebugView />
            <GameDataDebugView />
          </div>
        ) : null}
      </div>
    </main>
  );
}

function createReplaySaveBlob(payload: ReplaySavePayload) {
  return new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });
}

async function readReplaySavePayload(save: SaveRecord | null) {
  if (!save) {
    return null;
  }

  try {
    const text =
      save.quetzal_blob instanceof Blob
        ? await save.quetzal_blob.text()
        : new TextDecoder().decode(save.quetzal_blob);
    return normalizeReplaySavePayload(JSON.parse(text));
  } catch (error) {
    console.warn("Zorkish could not read replay save payload", {
      save_id: save.save_id,
      error,
    });
    return null;
  }
}

async function buildReplaySavePayloadFromTurns(run: RunRecord) {
  const turns = await getTurnsForRun(run.run_id);
  if (turns.length === 0) {
    return null;
  }

  return {
    format: REPLAY_SAVE_FORMAT,
    source: "command-history-replay",
    commands: extractReplayCommands(turns),
    roomId: run.current_state.current_room,
    inventory: run.current_state.inventory,
    containerStates: {},
    previousActionWasFatal: false,
    mostRecentEngineResponse: getMostRecentEngineText(turns),
    savedAt: Date.now(),
  } satisfies ReplaySavePayload;
}

function normalizeReplaySavePayload(input: unknown): ReplaySavePayload | null {
  if (!isRecord(input) || input.format !== REPLAY_SAVE_FORMAT) {
    return null;
  }

  const commands = Array.isArray(input.commands)
    ? input.commands.filter((command): command is string => typeof command === "string")
    : null;
  if (!commands) {
    return null;
  }

  return {
    format: REPLAY_SAVE_FORMAT,
    source: "command-history-replay",
    commands,
    roomId: typeof input.roomId === "string" ? input.roomId : START_ROOM_ID,
    inventory: Array.isArray(input.inventory)
      ? input.inventory.filter((item): item is string => typeof item === "string")
      : [],
    containerStates: normalizeContainerStates(input.containerStates),
    previousActionWasFatal:
      typeof input.previousActionWasFatal === "boolean"
        ? input.previousActionWasFatal
        : false,
    mostRecentEngineResponse:
      typeof input.mostRecentEngineResponse === "string"
        ? input.mostRecentEngineResponse
        : null,
    savedAt: typeof input.savedAt === "number" ? input.savedAt : Date.now(),
  };
}

function normalizeContainerStates(input: unknown): ContainerStateMap {
  if (!isRecord(input)) {
    return {};
  }

  const containerStates: ContainerStateMap = {};
  for (const [objectId, state] of Object.entries(input)) {
    if (typeof state === "string") {
      containerStates[objectId] = state as ContainerStateMap[string];
    }
  }
  return containerStates;
}

function extractReplayCommands(turns: TurnRecord[]) {
  const commands: string[] = [];

  for (const turn of turns) {
    if (turn.intent_mapping.intent === "undo") {
      commands.pop();
      continue;
    }

    for (const response of turn.engine_responses) {
      const command = response.command;
      const source = response.source;
      const wasDeath = response.was_death === true;
      if (
        typeof command === "string" &&
        command !== "[zorkish]" &&
        (source === undefined || source === "engine") &&
        !wasDeath
      ) {
        commands.push(command);
      }
    }
  }

  return commands;
}

function getMostRecentEngineText(turns: TurnRecord[]) {
  for (const turn of [...turns].reverse()) {
    for (const response of [...turn.engine_responses].reverse()) {
      if (
        typeof response.text === "string" &&
        (response.source === undefined || response.source === "engine")
      ) {
        return response.text;
      }
    }
  }

  return null;
}

function createScrollbackEntries(
  recentTurns: TurnRecord[],
  nextId: () => number,
): TerminalEntry[] {
  const entries: TerminalEntry[] = [];

  for (const turn of [...recentTurns].reverse()) {
    entries.push({
      id: nextId(),
      kind: "player",
      text: `> ${turn.player_input}`,
    });

    const narrationText = getTurnNarrationText(turn);
    if (narrationText) {
      entries.push({
        id: nextId(),
        kind: "narration",
        text: narrationText,
      });
    }
  }

  return entries.length > 0
    ? entries
    : [
        {
          id: nextId(),
          kind: "system",
          text: "Resumed the saved run. No recent scrollback was found.",
        },
      ];
}

function getTurnNarrationText(turn: TurnRecord) {
  if (typeof turn.narration.text === "string" && turn.narration.text.trim()) {
    return turn.narration.text;
  }

  const engineText = turn.engine_responses
    .map((response) => response.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n\n");

  return engineText || null;
}

function formatStatusText(
  gameData: Awaited<ReturnType<typeof loadGameData>>,
  roomId: string,
  inventory: string[],
  run: RunRecord | null,
) {
  const livesText = run ? ` | Lives: ${run.lives_remaining}` : "";
  const terminalText = run?.ended_reason ? " | Run ended" : "";
  return `Room: ${getRoom(gameData, roomId)?.name ?? roomId} | Inventory guess: ${
    inventory.length ? inventory.join(", ") : "empty"
  }${livesText}${terminalText}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
