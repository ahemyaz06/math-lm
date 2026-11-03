"""Download pinned data files only; never imports or runs code from the model repository."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent / "models" / "qwen3.5-9b-q4km"
ROOT.mkdir(parents=True, exist_ok=True)
REPO = "unsloth/Qwen3.5-9B-GGUF"
REVISION = "3885219b6810b007914f3a7950a8d1b469d598a5"
FILES = [
    ("Qwen3.5-9B-Q4_K_M.gguf", 5680522464,
     "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8"),
    ("mmproj-F16.gguf", 918166080,
     "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f"),
]
CURL = r"C:\Windows\system32\curl.exe"
MANIFEST = ROOT / "download-manifest.json"


def utc():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


state = {
    "repository": REPO, "revision": REVISION, "license": "Apache-2.0",
    "created_utc": utc(), "status": "downloading", "files": [], "metadata": [],
    "installed_application_modified": False, "model_loaded": False,
}


def save():
    state["updated_utc"] = utc()
    temporary = MANIFEST.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(MANIFEST)


def fetch_large(name, expected_size, expected_sha):
    final = ROOT / name
    part = ROOT / (name + ".part")
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}?download=true"
    item = {"filename": name, "url": url, "expected_bytes": expected_size,
            "expected_sha256": expected_sha, "status": "pending"}
    state["files"].append(item)
    save()
    if final.exists():
        if final.stat().st_size != expected_size or digest(final) != expected_sha:
            raise RuntimeError(f"Existing final file does not match pinned metadata: {final}")
        item.update(status="verified", bytes=expected_size, sha256=expected_sha, reused=True)
        save()
        print(f"Verified existing {name}", flush=True)
        return
    for attempt in range(1, 6):
        current = part.stat().st_size if part.exists() else 0
        if current > expected_size:
            raise RuntimeError(f"Partial file exceeds expected size: {part}")
        if current == expected_size:
            break
        item.update(status="downloading", attempt=attempt, bytes=current)
        save()
        print(f"Downloading {name} from byte {current:,} of {expected_size:,}", flush=True)
        request_url = url + f"&transfer={int(time.time())}"
        command = [CURL, "--location", "--fail", "--show-error", "--silent",
                   "--continue-at", "-", "--retry", "8", "--retry-all-errors",
                   "--retry-delay", "3", "--connect-timeout", "30",
                   "--speed-limit", "10240", "--speed-time", "90",
                   "--output", str(part), request_url]
        log_path = ROOT / (name + ".transfer.log")
        process = None
        try:
            with log_path.open("ab") as output:
                process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
                last_update = 0.0
                while process.poll() is None:
                    now = time.monotonic()
                    if now - last_update >= 15:
                        current = part.stat().st_size if part.exists() else 0
                        item["bytes"] = current
                        save()
                        print(f"{name}: {current:,}/{expected_size:,} bytes ({100*current/expected_size:.1f}%)", flush=True)
                        last_update = now
                    time.sleep(1)
            item["last_transfer_exit_code"] = process.returncode
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        current = part.stat().st_size if part.exists() else 0
        item["bytes"] = current
        save()
        if current == expected_size:
            break
        print(f"Transfer attempt {attempt} ended at {current:,} bytes; partial file retained.", flush=True)
    actual_size = part.stat().st_size if part.exists() else 0
    if actual_size != expected_size:
        raise RuntimeError(f"Incomplete download of {name}: {actual_size} of {expected_size} bytes")
    item.update(status="verifying", bytes=actual_size)
    save()
    print(f"Verifying full SHA-256 for {name}", flush=True)
    actual_sha = digest(part)
    item["sha256"] = actual_sha
    if actual_sha != expected_sha:
        item["status"] = "hash_mismatch"
        save()
        raise RuntimeError(f"Pinned SHA-256 mismatch for {name}; .part file retained")
    part.rename(final)
    item.update(status="verified", verified_utc=utc())
    save()
    print(f"Verified {name}: {actual_size:,} bytes, SHA-256 {actual_sha}", flush=True)


def fetch_metadata(name, repo, revision, filename, optional=False):
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{filename}"
    final = ROOT / name
    part = ROOT / (name + ".part")
    command = [CURL, "--location", "--fail", "--show-error", "--silent", "--retry", "3",
               "--connect-timeout", "30", "--max-time", "120", "--output", str(part), url]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        state["metadata"].append({"filename": name, "url": url, "status": "unavailable",
                                  "optional": optional, "exit_code": result.returncode})
        save()
        if not optional:
            raise RuntimeError(f"Could not retrieve metadata {name}")
        return
    part.replace(final)
    state["metadata"].append({"filename": name, "url": url, "status": "saved",
                              "bytes": final.stat().st_size, "sha256": digest(final)})
    save()


if __name__ == "__main__":
    try:
        save()
        for specification in FILES:
            fetch_large(*specification)
        fetch_metadata("README-source.md", REPO, REVISION, "README.md")
        fetch_metadata("LICENSE", "Qwen/Qwen3.5-9B", "c202236235762e1c871ad0ccb60c8ee5ba337b9a", "LICENSE")
        state.update(status="verified", completed_utc=utc())
        save()
        print("Both pinned GGUF files verified. No model was loaded and the installed app was not changed.", flush=True)
    except BaseException as error:
        state.update(status="failed", error=str(error))
        save()
        raise
