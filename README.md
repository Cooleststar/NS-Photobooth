# NS Photobooth

An interactive photobooth application for events. It captures photos via a webcam (USB/local or RTSP IP camera), overlays animated GIF characters onto the live feed, and uses real-time pose detection so animations react to the person standing in front of the camera.

## Tech Stack

| Part | Tech | Port |
|---|---|---|
| Frontend (`client-ns-photobooth`) | Vite + Preact + PixiJS + TypeScript | 3000 |
| Backend (`backend`) | Python + MediaPipe + WebSockets | 8081 (HTTP/WS), 9091 (rosbridge) |

## Features

- **Camera selection page** — choose a preset RTSP IP camera, enter a custom RTSP URL, or use a local USB/built-in webcam
- **Pose-reactive animations** — Owl, Globe, Parrot, Laptop, and V15 Drone overlays that respond to body movement
- **Photo capture flow** — countdown timer, confirm/cancel preview, automatic save
- **QR code sharing** — scan to download or share captured photos
- **Configurable settings** — resolution, save folder, animation toggles, debug overlay, and more

---

## Prerequisites

### Option 1 — Docker (recommended)

- **Docker Desktop** — https://www.docker.com/products/docker-desktop
- **Git** — to clone the repository

That's it. Docker handles Python, Node, and all dependencies inside containers.

### Option 2 — Without Docker

| Requirement | Version | Notes |
|---|---|---|
| **fnm** | Latest | Node version manager — installs and switches Node versions |
| **Node.js** | 18.x | Installed via fnm — newer versions will break the project |
| **Yarn** | 3.2.3+ | Comes with Node 18 via fnm |
| **Python** | 3.10.x | Required by the backend — see note below |
| **pip** | Latest | Comes bundled with Python 3.10+ |
| **FFmpeg** | Latest | System binary (not a pip package) — required for RTSP camera streaming. `winget install Gyan.FFmpeg`, then reopen your terminal so `ffmpeg` is on `PATH` |

> **Why Python 3.10 specifically:** `numpy==1.24.4` (pinned in `backend/requirements.txt`) has no prebuilt wheel for Python 3.12, and building it from source fails outright — Python 3.12 removed an API (`pkgutil.ImpImporter`) that the old `setuptools`/`pkg_resources` shim bundled in numpy's build process depends on. There's no workaround short of using Python 3.10.

Python packages are pinned in [`backend/requirements.txt`](backend/requirements.txt) and installed via `pip install -r backend/requirements.txt` (see step 7 below). A couple of things worth knowing if you're setting this up for the first time:
- `mediapipe` (used for hand-gesture/drone detection) is a runtime dependency of `backend/main.py` — make sure your `requirements.txt` includes it; if you're working from an older checkout that predates this note, add `mediapipe==0.10.8` manually.
- Installing `requirements.txt` pulls in **three different OpenCV packages** side-by-side (`opencv-python-headless`, pinned directly, plus `opencv-python` and `opencv-contrib-python`, pulled in transitively by `mediapipe`/`ultralytics`) — they all provide the same `cv2` module. This works in practice (whichever installs last wins in `site-packages`), but if `cv2` ever behaves unexpectedly, this is why.
- **If you have an NVIDIA GPU, `pip install -r backend/requirements.txt` alone will NOT use it.** `ultralytics` pulls in `torch` with no pinned index, so on Windows `pip` installs the CPU-only build (`torch.cuda.is_available()` returns `False` even with a GPU present) — pose detection (and ViTPose++, see `ENABLE_VITPOSE` in `main.py`) then silently runs on CPU, which is dramatically slower and directly hurts live-feed latency. After the normal install, reinstall `torch`/`torchvision` from the CUDA build explicitly:
  ```powershell
  pip uninstall torch torchvision -y
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
  ```
  Verify it worked with `python -c "import torch; print(torch.cuda.is_available())"` — this should print `True`.

  Docker users aren't automatically better off here: on Linux, PyPI's plain `torch` wheel *is* the CUDA-enabled build (unlike Windows), so the backend image's `torch` is already CUDA-capable — but `docker-compose.yml` has no GPU device reservation configured (no `deploy.resources.reservations.devices`), so the container has no access to the host GPU regardless. `torch.cuda.is_available()` returns `False` inside the container too unless you add a GPU reservation to the `backend` service and have Docker Desktop's GPU support enabled.
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
cd photobooth
```

---

## Installation & Running — With Docker.

```bash
docker-compose up -d --build
```

Then open [http://localhost:3000](http://localhost:3000).

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

### 3. Install Python 3.10

1. Download the **Windows installer (64-bit)** from https://www.python.org/downloads/release/python-31011/
2. **Check "Add Python to PATH"** before clicking Install
3. Click **Install Now**
4. Close and reopen PowerShell, then verify:

```powershell
python --version
```

> Python 3.10 specifically is required — other versions (3.11, 3.12) may cause compatibility issues with MediaPipe (and will hard-fail installing `numpy==1.24.4` — see note above).

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
cd photobooth/client-ns-photobooth
yarn install
cd ../..
```

> **Required every time `client-ns-photobooth/.yarnrc.yml` or `yarn.lock` changes**, not just on first setup — `app.py` (below) starts the frontend with `yarn dev` directly and never runs `yarn install` itself, so a stale `node_modules`/Yarn state will make `localhost:3000` fail to boot with `Usage Error: Couldn't find the node_modules state file`, even if you'd already run this before. In particular, this project switched from Yarn's PnP linker to the classic `node_modules` linker (`nodeLinker: node-modules` in `.yarnrc.yml`) — if you're pulling into a checkout that predates that change, you must re-run `yarn install` here or the frontend won't start.

### 7. Run the App

```powershell
cd photobooth
python -m venv venv
venv\Scripts\Activate
pip install -r backend/requirements.txt
python app.py
```

Then open [http://localhost:3000](http://localhost:3000).

---

## Using the Programme

1. Open `http://localhost:3000` in your browser, then click the window to give it focus (required for keyboard shortcuts).
2. On the **camera selection page**, pick a preset RTSP camera, enter a custom RTSP URL, or choose your local webcam.
3. On the **Booth screen**, your live feed appears with an animated character overlay.
4. Press **Space Bar** (or click the camera button) to take a photo — a countdown plays, then **confirm** or **cancel** the preview.
5. Confirmed photos are saved/uploaded automatically, and a **QR code** appears so you can scan and download it.
6. Press **S** to open **Settings** — change the animation character, camera/canvas resolution, save folder, and more.

---

## Full Documentation

For complete instructions, see the **NS Photobooth – Setup & Run Guide**, which covers:

- Full usage guide — camera selection, taking photos, settings panel, keyboard shortcuts
- How pose detection works
- Troubleshooting common issues
