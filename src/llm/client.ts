export const LLM_PROXY_URL =
  import.meta.env.VITE_LLM_PROXY_URL ?? "http://127.0.0.1:8000/api/llm";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
};

export type LlmTiming = {
  browser_request_ms: number;
  proxy_parse_ms: number | null;
  proxy_upstream_ms: number | null;
  proxy_total_ms: number | null;
  stream: boolean;
  first_token_ms?: number | null;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type StreamDeltaResponse = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
  }>;
  error?: unknown;
};

export async function requestChatCompletion(
  request: ChatCompletionRequest,
) {
  const startedAt = performance.now();
  const response = await fetch(LLM_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const browserRequestMs = performance.now() - startedAt;
  const timing = readProxyTiming(response, browserRequestMs);

  if (!response.ok) {
    throw new Error(`LLM proxy request failed: ${response.status}`);
  }

  const completion = (await response.json()) as ChatCompletionResponse;
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM proxy response did not contain text content");
  }

  return {
    content,
    timing,
  };
}

export async function streamChatCompletion(
  request: ChatCompletionRequest,
  onToken: (token: string) => void,
) {
  const startedAt = performance.now();
  const response = await fetch(LLM_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM streaming proxy request failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("LLM streaming response had no body");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = "";
  let content = "";
  let firstTokenMs: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      const token = readStreamingToken(line);
      if (token === null) {
        continue;
      }
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - startedAt;
      }
      content += token;
      onToken(token);
    }
  }

  pending += decoder.decode();
  const finalToken = readStreamingToken(pending);
  if (finalToken !== null) {
    if (firstTokenMs === null) {
      firstTokenMs = performance.now() - startedAt;
    }
    content += finalToken;
    onToken(finalToken);
  }

  return {
    content,
    timing: {
      ...readProxyTiming(response, performance.now() - startedAt),
      first_token_ms: firstTokenMs,
    },
  };
}

function readStreamingToken(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return null;
  }

  const parsed = JSON.parse(data) as StreamDeltaResponse;
  if (typeof parsed.error === "string") {
    throw new Error(parsed.error);
  }

  const content = parsed.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : null;
}

function readProxyTiming(response: Response, browserRequestMs: number): LlmTiming {
  return {
    browser_request_ms: browserRequestMs,
    proxy_parse_ms: readMsHeader(response, "X-Zorkish-Proxy-Parse-Ms"),
    proxy_upstream_ms: readMsHeader(response, "X-Zorkish-Proxy-Upstream-Ms"),
    proxy_total_ms: readMsHeader(response, "X-Zorkish-Proxy-Total-Ms"),
    stream: response.headers.get("X-Zorkish-Proxy-Stream") === "true",
  };
}

function readMsHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
