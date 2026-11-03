# Recognition Lab 0.6.0 validation

October 26, 2026. The PDF import workflow is improved; the graph-reading model has not been replaced or certified as reliable.

## Delivered behavior

- PDF uploads default to **20 MB**, adjustable from 1 to 100 MB in closed Settings. Pages per batch default to 100 and are adjustable from 1 to 100. The server enforces both values. Image uploads retain the 10 MB ceiling.
- PDF page counts and selected ranges are checked before model loading. A whole document up to 2,000 pages can run automatically; dense figures may create additional batches beyond the planned page batches.
- Completed pages are saved atomically. Cancel, server restart and Resume preserve their graph IDs and page text. An incomplete page is replayed instead of publishing half its results.
- Recent PDFs persists across app shutdown. A single graph list spans the document; Previous/Next crosses page boundaries. The first useful result opens once without stealing focus. Save descriptions produces portable readable HTML; technical JSON remains optional.
- Permanent missing/session errors stop polling. Source data is escaped in HTML. File locks prevent two app instances or resumed workers from writing the same library/import concurrently.
- The current Qwen model, quantization and inference defaults remain installed. No additional model weights were downloaded and no Curious Mind code was imported.

## Tests actually performed

- **93 Python tests passed** in [all-tests.log](outputs/recognition-lab-0.6.0/all-tests.log), including the existing 22-image suite, PDF/HTTP tests, worker checkpoint and candidate-budget tests, storage/lock/schema tests and AI response validation.
- Both Node UI suites and JavaScript syntax checks passed; [UI log](outputs/recognition-lab-0.6.0/ui-tests.log). These exercise settings/limits, cached preflight, long ranges, navigation, auto-open/manual-selection protection, history/resume/export, permanent/transient errors and stale-result isolation.
- A **real 103-page synthetic PDF** was preflighted into 100+3 page batches without model loading. Processing was cancelled after **3 completed pages**, then the server/library was closed and reopened. Resume completed all **103 pages** in two actual batches with exactly one saved record per page and graph ID. [Lifecycle evidence](outputs/recognition-lab-0.6.0/lifecycle-validation.json), [readable result](outputs/recognition-lab-0.6.0/103-page-results.html).
- **Three licensed APEX Calculus 2 pages, PDF pages 19-21**, completed with fresh Quality inspection in **three separate one-page batches**. AI was off for this workflow test. [Manifest](outputs/recognition-lab-0.6.0/real-pdf-batches/manifest.json), [readable export](outputs/recognition-lab-0.6.0/apex-descriptions.html), [source/license notice](outputs/recognition-lab-0.6.0/APEX-SOURCE-AND-LICENSE.txt).
- Worker tests separately processed 205 fake-inspected pages across three parser lifetimes and a 168-candidate case across the candidate-budget boundary; these verify batching behavior, not recognition accuracy. They also verify source-change rejection, a never-started import resume, cancellation before models, interrupted-page replay and a real Windows lock conflict.
- Live browser checks confirmed Settings save/update, the 20 MB restored default, saved history after restart, and navigation from graph 2 on PDF page 19 to graph 3 on PDF page 20. [Settings screenshot](outputs/recognition-lab-0.6.0/settings.png), [navigation screenshot](outputs/recognition-lab-0.6.0/navigation.png).
- The v0.5 48-page/12-PDF mathematics control pass remains historical evidence. It was not rerun for this workflow release. Actual NVDA speech and the user's workshop PDFs remain untested.

## Why the AI can still fail

The separate investigation reviewed **22 completed requests on three fixed crops**, changing image detail, vision budget, panel isolation, source context, prompt and a minimum-token floor. All returned complete JSON; mathematical mistakes remained. More detail helped one matched Active Calculus example, but other changes introduced or retained false features. Neither a larger token minimum nor source context was a universal fix. Four-bit quantization was not isolated in a matched precision comparison.

[Full AI analysis and current model candidates](outputs/recognition-lab-0.6.0/ai-analysis/REPORT.md) distinguishes input/prompt faults from perception errors. Qwen3.5-9B/4B and Gemma 4 E4B QAT merit a controlled comparison with the current model; none was downloaded or shown to be better here. Model footprint, vision components, context/cache memory, runner compatibility, speed and mathematical errors all need measurement before selecting a replacement.

## Remaining limits

Complex graph descriptions, coordinates, open/filled markers and discontinuities can still be wrong. This release addresses import workflow, not that underlying accuracy limit. Validated JSON does not verify mathematics. Empty grids, diagrams and whole-page fallback regions can still clutter results. Native PDF font encodings can damage extracted source text.

Resume covers unfinished pages, not selective re-reading of already processed failed regions. The UI still lacks manual crop correction, labelled graph-training/benchmark tools, and an import deletion control. Local sources and results remain on disk until removed outside the app; old temporary v0.5 imports are not migrated. A completely unreadable/corrupt checkpoint may require re-upload. Batch/processing completion is separate from reviewing all results.

The control tests do not establish throughput or accuracy on a fully illustrated 2,000-page book with AI enabled. The 15-minute limit is per batch; very dense or slow batches may need resume or smaller future batch settings. A resumed import retains its original settings and selected range.

Installation.json records the backed-up source files and installed hashes after deployment. Source PDFs in the calculus corpus remain unchanged. Model weights and existing user documents are not overwritten.
