# Troubleshooting

Common issues encountered while running the pipeline, and how to resolve them.

## The frontend shows "Failed to fetch" in Live API mode

The FastAPI server is not running. Start it in a separate terminal:

```bash
python server.py
```

Confirm it's reachable:

```bash
curl http://127.0.0.1:8000/health
```

You should see a JSON response with `"status": "ok"`.

## `vosk_available: false` in /health output

Either Vosk is not installed, or the model directory is missing.

```bash
pip install vosk
```

Then download the small English model into the project root:

```bash
python -c "import requests, zipfile, urllib3; urllib3.disable_warnings(); \
r = requests.get('https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip', verify=False); \
open('m.zip','wb').write(r.content); zipfile.ZipFile('m.zip').extractall('.')"
```

Restart the server. `/health` should now report `"vosk_available": true`.

## Transcription returns empty text

Vosk's small English model only recognizes spoken English. Empty output usually means:

- The audio is silent or near-silent (check the `vad_segments` field).
- The audio is not speech (e.g., music, tones, ambient noise).
- The audio is in a language other than English. Swap in a multilingual model or enable Whisper.
- The sample rate is heavily mismatched. The server resamples to 16 kHz, but extreme rates (e.g., 4 kHz) may degrade quality.

## "Cannot decode … only PCM WAV files are supported"

Vosk needs PCM WAV input. To process MP3 / M4A / OGG, convert first:

```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav
```

Or install `openai-whisper` (uses ffmpeg under the hood) — but note this pulls in PyTorch and may not have wheels for very new Python releases.

## Whisper import fails on Python 3.14

PyTorch wheels often lag the latest Python release by several months. Options:

- Use Python 3.11 or 3.12 in a separate virtualenv for Whisper.
- Stay on Vosk — it ships pre-built wheels for current Python versions and needs no GPU.

## SSL certificate errors when downloading the Vosk model

Python's bundled CA certificates can become outdated. Use `requests` with verification disabled for this single download (it's a public model file, so integrity can be checked against the upstream SHA):

```bash
python -c "import requests, urllib3; urllib3.disable_warnings(); \
print(requests.get('https://alphacephei.com/vosk/models/...', verify=False).status_code)"
```

## Port 8000 or 5173 already in use

Find the process holding the port and stop it:

**Windows PowerShell:**
```powershell
Get-NetTCPConnection -LocalPort 8000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Linux / macOS:**
```bash
lsof -ti:8000 | xargs kill -9
```

## CORS errors in the browser console

The server allows all origins by default (`allow_origins=["*"]`). If you're seeing CORS errors, the request is probably not reaching the server at all — check that `server.py` is running and that the frontend's `API_BASE` constant in [app.jsx](app.jsx) matches the server URL.

## The frontend shows old behavior after editing app.jsx

Babel-standalone compiles JSX in-browser and caches aggressively. Hard-refresh with **Ctrl+F5** (Windows / Linux) or **Cmd+Shift+R** (macOS) after every edit.
