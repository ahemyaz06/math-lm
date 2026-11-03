"""Explicit, pinned model download; the application never downloads on upload."""
from pathlib import Path
import hashlib
import json
import urllib.request

MODEL_ID = 'docling-project/docling-layout-heron-101'
REVISION = '2e4993cf6bb211112084a2f80938f26138008917'
FILES = {
    'model.safetensors': (306814140, 'sha256', 'c11fe1df2087f29c77359834ac34700a5d9a41516b3387a3df0d7c3d52440c4e'),
    'config.json': (3269, 'git', 'd92583081ec7a2297ac9610bf705f4591f45f194'),
    'preprocessor_config.json': (444, 'git', 'fcdff16b42e5ebc51d28f59184490c6eff91a88b'),
    'README.md': (3114, 'git', '5ee57f93eda4ed3c7579a2bcf0d69427165cf25d'),
}


def verified(path, spec):
    size, kind, expected = spec
    if not path.is_file() or path.stat().st_size != size:
        return False
    digest = hashlib.sha256() if kind == 'sha256' else hashlib.sha1(f'blob {size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest() == expected


def download(folder=None):
    folder = Path(folder or Path(__file__).parent/'models'/'layout-heron-101')
    folder.mkdir(parents=True, exist_ok=True)
    for name, spec in FILES.items():
        path = folder/name
        if verified(path, spec):
            print(f'Verified {name}', flush=True)
            continue
        temp = path.with_suffix(path.suffix+'.part')
        print(f'Downloading {name} ({spec[0]:,} bytes)', flush=True)
        try:
            with urllib.request.urlopen(f'https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{name}', timeout=60) as response, temp.open('wb') as stream:
                while chunk := response.read(1024*1024):
                    stream.write(chunk)
                    if stream.tell() > spec[0]:
                        raise ValueError('Download exceeds expected size.')
            if not verified(temp, spec):
                raise ValueError(f'Size/checksum verification failed for {name}.')
            temp.replace(path)
        finally:
            if temp.exists():
                temp.unlink()
    provenance = {'model_id': MODEL_ID, 'revision': REVISION, 'license': 'Apache-2.0',
                  'files': {name: {'bytes': spec[0], 'verification': spec[1], 'digest': spec[2]} for name, spec in FILES.items()}}
    (folder/'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    print('Layout model ready. Processing is offline.', flush=True)


if __name__ == '__main__':
    download()
