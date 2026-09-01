"""Download the WiLoR model weights into backend/wilor_models/.

Run once per machine:

    python backend/fetch_wilor.py

The weights are ~2.5 GB and deliberately NOT committed. Git stores every
version of every file forever and cannot delta-compress dense binaries, so a
committed checkpoint would be paid for by every clone and every CI checkout
permanently — and could only be removed later by rewriting history. The source
tree is vendored (backend/wilor_src, 714 KB) because it is small and changes
with the code; the weights are fetched because they are large and static.

Already-present files are skipped, so this is safe to re-run and does NOT
download on every start. Once fetched, the files persist like any other file
on disk.

WHERE THE WEIGHTS COME FROM
---------------------------
Primary is the author's own HuggingFace Space (rolpotamias/WiLoR). A
third-party mirror is kept as a fallback: the original evaluation used it, but
a mirror is more likely to disappear than the author's own copy, so it is no
longer the default.

If both sources ever go away, the checkpoint is unrecoverable from the
internet. It is worth keeping an archived copy on company storage — that, not
git, is the real insurance against upstream disappearing.
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, 'wilor_models')

# (filename, primary url, fallback url, approx size for the progress line)
FILES = [
    (
        'wilor_final.ckpt',
        'https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models/wilor_final.ckpt',
        'https://huggingface.co/warmshao/WiLoR-mini/resolve/main/pretrained_models/wilor_final.ckpt',
        2.5e9,
    ),
    (
        'detector.pt',
        'https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models/detector.pt',
        'https://huggingface.co/warmshao/WiLoR-mini/resolve/main/pretrained_models/detector.pt',
        5.2e7,
    ),
]

# A partial download left behind by a cancelled run would otherwise look like a
# valid file on the next run, so anything below this is treated as incomplete.
MIN_PLAUSIBLE_BYTES = 1_000_000


def _progress(done, total):
    if not total:
        sys.stdout.write('\r  %.0f MB' % (done / 1e6))
    else:
        pct = 100.0 * done / total
        bar = int(pct / 2.5)
        sys.stdout.write('\r  [%s%s] %5.1f%%  %.0f/%.0f MB'
                         % ('#' * bar, '.' * (40 - bar), pct, done / 1e6, total / 1e6))
    sys.stdout.flush()


def download(url, path):
    """Download to a .part file, then rename — so an interrupted run never
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
    for name, primary, fallback, approx in FILES:
        path = os.path.join(DEST, name)
        if os.path.isfile(path) and os.path.getsize(path) >= MIN_PLAUSIBLE_BYTES:
            print('%-20s already present (%.0f MB) - skipping'
                  % (name, os.path.getsize(path) / 1e6))
            continue

        got = False
        for label, url in (('official', primary), ('mirror', fallback)):
            print('%-20s downloading ~%.0f MB from %s' % (name, approx / 1e6, label))
            try:
                download(url, path)
                got = True
                break
            except Exception as e:
                print('  %s source failed: %s: %s' % (label, type(e).__name__, e))
                if os.path.exists(path + '.part'):
                    os.remove(path + '.part')
        if not got:
            print('  COULD NOT FETCH %s from either source' % name)
            ok = False

    print()
    if ok:
        print('Done. Start the app normally:  python main.py')
    else:
        print('Some files are missing - the backend will refuse to start.')
        print('If both sources are unreachable, restore from an archived copy.')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
