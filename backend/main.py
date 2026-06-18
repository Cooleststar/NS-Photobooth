"""
Photobooth pose detection backend.
  ws://localhost:9091/                            -> rosbridge (sends pose data to frontend)
  ws://localhost:9091/video                       -> receives camera frames from browser
  ws://localhost:8081/ws_stream?url=<rtsp-url>    -> low-latency WebSocket RTSP proxy (primary)
  http://localhost:8081/stream?url=<rtsp-url>     -> MJPEG proxy for RTSP cameras (fallback)
  POST http://localhost:8081/stream/stop          -> stop the RTSP reader
"""
import asyncio
import base64
import json
import logging
import os
import pathlib
import subprocess
import threading
import time
import queue
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from urllib.parse import unquote
import cv2
import numpy as np
import mediapipe as mp
import websockets
from aiohttp import web

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
# RTSP / stream proxy state (set once main() starts)
# ---------------------------------------------------------------------------
_loop: asyncio.AbstractEventLoop | None = None
_stream_clients: set = set()         # set of asyncio.Queue, one per browser connection
_rtsp_lock: asyncio.Lock | None = None  # serialises camera switches

_rtsp_stop_event = threading.Event()
_rtsp_thread: threading.Thread | None = None
_current_rtsp_url: str = ""
_stream_size: tuple[int, int] = (1920, 1080)   # (width, height) for JPEG encode

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
# Read-Write Lock — multiple readers, exclusive writer
# ---------------------------------------------------------------------------

class RWLock:
    """Lightweight read-write lock. Many readers can hold it simultaneously;
    a writer gets exclusive access."""

    def __init__(self):
        self._readers = 0
        self._lock = threading.Lock()       # protects _readers count
        self._write = threading.Lock()      # held by writer OR first reader

    def read_acquire(self):
        with self._lock:
            self._readers += 1
            if self._readers == 1:
                self._write.acquire()

    def read_release(self):
        with self._lock:
            self._readers -= 1
            if self._readers == 0:
                self._write.release()

    def write_acquire(self):
        self._write.acquire()

    def write_release(self):
        self._write.release()


# ---------------------------------------------------------------------------
# RTSP reader — FFmpeg subprocess, latest-frame-only design
# ---------------------------------------------------------------------------

def _distribute_frame(jpg_bytes: bytes):
    """Push a JPEG frame to all connected stream clients (WS and MJPEG)."""
    dead = set()
    for q in _stream_clients:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(jpg_bytes)
        except Exception:
            dead.add(q)
    _stream_clients.difference_update(dead)


# Shared frame state — written by ffmpeg reader, read by encode + pose threads
_current_frame: np.ndarray | None = None
_frame_id: int = 0
_frame_rwlock = RWLock()


def _ffmpeg_read_loop(
    rtsp_url: str,
    stop_event: threading.Event,
    width: int,
    height: int,
):
    """Read raw BGR24 frames from an FFmpeg subprocess and store the latest one.

    FFmpeg is launched with every buffering knob turned off so frames arrive
    as close to real-time as the network allows.  Each new frame overwrites
    the previous one — there is no queue.
    """
    global _current_frame, _frame_id

    cmd = [
        'ffmpeg',
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-avioflags', 'direct',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-max_delay', '0',
        '-reorder_queue_size', '0',
        '-i', rtsp_url,
        '-vf', f'scale={width}:{height}',
        '-f', 'rawvideo',
        '-pix_fmt', 'bgr24',
        '-an', '-sn',
        'pipe:1',
    ]

    frame_bytes = width * height * 3
    max_buf = frame_bytes * 10

    while not stop_event.is_set():
        log.info(f"FFmpeg launching: {rtsp_url} ({width}×{height})")
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )

        buf = bytearray()
        try:
            while not stop_event.is_set():
                chunk = proc.stdout.read(frame_bytes)
                if not chunk:
                    break
                buf.extend(chunk)

                # Discard old data if buffer grew too large (system was busy)
                if len(buf) > max_buf:
                    excess = (len(buf) // frame_bytes - 1) * frame_bytes
                    del buf[:excess]

                while len(buf) >= frame_bytes:
                    raw = bytes(buf[:frame_bytes])
                    del buf[:frame_bytes]
                    frame = np.frombuffer(raw, dtype=np.uint8).reshape(
                        (height, width, 3)
                    )
                    _frame_rwlock.write_acquire()
                    _current_frame = frame
                    _frame_id += 1
                    _frame_rwlock.write_release()

        except Exception as e:
            log.error(f"FFmpeg read error: {e}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

        if not stop_event.is_set():
            log.warning("FFmpeg exited, restarting in 3 s...")
            if stop_event.wait(3):
                break

    log.info("FFmpeg read loop stopped")


def _rtsp_reader(rtsp_url: str, stop_event: threading.Event):
    """Encode the latest frame to JPEG and distribute to browser clients.

    Runs in its own thread.  Checks _frame_id to detect new frames; if the
    frame hasn't changed it sleeps 5 ms and checks again (no wasted encodes).
    """
    rtsp_url = unquote(rtsp_url)
    sw, sh = _stream_size
    log.info(f"RTSP reader starting: {rtsp_url} (stream {sw}×{sh})")

    if stop_event.is_set():
        return

    ffmpeg_thread = threading.Thread(
        target=_ffmpeg_read_loop,
        args=(rtsp_url, stop_event, sw, sh),
        daemon=True,
    )
    ffmpeg_thread.start()

    prev_id = -1
    frame_count = 0
    try:
        while not stop_event.is_set():
            _frame_rwlock.read_acquire()
            fid = _frame_id
            frame = _current_frame
            _frame_rwlock.read_release()

            if fid == prev_id or frame is None:
                time.sleep(0.005)
                continue
            prev_id = fid
            frame_count += 1

            _, jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
            _loop.call_soon_threadsafe(_distribute_frame, jpg.tobytes())

            if frame_count % 3 == 0:
                small = cv2.resize(frame, (320, 240))
                threading.Thread(
                    target=lambda f=small: (
                        asyncio.run_coroutine_threadsafe(
                            broadcast("/pose_out",
                                      run_pose_detection(f) or {"poses": []}),
                            _loop,
                        )
                    ),
                    daemon=True,
                ).start()
    finally:
        stop_event.set()
        ffmpeg_thread.join(timeout=10)
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
# HTTP + WebSocket server (aiohttp, port 8081)
# ---------------------------------------------------------------------------

_CORS = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
}


async def ws_stream_handler(request: web.Request) -> web.WebSocketResponse:
    """Low-latency WebSocket endpoint: sends raw JPEG blobs to the browser."""
    global _stream_size
    rtsp_url = request.rel_url.query.get('url', '').strip()
    if not rtsp_url:
        return web.Response(status=400, text='Missing ?url= parameter')

    w = int(request.rel_url.query.get('w', 0))
    h = int(request.rel_url.query.get('h', 0))
    if w > 0 and h > 0:
        _stream_size = (w, h)
        log.info(f"Stream resolution set to {w}×{h}")

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    await switch_rtsp_reader(rtsp_url)

    q: asyncio.Queue = asyncio.Queue(maxsize=1)
    _stream_clients.add(q)
    log.info(f"WS stream client connected (total: {len(_stream_clients)})")
    try:
        while not ws.closed:
            jpg_bytes: bytes = await asyncio.wait_for(q.get(), timeout=20.0)
            await ws.send_bytes(jpg_bytes)
    except (asyncio.TimeoutError, ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        _stream_clients.discard(q)
        log.info(f"WS stream client disconnected (total: {len(_stream_clients)})")

    return ws


async def stream_handler(request: web.Request) -> web.StreamResponse:
    """MJPEG fallback endpoint for clients that don't support WebSocket."""
    rtsp_url = request.rel_url.query.get('url', '').strip()
    if not rtsp_url:
        return web.Response(status=400, text='Missing ?url= parameter')

    await switch_rtsp_reader(rtsp_url)

    response = web.StreamResponse(headers={
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        **_CORS,
    })
    await response.prepare(request)

    q: asyncio.Queue = asyncio.Queue(maxsize=1)
    _stream_clients.add(q)
    log.info(f"MJPEG client connected (total: {len(_stream_clients)})")
    try:
        while True:
            jpg_bytes: bytes = await asyncio.wait_for(q.get(), timeout=20.0)
            await response.write(
                b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpg_bytes + b'\r\n'
            )
    except (asyncio.TimeoutError, ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        _stream_clients.discard(q)
        log.info(f"MJPEG client disconnected (total: {len(_stream_clients)})")

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


# ---------------------------------------------------------------------------
# Hikvision ISAPI camera configuration
# ---------------------------------------------------------------------------

def _configure_camera_sync(
    ip: str, user: str, password: str, stream: int, use_mjpeg: bool,
):
    """Set a Hikvision camera channel to low-latency encoding via ISAPI.

    stream=1 → channel 101 (main), stream=2 → channel 102 (sub).
    """
    channel_id = f'10{stream}'
    base_url = f'http://{ip}'
    api_url = f'{base_url}/ISAPI/Streaming/channels/{channel_id}'

    auth = urllib.request.HTTPDigestAuthHandler()
    auth.add_password(realm=None, uri=base_url, user=user, passwd=password)
    opener = urllib.request.build_opener(auth)

    current = opener.open(api_url, timeout=10).read()
    root = ET.fromstring(current)

    def set_text(tag: str, value: str):
        for elem in root.iter():
            if elem.tag.endswith(tag):
                elem.text = value
                return

    if use_mjpeg:
        set_text('videoCodecType', 'MJPEG')
    else:
        set_text('videoCodecType', 'H.264')
        set_text('H264Profile', 'Baseline')
        set_text('GovLength', '1')

    xml_bytes = ET.tostring(root, encoding='unicode').encode('utf-8')
    req = urllib.request.Request(api_url, data=xml_bytes, method='PUT')
    req.add_header('Content-Type', 'application/xml')
    opener.open(req, timeout=10)


async def configure_camera_handler(request: web.Request) -> web.Response:
    if request.method == 'OPTIONS':
        return web.Response(headers={
            **_CORS,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        })
    try:
        data = await request.json()
        ip = data.get('ip', '').strip()
        user = data.get('user', 'admin')
        password = data.get('password', '')
        stream = int(data.get('stream', 2))
        use_mjpeg = bool(data.get('mjpeg', False))

        if not ip:
            return web.Response(status=400, text='Missing ip', headers=_CORS)

        await asyncio.to_thread(
            _configure_camera_sync, ip, user, password, stream, use_mjpeg,
        )
        mode = 'MJPEG' if use_mjpeg else 'H.264 Baseline (GOP=1)'
        msg = f'Camera {ip} channel 10{stream} set to {mode}'
        log.info(msg)
        return web.Response(text=msg, headers=_CORS)
    except Exception as e:
        log.error(f"Camera configure error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


def make_http_app() -> web.Application:
    app = web.Application()
    app.router.add_get('/ws_stream', ws_stream_handler)
    app.router.add_get('/stream', stream_handler)
    app.router.add_post('/stream/stop', stop_stream_handler)
    app.router.add_post('/save', save_photo_handler)
    app.router.add_get('/browse', browse_handler)
    app.router.add_route('*', '/camera/configure', configure_camera_handler)
    return app

# ---------------------------------------------------------------------------
# Entry point — run WebSocket (9091) and HTTP (8081) servers concurrently
# ---------------------------------------------------------------------------

async def main():
    global _loop, _rtsp_lock
    _loop = asyncio.get_running_loop()
    _rtsp_lock = asyncio.Lock()

    log.info("Photobooth backend starting...")

    ws_server = await websockets.serve(handler, "0.0.0.0", 9091)
    log.info("WebSocket server ready on port 9091")

    http_app = make_http_app()
    runner = web.AppRunner(http_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8081)
    await site.start()
    log.info("MJPEG HTTP server ready on port 8081")

    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
