# NS Photobooth

An interactive photobooth application for events. It captures photos via a webcam (USB/local or RTSP IP camera), overlays animated GIF characters onto the live feed, and uses real-time pose detection so animations react to the person standing in front of the camera.

## Tech Stack

| Part | Tech | Port |
|---|---|---|
| Frontend (`client-ns-photobooth`) | Vite + Preact + PixiJS + TypeScript | 3000 |
| Backend (`backend`) | Python + WiLoR/Ultralytics + WebSockets | 8081 (HTTP/WS), 9091 (rosbridge) |
| Gallery (`gallery`) | Vite + Preact | 5173 |

## Features

- **Camera selection page** — choose a preset Hikvision RTSP camera, enter a custom RTSP URL, or use a local USB/built-in webcam (capture cards included). Cameras mounted mirrored or upside down can be flipped in Settings.
- **Pose- and hand-reactive animations**, toggled from the thumbnail bar at the top of the screen (up to 5 at once):

  | Character | Triggered by |
  |---|---|
  | Owl, Bat, Caped Cat | Holding a bent arm out; the character perches on the forearm |
  | Globe | Orbits the body; hold your hands apart and it moves between them |
  | Drone | An open palm facing the sky |
  | 67 | Both palms up with the arms held diagonally — a 6 and a 7 appear above them |
  | Scuba | Waving a hand side to side |
  | Boxing Gloves | A closed fist (with dizzy stars) |
  | Pig Nose & Ears, Bat Ears, Clown Wig & Nose, Sunglasses, Mustache, OC Fusion | Face-tracked; always on while selected. OC Fusion has its own button, bottom-right |

  Some combinations are blocked because they compete for the same arm or gesture: Owl/Bat/Caped Cat, Drone/67 and Scuba/Boxing Gloves. A greyed-out button's tooltip says which character it clashes with. The reasons are documented on `EXCLUSIVE_GROUPS` in [`client-ns-photobooth/src/store.ts`](client-ns-photobooth/src/store.ts).
- **Multi-Person Tracking** — puts the selected characters on everyone in frame instead of one person
- **Per-character size** — a slider in Settings scales any character up or down live, for booths where people stand closer or further than usual
- **QR Code Mode** — instead of using the picker, a guest holds up a printed QR card and the matching character locks onto them until **Reset Animation** is pressed. Cards are in [`qr-test-codes/`](qr-test-codes/). ORDLO is a QR-only character.
- **67 Mode** — a standalone 20-second "67 as fast as you can" minigame with name entry and a persisted leaderboard (editable from Settings), replacing the normal capture flow entirely
- **Photo capture flow** — single shots or Burst Mode (1–12 shots into one strip, 1–10 s apart), a 0–15 s countdown, confirm/cancel preview, automatic save
- **QR code sharing** — when online features are on, every saved photo/strip is uploaded and gets its own QR code linking to a downloadable copy
- **Logos** — choose one or more company logos for the live-feed banner and the photo-strip footer
- **Gallery** — a separate site ([http://localhost:5173](http://localhost:5173)) where anyone on the network enters the booth PC's IP to browse, recolour, download or delete saved photos
- **Testing tools** — replay a recorded video as the camera source, and measure detection accuracy on an uploaded clip, both from Settings

---

## Prerequisites

### Option 1 — Docker (recommended)

- **Docker Desktop** — https://www.docker.com/products/docker-desktop
- **Git** — to clone the repository

Docker handles Python, Node, and all dependencies inside containers. For GPU acceleration you also need an NVIDIA GPU with Docker Desktop's GPU support (WSL 2 backend) working — `docker-compose.yml` passes one GPU through to the backend.

### Option 2 — Without Docker

| Requirement | Version | Notes |
|---|---|---|
| **fnm** | Latest | Node version manager — installs and switches Node versions |
| **Node.js** | 18.x | Installed via fnm — newer versions will break the project |
| **Yarn** | 3.2.3+ | Comes with Node 18 via fnm |
| **Python** | 3.11.x | Required by the backend — see note below |
| **pip** | Latest | Comes bundled with Python 3.11+ |
| **FFmpeg** | Latest | System binary (not a pip package) — required for RTSP camera streaming. `winget install Gyan.FFmpeg`, then reopen your terminal so `ffmpeg` is on `PATH` |

> **Why Python 3.11 specifically:** that's the version `backend/requirements.txt` is pinned and tested against. Earlier revisions of this project required 3.10 (numpy had no prebuilt wheel for 3.12 under the old pins), but that constraint no longer applies with the current pins — 3.11 is simply what's verified.

Python packages are pinned in [`backend/requirements.txt`](backend/requirements.txt) and installed via `pip install -r backend/requirements.txt` (see step 8 below). A couple of things worth knowing if you're setting this up for the first time:
- Hand detection uses **WiLoR**, not MediaPipe (MediaPipe was removed). The WiLoR source is vendored at `backend/wilor_src/`; its model weights (~2.5 GB) are not pip-installable and are not committed to git — fetch them once per machine with `python backend/fetch_wilor.py` (see step 8 below). The MANO hand mesh model is deliberately not required — it's licensed separately and its loader (`chumpy`) doesn't install on modern Python, so that layer is stubbed out; this pipeline never renders a mesh anyway.
- **If you have an NVIDIA GPU, `pip install -r backend/requirements.txt` alone will NOT use it.** `torch`/`torchvision` are deliberately left unpinned in `requirements.txt` — the correct wheel depends on your CUDA version, and the default PyPI wheel on Windows is CPU-only (`torch.cuda.is_available()` returns `False` even with a GPU present), silently making pose detection (and ViTPose++, see `ENABLE_VITPOSE` in `main.py`) run 20-50x slower. **Install torch FIRST, before the rest of `requirements.txt`:**
  1. Check your driver's supported CUDA version: `nvidia-smi` (top-right of the output, e.g. `CUDA Version: 12.6`).
  2. Pick the newest `cuXXX` PyTorch index your driver supports (e.g. CUDA 12.6 → `cu124`; CUDA 12.2 → `cu118`) and install:
     ```powershell
     pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
     ```
  3. Verify with `python -c "import torch; print(torch.cuda.is_available())"` — this should print `True`.

  Or just run `python backend/install_torch.py`, which detects the right wheel for your driver and does this for you. Either way, do it **before** `pip install -r backend/requirements.txt` — pip then sees torch already satisfied and won't overwrite it with a CPU build. `main.py` refuses to start on a CPU build, so a mistake here is loud rather than silent.

  Docker users don't need to do this: the backend image installs the CUDA 11.8 build of torch itself, and `docker-compose.yml` reserves the host GPU for the `backend` service. That only works if Docker Desktop's GPU support is enabled — check with `docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi`.
- **Once CUDA is working, the very first startup can hang for a very long time (10+ minutes) with the camera showing nothing.** `main.py` auto-enables ViTPose++ (a ~900MB Hugging Face model) whenever a GPU is detected (`ENABLE_VITPOSE` defaults to on when `torch.cuda.is_available()`). Loading it calls `from_pretrained()`, which re-validates every file over the network against Hugging Face **on every single startup**, even once the model is fully cached locally — and without an `HF_TOKEN`, those requests are rate-limited and can take many minutes. This blocks the entire backend from binding its ports (RTSP/camera included) until it finishes, which looks exactly like a dead camera feed. Once the model has fully downloaded and cached once, skip the revalidation on every future run:
  ```powershell
  $env:HF_HUB_OFFLINE = "1"
  python app.py
  ```
  Don't set this on the very first run — offline mode requires the model to already be fully cached, or `VitPoseForPoseEstimation.from_pretrained()` fails outright and falls back to YOLO-only keypoints (not fatal, just less precise arm/shoulder/wrist tracking). Let the first run finish completely and uninterrupted, then use `HF_HUB_OFFLINE=1` for every run after that.

---

## Getting the Code

```bash
git clone https://github.com/Cooleststar/NS-Photobooth
cd NS-Photobooth
```

All commands below are run from this repository root unless they say otherwise.

---

## Installation & Running — With Docker.

First time only, download the WiLoR hand-model weights (~2.5 GB) into their Docker volume. Without them the backend exits at startup and prints this command:

```bash
docker-compose build backend
docker-compose run --rm backend python fetch_wilor.py
```

Then start everything:

```bash
docker-compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) for the booth and [http://localhost:5173](http://localhost:5173) for the gallery.

> Docker needs no `.env` file to start: the frontend image falls back to `.env.example`, which leaves the ImgBB key blank, so photos save locally with no upload or QR code. To enable uploads, create `client-ns-photobooth/.env` as in step 7 below before building.

To stop:

```bash
docker-compose down
```

> Containers can also be started/stopped from Docker Desktop's **play**/**stop** buttons under the Containers section. Note: any code changes require a rebuild (`docker-compose up -d --build`) to take effect — the play button alone re-runs the existing build.

---

## Installation & Running — Without Docker

All commands below use **PowerShell**.

### 1. Install Node.js 18 via fnm

```powershell
winget install Schniz.fnm
```

Close and reopen PowerShell, then run the one-time setup:

```powershell
Add-Content $PROFILE "`nfnm env --use-on-cd | Out-String | Invoke-Expression"
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
. $PROFILE
fnm install 18
fnm default 18
```

Verify:

```powershell
node --version
npm --version
```

> fnm must be activated per terminal session — if `node`/`yarn` aren't recognized in a new terminal, run `fnm use 18` first.

### 2. Verify Yarn

```powershell
yarn --version
```

If not found:

```powershell
npm install -g yarn
```

### 3. Install Python 3.11

```powershell
winget install --id Python.Python.3.11 -e --source winget
```

Close and reopen PowerShell, then verify:

```powershell
py -3.11 --version
```

> Python 3.11 specifically is required — see note above. If you already have other Python versions installed (e.g. 3.10, 3.12), use the `py -3.11` launcher (as in step 8) to make sure the venv is created with the right one.

### 4. Install FFmpeg

```powershell
winget install Gyan.FFmpeg
```

Close and reopen PowerShell, then verify:

```powershell
ffmpeg -version
```

> Required for RTSP IP camera streaming (`backend/main.py` shells out to it directly). Not needed if you're only using a local/USB webcam, but install it anyway — it's cheap and you'll hit a confusing runtime failure later if you skip it and switch to an RTSP camera.

### 5. Verify pip

```powershell
python -m pip --version
```

If not found:

```powershell
python -m ensurepip --upgrade
python -m pip install --upgrade pip
```

### 6. Install Frontend Dependencies

```powershell
cd client-ns-photobooth
yarn install
cd ..
```

> **Required every time `client-ns-photobooth/.yarnrc.yml` or `yarn.lock` changes**, not just on first setup — `app.py` (below) starts the frontend with `yarn dev` directly and never runs `yarn install` itself, so a stale `node_modules`/Yarn state will make `localhost:3000` fail to boot with `Usage Error: Couldn't find the node_modules state file`, even if you'd already run this before. In particular, this project switched from Yarn's PnP linker to the classic `node_modules` linker (`nodeLinker: node-modules` in `.yarnrc.yml`) — if you're pulling into a checkout that predates that change, you must re-run `yarn install` here or the frontend won't start.

There is a second, separate frontend for browsing/downloading saved photos after an event:

```powershell
cd gallery
yarn install
cd ..
```

> Same reasoning as above — `app.py` also starts `gallery` with `yarn dev` directly, with no install step of its own. `gallery` pins its own Yarn version via `packageManager` in `gallery/package.json` (`yarn@4.16.0`, vs. `3.2.3+` for `client-ns-photobooth`) — Corepack switches automatically per-directory, so no extra setup is needed for that, just run `yarn install` from inside `gallery/`.

### 7. Create the environment file

```powershell
copy client-ns-photobooth\.env.example client-ns-photobooth\.env
```

Then open `client-ns-photobooth/.env` and paste your ImgBB API key into `VITE_IMGBB_API_KEY` (free key from [api.imgbb.com](https://api.imgbb.com/)).

> **`.env` is not in the repository** — it holds an API key, so it's gitignored and every checkout has to create its own from `.env.example`. Without it the animation timings read as `NaN` and the booth won't render characters correctly, so don't skip this step.
>
> The key is used twice: by the frontend when a photo is first uploaded, and by the backend when a photo is re-uploaded after being recoloured in the gallery. The backend reads this same file by default, so filling it in here covers both — set `IMGBB_API_KEY` in the backend's own environment if you'd rather keep them separate.
>
> **Uploads are off by default.** Settings → Connection → **Disable Online Features** starts switched on, so photos save locally with no upload and no QR code. Switch it off once your key is in place. Without a key, just leave it on.

### 8. Run the App

```powershell
py -3.11 -m venv venv
venv\Scripts\Activate.ps1
python backend/install_torch.py          # CUDA torch — do this FIRST
pip install -r backend/requirements.txt
python backend/fetch_wilor.py
python backend/fetch_mediapipe.py
python app.py
```

> **`install_torch.py` must run before `pip install -r`.** It reads your driver's maximum CUDA version from `nvidia-smi`, picks the matching wheel (cu124 or cu118) and installs it from the PyTorch index. Run the other order and pip pulls torch in transitively — via ultralytics, pytorch-lightning and mediapipe — and PyPI's default wheel is **CPU-only**, which is 20–50× slower with no error to indicate it. `main.py` refuses to start on a CPU build rather than let that pass unnoticed; set `REQUIRE_CUDA=0` only if you genuinely have no NVIDIA GPU.

> `fetch_wilor.py` downloads the WiLoR model weights (~2.5 GB) into `backend/wilor_models/` — only needed once per machine; it skips files that are already present, so it's safe to re-run.

> `fetch_mediapipe.py` does the same for the two MediaPipe Tasks models (~13 MB total) in `backend/mediapipe_models/` — `pose_landmarker_lite.task` for **67 Mode** and `hand_landmarker.task` for handedness. Both modules would otherwise download their own file lazily, the first time the feature is switched on, **which needs internet at that moment**. Skip this step and the booth still starts fine on a connected machine — then fails at an offline event, silently: the load happens on a background thread that only records the error, so 67 Mode shows no skeleton at all and handedness quietly falls back to WiLoR's unreliable left/right label (gloves mirror onto the wrong hand). Run it once, with internet, before taking the booth out.

`app.py` starts all three services (backend, frontend, gallery) together. Open [http://localhost:3000](http://localhost:3000) for the booth itself, or [http://localhost:5173](http://localhost:5173) for the photo gallery.

---

## Using the Programme

1. Open `http://localhost:3000` in your browser, then click the window to give it focus (required for keyboard shortcuts).
2. On the **camera selection page**, pick a preset RTSP camera, enter a custom RTSP URL, or choose your local webcam.
3. On the **Booth screen**, your live feed appears. Toggle characters from the thumbnail bar at the top; banner logo and Burst Mode have quick controls on screen too.
4. Press **Space** (or click the round shutter button) to take a photo. A countdown plays, then **confirm** or **cancel** the preview.
5. Confirmed photos are saved automatically. With online features on, a **QR code** appears so the guest can scan and download it.
6. Press **S** to open **Settings**.

### Keyboard shortcuts

**PageUp**/**PageDown** are what a presentation clicker sends, so a clicker can run the booth.

| Key | Action |
|---|---|
| **Space** or **PageUp** | Take a photo |
| **PageUp** / **PageDown** | Confirm / cancel the photo preview |
| **←** / **→** | Previous / next photo in a burst preview |
| **PageDown** (while waiting for a shot) | Switch which tracked person the characters follow (single-person mode) |
| **S** | Open/close Settings |
| **D** | Toggle the debug overlay |
| **PageUp** / **R** | 67 Mode: start or play / retry |

### Settings

| Section | What's there |
|---|---|
| Connection | **Disable Online Features**: on by default; turn off to upload photos and show QR codes |
| Display | Canvas size, camera size, and (local webcam only) detection resolution |
| Camera | Mirror horizontally / flip upside down, for cameras mounted that way |
| Capture | Countdown length, Burst Mode, photos per burst, interval between shots |
| Animation | Character selection, per-character size, Multi-Person Tracking, banner and footer logos, arrow pointer, debug overlay, QR Code Mode (with **Reset Animation**), 67 Mode |
| 67 Mode | Leaderboard editor, for pruning scores between events |
| Testing | Play a test video from `backend/replay_videos/` as the camera, and analyse a clip's detection accuracy |
| Actions | **Reset Application**: clears the booth's photo list and returns to camera selection (saved files are kept) |

Settings are saved in the browser, so they survive restarts.

### Using a capture-card camera (e.g. Sony A7 III)

A camera on HDMI capture or USB is a **local webcam** to the booth, not RTSP. It goes through a different backend path from the Hikvision cameras, so check these before an event:

- **HDMI Info Display: Off** on the camera, so focus boxes and settings text do not end up in the feed.
- **Shutter speed 1/250 or faster** (S or M mode; raise ISO to compensate). Slower shutters blur moving hands and arms. Scuba is a swinging gesture and suffers most.
- **Frame the guest down to the hips.** The Bat needs a tracked hip to appear. The Caped Cat doesn't, but tracks better with one.
- **Capture card at MJPEG 1080p30.** Open the browser console and look for `Camera stream actual resolution: … @ … fps`. Some cards fall back to ~5 fps at 1080p.
- **Detection Resolution** (Settings) sets the width of the frames sent for detection (1280 by default). Their height follows the camera's own aspect ratio automatically, and the console logs `Detection frames sent at …`.

### Camera settings for hand gestures (Scuba) with groups and at distance

The Scuba cat reads a swinging, edge-on hand, and a hand 3–5 m away is only a few dozen pixels across. Motion blur and compression artefacts on it decide whether it is detected at all. On every camera:

- **Shutter 1/250 or faster.** Add light rather than slowing the shutter.
- **Hikvision (RTSP):** in the camera's web UI, turn **H.264+ / Smart Codec off**, use the main stream at 1080p25 with a generous bitrate, and keep **WDR and 3D DNR off or low**. Noise reduction smears moving hands.
- **DJI Osmo Pocket 3 (webcam stand-in):** turn **face tracking / auto-framing off** and lock the gimbal. A camera that pans to follow people moves every hand on screen, which reads as hand motion. Lock exposure at a fast shutter, use 1080p, and turn beauty and HDR off.
- **Sony A7 III:** see the capture-card checklist above. SteadyShot off.

**Diagnosing the Owl, Bat and Scuba on site** (browser console, no restart needed):

| Command | What it does |
|---|---|
| `window.ARM_DEBUG = true` | Prints the Owl/Bat/Caped Cat arm checks live: state, locked arm, and which gate failed per side (e.g. `vis=0.42`, `angle=38`, `hipVis=0.10`, `away=135`) |
| `copy(armDump())` | Copies the recorded Owl/Bat/Caped Cat history (kept even with `ARM_DEBUG` off) |
| `window.SCUBA_DEBUG = true` / `copy(scubaDump())` | The same for the Scuba gesture. Each line is tagged `[scuba @x=…]` with that person's on-screen position (pixels from the left), so in a group you can tell whose line is whose. `anchor=wrist/elbow/none` shows what their hand was looked for around. |
| `window.SCUBA_FORCE = true` | Shows the cat without the gesture, which proves it can render |

To rehearse without the event camera, feed a recorded clip through **OBS Virtual Camera** and pick it as the local webcam. This exercises the same path as a capture card. A `replay:` video goes through the RTSP path instead.

### Tests

```
cd client-ns-photobooth
yarn test
```

Compiles the tests and runs them with Node's built-in test runner. No extra packages are needed. They cover the animation state machine, the Owl/Bat/Caped Cat arm checks, the bat's perch, the caped cat's run, the globe's orbit and hand pose, Scuba hand detection, multi-person slot assignment and pose-point conversion.

---

## Full Documentation

- [**NS Photobooth Guide.pdf**](NS%20Photobooth%20Guide.pdf): the setup and run guide, covering usage, how pose detection works, and troubleshooting
- [`client-ns-photobooth/boothfieldguide.docx`](client-ns-photobooth/boothfieldguide.docx): field guide for running the booth at an event (`boothfieldguide_with_evidence.docx` alongside it is the version with supporting evidence)
- [`RTSPinfo.md`](RTSPinfo.md): how the RTSP camera feed reaches the screen with near-zero latency, for anyone debugging or changing the camera pipeline
- [`backend/replay_videos/README.md`](backend/replay_videos/README.md): adding test videos for the replay camera source

---

## Models & Credits

The backend's body/hand tracking is built on the following third-party models, run locally — no frames or keypoints are sent to any external API:

| Model | Used for | Repository |
|---|---|---|
| **YOLO26-Pose** (`yolo26n-pose.pt`) | Real-time body pose detection and per-person tracking | [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) |
| **BoT-SORT** | Multi-person tracking across frames (keeps the same animation on the same person) | [NirAharon/BoT-SORT](https://github.com/NirAharon/BoT-SORT) |
| **ViTPose++ (Huge)** (`usyd-community/vitpose-plus-huge`) | Refines YOLO's keypoints for more precise arm/shoulder/wrist tracking, used when a GPU is available | [ViTAE-Transformer/ViTPose](https://github.com/ViTAE-Transformer/ViTPose) |
| **WiLoR** | Hand detection and palm orientation, used to trigger the Drone, 67, Scuba and Boxing Gloves animations | [rolpotamias/WiLoR](https://github.com/rolpotamias/WiLoR) |
| **MediaPipe Hand Landmarker** | Telling left hands from right, so the boxing gloves land on the correct hand | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) |
| **MediaPipe Pose Landmarker** (lite) | Pose tracking for 67 Mode specifically — kept independent of the YOLO/ViTPose/WiLoR pipeline above | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) |

All six run as vendored/pip-installed dependencies of this project; none of their original authors are affiliated with or endorse NS Photobooth.
