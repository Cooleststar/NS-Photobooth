# 3.11 is the floor, not a preference: numpy, scipy and scikit-image in
# requirements.txt all declare requires-python >=3.11, so a 3.10 base fails
# during pip resolution before anything installs.
FROM python:3.11-slim

WORKDIR /app

# System dependencies required by OpenCV, PyTorch (ultralytics), and raw FFmpeg subprocess
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libgl1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# torch/torchvision are deliberately not in requirements.txt (see its header
# comment) - the right wheel depends on the host's CUDA driver, and a plain
# `pip install -r requirements.txt` would let ultralytics pull in the
# default CPU-only PyPI wheel as a transitive dependency instead, which
# still runs but 20-50x slower with no error to indicate it. Installed
# explicitly, first, from the CUDA-specific index, matching what
# requirements.txt documents as verified for a driver reporting CUDA 12.2
# (`nvidia-smi`) - swap cu118 for cu124 etc. if this image ever needs to
# target a different host driver.
RUN pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 \
    --index-url https://download.pytorch.org/whl/cu118

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY gallery.html .
COPY botsort_photobooth.yaml .

# Hand detection. wilor_src is the vendored model source (718 KB); without it
# the backend exits at startup by design, since there is no fallback model.
COPY wilor_hands.py .
COPY fetch_wilor.py .
COPY wilor_src ./wilor_src

# The ~2.5 GB of weights are NOT baked into the image - that would make every
# layer push and pull enormous. Fetch them once into a volume mounted at
# /app/wilor_models:
#
#     docker compose run --rm backend python fetch_wilor.py
#
# Without that, the container starts and immediately exits with the command to
# run, rather than silently degrading.

EXPOSE 9091 8081

CMD ["python", "main.py"]
