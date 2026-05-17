import { useCallback, useEffect, useState } from "react";
import {
  createRun,
  getActiveObservations,
  getDeathsForPlayer,
  getDeathsForRun,
  getLatestSaveForRun,
  getOrCreatePlayer,
  getRecentTurns,
  getRun,
  recordDeath,
  recordObservation,
  recordSave,
  recordTurn,
  updateRunDiscovery,
} from "../wiki/access";
import type {
  DeathRecord,
  ObservationRecord,
  RunRecord,
  SaveRecord,
  TurnRecord,
} from "../wiki/schema";

const DEBUG_PLAYER_ID = "wiki-debug-player";
const LAST_RUN_STORAGE_KEY = "zorkish-wiki-debug-last-run";
const BATCH_TURN_COUNT = 100;
const DEBUG_ROOMS = ["WEST-OF-HOUSE", "KITCHEN", "CELLAR"];
const DEBUG_OBJECTS = ["MAILBOX", "LANTERN", "TROLL"];

type DebugSnapshot = {
  run: RunRecord | null;
  queryDurationMs: number | null;
  playerDeathCount: number;
  runDeaths: DeathRecord[];
  observations: ObservationRecord[];
  recentTurns: TurnRecord[];
  latestSave: SaveRecord | null;
};

function emptySnapshot(): DebugSnapshot {
  return {
    run: null,
    queryDurationMs: null,
    playerDeathCount: 0,
    runDeaths: [],
    observations: [],
    recentTurns: [],
    latestSave: null,
  };
}

export function WikiDebugView() {
  const [lastRunId, setLastRunId] = useState<string | null>(() =>
    localStorage.getItem(LAST_RUN_STORAGE_KEY),
  );
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(emptySnapshot);
  const [status, setStatus] = useState("Loading wiki debug data...");
  const [isBusy, setIsBusy] = useState(false);

  const refreshSnapshot = useCallback(async (runId: string | null) => {
    await getOrCreatePlayer({
      playerId: DEBUG_PLAYER_ID,
      playerProfile: "Debug harness player",
    });

    const playerDeaths = await getDeathsForPlayer(DEBUG_PLAYER_ID);
    const nextSnapshot: DebugSnapshot = {
      ...emptySnapshot(),
      playerDeathCount: playerDeaths.length,
    };

    if (runId) {
      const queryStart = performance.now();
      const [run, recentTurns, runDeaths, observations, latestSave] =
        await Promise.all([
          getRun(runId),
          getRecentTurns(runId, 10),
          getDeathsForRun(runId),
          getActiveObservations(runId),
          getLatestSaveForRun(runId),
        ]);
      const queryDurationMs = performance.now() - queryStart;

      nextSnapshot.run = run ?? null;
      nextSnapshot.recentTurns = recentTurns;
      nextSnapshot.runDeaths = runDeaths;
      nextSnapshot.observations = observations;
      nextSnapshot.latestSave = latestSave;
      nextSnapshot.queryDurationMs = queryDurationMs;
    }

    setSnapshot(nextSnapshot);
    setStatus(
      runId
        ? `Loaded persisted debug run ${runId}.`
        : "No debug run yet. Create one to exercise the wiki stores.",
    );
    return nextSnapshot;
  }, []);

  useEffect(() => {
    Promise.resolve()
      .then(() => refreshSnapshot(lastRunId))
      .catch((error: unknown) => {
        console.error("Wiki debug refresh failed", error);
        setStatus("Could not read the wiki debug data.");
      });
  }, [lastRunId, refreshSnapshot]);

  async function createFakeRunData() {
    setIsBusy(true);
    setStatus(`Writing ${BATCH_TURN_COUNT} fake turns into one debug run...`);

    try {
      const player = await getOrCreatePlayer({
        playerId: DEBUG_PLAYER_ID,
        playerProfile: "Debug harness player",
      });
      const run = await getOrCreateDebugRun(player.player_id);
      const latestTurns = await getRecentTurns(run.run_id, 1);
      const firstTurnNumber = (latestTurns[0]?.turn_number ?? 0) + 1;
      const writtenTurns: TurnRecord[] = [];

      for (let offset = 0; offset < BATCH_TURN_COUNT; offset += 1) {
        const turnNumber = firstTurnNumber + offset;
        const room = DEBUG_ROOMS[offset % DEBUG_ROOMS.length];
        const object = DEBUG_OBJECTS[offset % DEBUG_OBJECTS.length];
        const turn = await recordTurn({
          runId: run.run_id,
          playerId: player.player_id,
          turnNumber,
          playerInput: `debug turn ${turnNumber}: inspect ${object.toLowerCase()}`,
          engineResponses: [
            {
              text: `Debug response ${turnNumber} in ${room}.`,
            },
          ],
          narration: {
            text: `The debug run notes ${object} without disturbing canonical play.`,
          },
          engineSaveId: `debug-save-turn-${turnNumber}`,
          wikiContextUsed: {
            source: "WikiDebugView",
            batch_size: BATCH_TURN_COUNT,
          },
          outcome: {
            room,
            object,
          },
        });
        writtenTurns.push(turn);
      }

      for (const deathTurn of [
        writtenTurns[24],
        writtenTurns[61],
        writtenTurns[99],
      ]) {
        if (deathTurn) {
          await recordDeath({
            runId: run.run_id,
            playerId: player.player_id,
            turnId: deathTurn.turn_id,
            origin: "creative",
            deathType: `debug_mishap_${deathTurn.turn_number}`,
            location: String(deathTurn.outcome.room ?? "WEST-OF-HOUSE"),
            cause: {
              input: deathTurn.player_input,
            },
            narration: {
              text: "A fake death record for the Checkpoint 3 gallery.",
            },
          });
        }
      }

      const latestTurn = writtenTurns[writtenTurns.length - 1];
      await recordObservation({
        runId: run.run_id,
        playerId: player.player_id,
        turnId: latestTurn.turn_id,
        text: `Debug harness appended turns ${firstTurnNumber}-${latestTurn.turn_number}.`,
        category: "behavior",
      });

      await recordSave({
        runId: run.run_id,
        turnId: latestTurn.turn_id,
        turnNumber: latestTurn.turn_number,
        quetzalBlob: new Blob([`debug quetzal payload ${latestTurn.turn_number}`], {
          type: "application/octet-stream",
        }),
      });

      await updateRunDiscovery({
        runId: run.run_id,
        rooms: DEBUG_ROOMS,
        objects: DEBUG_OBJECTS,
        npcs: ["TROLL"],
        puzzlesCompleted: [`debug_batch_${firstTurnNumber}_${latestTurn.turn_number}`],
        deathsExperienced: ["debug_mishap"],
        currentRoom: "CELLAR",
        inventory: ["LANTERN", "LEAFLET"],
        engineSaveId: `debug-save-turn-${latestTurn.turn_number}`,
        score: latestTurn.turn_number,
      });

      localStorage.setItem(LAST_RUN_STORAGE_KEY, run.run_id);
      setLastRunId(run.run_id);
      const refreshed = await refreshSnapshot(run.run_id);
      setStatus(
        `Added turns ${firstTurnNumber}-${latestTurn.turn_number}; last-10 query returned ${refreshed.recentTurns.length} turns in ${formatMs(refreshed.queryDurationMs)}.`,
      );
    } catch (error) {
      console.error("Wiki debug write failed", error);
      setStatus("Could not write fake wiki records.");
    } finally {
      setIsBusy(false);
    }
  }

  async function getOrCreateDebugRun(playerId: string) {
    const existingRun = lastRunId ? await getRun(lastRunId) : null;
    if (existingRun) {
      return existingRun;
    }

    const run = await createRun({
      playerId,
      livesInitial: 999,
      currentRoom: "WEST-OF-HOUSE",
      engineSaveId: "debug-save-before-turn",
    });
    localStorage.setItem(LAST_RUN_STORAGE_KEY, run.run_id);
    setLastRunId(run.run_id);
    return run;
  }

  return (
    <aside className="border-t border-amber-100/10 py-4 text-xs text-stone-300">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-amber-100">Wiki Debug</h2>
          <p className="mt-1 text-stone-400">{status}</p>
        </div>
        <button
          className="border border-amber-100/20 px-3 py-2 text-amber-100 transition hover:border-amber-100/50 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={isBusy}
          onClick={createFakeRunData}
          type="button"
        >
          Add 100 fake turns
        </button>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-stone-500">Last run</dt>
          <dd className="mt-1 break-all font-mono text-stone-200">
            {lastRunId ?? "none"}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Run turns</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {snapshot.run?.stats.turn_count ?? 0}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Last 10 query</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {snapshot.recentTurns.length}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Query time</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {formatMs(snapshot.queryDurationMs)}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Run deaths</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {snapshot.runDeaths.length}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Player deaths</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {snapshot.playerDeathCount}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DebugList
          items={snapshot.recentTurns.map(
            (turn) => `#${turn.turn_number}: ${turn.player_input}`,
          )}
          title="Last 10 Turns"
        />
        <DebugList
          items={snapshot.runDeaths.slice(-8).map(
            (death) => `${death.death_type} at ${death.location}`,
          )}
          title={`Death Gallery (${snapshot.runDeaths.length})`}
        />
        <DebugList
          items={[
            ...snapshot.observations.map((observation) => observation.text),
            snapshot.latestSave
              ? `Latest save: ${snapshot.latestSave.blob_size_bytes} bytes`
              : "Latest save: none",
          ]}
          title="Observations / Save"
        />
        <DebugList
          items={[
            `rooms: ${snapshot.run?.discovered.rooms.join(", ") || "none"}`,
            `objects: ${snapshot.run?.discovered.objects.join(", ") || "none"}`,
            `npcs: ${snapshot.run?.discovered.npcs.join(", ") || "none"}`,
            `puzzles: ${
              snapshot.run?.discovered.puzzles_completed.slice(-3).join(", ") ||
              "none"
            }`,
          ]}
          title="Discovered Set"
        />
      </div>
    </aside>
  );
}

function DebugList({ items, title }: { items: string[]; title: string }) {
  return (
    <section>
      <h3 className="font-medium text-amber-100">{title}</h3>
      <ul className="mt-2 space-y-1 font-mono text-stone-300">
        {items.length > 0 ? (
          items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)
        ) : (
          <li>none</li>
        )}
      </ul>
    </section>
  );
}

function formatMs(value: number | null) {
  if (value === null) {
    return "not run";
  }

  return `${value.toFixed(1)} ms`;
}
