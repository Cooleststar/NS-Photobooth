"""Download the MediaPipe Tasks model files into backend/mediapipe_models/.

Run once per machine, alongside fetch_wilor.py:

    python backend/fetch_mediapipe.py

WHY THIS EXISTS
---------------
Both mediapipe modules already download their own .task file on first use
(see _download_model in each). That is fine on a developer machine and wrong
at an event: this booth runs OFFLINE, and the download happens lazily at the
moment the feature is first switched on, inside a BACKGROUND thread that only
records the failure (ensure_loading / _load_error). So with no connection the
first person to pick 67 Mode gets no skeleton at all, handedness silently
falls back to WiLoR's unreliable left/right label, and nothing anywhere says
why. Fetching ahead of time turns that into a problem you hit here, once,
with a progress bar.

It also unblocks the Docker build, which used to `COPY mediapipe_models` --
a directory .gitignore deliberately excludes, so it existed only on machines
that happened to have run the lazy download already. The image now runs this
script at build time instead.

SIZE, AND WHY THESE ARE NOT COMMITTED
-------------------------------------
~13 MB for both, which is small enough that committing them would be
defensible -- but .gitignore already made the call to treat them like
wilor_models/, and a fetch script keeps one rule for every model file rather
than two. Unlike the WiLoR checkpoint these are trivially replaceable: they
are Google's published models at version-pinned URLs (.../1/...), so the
bytes never change under you and there is no need for a fallback mirror or
an archived copy.

Already-present files are skipped, so this is safe to re-run.
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# Honours the same override the two modules read, so pointing them at a shared
# or read-only model directory does not silently fetch into a different one.
DEST = os.environ.get('MEDIAPIPE_POSE_DIR',
                      os.environ.get('MEDIAPIPE_HANDS_DIR',
                                     os.path.join(HERE, 'mediapipe_models')))

_BASE = 'https://storage.googleapis.com/mediapipe-models'

# (filename, url, approx size for the progress line, what breaks without it)
# The URLs must stay in step with _MODEL_URL in each module.
FILES = [
    (
        'pose_landmarker_lite.task',
        _BASE + '/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        5.8e6,
        '67 Mode (mediapipe_pose.py)',
    ),
    (
        'hand_landmarker.task',
        _BASE + '/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        7.5e6,
        'handedness (mediapipe_handedness.py)',
    ),
]

# A partial download left behind by a cancelled run would otherwise look like a
# valid file on the next run, so anything below this is treated as incomplete.
# Both files are several MB; the smallest plausible real one is ~5 MB.
MIN_PLAUSIBLE_BYTES = 1_000_000


def _progress(done, total):
    if not total:
        sys.stdout.write('\r  %.1f MB' % (done / 1e6))
    else:
        pct = 100.0 * done / total
        bar = int(pct / 2.5)
        sys.stdout.write('\r  [%s%s] %5.1f%%  %.1f/%.1f MB'
                         % ('#' * bar, '.' * (40 - bar), pct, done / 1e6, total / 1e6))
    sys.stdout.flush()


def download(url, path):
    """Download to a .part file, then rename - so an interrupted run never
    leaves something that looks complete."""
    tmp = path + '.part'
    req = urllib.request.Request(url, headers={'User-Agent': 'ns-photobooth'})
    with urllib.request.urlopen(req) as r, open(tmp, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            _progress(done, total)
    sys.stdout.write('\n')
    os.replace(tmp, path)
    return done


def main():
    os.makedirs(DEST, exist_ok=True)
    print('destination: %s\n' % DEST)

    ok = True
    for name, url, approx, used_by in FILES:
        path = os.path.join(DEST, name)
        if os.path.isfile(path) and os.path.getsize(path) >= MIN_PLAUSIBLE_BYTES:
            print('%-28s already present (%.1f MB) - skipping'
                  % (name, os.path.getsize(path) / 1e6))
            continue

        print('%-28s downloading ~%.1f MB  [%s]' % (name, approx / 1e6, used_by))
        try:
            download(url, path)
        except Exception as e:
            print('  FAILED: %s: %s' % (type(e).__name__, e))
            if os.path.exists(path + '.part'):
                os.remove(path + '.part')
            ok = False

    print()
    if ok:
        print('Done. Both models are on disk; nothing downloads at runtime.')
    else:
        print('Some files are missing. The backend still STARTS without them -')
        print('it would just fetch them lazily on first use, which fails with no')
        print('connection. Re-run this with internet before taking the booth out.')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
