# How the RTSP camera achieves near-zero display latency

## Overview

The photobooth displays an RTSP camera feed with minimal delay by eliminating
every buffer in the pipeline — from FFmpeg to the browser. The core principle:
**only the latest frame exists at any point. There are no queues.**

---

## 1. FFmpeg subprocess with all buffering disabled

Instead of using OpenCV's `VideoCapture` (which wraps FFmpeg but adds its own
internal buffering), the backend launches FFmpeg directly as a subprocess with
every buffering knob turned off:

```
ffmpeg -rtsp_transport tcp
       -fflags nobuffer          # no format-level buffering
       -flags low_delay           # minimize codec decode delay
       -avioflags direct          # bypass OS I/O buffering
       -probesize 32              # near-instant stream detection
       -analyzeduration 0         # don't analyze stream format
       -max_delay 0               # no demuxing delay
       -reorder_queue_size 0      # no B-frame reorder wait
       -i rtsp://...
       -vf scale=1920:1080
       -f rawvideo -pix_fmt bgr24 # raw pixels, no container
       -an -sn pipe:1             # output to stdout
```

The subprocess pipe uses `bufsize=0` (unbuffered) so frames arrive in Python
the instant FFmpeg finishes decoding them.

**File:** [`backend/main.py`](backend/main.py) — `_ffmpeg_read_loop()`

---

## 2. Latest frame only — no queues

A single variable (`_current_frame`) holds the most recent frame. Each time
FFmpeg delivers a new frame, it overwrites the previous one. Any frame that
wasn't consumed before the next one arrived is gone — intentionally dropped.

If the byte buffer from FFmpeg grows beyond 10 frames worth of data (because
the system was busy), the old bytes are deleted and only the most recent data
is kept.

```python
_current_frame: np.ndarray | None = None
_frame_id: int = 0
_frame_rwlock = RWLock()
```

**File:** [`backend/main.py`](backend/main.py) — `_ffmpeg_read_loop()`

---

## 3. Frame ID counter — no wasted work

The encode thread doesn't poll a queue. It checks `_frame_id` — if the ID
hasn't changed since the last check, it sleeps 5ms and checks again. If it
has changed, it grabs the new frame, encodes it to JPEG, and sends it to all
connected browsers.

```python
if fid == prev_id or frame is None:
    time.sleep(0.005)
    continue
```

**File:** [`backend/main.py`](backend/main.py) — `_rtsp_reader()`

---

## 4. Read-Write Lock prevents tearing

Three threads access the frame simultaneously:

- **FFmpeg thread** writes new frames (exclusive write lock)
- **Encode thread** reads the frame to produce JPEG (shared read lock)
- **Pose detection** reads the frame for MediaPipe (shared read lock)

The `RWLock` lets multiple readers work at the same time but blocks the writer
until all readers finish. This prevents a half-written frame from being read
without creating unnecessary waiting between readers.

**File:** [`backend/main.py`](backend/main.py) — `RWLock` class

---

## 5. WebSocket transport — no HTTP buffering

The JPEG frames are sent to the browser over a WebSocket (`ws://localhost:8081/ws_stream`)
as raw binary blobs. The server-side `asyncio.Queue(maxsize=1)` drops the old
frame if the browser hasn't consumed it yet — so the stream can never fall behind.

The frontend receives each blob, creates a `URL.createObjectURL()`, and sets it
as the `<img>` element's `src`. Previous blob URLs are revoked each frame to
prevent memory leaks.

**Files:**
- [`backend/main.py`](backend/main.py) — `ws_stream_handler()`
- [`client-ns-photobooth/src/pages/Display.tsx`](client-ns-photobooth/src/pages/Display.tsx) — WebSocket `useEffect`

---

## 6. Camera auto-configured for low latency on startup

When the user clicks Start with a Hikvision camera selected, the backend
automatically configures the camera via its ISAPI REST API:

- **H.264 Baseline profile** — no B-frames, eliminates decode reordering
- **GOP length = 1** — every frame is an I-frame, independently decodable

This runs best-effort; if the camera doesn't respond, startup proceeds anyway.

**Files:**
- [`backend/main.py`](backend/main.py) — `_configure_camera_sync()`, `configure_camera_handler()`
- [`client-ns-photobooth/src/pages/CameraSelect.tsx`](client-ns-photobooth/src/pages/CameraSelect.tsx) — `handleStart()`

---

## 7. Configurable stream resolution

The frontend passes the desired resolution as query parameters on the WebSocket
URL (`?w=1920&h=1080`). The backend tells FFmpeg to scale to that size. If the
camera's native resolution already matches, no scaling occurs.

**Files:**
- [`backend/main.py`](backend/main.py) — `ws_stream_handler()` reads `w`/`h` params
- [`client-ns-photobooth/src/pages/Display.tsx`](client-ns-photobooth/src/pages/Display.tsx) — URL includes `&w=...&h=...`

---

## Port configuration

Ports were moved from the defaults to avoid conflicts with other Docker services:

| Service | Port |
|---|---|
| HTTP + WebSocket stream server | 8081 |
| Rosbridge WebSocket | 9091 |
| Frontend (Vite) | 3000 |

---

## Pipeline diagram

```
Hikvision camera
  │  H.264 Baseline, GOP=1 (auto-configured)
  │  Main stream /Streaming/Channels/101
  │
  ▼  RTSP/TCP
FFmpeg subprocess
  │  nobuffer, low_delay, avioflags=direct
  │  reorder_queue_size=0, max_delay=0
  │  → raw BGR24 to stdout (bufsize=0)
  │
  ▼
_current_frame (single variable, RWLock)
  │  overwritten each frame, no queue
  │  frame_id incremented for change detection
  │
  ▼
cv2.imencode → JPEG
  │  encode thread sleeps 5ms if no new frame
  │
  ▼
WebSocket send_bytes()
  │  asyncio.Queue(maxsize=1) drops stale frames
  │
  ▼
Browser: blob URL → <img> → PIXI canvas
```
