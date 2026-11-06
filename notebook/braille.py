"""Braille (.brf) from the document, made by BrailleBlaster, which has to be installed on this
computer (free, from the American Printing House: brailleblaster.org).

The page gives an XHTML file with every equation as MathML (web/braille.js); BrailleBlaster's own
command line (`export brf <in> <out>`) translates it with its saved settings. For Nemeth maths,
BrailleBlaster's Translation settings must say UEB with Nemeth (UEB-PLUS-NEMETH).

Finding BrailleBlaster, its settings and waiting for its export follow Owen Petronick's Braille
Check (tex2braille.py), which does the same for quizzes.
"""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import time

NEMETH = 'UEB-PLUS-NEMETH'


def program():
    """BrailleBlaster's launcher, or None. $BRAILLEBLASTER wins; then PATH; then where its installers
    put it: the Microsoft Store alias, the Windows installer, the macOS .app, the Linux package."""
    if os.environ.get('BRAILLEBLASTER'):
        return os.environ['BRAILLEBLASTER']
    found = shutil.which('brailleblaster') or shutil.which('BrailleBlaster')
    if found:
        return found
    home = Path.home()
    local = Path(os.environ.get('LOCALAPPDATA', home / 'AppData' / 'Local'))
    candidates = [local / 'Microsoft' / 'WindowsApps' / 'brailleblaster.exe']
    for root in (os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)'), str(local / 'Programs')):
        if root:
            candidates += sorted(Path(root).glob('*rail*laster*/[Bb]raille[Bb]laster.exe'))
    for apps in (Path('/Applications'), home / 'Applications'):
        candidates += sorted(apps.glob('*rail*laster*.app/Contents/MacOS/*'))
    candidates.append(Path('/opt/brailleblaster/bin/BrailleBlaster'))
    return next((str(c) for c in candidates if c.is_file()), None)


def _data():
    """BrailleBlaster's own folder ("brlblst": its settings and log)."""
    home = Path.home()
    candidates = [Path(os.environ['BRAILLEBLASTER_DATA'])] if os.environ.get('BRAILLEBLASTER_DATA') else []  # tests
    if os.environ.get('APPDATA'):
        candidates.append(Path(os.environ['APPDATA']) / 'brlblst')
    candidates += [home / 'Library' / 'Application Support' / 'brlblst', home / '.brlblst']
    return next((c for c in candidates if c.is_dir()), None)


def first_run_done():
    """BrailleBlaster's first start shows its licence and a few questions in a window, and its
    command line waits behind that window: export works only after a person has gone through it."""
    folder = _data()
    settings = folder / 'programData' / 'settings' / 'user_settings.properties' if folder else None
    return bool(settings and settings.is_file()
                and re.search(r'^licenseAccepted=\S', settings.read_text(encoding='utf-8', errors='replace'), re.M))


def not_six_dot(brf):
    """The lines of a .brf that are not plain 6-dot braille (ASCII braille, space to underscore):
    BrailleBlaster writes an 8-dot cell (as a Unicode braille character) where it cannot braille
    something, such as the rows of a matrix. An embosser cannot make those."""
    lines = Path(brf).read_text(encoding='utf-8', errors='replace').splitlines()
    return [n for n, line in enumerate(lines, 1) if re.search(r'[^\x20-\x5f\f]', line.upper())]


def standard():
    """BrailleBlaster's braille standard as saved in its settings (UEB when nothing is saved)."""
    folder = _data()
    settings = folder / 'programData' / 'settings' / 'user_settings.properties' if folder else None
    if not settings or not settings.is_file():
        return 'UEB'
    found = re.search(r'^brailleStandard=(.+)$', settings.read_text(encoding='utf-8', errors='replace'), re.M)
    return found.group(1).strip() if found else 'UEB'


def export(page, brf, timeout=600):
    """Write the braille of an XHTML page to brf. Returns BrailleBlaster's braille standard.
    BrailleBlaster's launcher returns at once while the export runs on, so this waits until the
    file exists and stops growing, and stops early when BrailleBlaster's log reports a failure."""
    exe = program()
    if not exe:
        raise LookupError('BrailleBlaster is not installed. It is free from the American Printing House '
                          '(brailleblaster.org); after installing it, export again.')
    if not first_run_done():
        raise LookupError('BrailleBlaster has not been started yet. Open BrailleBlaster once, read and accept its '
                          'licence and answer its first questions (its Translation settings can be set to UEB with '
                          'Nemeth there too), then export again.')
    brf = Path(brf).resolve()
    work =Path(tempfile.mkdtemp(prefix='notebook-braille-'))
    try:
        source = work / 'document.html'
        source.write_text(page, encoding='utf-8')
        brf.unlink(missing_ok=True)
        log = (_data() or work) / 'log' / 'bb.log'
        seen = log.stat().st_size if log.is_file() else 0
        launcher = subprocess.Popen([exe, 'export', 'brf', str(source), str(brf)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            launcher.wait(30)  # the launcher itself returns at once; the export goes on after it
        except subprocess.TimeoutExpired:
            pass
        end, last = time.time() + timeout, -1
        while time.time() < end:
            time.sleep(1)
            if brf.is_file():
                size = brf.stat().st_size
                # A file of only spaces and page breaks is what a failed open leaves: keep waiting.
                if size == last and size > 0 and brf.read_bytes().strip():
                    return standard()
                last = size
            if log.is_file() and log.stat().st_size > seen:
                with open(log, encoding='utf-8', errors='replace') as fh:
                    fh.seek(seen)
                    failed = re.search(r'(Failed when opening file.*|There was a problem converting.*|Unable to open file.*)', fh.read())
                if failed:
                    raise RuntimeError(f'BrailleBlaster: {failed.group(1).strip()}')
        raise RuntimeError(f'BrailleBlaster made no braille within {timeout // 60} minutes.')
    finally:
        shutil.rmtree(work, ignore_errors=True)
