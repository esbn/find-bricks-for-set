# Provenance and licences

The first-party vision/geometry kernel and local inference adapters were copied from the local brick-finder app on 2026-10-06. ENGINE_BASELINE.json records source hashes and adapter changes. They are independent vendored copies, not imports from another repo. No new licence is assigned to previously unlicensed first-party code.

The patch-based copy added one final blank line to kernel files; regression tests compare their source hashes allowing that newline only. Installer paths, including staging directories, are adapted to this app's `public/` assets.

The local SAM adapter additionally captures bounded diagnostic masks and keep/reject decisions for pipeline inspection. The initial instrumentation preserved filter outcomes. On 2026-10-07 the first-party adapter was further adapted to condition size/texture rejection on YOLO confidence, SAM quality and prompt containment, with diagnostic warnings and synthetic regression coverage (see ARCHITECTURE.md). The bridge reloads persistent workers after Python source updates. The vendored browser kernels remain unchanged.

Source-resolution tiling and per-proposal local SAM refinement were added as first-party adapters on 2026-10-07. No SAHI dependency, new model checkpoint, or cloud service is introduced; the existing YOLO and MobileSAM weights are reused. Source photos are transient, JPEG-encoded for the local transport, and excluded from Git and exports.

LDraw data remains a separately installed checksum-pinned dependency. Original authors/licence headers and CAreadme/CAlicense files are preserved. MobileSAM is pinned at f706ad9c4eb7f219c00d9050e46328518ffb65d2 (Apache-2.0). LEGO-specific YOLOv8 nano brick/stud checkpoints originate from MiguelDiLalla/Brickssifier_Studwise revision 3aef8aade8cb74a04780d5e809e49dfa1fc57a47; setup preserves its abbreviated Apache-2.0 licence file. Ultralytics 8.3.40 inference is AGPL-3.0; its package/licences remain in the isolated installation. Tube detection is first-party OpenCV code, not a trained tube checkpoint.

Set data is downloaded separately from public Rebrickable CSVs, with source URLs and input hashes recorded by setup. Its applicable terms govern redistribution. This app does not claim production/sales statistics or audited universal cross-system ID equivalence. No third-party dataset, model weights, personal photo or generated index is distributed in Git. Fonts are system fonts, and the application does not automatically load remote set images.
