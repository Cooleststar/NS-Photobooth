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
import websockets
from aiohttp import web
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MediaPipe Hands — palm orientation detection (mediapipe >= 0.10 tasks API)
# ---------------------------------------------------------------------------
_mp_hands_available = False
_mp_hands_lock = threading.Lock()
_hand_landmarker = None

try:
    import mediapipe as _mp
    from mediapipe.tasks import python as _mp_python
    from mediapipe.tasks.python import vision as _mp_vision

    _HAND_MODEL_PATH = os.path.join(os.path.dirname(__file__), 'hand_landmarker.task')
    _HAND_MODEL_URL = (
        'https://storage.googleapis.com/mediapipe-models/'
        'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
    )

    if not os.path.exists(_HAND_MODEL_PATH):
        log.info("Downloading hand_landmarker.task (~23 MB) …")
        urllib.request.urlretrieve(_HAND_MODEL_URL, _HAND_MODEL_PATH)
        log.info("Hand landmarker model saved to %s", _HAND_MODEL_PATH)

    _hand_landmarker = _mp_vision.HandLandmarker.create_from_options(
        _mp_vision.HandLandmarkerOptions(
            base_options=_mp_python.BaseOptions(model_asset_path=_HAND_MODEL_PATH),
            num_hands=2,
            min_hand_detection_confidence=0.5,
            min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            running_mode=_mp_vision.RunningMode.IMAGE,
        )
    )
    _mp_hands_available = True
    log.info("MediaPipe HandLandmarker initialised")

except Exception as _e:
    log.warning("MediaPipe Hands unavailable — drone palm-up detection disabled: %s", _e)


def run_hand_detection(frame: np.ndarray) -> list:
    """Run MediaPipe HandLandmarker on a BGR frame. Returns a list of hand dicts."""
    if not _mp_hands_available or _hand_landmarker is None:
        return []
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = _mp.Image(image_format=_mp.ImageFormat.SRGB, data=rgb)
    with _mp_hands_lock:
        result = _hand_landmarker.detect(mp_image)
    hands = []
    for i, hand_lms in enumerate(result.hand_landmarks):
        x = [float(lm.x) for lm in hand_lms]
        y = [float(lm.y) for lm in hand_lms]
        z = [float(lm.z) for lm in hand_lms]
        label = result.handedness[i][0].category_name  # "Left" or "Right"
        # Palm-up: MCP knuckles avg-y (5,9,13,17) above wrist (0) in image space
        mcp_y = (hand_lms[5].y + hand_lms[9].y + hand_lms[13].y + hand_lms[17].y) / 4
        palm_up = bool(mcp_y < hand_lms[0].y)
        hands.append({
            "x":       x,
            "y":       y,
            "z":       z,
            "label":   label,
            "palm_up": palm_up,
        })
    return hands


# ---------------------------------------------------------------------------
# Pose detector — YOLO26-Pose (upgraded from YOLOv8n-Pose)
# ---------------------------------------------------------------------------
# Change 'yolo26n-pose.pt' to 's'/'m'/'l' for better accuracy at cost of speed.
# The model is auto-downloaded on first run.
# Revert to 'yolov8n-pose.pt' if tracking becomes unstable.
_yolo = YOLO('yolo26n-pose.pt')
_yolo_lock = threading.Lock()
_multi_target: bool = False

# Maps COCO-17 keypoint index → MediaPipe-33 landmark index.
# Landmarks that have no COCO equivalent are left at x=y=0, score=0 (not visible).
_COCO_TO_MP: dict[int, int] = {
    0:  0,   # nose
    1:  2,   # left eye
    2:  5,   # right eye
    3:  7,   # left ear
    4:  8,   # right ear
    5:  11,  # left shoulder
    6:  12,  # right shoulder
    7:  13,  # left elbow
    8:  14,  # right elbow
    9:  15,  # left wrist
    10: 16,  # right wrist
    11: 23,  # left hip
    12: 24,  # right hip
    13: 25,  # left knee
    14: 26,  # right knee
    15: 27,  # left ankle
    16: 28,  # right ankle
}


def _to_mp33(xyn, conf):
    """Map 17 normalised COCO keypoints to a 33-element MediaPipe landmark list."""
    x      = [0.0] * 33
    y      = [0.0] * 33
    scores = [0.0] * 33
    for ci, mi in _COCO_TO_MP.items():
        x[mi]      = float(xyn[ci, 0])
        y[mi]      = float(xyn[ci, 1])
        scores[mi] = float(conf[ci]) if conf is not None else 1.0
    return x, y, scores


def run_pose_detection(frame: np.ndarray) -> dict:
    """Run YOLOv8-Pose on a BGR frame. Always returns a pose msg dict."""
    with _yolo_lock:
        results = _yolo.track(
            frame,
            persist=True,   # maintains stable track IDs across frames
            verbose=False,
            conf=0.4,
            iou=0.45,       # tighter NMS to prevent double-detecting one person
            imgsz=640,      # lower to 320 for faster inference on weak hardware
        )

    if not results:
        return {"poses": []}

    r = results[0]
    if r.keypoints is None or len(r.keypoints) == 0:
        return {"poses": []}

    kps_xyn  = r.keypoints.xyn.cpu().numpy()                          # (N, 17, 2)
    kps_conf = (r.keypoints.conf.cpu().numpy()                        # (N, 17)
                if r.keypoints.conf is not None else None)
    ids = (r.boxes.id.cpu().numpy().astype(int).tolist()
           if r.boxes.id is not None else list(range(len(kps_xyn))))

    # In single-target mode keep only the highest-confidence detection
    if not _multi_target and len(kps_xyn) > 1:
        box_conf = (r.boxes.conf.cpu().numpy() if r.boxes.conf is not None
                    else np.ones(len(kps_xyn)))
        best = int(np.argmax(box_conf))
        kps_xyn  = kps_xyn[best:best + 1]
        kps_conf = kps_conf[best:best + 1] if kps_conf is not None else None
        ids      = [ids[best]]

    poses = []
    for i in range(len(kps_xyn)):
        conf_row = kps_conf[i] if kps_conf is not None else None
        x, y, scores = _to_mp33(kps_xyn[i], conf_row)
        poses.append({
            "x":      x,
            "y":      y,
            "z":      [0.0] * 33,
            "scores": scores,
            "track":  {"id": int(ids[i])},
        })

    hands = run_hand_detection(frame)
    return {"poses": poses, "hands": hands}

# ---------------------------------------------------------------------------
# Rosbridge state
# ---------------------------------------------------------------------------
rosbridge_clients: set = set()
clients_lock: asyncio.Lock  # initialised inside main() to avoid wrong-loop bind

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
_current_stream_size: tuple[int, int] = (0, 0)
_stream_size: tuple[int, int] = (1920, 1080)   # (width, height) for JPEG encode
_rtsp_pose_busy: bool = False  # drop RTSP pose frames while inference is running



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
    inferring = False

    async def run_inference(frame):
        nonlocal inferring, pose_count
        inferring = True
        try:
            pose_msg = await asyncio.to_thread(run_pose_detection, frame)
            if pose_msg["poses"]:
                pose_count += 1
            await broadcast("/pose_out", pose_msg)
        finally:
            inferring = False

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
            if not inferring:
                asyncio.create_task(run_inference(frame))
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


# Shared frame state — written by ffmpeg reader, read by distribute + pose threads
_current_frame: np.ndarray | None = None
_current_jpg: bytes | None = None
_frame_id: int = 0
_frame_rwlock = RWLock()


_JPEG_SOI = b'\xff\xd8'
_JPEG_EOI = b'\xff\xd9'


def _ffmpeg_read_loop(
    rtsp_url: str,
    stop_event: threading.Event,
    width: int,
    height: int,
):
    """Read MJPEG frames from an FFmpeg subprocess and store the latest one.

    FFmpeg outputs JPEG-compressed frames instead of raw video, cutting pipe
    bandwidth by ~95%.  Each JPEG is delimited by SOI (FF D8) and EOI (FF D9)
    markers.  The latest JPEG bytes and decoded numpy frame are stored for the
    encode/distribute thread — there is no queue.
    """
    global _current_frame, _current_jpg, _frame_id

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
        '-f', 'image2pipe',
        '-c:v', 'mjpeg',
        '-q:v', '3',
        '-an', '-sn',
        'pipe:1',
    ]

    CHUNK = 65536
    MAX_BUF = 5 * 1024 * 1024

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
                chunk = proc.stdout.read(CHUNK)
                if not chunk:
                    break
                buf.extend(chunk)

                if len(buf) > MAX_BUF:
                    last_soi = buf.rfind(_JPEG_SOI)
                    if last_soi > 0:
                        del buf[:last_soi]
                    elif last_soi < 0:
                        buf.clear()

                while True:
                    soi = buf.find(_JPEG_SOI)
                    if soi < 0:
                        buf.clear()
                        break
                    eoi = buf.find(_JPEG_EOI, soi + 2)
                    if eoi < 0:
                        if soi > 0:
                            del buf[:soi]
                        break
                    jpg_bytes = bytes(buf[soi:eoi + 2])
                    del buf[:eoi + 2]

                    arr = np.frombuffer(jpg_bytes, np.uint8)
                    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                    if frame is None:
                        continue

                    _frame_rwlock.write_acquire()
                    _current_frame = frame
                    _current_jpg = jpg_bytes
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
            jpg = _current_jpg
            _frame_rwlock.read_release()

            if fid == prev_id or jpg is None:
                time.sleep(0.005)
                continue
            prev_id = fid
            frame_count += 1

            _loop.call_soon_threadsafe(_distribute_frame, jpg)

            if frame_count % 3 == 0 and frame is not None:
                global _rtsp_pose_busy
                small = cv2.resize(frame, (320, 240))
                if not _rtsp_pose_busy:
                    _rtsp_pose_busy = True
                    def _rtsp_infer(f):
                        global _rtsp_pose_busy
                        try:
                            asyncio.run_coroutine_threadsafe(
                                broadcast("/pose_out", run_pose_detection(f)),
                                _loop,
                            ).result()
                        finally:
                            _rtsp_pose_busy = False
                    threading.Thread(target=_rtsp_infer, args=(small,), daemon=True).start()
    finally:
        stop_event.set()
        ffmpeg_thread.join(timeout=10)
        log.info("RTSP reader stopped")


async def switch_rtsp_reader(rtsp_url: str, force: bool = False):
    """Restart the RTSP reader if the URL or stream resolution changed.

    Pass force=True to reconnect even when the URL and size are unchanged
    (used by the keepfresh watchdog to flush camera-side encode buffers).
    """
    global _rtsp_stop_event, _rtsp_thread, _current_rtsp_url, _current_stream_size
    async with _rtsp_lock:
        same_url = rtsp_url == _current_rtsp_url
        same_size = _stream_size == _current_stream_size
        if not force and same_url and same_size and _rtsp_thread and _rtsp_thread.is_alive():
            return
        old_thread = _rtsp_thread
        stop_rtsp_reader()
        if old_thread and old_thread.is_alive():
            log.info("Waiting for previous RTSP reader to stop...")
            await asyncio.to_thread(old_thread.join, 12)
        _current_rtsp_url = rtsp_url
        _current_stream_size = _stream_size
        _rtsp_stop_event = threading.Event()
        _rtsp_thread = threading.Thread(
            target=_rtsp_reader,
            args=(rtsp_url, _rtsp_stop_event),
            daemon=True,
        )
        _rtsp_thread.start()
        log.info(f"RTSP reader thread started for {rtsp_url} at {_stream_size[0]}×{_stream_size[1]}")


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
    global _stream_size, _multi_target
    rtsp_url = request.rel_url.query.get('url', '').strip()
    if not rtsp_url:
        return web.Response(status=400, text='Missing ?url= parameter')

    w = int(request.rel_url.query.get('w', 0))
    h = int(request.rel_url.query.get('h', 0))
    if w > 0 and h > 0:
        _stream_size = (w, h)
        log.info(f"Stream resolution set to {w}×{h}")

    _multi_target = request.rel_url.query.get('multi', '0') == '1'
    log.info(f"Multi-target: {_multi_target}")

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

async def _rtsp_keepfresh_loop(interval_s: int = 45):
    """Periodically force-reconnect to the RTSP camera.

    Hikvision cameras (and many H.264 IP cameras) accumulate latency over
    time because H.264 GOP buffering causes the encode pipeline to drift
    further and further from real-time.  Reconnecting forces the camera to
    start a fresh stream from the current frame, resetting the delay.
    The browser WebSocket stays open; clients see only a brief (~1 s) gap.
    """
    while True:
        await asyncio.sleep(interval_s)
        url = _current_rtsp_url
        if not url:
            continue
        log.info("RTSP keepfresh: reconnecting to flush camera buffer")
        await switch_rtsp_reader(url, force=True)


async def main():
    global _loop, _rtsp_lock, clients_lock
    _loop = asyncio.get_running_loop()
    _rtsp_lock = asyncio.Lock()
    clients_lock = asyncio.Lock()  # must be created inside the running loop

    log.info("Photobooth backend starting...")

    asyncio.create_task(_rtsp_keepfresh_loop())

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
