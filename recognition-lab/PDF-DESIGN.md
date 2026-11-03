# PDF inspection design and engine choice

The PDF layer is independent of mathematical graph recognition. No Curious Mind source or conversion data is reused.

Pipeline: upload -> isolated worker -> native text/geometry + rendered page -> trained figure layout + geometry candidates -> label padding -> source-page PNG crop -> existing read_graph -> document manifest + existing graph UI.

## Engines

PDFium (pypdfium2 5.14.0) renders the displayed PDF page, including raster and vector graphics. Crops are re-rendered directly from the source at a resolution suited to the existing reader's 1,400-pixel analysis limit. For embedded rasters, native pixel-density hints prevent unnecessary enlargement. Quality mode retries a second raster scale when the first cannot calibrate; the manifest records each attempt and the chosen crop remains paired with its matching result. PDF geometry and rendered coordinates are kept separate from mathematical graph coordinates. Rotated/cropped pages with mismatched native coordinate dimensions use rendered geometry instead of incorrectly transforming native boxes.

pdfplumber 0.11.9 exposes positioned text, lines, rectangles, curves, and image bounds. It supplies additional region candidates and nearby text. It does not recognize equations from plotted curves. Native extraction is not OCR of scanned question text.

The quality default uses Docling's original FP32 Heron-101 RT-DETR model. It localizes document figures. PDF geometry and raster checks supplement it because figure models can combine panels or miss sparse mathematical diagrams. The original model is loaded locally with PyTorch CPU, preserving GPU memory for Qwen. No quantization is introduced. Model provenance pins the publisher revision and verifies downloads by size and digest.

This is not a claim that Heron-101 is universally best for workshop graphs. Its publisher reports the strongest result among the layout models in its study. That general document benchmark does not measure our graph extraction or mathematical accuracy. The inference adapter is separate so a measured replacement can be introduced without rewriting the PDF or graph reader.

Alternatives researched: PyMuPDF offers convenient drawing clustering and clipped rendering; a larger renderer rewrite does not itself supply learned graph localization. Full Docling adds document assembly, OCR, and table functionality beyond this release. PaddleOCR's PP-DocLayout family is another credible layout backend. MinerU offers broader document conversion and VLM tiers. No evidence establishes a universal winner for these user's worksheets, and full-document OCR scores do not establish coordinate accuracy. Future comparisons should measure missed graphs, panel separation, label coverage, false positives, recognition success, and wrong numerical claims on the same labeled PDFs.

## Result contract and limits

The manifest retains source SHA-256, selected source-page numbers, page text, document/layout warnings, detected layout elements, crop bounding boxes in displayed PDF points, nearby text, attempted methods, and each region's recognition status/description. Nearby text is not automatically assigned to a question. Model scores are evidence, not calibrated correctness probabilities.

Candidate status is separate from mathematical recognition. A page with no region proposals is processed as an explicitly labeled whole-page fallback. There is no assertion that all graphs were found. Tables, photos, and diagrams may be retained as candidates; the existing reader can reject unsupported material. Rendering from the page retains composite vector/image/text content rather than exporting only embedded image objects.

Limits: 50 MB upload; 2,000 pages in the document; 100 selected pages; 12 regions per page; 150 regions per job; 15 minutes per job; one active job; three recent jobs retained in private OS temporary storage. Normal shutdown deletes temporary storage; a forced OS/process crash may leave temporary files. Download needed results before stopping. Cancellation terminates the isolated worker and preserves the last atomically saved completed regions. It cannot preserve an in-flight region. App restart expires all job links.

Documents are never uploaded to external inference services. Dependency/model downloads are explicit setup operations. Uploaded text is rendered through textContent. The model has no tool execution path. PDF libraries run in a cancellable separate process; this is crash isolation and bounded workflow, not a security sandbox for hostile native-library exploits.

## Primary research references

- PDFium bindings, rendering/crop and threading contract: https://pypdfium2.readthedocs.io/en/stable/python_api.html
- Positioned native PDF objects: https://github.com/jsvine/pdfplumber
- Layout model publisher: https://huggingface.co/docling-project/docling-layout-heron-101
- Layout evaluation paper: https://arxiv.org/abs/2509.11720
- Docling model catalog: https://docling-project.github.io/docling/usage/model_catalog/
- Docling figure exports: https://docling-project.github.io/docling//_generated/examples/export_figures/
- PaddleOCR layout documentation: https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/layout_detection.en.md
- MinerU runtime/tier documentation: https://opendatalab.github.io/MinerU/usage/tiers/


## 0.5.0 evaluation-driven corrections

Independent axis components take precedence over enclosing native/model bounds.
Invisible white background shapes cannot join panels. Dense bordered prose is
rejected only when it has a closed enclosure, sufficient native prose and no
interior line intersection. Whole-page fallbacks remain review items, never
confirmed graphs. Splitting enclosures can omit axis-free insets; record this
warning. Readings can now have qualitative_description status, which must not
enable numerical exploration or coordinate export. The local AI response has
unverified provenance and cannot calibrate axes. Worker logs/exit codes belong
to the private job; terminal API state is held until actual worker exit.
See VALIDATION-0.5.0.md for evidence and remaining limits.


## 0.6.0 import lifecycle

settings.py persists validated PDF limits. pdf_plan.py performs PDFium-only
page preflight before expensive model loading. pdf_worker.py reopens parser
handles at page/candidate batch boundaries, keeps models warm, and commits each
completed page with its global graph IDs and next_page checkpoint. Interrupted
page assets are not published and are overwritten safely on resume. The source
hash/range/options are checked before resumed processing.

PdfJobs uses a persistent document library in the real server (temporary roots
remain available for tests). A library lock prevents simultaneous app owners;
an import worker lock prevents concurrent resume after an unexpected parent
exit. Saved metadata is schema-checked before status/history/report use. The
server exposes authenticated settings, cheap preflight, history, resume, and
readable HTML report endpoints; existing Host/Origin/token restrictions remain.
Batch boundaries do not establish graph correctness. The installed AI model
and inference settings are unchanged by this release.
