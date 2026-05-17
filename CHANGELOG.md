# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- Real Anthropic-backed post-processing (summary, NER, action items) gated on `ANTHROPIC_API_KEY`.
- Optional Whisper backend selection from the frontend (currently auto-detected at server boot).
- Replace energy-based VAD with Silero VAD for fewer false positives.
- MP3 / M4A ingestion via ffmpeg subprocess.

---

## [0.3.0] — 2026-05-17

### Added
- **Save transcript** button on the result panel — downloads a `.md` file with the title, metadata, clean transcript, summary, topics, action items, and named entities.
- **Start new session** button — clears the current result, error, and uploaded file so the next run starts fresh.
- `LICENSE` (MIT) to match the badge in the README.
- `CONTRIBUTING.md` with setup, branching, commit, and PR conventions.
- `TROUBLESHOOTING.md` covering the recurring setup issues from development.

### Changed
- Simplified the frontend chrome: removed the API endpoints sidebar panel, the API base URL + Swagger link in the header, the version badge, the session history panel, and the raw-JSON tab on the result. The UI now focuses on the user-facing flow.
- Expanded `.gitignore` to exclude downloaded ASR models, build artifacts, and a few common editor/OS noise files.

---

## [0.2.0] — 2026-05-17

### Added
- **Vosk ASR backend** wired into `server.py` as the preferred engine when Whisper is unavailable.
  - Bundled `vosk-model-small-en-us-0.15` (~40 MB, English-only).
  - Numpy-based linear resampler so non-16 kHz WAVs are handled correctly.
  - Per-word confidence is averaged into the response's `confidence` field.
- `/health` endpoint now reports `vosk_available` alongside Whisper and Anthropic status.

### Notes
- Whisper remains the priority backend if installed; Vosk is the fallback; mock is the last resort.

---

## [0.1.0] — 2026-05-17

### Added
- FastAPI server (`server.py`) exposing `/transcribe`, `/transcribe/{id}`, `/history`, `/health`.
- Real WAV ingestion via the stdlib `wave` module.
- Real energy-based VAD operating on the actual audio samples.
- Heuristic post-processor (capitalization + ending punctuation) as a fallback for the Anthropic path.
- CORS middleware permitting the frontend at `localhost:5173`.
- React frontend (`app.jsx` + `index.html`) served by a one-liner `python -m http.server 5173`.
  - Demo mode with four built-in mock scenarios.
  - Live API mode with drag-and-drop file upload.
  - Result panel with Transcript and Analysis tabs.
- Pipeline notebook (`transcription_pipeline.ipynb`) documenting the staged design and engineering rationale.
