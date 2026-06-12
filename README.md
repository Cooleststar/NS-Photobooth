# NS Photobooth

An interactive photobooth application for events. It captures photos via a webcam (USB/local or RTSP IP camera), overlays animated GIF characters onto the live feed, and uses real-time pose detection so animations react to the person standing in front of the camera.

## Tech Stack

| Part | Tech | Port |
|---|---|---|
| Frontend (`client-ns-photobooth`) | Vite + Preact + PixiJS + TypeScript | 3000 |
| Backend (`backend`) | Python + MediaPipe + WebSockets | 9090 |

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
| **Python** | 3.10.x | Required by the backend |
| **pip** | Latest | Comes bundled with Python 3.10+ |

Python packages (installed via `pip`): `mediapipe==0.10.8`, `opencv-python-headless==4.8.1.78`, `numpy==1.24.4`, `websockets==11.0.3`

---

## Getting the Code

```bash
git clone https://github.com/jenastyx/photobooth.git
cd photobooth
```

---

## Installation & Running — With Docker

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

> Python 3.10 specifically is required — other versions (3.11, 3.12) may cause compatibility issues with MediaPipe.

### 4. Verify pip

```powershell
python -m pip --version
```

If not found:

```powershell
python -m ensurepip --upgrade
python -m pip install --upgrade pip
```

### 5. Run the App

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
