import subprocess
import sys
import os
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))

def stream(proc, prefix):
    for line in iter(proc.stdout.readline, b''):
        print(f"[{prefix}] {line.decode(errors='replace')}", end='')

def main():
    backend = subprocess.Popen(
        [sys.executable, "main.py"],
        cwd=os.path.join(ROOT, "backend"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    frontend = subprocess.Popen(
        ["yarn", "dev", "--host"],
        cwd=os.path.join(ROOT, "client-ns-photobooth"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
    )

    threading.Thread(target=stream, args=(backend, "backend"), daemon=True).start()
    threading.Thread(target=stream, args=(frontend, "frontend"), daemon=True).start()

    print("[dev] Both services started. Press Ctrl+C to stop.")
    try:
        backend.wait()
        frontend.wait()
    except KeyboardInterrupt:
        print("\n[dev] Stopping...")
        backend.terminate()
        frontend.terminate()

if __name__ == "__main__":
    main()
