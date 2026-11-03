"""Download the 4-bit Qwen3-VL-8B-Instruct (Q4_K_M) GGUF model and llama.cpp Vulkan GPU runner."""
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
BIN_DIR = ROOT / "bin" / "llama-vulkan"
OLD_MODEL_DIR = ROOT / "models" / "qwen2.5-vl-3b"
MODEL_DIR = ROOT / "models" / "qwen3-vl-8b"

LLAMA_ZIP_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-vulkan-x64.zip"
HF_BASE = "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main"
MODEL_FILES = [
    "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
]


def download_file(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    existing = part.stat().st_size if part.exists() else 0
    if dest.exists() and dest.stat().st_size > 1_000_000:
        print(f"[skip] {dest.name} already downloaded ({dest.stat().st_size / 1e6:.1f} MB)")
        return
    headers = {"User-Agent": "RecognitionLab/0.3"}
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"
        print(f"[resume] {dest.name} from {existing / 1e6:.1f} MB...")
    else:
        print(f"[download] {dest.name} from {url} ...")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        total = int(resp.headers.get("Content-Length", "0")) + existing
        mode = "ab" if existing > 0 and resp.status == 206 else "wb"
        if mode == "wb":
            existing = 0
        downloaded = existing
        last_pct = -1
        with open(part, mode) as f:
            while True:
                chunk = resp.read(4 * 1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = int(downloaded * 100 // total)
                    if pct >= last_pct + 10:
                        last_pct = pct
                        print(f"  {dest.name}: {pct}% ({downloaded / 1e6:.1f} / {total / 1e6:.1f} MB)", flush=True)
    part.replace(dest)
    print(f"[done] {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")


def main():
    if OLD_MODEL_DIR.exists():
        print(f"[cleanup] Removing old model directory {OLD_MODEL_DIR} ...")
        shutil.rmtree(OLD_MODEL_DIR, ignore_errors=True)
        print("[done] Removed old Qwen2.5-VL-3B model directory.")

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    server_exe = BIN_DIR / "llama-server.exe"
    if not server_exe.exists():
        zip_path = BIN_DIR / "llama-vulkan.zip"
        download_file(LLAMA_ZIP_URL, zip_path)
        print(f"[extract] Extracting {zip_path.name} to {BIN_DIR} ...")
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(BIN_DIR)
        zip_path.unlink(missing_ok=True)
        print("[done] Extracted llama.cpp Vulkan GPU binaries.")
    else:
        print("[skip] llama-server.exe already present.")

    for fname in MODEL_FILES:
        download_file(f"{HF_BASE}/{fname}", MODEL_DIR / fname)

    print("All Qwen3-VL-8B-Instruct (Q4_K_M) VLM files are ready.")


if __name__ == "__main__":
    main()

