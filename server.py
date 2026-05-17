"""FastAPI wrapper around the transcription pipeline.

Mirrors the stages from transcription_pipeline.ipynb:
  Ingest -> VAD -> ASR -> LLM post-process

Returns the flat JSON shape the React frontend (app.jsx) consumes.
Run:  python server.py     (listens on http://127.0.0.1:8000)
"""

import hashlib
import math
import os
import re
import struct
import time
import wave
from typing import Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

try:
    import whisper
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

VOSK_MODEL_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "vosk-model-small-en-us-0.15",
)
try:
    from vosk import Model as VoskModel, KaldiRecognizer, SetLogLevel as VoskSetLogLevel
    VOSK_AVAILABLE = os.path.isdir(VOSK_MODEL_DIR)
    if VOSK_AVAILABLE:
        VoskSetLogLevel(-1)
except ImportError:
    VOSK_AVAILABLE = False

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False


app = FastAPI(title="Transcription Pipeline API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


HISTORY: List[Dict] = []
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

_whisper_model = None
_vosk_model = None


def get_whisper():
    global _whisper_model
    if _whisper_model is None and WHISPER_AVAILABLE:
        _whisper_model = whisper.load_model("base")
    return _whisper_model


def get_vosk():
    global _vosk_model
    if _vosk_model is None and VOSK_AVAILABLE:
        print(f"[server] loading vosk model from {VOSK_MODEL_DIR}")
        _vosk_model = VoskModel(VOSK_MODEL_DIR)
    return _vosk_model


def vosk_transcribe(samples: List[int], sample_rate: int):
    """Run Vosk ASR on mono int16 samples. Returns (text, confidence, word_count).

    The bundled small EN model is English-only — language hint is ignored.
    """
    import json as _json
    target_rate = 16000

    if NUMPY_AVAILABLE:
        arr = np.asarray(samples, dtype=np.int16)
        if sample_rate != target_rate and len(arr) > 1:
            new_n = max(1, int(len(arr) * target_rate / sample_rate))
            x_old = np.linspace(0.0, 1.0, num=len(arr), endpoint=False, dtype=np.float64)
            x_new = np.linspace(0.0, 1.0, num=new_n, endpoint=False, dtype=np.float64)
            arr = np.interp(x_new, x_old, arr.astype(np.float64)).astype(np.int16)
        pcm_bytes = arr.tobytes()
    else:
        pcm_bytes = struct.pack(f"<{len(samples)}h", *samples)

    rec = KaldiRecognizer(get_vosk(), target_rate)
    rec.SetWords(True)

    results = []
    chunk_bytes = 4000 * 2  # 4000 int16 samples per chunk
    for i in range(0, len(pcm_bytes), chunk_bytes):
        chunk = pcm_bytes[i:i + chunk_bytes]
        if rec.AcceptWaveform(chunk):
            results.append(_json.loads(rec.Result()))
    results.append(_json.loads(rec.FinalResult()))

    texts = [r.get("text", "") for r in results if r.get("text")]
    text = " ".join(texts).strip()
    all_words = [w for r in results for w in r.get("result", [])]
    if all_words:
        confidence = sum(w.get("conf", 0.0) for w in all_words) / len(all_words)
    else:
        confidence = 0.0
    return text, confidence, len(all_words)


def read_wav(path: str):
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        nc = wf.getnchannels()
        sw = wf.getsampwidth()
        nf = wf.getnframes()
        raw = wf.readframes(nf)
    fmt_char = "h" if sw == 2 else "b"
    samples = list(struct.unpack(f"<{nf * nc}{fmt_char}", raw))
    if nc == 2:
        samples = samples[::2]
    return samples, sr, nf / sr if sr else 0.0


def energy_vad(samples: List[int], sample_rate: int,
               frame_ms: int = 20, threshold_factor: float = 0.1):
    frame_size = int(sample_rate * frame_ms / 1000)
    if frame_size <= 0 or not samples:
        return []
    frames = [samples[i:i + frame_size] for i in range(0, len(samples), frame_size)]
    energies = [math.sqrt(sum(s * s for s in f) / len(f)) if f else 0.0 for f in frames]
    thr = threshold_factor * (max(energies) if energies else 1.0)
    segs, in_s, t0 = [], False, 0.0
    for i, e in enumerate(energies):
        t = i * frame_ms / 1000
        if e > thr and not in_s:
            in_s, t0 = True, t
        elif e <= thr and in_s:
            in_s = False
            segs.append((t0, t))
    if in_s:
        segs.append((t0, len(samples) / sample_rate))
    return segs


POSTPROCESS_PROMPT = (
    "You are a transcript post-processor. Given raw ASR output, return ONLY a JSON "
    "object with: clean_text, summary (1-2 sentences), sentiment (positive/neutral/negative), "
    "named_entities (list of {text, type}), action_items (list), topics (list of 2-5 keywords). "
    "Return ONLY JSON, no markdown fences."
)


def llm_postprocess(raw_text: str) -> Dict:
    """Use Anthropic if available, else a heuristic capitalize-and-punctuate fallback."""
    if ANTHROPIC_AVAILABLE and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            import json as _json
            client = anthropic.Anthropic()
            msg = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1000,
                system=POSTPROCESS_PROMPT,
                messages=[{"role": "user", "content": raw_text}],
            )
            data = _json.loads(msg.content[0].text.strip())
            return {
                "clean_text": data.get("clean_text", raw_text),
                "summary": data.get("summary", ""),
                "sentiment": data.get("sentiment", "neutral"),
                "named_entities": data.get("named_entities", []),
                "action_items": data.get("action_items", []),
                "topics": data.get("topics", []),
            }
        except Exception as e:
            print(f"[postprocess] Anthropic call failed, falling back to mock: {e}")

    # Heuristic fallback: capitalize first letter, add ending period.
    text = (raw_text or "").strip()
    if text:
        sentences = re.split(r"(?<=[.!?])\s+", text)
        sentences = [s[:1].upper() + s[1:] if s else s for s in sentences]
        text = " ".join(sentences)
        if not re.search(r"[.!?]$", text):
            text += "."
    wc = len(raw_text.split())
    return {
        "clean_text": text,
        "summary": f"Audio transcribed: {wc} words detected." if wc else "Empty transcript.",
        "sentiment": "neutral",
        "named_entities": [],
        "action_items": [],
        "topics": ["general"],
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisper_available": WHISPER_AVAILABLE,
        "vosk_available": VOSK_AVAILABLE,
        "anthropic_available": ANTHROPIC_AVAILABLE,
        "anthropic_key_set": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "history_count": len(HISTORY),
    }


@app.get("/history")
def history():
    return HISTORY[-20:]


@app.get("/transcribe/{chunk_id}")
def get_transcript(chunk_id: str):
    for h in HISTORY:
        if h["chunk_id"] == chunk_id:
            return h
    raise HTTPException(404, "Transcript not found")


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Query("en"),
    run_vad: bool = Query(True),
    run_postprocess: bool = Query(True),
):
    t_start = time.perf_counter()

    # ---- Stage 1: Ingest ----
    t1 = time.perf_counter()
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(400, "Empty file upload")

    original_name = file.filename or "uploaded.wav"
    label = re.sub(r"[^a-zA-Z0-9_-]+", "_", os.path.splitext(original_name)[0])[:48] or "uploaded"
    save_path = os.path.join(UPLOAD_DIR, original_name)
    with open(save_path, "wb") as f:
        f.write(raw_bytes)

    chunk_id = hashlib.md5(f"{label}-{time.time()}".encode()).hexdigest()[:8]

    samples: Optional[List[int]] = None
    sample_rate: Optional[int] = None
    duration: float = 0.0
    try:
        samples, sample_rate, duration = read_wav(save_path)
    except wave.Error as e:
        if not WHISPER_AVAILABLE:
            raise HTTPException(
                415,
                f"Cannot decode '{original_name}': only PCM WAV files are supported "
                f"without Whisper installed. Got: {e}",
            )
        # Whisper handles other formats via ffmpeg; we just won't have VAD samples.

    ingest_ms = int((time.perf_counter() - t1) * 1000)

    # ---- Stage 2: VAD ----
    t2 = time.perf_counter()
    if run_vad and samples is not None and sample_rate:
        segs = energy_vad(samples, sample_rate)
    else:
        segs = []
    vad_ms = int((time.perf_counter() - t2) * 1000)

    # ---- Stage 3: ASR ----
    t3 = time.perf_counter()
    if WHISPER_AVAILABLE:
        model = get_whisper()
        result = model.transcribe(save_path, language=language, fp16=False)
        raw_text = (result.get("text") or "").strip()
        lang_detected = result.get("language", language)
        w_segs = result.get("segments", []) or []
        if w_segs:
            avg_lp = sum(s.get("avg_logprob", -1.0) for s in w_segs) / len(w_segs)
            confidence = min(1.0, max(0.0, math.exp(avg_lp)))
        else:
            confidence = 0.80
        engine = "whisper"
    elif VOSK_AVAILABLE and samples is not None and sample_rate:
        raw_text, confidence, _ = vosk_transcribe(samples, sample_rate)
        lang_detected = "en"
        engine = "vosk"
    else:
        time.sleep(0.05)
        raw_text = (
            f"mock asr output for {original_name} "
            f"({duration:.1f}s at {sample_rate or '?'}hz {len(segs)} vad segments) "
            f"install openai whisper or vosk for real speech recognition"
        )
        confidence = 0.50
        lang_detected = language
        engine = "mock"
    asr_ms = int((time.perf_counter() - t3) * 1000)
    word_count = len(raw_text.split())

    # ---- Stage 4: LLM post-process ----
    t4 = time.perf_counter()
    if run_postprocess:
        post = llm_postprocess(raw_text)
    else:
        post = {"clean_text": "", "summary": "", "sentiment": "neutral",
                "named_entities": [], "action_items": [], "topics": []}
    postprocess_ms = int((time.perf_counter() - t4) * 1000)

    total_ms = int((time.perf_counter() - t_start) * 1000)

    response = {
        "chunk_id": chunk_id,
        "label": label,
        "language": language,
        "raw_text": raw_text,
        "confidence": round(confidence, 3),
        "word_count": word_count,
        "engine": engine,
        "language_detected": lang_detected,
        "clean_text": post["clean_text"],
        "summary": post["summary"],
        "sentiment": post["sentiment"],
        "named_entities": post["named_entities"],
        "action_items": post["action_items"],
        "topics": post["topics"],
        "vad_segments": len(segs),
        "duration_sec": round(duration, 2),
        "sample_rate": sample_rate,
        "timings": {
            "ingest_ms": ingest_ms,
            "vad_ms": vad_ms,
            "asr_ms": asr_ms,
            "postprocess_ms": postprocess_ms,
            "total_ms": total_ms,
        },
    }
    HISTORY.append(response)
    return response


if __name__ == "__main__":
    import uvicorn
    print(f"[server] whisper={WHISPER_AVAILABLE} vosk={VOSK_AVAILABLE} anthropic={ANTHROPIC_AVAILABLE}")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
