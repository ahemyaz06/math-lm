# Recognition Lab 0.5.0

October 25, 2026. This upgrade simplifies the interface and fixes demonstrated PDF localization, axis-reading and response-handling problems. It does not establish reliable reading of arbitrary workshop graphs.

## What changed

- One visible PDF/Image upload form. Options, source text, keyboard help, uncertainty, exports and technical details stay closed until requested. Results focus moves to the reading heading; the description is presented once. Processing errors and Cancel remain visible when needed.
- Independent coordinate panels survive PDF/native/raster/layout fusion. Invisible white PDF backgrounds no longer merge them. Crop padding respects neighboring panels.
- Dense bordered prose without internal axes is rejected as a graph candidate. A whole-page fallback remains an explicit review item.
- Tick crops expand only when already associated OCR labels demonstrate that fixed windows cut off large glyphs. Agreeing outer labels are retained inside the selected axis segment.
- Bold-axis erasure follows measured stroke thickness. Ambiguous repeated dark points at ticks/axes require review; numerical traces are withheld. Dark dot candidates at calibrated tick-label text positions are also withheld.
- Proposed straight-piece and nonlinear function fits need tighter pixel evidence. A poor named-function fit falls back to measured stroke samples, rather than an asserted equation.
- Local AI uses a compact qualitative schema, lossless image input, validation, whole-sentence numerical/formula filtering and at most one correction request. Valid prose is explicitly unverified. AI cannot calibrate axes. PDF AI defaults on when installed; Options permits opting out. Completed OCR is reused for AI attachment.
- Worker logs and exit codes survive failures. Atomic manifest publication retries bounded Windows access failures; status preserves the last good snapshot and becomes terminal only after worker exit.

No Curious Mind code was imported. No new model or dependency installation is required over 0.4.0. README.txt and CHANGELOG.md are updated with the version.

## Validation

- **64 Python tests passed**, including the existing 22-image benchmark, PDF integration/HTTP tests, panel regressions, tick/curve/worker regressions and AI validation tests. See [test log](outputs/recognition-lab-0.5.0/release-validation-tests.log).
- Both [image UI](outputs/recognition-lab-0.5.0/ui-tests.log) and PDF UI behavior suites passed, with JavaScript syntax checks. These include real HTML/ARIA contracts, source switching, stale response isolation, selected-crop requests, focus, folded details, default AI availability and explicit opt-out.
- The same twelve openly licensed calculus PDFs and fixed four-page ranges were processed with fresh Heron inference. **48/48 pages completed; 12/12 jobs completed**, all with exit code zero. This is a convenience sample selected before recognition, not a random sample or graph-recall benchmark.
- The final control pass uses Quality inspection with AI off, isolating localization and the existing numerical reader. It produced **102 regions: 84 candidates and 18 whole-page fallbacks**. Recognition statuses: `{"estimated_coordinates": 2, "unreadable": 100}`. Numerical estimates are not manually certified successes.
- Seven fixed real crops were also evaluated using the existing local Qwen model: seven final responses were complete JSON; six passed publication checks after filtering and bounded correction. **That is response validation, not mathematical accuracy.** See [manual AI findings](outputs/recognition-lab-0.5.0/ai-evidence/README.md).
- A real browser test uploaded APEX Calculus 2, selected PDF page 19, used default local AI, opened an extracted region, refreshed/reconnected, and exported the PDF results. Both candidate regions produced qualitative descriptions. The first correctly described the horizontal blue line with shading beneath it. [Exported manifest](outputs/recognition-lab-0.5.0/browser-pdf-manifest.json), [raw region results](outputs/recognition-lab-0.5.0/browser-e2e/graph-1.json), [result screenshot](outputs/recognition-lab-0.5.0/pdf-reading.png).
- Actual NVDA speech and the user's workshop PDFs were not tested.

## Demonstrated fixes

| Source case | Earlier behavior | New behavior |
|---|---|---|
| Active Calculus workbook 1, PDF p57 | Six coordinate panels collapsed into one crop | Six separate panels; includes two plotted graphs and four blank answer grids |
| CLP-1 Exercises, PDF pp110-113 | Eight bordered prose boxes proposed as graphs | Zero graph candidates from those boxes; four explicit whole-page fallbacks |
| Strang, PDF p70 | Five crops each combining adjacent plots | Ten separately localized plots, matching visual inspection |
| Whitman, PDF p52 | Reported X labels -2 to 2 and a spurious point from a digit | X labels -3 to 3 retained; ambiguous digit-derived point withheld |
| APEX Calculus 1, PDF p160 | Last visible X label missed; large tick crops cut glyphs | Targeted final reading retains X labels 0 to 4 and Y labels 0 to 15 |
| Active workbook 1, PDF p59 | Bold axis edges/erased ticks contributed false curves and dots | Thick axes erased more fully; ambiguous tick artifacts prevent numerical trace publication |

Panel evidence includes an inspector-only replay of all 48 pages using saved model detections. Its counts differ from the fresh full pipeline and from the old partial 42-page baseline. They must not be combined or interpreted as recognition accuracy. See [panel evidence](outputs/recognition-lab-0.5.0/panel-evidence/README.txt).

## Final control pass by document

| PDF ID | Pages | State | Regions | Page fallbacks | Numerical estimates |
|---|---:|---|---:|---:|---:|
| 03-clp1-text | 4/4 | complete | 9 | 1 | 0 |
| 04-clp1-problems | 4/4 | complete | 4 | 4 | 0 |
| 05-clp2-text | 4/4 | complete | 4 | 2 | 0 |
| 08-active-workbook1 | 4/4 | complete | 9 | 2 | 0 |
| 09-active-workbook2 | 4/4 | complete | 8 | 2 | 0 |
| 10-apex-calc1 | 4/4 | complete | 16 | 0 | 1 |
| 11-apex-calc2 | 4/4 | complete | 6 | 0 | 0 |
| 13-contemporary-calc2 | 4/4 | complete | 11 | 1 | 0 |
| 14-whitman-single | 4/4 | complete | 8 | 1 | 1 |
| 15-strang-calculus | 4/4 | complete | 17 | 1 | 0 |
| 16-clp1-workbook | 4/4 | complete | 6 | 1 | 0 |
| 17-clp2-workbook | 4/4 | complete | 4 | 3 | 0 |

## Remaining limits

The numerical reader is still unreliable for complex workshop figures. Open circles, discontinuities, touching annotations, dense grid lines and hand-drawn/scribbled strokes can be missed or misinterpreted. Some source text has broken PDF font encodings. Candidate extraction can still include diagrams or incomplete panels; splitting an enclosure can omit an axis-free zoom inset or connecting diagram.

The final AI spot checks still contain omissions and wrong limitations: several responses claim no visible ticks even when ticks are present; the Contemporary illustration misses a dashed diagonal, and the small Strang panels receive an incomplete description. The complex Active graph was rejected. Qualitative filtering does not prove that retained statements are true. Full 48-page processing with AI on was not benchmarked; the control pass and seven-crop checks are separate.

The earlier intermittent worker failures did not recur in either full rerun. Their original root cause remains unconfirmed. Log capture, atomic-write retry and lifecycle tests improve diagnosis and handle specific demonstrated failure modes; they do not prove all process failures are eliminated.

Timing occurred during development with other local validation running. No speed-improvement claim is made. More candidate regions or more fallbacks are not an accuracy score. Further work should use labelled per-panel crops, explicit open/closed marker recognition and source-supported qualitative descriptions before attempting broader numerical recovery.

## Evidence and source rights

Original PDFs, publisher links, authors, hashes and license conditions remain in the [calculus collection](outputs/calculus-pdf-evaluation/index.html). Source PDFs were not changed or used for training. Each copied crop folder retains its source/license notice. Some sources require attribution, noncommercial use and/or sharing adaptations under the same license.

- [Final manifests and counts](outputs/recognition-lab-0.5.0/final-calculus-retest/summary.json)
- [First development rerun](outputs/recognition-lab-0.5.0/calculus-retest/summary.json)
- [Targeted reader follow-up](outputs/recognition-lab-0.5.0/targeted-reader/summary.json)
- [Preserved baseline OCR replay](outputs/recognition-lab-0.5.0/whitman-reading-replay.json)
- [AI evidence and limitations](outputs/recognition-lab-0.5.0/ai-evidence/README.md)
- [Opening screen](outputs/recognition-lab-0.5.0/interface.png) and [real PDF reading](outputs/recognition-lab-0.5.0/pdf-reading.png)

Installation and source hashes are recorded separately in installation.json after deployment. Previous modified application files are backed up before replacement. Existing user documents and model weights are not overwritten.
