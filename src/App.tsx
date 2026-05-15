export default function App() {
  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-5">
        <header className="border-b border-amber-200/15 pb-4">
          <h1 className="text-xl font-semibold tracking-normal text-amber-100">
            Zorkish v0.01
          </h1>
        </header>
        <section className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-3xl border border-amber-100/10 bg-stone-900/70 p-6 shadow-2xl shadow-black/30">
            <p className="text-sm leading-6 text-stone-300">
              The dungeon is quiet. For now.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

