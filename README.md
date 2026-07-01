<div align="center">

# Audio Transcription Pipeline

**A multi-stage audio-to-insight system. Built around clear interfaces, replaceable components, and production-oriented tradeoffs — not a thin wrapper around a single ASR model.**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Vosk](https://img.shields.io/badge/ASR-Vosk-FF6B35)](https://alphacephei.com/vosk/)
[![Whisper](https://img.shields.io/badge/ASR-Whisper%20(optional)-7C3AED)](https://github.com/openai/whisper)
[![Claude](https://img.shields.io/badge/LLM-Claude-D97757)](https://www.anthropic.com/)
[![License](https://img.shields.io/badge/License-MIT-374151)](LICENSE)

<!-- Replace with an architecture banner image at docs/architecture.png when available -->
<!-- <img src="docs/architecture.png" alt="Pipeline architecture" width="780"/> -->

</div>

---

## Overview

A four-stage pipeline that converts raw audio into structured, downstream-ready insights:

```
Audio  →  Ingest  →  VAD  →  ASR  →  LLM Post-Process  →  Structured JSON
```

The system was built to demonstrate **engineering decisions, not model training**. Every stage is independently replaceable, every external dependency has a fallback, and every response surfaces per-stage latency so operators can see exactly where time and cost are spent.

**Engineering goals that shaped the architecture:**

- **Reliability before features.** No single dependency can take the service down — Whisper degrades to Vosk degrades to a documented mock; Claude degrades to a deterministic regex normalizer.
- **Operational visibility.** Each stage emits its own latency; the response is self-describing.
- **Stable contracts.** The JSON shape between the API and the frontend is fixed. Internals can change freely.
- **Zero-setup operation.** The default configuration runs offline on CPU with no API keys.

---

## Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  Audio   │───▶│  Ingest  │───▶│   VAD    │───▶│     ASR      │───▶│  LLM Post-   │───▶ JSON
│ WAV/MP3  │    │  decode  │    │ silence  │    │ Vosk/Whisper │    │  Process     │
└──────────┘    │  resample│    │ detection│    │              │    │ Claude/Regex │
                └──────────┘    └──────────┘    └──────────────┘    └──────────────┘
                     │                │                │                    │
                     ▼                ▼                ▼                    ▼
                ingest_ms         vad_ms           asr_ms           postprocess_ms
```

| Stage | Responsibility | Implementation |
|---|---|---|
| **Ingest** | Decode upload to mono int16 samples at 16 kHz | [`read_wav`](server.py#L127) (stdlib); Whisper + FFmpeg for non-WAV formats |
| **VAD** | Identify speech regions, prepare for chunking | [`energy_vad`](server.py#L141) — RMS thresholding per 20 ms frame |
| **ASR** | Speech → text with a confidence score | Whisper (inline in [`transcribe`](server.py#L238), via [`get_whisper`](server.py#L72)) if installed, else [`vosk_transcribe`](server.py#L87), else a mock transcript |
| **Post-Process** | Punctuation, summary, NER, sentiment, topics, action items | [`llm_postprocess`](server.py#L170) — single Claude call with regex fallback |

> Architecture diagrams (`docs/architecture.png`, `docs/sequence.png`) are referenced as placeholders and can be added without changing the source.

---

## Engineering Decisions

The choices below are the substance of this project. Each one is a deliberate tradeoff between accuracy, cost, latency, and operational complexity.

### 1. Whisper preferred when installed, Vosk as the offline fallback

`server.py` checks `WHISPER_AVAILABLE` first: if `openai-whisper` is importable, every request is transcribed with Whisper. Only when Whisper is absent does the code fall through to Vosk (`VOSK_AVAILABLE`, gated on the bundled model directory existing), and only when neither is present does it fall through to a documented mock transcript. This makes Vosk the zero-dependency, always-available baseline — the small bundled model ships in this repo so the service works out of the box — while Whisper is the opt-in accuracy upgrade.

| Concern | Vosk (bundled, zero-config) | Whisper (opt-in, `pip install openai-whisper`) |
|---|---|---|
| Cold-start | ~3s, 40 MB model | ~15s, 140 MB model + torch |
| Inference | CPU, real-time on modest hardware | CPU 5–10x slower; GPU recommended |
| Dependencies | One pip install | torch + FFmpeg on PATH |
| Network | None required | None (local model) |
| Accuracy on clean English | Adequate | Higher |

For most short-form audio on consumer hardware, Vosk delivers usable results without making the service depend on a GPU or a large transitive dependency. If Whisper is installed, the pipeline uses it automatically for every request — no config flip required.

### 2. Single-prompt LLM orchestration

The post-processing stage produces six derived outputs: clean punctuated text, summary, sentiment, named entities, topics, and action items. Each could be a separate model or API call. Instead, one prompt produces all six in a structured JSON response.

**The math:** six round-trips at ~500 ms each is ~3 seconds of pure network latency. One round-trip is ~700 ms. The model already has the full transcript in context — asking it to emit one extra field is essentially free.

This also collapses the failure surface from six points to one. If the call fails, the entire enrichment layer falls back together, gracefully, to the deterministic regex normalizer.

### 3. VAD-based chunking strategy

Naive chunking of long audio (splitting on time boundaries) cuts mid-word and degrades ASR accuracy by 15–30%. VAD-based chunking splits on detected silences instead, which:

- **Bounds memory** — a one-hour 16 kHz file is 115 MB raw; chunking lets us stream slice-by-slice rather than load it all.
- **Respects model context** — Whisper's 30s window means anything longer is chunked internally, blindly. Pre-chunking on phrase boundaries beats blind splits.
- **Unlocks parallelism** — independent segments fan out across workers; results merge in order.

The current implementation uses energy thresholding for zero-dependency operation. WebRTC VAD or Silero VAD are documented production upgrades — the function signature (`samples, sample_rate → [(start, end), ...]`) is stable, so swaps are mechanical.

### 4. Retrievable results via a stable chunk ID

Every request is assigned a `chunk_id` (an 8-character hash of the filename and request timestamp) and the full response is appended to an in-memory `HISTORY` list. That ID can be used afterward to re-fetch the exact same result via [`GET /transcribe/{chunk_id}`](server.py#L230), without re-reading or re-parsing anything — useful for a frontend that wants to deep-link to a past transcript or poll a result after the initial call.

Note that this is *not* request-level idempotency: each `POST /transcribe` call always re-runs the full pipeline and mints a new `chunk_id` (the hash includes the current timestamp), even for byte-identical uploads. `HISTORY` is also process-local and unbounded in memory — it resets on restart and `GET /history` only surfaces the most recent 20 entries. A production version of this would hash the file content (not the timestamp) for true dedup and back `HISTORY` with persistent storage.

### 5. Layered fallbacks at every external boundary

Every external dependency is wrapped in a degradation path:

| Layer | Primary | Fallback | Final fallback |
|---|---|---|---|
| Audio decode | Native WAV | FFmpeg via Whisper | HTTP 415 with diagnostic |
| ASR | Whisper | Vosk | Documented mock |
| LLM enrichment | Claude API | Regex normalizer | Empty enrichment fields, raw text returned |

No single failure mode produces an HTTP 500. The worst case is a degraded response with the raw transcript and explicit `engine: "mock"` metadata — actionable, not opaque.

### 6. Stable interfaces between stages

Each stage exposes a typed function signature. The orchestrator wires them together; it doesn't know what's inside.

```python
read_wav(path: str)              -> (samples: List[int], sample_rate: int, duration: float)
energy_vad(samples, sr)          -> List[Tuple[float, float]]
vosk_transcribe(samples, sr)     -> (text: str, confidence: float, word_count: int)
llm_postprocess(raw_text: str)   -> Dict[str, Any]
```

Replacing energy VAD with Silero, or Vosk with Deepgram, is a single-file change. Nothing upstream or downstream needs to know.

### 7. Decoupled architecture, not framework worship

FastAPI is the transport, not the application. The pipeline functions live as plain Python — no FastAPI imports leak into them. They can be invoked from a CLI, a Celery worker, a Lambda handler, or a notebook without modification. The web layer is intentionally thin.

---

## Features

- WAV native decode via the stdlib `wave` module; MP3/M4A/FLAC/OGG and other formats via Whisper + FFmpeg when Whisper is installed
- Energy-based voice activity detection (silence/speech segmentation) with a segment count returned per response
- Confidence scoring per response (derived from Whisper's average log-probability, or averaged Vosk word confidences)
- LLM post-processing: cleaned/punctuated transcript, 1-2 sentence summary, sentiment, named entities, action items, and topics — via a single Claude API call, with a deterministic regex-based fallback when `anthropic` isn't installed or no API key is set
- Per-stage latency (`ingest_ms`, `vad_ms`, `asr_ms`, `postprocess_ms`, `total_ms`) in every response
- Retrievable results via `chunk_id` (`GET /transcribe/{chunk_id}`) and a rolling history of the last 20 transcripts (`GET /history`)
- Graceful degradation at every layer: Whisper unavailable falls back to Vosk falls back to a labeled mock transcript; Anthropic unavailable or unconfigured falls back to a regex-based cleanup — the service runs with zero optional dependencies installed
- CORS-enabled REST API with auto-generated OpenAPI docs at `/docs`
- React frontend (no build step) with a live API mode and a demo mode using pre-baked mock scenarios
- Offline operation by default (no API keys required; the bundled Vosk model and stdlib WAV decoding are enough to get real transcripts)

---

## API

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | [`/health`](server.py#L213) | Liveness probe and feature availability flags |
| `POST` | [`/transcribe`](server.py#L238) | Submit audio, return full structured response |
| `GET`  | [`/transcribe/{id}`](server.py#L230) | Retrieve a previously-computed result |
| `GET`  | [`/history`](server.py#L225) | Last 20 transcripts (frontend sidebar) |

OpenAPI / Swagger UI is auto-generated at `/docs`.

### Example: transcribe a file

The repo ships `harvard.wav` (a standard Harvard Sentences phonetic test recording) specifically so there's a working example with no extra downloads. With the server running (`python server.py`):

```bash
curl -X POST "http://127.0.0.1:8000/transcribe?language=en" \
     -F "file=@harvard.wav"
```

Or with Python's `requests`:

```python
import requests

with open("harvard.wav", "rb") as f:
    resp = requests.post(
        "http://127.0.0.1:8000/transcribe",
        params={"language": "en", "run_vad": True, "run_postprocess": True},
        files={"file": f},
    )
resp.raise_for_status()
print(resp.json()["clean_text"])
```

Query parameters on `POST /transcribe` (all optional): `language` (default `"en"`, passed through to Whisper if installed — Vosk's bundled model is English-only regardless), `run_vad` (default `true`, toggles the VAD stage), `run_postprocess` (default `true`, toggles the LLM/regex enrichment stage).

### Example response

```json
{
  "chunk_id":     "a1b2c3d4",
  "engine":       "vosk",
  "language":     "en",
  "duration_sec": 18.36,
  "confidence":   0.94,
  "word_count":   47,
  "vad_segments": 12,

  "raw_text":   "the birch canoe slid on the smooth planks ...",
  "clean_text": "The birch canoe slid on the smooth planks. ...",
  "summary":    "Reading from the Harvard Sentences phonetic test set.",
  "sentiment":  "neutral",

  "named_entities": [],
  "action_items":   [],
  "topics":         ["phonetics", "sample audio"],

  "timings": {
    "ingest_ms":      8,
    "vad_ms":         12,
    "asr_ms":         1840,
    "postprocess_ms": 6,
    "total_ms":       1866
  }
}
```

### Latency breakdown (sample run on `harvard.wav`, CPU only)

| Stage | Latency | Share of total |
|---|---:|---:|
| Ingest | 8 ms | < 1% |
| VAD | 12 ms | < 1% |
| ASR (Vosk) | 1840 ms | 99% |
| Post-process (regex fallback) | 6 ms | < 1% |
| **Total** | **1866 ms** | **100%** |

ASR dominates. This is the right shape — the rest of the orchestrator should be invisible in the timing profile.

---

## Project Structure

```
audio-to-text/
├── README.md                       # This document
├── LICENSE                         # MIT license
├── requirements.txt                # Python dependencies (required + optional)
├── .env.example                    # Template for ANTHROPIC_API_KEY
├── server.py                       # FastAPI service — pipeline orchestration
├── app.jsx                         # React frontend (Babel-standalone, no build step)
├── index.html                      # CDN-loaded React mount point
├── harvard.wav                     # Sample audio for testing
├── _uploads/                       # Runtime upload directory (gitignored)
└── vosk-model-small-en-us-0.15/    # Offline ASR model (~40 MB on disk)
```

Backend, frontend, and model artifacts are intentionally kept at the same level. There's no `src/` ceremony for a service this size — the cost of finding files outweighs the benefit of nested directories.

---

## Installation & Setup

### Backend

```bash
pip install -r requirements.txt
python server.py
```

`requirements.txt` includes the always-required packages (`fastapi`, `uvicorn`, `python-multipart`) alongside the optional ones (`openai-whisper`, `vosk`, `numpy`, `anthropic`). Nothing needs to be installed beyond `fastapi`, `uvicorn`, and `python-multipart` for the service to run — `vosk` plus the bundled `vosk-model-small-en-us-0.15/` directory gives real offline transcription once installed, and everything else degrades gracefully per the fallback table above. Startup prints which optional engines were detected:

```
[server] whisper=False vosk=True anthropic=False
```

The service listens at `http://127.0.0.1:8000`. Interactive API docs are at `http://127.0.0.1:8000/docs`.

**Optional upgrades**, installable independently and detected automatically at import time — no config flag needed:

```bash
pip install openai-whisper   # preferred ASR engine when present (see Engineering Decisions, #1)
pip install anthropic        # enables real LLM post-processing instead of the regex fallback
```

If `anthropic` is installed, also set `ANTHROPIC_API_KEY` (see Environment Variables below) — without it, `llm_postprocess` falls back to the regex-based cleanup even with the package installed.

### Environment Variables

`server.py` reads exactly one environment variable:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | No | Enables real Claude-based post-processing in `llm_postprocess`. Checked via `os.environ.get("ANTHROPIC_API_KEY")`. If unset (or if `anthropic` isn't installed, or the API call raises), the pipeline falls back to a deterministic regex-based cleanup and returns `sentiment: "neutral"`, empty `named_entities`/`action_items`, and `topics: ["general"]`. |

Copy `.env.example` to `.env` and fill in the value, or export it directly in your shell (`export ANTHROPIC_API_KEY=sk-ant-...` on macOS/Linux, `$env:ANTHROPIC_API_KEY="sk-ant-..."` in PowerShell). `server.py` does not load `.env` files itself (no `python-dotenv` dependency) — either export the variable in your shell/process manager before running `python server.py`, or load it yourself. `GET /health` reports whether the key is currently set via `anthropic_key_set`.

### Running the frontend

The frontend is plain static files — `index.html` loads React 18 and Babel Standalone from CDN `<script>` tags and compiles `app.jsx` in the browser, so there is no `npm install` or build step. Any of the following works:

```bash
# Simplest: open the file directly
# (double-click index.html, or)
start index.html          # Windows
open index.html           # macOS

# Or serve it so fetch() has a proper origin (recommended, avoids file:// quirks)
python -m http.server 5500
# then visit http://127.0.0.1:5500/index.html
```

The frontend's "Live API" mode calls `http://127.0.0.1:8000` directly (hardcoded as `API_BASE` in `app.jsx`), so the backend must be running first. CORS is wide open (`allow_origins=["*"]`) in `server.py`, so it does not matter which origin serves the static files.

---

## Frontend

The React frontend is intentionally minimal: file upload, live API mode, demo mode with pre-baked scenarios, and a result panel that renders the full response (transcript, summary, NER, topics, action items, per-stage timing bar).

<!-- Replace these placeholders with real screenshots when available -->
<!--
<p align="center">
  <img src="docs/frontend-upload.png" alt="Upload screen" width="48%"/>
  <img src="docs/frontend-result.png" alt="Result panel" width="48%"/>
</p>
-->

`docs/frontend-upload.png` and `docs/frontend-result.png` are referenced as placeholders. Drop screenshots in `docs/` and uncomment the block above.

---

## Performance & Reliability Notes

- **Offline-capable by default.** No network, no API key, no GPU required. Vosk model is bundled.
- **CPU-friendly inference.** ~1.8 s for an 18 s clip on a mid-range laptop CPU; near real-time.
- **No single point of failure.** Every external dependency has a documented fallback path.
- **Replaceable model backends.** Swapping Vosk for Deepgram or Whisper for a GPU-served Whisper-large is a one-function change.
- **Low orchestration overhead.** Non-ASR stages contribute <2% of total latency. The orchestrator does not get in the way.
- **Results are addressable, not deduplicated.** Every response gets a `chunk_id` and can be re-fetched via `GET /transcribe/{chunk_id}`, but `POST /transcribe` itself always re-runs the pipeline (see Engineering Decisions, #4) — true request-level dedup would need content-based hashing, which isn't implemented yet.
- **Self-describing responses.** Every payload includes engine, confidence, segment count, and per-stage latency. Operators don't need a separate dashboard to understand a single request.

---

## Future Improvements

- **Streaming transcription.** WebSocket endpoint emitting partial hypotheses as audio arrives. The current architecture already chunks by VAD; streaming is a transport change, not an architecture change.
- **Speaker diarization.** Add a `pyannote.audio` stage between VAD and ASR. The interface (segments in, labeled segments out) fits naturally.
- **Queue-based processing.** Replace synchronous `POST /transcribe` with `POST /jobs` returning `{job_id}`; workers consume from Redis/SQS and write results to a results store. Frontend polls or subscribes.
- **Production storage layer.** Object storage (S3) for audio with lifecycle policies; Postgres + OpenSearch for transcripts with full-text and vector search.
- **Kubernetes deployment.** Horizontal pod autoscaling on queue depth; separate worker pools for CPU (Vosk) and GPU (Whisper) workloads.
- **WebRTC VAD or Silero VAD.** Drop-in replacement for the energy-based detector; better performance on noisy audio.
- **Per-IP rate limiting.** Prevent a single client from saturating the worker pool.
- **Observability.** OpenTelemetry traces across all four stages; latency histograms exported to Prometheus.

---

## A Note on the Approach

This system is small on purpose. The interesting work in audio transcription is not picking the highest-accuracy model — that decision is increasingly commoditized. The interesting work is the orchestration: how stages compose, how failures propagate, how results stay addressable, how the system behaves when a dependency disappears, and how the response shape stays stable while everything underneath changes.

The architecture here treats each stage as a contract, not a class. Models are pluggable. The LLM call is collapsed to one round-trip. Every result is addressable by `chunk_id`. The web layer is intentionally thin. The frontend negotiates with the API through a single JSON shape and nothing else.

These are the decisions that survive when the underlying models get replaced, the deployment target changes, or the team that wrote it moves on. That's what the system is optimized for.
