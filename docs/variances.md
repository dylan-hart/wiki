# Variances

Genuine, justified deviations from spec. An entry stays only as long as the deviation is real;
delete it once resolved rather than leaving it as changelog prose.

## Tajawal has no `latin-ext` subset upstream

**Spec**: Task 715 (Feature 415, "Make code injection and font selection actually apply") requires
every non-Roboto vendored font family to cover at minimum `latin` + `latin-ext`.

**Deviation**: Tajawal's OFL distribution on Google Fonts (`google/fonts` repo, `ofl/tajawal`, v12)
ships exactly two subsets: `arabic` and `latin`. There is no `latin-ext` subset at all — requesting
one (either via the legacy `subset=latin-ext` parameter or the modern `css2` API) silently falls
back to the plain `latin` file, confirmed by comparing the returned font URL/hash in both cases.
This is a property of the upstream font project, not a vendoring choice: Tajawal is designed and
maintained as an Arabic/Latin-basic display face (Arabic being, per the task description, "that
font's whole purpose"), and its author has never published Central/Eastern European diacritics for
it. `frontend/public/_assets/fonts/tajawal/tajawal.css` is annotated at each `@font-face` with this
gap.

**Effect**: text rendered in Tajawal that requires `latin-ext` codepoints (e.g. Polish, Czech,
Turkish-beyond-basic-Latin, Vietnamese-via-Latin) falls through to the next font in the stack rather
than rendering in Tajawal — expected, standards-compliant `unicode-range`/font-stack fallback
behavior, not a rendering bug.

**Not economically fixable**: sourcing or hand-drawing `latin-ext` glyphs for a third-party OFL face
is out of scope for this fork. The Arabic subset itself is comprehensive (standard Arabic, Arabic
Supplement, Arabic Extended-A/B, Presentation Forms A/B, Arabic Mathematical Alphabetic Symbols) —
the gap is specifically and only the Latin side falling one subset short of the general five-family
minimum.
