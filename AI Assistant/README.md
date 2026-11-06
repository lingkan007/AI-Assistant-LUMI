# Lumi Live Voice Assistant

Lumi is a small 2D voice companion built with FastAPI, the Google GenAI SDK,
Gemini Live, and the four included character sprites.

## Requirements

- Python 3.10 or later
- A Gemini API key with access to a Gemini Live model
- A browser with microphone and AudioWorklet support

## Install and run on Windows

From the project directory, create and activate a virtual environment and
install the dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Create a local `.env` file from the example and add your API key:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `GEMINI_API_KEY` in `.env`, then start the server:

```powershell
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

Open <http://127.0.0.1:8000>, choose **Wake up Lumi**, and allow microphone
access. **Sleep Lumi** ends the microphone and Live session. Use `Ctrl+C` in
the server terminal to stop the app.

The `.env` file is ignored by Git. Never put an API key in frontend code or
commit it.

## Gemini model

The default model is `gemini-3.8-live`, currently listed in Google's Live API
model documentation. The requested `gemini-2.0-flash-exp` model is not listed
there; set `GEMINI_MODEL` in `.env` to that value only if it is still enabled for
your API project. The server reports Live connection failures in its terminal
and in Lumi's status message.

## Audio format

Gemini Live expects raw, little-endian 16-bit PCM at 16 kHz for microphone
input, and returns PCM audio at 24 kHz. Lumi uses an AudioWorklet and the Web
Audio API to stream and play those formats directly. `MediaRecorder` produces
containerized chunks such as WebM, which cannot be sent directly to the Live
API as PCM.

## Project files

- `backend/main.py` — FastAPI routes and Gemini Live audio relay
- `frontend/index.html` — responsive character scene and controls
- `frontend/app.js` — microphone session, audio playback, and state machine
- `frontend/pcm_processor.js` — 16 kHz PCM capture worklet
- `frontend/assets/` — Lumi's idle, listening, thinking, and talking sprites
