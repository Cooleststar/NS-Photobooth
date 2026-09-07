"""Install the CUDA build of torch that this machine's driver supports.

    python backend/install_torch.py            # detect, confirm, install
    python backend/install_torch.py --yes      # no prompt
    python backend/install_torch.py --check    # report only, install nothing

WHY THIS EXISTS
---------------
requirements.txt pins torch's VERSION but not its wheel - it carries no index,
because the right CUDA build depends on the driver and no single index is
correct everywhere. That pin is satisfied by any local variant (2.6.0+cu124,
2.6.0+cu118, or PyPI's CPU 2.6.0), which is what makes one file work on every
machine. The gap it leaves is that a plain `pip install -r requirements.txt`
on a clean box resolves those pins to the CPU-only wheels from PyPI.

This script closes that gap: run it first and the pins resolve to the CUDA
build already installed, so pip has nothing to do.

Nothing errors when that happens. The booth starts and simply runs badly -
ViTPose++ switches itself off, WiLoR slows by an order of magnitude, and YOLO
drags the synchronous path. main.py now refuses to start on a CPU build rather
than let that pass unnoticed, and points here.

PICKING THE WHEEL
-----------------
A cuXXX wheel needs a driver built against at least that CUDA version, so the
driver's maximum - the "CUDA Version" field in nvidia-smi - is the ceiling, not
a target. Two machines here, both verified working:

    driver 537.70  ->  max CUDA 12.2  ->  cu118
    driver 560.70  ->  max CUDA 12.6  ->  cu124

Newer drivers run older cuXXX wheels fine, so when in doubt the lower one is
the safe choice; this script picks the newest that the driver actually allows.
"""
import argparse
import re
import subprocess
import sys

TORCH = '2.6.0'
TORCHVISION = '0.21.0'

# (minimum driver CUDA version, wheel tag), newest first.
WHEELS = [
    ((12, 4), 'cu124'),
    ((11, 8), 'cu118'),
]


def driver_cuda():
    """Maximum CUDA version this driver supports, from nvidia-smi, or None."""
    try:
        out = subprocess.run(['nvidia-smi'], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'CUDA Version:\s*([0-9]+)\.([0-9]+)', out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def installed():
    try:
        import torch
        return torch.__version__, torch.cuda.is_available()
    except Exception:
        return None, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--yes', action='store_true', help='skip the confirmation prompt')
    ap.add_argument('--check', action='store_true', help='report and exit without installing')
    args = ap.parse_args()

    version, has_cuda = installed()
    print('installed torch : %s' % (version or '(none)'))
    print('cuda available  : %s' % has_cuda)

    cuda = driver_cuda()
    if cuda is None:
        print('\nnvidia-smi did not report a CUDA version.')
        print('Either there is no NVIDIA GPU here, or the driver is not installed.')
        print('Without one, the booth can only run with REQUIRE_CUDA=0 - much slower.')
        return 1
    print('driver max cuda : %d.%d' % cuda)

    tag = next((t for minimum, t in WHEELS if cuda >= minimum), None)
    if tag is None:
        print('\nThis driver is older than the oldest wheel here (%s).' % WHEELS[-1][1])
        print('Update the NVIDIA driver, or add an older wheel tag to WHEELS.')
        return 1
    print('wheel to use    : %s' % tag)

    if has_cuda and version and tag in version:
        print('\nAlready on the right build - nothing to do.')
        return 0

    cmd = [
        sys.executable, '-m', 'pip', 'install',
        'torch==%s' % TORCH, 'torchvision==%s' % TORCHVISION,
        '--index-url', 'https://download.pytorch.org/whl/%s' % tag,
        # PyPI must stay reachable as a fallback. --index-url REPLACES the
        # default index, and the PyTorch index carries only torch's own
        # wheels - so without this, resolving torch's dependencies fails on a
        # clean machine ("No matching distribution found for flit_core",
        # needed to build typing_extensions from source). Verified in an empty
        # venv: with --index-url alone the install errors out; with this added
        # it resolves to torch 2.6.0+cu124 and torchvision 0.21.0+cu124.
        #
        # The CUDA build still wins over PyPI's CPU one of the same version:
        # PEP 440 sorts a local version segment above its absence, so
        # 2.6.0+cu124 > 2.6.0.
        '--extra-index-url', 'https://pypi.org/simple',
    ]
    print('\n' + ' '.join(cmd))

    if args.check:
        return 0
    if not args.yes:
        # ~2.5 GB, and it replaces whatever torch is installed, so it is worth
        # a deliberate keystroke rather than happening as a side effect.
        try:
            if input('\nDownload ~2.5 GB and install? [y/N] ').strip().lower() != 'y':
                print('Cancelled.')
                return 1
        except EOFError:
            print('\nNo terminal to prompt on - re-run with --yes.')
            return 1

    rc = subprocess.call(cmd)
    if rc != 0:
        print('\npip failed (exit %d).' % rc)
        return rc

    # Verify in a fresh interpreter: this one imported torch before the
    # install, so its already-loaded module would report the OLD version.
    check = subprocess.run(
        [sys.executable, '-c',
         'import torch; print(torch.__version__, torch.cuda.is_available())'],
        capture_output=True, text=True,
    )
    print('\nnow installed   : %s' % check.stdout.strip())
    if 'True' not in check.stdout:
        print('Still no GPU. The wheel installed but torch cannot reach the driver.')
        return 1
    print('Ready - start the app normally:  python app.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
