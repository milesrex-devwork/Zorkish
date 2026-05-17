/// <reference types="vite/client" />

declare module "/vendor/emglken/bocfel-noz6.js" {
  interface EmglkenVm {
    start(options: {
      arguments: string[];
      Dialog: unknown;
      GlkOte: unknown;
    }): void;
  }

  const createBocfel: () => Promise<EmglkenVm>;
  export default createBocfel;
}

