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
import torch
import cv2
import numpy as np
import requests
import websockets
from aiohttp import web
from ultralytics import YOLO
from PIL import Image as PILImage

try:
    from transformers import AutoProcessor, VitPoseForPoseEstimation
    _transformers_available = True
except ImportError:
    _transformers_available = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Gesture diagnostic mode — opt-in (GESTURE_DEBUG=1), off by default so it
# costs nothing in normal/production runs. When on, logs the raw geometric
# values behind every palm-up classification (not just the final true/false)
# plus a matching saved frame, so we can look at what the camera actually
# saw next to what the heuristic concluded — this is how we get real
# evidence instead of guessing why gesture detection misfires.
#
# Runs entirely inside the MediaPipe Hands background worker thread, which
# already doesn't block the main detection loop, so this adds zero latency
# to the live pipeline. Throttled to at most one write per _GESTURE_DEBUG_
# _MIN_INTERVAL seconds, except state transitions (palm_up flipping), which
# always get logged since those are the moments most worth reviewing.
# ---------------------------------------------------------------------------
_GESTURE_DEBUG = os.environ.get('GESTURE_DEBUG', '0') == '1'
_GESTURE_DEBUG_DIR = pathlib.Path(__file__).parent / 'gesture_debug'
_GESTURE_DEBUG_MIN_INTERVAL = 0.5  # seconds between routine (non-transition) samples
_gesture_debug_last_write: float = 0.0
_gesture_debug_last_palm_up: dict = {}  # label -> last logged palm_up bool, to detect flips
_gesture_debug_last_palm_sky: dict = {}  # label -> last logged palm_sky bool, to detect flips

if _GESTURE_DEBUG:
    _GESTURE_DEBUG_DIR.mkdir(exist_ok=True)
    log.info(f"Gesture debug mode ON — writing to {_GESTURE_DEBUG_DIR}")


def _log_gesture_debug(records: list, frame: np.ndarray) -> None:
    """Append one JSONL line per detected hand + save the frame, throttled.
    `records` are raw geometric measurements, not just the final boolean,
    so we can see *how close* a borderline case was, not just pass/fail."""
    global _gesture_debug_last_write
    now = time.time()
    any_transition = any(
        _gesture_debug_last_palm_up.get(r['label']) != r['palm_up']
        or _gesture_debug_last_palm_sky.get(r['label']) != r['palm_sky']
        for r in records
    )
    if not any_transition and (now - _gesture_debug_last_write) < _GESTURE_DEBUG_MIN_INTERVAL:
        return
    _gesture_debug_last_write = now
    for r in records:
        _gesture_debug_last_palm_up[r['label']] = r['palm_up']
        _gesture_debug_last_palm_sky[r['label']] = r['palm_sky']

    ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    try:
        frame_name = f'{ts}.jpg'
        cv2.imwrite(str(_GESTURE_DEBUG_DIR / frame_name), frame)
        with open(_GESTURE_DEBUG_DIR / 'log.jsonl', 'a') as f:
            for r in records:
                f.write(json.dumps({'ts': ts, 'frame': frame_name, **r}) + '\n')
    except Exception as _e:
        log.debug("Gesture debug write error: %s", _e)


# ---------------------------------------------------------------------------
# MediaPipe Hands — palm orientation detection (mediapipe >= 0.10 tasks API)
# ---------------------------------------------------------------------------
_mp_hands_available = False
_mp_hands_lock = threading.Lock()
_hand_landmarker = None
_mp_hands_queue: queue.Queue = queue.Queue(maxsize=1)
_mp_hands_cache: list = []   # latest result, updated by worker

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
            # 4 -> matches MAX_PEOPLE in Display.tsx / DRONE_SLOTS in drone.ts:
            # up to 4 simultaneous drones (e.g. 4 people showing one palm each,
            # or 2 people showing both). Was 2 — that was the actual ceiling on
            # simultaneous drones, not anything in the frontend.
            num_hands=4,
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


# Lower magnitude (closer to 0) = easier to trigger, tolerates a palm that's
# tilted rather than facing dead-on vertical. Higher magnitude = stricter.
# Picked by geometric reasoning, not measured against real footage (no
# camera available in this environment) — tune against GESTURE_DEBUG=1
# output (normal_y ranges roughly -1 "straight up" to +1 "straight down").
_PALM_SKY_THRESHOLD = -0.4


def _palm_facing_sky(hand_world_lms, label: str):
    """Whether the palm's surface faces upward (skyward) — a roughly
    horizontal, outstretched hand held like it's offering/presenting
    something on it, as opposed to an upright hand held palm-toward-camera
    (that's the separate, older 'palm_up' heuristic below).

    Computed as the palm's surface normal: the cross product of two vectors
    lying in the palm plane (wrist->index_mcp, wrist->pinky_mcp). Takes
    HandLandmarker's *world* landmarks (hand_world_landmarks — real-world
    metric coordinates, roughly meters, independent of camera FOV/distance)
    rather than the normalized image landmarks used everywhere else in this
    file: those are fine for on-screen positioning, but their z is a rough,
    perspective-relative approximation, noisier than world z and not really
    meant for angle/orientation math like this.

    IMPORTANT — world landmarks are NOT guaranteed to share image landmarks'
    axis convention (image y increases downward; world coordinates may or
    may not put +y "up"). This was implemented and reasoned about without a
    live camera to verify against, so the sign in _PALM_SKY_THRESHOLD's
    comparison below is a best guess, not a confirmed fact — if the gesture
    ends up backwards (triggers on palm-down instead of palm-up), flip the
    comparison direction (and the sign of _PALM_SKY_THRESHOLD) rather than
    assuming the geometry itself is wrong. Verify with GESTURE_DEBUG=1 and
    check normal_y in backend/gesture_debug/log.jsonl against what the palm
    was actually doing in the matching saved frame.

    The winding order index->pinky flips between hands, so the resulting
    normal is negated for the left hand to keep "positive/negative" meaning
    the same regardless of which hand is shown; requiring the up/down
    component to dominate the vector (via _PALM_SKY_THRESHOLD) rules out a
    hand that's merely tilted rather than genuinely palm-up.

    Returns (is_sky_facing, normal_y) — the raw normal_y is included for
    GESTURE_DEBUG tuning, same reasoning as the palm_up debug fields below.
    """
    wrist = hand_world_lms[0]
    index_mcp = hand_world_lms[5]
    pinky_mcp = hand_world_lms[17]
    v1 = (index_mcp.x - wrist.x, index_mcp.y - wrist.y, index_mcp.z - wrist.z)
    v2 = (pinky_mcp.x - wrist.x, pinky_mcp.y - wrist.y, pinky_mcp.z - wrist.z)
    nx = v1[1] * v2[2] - v1[2] * v2[1]
    ny = v1[2] * v2[0] - v1[0] * v2[2]
    nz = v1[0] * v2[1] - v1[1] * v2[0]
    if label == 'Left':
        nx, ny, nz = -nx, -ny, -nz
    length = (nx * nx + ny * ny + nz * nz) ** 0.5
    if length < 1e-6:
        return False, 0.0
    ny /= length
    return ny < _PALM_SKY_THRESHOLD, ny


def _mp_hands_worker():
    global _mp_hands_cache
    while True:
        try:
            frame = _mp_hands_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = _mp.Image(image_format=_mp.ImageFormat.SRGB, data=rgb)
            with _mp_hands_lock:
                result = _hand_landmarker.detect(mp_image)
            hands = []
            debug_records = []
            for i, hand_lms in enumerate(result.hand_landmarks):
                x = [float(lm.x) for lm in hand_lms]
                y = [float(lm.y) for lm in hand_lms]
                z = [float(lm.z) for lm in hand_lms]
                label = result.handedness[i][0].category_name
                handedness_score = float(result.handedness[i][0].score)
                mcp_y = (hand_lms[5].y + hand_lms[9].y + hand_lms[13].y + hand_lms[17].y) / 4
                wrist_y = hand_lms[0].y
                hand_upright = mcp_y < wrist_y
                thumb_x = hand_lms[2].x
                pinky_x = hand_lms[17].x
                if label == 'Left':
                    palm_facing_up = thumb_x < pinky_x
                else:
                    palm_facing_up = thumb_x > pinky_x
                palm_up = bool(hand_upright and palm_facing_up)
                # hand_world_landmarks is parallel to hand_landmarks (same
                # index per detected hand) — real-world metric coordinates,
                # better suited to orientation math than the image landmarks
                # used everywhere else here. See _palm_facing_sky's docstring.
                world_lms = (
                    result.hand_world_landmarks[i]
                    if i < len(result.hand_world_landmarks) else hand_lms
                )
                palm_sky, palm_normal_y = _palm_facing_sky(world_lms, label)
                hands.append({
                    "x": x, "y": y, "z": z, "label": label,
                    "palm_up": palm_up, "palm_sky": palm_sky,
                })
                if _GESTURE_DEBUG:
                    debug_records.append({
                        'label': label,
                        'handedness_score': handedness_score,
                        'mcp_y': mcp_y, 'wrist_y': wrist_y, 'hand_upright': hand_upright,
                        'thumb_x': thumb_x, 'pinky_x': pinky_x, 'palm_facing_up': palm_facing_up,
                        'palm_up': palm_up,
                        'palm_normal_y': palm_normal_y, 'palm_sky': palm_sky,
                    })
            _mp_hands_cache = hands
            if _GESTURE_DEBUG and debug_records:
                _log_gesture_debug(debug_records, frame)
        except Exception as _e:
            log.debug("MP hands worker error: %s", _e)


if _mp_hands_available:
    threading.Thread(target=_mp_hands_worker, daemon=True).start()


def run_hand_detection(frame: np.ndarray):
    """Submit frame to hand-detection worker (non-blocking) and return cached result."""
    if _mp_hands_available:
        try:
            _mp_hands_queue.put_nowait(frame.copy())
        except queue.Full:
            pass
    return _mp_hands_cache


# ---------------------------------------------------------------------------
# Pose detector — YOLO26-Pose (upgraded from YOLOv8n-Pose)
# ---------------------------------------------------------------------------
# Change 'yolo26n-pose.pt' to 's'/'m'/'l' for better accuracy at cost of speed.
# The model is auto-downloaded on first run.
# Revert to 'yolov8n-pose.pt' if tracking becomes unstable.
_yolo = YOLO('yolo26n-pose.pt')
_yolo_lock = threading.Lock()
# Tuned BoT-SORT settings - longer track_buffer and a looser match_thresh so a
# person standing close to the camera keeps their track ID instead of being
# re-issued a new one every time detection wobbles. See the file for details.
_TRACKER_CFG = str(pathlib.Path(__file__).parent / 'botsort_photobooth.yaml')
_multi_target: bool = False

# ---------------------------------------------------------------------------
# ViTPose++-Huge — async keypoint refinement running in a background thread
#
# Architecture: YOLO detection stays on the fast path (returns immediately).
# A size-1 queue feeds the ViTPose++ worker; results are cached per track ID
# with a 2 s TTL. Each YOLO result merges the cached ViTPose++ keypoints when
# available, falling back to YOLO's own keypoints — this is what improves
# arm/shoulder/wrist tracking precision over YOLO26n's nano-scale keypoints.
#
# CAUTION: "doesn't block the return value" is NOT the same as "free". This
# is a ~630M-param transformer; without a CUDA GPU it runs on CPU and its
# background thread competes for the same CPU cores as the main YOLO loop
# every frame, which shows up as real added latency across the whole app.
# So: auto-enabled when a CUDA GPU is available, auto-disabled otherwise.
# Override either way with ENABLE_VITPOSE=1 or ENABLE_VITPOSE=0.
# ---------------------------------------------------------------------------
_ENABLE_VITPOSE = os.environ.get(
    'ENABLE_VITPOSE', '1' if torch.cuda.is_available() else '0',
) == '1'
_vitpose_model = None
_vitpose_processor = None
_vitpose_lock = threading.Lock()
_vitpose_device = 'cuda' if torch.cuda.is_available() else 'cpu'

# queue(1): drops frames when worker is busy so we always process the latest
_vitpose_queue: queue.Queue = queue.Queue(maxsize=1)
# {track_id: (timestamp, kps_xyn (17,2), kps_scores (17,), box_xyxy (4,))}
_vitpose_cache: dict = {}
_VITPOSE_CACHE_TTL = 2.0   # seconds before a cached result is considered stale
# A cached entry is only trusted if the box it was computed from still
# overlaps the box the same track ID occupies now — see run_pose_detection().
_VITPOSE_MIN_IOU = 0.5


def _box_iou(a, b) -> float:
    """IoU of two xyxy boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return float(inter / union) if union > 0 else 0.0

if not _ENABLE_VITPOSE:
    log.info("ViTPose++ disabled — set ENABLE_VITPOSE=1 to re-enable (GPU recommended)")
elif _transformers_available:
    # NOTE: must stay float32 even on CUDA — transformers' own
    # post_process_pose_estimation() runs scipy.ndimage.gaussian_filter
    # on the raw heatmaps, which doesn't support float16 at all and
    # crashes every call ("array type dtype('float16') not supported").
    # The A5000 has plenty of VRAM (~2.5 GB for this model in fp32), so
    # there's no real reason to fight for the fp16 memory/speed gain.
    #
    # Try the local cache first (local_files_only=True makes zero network
    # calls). Without this, from_pretrained() re-validates every file against
    # the HF Hub on *every* startup, even when fully cached — unauthenticated
    # requests get rate-limited, turning every boot into a multi-minute stall
    # while the whole backend (RTSP feed included) waits on it. Only fall
    # back to a real network fetch if nothing usable is cached yet (first
    # run, or a previous download got interrupted).
    try:
        _vitpose_processor = AutoProcessor.from_pretrained(
            "usyd-community/vitpose-plus-huge", local_files_only=True,
        )
        _vitpose_model = VitPoseForPoseEstimation.from_pretrained(
            "usyd-community/vitpose-plus-huge",
            torch_dtype=torch.float32,
            local_files_only=True,
        ).to(_vitpose_device).eval()
        log.info("ViTPose++-Huge loaded from local cache on %s", _vitpose_device)
    except Exception:
        try:
            log.info("ViTPose++-Huge not cached locally — downloading (~900 MB, first run only)…")
            _vitpose_processor = AutoProcessor.from_pretrained("usyd-community/vitpose-plus-huge")
            _vitpose_model = VitPoseForPoseEstimation.from_pretrained(
                "usyd-community/vitpose-plus-huge",
                torch_dtype=torch.float32,
            ).to(_vitpose_device).eval()
            log.info("ViTPose++-Huge loaded on %s", _vitpose_device)
        except Exception as _e:
            log.warning("ViTPose++ unavailable — falling back to YOLO keypoints: %s", _e)
else:
    log.warning("transformers not installed — pip install transformers to enable ViTPose++")


def _vitpose_worker():
    """Background thread: dequeues frames, runs ViTPose++, updates cache."""
    while True:
        try:
            frame, boxes_xyxy, ids = _vitpose_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        try:
            rgb      = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img  = PILImage.fromarray(rgb)
            boxes_list = boxes_xyxy.tolist()

            inputs = _vitpose_processor(
                images=pil_img, boxes=[boxes_list], return_tensors="pt",
            )
            pixel_values = inputs["pixel_values"].to(_vitpose_device)
            dataset_index = torch.zeros(
                len(boxes_list), dtype=torch.long, device=_vitpose_device,
            )

            with torch.no_grad(), _vitpose_lock:
                outputs = _vitpose_model(
                    pixel_values=pixel_values, dataset_index=dataset_index,
                )

            h, w = frame.shape[:2]
            now = time.time()
            for i, person in enumerate(_vitpose_processor.post_process_pose_estimation(
                outputs, boxes=[boxes_list],
            )[0]):
                if i >= len(ids):
                    continue   # no identity for this box; caching it under a
                               # made-up ID would hand these keypoints to an
                               # unrelated person later
                track_id = int(ids[i])
                if track_id < 0:
                    continue   # untracked detection: the ID is positional, so
                               # it would point at a different person next
                               # frame — see the ID fallback in run_pose_detection()
                kps_xy  = person["keypoints"].cpu().float().numpy()   # (17, 2) pixels
                kps_sc  = person["scores"].cpu().float().numpy()      # (17,)
                kps_xyn = kps_xy / np.array([w, h], dtype=np.float32)
                # Box is kept so the merge site can check this result still
                # describes the person currently holding the track ID.
                _vitpose_cache[track_id] = (
                    now, kps_xyn, kps_sc, np.asarray(boxes_list[i], dtype=np.float32),
                )

            # tracked IDs only ever grow over a long-running session, so
            # entries for people no longer around must be evicted here or
            # the dict grows unbounded
            stale_ids = [tid for tid, (ts, *_) in _vitpose_cache.items() if now - ts >= _VITPOSE_CACHE_TTL]
            for tid in stale_ids:
                del _vitpose_cache[tid]
        except Exception as _e:
            log.warning("ViTPose++ worker error: %s", _e)


if _vitpose_model is not None:
    threading.Thread(target=_vitpose_worker, daemon=True).start()
    log.info("ViTPose++ background worker started")

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


# ---------------------------------------------------------------------------
# Per-character detection mode — lets the frontend tell the backend which
# models the currently selected GIF character actually needs, so idle
# models don't burn GPU/CPU computing data nobody's reading.
#   'pose'  -> owl/bat/globe (YOLO + ViTPose only; they never read hands)
#   'hands' -> drone (MediaPipe Hands only; drone's update() ignores pose)
#   'none'  -> laptop (a fixed-position fade prop; reads neither)
#   'both'  -> default until the frontend checks in, or an unrecognised mode
# Set via POST /detection_mode {"mode": "..."} — see detection_mode_handler.
# ---------------------------------------------------------------------------
_detection_mode: str = 'both'

# QR code detection, for QR mode (a guest holds a printed/on-screen QR code
# up to the camera and the frontend shows a matching animation — see
# QR_DRONE_PAYLOAD in Display.tsx). Two interchangeable backends: pyzbar is
# noticeably more tolerant of small, angled, or partially-blurred codes than
# OpenCV's built-in detector, but needs the zbar DLL on Windows, which isn't
# always present — degrade to OpenCV (always available, ships with
# opencv-python) rather than crash if it's missing.
_qr_detector = cv2.QRCodeDetector()
_QR_DOWNSCALE_WIDTH = 1280  # more pixels per QR module = more reliable decode at a distance, at some CPU cost

_pyzbar_decode = None
_pyzbar_symbol = None
try:
    from pyzbar.pyzbar import ZBarSymbol as _ZBarSymbol, decode as _pyzbar_decode_fn
    _pyzbar_decode = _pyzbar_decode_fn
    _pyzbar_symbol = _ZBarSymbol
    log.info("pyzbar available — using it for QR detection (more tolerant of small/angled codes)")
except Exception as _e:
    log.info("pyzbar unavailable, falling back to OpenCV's QR detector: %s", _e)


def _decode_qr_pyzbar(working: np.ndarray) -> list:
    """[(payload, cx, cy), ...] — cx/cy normalised 0-1. Uses each symbol's
    actual polygon (the real corner points, which are non-rectangular for a
    skewed/angled code) rather than its axis-aligned bounding rect, falling
    back to reconstructing a rect only if pyzbar didn't return 4 points."""
    h, w = working.shape[:2]
    gray = cv2.cvtColor(working, cv2.COLOR_BGR2GRAY)
    out = []
    try:
        symbols = _pyzbar_decode(gray, symbols=[_pyzbar_symbol.QRCODE])
    except Exception:
        # pyzbar/zbar can throw on degenerate input, same as OpenCV's
        # detector below — treat it as "no codes this frame", not a crash.
        return []
    for symbol in symbols:
        try:
            text = symbol.data.decode('utf-8', errors='replace').strip()
        except Exception:
            continue
        if not text:
            continue
        polygon = symbol.polygon
        if len(polygon) >= 4:
            xs = [p.x for p in polygon]
            ys = [p.y for p in polygon]
            cx = (sum(xs) / len(xs)) / w
            cy = (sum(ys) / len(ys)) / h
        else:
            rect = symbol.rect
            cx = (rect.left + rect.width / 2) / w
            cy = (rect.top + rect.height / 2) / h
        out.append((text, cx, cy))
    return out


def _decode_qr_opencv(working: np.ndarray) -> list:
    """[(payload, cx, cy), ...] — cx/cy normalised 0-1."""
    h, w = working.shape[:2]
    try:
        ok, payloads, points, _ = _qr_detector.detectAndDecodeMulti(working)
    except cv2.error:
        # OpenCV's detector occasionally throws on degenerate frames.
        return []
    if not ok or payloads is None or points is None:
        return []
    out = []
    for text_raw, quad in zip(payloads, points):
        # A code can be located but not decodable (empty payload) — normal
        # at distance or a steep angle, just skip it rather than error.
        text = (text_raw or '').strip()
        if not text:
            continue
        cx = float(quad[:, 0].mean()) / w
        cy = float(quad[:, 1].mean()) / h
        out.append((text, cx, cy))
    return out

# Raw per-frame decodes are noisy — a code drops out for a frame or two the
# moment it tilts, blurs, or is briefly occluded (e.g. by a hand), which
# without smoothing flickers the overlay on/off on the frontend. Track each
# payload's last-seen time (and position) and keep reporting it as "visible"
# for a short grace window after its last successful decode, same idea as a
# track TTL. Position lets the frontend figure out *who* is holding a given
# code (by proximity to a tracked person's hand) rather than just that some
# code is visible somewhere in frame.
_qr_last_seen: dict = {}  # payload -> (timestamp, cx, cy) — cx/cy normalised 0-1
_QR_TRACK_TTL = 0.8  # seconds a code stays "visible" after its last successful decode

# Diagnostic counters — /qr_debug reports these so we can tell "detection is
# running but finding nothing" apart from "detection never even runs".
_qr_attempt_count = 0
_qr_last_attempt_ts: float = 0.0
_qr_last_frame_shape: tuple = ()


def _decode_qr_codes(frame: np.ndarray) -> list:
    """Every QR code visible in the frame, or seen within the last
    _QR_TRACK_TTL seconds — absorbs brief decode dropouts instead of
    flickering the overlay off every time a single frame fails to decode.
    Returns [{"payload": str, "x": float, "y": float}, ...], position being
    the code's center in normalised (0-1) frame coordinates."""
    global _qr_attempt_count, _qr_last_attempt_ts, _qr_last_frame_shape
    _qr_attempt_count += 1
    _qr_last_attempt_ts = time.time()
    _qr_last_frame_shape = frame.shape

    height, width = frame.shape[:2]
    working = frame
    if width > _QR_DOWNSCALE_WIDTH:
        # Decoding a smaller image is cheaper, and detection runs on every
        # processed frame — that cost matters more than the (negligible)
        # accuracy loss from downscaling something as high-contrast as a QR
        # code. _decode_qr_pyzbar/_decode_qr_opencv report each code's
        # center as a fraction (0-1) of *this* (downscaled) frame's own
        # dimensions, which is exactly equivalent to detecting on the small
        # copy, multiplying the corner points back up by the scale factor,
        # then dividing by the original full-resolution dimensions — just
        # without the intermediate pixel-space step, since the resize below
        # preserves aspect ratio uniformly (same factor on both axes).
        # Downstream code (Display.tsx) always works with these normalised
        # fractions, so it never needs to know downscaling happened at all.
        scale = _QR_DOWNSCALE_WIDTH / float(width)
        working = cv2.resize(
            frame, (_QR_DOWNSCALE_WIDTH, max(1, int(round(height * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    decoded = _decode_qr_pyzbar(working) if _pyzbar_decode is not None else _decode_qr_opencv(working)

    now = time.time()
    for text, cx, cy in decoded:
        _qr_last_seen[text] = (now, cx, cy)

    stale = [text for text, (ts, *_r) in _qr_last_seen.items() if now - ts >= _QR_TRACK_TTL]
    for text in stale:
        del _qr_last_seen[text]

    return [
        {"payload": text, "x": cx, "y": cy}
        for text, (_ts, cx, cy) in _qr_last_seen.items()
    ]


def run_pose_detection(frame: np.ndarray, qr_frame: np.ndarray = None) -> dict:
    """Detect poses/hands on a BGR frame, gated by _detection_mode.

    `frame` must be a *consistent* size across calls — YOLO's BoT-SORT
    tracker keeps internal state (including a previous-frame pyramid for its
    GMC/optical-flow motion compensation) between calls, and feeding it a
    differently-sized frame breaks that comparison (OpenCV assertion error,
    "GMC failed, falling back to identity", repeating on every subsequent
    call since it never gets a matching pair of frames to recover with).
    QR decoding wants much higher resolution than pose/hand keypoints need,
    so it takes its own separately-sized `qr_frame` (defaults to `frame`)
    instead of sharing YOLO's input.

    YOLO26-Pose runs synchronously for fast tracking + bounding boxes.
    ViTPose++ runs in a background worker thread; its cached keypoints are
    merged in when fresh (< 2 s old) — otherwise YOLO keypoints are used.
    The function always returns at YOLO speed regardless of ViTPose++ load.
    """
    mode = _detection_mode
    poses: list = []

    # QR mode also needs pose (specifically the nose keypoint) for the
    # sticky drone lock-on — once a guest shows the QR code, the drone
    # locks onto their face/head and keeps following it, so pose detection
    # has to keep running even after the code itself is put away.
    if mode in ('pose', 'both', 'qr'):
        with _yolo_lock:
            results = _yolo.track(
                frame,
                persist=True,
                verbose=False,
                conf=0.4,
                iou=0.45,
                imgsz=640,
                tracker=_TRACKER_CFG,
            )

        r = results[0] if results else None
        if r is not None and r.keypoints is not None and len(r.keypoints) > 0:
            kps_xyn  = r.keypoints.xyn.cpu().numpy()     # (N, 17, 2) normalised
            kps_conf = (r.keypoints.conf.cpu().numpy()
                        if r.keypoints.conf is not None else None)
            boxes_xyxy = r.boxes.xyxy.cpu().numpy()
            if r.boxes.id is not None:
                ids = r.boxes.id.cpu().numpy().astype(int).tolist()
            else:
                # No tracker IDs this frame: detections exist but the tracker
                # hasn't confirmed them, which gets more frequent the more
                # people are in shot. Positional 0,1,2… would collide with real
                # track IDs and hand one person's identity — and their cached
                # ViTPose keypoints — to whoever sits at that index, which is
                # the "face jumps to the wrong person" bug. Negative IDs can
                # never collide with real ones.
                ids = [-(i + 1) for i in range(len(kps_xyn))]

            # Single-target: keep only highest-confidence detection
            if not _multi_target and len(kps_xyn) > 1:
                box_conf = (r.boxes.conf.cpu().numpy() if r.boxes.conf is not None
                            else np.ones(len(kps_xyn)))
                best     = int(np.argmax(box_conf))
                kps_xyn  = kps_xyn[best:best + 1]
                kps_conf = kps_conf[best:best + 1] if kps_conf is not None else None
                ids      = [ids[best]]
                boxes_xyxy = boxes_xyxy[best:best + 1]

            # Submit frame to ViTPose++ worker (non-blocking: drops if busy)
            if _vitpose_model is not None:
                try:
                    _vitpose_queue.put_nowait((frame.copy(), boxes_xyxy.copy(), ids[:]))
                except queue.Full:
                    pass  # worker still processing previous frame — skip, no latency added

            # Build pose list — merge ViTPose++ cached keypoints when fresh
            now = time.time()
            for i in range(len(kps_xyn)):
                track_id = int(ids[i])
                cached   = _vitpose_cache.get(track_id)
                # The worker runs at least a frame behind, so a cached entry may
                # belong to whoever held this track ID earlier. Only trust it if
                # the box it came from still lines up with this person's box now
                # — otherwise fall back to YOLO's own keypoints.
                if (cached and (now - cached[0]) < _VITPOSE_CACHE_TTL
                        and i < len(boxes_xyxy)
                        and _box_iou(cached[3], boxes_xyxy[i]) >= _VITPOSE_MIN_IOU):
                    x, y, scores = _to_mp33(cached[1], cached[2])   # ViTPose++ keypoints
                else:
                    conf_row = kps_conf[i] if kps_conf is not None else None
                    x, y, scores = _to_mp33(kps_xyn[i], conf_row)  # YOLO keypoints
                poses.append({
                    "x": x, "y": y, "z": [0.0] * 33,
                    "scores": scores,
                    "track": {"id": track_id},
                })

    hands: list = []
    if mode in ('hands', 'both'):
        hands = run_hand_detection(frame)

    qr_codes = _decode_qr_codes(qr_frame if qr_frame is not None else frame) if mode == 'qr' else []

    return {"poses": poses, "hands": hands, "qr_codes": qr_codes}

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
        # Without an explicit output rate, skipping proper stream analysis
        # (-analyzeduration 0 -probesize 32, needed for low latency) makes
        # ffmpeg misjudge source frame timing and emit frames at ~2x the
        # camera's actual rate (measured: 25fps source -> 50fps output).
        # That doubles the frontend's JPEG-decode/render load for no reason
        # and was a real, measured contributor to stuttering. Pin output to
        # the camera's configured rate so ffmpeg can't over-emit.
        '-r', '25',
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
        proc = None
        buf = bytearray()
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )

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
            if proc is not None:
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

            # Sampling rate is mode-aware: YOLO+ViTPose (~31ms/call) needs the
            # every-3rd-frame throttle to stay cheap, but MediaPipe Hands
            # alone (~8ms/call) can easily keep up with every frame — running
            # it at the same slow rate as the expensive pipeline was adding
            # unnecessary detection latency for hand-only characters (drone).
            mode = _detection_mode
            should_infer = frame is not None and (
                mode == 'hands' or (mode in ('pose', 'both', 'qr') and frame_count % 3 == 0)
            )
            if should_infer:
                global _rtsp_pose_busy
                # YOLO always gets a fixed 320x240 frame regardless of mode —
                # its tracker keeps state between calls and breaks (repeating
                # "GMC failed" errors) if the frame size changes call to
                # call. QR codes need much more pixel density than that to
                # decode, so QR mode passes the full-resolution frame
                # separately, only for QR decoding — never into YOLO.
                small = cv2.resize(frame, (320, 240))
                qr_frame = frame if mode == 'qr' else None
                if not _rtsp_pose_busy:
                    _rtsp_pose_busy = True
                    def _rtsp_infer(f, qf):
                        global _rtsp_pose_busy
                        try:
                            asyncio.run_coroutine_threadsafe(
                                broadcast("/pose_out", run_pose_detection(f, qf)),
                                _loop,
                            ).result()
                        finally:
                            _rtsp_pose_busy = False
                    threading.Thread(target=_rtsp_infer, args=(small, qr_frame), daemon=True).start()
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
}


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == 'OPTIONS':
        return web.Response(headers=_CORS)
    response = await handler(request)
    response.headers.update(_CORS)
    return response


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


def _write_photo_files(
    b64img: str, directory: str, share_url: str, pic_timestamp: int, strip_photos: list,
) -> str:
    """Blocking disk I/O for save_photo_handler, run off the event loop thread
    so a photo save doesn't stall every other in-flight request/WS message."""
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

    # Save sidecar metadata (Cloudinary URL, original timestamp)
    meta_path = filepath + '.json'
    with open(meta_path, 'w') as f:
        json.dump({'url': share_url, 'timestamp': pic_timestamp}, f)

    # Save raw strip photos separately (large; only needed for recoloring)
    if strip_photos:
        strips_path = filepath + '.strips.json'
        with open(strips_path, 'w') as f:
            json.dump({'stripPhotos': strip_photos}, f)

    return filepath


async def save_photo_handler(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        b64img: str = data.get('image', '')
        directory: str = data.get('directory', './photos').strip()
        share_url: str = data.get('url', '')
        pic_timestamp: int = data.get('timestamp', 0)
        strip_photos: list = data.get('stripPhotos', [])

        if not b64img:
            return web.Response(status=400, text='Missing image', headers=_CORS)

        filepath = await asyncio.to_thread(
            _write_photo_files, b64img, directory, share_url, pic_timestamp, strip_photos,
        )

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

# GOP of 1 (every frame a keyframe) minimises latency but is extremely
# bitrate-hungry — on cameras with a hard bitrate ceiling (many Hikvision
# models cap at 8192 kbps regardless of settings) it starves every frame's
# compression budget and produces visibly grainy/blocky video. GOP=10 (a
# keyframe every 0.4s at 25fps) leans on cheap delta frames instead, freeing
# up bitrate for real quality, while still refreshing far more often than
# the camera's ~1s factory default — a deliberate latency/quality balance,
# not the previous all-keyframe extreme.
_GOP_LENGTH = '10'


def _configure_camera_sync(
    ip: str, user: str, password: str, stream: int, use_mjpeg: bool,
):
    """Set a Hikvision camera channel to low-latency encoding via ISAPI.

    stream=1 → channel 101 (main), stream=2 → channel 102 (sub).

    Uses `requests`' digest auth rather than urllib's HTTPDigestAuthHandler —
    urllib's implementation fails outright (401 on the very first GET)
    against this camera's digest challenge, while `requests` and
    `curl --digest` handle the exact same credentials fine.

    Also registers the camera's XML namespace with an empty prefix before
    re-serializing — ElementTree defaults to an auto-generated `ns0:` prefix
    on every tag, which Hikvision's ISAPI parser silently ignores (naive tag
    matching, not real namespace-aware parsing), so the PUT would return 200
    OK while quietly not changing anything unless the output matches the
    camera's own unprefixed style.
    """
    channel_id = f'10{stream}'
    base_url = f'http://{ip}'
    api_url = f'{base_url}/ISAPI/Streaming/channels/{channel_id}'
    auth = requests.auth.HTTPDigestAuth(user, password)

    resp = requests.get(api_url, auth=auth, timeout=10)
    resp.raise_for_status()
    ET.register_namespace('', 'http://www.hikvision.com/ver20/XMLSchema')
    root = ET.fromstring(resp.content)

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
        set_text('GovLength', _GOP_LENGTH)

    xml_bytes = ET.tostring(root, encoding='unicode').encode('utf-8')
    put_resp = requests.put(
        api_url, data=xml_bytes, auth=auth, timeout=10,
        headers={'Content-Type': 'application/xml'},
    )
    put_resp.raise_for_status()


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
        mode = 'MJPEG' if use_mjpeg else f'H.264 Baseline (GOP={_GOP_LENGTH})'
        msg = f'Camera {ip} channel 10{stream} set to {mode}'
        log.info(msg)
        return web.Response(text=msg, headers=_CORS)
    except Exception as e:
        log.error(f"Camera configure error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


async def detection_mode_handler(request: web.Request) -> web.Response:
    """POST: frontend calls this whenever the selected GIF character changes,
    so the backend only runs the model(s) that character actually needs.
    GET: diagnostic — check what mode is currently active without guessing."""
    global _detection_mode
    if request.method == 'GET':
        return web.json_response({'mode': _detection_mode}, headers=_CORS)
    try:
        data = await request.json()
        mode = data.get('mode', 'both')
        if mode not in ('pose', 'hands', 'none', 'both', 'qr'):
            return web.Response(status=400, text='Invalid mode', headers=_CORS)
        _detection_mode = mode
        log.info(f"Detection mode set to: {mode}")
        return web.Response(text='ok', headers=_CORS)
    except Exception as e:
        log.error(f"Detection mode error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


async def qr_debug_handler(request: web.Request) -> web.Response:
    """Diagnostic: what QR codes the backend currently thinks are visible
    (within the TTL grace window), plus which decode backend is active.
    GET /qr_debug — no auth, dev-only convenience for troubleshooting."""
    return web.json_response({
        'detection_mode': _detection_mode,
        'backend': 'pyzbar' if _pyzbar_decode is not None else 'opencv',
        'attempts': _qr_attempt_count,
        'last_attempt_age_seconds': (
            round(time.time() - _qr_last_attempt_ts, 2) if _qr_last_attempt_ts else None
        ),
        'last_frame_shape': list(_qr_last_frame_shape) if _qr_last_frame_shape else None,
        'seen': [
            {'payload': text, 'age_seconds': round(time.time() - ts, 2), 'x': cx, 'y': cy}
            for text, (ts, cx, cy) in _qr_last_seen.items()
        ],
    }, headers=_CORS)


async def gallery_client_handler(request: web.Request) -> web.Response:
    html_path = pathlib.Path(__file__).parent / 'gallery.html'
    return web.FileResponse(html_path)


async def list_photos_handler(request: web.Request) -> web.Response:
    photos_dir = pathlib.Path('./photos')
    if not photos_dir.exists():
        return web.json_response([], headers=_CORS)
    files = sorted(
        (f for f in photos_dir.iterdir() if f.is_file() and f.suffix != '.json'),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    result = []
    for f in files:
        meta_path = pathlib.Path(str(f) + '.json')
        url, pic_ts = '', 0
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                url = meta.get('url', '')
                pic_ts = meta.get('timestamp', 0)
            except Exception:
                pass
        result.append({'filename': f.name, 'mtime': f.stat().st_mtime, 'url': url, 'timestamp': pic_ts})
    return web.json_response(result, headers=_CORS)


async def serve_photo_handler(request: web.Request) -> web.Response:
    filename = request.match_info['filename']
    filepath = pathlib.Path('./photos') / filename
    if not filepath.exists() or not filepath.is_file():
        return web.Response(status=404, headers=_CORS)
    return web.FileResponse(filepath, headers={**_CORS, 'Content-Disposition': f'inline; filename="{filename}"'})


async def delete_photo_handler(request: web.Request) -> web.Response:
    filename = request.match_info['filename']
    filepath = pathlib.Path('./photos') / filename
    if not filepath.exists() or not filepath.is_file():
        return web.Response(status=404, headers=_CORS)
    filepath.unlink()
    meta_path = pathlib.Path(str(filepath) + '.json')
    if meta_path.exists():
        meta_path.unlink()
    strips_path = pathlib.Path(str(filepath) + '.strips.json')
    if strips_path.exists():
        strips_path.unlink()
    return web.Response(text='deleted', headers=_CORS)


async def fetch_strips_handler(request: web.Request) -> web.Response:
    filename = request.match_info['filename']
    filepath = pathlib.Path('./photos') / filename
    strips_path = pathlib.Path(str(filepath) + '.strips.json')
    if not strips_path.exists():
        return web.json_response({'stripPhotos': []}, headers=_CORS)
    try:
        return web.json_response(json.loads(strips_path.read_text()), headers=_CORS)
    except Exception as e:
        return web.Response(status=500, text=str(e), headers=_CORS)


async def replace_photo_handler(request: web.Request) -> web.Response:
    filename = request.match_info['filename']
    filepath = pathlib.Path('./photos') / filename
    if not filepath.exists() or not filepath.is_file():
        return web.Response(status=404, headers=_CORS)
    try:
        data = await request.json()
        b64img: str = data.get('image', '')
        if not b64img:
            return web.Response(status=400, text='Missing image', headers=_CORS)
        if ',' in b64img:
            _, b64data = b64img.split(',', 1)
        else:
            b64data = b64img
        filepath.write_bytes(base64.b64decode(b64data))
        log.info(f"Photo replaced: {filepath}")
        return web.json_response({'ok': True}, headers=_CORS)
    except Exception as e:
        log.error(f"Replace photo error: {e}")
        return web.Response(status=500, text=str(e), headers=_CORS)


def make_http_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware], client_max_size=50 * 1024 * 1024)
    app.router.add_get('/ws_stream', ws_stream_handler)
    app.router.add_get('/stream', stream_handler)
    app.router.add_post('/stream/stop', stop_stream_handler)
    app.router.add_post('/save', save_photo_handler)
    app.router.add_get('/browse', browse_handler)
    app.router.add_route('*', '/camera/configure', configure_camera_handler)
    app.router.add_route('*', '/detection_mode', detection_mode_handler)
    app.router.add_get('/qr_debug', qr_debug_handler)
    app.router.add_get('/photos', list_photos_handler)
    app.router.add_get('/photos/{filename}', serve_photo_handler)
    app.router.add_put('/photos/{filename}', replace_photo_handler)
    app.router.add_delete('/photos/{filename}', delete_photo_handler)
    app.router.add_get('/photos/{filename}/strips', fetch_strips_handler)
    app.router.add_get('/gallery', gallery_client_handler)
    return app

# ---------------------------------------------------------------------------
# Entry point — run WebSocket (9091) and HTTP (8081) servers concurrently
# ---------------------------------------------------------------------------

async def _rtsp_keepfresh_loop(interval_s: int = 300):
    """Periodically force-reconnect to the RTSP camera.

    Hikvision cameras (and many H.264 IP cameras) accumulate latency over
    time because H.264 GOP buffering causes the encode pipeline to drift
    further and further from real-time.  Reconnecting forces the camera to
    start a fresh stream from the current frame, resetting the delay.
    The browser WebSocket stays open; clients see only a brief (~1 s) gap.

    Was 45s originally, written when the camera ran a long GOP (infrequent
    keyframes) — that gave drift a lot of room to accumulate between
    resets. Since the camera is now configured for a much shorter GOP
    (keyframe every ~0.4s, see _configure_camera_sync), there's far less
    drift to accumulate in the first place, so the periodic ~1s visible
    stutter this causes no longer needs to happen anywhere near as often.
    5 minutes keeps it as a safety net for long event sessions without the
    hiccup being noticeable every 30-60s.
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
