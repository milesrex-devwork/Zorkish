import type {
  EngineCommandResponse,
  EngineWorkerRequest,
  EngineWorkerRequestPayload,
  EngineWorkerResponse,
} from "./types";

type PendingRequest = {
  resolve: (response: EngineCommandResponse) => void;
  reject: (error: Error) => void;
};

export class ZMachineEngineClient {
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private worker: Worker;

  constructor() {
    this.worker = new Worker(new URL("./zmachine-worker.ts", import.meta.url), {
      type: "module",
    });

    this.worker.addEventListener("message", (event) => {
      this.handleMessage(event.data as EngineWorkerResponse);
    });

    this.worker.addEventListener("error", (event) => {
      this.rejectAll(new Error(event.message || "The Z-machine worker failed."));
    });
  }

  init(storyUrl = "/zork1.z3") {
    return this.send({ type: "init", storyUrl });
  }

  sendCommand(command: string) {
    return this.send({ type: "command", command });
  }

  dispose() {
    this.rejectAll(new Error("The Z-machine worker was stopped."));
    this.worker.terminate();
  }

  private send(message: EngineWorkerRequestPayload): Promise<EngineCommandResponse> {
    const requestId = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request = { ...message, requestId } as EngineWorkerRequest;
      this.worker.postMessage(request);
    });
  }

  private handleMessage(message: EngineWorkerResponse) {
    if (message.type === "error") {
      if (message.requestId !== null) {
        const pending = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        pending?.reject(new Error(message.message));
        return;
      }

      this.rejectAll(new Error(message.message));
      return;
    }

    const pending = this.pending.get(message.requestId);
    this.pending.delete(message.requestId);
    pending?.resolve(message.response);
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
