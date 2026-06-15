"""
Photobooth pose detection backend.
  ws://localhost:9090/                         -> rosbridge (sends pose data to frontend)
  ws://localhost:9090/video                    -> receives camera frames from browser
  http://localhost:8080/stream?url=<rtsp-url>  -> MJPEG proxy for RTSP cameras
  POST http://localhost:8080/stream/stop       -> stop the RTSP reader
"""
import asyncio
import base64
import json
import logging
import os
import pathlib
import threading
import queue
from datetime import datetime
from urllib.parse import unquote
import cv2
import numpy as np
import mediapipe as mp
import websockets
from aiohttp import web

# Force RTSP over TCP and minimise buffering for lower display latency
os.environ.setdefault(
    'OPENCV_FFMPEG_CAPTURE_OPTIONS',
    'rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|probesize;32|analyzeduration;0',
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pose detector — shared between browser-video path and RTSP path
# Protected by a threading lock so both can call it safely
# ---------------------------------------------------------------------------
_mp = mp.solutions.pose
detector = _mp.Pose(
    static_image_mode=False,
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)
detector_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Rosbridge state
# ---------------------------------------------------------------------------
rosbridge_clients: set = set()
clients_lock = asyncio.Lock()

TOPIC_TYPES = {
    "/pose_out": "nice_ros_msgs/WholeBodyArray",
    "/rect_out": "visualization_msgs/ImageMarkerArray",
}

# ---------------------------------------------------------------------------
# RTSP / MJPEG proxy state (set once main() starts)
# ---------------------------------------------------------------------------
_loop: asyncio.AbstractEventLoop | None = None
_mjpeg_clients: set = set()          # set of asyncio.Queue, one per browser connection
_rtsp_lock: asyncio.Lock | None = None  # serialises camera switches

_rtsp_stop_event = threading.Event()
_rtsp_thread: threading.Thread | None = None
_current_rtsp_url: str = ""

# ---------------------------------------------------------------------------
# Shared pose detection helper
# ---------------------------------------------------------------------------

def run_pose_detection(frame: np.ndarray) -> dict | None:
    """Run MediaPipe pose on a BGR frame. Returns pose msg dict or None."""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    with detector_lock:
        results = detector.process(rgb)
    if not results.pose_landmarks:
        return None
    lm = results.pose_landmarks.landmark
    return {
        "poses": [{
            "x": [l.x for l in lm],
            "y": [l.y for l in lm],
            "z": [l.z for l in lm],
            "scores": [l.visibility for l in lm],
            "track": {"id": 0},
        }]
    }

# ---------------------------------------------------------------------------
# Rosbridge helpers
# ---------------------------------------------------------------------------

async def handle_service_call(ws, msg: dict):
    service = msg.get("service")
    call_id = msg.get("id")
    args = msg.get("args") or {}
    if service == "/rosapi/topic_type":
        values = {"type": TOPIC_TYPES.get(args.get("topic"), "std_msgs/String")}
    elif service == "/rosapi/service_type":
        values = {"type": "rosapi/TopicType"}
    else:
        return
    await ws.send(json.dumps({
        "op": "service_response",
        "id": call_id,
        "service": service,
        "values": values,
        "result": True,
    }))


async def broadcast(topic: str, msg: dict):
    payload = json.dumps({"op": "publish", "topic": topic, "msg": msg})
    async with clients_lock:
        dead = set()
        for ws in rosbridge_clients:
            try:
                await ws.send(payload)
            except Exception:
                dead.add(ws)
        rosbridge_clients.difference_update(dead)


async def handle_rosbridge(ws):
    log.info("Rosbridge client connected")
    async with clients_lock:
        rosbridge_clients.add(ws)
    try:
        async for message in ws:
            log.info(f"Rosbridge msg: {str(message)[:120]}")
            try:
                msg = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                continue
            if msg.get("op") == "call_service":
                await handle_service_call(ws, msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        async with clients_lock:
            rosbridge_clients.discard(ws)
        log.info("Rosbridge client disconnected")

# ---------------------------------------------------------------------------
# Browser camera video handler
# ---------------------------------------------------------------------------

async def handle_video(ws):
    log.info("Video feed connected")
    frame_count = 0
    pose_count = 0
    try:
        async for message in ws:
            if not isinstance(message, bytes):
                continue
            frame_count += 1
            arr = np.frombuffer(message, np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is None:
                continue
            if frame_count % 30 == 0:
                log.info(f"Frames: {frame_count}, Poses: {pose_count}")
            pose_msg = run_pose_detection(frame)
            if pose_msg:
                pose_count += 1
                await broadcast("/pose_out", pose_msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log.info("Video feed disconnected")


async def handler(ws, path):
    if path == "/video":
        await handle_video(ws)
    else:
        await handle_rosbridge(ws)

# ---------------------------------------------------------------------------
# RTSP reader thread
# ---------------------------------------------------------------------------

def _distribute_frame(jpg_bytes: bytes):
    """Push a JPEG frame to all connected MJPEG browser clients."""
    dead = set()
    for q in _mjpeg_clients:
        if q.full():
            try:
                q.get_nowait()  # drop oldest frame for slow clients
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(jpg_bytes)
        except Exception:
            dead.add(q)
    _mjpeg_clients.difference_update(dead)


def _rtsp_reader(rtsp_url: str, stop_event: threading.Event):
    rtsp_url = unquote(rtsp_url)  # decode %40 → @ so OpenCV doesn't mistake it for an image pattern
    log.info(f"RTSP reader starting: {rtsp_url}")

    def open_cap(url: str) -> cv2.VideoCapture:
        cap = cv2.VideoCapture()
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10_000)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 10_000)
        cap.open(url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    if stop_event.is_set():
        return
    cap = open_cap(rtsp_url)
    if not cap.isOpened():
        log.error(f"Failed to open RTSP stream (check URL/credentials): {rtsp_url}")
        return
    log.info("RTSP stream opened successfully")

    frame_count = 0
    try:
        while not stop_event.is_set():
            ret, frame = cap.read()
            if not ret:
                log.warning("RTSP read failed, retrying in 3 s...")
                cap.release()
                if stop_event.wait(3):
                    break
                cap = open_cap(rtsp_url)
                if not cap.isOpened():
                    log.error("Failed to reopen RTSP stream, stopping")
                    break
                continue

            frame_count += 1

            # Encode as JPEG and push to MJPEG streaming clients
            _, jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            _loop.call_soon_threadsafe(_distribute_frame, jpg.tobytes())

            # Run pose detection every 3rd frame to avoid overloading the CPU
            if frame_count % 3 == 0:
                small = cv2.resize(frame, (320, 240))
                pose_msg = run_pose_detection(small)
                if pose_msg:
                    asyncio.run_coroutine_threadsafe(
                        broadcast("/pose_out", pose_msg), _loop
                    )
    finally:
        cap.release()
        log.info("RTSP reader stopped")


async def switch_rtsp_reader(rtsp_url: str):
    """Switch to a new RTSP URL. Waits for the old reader to stop without blocking the event loop."""
    global _rtsp_stop_event, _rtsp_thread, _current_rtsp_url
    async with _rtsp_lock:
        if rtsp_url == _current_rtsp_url and _rtsp_thread and _rtsp_thread.is_alive():
            return
        old_thread = _rtsp_thread
        stop_rtsp_reader()
        if old_thread and old_thread.is_alive():
            log.info("Waiting for previous RTSP reader to stop...")
            await asyncio.to_thread(old_thread.join, 12)
        _current_rtsp_url = rtsp_url
        _rtsp_stop_event = threading.Event()
        _rtsp_thread = threading.Thread(
            target=_rtsp_reader,
            args=(rtsp_url, _rtsp_stop_event),
            daemon=True,
        )
        _rtsp_thread.start()
        log.info(f"RTSP reader thread started for {rtsp_url}")


def stop_rtsp_reader():
    global _current_rtsp_url
    _rtsp_stop_event.set()
    _current_rtsp_url = ""

# ---------------------------------------------------------------------------
# MJPEG HTTP server (aiohttp, port 8080)
# ---------------------------------------------------------------------------

_CORS = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
}


async def stream_handler(request: web.Request) -> web.StreamResponse:
    rtsp_url = request.rel_url.query.get('url', '').strip()
    if not rtsp_url:
        return web.Response(status=400, text='Missing ?url= parameter')

    await switch_rtsp_reader(rtsp_url)

    response = web.StreamResponse(headers={
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        **_CORS,
    })
    await response.prepare(request)

    q: asyncio.Queue = asyncio.Queue(maxsize=5)
    _mjpeg_clients.add(q)
    log.info(f"MJPEG client connected (total: {len(_mjpeg_clients)})")
    try:
        while True:
            jpg_bytes: bytes = await asyncio.wait_for(q.get(), timeout=20.0)
            await response.write(
                b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpg_bytes + b'\r\n'
            )
    except (asyncio.TimeoutError, ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        _mjpeg_clients.discard(q)
        log.info(f"MJPEG client disconnected (total: {len(_mjpeg_clients)})")

    return response


async def stop_stream_handler(request: web.Request) -> web.Response:
    stop_rtsp_reader()
    return web.Response(text='RTSP reader stopped', headers=_CORS)


async def save_photo_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        b64img: str = data.get('image', '')
        directory: str = data.get('directory', './photos').strip()

        if not b64img:
            return web.Response(status=400, text='Missing image', headers=_CORS)

        # Parse data URL: data:image/png;base64,<data>
        if ',' in b64img:
            header, b64data = b64img.split(',', 1)
            ext = header.split('/')[1].split(';')[0]  # e.g. png, webp, jpeg
        else:
            b64data = b64img
            ext = 'jpg'

        pathlib.Path(directory).mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        filepath = os.path.join(directory, f'photo_{timestamp}.{ext}')

        with open(filepath, 'wb') as f:
            f.write(base64.b64decode(b64data))

        log.info(f"Photo saved: {filepath}")
        return web.Response(text=filepath, headers=_CORS)
    except Exception as e:
        log.error(f"Save photo error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


async def browse_handler(request: web.Request) -> web.Response:
    raw = request.rel_url.query.get('path', '/app/photos').strip()
    try:
        p = pathlib.Path(raw).resolve()
        if not p.exists() or not p.is_dir():
            p = pathlib.Path('/app/photos').resolve()
        dirs = sorted(d.name for d in p.iterdir() if d.is_dir())
        parent = str(p.parent) if p != p.parent else None
        return web.Response(
            text=json.dumps({'path': str(p), 'parent': parent, 'dirs': dirs}),
            content_type='application/json',
            headers=_CORS,
        )
    except Exception as e:
        log.error(f"Browse error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


def make_http_app() -> web.Application:
    app = web.Application()
    app.router.add_get('/stream', stream_handler)
    app.router.add_post('/stream/stop', stop_stream_handler)
    app.router.add_post('/save', save_photo_handler)
    app.router.add_get('/browse', browse_handler)
    return app

# ---------------------------------------------------------------------------
# Entry point — run WebSocket (9090) and HTTP (8080) servers concurrently
# ---------------------------------------------------------------------------

async def main():
    global _loop, _rtsp_lock
    _loop = asyncio.get_running_loop()
    _rtsp_lock = asyncio.Lock()

    log.info("Photobooth backend starting...")

    ws_server = await websockets.serve(handler, "0.0.0.0", 9090)
    log.info("WebSocket server ready on port 9090")

    http_app = make_http_app()
    runner = web.AppRunner(http_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    log.info("MJPEG HTTP server ready on port 8080")

    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
