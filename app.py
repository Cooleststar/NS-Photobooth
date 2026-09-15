import subprocess
import sys
import os
import threading
import time

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
    gallery = subprocess.Popen(
        ["yarn", "dev", "--host"],
        cwd=os.path.join(ROOT, "gallery"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
    )

    threading.Thread(target=stream, args=(backend,  "backend"),  daemon=True).start()
    threading.Thread(target=stream, args=(frontend, "frontend"), daemon=True).start()
    threading.Thread(target=stream, args=(gallery,  "gallery"),  daemon=True).start()

    print("[dev] All services started. Press Ctrl+C to stop.")
    print("[dev]  backend  → http://localhost:8081")
    print("[dev]  frontend → http://localhost:3000")
    print("[dev]  gallery  → http://localhost:5173")

    procs = {"backend": backend, "frontend": frontend, "gallery": gallery}
    try:
        # Poll all three rather than backend.wait(); frontend.wait();
        # gallery.wait() in sequence - that order meant a backend crash was
        # invisible: backend.wait() returns the moment it dies, but nothing
        # checked its exit code, so execution just moved on to blocking on
        # frontend.wait() against a frontend that was still running fine.
        # The booth would sit there looking alive with a dead backend behind
        # it for the rest of the event. Polling means ANY of the three dying
        # ends the whole thing immediately, with a message saying which one.
        while True:
            for name, proc in procs.items():
                code = proc.poll()
                if code is not None:
                    print(f"\n[dev] {name} exited unexpectedly (code {code}) - stopping the others.")
                    for other_proc in procs.values():
                        if other_proc is not proc:
                            other_proc.terminate()
                    return
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[dev] Stopping...")
        for proc in procs.values():
            proc.terminate()

if __name__ == "__main__":
    main()
