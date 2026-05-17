import { useCallback, useEffect, useState } from "react";
import {
  createRun,
  getActiveObservations,
  getDeathsForPlayer,
  getDeathsForRun,
  getLatestSaveForRun,
  getOrCreatePlayer,
  getRecentTurns,
  recordDeath,
  recordObservation,
  recordSave,
  recordTurn,
} from "../wiki/access";
import type {
  DeathRecord,
  ObservationRecord,
  SaveRecord,
  TurnRecord,
} from "../wiki/schema";

const DEBUG_PLAYER_ID = "wiki-debug-player";
const LAST_RUN_STORAGE_KEY = "zorkish-wiki-debug-last-run";

type DebugSnapshot = {
  playerDeathCount: number;
  runDeaths: DeathRecord[];
  observations: ObservationRecord[];
  recentTurns: TurnRecord[];
  latestSave: SaveRecord | null;
};

function emptySnapshot(): DebugSnapshot {
  return {
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
      const [recentTurns, runDeaths, observations, latestSave] =
        await Promise.all([
          getRecentTurns(runId, 5),
          getDeathsForRun(runId),
          getActiveObservations(runId),
          getLatestSaveForRun(runId),
        ]);

      nextSnapshot.recentTurns = recentTurns;
      nextSnapshot.runDeaths = runDeaths;
      nextSnapshot.observations = observations;
      nextSnapshot.latestSave = latestSave;
    }

    setSnapshot(nextSnapshot);
    setStatus(
      runId
        ? `Loaded persisted debug run ${runId}.`
        : "No debug run yet. Create one to exercise the wiki stores.",
    );
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
    setStatus("Writing fake wiki records...");

    try {
      const player = await getOrCreatePlayer({
        playerId: DEBUG_PLAYER_ID,
        playerProfile: "Debug harness player",
      });
      const run = await createRun({
        playerId: player.player_id,
        currentRoom: "West of House",
        engineSaveId: "debug-save-before-turn",
      });
      const turn = await recordTurn({
        runId: run.run_id,
        playerId: player.player_id,
        turnNumber: 1,
        playerInput: "open mailbox",
        engineResponses: [
          {
            text: "Opening the small mailbox reveals a leaflet.",
          },
        ],
        narration: {
          voice: "The mailbox creaks like it has been waiting for this.",
        },
        engineSaveId: "debug-save-after-turn",
        wikiContextUsed: {
          source: "WikiDebugView",
        },
        outcome: {
          room: "West of House",
        },
      });

      await recordDeath({
        runId: run.run_id,
        playerId: player.player_id,
        turnId: turn.turn_id,
        origin: "creative",
        deathType: "debug_mailbox_mishap",
        location: "West of House",
        cause: {
          input: turn.player_input,
        },
        narration: {
          text: "The debug mailbox was only mostly harmless.",
        },
      });

      await recordObservation({
        runId: run.run_id,
        playerId: player.player_id,
        turnId: turn.turn_id,
        text: "Debug player likes poking suspicious containers.",
        category: "behavior",
      });

      await recordSave({
        runId: run.run_id,
        turnId: turn.turn_id,
        turnNumber: turn.turn_number,
        quetzalBlob: new Blob(["debug quetzal payload"], {
          type: "application/octet-stream",
        }),
      });

      localStorage.setItem(LAST_RUN_STORAGE_KEY, run.run_id);
      setLastRunId(run.run_id);
      await refreshSnapshot(run.run_id);
      setStatus("Wrote fake run, turn, death, observation, and save records.");
    } catch (error) {
      console.error("Wiki debug write failed", error);
      setStatus("Could not write fake wiki records.");
    } finally {
      setIsBusy(false);
    }
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
          Create fake wiki data
        </button>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-stone-500">Last run</dt>
          <dd className="mt-1 break-all font-mono text-stone-200">
            {lastRunId ?? "none"}
          </dd>
        </div>
        <div>
          <dt className="text-stone-500">Recent turns</dt>
          <dd className="mt-1 font-mono text-stone-200">
            {snapshot.recentTurns.length}
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

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <DebugList
          items={snapshot.recentTurns.map(
            (turn) => `#${turn.turn_number}: ${turn.player_input}`,
          )}
          title="Turns"
        />
        <DebugList
          items={snapshot.runDeaths.map(
            (death) => `${death.death_type} at ${death.location}`,
          )}
          title="Death Gallery"
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
          items.map((item) => <li key={item}>{item}</li>)
        ) : (
          <li>none</li>
        )}
      </ul>
    </section>
  );
}
