# Contributing

Thanks for your interest in improving the Audio Transcription Pipeline. This project favors small, focused changes that respect the staged-pipeline design.

## Local setup

1. Clone the repo and `cd` into it.
2. Install Python dependencies:
   ```bash
   pip install fastapi uvicorn python-multipart vosk numpy
   ```
3. Download the small English Vosk model into the project root (see the README for the exact URL and unzip target).
4. Start the API server:
   ```bash
   python server.py
   ```
5. Serve the frontend in a separate terminal:
   ```bash
   python -m http.server 5173
   ```
6. Open <http://localhost:5173/> in your browser.

## Branching

- `main` is the integration branch. Keep it green.
- Feature branches: `feat/<short-name>` (e.g. `feat/silero-vad`).
- Bug fixes: `fix/<short-name>` (e.g. `fix/wav-stereo-decoding`).
- Docs only: `docs/<short-name>`.

## Commit style

Use Conventional Commits prefixes:

| Prefix     | When to use                              |
|------------|------------------------------------------|
| `feat:`    | A user-visible new capability             |
| `fix:`     | A bug fix in existing behavior            |
| `perf:`    | Performance change with no behavior change|
| `refactor:`| Internal restructuring, no behavior change|
| `docs:`    | README, comments, this file               |
| `chore:`   | Build, deps, .gitignore, license          |
| `test:`    | Adding or fixing tests                    |

Subject line: imperative mood, lowercase, no trailing period, ≤72 chars.

## Pull requests

Each PR should:

- Touch one concern. Refactors should not include behavior changes.
- Update the README when a user-facing flag, endpoint, or behavior changes.
- Run cleanly against the four built-in demo scenarios in the frontend before merging.
- Include a short "test plan" in the PR body — what you ran, what you eyeballed.

## Design constraints to respect

These are load-bearing decisions; please discuss before changing them.

- **Every external dependency has a mock fallback.** Whisper, Vosk, Anthropic — all degrade gracefully when absent. New ASR or LLM backends should follow the same pattern.
- **Stage timings are exposed in every response.** New stages must emit a `*_ms` field and contribute to `total_ms`.
- **The `/transcribe` response shape is the public contract.** Adding fields is fine; renaming or removing them is a breaking change and requires a major version bump in the README.

## Reporting issues

Open a GitHub issue with:

1. What you ran (command line, browser, OS).
2. What you expected vs. what happened.
3. Relevant log output from `server.py`.
4. Audio file metadata if reproducible (sample rate, channels, duration). Do **not** attach proprietary audio.
