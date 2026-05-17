export interface EngineCommandResponse {
  command: string | null;
  text: string;
  rawUpdate: unknown;
}

export type EngineWorkerRequest =
  | {
      type: "init";
      requestId: number;
      storyUrl: string;
    }
  | {
      type: "command";
      requestId: number;
      command: string;
    };

export type EngineWorkerRequestPayload =
  | Omit<Extract<EngineWorkerRequest, { type: "init" }>, "requestId">
  | Omit<Extract<EngineWorkerRequest, { type: "command" }>, "requestId">;

export type EngineWorkerResponse =
  | {
      type: "ready";
      requestId: number;
      response: EngineCommandResponse;
    }
  | {
      type: "commandResult";
      requestId: number;
      response: EngineCommandResponse;
    }
  | {
      type: "error";
      requestId: number | null;
      message: string;
    };
