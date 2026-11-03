# Version 0.4.0 validation - 2026-10-24

Installed at %USERPROFILE%\Desktop\graphing\recognition-lab.
No Curious Mind code or data was incorporated. No user/course/workshop PDF was opened during implementation validation.

## Automated checks

The installed release passed 30 Python tests in 67.966 seconds:

- Seven existing recognition test groups, including the 22-image demo benchmark and reconstructed rendering.
- Ten focused image-reader regressions covering transparency, input limits, model JSON validation, failed inference handling, and cubic-inflection calculation.
- Thirteen synthetic PDF/HTTP/job checks covering native two-panel graphs, scanned two-panel pages, rotated page coordinates, explicit whole-page fallback, layout supplementation and failure reporting, actual local Heron-101 inference, native-resolution image preservation, malformed PDFs, invalid ranges, job cancellation/timeout, authenticated assets, and reuse of the actual graph reader.

Two JavaScript regression scripts passed: switching images clears stale sampled values; PDF navigation rejects late responses for an old region and sends the selected crop to the VLM endpoint. The VLM endpoint is a network double in the JavaScript test; live Qwen inference was not performed.

Python command (from the app folder):

    .venv\Scripts\python.exe -B -m unittest test_recognition test_audit_regressions test_pdf -v

JavaScript commands (Node.js required):

    node test_ui_regressions.cjs
    node test_pdf_ui.cjs

All package requirements passed pip check. Application and model files were copied with SHA-256 verification. The model download is pinned to revision 2e4993cf6bb211112084a2f80938f26138008917; its 306,814,140-byte weights were verified against publisher SHA-256 c11fe1df2087f29c77359834ac34700a5d9a41516b3387a3df0d7c3d52440c4e.

## Browser verification

In a local browser, uploaded a generated one-page worksheet with two vector graph panels in Quality mode, observed completion with two regions, opened a region in the existing results interface, switched to the next region, and read extracted page text. Controls, selection, uncertainty, and result heading updated correctly. A screenshot was saved in this chat's outputs folder.

The synthetic vector panels were detected, but their tick scales were not sufficiently readable by the existing numerical reader. The interface reported unreadable instead of inventing coordinates. A separate generated PDF containing the existing synthetic parabola demo did recover estimated coordinates after native-resolution preservation was added. Neither result establishes accuracy on arbitrary PDFs.

## Scope and remaining evaluation

No real workshop PDFs, actual NVDA speech/focus behavior, or live GPU Qwen inference were tested. These are separate next steps. General layout-model benchmark results do not establish graph recall, label completeness, or coordinate correctness on the user's materials. Existing graph calibration/curve fitting limitations remain.

Temporary-file and loopback tests initially encountered the agent execution sandbox's restrictions and were rerun with the necessary local access. Final results above are from the installed application environment.

Before overwriting existing source files, a backup was saved in a backup folder. New PDF files and model assets were added separately. The backup is a source backup, not a full copy of the Python environment or existing large graph models.
