# Find bricks for a set: implementation plan

User story: choose a LEGO set, photograph separated loose bricks, and highlight the pieces that are needed, with quantity-aware review.

1. Create an independent repository. Vendor the proven brick-finder CAD, segmentation and descriptor kernel with provenance; adapt offline setup to this app's assets. No runtime sibling dependency.
2. Build a local searchable set catalogue from Rebrickable bulk CSVs, expand nested set/minifigure inventories, exclude spares by default, and expose exact part/colour/quantity requirements. Explicitly flag unsupported mappings and decoration ambiguity.
3. Use local LEGO YOLO + SAM and hollow-tube detection. Compare cached CAD views only for mapped parts in the chosen set. Report detection/search progress and support cancellation. Unknown or weak matches remain unresolved, not force-fit to the set.
4. Estimate colours conservatively. Allocate at most one requirement to each photographed physical brick, respecting per-part/colour quantities with a globally optimised capacity-constrained assignment. Preserve manual confirmations and distinguish likely/uncertain/confirmed/unassigned.
5. Build a photo-overlay workspace and a side-by-side crop/CAD review panel with rotation/reset, candidate cycling, manual assignment, confirmation and rejection. Clicking the photo/requirements links the views. Show confirmed, suggested and still-unlocated quantities separately.
6. Verify core matching/assignment, set expansion, quantity caps, corrections, transport/privacy, repository isolation and actual browser flows. Document limits and setup. Initialise local Git, without publishing a remote.

First release: uploaded still photos, up to 100 separated pieces per batch. Not live camera tracking. No calibrated recognition probabilities, guaranteed discovery, print/mould identification or promise that a matching silhouette proves set membership. Colour is estimated and user review remains important.

All six implementation steps completed and verified. See VALIDATION.md for the automated and browser results. Live camera tracking and a labelled recognition accuracy evaluation remain outside this first release.
