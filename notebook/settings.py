"""Math Notebook settings: one file for everything the separate labs used to set on their
own (Recognition Lab's reading, Sound Lab's sounds, the cursor tones).

Saved as settings.json next to the notebook's other data. Only the Settings dialog
changes it; imported documents never can.
"""
import json
import os
import threading
from pathlib import Path

_lock = threading.RLock()


def _ai_installed():
    """The AI is an add-on: Recognition Lab's model launcher plus at least one reading model
    on this computer. Without it (or with MATH_NOTEBOOK_NO_AI=1, the portable version) the
    notebook reads PDFs only from their own text and never starts a model."""
    if os.environ.get('MATH_NOTEBOOK_NO_AI') == '1':
        return False
    import sys
    lab = Path(__file__).resolve().parent.parent / 'recognition-lab'
    if not (lab / 'vlm_helper.py').is_file():
        return False
    if str(lab) not in sys.path:
        sys.path.append(str(lab))
    try:
        import vlm_helper
        return any(vlm_helper.is_vlm_installed(name) for name in vlm_helper.PROFILES)
    except Exception:
        return False


AI = _ai_installed()  # whether the AI add-on is installed; ai_enabled() says if it is used


def _env_models():
    models = [m.strip() for m in os.environ.get('MATH_NOTEBOOK_MODELS', 'qwen3.6-35b').split(',') if m.strip()]
    return models or ['qwen3.6-35b']


# name: (default, allowed values or a (low, high) range for numbers)
def _spec():
    models = _env_models() if AI else ['']
    return {
        # The AI add-on, when installed, can be switched off; the notebook then works as without it.
        **({'use_ai': (True, [True, False])} if AI else {}),
        # Reading PDFs
        'reading_method': ('auto', ['auto', 'text', 'ai']) if AI else ('text', ['text']),
        'describe_pictures': (True, [True, False]) if AI else (False, [False]),
        'estimate_graph_numbers': (True, [True, False]) if AI else (False, [False]),
        'reading_model': (models[0], None),          # checked against installed models by the server
        'second_model': (models[1] if len(models) > 1 else '', None),
        'pages_at_once': (int(os.environ.get('MATH_NOTEBOOK_WORKERS', '2')), [1, 2]),
        # Graph sound (Sound Lab)
        # The calm profiles, then the voices in sound-lab/public/voices.js (instruments, beeps, game sounds)
        'sound_profile': ('gentle', ['gentle', 'warm-acoustic', 'soft-synth', 'crisp-piano', 'high-contrast', 'progress',
                                     'piano', 'guitar', 'harp', 'marimba', 'kalimba', 'vibraphone', 'flute', 'cello',
                                     'beep', 'soft-square', 'chirp', 'chiptune', 'retro-triangle', 'bubble', 'arcade']),
        # Clearer pitch: notes slide from the last height's pitch and are further apart (off: the original)
        'pitch_glide': (True, [True, False]),
        # The slope sound in graph mode: a soft second note for the slope after each step (D turns it on or off)
        'slope_sound': (False, [True, False]),
        # Writing: Right and Left go into an equation and step through its plain text one symbol at a time
        'step_into_equations': (True, [True, False]),
        # Ask GitHub for a newer version when the app starts (one request; off unless chosen)
        'check_updates': (False, [True, False]),
        # Writing: say an equation as plain text when the cursor comes to it (NVDA's focus mode reads only its start)
        'say_equations': (True, [True, False]),
        'bass_mode': ('x-and-y', ['x-and-y', 'x-only', 'y-only', 'off']),
        'step': (0.5, [0.1, 0.25, 0.5, 1]),
        'play_speed_ms': (400, [800, 400, 250, 150]),
        'cues': (True, [True, False]),
        'volume': (0.25, (0.05, 0.5)),
        'bass_volume': (0.35, (0.1, 0.9)),
        # Moving freely in a graph: cursor tones
        'free_move_tones': (True, [True, False]),
        # Dots and corners: bump, wind and corner slide ('new') or the earlier sounds
        'dot_sounds': ('new', ['new', 'original']),
        # Numbers said in graph mode: to the nearest half (4.19 is 4), one decimal, or exact
        'graph_numbers': ('half', ['half', 'tenth', 'exact']),
    }


def defaults():
    return {name: default for name, (default, _allowed) in _spec().items()}


def _path():
    root = Path(os.environ.get('MATH_NOTEBOOK_DATA') or
                Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'MathNotebook')
    return root / 'settings.json'


def validate(values, models=None):
    """Check every given value; unknown names and wrong values are refused with a reason."""
    spec = _spec()
    if not isinstance(values, dict):
        raise ValueError('Settings must be a set of names and values.')
    clean = {}
    for name, value in values.items():
        if name not in spec:
            raise ValueError(f'Unknown setting: {name}.')
        default, allowed = spec[name]
        if name in ('reading_model', 'second_model') and not AI:
            if value != '':
                raise ValueError('This version of Math Notebook has no AI reading models.')
        elif name in ('reading_model', 'second_model'):
            if not isinstance(value, str) or (models is not None and value and value not in models):
                raise ValueError(f'{value} is not an installed reading model.')
            if name == 'reading_model' and not value:
                raise ValueError('Choose a reading model.')
        elif isinstance(allowed, tuple):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not allowed[0] <= value <= allowed[1]:
                raise ValueError(f'{name} must be a number from {allowed[0]} to {allowed[1]}.')
        elif value not in allowed or type(value) is not type(default) and not (
                isinstance(default, float) and isinstance(value, int) and not isinstance(value, bool)):
            raise ValueError(f'{name} cannot be {value!r}.')
        clean[name] = value
    return clean


def load():
    """All settings: saved values over the defaults. A damaged file gives the defaults."""
    values = defaults()
    with _lock:
        try:
            saved = json.loads(_path().read_text(encoding='utf-8'))
            for name, value in saved.items():
                try:
                    values.update(validate({name: value}))
                except ValueError:
                    pass  # one bad value does not lose the others
        except (OSError, ValueError):
            pass
    return values


def save(changes, models=None):
    """Save some settings (the rest keep their values). Returns all settings."""
    clean = validate(changes, models)
    with _lock:
        values = load()
        values.update(clean)
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(values, indent=1), encoding='utf-8')
        os.replace(tmp, path)
    return values


def reset():
    with _lock:
        try:
            _path().unlink()
        except FileNotFoundError:
            pass
    return load()


def get(name):
    return load()[name]


def ai_enabled():
    """True only when the AI add-on is installed and switched on in Settings."""
    return AI and load()['use_ai']
