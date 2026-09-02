# CLAUDE.md notes — Lane A (backend)

- **Task A2 (migration dead code, spec D5).** CLAUDE.md's `migration/` bullet (the `backend/` layout
  table) stays accurate as written — every file and directory it names still exists and still plays
  the role it describes. One optional addition worth considering: D5 deleted the multi-source
  conflict-policy machinery from `migration/mappers/`, so the importer now consolidates exactly **one**
  2.5.x source into one fresh 3.0 instance. If CLAUDE.md ever grows a sentence about what the importer
  can and cannot do, "one source per run, no multi-source consolidation" belongs in it.
