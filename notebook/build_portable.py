"""Build the portable Math Notebook: one folder (and a zip of it) that runs on any 64-bit
Windows PC with nothing to install, and with no AI at all.

    recognition-lab\\.venv\\Scripts\\python.exe notebook\\build_portable.py

Layout of dist\\Math Notebook\\:
    Math Notebook.exe          the window (Electron, renamed)
    Read me first.txt
    resources\\app\\notebook\\    the notebook (no tests, no samples) with a PORTABLE marker
    resources\\app\\recognition-lab\\  only the two PDF readers it uses (no AI launcher)
    resources\\app\\sound-lab\\public\\  the graph sounds
    resources\\app\\python\\     a private Python 3.12 with only the libraries the reader needs
    data\\                      made on first start: settings and read PDFs (stays with the folder)
"""
from pathlib import Path
import importlib.metadata as md
import json
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
NOTEBOOK = ROOT / 'notebook'
DIST = ROOT / 'dist'
OUT = DIST / 'Math Notebook'
APP = OUT / 'resources' / 'app'
ELECTRON = ROOT / 'node_modules' / 'electron' / 'dist'
BASE_PYTHON = Path(sys.base_prefix)  # the Python this venv was made from

# What the reader imports (pdf_inspector needs OpenCV and NumPy, the reader pdfplumber and PDFium).
PACKAGES = ['pypdfium2', 'pdfplumber', 'opencv-python', 'numpy']
NOTEBOOK_FILES = ['server.py', 'notebook_core.py', 'pdf_text_reader.py', 'checker.py', 'settings.py', 'attachments.py', 'spelling.py', 'README.md', 'VERSION']
VERSION = (NOTEBOOK / 'VERSION').read_text(encoding='utf-8').strip()  # the one place the version is set
LAB_FILES = ['pdf_inspector.py', 'vector_graph.py']
# Parts of the standard library a reading server never uses.
STDLIB_SKIP = {'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'lib2to3', 'site-packages', '__pycache__', 'pydoc_data'}
DLL_SKIP = re.compile(r'^(_tkinter|tcl|tk)', re.I)


def copy_tree(source, target, skip_dirs=frozenset()):
    for path in source.rglob('*'):
        rel = path.relative_to(source)
        if any(part in skip_dirs for part in rel.parts) or path.suffix == '.pyc':
            continue
        dest = target / rel
        if path.is_dir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)


def requirement_names(dist):
    """Names a distribution needs (leaving out extras and other platforms)."""
    names = []
    for req in dist.requires or []:
        if ';' in req:
            marker = req.split(';', 1)[1]
            if 'extra' in marker or 'sys_platform' in marker and 'win32' not in marker:
                continue
        names.append(re.split(r'[\s<>=!~\[(;]', req.strip(), maxsplit=1)[0])
    return names


def needed_distributions():
    seen, todo = {}, list(PACKAGES)
    while todo:
        name = todo.pop()
        key = name.lower().replace('_', '-')
        if key in seen:
            continue
        try:
            dist = md.distribution(name)
        except md.PackageNotFoundError:
            continue  # an optional dependency not installed here
        seen[key] = dist
        todo.extend(requirement_names(dist))
    return seen


def build_python():
    py = APP / 'python'
    (py / 'DLLs').mkdir(parents=True)
    for name in ['python.exe', 'pythonw.exe', 'python3.dll', f'python{sys.version_info.major}{sys.version_info.minor}.dll',
                 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']:
        if (BASE_PYTHON / name).exists():
            shutil.copy2(BASE_PYTHON / name, py / name)
    for dll in (BASE_PYTHON / 'DLLs').iterdir():
        if dll.is_file() and not DLL_SKIP.match(dll.name):
            shutil.copy2(dll, py / 'DLLs' / dll.name)
    copy_tree(BASE_PYTHON / 'Lib', py / 'Lib', STDLIB_SKIP)
    site = py / 'Lib' / 'site-packages'
    site.mkdir(parents=True, exist_ok=True)
    copied = []
    for key, dist in sorted(needed_distributions().items()):
        for file in dist.files or []:
            source = Path(dist.locate_file(file))
            if not source.is_file() or source.suffix == '.pyc' or '__pycache__' in source.parts:
                continue
            dest = site / file
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
        copied.append(f'{dist.metadata["Name"]} {dist.version}')
    # A ._pth file makes this Python ignore every other Python on the PC (registry, PYTHONPATH)
    # and look only here; the notebook folder is listed because ._pth leaves out the script's folder.
    tag = f'python{sys.version_info.major}{sys.version_info.minor}'
    (py / f'{tag}._pth').write_text('Lib\nDLLs\nLib\\site-packages\n..\\notebook\nimport site\n', encoding='utf-8')
    return copied


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    # The window: Electron with only the English language files, renamed.
    copy_tree(ELECTRON, OUT, {'locales'})
    (OUT / 'locales').mkdir()
    shutil.copy2(ELECTRON / 'locales' / 'en-US.pak', OUT / 'locales' / 'en-US.pak')
    (OUT / 'electron.exe').rename(OUT / 'Math Notebook.exe')
    (OUT / 'resources' / 'default_app.asar').unlink(missing_ok=True)
    APP.mkdir(parents=True)
    (APP / 'package.json').write_text(json.dumps({'name': 'math-notebook', 'productName': 'Math Notebook', 'version': VERSION,
                                                  'main': 'notebook/desktop/main.cjs'}, indent=1), encoding='utf-8')
    # The notebook itself.
    (APP / 'notebook').mkdir()
    for name in NOTEBOOK_FILES:
        shutil.copy2(NOTEBOOK / name, APP / 'notebook' / name)
    # The guide without its notes for developers (the tests are not in the build).
    guide = APP / 'notebook' / 'README.md'
    guide.write_text(re.sub(r'\n?', '', guide.read_text(encoding='utf-8'), flags=re.S), encoding='utf-8')
    copy_tree(NOTEBOOK / 'web', APP / 'notebook' / 'web')
    copy_tree(NOTEBOOK / 'desktop', APP / 'notebook' / 'desktop')
    (APP / 'notebook' / 'PORTABLE').write_text('This copy runs without AI. See "Read me first.txt".\n', encoding='utf-8')
    (APP / 'recognition-lab').mkdir()
    for name in LAB_FILES:
        shutil.copy2(ROOT / 'recognition-lab' / name, APP / 'recognition-lab' / name)
    copy_tree(ROOT / 'sound-lab' / 'public', APP / 'sound-lab' / 'public')
    copied = build_python()
    shutil.copy2(NOTEBOOK / 'portable-readme.txt', OUT / 'Read me first.txt')
    return copied


def check():
    """Start the bundled Python the way the app does and import everything the reader needs."""
    py = APP / 'python' / 'python.exe'
    code = ('import sys, notebook_core, settings, attachments, spelling, pdf_inspector, vector_graph, cv2, numpy, pdfplumber, pypdfium2; '
            'print(sys.version.split()[0], "AI" if settings.AI else "no AI", sys.prefix)')
    # No compiled cache files from this run: they would carry this computer's folder names.
    env = {'SYSTEMROOT': __import__('os').environ['SYSTEMROOT'], 'MATH_NOTEBOOK_NO_AI': '1', 'MATH_NOTEBOOK_DATA': str(DIST / 'check-data'),
           'PYTHONDONTWRITEBYTECODE': '1'}
    result = subprocess.run([str(py), '-c', code], cwd=APP / 'notebook', env=env, capture_output=True, text=True, timeout=120)
    shutil.rmtree(DIST / 'check-data', ignore_errors=True)
    if result.returncode:
        raise SystemExit(f'The portable Python cannot load the reader:\n{result.stderr}')
    return result.stdout.strip()


def private_check():
    """The build is shared: no cache folders, and no file may name this computer's user folder."""
    for cache in list(APP.rglob('__pycache__')):
        shutil.rmtree(cache, ignore_errors=True)
    # pip's command-line launchers (pdf2txt.py, f2py.exe ...) name the build's Python inside
    # them; the app never runs them.
    shutil.rmtree(APP / 'python' / 'Scripts', ignore_errors=True)
    home = str(Path.home())
    needles = {home.encode(), home.replace('\\', '/').encode(), home.encode('utf-16-le'), Path.home().name.encode() + b'\\Desktop'}
    found = []
    for f in OUT.rglob('*'):
        if f.is_file() and f.stat().st_size < 20 * 2**20:
            data = f.read_bytes()
            if any(n in data for n in needles):
                found.append(str(f.relative_to(OUT)))
    if found:
        raise SystemExit('These files name this computer\'s user folder, so the build is not shared:\n' + '\n'.join(found))
    return 'no user folder names, no cache folders'


def size(path):
    return sum(f.stat().st_size for f in path.rglob('*') if f.is_file())


if __name__ == '__main__':
    copied = build()
    print('Libraries:', ', '.join(copied))
    print('Check:', check())
    print('Private:', private_check())
    print(f'Folder: {OUT} ({size(OUT) / 2**20:.0f} MB)')
    if '--no-zip' not in sys.argv:
        archive = DIST / 'Math Notebook (portable).zip'
        archive.unlink(missing_ok=True)
        subprocess.run(['tar', '-a', '-c', '-f', str(archive), '-C', str(DIST), 'Math Notebook'], check=True)
        print(f'Zip: {archive} ({archive.stat().st_size / 2**20:.0f} MB)')
