# quality.yml: stale FIXME after the duplicate install steps were removed

`.github/workflows/quality.yml`, the two-line `# FIXME:` comment directly above the "Start MinIO"
step's own comment (it begins `FIXME: this step and the "Install pandoc" step after it repeat...`).

**Recommendation: delete it.** The duplicated "Install git-cliff" / "Install pandoc" pair it asked
to have deleted is gone (OpenProject #3529), so the FIXME now describes nothing and, sitting flush
against the MinIO comment, reads as though it belongs to that step.
