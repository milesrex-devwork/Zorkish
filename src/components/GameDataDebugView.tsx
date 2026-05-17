import { useEffect, useMemo, useState } from "react";

type RoomRecord = {
  name: string;
  description: string;
  exits: Record<string, string | null>;
  is_dark: boolean;
  objects_starting_here: string[];
};

type ObjectRecord = {
  name: string;
  description: string;
  starting_location: string | null;
  is_container: boolean;
  is_takeable: boolean;
  is_npc: boolean;
};

type GameData = {
  schema_version: 1;
  rooms: Record<string, RoomRecord>;
  objects: Record<string, ObjectRecord>;
  verbs: string[];
  verb_object_combinations: Array<{
    verb: string;
    preposition: string;
  }>;
};

type Match<T> = {
  id: string;
  record: T;
};

const REQUIRED_VERBS = [
  "take",
  "drop",
  "look",
  "examine",
  "north",
  "south",
  "east",
  "west",
  "up",
  "down",
  "open",
  "close",
  "attack",
  "kill",
  "give",
  "read",
  "eat",
  "drink",
  "inventory",
];

export function GameDataDebugView() {
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [query, setQuery] = useState("kitchen");
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/zork1-game-data.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Game data fetch failed: ${response.status}`);
        }
        return response.json() as Promise<GameData>;
      })
      .then(setGameData)
      .catch((fetchError: unknown) => {
        console.error("Game data debug load failed", fetchError);
        setError(true);
      });
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const roomMatches = useMemo(
    () =>
      matchRecords(gameData?.rooms ?? {}, normalizedQuery, (room) =>
        [room.name, room.description].join(" "),
      ),
    [gameData, normalizedQuery],
  );
  const objectMatches = useMemo(
    () =>
      matchRecords(gameData?.objects ?? {}, normalizedQuery, (object) =>
        [object.name, object.description, object.starting_location ?? ""].join(
          " ",
        ),
      ),
    [gameData, normalizedQuery],
  );
  const verbMatches = useMemo(
    () =>
      (gameData?.verbs ?? []).filter((verb) => {
        if (!normalizedQuery) {
          return true;
        }
        return verb.includes(normalizedQuery);
      }),
    [gameData, normalizedQuery],
  );
  const combinationMatches = useMemo(
    () =>
      (gameData?.verb_object_combinations ?? []).filter((combo) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${combo.verb} ${combo.preposition}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [gameData, normalizedQuery],
  );

  const westOfHouse = gameData?.rooms["WEST-OF-HOUSE"];
  const kitchen = gameData?.rooms.KITCHEN;
  const cellar = gameData?.rooms.CELLAR;
  const mailbox = gameData?.objects.MAILBOX;
  const troll = gameData?.objects.TROLL;
  const hasAttackWith =
    gameData?.verb_object_combinations.some(
      (combo) => combo.verb === "attack" && combo.preposition === "with",
    ) ?? false;

  return (
    <aside className="border-t border-amber-100/10 py-4 text-xs text-stone-300">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-amber-100">Game Data Debug</h2>
          <p className="mt-1 text-stone-400">
            {error
              ? "Could not load generated game data."
              : gameData
                ? `Loaded schema v${gameData.schema_version}.`
                : "Loading generated game data..."}
          </p>
        </div>
        <label className="flex min-w-56 flex-col gap-1">
          <span className="text-stone-500">Search</span>
          <input
            className="border border-amber-100/15 bg-stone-900 px-3 py-2 font-mono text-stone-100 outline-none transition focus:border-amber-200/60"
            onChange={(event) => setQuery(event.target.value)}
            value={query}
          />
        </label>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-4">
        <DebugStat label="Rooms" value={countRecords(gameData?.rooms)} />
        <DebugStat label="Objects" value={countRecords(gameData?.objects)} />
        <DebugStat label="Verbs" value={gameData?.verbs.length ?? 0} />
        <DebugStat
          label="Attack with"
          value={hasAttackWith ? "present" : "missing"}
        />
      </dl>

      <section className="mt-4">
        <h3 className="font-medium text-amber-100">Required Verbs</h3>
        <ul className="mt-2 flex flex-wrap gap-2 font-mono">
          {REQUIRED_VERBS.map((verb) => {
            const isPresent = gameData?.verbs.includes(verb) ?? false;
            return (
              <li
                className={`border px-2 py-1 ${
                  isPresent
                    ? "border-emerald-300/30 text-emerald-100"
                    : "border-red-300/40 text-red-100"
                }`}
                key={verb}
              >
                {verb}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <section>
          <h3 className="font-medium text-amber-100">Rooms</h3>
          <div className="mt-2 space-y-3">
            {roomMatches.slice(0, 3).map(({ id, record }) => (
              <RoomDebugEntry id={id} key={id} room={record} />
            ))}
          </div>
        </section>

        <section>
          <h3 className="font-medium text-amber-100">Objects</h3>
          <div className="mt-2 space-y-3">
            {objectMatches.slice(0, 3).map(({ id, record }) => (
              <ObjectDebugEntry id={id} key={id} object={record} />
            ))}
          </div>
        </section>

        <section>
          <h3 className="font-medium text-amber-100">Verbs</h3>
          <DebugList
            items={verbMatches.slice(0, 12)}
            noneText="No matching verbs"
          />
        </section>

        <section>
          <h3 className="font-medium text-amber-100">Verb Combos</h3>
          <DebugList
            items={combinationMatches
              .slice(0, 12)
              .map((combo) => `${combo.verb} ${combo.preposition}`)}
            noneText="No matching combos"
          />
        </section>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <DebugStat
          label="West north"
          value={westOfHouse?.exits.north ?? "missing"}
        />
        <DebugStat
          label="West east"
          value={westOfHouse?.exits.east ?? "null"}
        />
        <DebugStat
          label="Kitchen dark"
          value={String(kitchen?.is_dark ?? "missing")}
        />
        <DebugStat
          label="Cellar dark"
          value={String(cellar?.is_dark ?? "missing")}
        />
        <DebugStat
          label="Mailbox / Troll"
          value={`${mailbox?.is_container ? "container" : "missing"} / ${
            troll?.is_npc ? "npc" : "missing"
          }`}
        />
      </dl>
    </aside>
  );
}

function matchRecords<T>(
  records: Record<string, T>,
  query: string,
  textForRecord: (record: T) => string,
): Array<Match<T>> {
  return Object.entries(records)
    .filter(([id, record]) => {
      if (!query) {
        return true;
      }
      return `${id} ${textForRecord(record)}`.toLowerCase().includes(query);
    })
    .map(([id, record]) => ({ id, record }));
}

function countRecords(records: Record<string, unknown> | undefined) {
  return records ? Object.keys(records).length : 0;
}

function DebugStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-stone-500">{label}</dt>
      <dd className="mt-1 break-words font-mono text-stone-200">{value}</dd>
    </div>
  );
}

function DebugList({ items, noneText }: { items: string[]; noneText: string }) {
  return (
    <ul className="mt-2 space-y-1 font-mono text-stone-300">
      {items.length > 0 ? (
        items.map((item) => <li key={item}>{item}</li>)
      ) : (
        <li className="text-stone-500">{noneText}</li>
      )}
    </ul>
  );
}

function RoomDebugEntry({ id, room }: { id: string; room: RoomRecord }) {
  const exits = Object.entries(room.exits)
    .filter(([, target]) => target)
    .map(([direction, target]) => `${direction}:${target}`)
    .join(", ");

  return (
    <article className="border border-amber-100/10 bg-stone-900/50 p-3">
      <h4 className="font-mono text-amber-100">
        {id} - {room.name}
      </h4>
      <p className="mt-2 line-clamp-3 text-stone-300">{room.description}</p>
      <p className="mt-2 font-mono text-stone-400">{exits || "no exits"}</p>
      <p className="mt-2 font-mono text-stone-500">
        objects: {room.objects_starting_here.slice(0, 8).join(", ") || "none"}
      </p>
    </article>
  );
}

function ObjectDebugEntry({
  id,
  object,
}: {
  id: string;
  object: ObjectRecord;
}) {
  return (
    <article className="border border-amber-100/10 bg-stone-900/50 p-3">
      <h4 className="font-mono text-amber-100">
        {id} - {object.name}
      </h4>
      <p className="mt-2 line-clamp-3 text-stone-300">{object.description}</p>
      <p className="mt-2 font-mono text-stone-400">
        starts: {object.starting_location ?? "none"}
      </p>
      <p className="mt-2 font-mono text-stone-500">
        {[
          object.is_container ? "container" : null,
          object.is_takeable ? "takeable" : null,
          object.is_npc ? "npc" : null,
        ]
          .filter(Boolean)
          .join(", ") || "static"}
      </p>
    </article>
  );
}
