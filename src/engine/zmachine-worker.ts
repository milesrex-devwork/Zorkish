import type {
  EngineCommandResponse,
  EngineWorkerRequest,
  EngineWorkerResponse,
} from "./types";

type EmglkenVm = {
  start(options: {
    arguments: string[];
    Dialog: unknown;
    GlkOte: unknown;
  }): void;
};

type EmglkenModule = {
  default: () => Promise<EmglkenVm>;
};

type GlkInputRequest = {
  id: number;
  type: "line" | "char";
};

type GlkUpdate = {
  type: string;
  gen?: number;
  windows?: Array<{ id: number; type: string }>;
  content?: Array<{
    id: number;
    text?: Array<{
      append?: boolean;
      content?: Array<string | { text?: string }>;
    }>;
  }>;
  input?: GlkInputRequest[];
  timer?: number;
  disable?: boolean;
  message?: string;
};

type PendingTurn = {
  requestId: number;
  command: string | null;
  chunks: string[];
  latestUpdate: GlkUpdate | null;
  timeoutId: number;
};

class BrowserDialog {
  readonly async = true;
  private files = new Map<string, Uint8Array>();

  addFile(path: string, data: Uint8Array) {
    this.files.set(this.normalize(path), data);
  }

  async delete(path: string) {
    this.files.delete(this.normalize(path));
  }

  async exists(path: string) {
    return this.files.has(this.normalize(path));
  }

  get_dirs() {
    return {
      storyfile: "/",
      system_cwd: "/",
      temp: "/tmp",
      working: "/",
    };
  }

  prompt() {
    return Promise.resolve(null);
  }

  async read(path: string) {
    return this.files.get(this.normalize(path)) ?? null;
  }

  set_storyfile_dir() {
    return {
      storyfile: "/",
      working: "/",
    };
  }

  async write(files: Record<string, Uint8Array>) {
    for (const [path, data] of Object.entries(files)) {
      this.files.set(this.normalize(path), new Uint8Array(data));
    }
  }

  private normalize(path: string) {
    return path.replaceAll("\\", "/").replace(/^\/+/, "");
  }
}

class WorkerGlkOte {
  private acceptFunc: ((event: Record<string, unknown>) => void) | null = null;
  private generation = 0;
  private lineInput: GlkInputRequest | null = null;
  private timerId: number | null = null;

  constructor(private readonly onUpdate: (update: GlkUpdate) => void) {}

  init(options: { accept: (event: Record<string, unknown>) => void }) {
    this.acceptFunc = options.accept;
    this.sendEvent({
      type: "init",
      metrics: {
        buffercharheight: 1,
        buffercharwidth: 1,
        buffermarginx: 0,
        buffermarginy: 0,
        graphicsmarginx: 0,
        graphicsmarginy: 0,
        gridcharheight: 1,
        gridcharwidth: 1,
        gridmarginx: 0,
        gridmarginy: 0,
        height: 50,
        inspacingx: 0,
        inspacingy: 0,
        outspacingx: 0,
        outspacingy: 0,
        width: 80,
      },
      support: ["timer"],
    });
  }

  update(update: GlkUpdate) {
    if (typeof update.gen === "number") {
      this.generation = update.gen;
    }

    const nextLineInput = update.input?.find((input) => input.type === "line");
    this.lineInput = nextLineInput ?? null;
    this.updateTimer(update.timer);
    this.onUpdate(update);
  }

  submitLine(value: string) {
    if (!this.lineInput) {
      throw new Error("The engine is not waiting for line input.");
    }

    const windowId = this.lineInput.id;
    this.lineInput = null;
    this.sendEvent({
      type: "line",
      window: windowId,
      value,
    });
  }

  private updateTimer(interval: number | undefined) {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    if (interval) {
      this.timerId = window.setInterval(() => {
        this.sendEvent({ type: "timer" });
      }, interval);
    }
  }

  private sendEvent(event: Record<string, unknown>) {
    if (!this.acceptFunc) {
      throw new Error("GlkOte has not been initialized.");
    }

    this.acceptFunc({
      ...event,
      gen: this.generation,
    });
  }
}

let glkote: WorkerGlkOte | null = null;
let pendingTurn: PendingTurn | null = null;

self.addEventListener("message", (event: MessageEvent<EngineWorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(message: EngineWorkerRequest) {
  try {
    if (message.type === "init") {
      await initializeEngine(message.requestId, message.storyUrl);
      return;
    }

    if (message.type === "command") {
      runCommand(message.requestId, message.command);
    }
  } catch (error) {
    postError(message.requestId, getErrorMessage(error));
  }
}

async function initializeEngine(requestId: number, storyUrl: string) {
  const storyResponse = await fetch(storyUrl);

  if (!storyResponse.ok) {
    throw new Error(`Could not load story file: ${storyResponse.status}`);
  }

  const storyBytes = new Uint8Array(await storyResponse.arrayBuffer());
  const dialog = new BrowserDialog();
  dialog.addFile("zork1.z3", storyBytes);

  glkote = new WorkerGlkOte(handleGlkUpdate);
  pendingTurn = createPendingTurn(requestId, null);

  const { default: createBocfel } = await loadBocfel();
  const vm = await createBocfel();
  vm.start({
    arguments: ["zork1.z3"],
    Dialog: dialog,
    GlkOte: glkote,
  });
}

async function loadBocfel() {
  const interpreterUrl = new URL(
    "/vendor/emglken/bocfel-noz6.js",
    self.location.origin,
  ).href;
  return import(/* @vite-ignore */ interpreterUrl) as Promise<EmglkenModule>;
}

function runCommand(requestId: number, command: string) {
  if (!glkote) {
    throw new Error("The engine has not been initialized.");
  }

  pendingTurn = createPendingTurn(requestId, command);
  glkote.submitLine(command);
}

function createPendingTurn(requestId: number, command: string | null): PendingTurn {
  return {
    requestId,
    command,
    chunks: [],
    latestUpdate: null,
    timeoutId: window.setTimeout(() => {
      postError(requestId, "The Z-machine did not respond in time.");
      pendingTurn = null;
    }, 10000),
  };
}

function handleGlkUpdate(update: GlkUpdate) {
  if (update.type === "error") {
    postError(pendingTurn?.requestId ?? null, update.message ?? "Z-machine error.");
    pendingTurn = null;
    return;
  }

  if (!pendingTurn) {
    return;
  }

  const text = extractText(update);
  if (text) {
    pendingTurn.chunks.push(text);
  }
  pendingTurn.latestUpdate = update;

  const isReadyForInput = update.input?.some((input) => input.type === "line") ?? false;
  if (!isReadyForInput) {
    return;
  }

  const response: EngineCommandResponse = {
    command: pendingTurn.command,
    text: normalizeOutput(pendingTurn.chunks.join("")),
    rawUpdate: pendingTurn.latestUpdate,
  };

  clearTimeout(pendingTurn.timeoutId);
  postMessage({
    type: pendingTurn.command === null ? "ready" : "commandResult",
    requestId: pendingTurn.requestId,
    response,
  } satisfies EngineWorkerResponse);
  pendingTurn = null;
}

function extractText(update: GlkUpdate) {
  if (!update.content?.length) {
    return "";
  }

  const bufferWindowIds = new Set(
    update.windows
      ?.filter((windowDescription) => windowDescription.type === "buffer")
      .map((windowDescription) => windowDescription.id) ?? [],
  );

  let output = "";

  for (const content of update.content) {
    if (bufferWindowIds.size > 0 && !bufferWindowIds.has(content.id)) {
      continue;
    }

    for (const line of content.text ?? []) {
      if (!line.append && output) {
        output += "\n";
      }

      for (const run of line.content ?? []) {
        if (typeof run === "string") {
          output += run;
        } else if (run.text) {
          output += run.text;
        }
      }
    }
  }

  return output;
}

function normalizeOutput(output: string) {
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

function postError(requestId: number | null, message: string) {
  postMessage({
    type: "error",
    requestId,
    message,
  } satisfies EngineWorkerResponse);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Z-machine error.";
}
