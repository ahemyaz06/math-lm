"""Local figure layout model, independent of the mathematical reader.

Uses the original FP32 Heron-101 weights, not a quantized approximation.
Model scores are localization evidence, not probabilities of graph correctness.
"""
from pathlib import Path
import importlib.util

MODEL_DIR = Path(__file__).parent/'models'/'layout-heron-101'


def available():
    return all(importlib.util.find_spec(m) for m in ('torch', 'transformers', 'safetensors')) and all(
        (MODEL_DIR/name).is_file() for name in ('config.json', 'preprocessor_config.json', 'model.safetensors'))


class LayoutDetector:
    def __init__(self):
        import torch
        from transformers import RTDetrImageProcessorPil, RTDetrV2ForObjectDetection
        # CPU avoids competing for VRAM with the existing local Qwen model.
        torch.set_num_threads(4)
        self.torch = torch
        self.processor = RTDetrImageProcessorPil.from_pretrained(MODEL_DIR, local_files_only=True)
        self.model = RTDetrV2ForObjectDetection.from_pretrained(MODEL_DIR, local_files_only=True,
                                                               use_safetensors=True).to('cpu').eval()

    def predict(self, image, width, height):
        inputs = self.processor(images=[image.convert('RGB')], return_tensors='pt')
        with self.torch.inference_mode():
            outputs = self.model(**inputs)
        result = self.processor.post_process_object_detection(outputs, threshold=.35,
            target_sizes=self.torch.tensor([[height, width]]))[0]
        records = []
        for score, label, box in zip(result['scores'], result['labels'], result['boxes']):
            name = self.model.config.id2label[int(label)].lower().replace('-', '_').replace(' ', '_')
            if name not in ('picture', 'table', 'caption', 'formula'):
                continue
            x0, y0, x1, y1 = map(float, box.tolist())
            bbox = [max(0, x0), max(0, y0), min(width, x1), min(height, y1)]
            if bbox[2]-bbox[0] >= 5 and bbox[3]-bbox[1] >= 5:
                records.append({'label': name, 'score': round(float(score), 4), 'bbox_points': bbox})
        return records
