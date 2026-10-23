# NS Photobooth

## Description

An interactive photobooth for events. It shows a live camera feed (USB webcam, capture card or RTSP IP camera), puts animated characters onto the people in it using real-time body, hand and face tracking, and takes photos and photo strips that guests can download by scanning a QR code. A separate gallery lets anyone on the same network browse, recolour, download and delete the photos, and a built-in "67 Mode" minigame keeps a leaderboard.

Everything runs locally on the booth PC. Detection runs on the PC's own NVIDIA GPU, and no camera frames are sent to any outside service.

## Table of Contents

- [Features](#features)
- [Installation & Setup](#installation--setup)
  - [Prerequisites](#prerequisites)
  - [Quick Start with Docker Compose (Recommended)](#quick-start-with-docker-compose-recommended)
  - [Docker Desktop View](#docker-desktop-view)
  - [Local Setup (Without Docker)](#local-setup-without-docker)
- [Usage](#usage)
  - [Photobooth (Port 3000)](#photobooth-port-3000)
  - [Gallery (Port 5173)](#gallery-port-5173)
  - [67 Mode](#67-mode)
  - [Testing Tools](#testing-tools)
  - [Event Camera Setup](#event-camera-setup)
  - [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Acknowledgements](#acknowledgements)

## Features

- **Camera selection**: a preset Hikvision RTSP camera, a custom RTSP URL, or a local USB webcam or capture card. Cameras mounted mirrored or upside down can be flipped in Settings.
- **Pose-, hand- and face-reactive characters**, toggled from the thumbnail bar at the top of the screen (up to 5 at once):

  | Character | Triggered by |
  |---|---|
  | Owl, Bat, Caped Cat | Holding a bent arm out; the character perches on the forearm |
  | Globe | Orbits the body; hold your hands apart and it moves between them |
  | Drone | An open palm facing the sky |
  | 67 | Both palms up with the arms held diagonally; a 6 and a 7 appear above them |
  | Scuba | Waving a hand side to side |
  | Boxing Gloves | A closed fist (with dizzy stars) |
  | Pig Nose & Ears, Bat Ears, Clown Wig & Nose, Sunglasses, Mustache, OC Fusion | Face-tracked; always on while selected. OC Fusion has its own button, bottom-right |

  Some combinations are blocked because they compete for the same arm or gesture: Owl/Bat/Caped Cat, Drone/67 and Scuba/Boxing Gloves. A greyed-out button's tooltip says which character it clashes with. The reasons are documented on `EXCLUSIVE_GROUPS` in [`client-ns-photobooth/src/store.ts`](client-ns-photobooth/src/store.ts).
- **Multi-Person Tracking**: puts the selected characters on everyone in frame instead of one person.
- **Per-character size**: a slider in Settings scales any character up or down live.
- **Photo capture**: single shots or Burst Mode (1–12 shots, 1–10 s apart, grouped into strips of 3), a 0–15 s countdown, and a confirm/cancel preview.
- **QR code download**: with online features on and an ImgBB API key entered in Settings, every photo or strip is uploaded and gets a QR code printed on it, linking to a downloadable copy.
- **Logos**: one or more company logos on the live-feed banner and the photo-strip footer.
- **Gallery**: a separate site for browsing, recolouring, downloading and deleting saved photos, from any device on the network.
- **67 Mode**: a 20-second arm-flapping minigame with name entry and a password-protected, editable leaderboard. It replaces the normal capture flow while switched on.
- **Testing tools**: play a recorded video as the camera, and measure detection accuracy on a clip, both from Settings.
- **QR Code Mode** (currently hidden): a guest holds up a printed QR card and the matching character locks onto them. Set `SHOW_QR_MODE_TOGGLE` to `true` in [`Settings.tsx`](client-ns-photobooth/src/pages/Settings.tsx) to show its switch again. Cards are in [`qr-test-codes/`](qr-test-codes/).

## Installation & Setup

### Prerequisites

**Hardware**

| Item | Requirement |
|---|---|
| GPU | **NVIDIA GPU with CUDA 11.8 or later** (check with `nvidia-smi`). Required: the backend refuses to start without one |
| GPU memory | About 8 GB minimum, 12 GB+ recommended (estimated; the pose and hand models need ~2.5 GB each) |
| RAM | 16 GB minimum, 32 GB recommended (estimated) |
| Disk | 20 GB free, 30 GB with Docker (models, PyTorch, Docker images and photos) |
| Camera | USB webcam / capture card, or a Hikvision / RTSP IP camera |

The booth was developed and timed on an RTX A5000. The memory and disk figures above are estimates, not tested minimums.

**Software**

- [Visual Studio Code](https://code.visualstudio.com/) (or an equivalent code editor)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/), which includes Docker Compose (for the Docker setup)
- [NVIDIA GPU driver](https://www.nvidia.com/Download/index.aspx), with GPU support enabled in Docker Desktop (WSL 2 backend) when using Docker
- [Git](https://git-scm.com/downloads) (for cloning and updating the repository)
- A web browser such as Chrome or Edge

For the local setup without Docker, also:

- [Python 3.11](https://www.python.org/downloads/) (3.11 is required; the pinned packages need at least 3.11)
- **PyTorch 2.6.0, GPU/CUDA build**: installed by `backend/install_torch.py`, which must run **before** `pip install -r backend/requirements.txt`. Otherwise pip installs the CPU-only build, which is 20–50× slower and which the backend refuses to start on
- [FFmpeg](https://ffmpeg.org/download.html) (for reading RTSP camera streams)
- [fnm](https://github.com/Schniz/fnm) and [Node.js 18.x](https://nodejs.org/en/download) (newer Node versions break the project)
- [Yarn 3.2.3 or later](https://yarnpkg.com/getting-started/install) (comes with Node 18)

Internet is needed for the first setup and the first start, to download several GB of packages and models. After that the booth runs offline.

### Quick Start with Docker Compose (Recommended)

Run in PowerShell:

```powershell
git clone https://github.com/Cooleststar/NS-Photobooth
cd NS-Photobooth
docker compose build
docker compose up
```

The first start downloads the hand-detection model (~2.5 GB), so it may take some time before the booth works. The backend is ready when its log shows `MJPEG HTTP server ready on port 8081`. Later starts skip the download.

Then open [http://localhost:3000](http://localhost:3000) for the booth and [http://localhost:5173](http://localhost:5173) for the gallery.

> If you download the repository as a ZIP instead of cloning it, Windows' "Extract All" puts it in a folder inside another folder of the same name. Run the commands from the inner folder, the one containing `docker-compose.yml`.

### Docker Desktop View

After the first `docker compose up`, Docker Desktop's **Containers** list shows the photobooth as one application, named after the project folder (for example `ns-photobooth`), containing three containers: **frontend**, **backend** and **gallery**. Running containers have a green circle.

From then on there is no need to use the terminal: start and stop the whole booth with the play/stop button on the right. After changing any code, run `docker compose build` again; the play button alone restarts the old build.

The backend has no page of its own to open. It is the engine that reads the camera and runs the detection, and the frontend and gallery connect to it automatically.

### Local Setup (Without Docker)

One-time setup, in PowerShell from the repository root:

```powershell
winget install Schniz.fnm
winget install --id Python.Python.3.11 -e --source winget
winget install Gyan.FFmpeg
# close and reopen PowerShell, then:

Add-Content $PROFILE "`nfnm env --use-on-cd | Out-String | Invoke-Expression"
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
. $PROFILE
fnm install 18
fnm default 18

cd client-ns-photobooth
yarn install
cd ..\gallery
yarn install
cd ..

copy client-ns-photobooth\.env.example client-ns-photobooth\.env
# the ImgBB API key is not set in this file - enter it later in the booth Settings page

py -3.11 -m venv venv
venv\Scripts\Activate.ps1
python backend/install_torch.py
pip install -r backend/requirements.txt
python backend/fetch_wilor.py
python backend/fetch_mediapipe.py
```

Every time you run it:

```powershell
venv\Scripts\Activate.ps1
python app.py
```

`app.py` starts the backend, frontend and gallery together. Open [http://localhost:3000](http://localhost:3000) for the booth and [http://localhost:5173](http://localhost:5173) for the gallery.

## Usage

The full step-by-step guide for each part is the Fusion Photobooth Guide, which is shared within the team rather than kept in this repository. The essentials are below.

#### Photobooth (Port 3000)

1. Open [http://localhost:3000](http://localhost:3000) and click once on the page, so the keyboard shortcuts work.
2. Choose the camera and click **Start**. For a USB webcam, make sure the browser is allowed to use the camera and is set to the right one.
3. Toggle characters from the thumbnail bar at the top. Banner logo and Burst Mode have quick controls on screen too.
4. Press **Space** (or click the round shutter button) to take a photo, then **Confirm** or **Cancel** the preview. Confirmed photos are saved and appear in the gallery.
5. Press **S** to open **Settings**.

**Keyboard shortcuts.** PageUp/PageDown are what a presentation clicker sends, so a clicker can run the booth.

| Key | Action |
|---|---|
| **Space** or **PageUp** | Take a photo |
| **PageUp** / **PageDown** | Confirm / cancel the photo preview |
| **←** / **→** | Previous / next strip in a burst preview |
| **PageDown** (while waiting for a shot) | Switch which tracked person the characters follow (single-person mode) |
| **S** | Open/close Settings |
| **D** | Toggle the debug overlay |
| **PageUp** / **R** | 67 Mode: start or play / retry |

**Settings.** Saved in the browser, so they survive restarts.

| Section | What's there |
|---|---|
| Connection | **Disable Online Features**: on by default; turn off to upload photos and get QR codes. **ImgBB API Key**: paste a key (free at [api.imgbb.com](https://api.imgbb.com/)) and press Save |
| Display | Canvas size, camera size, and (local webcam only) detection resolution (1280 wide by default) |
| Camera | Mirror horizontally / flip upside down |
| Capture | Countdown length, Burst Mode, photos per burst, interval between shots |
| Animation | Character selection, per-character size, Multi-Person Tracking, banner and footer logos, arrow pointer, debug overlay, 67 Mode |
| 67 Mode | Password-protected leaderboard editor |
| Testing | Test video and detection accuracy tools |
| Actions | **Reset Application**: clears the booth's photo list and returns to camera selection (saved photos are kept) |

#### Gallery (Port 5173)

1. On the booth PC, open [http://localhost:5173](http://localhost:5173). On another device on the same network, open `http://<booth-PC-IP>:5173`; it needs only a browser, no installation.
2. Enter the booth PC's address: `localhost` on the booth PC itself, or its IPv4 address (from `ipconfig`) on another device. Click **Connect**; the address is remembered.
3. Click a thumbnail to open a photo, then scan its QR code, **Download** it, change its **Background** colour, or **Delete** it. Delete happens immediately, with no undo. Recolouring needs the ImgBB key and gives the photo a new QR link.

Other devices need the booth PC's Windows Firewall to allow ports **5173** and **8081**, and a network that lets devices reach each other (many guest Wi-Fi networks don't).

#### 67 Mode

Turn on **Enable 67 Mode** in Settings (QR Code Mode must be off). A player clicks **Start**, enters a unique name, and has 20 seconds to flap their forearms, keeping the elbows steady, with shoulders, arms and hips in view. Each flap scores a point. Results show the score, rank and the top 10. **Play** starts a new player, **R** retries for the same one. Staff can edit or clear scores in Settings → 67 Mode → **Edit Leaderboard…** (password: `password123`).

#### Testing Tools

In Settings → **Testing**:

- **Test Video**: **Choose video…** plays a recording on a loop as if it were the camera. **Stop replay (back to camera)** returns to the live camera. See [`backend/replay_videos/README.md`](backend/replay_videos/README.md). Test videos show real people, so they are kept out of git; never commit them.
- **Detection Accuracy**: **Analyze clip…** reports how reliably people and hands were detected over a clip. It pauses live tracking while it runs, so don't use it while guests are at the booth.

#### Event Camera Setup

A camera on HDMI capture or USB counts as a **local webcam**, not RTSP. Before an event:

- **Shutter 1/250 or faster** (add light rather than slowing the shutter). Slower shutters blur moving hands; Scuba suffers most.
- **Frame guests down to the hips.** The Bat needs a tracked hip; the Caped Cat tracks better with one.
- **Sony A7 III (capture card):** HDMI Info Display off, SteadyShot off, capture card at MJPEG 1080p30. The browser console logs `Camera stream actual resolution: … @ … fps`; some cards fall back to ~5 fps at 1080p.
- **Hikvision (RTSP):** in the camera's web UI, turn **H.264+ / Smart Codec off**, use the main stream at 1080p25 with a generous bitrate, and keep **WDR and 3D DNR off or low**.
- **DJI Osmo Pocket 3 (webcam):** turn face tracking / auto-framing off and lock the gimbal; lock exposure at a fast shutter, 1080p, beauty and HDR off.

To rehearse without the event camera, feed a recording through **OBS Virtual Camera** and pick it as the webcam, or use the Test Video tool.

**On-site diagnosis** (browser console, no restart needed):

| Command | What it does |
|---|---|
| `window.ARM_DEBUG = true` | Prints the Owl/Bat/Caped Cat arm checks live, including which check failed per side |
| `copy(armDump())` | Copies the recorded Owl/Bat/Caped Cat history (kept even with `ARM_DEBUG` off) |
| `window.SCUBA_DEBUG = true` / `copy(scubaDump())` | The same for the Scuba gesture; each line is tagged with that person's on-screen position |
| `window.SCUBA_FORCE = true` | Shows the Scuba cat without the gesture, which proves it can render |

#### Troubleshooting

| Problem | What to check |
|---|---|
| Page blank or no camera | The backend may still be starting. Check `docker compose logs -f backend` for `MJPEG HTTP server ready on port 8081`, then refresh |
| Backend keeps restarting | Docker can't see the GPU, or a model download failed. Test the GPU with `docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi` |
| "Port already in use" | Another copy is running (for example `python app.py`). Stop it, or run `docker compose down` |
| Code changes not showing | Run `docker compose build`, then `docker compose up` |
| Webcam not found | The webcam is used by the browser: check its camera permission and selected camera, and close other apps using the camera |
| Gallery won't connect from another device | Wrong IP (use the booth PC's Wi-Fi or Ethernet IPv4 address), firewall blocking ports 5173/8081, or a network that isolates devices. Test with `Test-NetConnection <IP> -Port 5173` |
| No upload or QR code | In Settings, turn off **Disable Online Features** and enter a valid ImgBB API key |

To restart cleanly: `docker compose down`, `docker compose build`, `docker compose up`. Avoid `docker compose down -v`, which also deletes the downloaded models.

## Architecture

The booth is three applications:

| Part | Folder | Tech | Port |
|---|---|---|---|
| Frontend (the booth) | `client-ns-photobooth` | Vite + Preact + PixiJS + TypeScript | 3000 |
| Backend | `backend` | Python + aiohttp, PyTorch / Ultralytics / WiLoR / MediaPipe | 8081 (HTTP and WebSocket), 9091 (rosbridge WebSocket) |
| Gallery | `gallery` | Vite + Preact | 5173 |

### Frontend

Shows the camera feed and draws the characters on it with PixiJS, runs the capture flow, builds the photo strips, and uploads them to ImgBB for the QR codes. For a local webcam the browser opens the camera itself and sends frames to the backend for detection. Settings are kept in the browser's local storage.

### Backend

- Reads RTSP cameras directly through FFmpeg with buffering disabled, for near-zero delay, or receives webcam frames from the browser.
- Detects people with YOLO26-Pose, keeps track of who is who with BoT-SORT, and refines arm and shoulder points with ViTPose++ when a GPU is available.
- Detects hands with WiLoR, using MediaPipe to tell left from right. 67 Mode uses its own MediaPipe pose model.
- Saves photos, serves them to the gallery, keeps the 67 Mode leaderboard, and re-uploads recoloured strips to ImgBB.

| Data | Location |
|---|---|
| Saved photos | `backend/photos/` |
| 67 Mode leaderboard | `backend/challenge67_leaderboard.json` |
| ImgBB key saved from Settings | `backend/settings/imgbb_key.txt` (never committed) |
| Hand models | `backend/wilor_models/` (Docker: `wilor_models` volume) |
| MediaPipe models | `backend/mediapipe_models/` |
| ViTPose model | Hugging Face cache (Docker: `hf_cache` volume) |

### Gallery

A separate site that loads the photo list and images from the backend on port 8081. It refreshes every few seconds, so new photos appear on their own.

## Acknowledgements

The backend's body and hand tracking is built on these third-party models, all run locally:

| Model | Used for | Repository |
|---|---|---|
| **YOLO26-Pose** (`yolo26n-pose.pt`) | Real-time body pose detection | [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) |
| **BoT-SORT** | Multi-person tracking across frames (keeps the same character on the same person) | [NirAharon/BoT-SORT](https://github.com/NirAharon/BoT-SORT) |
| **ViTPose++ (Huge)** (`usyd-community/vitpose-plus-huge`) | Refines YOLO's arm, shoulder and wrist points, when a GPU is available | [ViTAE-Transformer/ViTPose](https://github.com/ViTAE-Transformer/ViTPose) |
| **WiLoR** | Hand detection and palm orientation for the Drone, 67, Scuba and Boxing Gloves | [rolpotamias/WiLoR](https://github.com/rolpotamias/WiLoR) |
| **MediaPipe Hand Landmarker** | Telling left hands from right, so the boxing gloves land on the correct hand | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) |
| **MediaPipe Pose Landmarker** (lite) | Pose tracking for 67 Mode | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) |

None of their original authors are affiliated with or endorse NS Photobooth.
