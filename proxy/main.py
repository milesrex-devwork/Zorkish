"""
Zorkish FastAPI proxy.
Receives LLM requests from the browser, attaches the NVIDIA API key,
forwards to inference.nvidia.com, streams responses back.
No business logic. No logging beyond errors. No rate limiting (v1).
"""

import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import httpx

app = FastAPI(title="Zorkish LLM Proxy")

# CORS - allow the browser to call this from localhost (dev) and
# eventually from the production domain. Update as needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:4173",   # Vite preview
        # Add production origin here when deployed
    ],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY")
NVIDIA_BASE_URL = "https://inference-api.nvidia.com"

if not NVIDIA_API_KEY:
    raise RuntimeError("NVIDIA_API_KEY environment variable required")


@app.post("/api/llm")
async def llm_proxy(request: Request):
    """Forward an OpenAI-compatible request to NVIDIA inference."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    is_streaming = body.get("stream", False)

    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json",
    }

    upstream_url = f"{NVIDIA_BASE_URL}/v1/chat/completions"

    if is_streaming:
        async def stream_generator():
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "POST", upstream_url, json=body, headers=headers
                ) as response:
                    if response.status_code != 200:
                        error_body = await response.aread()
                        yield f"data: {{\"error\": {error_body.decode()}}}\n\n"
                        return
                    async for chunk in response.aiter_bytes():
                        yield chunk

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            upstream_url, json=body, headers=headers
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=response.text,
            )
        return response.json()


@app.get("/health")
async def health():
    return {"status": "ok"}

