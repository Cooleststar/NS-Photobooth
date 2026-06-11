"""
Photobooth pose detection backend.
  ws://localhost:9090/                         -> rosbridge (sends pose data to frontend)
  ws://localhost:9090/video                    -> receives camera frames from browser
  http://localhost:8080/stream?url=<rtsp-url>  -> MJPEG proxy for RTSP cameras
  POST http://localhost:8080/stream/stop       -> stop the RTSP reader
"""
import asyncio
import json
import logging
import threading
import queue
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
# RTSP / MJPEG proxy state (set once main() starts)
# ---------------------------------------------------------------------------
_loop: asyncio.AbstractEventLoop | None = None
_mjpeg_clients: set = set()          # set of asyncio.Queue, one per browser connection

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
    log.info(f"RTSP reader starting: {rtsp_url}")
    cap = cv2.VideoCapture(rtsp_url)
    frame_count = 0
    try:
        while not stop_event.is_set():
            ret, frame = cap.read()
            if not ret:
                log.warning("RTSP read failed, retrying in 3 s...")
                cap.release()
                if stop_event.wait(3):
                    break
                cap = cv2.VideoCapture(rtsp_url)
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


def start_rtsp_reader(rtsp_url: str):
    global _rtsp_stop_event, _rtsp_thread, _current_rtsp_url
    if rtsp_url == _current_rtsp_url and _rtsp_thread and _rtsp_thread.is_alive():
        return
    stop_rtsp_reader()
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

    start_rtsp_reader(rtsp_url)

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
            jpg_bytes: bytes = await asyncio.wait_for(q.get(), timeout=10.0)
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


def make_http_app() -> web.Application:
    app = web.Application()
    app.router.add_get('/stream', stream_handler)
    app.router.add_post('/stream/stop', stop_stream_handler)
    return app

# ---------------------------------------------------------------------------
# Entry point — run WebSocket (9090) and HTTP (8080) servers concurrently
# ---------------------------------------------------------------------------

async def main():
    global _loop
    _loop = asyncio.get_running_loop()

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
