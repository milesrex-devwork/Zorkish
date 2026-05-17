import { FormEvent, useEffect, useRef, useState } from "react";
import { ZMachineEngineClient } from "./engine/engine-client";
import { initWiki } from "./wiki/access";

let hasLoggedWikiInitialization = false;

type TerminalEntry = {
  id: number;
  kind: "engine" | "player" | "system";
  text: string;
};

export default function App() {
  const engineRef = useRef<ZMachineEngineClient | null>(null);
  const nextEntryId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const [wikiError, setWikiError] = useState(false);
  const [input, setInput] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [entries, setEntries] = useState<TerminalEntry[]>([
    {
      id: 0,
      kind: "system",
      text: "Loading the Z-machine...",
    },
  ]);

  useEffect(() => {
    let isMounted = true;

    initWiki()
      .then(() => {
        if (!hasLoggedWikiInitialization) {
          console.log("IndexedDB initialized");
          hasLoggedWikiInitialization = true;
        }
      })
      .catch(() => {
        if (isMounted) {
          setWikiError(true);
        }
      });

    return () => {
      isMounted = false;
      };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const engine = new ZMachineEngineClient();
    engineRef.current = engine;

    engine
      .init()
      .then((response) => {
        if (!isMounted) {
          return;
        }

        setEntries([{ id: nextEntryId.current++, kind: "engine", text: response.text }]);
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
        setIsRunning(false);
      });

    return () => {
      isMounted = false;
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const command = String(formData.get("command") ?? "").trim();
    if (!command || !isReady || isRunning) {
      return;
    }

    const engine = engineRef.current;
    if (!engine) {
      return;
    }

    setInput("");
    setIsRunning(true);
    appendEntry("player", `> ${command}`);

    try {
      const response = await engine.sendCommand(command);
      appendEntry("engine", response.text);
    } catch (error) {
      console.error("Z-machine command failed", error);
      appendEntry("system", "The dungeon flickers. The command did not land.");
    } finally {
      setIsRunning(false);
    }
  }

  function appendEntry(kind: TerminalEntry["kind"], text: string) {
    setEntries((currentEntries) => [
      ...currentEntries,
      {
        id: nextEntryId.current++,
        kind,
        text,
      },
    ]);
  }

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-5">
        <header className="border-b border-amber-200/15 pb-4">
          <h1 className="text-xl font-semibold tracking-normal text-amber-100">
            Zorkish v0.02
          </h1>
        </header>
        <section
          aria-label="Game surface"
          className="flex flex-1 flex-col py-8"
        >
          <div
            ref={transcriptRef}
            className="min-h-0 flex-1 overflow-y-auto border border-amber-100/10 bg-stone-900/70 p-5 font-mono text-sm leading-6 shadow-2xl shadow-black/30"
          >
            {wikiError ? (
              <p className="mb-4 text-amber-100" role="alert">
                The local Wiki could not be opened. Refresh and try again.
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
                {entry.text}
              </pre>
            ))}
          </div>
          <form className="mt-4 flex gap-3" onSubmit={handleSubmit}>
            <input
              aria-label="Zork command"
              autoComplete="off"
              className="min-w-0 flex-1 border border-amber-100/15 bg-stone-900 px-4 py-3 font-mono text-sm text-stone-100 outline-none transition focus:border-amber-200/60"
              disabled={!isReady || isRunning}
              name="command"
              onChange={(event) => setInput(event.target.value)}
              placeholder={isReady ? "Type a Zork command..." : "Starting engine..."}
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
      </div>
    </main>
  );
}
