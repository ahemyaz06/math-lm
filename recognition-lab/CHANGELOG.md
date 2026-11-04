# Recognition Lab changelog

## Unreleased - 2026-10-29 faster Qwen3.6 GPU layout (version number unchanged: 0.7.0)

- The `qwen3.6-35b` profile now chooses which layers' experts go to the GPU from the free GPU memory at start-up (`expert_layout`). It prefers the small IQ2_S layers 29 down to 12 (246 MiB each; the file stores the other layers as 364-396 MiB K-quants, and IQ2_S is the slowest kind for the CPU), keeps 600 MiB spare, and keeps every expert in RAM (`--cpu-moe`) when too little is free. Reason: on Windows an overfull GPU does not fail, it spills into shared memory; a page then took 50 s instead of 4.
- Page images go to the model in one 1024-token chunk (`-ub 1024 -b 2048`, a page is 958 tokens) instead of two, and the server keeps one request slot (`-np 1`) instead of reserving four.
- The server start now notices a server that exits while loading instead of waiting 60 s.
- Three request slots of 8192 tokens (`-np 3 -c 24576`) so Math Notebook can read two pages at once and describe a picture alongside: 8 pages 58.5 s -> 48.7 s with two at once and the same checker results (three at once 46.4 s, four 48.8 s). The slots raise peak VRAM by about 260 MiB, so the layout budget (`base_vram_mib`) is 3330 MiB and an idle card keeps 16 expert layers on the GPU (peak 7.48 GB on a 15-page import). `ensure_vlm_server` is now serialised with a lock so two threads never start two servers.
- The model uses only the 8 performance cores, one pinned thread each (`-t 8 -tb 8 -C 5555 --cpu-strict 1`; logical CPUs 0,2,...,14 on the i7-14650HX), leaving the efficiency cores to the rest of the computer. 8 pages: 64.7 s with the default 16 unpinned threads, 57.7 s pinned (writing 64 tokens/s), word-for-word the same output. 16 threads on the performance cores: 59.9 s; 8 unpinned: 61.4 s. The mask is specific to this processor layout.
- Validation (RTX 5060 Laptop 8 GB, the same 8 real course pages): old settings 74.9 s (writing 51 tokens/s); 18 IQ2_S layers on the GPU 63.4 s (57 tokens/s, peak 7.49 GB); all experts in RAM 81.9 s (3.07 GB). Outputs differ only in LaTeX spacing style and the wording of picture descriptions; the checker found the same notes in every setting. New unit test for the layout choice. No change to the model, image size or precision.

## Unreleased - 2026-10-29 model check fix and Qwen3.6 profile (version number unchanged: 0.7.0)

- Fixed: `_verify_server_identity` read `default_generation_settings.model`, which llama-server leaves empty, so any running model counted as a match and switching profiles never happened. Earlier "Qwen3.5-9B validated" results most likely ran on Qwen3-VL-8B. It now reads `model_path`.
- New profile `qwen3.6-35b`: a local Qwen3.6-35B-A3B file with its image file (mmproj-F16, unsloth) in models/qwen3.6-35b-a3b, run by a CUDA build of llama.cpp with `--n-cpu-moe 28`. Profiles can now name their own server executable and extra arguments; the server starts in its own folder.
- Validation: on 8 real course pages the checker found 3 real copying errors for Qwen3-VL-8B, 2 for Qwen3.5-9B, one broken page for Chandra OCR 2 and none for Qwen3.6-35B-A3B (about 10 s a page). Recognition Lab's own default profile is unchanged.

## Unreleased - 2026-10-29 exact vector graph reader (version number unchanged: 0.7.0)

- New `vector_graph.py`: graphs that a PDF draws with vector instructions (LaTeX TikZ/pgfplots, as in LaTeX course handouts) are read from those instructions instead of from pixels. Tick labels are PDF text with exact positions, snapped to grid lines; curves are point lists converted through the calibrated scale. It reports the drawn x/y range, each curve's colour and label (f(x) and so on), corners of straight pieces, turning points and x-axis crossings of smooth curves, open and solid dots, dashed lines, arrows meaning a curve continues, and blank answer grids. Curves drawn past the edge and hidden by LaTeX clipping are cut to the visible frame. Bold labels printed several times over are de-duplicated. If the labels do not form an even linear scale, no numbers are returned.
- Not yet used by this app's own UI; Math Notebook (`../notebook`) uses it through `pdf_inspector` candidates.
- Validation: 9 new tests in `test_vector_graph.py` against five real course graphs (expected values checked by eye against the rendered pages) plus helper tests; a deliberate clipping break fails them. Full suite: 127 tests, 4 skipped. Raster-only graphs still use the existing OCR reader. Actual NVDA speech was not tested.

## Unreleased - 2026-10-29 audit fixes (version number unchanged: 0.7.0)

User-scenario audit with hostile and unusual uploads. No new dependencies or models.

- Invisible PDF text is no longer read out. Characters whose rendered area shows no ink (white on white, invisible render mode over blank paper, text hidden under shapes) are left out of page text and nearby text, with a page warning giving the count. OCR text layers over scanned glyphs and white-on-black text are kept.
- Grayscale scans, photocopies and pencil graphs: when no curve is found, the reader retries once with lighter gray ink after removing grid lines, instead of reporting "No plotted lines or curves". The reading carries a note when this happens. Blank grids still report no curves.
- Transparent PNGs with white ink (dark-mode screenshots) are composited on black instead of white, so axes and labels stay visible.
- Rotated PDF pages: if a candidate cannot be read as displayed, it is turned upright and read again; the attempt is recorded.
- Text-only and blank PDF pages no longer create a "Whole-page review" item (a 150-page text PDF produced 150 empty items). Pages with any picture or drawing keep the explicit fallback.
- Clear upload messages: non-PDF files name what they look like (video, PNG, ZIP, text, web page); 0-byte files say they are empty; oversize files say which limit; password-protected PDFs say so; a PDF chosen under Image is told to use PDF; decompression-bomb images get the pixel-limit message; region/page failures show the reason instead of only "ValueError".
- A short prefix before %PDF- (for example a byte-order mark) within the first 1024 bytes is accepted, as PDF readers do.
- Server: the reader lock is released before the response is sent. Back-to-back requests could previously get a false "Another image is being read" (about 1 in 60 in testing).
- Local AI: stopping the AI server now verifies the saved PID is really llama-server before force-killing it and its children. A stale PID (after a crash or reboot) could otherwise end an unrelated program. Server start-up wait raised from 25 s to 60 s for cold model loads.
- Correction to 0.7.0 notes: decision_referee.py implements Layer 1 only; no Layer 2 judge endpoint exists in the code. Its layout-label checks never trigger in the PDF pipeline because candidates carry no layout label.

- The image picker now offers GIF, WebP, BMP and TIFF as well as PNG/JPEG. The reader already opened these; only the picker hid them.

Windows validation (same day, on a Windows PC): 117 Python tests passed (4 skipped), both Node UI suites passed, and GIF/WebP/BMP/TIFF copies of parabola-0.png gave the same detector status as the PNG. Live Qwen3-VL-8B ran on two real course PDF pages through vlm_helper. Actual NVDA speech was not tested.

Validation: all Python suites pass in a Linux workspace (Quality-mode and Qwen tests skip there: no layout model or GPU), plus 14 new regression tests in test_audit_20261029.py and an updated text-only-page test in test_pdf.py. 40 hostile/edge-case files were exercised through the HTTP API and a headless browser. Not performed: Quality mode with Heron-101, live Qwen inference, Windows-specific process handling, actual NVDA speech.

## 0.7.0 - 2026-10-29

Introduced Qwen3.5-9B multi-profile VLM architecture, process-isolated PID server management, curve continuity stroke preservation, upstream layout table matrix rejection with caption association, and a two-layer Decision Model Referee.

- Multi-profile VLM architecture: Added VlmProfile dataclass in vlm_helper.py supporting Qwen3.5-9B (Q4_K_M, 6.6 GB VRAM footprint, fits completely inside 8 GB VRAM with 1.4 GB overhead) alongside legacy Qwen3-VL-8B. Added direct JSON output (enable_thinking: False) and CLI flag parity (-c 4096, -b 512).
- Safe PID lifecycle management: Track llama-server PID in vlm_server.pid and verify port 9935 identity via /props, eliminating blanket taskkill /IM llama-server.exe to protect external local models (such as Local AI Hub on port 8090).
- Curve continuity stroke preservation: Fixed curve-severing flaw in reader.py line 350. Selective connected-component analysis inside OCR token bounding boxes erases only isolated text glyphs, preserving continuous mathematical function curves intersecting label polygons.
- Layout table rejection and caption association: In pdf_inspector.py, upstream Docling Heron-101 multi-class layout predictions now explicitly filter out table matrix regions from candidate graph pools and automatically link adjacent figure captions, prepending textbook context to candidate text.
- Decision Model Referee (decision_referee.py): Two-layer decision referee pattern. Layer 1 executes sub-millisecond deterministic candidate triage (filtering tables, dense prose, and extreme aspect ratios before 14s VLM invocations) and verifies VLM qualitative responses against prompt leakage, scene contradictions, and non-coordinate plane classifications. Layer 2 supports lightweight local judge endpoints.

Validation: 102 automated unit/regression tests passed (3 skipped); all 17 classical image recognition benchmarks passed with 0 regressions; live Qwen3.5-9B qualitative inference validated on parabola-0.png in 8.91s. Real calculus course PDFs from the course notes folder and open-source APEX calculus textbooks were stress-tested across 6 boundary suites (outputs/pdf-boundary-tests/boundary_test_results.json). Actual NVDA speech usability testing was not performed in this change.

Setup: Qwen3.5-9B-Q4_K_M.gguf and mmproj-F16.gguf are located in models/qwen3.5-9b-q4km. No new pip packages required; existing image reading remains fully functional without PDF/layout or VLM dependencies.

## 0.6.0 - 2026-10-26

Long PDFs now have a checked page count, configurable upload limits, automatic batches, saved checkpoints and a readable document export.

- Default PDF upload size is 20 MB; Settings persists an adjustable 1-100 MB limit and 1-100 pages per batch (default 100). Enforce limits on the server as well as the client. Image uploads remain limited to 10 MB.
- Count and validate PDF pages/ranges with PDFium before loading OCR or the layout model. Process up to 2,000 document pages in batches, reopen parser handles between batches, and retain warm models. Split dense batches before the 150-candidate budget is exceeded without dropping a page.
- Publish page text, graph IDs and next-page checkpoints atomically after each completed page. Cancel/restart/resume preserves completed work and replays unfinished pages safely.
- Save imports/preferences in the local RecognitionLab data directory. Retain history across shutdown, remove three-import eviction, protect libraries/imports with OS file locks, and reuse an already running library instance.
- Add document-wide graph navigation, one-time useful-result opening, short reading states, readable HTML export, Recent PDFs and explicit Resume. Stop polling permanent missing/session errors. Keep settings and technical details closed by default.
- Keep failed page notices explicit in exported reports, escape document text, validate saved metadata, and handle worker launch failure without losing the resumable import. Cancel supervises the Windows venv launcher and its owned child process tree.
- Keep the existing graph model/weights/configuration. The separate 22-request AI study found remaining perception and prompt/input-policy errors and did not establish a replacement winner.

Validation: 93 Python regression tests passed; both Node UI suites and JS syntax checks passed. A real 103-page synthetic document completed through cancel/server restart/resume, and three licensed calculus pages completed in three separate batches. Live browser checks covered Settings, saved history and cross-page navigation. See VALIDATION-0.6.0.md for evidence and limitations.

Setup: no new dependencies or model downloads over 0.5.0. Existing temporary imports are not migrated. Saved sources/results now persist locally and consume disk space; deletion UI, per-region retry and manual crop correction remain future work. No mathematical accuracy or actual NVDA usability claim.

## 0.5.0 - 2026-10-25

Simplified the opening screen and corrected localization, reading-evidence and worker-lifecycle failures exposed by real calculus PDFs.

- Show one PDF/Image upload workflow, with settings, keyboard help, source text, exports and diagnostics in closed disclosures. Retain visible focus, status, errors, cancellation and numerical keyboard exploration.
- Ignore invisible white PDF background shapes; preserve independent axis components through native/raster/layout fusion; keep padding inside panel gutters. Reject dense prose-only bordered boxes while retaining explicit page fallbacks and warnings for incomplete axis-free insets.
- Include agreeing observed outer tick labels in axis ranges, limited to the selected axis span. Withhold ambiguous dark dots in calibrated tick-label text corridors.
- Expand tick OCR windows only when associated labels show large glyphs extending beyond normal crops. Erase bold axes using measured thickness; withhold numerical traces with repeated ambiguous axis/tick dots. Require tighter pixel evidence for straight-piece and nonlinear function fits.
- Use compact, schema-validated qualitative AI descriptions with explicit unverified provenance. Reject malformed/truncated output and omit entire sentences containing detected numerical/formula claims, recording omissions. Numerical coordinates still come only from the existing OCR/geometry path.
- Default PDF local AI on when installed, with an option to turn it off. Reuse completed OCR when attaching the selected crop's AI description.
- Capture worker logs/exit codes, preserve last valid progress during transient manifest access failures, retry bounded Windows access failures during atomic publication, and wait for process exit before exposing terminal job status.

Setup: no new dependencies or model downloads relative to 0.4.0. Existing image reading remains available without optional PDF/layout dependencies.

Validation and limitations: see VALIDATION-0.5.0.md. Tests distinguish saved-layout replays, fresh full-pipeline page tests and real local AI spot checks. Candidate counts and response completion are not mathematical-accuracy measurements. Actual NVDA speech and the user's own workshop PDFs remain untested.

## 0.4.0 - 2026-10-24

Added a local PDF inspection layer.

- Upload one PDF and process a selected range of up to 100 PDF pages.
- Quality mode combines the original FP32 Docling Heron-101 layout model with PDF drawing/image geometry and raster-axis checks. Basic mode is an explicit alternative without the layout model.
- Preserve embedded raster resolution where possible and retry a second crop scale in Quality mode when the initial reading cannot calibrate. Retain attempted scales/statuses in the manifest.
- Render candidate regions from the source page with padding for labels, then reuse read_graph(), descriptions, sampled values, graph exploration, and existing exports.
- Navigate by PDF page and candidate region; read extracted native page text and nearby text. Text proximity does not establish question ownership.
- Retain bounding boxes, source SHA-256, methods, layout detections, uncertainties, and descriptions in a downloadable inspection manifest.
- Run PDF processing in a separate process with progress, cancellation, partial results, one active job, a 15-minute limit, and three-job retention. Private temporary files are removed on normal recognizer shutdown.
- Reuse the selected PDF crop when asking the existing local graph VLM; guard against stale asynchronous image/graph display.
- Preserve loopback Host, Origin, and local-token checks; protect document status and region assets with the token.
- Add pinned PDF/layout dependencies, a pinned and checksum-verified model downloader, and synthetic PDF/integration tests.
- Add AGENTS.md requiring README and changelog updates for future version upgrades.

Setup: requirements.txt adds PDFium/pdfplumber. requirements-layout.txt plus download_layout.py enable Quality mode. Models are loaded from local files only; uploads never initiate model downloads.

Limitations: experimental candidate localization; scans have graph OCR but no complete question-text transcript; multi-panel regions and labels can still be mis-segmented; inherited numerical graph-reader limitations remain. Encrypted PDFs are rejected. No arbitrary-PDF accuracy claim.

Validation: see VALIDATION-0.4.0.md for the exact checks and outcomes. Real user PDFs, actual NVDA speech, and live Qwen inference are reserved for subsequent evaluation.

## 0.3.0 - previous application version

Single-image OCR/geometry reader, estimated curve reconstruction, keyboard exploration, exports, and optional local Qwen3-VL. Historical evaluation remains in RESEARCH-REPORT.txt/HTML and applies to that version, not PDF extraction accuracy.
