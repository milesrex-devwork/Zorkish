import { useEffect, useState } from "react";
import { initWiki } from "./wiki/access";

export default function App() {
  const [wikiError, setWikiError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    initWiki()
      .then(() => {
        console.log("IndexedDB initialized");
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

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-5">
        <header className="border-b border-amber-200/15 pb-4">
          <h1 className="text-xl font-semibold tracking-normal text-amber-100">
            Zorkish v0.01
          </h1>
        </header>
        <section
          aria-label="Game surface"
          className="flex flex-1 items-center justify-center py-12"
        >
          <div className="min-h-80 w-full max-w-3xl border border-amber-100/10 bg-stone-900/70 p-6 shadow-2xl shadow-black/30">
            {wikiError ? (
              <p className="text-sm leading-6 text-amber-100" role="alert">
                The local Wiki could not be opened. Refresh and try again.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
