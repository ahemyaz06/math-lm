"""Local PDF preferences; uploaded document text cannot change settings."""
from pathlib import Path
import json
import os
import threading

DEFAULTS={'upload_limit_mb':20,'batch_pages':100}


def data_directory():
    override=os.environ.get('RECOGNITION_LAB_DATA_DIR')
    if override:return Path(override)
    return Path(os.environ.get('LOCALAPPDATA',Path.home()/'AppData'/'Local'))/'RecognitionLab'


def validate(values):
    if not isinstance(values,dict) or set(values)!=set(DEFAULTS):
        raise ValueError('Settings must contain upload_limit_mb and batch_pages.')
    for name in DEFAULTS:
        if type(values[name]) is not int or not 1<=values[name]<=100:
            raise ValueError('PDF upload size and pages per batch must be whole numbers from 1 to 100.')
    return dict(values)


class AppSettings:
    def __init__(self,root):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.path=self.root/'settings.json'
        self.lock=threading.RLock()
        try:self.values=validate(json.loads(self.path.read_text(encoding='utf-8')))
        except (OSError,ValueError):self.values=dict(DEFAULTS)

    def snapshot(self):
        with self.lock:return dict(self.values)

    def update(self,values):
        values=validate(values)
        with self.lock:
            from pdf_worker import write_json
            write_json(self.path,values)
            self.values=values
            return self.snapshot()
