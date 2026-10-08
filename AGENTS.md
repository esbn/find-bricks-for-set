# Project guidance

Read README.md, PLAN.md and ARCHITECTURE.md before editing. This is an independent local app; no runtime imports, symlinks or HTTP dependencies on sibling apps. Preserve vendored engine provenance and licences. User photos, models and generated datasets/indexes must not enter Git. Tests use synthetic data and mock model inference. Bind loopback only. No deployment or cloud photo inference without an explicit request. Run npm test.
