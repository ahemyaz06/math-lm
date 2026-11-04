"""Spelling from the Windows spell checker: the same one that draws the document's red
underlines and fills the right-click suggestions, so all three always agree.

It is reached through its COM interface with ctypes (no extra package). All calls run on one
thread that owns the spell checker. Off Windows, or where Windows has no spell checker for
the language, `available()` is False and the notebook says so instead of checking.
"""
import ctypes
import queue
import sys
import threading

if sys.platform == 'win32':
    from ctypes import POINTER, WINFUNCTYPE, byref, c_ulong, c_void_p, c_wchar_p, wintypes

    ole32 = ctypes.OleDLL('ole32')

    class GUID(ctypes.Structure):
        _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16), ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]

    def _guid(text):
        g = GUID()
        ole32.CLSIDFromString(c_wchar_p(text), byref(g))
        return g

    CLSID_SpellCheckerFactory = '{7AB36653-1796-484B-BDFA-E74F1DB7C1DC}'
    IID_ISpellCheckerFactory = '{8E018A9D-2415-4677-BF08-794EA61F94BB}'
    CLSCTX_INPROC_SERVER = 1
    COINIT_MULTITHREADED = 0

    def _call(obj, index, *args, types=()):
        """Method `index` of a COM object's table (0-2 are IUnknown's)."""
        table = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
        method = WINFUNCTYPE(ctypes.HRESULT, c_void_p, *types)(table[index])
        return method(obj, *args)

    def _release(obj):
        if obj:
            table = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
            WINFUNCTYPE(c_ulong, c_void_p)(table[2])(obj)

    def _take_string(pointer):
        """A string the spell checker allocated, freed after reading."""
        text = ctypes.wstring_at(pointer)
        ole32.CoTaskMemFree(pointer)
        return text

    ACTIONS = {1: 'suggest', 2: 'replace', 3: 'delete'}

    class _Checker:
        def __init__(self, language):
            ole32.CoInitializeEx(None, COINIT_MULTITHREADED)
            factory = c_void_p()
            ole32.CoCreateInstance(byref(_guid(CLSID_SpellCheckerFactory)), None, CLSCTX_INPROC_SERVER,
                                   byref(_guid(IID_ISpellCheckerFactory)), byref(factory))
            self.factory = factory
            self.language = None
            for tag in [language, 'en-US']:
                supported = wintypes.BOOL()
                if tag and _call(factory, 4, c_wchar_p(tag), byref(supported), types=(c_wchar_p, POINTER(wintypes.BOOL))) == 0 and supported:
                    self.language = tag
                    break
            if not self.language:
                raise OSError('Windows has no spell checker for this language.')
            checker = c_void_p()
            _call(factory, 5, c_wchar_p(self.language), byref(checker), types=(c_wchar_p, POINTER(c_void_p)))
            self.checker = checker

        def suggest(self, word, limit=8):
            found = c_void_p()
            _call(self.checker, 5, c_wchar_p(word), byref(found), types=(c_wchar_p, POINTER(c_void_p)))
            out = []
            try:
                while len(out) < limit:
                    item, fetched = c_void_p(), c_ulong()
                    _call(found, 3, 1, byref(item), byref(fetched), types=(c_ulong, POINTER(c_void_p), POINTER(c_ulong)))
                    if not fetched.value:
                        break
                    out.append(_take_string(item))
            finally:
                _release(found)
            return out

        def check(self, text):
            """The mistakes in one piece of text. Positions count UTF-16 units, as JavaScript does."""
            units = text.encode('utf-16-le')
            errors = c_void_p()
            _call(self.checker, 4, c_wchar_p(text), byref(errors), types=(c_wchar_p, POINTER(c_void_p)))
            out = []
            try:
                for _ in range(2000):
                    error = c_void_p()
                    if _call(errors, 3, byref(error), types=(POINTER(c_void_p),)) != 0:
                        break  # S_FALSE: no more
                    try:
                        start, length, action, replacement = c_ulong(), c_ulong(), ctypes.c_int(), c_void_p()
                        _call(error, 3, byref(start), types=(POINTER(c_ulong),))
                        _call(error, 4, byref(length), types=(POINTER(c_ulong),))
                        _call(error, 5, byref(action), types=(POINTER(ctypes.c_int),))
                        _call(error, 6, byref(replacement), types=(POINTER(c_void_p),))
                        word = units[2 * start.value:2 * (start.value + length.value)].decode('utf-16-le', 'replace')
                        kind = ACTIONS.get(action.value)
                        swap = _take_string(replacement) if replacement.value else ''
                        if not kind:
                            continue
                        suggestions = self.suggest(word) if kind == 'suggest' else [swap] if kind == 'replace' else []
                        out.append({'start': start.value, 'length': length.value, 'word': word, 'action': kind, 'suggestions': suggestions})
                    finally:
                        _release(error)
            finally:
                _release(errors)
            return out

        def add(self, word):
            _call(self.checker, 6, c_wchar_p(word), types=(c_wchar_p,))


_jobs = queue.Queue()
_state = {'checker': None, 'error': None, 'started': False}
_lock = threading.Lock()


def _worker():
    try:
        _state['checker'] = _Checker(_user_language())
    except Exception as exc:  # no spell checker: say why, do not crash the server
        _state['error'] = str(exc) or 'The Windows spell checker could not be started.'
    while True:
        work, reply = _jobs.get()
        try:
            if _state['checker'] is None:
                raise OSError(_state['error'])
            reply.put((True, work(_state['checker'])))
        except Exception as exc:
            reply.put((False, exc))


def _user_language():
    try:
        buffer = ctypes.create_unicode_buffer(85)
        ctypes.windll.kernel32.GetUserDefaultLocaleName(buffer, 85)
        return buffer.value or 'en-US'
    except (AttributeError, OSError):
        return 'en-US'


def _run(work):
    if sys.platform != 'win32':
        raise OSError('Spelling uses the Windows spell checker, which is only on Windows.')
    with _lock:
        if not _state['started']:
            _state['started'] = True
            threading.Thread(target=_worker, name='spelling', daemon=True).start()
    reply = queue.Queue()
    _jobs.put((work, reply))
    ok, value = reply.get(timeout=30)
    if not ok:
        raise value
    return value


def available():
    try:
        return bool(_run(lambda c: c.language))
    except Exception:
        return False


def language():
    return _run(lambda c: c.language)


def check(texts):
    """Mistakes for each text in the list, in the same order."""
    return _run(lambda c: [c.check(t) if t.strip() else [] for t in texts])


def suggest(word):
    return _run(lambda c: c.suggest(word))


def add(word):
    """Adds the word to the Windows dictionary (the one the red underlines use too)."""
    return _run(lambda c: c.add(word))
