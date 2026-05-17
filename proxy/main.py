"""
Zorkish FastAPI proxy.
Receives LLM requests from the browser, attaches the NVIDIA API key,
forwards to inference.nvidia.com, streams responses back.
No business logic. No logging beyond errors. No rate limiting (v1).
"""

import json
import os
import time
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

app = FastAPI(title="Zorkish LLM Proxy")

# CORS - allow the browser to call this from localhost (dev) and
# eventually from the production domain. Update as needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:5174",   # Vite dev server, alternate port
        "http://127.0.0.1:5173",   # Vite dev server
        "http://127.0.0.1:5174",   # Vite dev server, alternate port
        "http://localhost:4173",   # Vite preview
        "http://127.0.0.1:4173",   # Vite preview
        # Add production origin here when deployed
    ],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=[
        "X-Zorkish-Proxy-Parse-Ms",
        "X-Zorkish-Proxy-Upstream-Ms",
        "X-Zorkish-Proxy-Total-Ms",
        "X-Zorkish-Proxy-Stream",
    ],
)

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY")
NVIDIA_BASE_URL = "https://inference-api.nvidia.com"

if not NVIDIA_API_KEY:
    raise RuntimeError("NVIDIA_API_KEY environment variable required")


@app.post("/api/llm")
async def llm_proxy(request: Request):
    """Forward an OpenAI-compatible request to NVIDIA inference."""
    request_started = time.perf_counter()
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    parse_ms = elapsed_ms(request_started)
    is_streaming = body.get("stream", False)
    model = str(body.get("model", "unknown"))

    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json",
    }

    upstream_url = f"{NVIDIA_BASE_URL}/v1/chat/completions"

    if is_streaming:
        async def stream_generator():
            stream_started = time.perf_counter()
            first_chunk_ms = None
            connect_ms = None
            status_code = 0
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "POST", upstream_url, json=body, headers=headers
                ) as response:
                    status_code = response.status_code
                    connect_ms = elapsed_ms(stream_started)
                    if response.status_code != 200:
                        error_body = await response.aread()
                        error_text = error_body.decode(errors="replace")
                        yield f"data: {json.dumps({'error': error_text})}\n\n"
                        log_timing(
                            model=model,
                            stream=is_streaming,
                            status=status_code,
                            parse_ms=parse_ms,
                            upstream_ms=connect_ms,
                            total_ms=elapsed_ms(request_started),
                            first_chunk_ms=first_chunk_ms,
                        )
                        return
                    async for chunk in response.aiter_bytes():
                        if first_chunk_ms is None:
                            first_chunk_ms = elapsed_ms(stream_started)
                        yield chunk
            log_timing(
                model=model,
                stream=is_streaming,
                status=status_code,
                parse_ms=parse_ms,
                upstream_ms=connect_ms,
                total_ms=elapsed_ms(request_started),
                first_chunk_ms=first_chunk_ms,
            )

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "X-Zorkish-Proxy-Parse-Ms": format_ms(parse_ms),
                "X-Zorkish-Proxy-Stream": "true",
            },
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        upstream_started = time.perf_counter()
        response = await client.post(
            upstream_url, json=body, headers=headers
        )
        upstream_ms = elapsed_ms(upstream_started)
        total_ms = elapsed_ms(request_started)
        log_timing(
            model=model,
            stream=is_streaming,
            status=response.status_code,
            parse_ms=parse_ms,
            upstream_ms=upstream_ms,
            total_ms=total_ms,
            first_chunk_ms=None,
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=response.text,
            )
        return JSONResponse(
            content=response.json(),
            headers={
                "X-Zorkish-Proxy-Parse-Ms": format_ms(parse_ms),
                "X-Zorkish-Proxy-Upstream-Ms": format_ms(upstream_ms),
                "X-Zorkish-Proxy-Total-Ms": format_ms(total_ms),
                "X-Zorkish-Proxy-Stream": "false",
            },
        )


@app.get("/health")
async def health():
    return {"status": "ok"}


def elapsed_ms(start_time: float):
    return (time.perf_counter() - start_time) * 1000


def format_ms(value: float | None):
    if value is None:
        return ""
    return f"{value:.1f}"


def log_timing(
    *,
    model: str,
    stream: bool,
    status: int,
    parse_ms: float,
    upstream_ms: float | None,
    total_ms: float,
    first_chunk_ms: float | None,
):
    print(
        "[zorkish-proxy] "
        f"model={model} "
        f"stream={str(stream).lower()} "
        f"status={status} "
        f"parse_ms={format_ms(parse_ms)} "
        f"upstream_ms={format_ms(upstream_ms)} "
        f"first_chunk_ms={format_ms(first_chunk_ms)} "
        f"total_ms={format_ms(total_ms)}",
        flush=True,
    )
