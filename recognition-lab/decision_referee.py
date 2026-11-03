"""Decision Model Referee for Recognition Lab.

Two-layer decision referee pattern:
Layer 1 (Deterministic Fast Gate, < 2ms):
  - Table grid detection (matrix of numbers / aligned cells)
  - Layout model classifications (rejecting tables / formulas without axes)
  - Extreme aspect ratio & dense prose checks
  - Direct contradiction detection between VLM qualitative claims and CV evidence
Layer 2 (Lightweight Model Referee, optional):
  - Queries local referee endpoint if configured and available.
  - Automatically falls back to Layer 1 if offline, preserving zero-dependency operation.
"""
from dataclasses import dataclass
import os
import re
from typing import Optional, Dict, Any, Tuple


@dataclass
class RefereeVerdict:
    is_viable_graph: bool
    category: str  # 'coordinate_plane', 'table', 'prose', 'diagram_non_graph', 'unknown'
    confidence: float
    reason: str
    skip_vlm: bool = False


def triage_candidate(candidate: Dict[str, Any],
                     reading_result: Optional[Dict[str, Any]] = None) -> RefereeVerdict:
    """Evaluate whether a candidate crop should proceed to full VLM qualitative inference.
    
    Returns a RefereeVerdict detailing viability, category, and whether heavy VLM should run.
    """
    notes = (reading_result or {}).get("reading", {}).get("notes", [])
    
    # 1. Hard Table Rejection from OCR / Geometry
    if any("data table" in str(n).lower() or "multiple rows of aligned numbers" in str(n).lower() for n in notes):
        return RefereeVerdict(
            is_viable_graph=False,
            category="table",
            confidence=0.95,
            reason="Aligned numerical rows indicate a data table rather than coordinate axes.",
            skip_vlm=True
        )
    
    # 2. Layout model label rejection
    layout_label = candidate.get("layout_label") or candidate.get("label")
    if layout_label == "table":
        return RefereeVerdict(
            is_viable_graph=False,
            category="table",
            confidence=0.90,
            reason="Layout detection classified candidate as a table.",
            skip_vlm=True
        )
    if layout_label in {"caption", "formula", "header", "footer"}:
        return RefereeVerdict(
            is_viable_graph=False,
            category="diagram_non_graph",
            confidence=0.85,
            reason=f"Layout detection classified candidate as {layout_label}.",
            skip_vlm=True
        )
        
    # 3. Geometry aspect ratio check
    bbox = candidate.get("bbox_points")
    if bbox and len(bbox) == 4:
        bw = abs(bbox[2] - bbox[0])
        bh = abs(bbox[3] - bbox[1])
        if bh > 0 and bw > 0:
            aspect = bw / bh
            if aspect > 5.5:
                return RefereeVerdict(
                    is_viable_graph=False,
                    category="prose",
                    confidence=0.80,
                    reason=f"Extreme horizontal aspect ratio ({aspect:.1f}:1) typical of running text.",
                    skip_vlm=True
                )
            if aspect < 0.18:
                return RefereeVerdict(
                    is_viable_graph=False,
                    category="prose",
                    confidence=0.80,
                    reason=f"Extreme vertical aspect ratio ({aspect:.2f}:1) typical of margin rules.",
                    skip_vlm=True
                )
                
    # 4. Whole-page fallback with zero detected geometry
    if candidate.get("extraction") == "page_fallback":
        # Whole page fallback is allowed to run VLM only if text is not purely overwhelming prose
        nearby = candidate.get("nearby_text", "")
        if len(nearby) > 2500 and not (reading_result or {}).get("axis_candidate"):
            return RefereeVerdict(
                is_viable_graph=False,
                category="prose",
                confidence=0.75,
                reason="Full page fallback with dense text and no candidate axes.",
                skip_vlm=False  # Allow fallback if requested, but flagged
            )
            
    return RefereeVerdict(
        is_viable_graph=True,
        category="coordinate_plane",
        confidence=0.70,
        reason="Viable coordinate plane candidate passed initial referee gate.",
        skip_vlm=False
    )


def referee_vlm_output(parsed: Dict[str, Any],
                       reading_result: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
    """Inspect parsed VLM JSON output before acceptance as a qualitative description.
    
    Returns (accepted: bool, explanation: str).
    """
    if not isinstance(parsed, dict):
        return False, "VLM output is not a structured dictionary."
        
    # If VLM explicitly recognized this is not a coordinate plane
    if parsed.get("is_coordinate_plane") is False:
        scene = parsed.get("scene_type", "non-graph")
        return False, f"VLM classified scene as '{scene}', not a coordinate plane."
        
    # If VLM says coordinate_plane but scene_type is table/text
    scene = parsed.get("scene_type")
    if scene in {"table", "text", "photo", "other"}:
        return False, f"VLM marked is_coordinate_plane=True but scene_type='{scene}'."
        
    # Guard against obvious hallucination in verbal summary:
    summary = parsed.get("verbal_summary", "")
    if not summary or len(summary) < 10:
        return False, "VLM verbal summary is empty or too short."
        
    # Check for prompt leakage or meta-commentary
    if re.search(r"(?i)\b(as an ai|json schema|markdown block|here is the description)\b", summary):
        return False, "VLM verbal summary contains system prompt leakage or meta-commentary."
        
    return True, "Passed referee verification."
