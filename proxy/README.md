# Zorkish LLM Proxy

This proxy holds the NVIDIA API key and forwards browser requests to the
OpenAI-compatible NVIDIA inference endpoint. It intentionally contains no
game orchestration logic.

## Local Run

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:NVIDIA_API_KEY = "your-key-here"
uvicorn main:app --host 0.0.0.0 --port 8000
```

The browser app calls `http://localhost:8000/api/llm` during development.

## Model IDs

Use exact IDs from `GET https://inference-api.nvidia.com/v1/models` for model
swaps. Catalog display names can differ from API IDs, and `nvcf/` vs.
`nvidia/` prefixes may route to different deployments.
