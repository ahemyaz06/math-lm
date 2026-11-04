"""Build both release files with one command:

    recognition-lab\\.venv\\Scripts\\python.exe notebook\\build_release.py

dist\\Math-Notebook-portable.zip   the portable folder (build_portable.py), nothing to install
dist\\Math-Notebook-Setup.exe      the same files as a Windows setup (installer\\MathNotebook.iss)
dist\\SHA256SUMS.txt               their checksums, for the release notes

The setup is made with Inno Setup 6 (free: jrsoftware.org, or `winget install JRSoftware.InnoSetup`).
The version comes from notebook\\VERSION, the same one the app shows in Help > About.
"""
from pathlib import Path
import hashlib
import os
import shutil
import subprocess
import sys

import build_portable as portable

INSTALLER = portable.NOTEBOOK / 'installer'
ZIP = portable.DIST / 'Math-Notebook-portable.zip'
SETUP = portable.DIST / 'Math-Notebook-Setup.exe'


def iscc():
    candidates = [os.environ.get('ISCC', '')]
    for base in (os.environ.get('LOCALAPPDATA'), os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles')):
        if base:
            candidates.append(str(Path(base) / ('Programs' if base == os.environ.get('LOCALAPPDATA') else '') / 'Inno Setup 6' / 'ISCC.exe'))
    candidates.append(shutil.which('iscc') or '')
    for c in candidates:
        if c and Path(c).is_file():
            return c
    raise SystemExit('Inno Setup 6 is not installed (winget install JRSoftware.InnoSetup).')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


if __name__ == '__main__':
    copied = portable.build()
    print('Libraries:', ', '.join(copied))
    print('Check:', portable.check())
    print('Private:', portable.private_check())
    ZIP.unlink(missing_ok=True)
    subprocess.run(['tar', '-a', '-c', '-f', str(ZIP), '-C', str(portable.DIST), 'Math Notebook'], check=True)
    SETUP.unlink(missing_ok=True)
    subprocess.run([iscc(), '/Q', f'/DAppVersion={portable.VERSION}', f'/DSourceDir={portable.OUT}',
                    f'/DOutputDir={portable.DIST}', str(INSTALLER / 'MathNotebook.iss')], check=True)
    sums = [f'{sha256(f)}  {f.name}' for f in (ZIP, SETUP)]
    (portable.DIST / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n', encoding='utf-8')
    print(f'Version {portable.VERSION}')
    for f in (ZIP, SETUP):
        print(f'{f.name}: {f.stat().st_size / 2**20:.0f} MB')
    print('\n'.join(sums))
