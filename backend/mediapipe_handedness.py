"""MediaPipe Hands — used for ONE thing: which hand is left and which is right.

WiLoR does the hand geometry, and does it well: wrist orientation holds to
under 2 degrees on a held fist, and finger curl separates a fist from a flat
hand cleanly. What it cannot do is tell left from right.

The reason is structural, not a tuning problem. WiLoR reconstructs a single
hand shape, and handles both hands by MIRRORING left-hand crops before the
network sees them (wilor_src/wilor/datasets/vitdet_dataset.py: `flip = right
== 0`). So the network only ever reconstructs a right hand, and the entire
left/right decision rests on a small YOLO classifier applied to the crop
beforehand. Observed in this booth, that classifier reported three hands in one
frame - across two people - as all "Left", and flips frame to frame on a hand
that is not moving. Because the flip has already happened by then, nothing
downstream can detect or undo the error.

MediaPipe's hand model predicts handedness directly, with a confidence score,
and does not normalise it away. Measured on THIS camera earlier in the
project's history:

    handedness correct   50.5%  on a 320x240 frame squashed from 16:9
                         91.6%  on an aspect-correct 960-wide frame

The 50.5% is why MediaPipe was dropped for hand geometry, but that figure was
an artefact of the squashed input, not the model. WiLoR already receives
exactly the aspect-correct 960-wide frame that produced 91.6%, so this reads
the same frame WiLoR does.

Runs on CPU, so it never competes with WiLoR, YOLO or ViTPose for the GPU, and
is loaded on demand alongside WiLoR.

It also supplies the hand's POSITION and DIRECTION, which turned out to be the
bigger win. WiLoR's 21 landmarks are all the detector box's centre - the MANO
layer that would give joint positions is stubbed out - and a box centre is not
anchored to anatomy: an axis-aligned box changes shape as a hand rotates, so
its centre slides across the hand even when the hand is still. MediaPipe's real
wrist and knuckle landmarks do not, and the inference has already happened.
"""
import atexit
import logging
import os
import threading
import urllib.request

# Quieten MediaPipe's native logging BEFORE the package is imported anywhere.
# Its C++ layer logs through glog/absl, which does not go through Python's
# logging module and so cannot be filtered by the handlers set up in main.py.
# Left alone it prints a warning on every detect call:
#
#   W0000 landmark_projection_calculator.cc:81] Using NORM_RECT without
#   IMAGE_DIMENSIONS is only supported for the square ROI...
#
# which is harmless - it concerns an ROI projection path this use does not
# depend on - but at frame rate it buries everything else in the terminal.
# 2 = errors only; real failures still surface.
os.environ.setdefault('GLOG_minloglevel', '2')
os.environ.setdefault('ABSL_MIN_LOG_LEVEL', '2')

import numpy as np

log = logging.getLogger('mp_hands')

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODEL_DIR = os.environ.get('MEDIAPIPE_HANDS_DIR', os.path.join(_HERE, 'mediapipe_models'))
_MODEL_PATH = os.path.join(_MODEL_DIR, 'hand_landmarker.task')
_MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/'
    'hand_landmarker/float16/1/hand_landmarker.task'
)

# Below this, MediaPipe's own confidence in the left/right call is too low to
# override WiLoR with - the point is to replace an unreliable answer, not to
# swap it for a differently unreliable one.
MIN_HANDEDNESS_SCORE = float(os.environ.get('MP_HANDEDNESS_MIN_SCORE', '0.75'))

# How many hands to look for. Matches WILOR_MAX_HANDS so neither becomes the
# limiting factor on a busy frame.
MAX_HANDS = int(os.environ.get('MP_HANDEDNESS_MAX_HANDS', '8'))

# MediaPipe hand landmark indices.
WRIST = 0
KNUCKLES = (5, 9, 13, 17)   # index, middle, ring, pinky MCP joints

_landmarker = None
_detect_lock = threading.Lock()

_loading = False
_load_error = ''
_load_lock = threading.Lock()


def _download_model():
    if os.path.isfile(_MODEL_PATH):
        return
    os.makedirs(_MODEL_DIR, exist_ok=True)
    log.info("Downloading MediaPipe hand_landmarker.task (~7 MB)...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)


def _init() -> bool:
    global _landmarker
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions

    _download_model()
    options = vision.HandLandmarkerOptions(
        base_options=BaseOptions(
            model_asset_path=_MODEL_PATH,
            delegate=BaseOptions.Delegate.CPU,
        ),
        # IMAGE rather than VIDEO: this is called from WiLoR's worker thread on
        # whichever frame that happens to be processing, which is not a
        # monotonic stream. VIDEO mode requires strictly increasing timestamps
        # and throws when they go backwards.
        running_mode=vision.RunningMode.IMAGE,
        num_hands=MAX_HANDS,
    )
    _landmarker = vision.HandLandmarker.create_from_options(options)
    return True


def ensure_loading() -> None:
    """Start loading in the background if not already loaded or loading.

    Same contract as wilor_hands.ensure_loading: returns immediately, callers
    tolerate detect() returning [] until it finishes, and a failure is not
    retried."""
    global _loading, _load_error
    with _load_lock:
        if _landmarker is not None or _loading or _load_error:
            return
        _loading = True

    def _load():
        global _loading, _load_error
        try:
            _init()
            log.info("MediaPipe hand landmarker loaded (CPU)")
        except Exception as e:
            _load_error = '%s: %s' % (type(e).__name__, e)
            log.warning("MediaPipe handedness unavailable: %s", _load_error)
        finally:
            _loading = False

    threading.Thread(target=_load, daemon=True, name='mp-handedness-load').start()


def _close():
    """Release the landmarker before the interpreter tears its modules down.

    MediaPipe's HandLandmarker.__del__ calls back into its own modules, which
    are already None by the time the garbage collector runs at shutdown - so
    every exit printed an ignored TypeError traceback. Closing it here, while
    the interpreter is still intact, means that never happens.
    """
    global _landmarker
    # Under the detect lock: WiLoR's worker may be mid-inference when the
    # process is asked to exit, and closing the landmarker underneath it would
    # be a use-after-free in native code rather than a tidy Python error.
    with _detect_lock:
        lm, _landmarker = _landmarker, None
    if lm is not None:
        try:
            lm.close()
        except Exception:
            pass


atexit.register(_close)


def available() -> bool:
    return _landmarker is not None


def status() -> str:
    if _landmarker is not None:
        return 'ready'
    if _loading:
        return 'loading'
    if _load_error:
        return 'failed'
    return 'idle'


def detect(frame_rgb: np.ndarray) -> list:
    """Handedness for every hand MediaPipe finds in this frame.

    Returns [{'box': (x0, y0, x1, y1), 'is_right': bool, 'score': float}, ...]
    with box in pixels, so callers can match these against their own detections
    by overlap.

    The box is derived from the landmark extremes rather than reported
    directly - MediaPipe gives 21 landmarks and no bounding box - which is
    enough to match against WiLoR's detector boxes.
    """
    if _landmarker is None:
        return []
    import mediapipe as mp

    h, w = frame_rgb.shape[:2]
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
    with _detect_lock:
        result = _landmarker.detect(image)

    out = []
    for i, lms in enumerate(result.hand_landmarks):
        if i >= len(result.handedness):
            continue
        cat = result.handedness[i][0]
        xs = [lm.x * w for lm in lms]
        ys = [lm.y * h for lm in lms]

        # Real anatomy, which WiLoR cannot supply: its 21 "landmarks" are all
        # the detector box's centre, because the MANO layer that would produce
        # joint positions is stubbed out. A box centre is not anchored to
        # anything - rotate a fist and the axis-aligned box changes shape, so
        # its centre slides across the hand even when the hand has not moved.
        #
        # 0 is the wrist; 5/9/13/17 are the knuckles (index, middle, ring,
        # pinky). Averaging the knuckles gives a stable point in the middle of
        # the fist, and wrist-to-knuckles is a direct measurement of which way
        # the hand points.
        wrist = (xs[WRIST], ys[WRIST])
        kx = sum(xs[i2] for i2 in KNUCKLES) / len(KNUCKLES)
        ky = sum(ys[i2] for i2 in KNUCKLES) / len(KNUCKLES)

        out.append({
            'box': (min(xs), min(ys), max(xs), max(ys)),
            # MediaPipe labels handedness as seen in the IMAGE, which is the
            # raw camera frame here - the display mirroring happens later, in
            # the frontend. So 'Right' means the person's actual right hand.
            'is_right': cat.category_name == 'Right',
            'score': float(cat.score),
            'wrist': wrist,
            'knuckles': (kx, ky),
        })
    return out
