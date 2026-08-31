"""WiLoR hand detection — a drop-in replacement for the MediaPipe path.

WHY
---
MediaPipe's palm orientation was measured, on this camera, holding one pose
still for 20+ seconds:

    palm to sky    MediaPipe  97.6% sign-consistent, and INVERTED
                   WiLoR     100.0%
    palm to floor  MediaPipe  76.0% sign-consistent
                   WiLoR     100.0%

Two independent defects in the MediaPipe path explain that. Its handedness
classifier was close to a coin flip on an outstretched palm, and the palm
normal is negated on that label — so ~20% of frames came out inverted. And its
sign convention turned out to be backwards regardless. WiLoR sidesteps both:
handedness comes from its detector's own class rather than a separate
classifier, and orientation is a direct network output instead of a plane
fitted through six noisy landmarks.

The remaining difficulty MediaPipe could never solve is geometric: a flat open
palm viewed edge-on is the degenerate case for single-camera depth, where a
plane tilted +θ and -θ project almost identically. WiLoR's transformer resolves
it from learned priors rather than from the fitted geometry.

WHAT THIS DOES NOT PROVIDE
--------------------------
21 landmarks. Those come from MANO, which is licensed separately (non-
commercial research, registration required) and whose loader needs `chumpy` —
which cannot install on Python 3.11. None of that is needed for orientation,
so the MANO layer is stubbed out.

The frontend only uses landmarks 0/5/9/13/17, averaged, to find the palm
centre for placing the drone. Those indices are therefore filled from the
detector's bounding-box centre, which is what that average approximates
anyway. Every other index is filled with the same point. This keeps the wire
contract byte-compatible with the MediaPipe path, so no frontend change is
needed — but it does mean per-finger landmarks are NOT real here, and anything
added later that needs true finger positions would have to bring MANO in.

PERFORMANCE (RTX A5000, 960x540 input, measured)
------------------------------------------------
    detector        7.7 ms/frame   (once per frame)
    reconstruction 20.9 ms/hand    (fp16; 34.6 ms at fp32)
    total          31.6 ms         -> 31.7 fps with one hand

Reconstruction cost scales with the number of hands, unlike MediaPipe's fixed
cost — four hands in shot is roughly 92 ms/frame. WILOR_MAX_HANDS caps that.

fp16 was verified against fp32 over 204 hands: median difference 0.00008,
worst 0.00231, and zero sign disagreements. It is enabled by default because
it is a 1.5x speedup for no measurable accuracy cost.
"""
import logging
import os
import queue
import sys
import threading
import types

import numpy as np

log = logging.getLogger('wilor')

# Both live inside the project, so a copied project folder is self-contained
# and nothing depends on a path outside it.
#
# The source is vendored (714 KB) because it is small and moves with the code.
# The weights are fetched by fetch_wilor.py and gitignored because they are
# ~2.5 GB: git keeps every version forever and cannot delta-compress dense
# binaries, so committing them would be paid for by every clone permanently.
_HERE = os.path.dirname(os.path.abspath(__file__))
WILOR_DIR = os.environ.get('WILOR_DIR', os.path.join(_HERE, 'wilor_src'))
WILOR_CKPT_DIR = os.environ.get('WILOR_CKPT_DIR', os.path.join(_HERE, 'wilor_models'))

WILOR_FP16 = os.environ.get('WILOR_FP16', '1') != '0'
WILOR_DET_CONF = float(os.environ.get('WILOR_DET_CONF', '0.3'))
# Reconstruction is per-hand, so a crowd is what threatens the frame rate.
# Hands are kept in detector-confidence order, so the clearest ones survive.
WILOR_MAX_HANDS = int(os.environ.get('WILOR_MAX_HANDS', '4'))

# Threshold on the vertical component of the palm normal. Same convention as
# the MediaPipe path: negative is skyward. WiLoR's readings sit near +/-0.9 on
# a held pose rather than hovering near the line, so this is far less critical
# than it was before.
PALM_SKY_THRESHOLD = float(os.environ.get('PALM_SKY_THRESHOLD', '-0.4'))

_available = False
_model = None
_model_cfg = None
_detector = None
_device = 'cpu'

_queue: queue.Queue = queue.Queue(maxsize=1)
_cache: list = []


def _stub_unused_modules():
    """Block the rendering stack before WiLoR's package __init__ imports it.

    wilor/utils/__init__.py imports pyrender at module level for mesh
    visualisation. It needs an OpenGL context, is awkward on Windows, and we
    only ever want numbers. MagicMock rather than a bare namespace because
    WiLoR constructs pyrender.OffscreenRenderer(...) during __init__, so the
    stubs must be callable.
    """
    from unittest.mock import MagicMock
    for name in ('pyrender', 'trimesh'):
        if name in sys.modules:
            continue
        m = types.ModuleType(name)
        # inspect walks module attributes when building tracebacks and calls
        # .endswith() on __file__, so a real string is required here.
        m.__file__ = '<stub:%s>' % name
        m.__spec__ = None

        def _getattr(attr, _n=name):
            if attr.startswith('__') and attr.endswith('__'):
                raise AttributeError(attr)
            return MagicMock()

        m.__getattr__ = _getattr
        sys.modules[name] = m


def _stub_mano():
    """Replace the MANO layer with a shape-compatible no-op.

    WiLoR calls self.mano(...) unconditionally and stores .joints/.vertices on
    the result, and passes self.mano.faces to its (also stubbed) renderer — so
    the stub needs those attributes to exist. Nothing downstream reads them.
    """
    import torch
    import wilor.models.wilor as wmod

    class _MANOStub(torch.nn.Module):
        def __init__(self, *a, **kw):
            super().__init__()
            self.faces = np.zeros((1538, 3), dtype=np.int64)

        def forward(self, *a, **kw):
            go = kw.get('global_orient')
            n = go.shape[0] if go is not None else 1
            dev = go.device if go is not None else 'cpu'
            out = types.SimpleNamespace()
            out.joints = torch.zeros(n, 21, 3, device=dev)
            out.vertices = torch.zeros(n, 778, 3, device=dev)
            return out

    wmod.MANO = _MANOStub


def init() -> bool:
    """Load WiLoR. Returns False (and logs why) if anything is missing.

    main.py turns that into a hard SystemExit rather than continuing: there is
    no fallback model any more, and a silently degraded hand tracker mid-event
    is worse than a refusal to start."""
    global _available, _model, _model_cfg, _detector, _device
    if _available:
        return True

    import torch

    if not os.path.isdir(WILOR_DIR):
        log.warning("WiLoR source not found at %s — set WILOR_DIR", WILOR_DIR)
        return False
    ckpt = os.path.join(WILOR_CKPT_DIR, 'wilor_final.ckpt')
    det = os.path.join(WILOR_CKPT_DIR, 'detector.pt')
    for p in (ckpt, det):
        if not os.path.isfile(p):
            log.warning("WiLoR checkpoint missing: %s", p)
            log.warning("Fetch the weights with:  python backend/fetch_wilor.py")
            return False

    if WILOR_DIR not in sys.path:
        sys.path.insert(0, WILOR_DIR)

    cwd = os.getcwd()
    try:
        # WiLoR's config references './mano_data/mano_mean_params.npz' relative
        # to the working directory. (That file ships with the repo — it is mean
        # pose statistics, not the licensed MANO model.)
        os.chdir(WILOR_DIR)
        _stub_unused_modules()
        _stub_mano()

        from wilor.models import load_wilor
        _device = 'cuda' if torch.cuda.is_available() else 'cpu'
        _model, _model_cfg = load_wilor(
            checkpoint_path=ckpt,
            cfg_path=os.path.join(WILOR_DIR, 'pretrained_models', 'model_config.yaml'),
        )
        _model = _model.to(_device).eval()

        # torch 2.6 flipped torch.load's weights_only default to True; the
        # detector checkpoint stores a pickled model, which the strict loader
        # refuses. Relaxed for this one call — it is our own downloaded file.
        from ultralytics import YOLO
        _orig_load = torch.load

        def _permissive(*a, **kw):
            kw['weights_only'] = False
            return _orig_load(*a, **kw)

        torch.load = _permissive
        try:
            _detector = YOLO(det)
        finally:
            torch.load = _orig_load
    except Exception as e:
        log.warning("WiLoR unavailable: %s: %s", type(e).__name__, e)
        return False
    finally:
        os.chdir(cwd)

    _available = True
    log.info("WiLoR initialised on %s (fp16=%s, max_hands=%d)",
             _device, WILOR_FP16, WILOR_MAX_HANDS)
    threading.Thread(target=_worker, daemon=True).start()
    return True


def _palm_normal_y(R: np.ndarray, is_right: bool) -> float:
    """Vertical component of the palm normal: negative is skyward.

    The axis was determined empirically rather than assumed. Every candidate
    was tested against two known-opposite holds (palm to sky, palm to floor):
    only +/-y separated them — 1.813 of a possible 2.0, at 100% consistency on
    both — while z, the initial guess, gave 0.205 and the SAME sign for both
    poses, i.e. no discrimination at all. -y is chosen so skyward reads
    negative, matching the existing convention.

    The palm faces opposite ways on the two hands in the canonical frame, so
    the left hand is mirrored. Unlike the MediaPipe path, the handedness this
    depends on comes from the detector's own class, not a coin-flip classifier.
    """
    n = R @ np.array([0.0, -1.0, 0.0], dtype=np.float32)
    if not is_right:
        n = n * np.array([1.0, 1.0, -1.0], dtype=np.float32)
    n = n / (np.linalg.norm(n) + 1e-9)
    return float(n[1])


def _infer(frame: np.ndarray) -> list:
    import torch
    h, w = frame.shape[:2]
    rgb = frame[:, :, ::-1].copy()

    det = _detector(frame, conf=WILOR_DET_CONF, verbose=False)[0]
    boxes = det.boxes.xyxy.cpu().numpy()
    if len(boxes) == 0:
        return []
    classes = det.boxes.cls.cpu().numpy()
    confs = det.boxes.conf.cpu().numpy()

    if len(boxes) > WILOR_MAX_HANDS:
        keep = np.argsort(-confs)[:WILOR_MAX_HANDS]
        boxes, classes, confs = boxes[keep], classes[keep], confs[keep]

    from wilor.datasets.vitdet_dataset import ViTDetDataset
    ds = ViTDetDataset(_model_cfg, rgb, boxes, classes, rescale_factor=2.0)
    loader = torch.utils.data.DataLoader(ds, batch_size=8, shuffle=False)

    rots, rights = [], []
    for batch in loader:
        batch = {k: (v.to(_device) if isinstance(v, torch.Tensor) else v)
                 for k, v in batch.items()}
        with torch.no_grad():
            if WILOR_FP16 and _device == 'cuda':
                with torch.autocast('cuda', dtype=torch.float16):
                    out = _model(batch)
            else:
                out = _model(batch)
        R = out['pred_mano_params']['global_orient'].reshape(-1, 3, 3).float()
        rots.append(R.detach().cpu().numpy())
        rights.append(batch['right'].cpu().numpy().reshape(-1))
    rots = np.concatenate(rots, axis=0)
    rights = np.concatenate(rights, axis=0)

    hands = []
    for i in range(min(len(rots), len(boxes))):
        is_right = bool(rights[i] > 0.5)
        ny = _palm_normal_y(rots[i], is_right)

        # Palm centre from the bounding box, normalised. The frontend averages
        # landmarks 0/5/9/13/17 to get this same point, so every index is
        # filled with it — see the module docstring on why real per-finger
        # landmarks are not available without MANO.
        x0, y0, x1, y1 = boxes[i]
        cx = float((x0 + x1) / 2.0 / w)
        cy = float((y0 + y1) / 2.0 / h)

        hands.append({
            'x': [cx] * 21,
            'y': [cy] * 21,
            'z': [0.0] * 21,
            'label': 'Right' if is_right else 'Left',
            # palm_up is MediaPipe's older upright-hand signal, used by
            # ocfusion. WiLoR gives orientation directly, so it is derived
            # from the same normal: an upright palm facing the camera has a
            # near-horizontal normal, i.e. |ny| small.
            'palm_up': bool(abs(ny) < 0.35),
            'palm_sky': bool(ny < PALM_SKY_THRESHOLD),
            'palm_normal_y': ny,
            'conf': float(confs[i]) if i < len(confs) else 0.0,
        })
    return hands


def _worker():
    global _cache
    while True:
        try:
            frame = _queue.get(timeout=1.0)
        except queue.Empty:
            continue
        try:
            _cache = _infer(frame)
        except Exception as e:
            log.debug("WiLoR inference error: %s: %s", type(e).__name__, e)


def detect(frame: np.ndarray) -> list:
    """Submit a frame (non-blocking) and return the most recent result.

    Same contract as run_hand_detection's MediaPipe path: newest frame wins,
    stale frames are dropped rather than queued, so a slow model shows up as a
    lower update rate and never as a stalled video feed.
    """
    if not _available:
        return []
    try:
        _queue.put_nowait(frame.copy())
    except queue.Full:
        pass
    return _cache


def available() -> bool:
    return _available
