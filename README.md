# Find bricks for a set

A local photo workbench for finding loose LEGO pieces needed by a selected set. Choose a set, upload a photo of separated pieces, identify against that set's mapped CAD parts, inspect the overlay, then confirm or reject suggestions. No cloud photo inference or API key is required.

## Setup

Use Node.js 22.9+, `uv` and Python 3.11.

```sh
npm ci
npm run setup:ldraw
npm run build:index
npm run setup:yolo
npm run setup:sets
npm start
```

Open http://localhost:8002. `PORT` changes the port. Index preparation is a one-time, resumable operation; `--jobs 8` selects concurrency. Dependencies and generated data stay ignored. `SAM_PYTHON=/path/to/python3.11` selects an interpreter. On the tested Intel Mac the pinned CPU runtime is used; local model installation creates this app's own `.venv-sam/`.

If brick-finder is already installed, optionally use `npm run setup:local -- --from /path/to/brick-finder` before setup. This **copies data** into this repo; it does not create runtime sibling imports or links. You still need this app's own Python environment and set database. The `BRICK_MODEL_CACHE` environment variable can point at an existing uv cache during installation only. Updating set data uses `npm run setup:sets -- --refresh`; restart the server afterwards.

## Workflow and limits

Search by set number/name, then upload a photo or try the synthetic workshop demo. Identify compares only mapped part families required by that set. Colours are estimated, not verified. Quantity-aware allocation cannot assign more bricks than the set needs. Likely suggestions and ambiguous suggestions are distinguished from explicit confirmations; neither implies certainty. Clicking the photo or a region opens side-by-side crop/CAD review. The CAD view rotates, has a reset control and does not alter identification evidence. You can cycle set candidates, manually assign an inventory line, confirm or reject a region. Counts distinguish confirmed, suggested and not located. A JSON report contains IDs/counts/review state, not image pixels.

Initial scope: uploaded still photos and up to 100 separated pieces per batch. Overlay highlights are photo-space annotations, not live camera pose tracking. Touching/occluded pieces, shadows, unusual moulds, plates versus bricks and colour/printing ambiguity remain limitations. A closest match in a constrained search is not proof of membership. Unknown, surplus and unmapped parts remain visible/unresolved, not silently accepted. Printed geometry can match its base, but printing itself is not recognised. Nested set/minifigure inventories are expanded; missing dependencies are reported as incomplete rather than hidden. Recognition is not guaranteed for all required parts.

Set data comes from public [Rebrickable CSV downloads](https://rebrickable.com/downloads/); catalogue/mapping coverage is partial. Exact shared IDs, explicit LDraw redirects and documented print families are mapped, without guessing mould equivalence. The downloaded set database and CAD/model/index assets are not committed. All processing after setup is local. Refresh clears the working photo/review session; export the report before closing.

Run `npm test` for synthetic, mocked-inference and local HTTP tests. See PLAN.md, ARCHITECTURE.md, PROVENANCE.md and VALIDATION.md.

## Pipeline inspection

YOLO + SAM now uses source-resolution tiled detection by default. The browser retains the decoded original (up to 32 megapixels and 10,000 pixels per edge), sends a quality-95 JPEG to the local worker, and keeps an at-most-1800-pixel working photo for review/search. Detection combines a whole-image pass with 1536-pixel source tiles overlapping by 25%, merges overlapping boxes, and refines each merged box with SAM on a padded local source crop. Stud/tube detection also uses local source crops. Tile and crop progress is visible; all masks and feature locations are mapped back to the working photo. Photos remain in memory and are never sent to a cloud service. This is slower than the previous whole-image path, especially on CPU; it is intended to improve small-part recall, not guarantee detection. SAM-only and threshold modes retain their existing behaviour.

Buttons above the input photo switch between Original, YOLO boxes, SAM proposals, Cleaned masks, Rejected masks, Retained regions, Studs & tubes and Set matches. Run identification first to populate the stages; unavailable stages are disabled (for example YOLO boxes in SAM-only mode). Stage switching reuses stored results, without rerunning inference or changing matches.

Click a SAM/cleaned/rejected mask to inspect its proposal ID, rejection reason, SAM quality and texture ratio. Masks have opaque contours with dark contrast halos, including boundaries around holes; the fill stays translucent. The same contours appear in retained-region and surface-feature views when SAM diagnostics are available. Proposal IDs correlate with retained-region labels. Diagnostic views show all available proposals independently of inventory/colour filters; “rejected” means discarded by detection filtering, not excluded by manual review. Masks retain holes and are mapped from SAM's working resolution to photo coordinates. Up to 400 diagnostic proposals are retained, with an explicit notice if truncated. A new photo clears diagnostic results. Threshold segmentation provides retained-region inspection but no YOLO/SAM stages.

Optional local filter regression: `.venv-sam/bin/python tests/pipeline_filters.py` (no models or personal photo needed).

Tiling regressions: `.venv-sam/bin/python tests/tiled_pipeline.py` (synthetic/mocked inference). Restart the server and reload/re-upload your photo after this update; previously downsized browser images cannot recover their discarded source detail.

YOLO-supported masks (detector confidence ≥0.2, SAM quality ≥0.8, at least 90% of mask pixels inside the slightly expanded detector box) use a smaller minimum area. Carpet-like texture becomes an inspection warning rather than an automatic veto for these masks. Duplicate, image-boundary and large-background checks remain active. SAM-only proposals retain the conservative rules. These thresholds are heuristics, not calibrated confidence in part identity.

After updating the app, restart `npm start`, refresh the browser and identify again once. Older persistent workers may not supply intermediate masks; the UI now explains this explicitly rather than leaving unexplained disabled buttons. New workers reload automatically between requests when their Python source changes. Cached results lacking diagnostics are not reused. Threshold mode intentionally has no intermediate SAM outputs.

## Custom inventory

Import JSON in “Use a custom parts list”. IDs must be LDraw/shared part IDs; unmapped IDs remain manual-only. Combine duplicate part/colour lines. Example:

```json
{"set":{"number":"my-build","name":"Practice build"},"parts":[{"id":"3001","quantity":2,"color":{"id":4,"name":"Red","rgb":"C91A09"}}]}
```

Colour `id` is optional (RGB is used as the key otherwise); `isTrans:true` disables automatic colour allocation for that line. Maximum 1000 lines and 1 MB per file. This does not fetch an official inventory or verify a custom list’s authenticity.

## Browser verification

With CAD/index assets installed, run `npx playwright install chromium` once, then `npm run test:browser`. To use an existing Chrome instead, set `CHROME_PATH` to its executable. Optional `TEST_PHOTO=/absolute/path/to/photo.png` exercises local YOLO/SAM against set 11013 without sending the photo elsewhere; `TEST_SET=60391` changes the test set. The synthetic test checks stud grids, set-only scope, quantity limits, review/corrections, rotation/reset, mask hit-testing, report download and mobile layout. It is not a recognition accuracy evaluation.
