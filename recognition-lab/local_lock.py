"""OS-backed local file locks; released even after process exit."""
from pathlib import Path
import os


class LockBusy(RuntimeError):
    pass


class FileLock:
    def __init__(self,path):
        self.path=Path(path);self.stream=None

    def acquire(self):
        if self.stream is not None:return self
        self.path.parent.mkdir(parents=True,exist_ok=True)
        stream=self.path.open('a+b')
        if self.path.stat().st_size==0:stream.write(b'0');stream.flush()
        stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as exc:
            stream.close();raise LockBusy('This saved library or PDF is already in use.') from exc
        self.stream=stream;return self

    def release(self):
        if self.stream is None:return
        stream=self.stream;self.stream=None
        try:
            stream.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_UN)
        finally:stream.close()

    def __enter__(self):return self.acquire()
    def __exit__(self,*_):self.release()


def is_locked(path):
    try:
        with FileLock(path):pass
        return False
    except LockBusy:return True
