<div align="center">

# Audio Transcription Pipeline

**A multi-stage audio-to-insight system. Built around clear interfaces, replaceable components, and production-oriented tradeoffs — not a thin wrapper around a single ASR model.**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Vosk](https://img.shields.io/badge/ASR-Vosk-FF6B35)](https://alphacephei.com/vosk/)
[![Whisper](https://img.shields.io/badge/ASR-Whisper%20(optional)-7C3AED)](https://github.com/openai/whisper)
[![Claude](https://img.shields.io/badge/LLM-Claude-D97757)](https://www.anthropic.com/)
[![License](https://img.shields.io/badge/License-MIT-374151)](#)

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
| **ASR** | Speech → text with confidence and timestamps | [`vosk_transcribe`](server.py#L87) (default) or [`whisper_transcribe`](server.py#L72) |
| **Post-Process** | Punctuation, summary, NER, sentiment, topics, action items | [`llm_postprocess`](server.py#L170) — single Claude call with regex fallback |

> Architecture diagrams (`docs/architecture.png`, `docs/sequence.png`) are referenced as placeholders and can be added without changing the source.

---

## Engineering Decisions

The choices below are the substance of this project. Each one is a deliberate tradeoff between accuracy, cost, latency, and operational complexity.

### 1. Vosk as default ASR, Whisper as opt-in

Whisper is the obvious "best" choice on paper — higher accuracy, multilingual, segment-level timestamps. It is not the obvious choice in production.

| Concern | Vosk (default) | Whisper (opt-in) |
|---|---|---|
| Cold-start | ~3s, 40 MB model | ~15s, 140 MB model + 1.5 GB torch |
| Inference | CPU, real-time on modest hardware | CPU 5–10× slower; GPU recommended |
| Dependencies | One pip install | torch + FFmpeg on PATH |
| Network | None required | None (local model) |
| Accuracy on clean English | Adequate (~10% WER) | Significantly better (~5% WER) |

For most short-form audio on consumer hardware, Vosk delivers usable results without making the service depend on a GPU or a 1.5 GB transitive dependency. Whisper is detected at startup and used automatically when available — no config flip required.

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

### 4. Idempotent retries via deterministic chunk IDs

Every request is assigned a `chunk_id` derived from the filename and a coarse timestamp. The contract is simple:

- **First call** runs the pipeline and stores the result.
- **Retry with the same `chunk_id`** returns the cached result via [`GET /transcribe/{chunk_id}`](server.py#L230) — no re-execution, no duplicate side effects, no double billing on the LLM call.

This is the same property cloud providers rely on for safe client retries. It costs nothing to implement and prevents an entire class of "we got charged twice" bugs.

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
read_wav(path: str)       -> (samples: List[int], sample_rate: int, duration: float)
energy_vad(samples, sr)   -> List[Tuple[float, float]]
vosk_transcribe(samples)  -> (text: str, confidence: float, words: List[Word])
llm_postprocess(raw_text) -> Dict[str, Any]
```

Replacing energy VAD with Silero, or Vosk with Deepgram, is a single-file change. Nothing upstream or downstream needs to know.

### 7. Decoupled architecture, not framework worship

FastAPI is the transport, not the application. The pipeline functions live as plain Python — no FastAPI imports leak into them. They can be invoked from a CLI, a Celery worker, a Lambda handler, or a notebook without modification. The web layer is intentionally thin.

---

## Features

- WAV native decode; MP3/M4A/FLAC/OGG via Whisper + FFmpeg
- Word-level and segment-level timestamps
- Confidence scoring per response
- Summary, sentiment, named entities, topics, action items
- Per-stage latency in every response
- Idempotent retries via `chunk_id`
- CORS-enabled REST API with auto-generated OpenAPI docs
- React frontend with live API and demo modes
- Offline operation by default (no API keys required)

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

```bash
curl -X POST "http://127.0.0.1:8000/transcribe?language=en" \
     -F "file=@harvard.wav"
```

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

```bash
pip install fastapi uvicorn vosk numpy python-multipart
python server.py
```

Service runs at `http://127.0.0.1:8000`. Open `index.html` for the frontend.

**Optional upgrades:**

```bash
pip install openai-whisper          # SOTA ASR; auto-detected at startup
pip install anthropic               # Real LLM post-processing
export ANTHROPIC_API_KEY=sk-ant-... # Required if anthropic is installed
```

The pipeline detects what's installed and routes accordingly. No configuration changes needed.

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
- **Idempotent by construction.** Safe to retry; safe to deduplicate at the queue layer; safe to cache.
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

This system is small on purpose. The interesting work in audio transcription is not picking the highest-accuracy model — that decision is increasingly commoditized. The interesting work is the orchestration: how stages compose, how failures propagate, how retries stay safe, how the system behaves when a dependency disappears, and how the response shape stays stable while everything underneath changes.

The architecture here treats each stage as a contract, not a class. Models are pluggable. The LLM call is collapsed to one round-trip. Retries are deterministic and free. The web layer is intentionally thin. The frontend negotiates with the API through a single JSON shape and nothing else.

These are the decisions that survive when the underlying models get replaced, the deployment target changes, or the team that wrote it moves on. That's what the system is optimized for.
