# Audio Transcription Pipeline

Upload an audio file. Get back a transcript with **timestamps, summary, sentiment, named entities, topics, and action items** — from one API call.

Built as a take-home exercise. The focus is on **engineering decisions** (what to compose, where to draw boundaries, how to fail gracefully) rather than training a model.

---

## What it does

**Input:** any audio file (WAV out of the box; MP3, M4A, FLAC, etc. when Whisper is installed).

**Output:** a single JSON document with everything a downstream consumer might need.

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
  "clean_text": "The birch canoe slid on the smooth planks ...",
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

The pipeline runs **four stages**, and the response tells you what each one cost.

---

## Quick start

**1. Install dependencies**

```powershell
pip install fastapi uvicorn vosk numpy python-multipart
```

**2. Start the API**

```powershell
python server.py
```

You'll see `http://127.0.0.1:8000`. The auto-generated docs live at `/docs`.

**3. Open the frontend**

Double-click [`index.html`](index.html). Switch to **Live API** mode, drop in `harvard.wav`, click **Transcribe**.

That's it. The frontend talks to the local API, which runs the pipeline and returns the JSON above.

### Optional upgrades

| Add | Command | What you get |
|---|---|---|
| Better ASR | `pip install openai-whisper` | SOTA accuracy, 99 languages (slower on CPU) |
| Real post-processing | `pip install anthropic` + set `ANTHROPIC_API_KEY` | LLM-generated summary, NER, sentiment instead of regex fallback |

The code auto-detects what's installed and picks the best available engine — no config changes needed.

---

## Architecture

```
[Audio file]  ->  [Ingest]  ->  [VAD]  ->  [ASR]  ->  [LLM post-process]  ->  [JSON response]
  WAV / MP3      decode +       detect      speech       punctuate,
                 resample       speech      to text      summarise,
                                segments                 extract entities
```

| Stage | Purpose | Code |
|---|---|---|
| **1. Ingest** | Decode upload to mono int16 samples | [`read_wav`](server.py#L127) for WAV; Whisper + FFmpeg for everything else |
| **2. VAD** | Detect speech, skip silence | [`energy_vad`](server.py#L141) — RMS thresholding per 20 ms frame |
| **3. ASR** | Speech → text with timestamps + confidence | [`vosk_transcribe`](server.py#L87) (default) or Whisper |
| **4. LLM post-process** | One call for clean text, summary, NER, sentiment, topics, action items | [`llm_postprocess`](server.py#L170) |

**Why four stages and not one big model?** Each stage has a different failure mode, a different cost, and a different upgrade path. Decoupling them means you can swap any one (better VAD, GPU ASR, cheaper LLM) without touching the others.

---

## API

| Method | Path                  | Purpose                                          |
|--------|-----------------------|--------------------------------------------------|
| `GET`  | [`/health`](server.py#L213)            | Liveness probe + which features are available  |
| `POST` | [`/transcribe`](server.py#L238)        | Submit audio, run pipeline, return full JSON   |
| `GET`  | [`/transcribe/{id}`](server.py#L230)   | Fetch a previously-computed result (for retries) |
| `GET`  | [`/history`](server.py#L225)           | Last 20 transcripts (powers the UI sidebar)    |

**Example: transcribing a file from the command line**

```powershell
curl.exe -X POST "http://127.0.0.1:8000/transcribe?language=en" `
         -F "file=@harvard.wav"
```

OpenAPI / Swagger docs are auto-generated at <http://127.0.0.1:8000/docs>.

---

## Design decisions

The brief asked six questions. Here's how the project answers each.

### 1. How do you handle different audio formats?

**Two-tier strategy:**

- **WAV is handled natively** by Python's stdlib `wave` module — no external binaries, no extra dependencies. The reader normalises to mono int16 regardless of channel count or bit depth.
- **Everything else (MP3, M4A, FLAC, OGG, WebM, ...) is delegated to FFmpeg** via Whisper. Same approach browsers and most production ASR services use: instead of writing decoders for every codec, lean on the one tool that already handles them all.

If neither path works (no FFmpeg, non-WAV upload), the API returns **HTTP 415** with a clear message. Failing loud is better than failing weird.

### 2. How do you deal with long audio files?

VAD-based chunking solves three problems at once:

- **Memory** — a one-hour 16 kHz WAV is ~115 MB in RAM. Chunking lets us stream slice-by-slice.
- **Model context limits** — Whisper processes 30 s windows; beyond that it chunks blindly and can cut mid-word. VAD splits on natural silences, so chunks land on phrase boundaries.
- **Parallelism** — each VAD segment is independent. Fan them out across workers, re-assemble in order.

The current implementation uses energy thresholding ([`energy_vad`](server.py#L141)) — cheap, zero dependencies, good for clean audio. For noisy production audio, swap in Silero VAD (1.8 MB RNN). The function signature stays the same.

### 3. How would you handle concurrent uploads?

**Three layers, scaling progressively:**

- **In-process (async I/O).** FastAPI is async; `/transcribe` is `async def`. File reads and the LLM HTTP call don't block the event loop — one process handles dozens of in-flight requests.
- **Per-machine (worker pool).** ASR is CPU- or GPU-bound and can't share the event loop. Either run uvicorn with `--workers N`, or offload `run_pipeline` to a thread/process executor.
- **Horizontal (job queue).** Beyond one box: `POST /transcribe` returns `{job_id, status: "queued"}` immediately, work goes to Redis/SQS, a worker fleet writes results to a database. Same shape AWS Transcribe and Deepgram use.

Add a per-IP rate limit so one client can't drown out everyone else.

### 4. How would you store audio and transcripts?

**Separate them** — they have different access patterns and very different storage costs.

**Audio (large, write-once, rarely re-read):**
- Object storage — S3 / GCS / Azure Blob, keyed by `chunk_id`.
- Lifecycle policy: hot for 7 days, then Glacier / Coldline.
- Encrypted at rest and in transit.

**Transcripts (small, structured, frequently queried):**
- Postgres for relational queries, OpenSearch if users want to **search inside transcripts** (the killer feature for support and meeting tools).
- Indexed on `chunk_id`, `language`, `created_at`, full-text on `clean_text`.
- Vector embeddings (pgvector / Pinecone) for semantic search.

This project's `_uploads/` folder + in-memory [`HISTORY`](server.py#L64) list is a demo shortcut, not the production answer.

**One thing I'd bake in from day one:** a TTL column and a delete-by-user endpoint. Transcripts contain PII; GDPR/retention is painful to bolt on later.

### 5. How do you retry or recover failed transcriptions?

Failures fall into two buckets, handled differently:

| Type | Examples | Strategy |
|---|---|---|
| **Transient** | LLM API timeout, network blip, rate limit | Exponential backoff with jitter (1 s, 2 s, 4 s + random) |
| **Permanent** | Corrupt audio, unsupported codec, empty ASR output, invalid LLM JSON | Log to dead-letter queue with `chunk_id`; return partial result (raw ASR only) instead of HTTP 500 |

**Idempotency** keeps retries safe: every request gets a `chunk_id` (hash of filename + timestamp). If the client retries with the same id, [`GET /transcribe/{chunk_id}`](server.py#L230) returns the cached result instead of re-running the pipeline. Saves money, prevents duplicate side effects.

### 6. How would you expose this as an API?

**FastAPI**, for four concrete reasons:

- **Async-native** — file uploads and LLM calls are I/O-bound. One worker handles many in-flight requests.
- **Auto-generated OpenAPI docs** at `/docs` — the frontend gets a typed contract for free.
- **Pydantic validation** — malformed input becomes HTTP 422 with a clear error before the handler runs.
- **Multipart upload** built in — one decorator handles WAV/MP3 streaming.

[`CORSMiddleware`](server.py#L55) is configured because the frontend (`file://` or `localhost:5500`) runs on a different origin than the API (`localhost:8000`).

---

## Tech choices — and what I'd swap

| Choice | Why | Production alternative |
|---|---|---|
| **Vosk** as default ASR | Offline, CPU-only, no API key, 40 MB | Whisper / Deepgram / AWS Transcribe |
| **Energy VAD** | Zero deps, good for clean audio | Silero VAD (1.8 MB RNN) |
| **One LLM call** for post-processing | One round-trip, ~700 ms instead of 3 × 500 ms | Same; switch to a cheaper model for high volume |
| **FastAPI** | Async, OpenAPI, Pydantic — built-in | Same |
| **React + Babel-standalone** | No build step for a demo | Vite or Next.js with a real bundler |
| **In-memory `HISTORY`** | Fine for a demo | Postgres + S3 (see Q4) |

Every component is replaceable behind a stable interface. That's the actual design pattern — the stages are decoupled, so I can upgrade any single one without rewriting the orchestrator.

---

## Project layout

```
audio to text converter/
├── README.md                       <- you are here
├── server.py                       <- FastAPI service — all four pipeline stages
├── app.jsx                         <- React frontend (no build step)
├── index.html                      <- loads React via CDN, mounts app.jsx
├── harvard.wav                     <- sample audio for testing
├── _uploads/                       <- audio saved on upload (dev only)
└── vosk-model-small-en-us-0.15/    <- offline ASR model (40 MB, see note below)
```

The **frontend ↔ API contract** lives in [`app.jsx`](app.jsx) (`runLive` function) and matches the JSON shape returned by [`/transcribe`](server.py#L238). Field names like `raw_text`, `clean_text`, `confidence`, `timings.*_ms` are the agreement between the two layers.

**On the Vosk model folder:** the 40 MB directory is the model itself (acoustic model + language model + speaker-adaptation files, all loaded by Vosk as a single unit). It's committed to keep the demo zero-setup. In production it'd live in a model registry or S3 bucket and be pulled on first start.
