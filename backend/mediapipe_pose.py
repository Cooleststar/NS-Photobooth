"""MediaPipe Pose Landmarker — pose source for 67 Mode only.

Deliberately separate from the main YOLO26-pose + ViTPose++ pipeline in
main.py: 67 Mode is single-player (see repCounter.ts on the frontend) and
was asked to match the model the original reference project ("67 challenge")
uses, rather than sharing the booth's multi-person tracker/GPU pipeline.
Every other character keeps using YOLO/ViTPose exactly as before — this
module is never imported by that code path.

Loaded on demand (same idea as wilor_hands.py's ensure_loading): nobody
pays for it unless 67 Mode is actually turned on. The .task model file
(a few MB) is fetched once into mediapipe_models/ and reused after that,
mirroring wilor_models/'s treatment of the (much larger) WiLoR weights.

CPU delegate, not GPU: the Tasks API's Python GPU delegate is far less
mature than its browser/WebGL counterpart (patchy on Windows in
particular), and pose_landmarker_lite was specifically chosen — same as
the original project — to be cheap enough to run on CPU in the first
place. This also means 67 Mode never competes with YOLO/ViTPose/WiLoR for
GPU memory, which is the whole point of keeping it independent.
"""
import logging
import os
import threading
import time
import urllib.request

import cv2
import numpy as np

log = logging.getLogger('mediapipe_pose')

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODEL_DIR = os.environ.get('MEDIAPIPE_POSE_DIR', os.path.join(_HERE, 'mediapipe_models'))
_MODEL_PATH = os.path.join(_MODEL_DIR, 'pose_landmarker_lite.task')
_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
    'pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
)

_landmarker = None
_detect_lock = threading.Lock()
_last_ts_ms = 0

# Load state - see wilor_hands.py's identical pattern for why this exists
# (on-demand loading, idempotent, failure isn't retried).
_loading = False
_load_error = ''
_load_lock = threading.Lock()


def _download_model():
    if os.path.isfile(_MODEL_PATH):
        return
    os.makedirs(_MODEL_DIR, exist_ok=True)
    log.info("Downloading MediaPipe Pose Landmarker model (~a few MB)...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)


def _init() -> bool:
    global _landmarker
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    _download_model()

    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(
            model_asset_path=_MODEL_PATH,
            delegate=BaseOptions.Delegate.CPU,
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,  # 67 Mode is single-player - see repCounter.ts
    )
    _landmarker = vision.PoseLandmarker.create_from_options(options)
    return True


def ensure_loading() -> None:
    """Start loading in the background if not already loaded/loading.
    Returns immediately - detect() returns [] until the load finishes."""
    global _loading, _load_error
    with _load_lock:
        if _landmarker is not None or _loading or _load_error:
            return
        _loading = True

    def _load():
        global _loading, _load_error
        try:
            _init()
            log.info("MediaPipe Pose Landmarker loaded")
        except Exception as e:
            _load_error = '%s: %s' % (type(e).__name__, e)
            log.warning("MediaPipe Pose Landmarker load failed: %s", _load_error)
        finally:
            _loading = False

    threading.Thread(target=_load, daemon=True, name='mediapipe-pose-load').start()
    log.info("MediaPipe Pose Landmarker loading in background (67 Mode requested)")


def status() -> str:
    if _landmarker is not None:
        return 'ready'
    if _loading:
        return 'loading'
    if _load_error:
        return 'failed'
    return 'idle'


def detect(frame_bgr: np.ndarray) -> list:
    """Same output shape run_pose_detection() already builds for YOLO in
    main.py: [{"x": [...33], "y": [...33], "z": [...33], "scores": [...33],
    "track": {"id": 0}}, ...] - BlazePose/MediaPipe's landmark layout is
    already the 33-point format _to_mp33() converts YOLO's COCO-17 *into*,
    so no remapping is needed here. track.id is always 0: there is no
    tracker (num_poses=1, and 67 Mode never needs to distinguish people)."""
    global _last_ts_ms
    if _landmarker is None:
        return []

    import mediapipe as mp

    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    with _detect_lock:
        # detect_for_video requires strictly increasing timestamps; wall-clock
        # ms is monotonic in practice but two calls within the same
        # millisecond would violate that, hence the max() guard.
        ts_ms = max(int(time.time() * 1000), _last_ts_ms + 1)
        _last_ts_ms = ts_ms
        try:
            result = _landmarker.detect_for_video(image, ts_ms)
        except Exception as e:
            log.warning("MediaPipe Pose Landmarker detect failed: %s", e)
            return []

    if not result.pose_landmarks:
        return []

    landmarks = result.pose_landmarks[0]
    x = [lm.x for lm in landmarks]
    y = [lm.y for lm in landmarks]
    z = [lm.z for lm in landmarks]
    scores = [lm.visibility for lm in landmarks]
    return [{"x": x, "y": y, "z": z, "scores": scores, "track": {"id": 0}}]
