# Decision: derive automatic tags by matching existing tag names against the page's own terms, not by neighbour voting or tag-name embeddings

**Date:** 2026-09-20 · **Context:** OpenProject #3590 (first Task of #3530, "Auto-tag new pages from their content using the existing tag set"). Unblocks #3591 (pure derivation helper), #3592 (the `autoTagPage` job) and #3593 (enqueue for pages created without tags).

## Background

#3530 applies tags automatically to a new page that was created without any, choosing only from the wiki's existing tag set. It left the derivation method open and said quality, not feasibility, was the risk, so the method and its score threshold are settled here before anything is wired. Three methods were named:

1. **Neighbour voting** — the page's nearest chunks on other pages vote for the tags those pages carry.
2. **Tag-name ranking** — embed each existing tag name and rank by cosine against the page's mean chunk vector.
3. **Keyword extraction** — extract the page's salient terms and match them to tag names.

## How they were compared

`backend/scripts/evaluate-auto-tag.ts` scores all of them in memory, with no database, over a hand-written fixture in `backend/scripts/evaluate-auto-tag-fixtures/`:

- `corpus.json` — two small wikis. **dense**: 27 pages sharing a vocabulary of eleven tags, including jargon and one-word tags (`sso`, `ci`, `oncall`, `runbook`). **sparse**: 20 pages of which seven each carry a different single tag, so almost nothing can be learned from neighbours. Every page has a human-assigned `gold` tag list; six pages have none and exist to measure false positives, three of them deliberately mention technologies in passing.
- `vectors.json` — the real `Xenova/all-MiniLM-L6-v2` vectors (`helpers/embeddings.ts`, 384-dim, normalised) for every chunk and tag name, keyed by a hash of the text. Committed so the script and its tests never load the model; `node scripts/evaluate-auto-tag.ts --regenerate` rebuilds them and a test fails if they go stale.

Each page is evaluated as a new, untagged page (leave-one-out): the candidate tags are those applied to _other_ pages, the expected tags are its gold tags restricted to those candidates, and at most three tags are returned. Scores are pooled micro precision/recall and **F0.5**, which weights precision over recall because tags are applied without a human in the loop and a wrong tag costs more than a missing one. Method (1) is modelled in memory, since `queryChunks` in `models/semanticSearch.ts` is not exported.

Keyword extraction was implemented as the statistical form (a tag's score is how strongly its name's tokens rank among the page's terms). An embedding-ranked keyword variant would rank candidate terms by cosine to the page vector and then have to match them to existing tags, which is method 2 with a different candidate set, so it was not evaluated separately. Two weightings were measured: TF-IDF over the wiki, and plain term frequency relative to the page's most frequent term.

## Results

40 evaluated pages, 52 expected tags, best pooled F0.5 per method (`node scripts/evaluate-auto-tag.ts`):

| Method                             | Threshold | Precision | Recall | F0.5 | Empty-gold pages wrongly tagged (of 6) |
| ---------------------------------- | --------- | --------- | ------ | ---- | -------------------------------------- |
| Neighbour voting (5 pages)         | 0.25      | 50.0%     | 46.2%  | 49.2 | 4                                      |
| Tag-name ranking                   | 0.25      | 73.5%     | 48.1%  | 66.5 | 3                                      |
| Keyword extraction, TF-IDF         | 0.05-0.10 | 74.4%     | 61.5%  | 71.4 | 3                                      |
| Keyword extraction, term frequency | 0.05-0.15 | 74.4%     | 61.5%  | 71.4 | 3                                      |

Split by wiki at the chosen setting (term frequency, 0.15): dense precision 75.0% / recall 61.5%, sparse precision 72.7% / recall 61.5%. Neighbour voting at its best threshold: dense 47.7% / 53.8%, sparse 75.0% / 23.1% — the sparse wiki starves it, as expected, and it collapses to zero above 0.30 there. Tag-name ranking (0.25): dense 72.7% / 41.0%, sparse 75.0% / 69.2%.

Splitting recall by whether the tag's word appears on the page at all (32 of the 52 expected tags do, 20 do not):

| Method                           | Tag word on the page | Tag word not on the page |
| -------------------------------- | -------------------- | ------------------------ |
| Neighbour voting                 | 15 / 32              | 9 / 20                   |
| Tag-name ranking                 | 23 / 32              | 2 / 20                   |
| Keyword extraction (either form) | 32 / 32              | 0 / 20                   |

Combining methods did not help: keyword OR tag-name and keyword OR neighbour voting both scored 0.70-0.72 F0.5 at their best settings, no better than keyword alone.

## Decision

- **Method: keyword extraction, term-frequency form.** A tag's score is the mean, over the tokens of its name, of that token's count on the page divided by the count of the page's most frequent token. Tokens are lowercased, split on non-alphanumerics, stripped of stopwords and single characters, and a trailing plural `s` is stemmed (the exact rules are `tokenize`/`tagTokens` in the script). The page's title is counted twice with its body. Hyphenated tag names are matched token by token.
- **Score threshold: 0.15**, with at most **three** tags per page. The pooled score is identical for every threshold from 0.05 to 0.15 and drops at 0.20, so 0.15 is the strictest setting on the plateau: identical on the fixture and the safer one on real, longer pages, where a passing mention has a low count relative to the page's dominant term.
- **No corpus statistics are needed.** TF-IDF scored identically at the useful thresholds, so the helper needs no document-frequency table and no per-wiki state. It is a pure function of the page text and the tag list.
- **Model calls: none.** The chosen method never embeds anything, so nothing needs to run in the worker thread (which has no `CARDINAL.models`) for tag names, and #3592's job does not depend on `embedPage` having finished. If the fallback below is ever taken, tag-name ranking calls `embedText()` inside the worker task: `helpers/embeddings.ts` touches only `CARDINAL.logger` and an optional-chained `CARDINAL.models.extensions`, and `tasks/workers/embed-page.ts` already does exactly this. The tag list would come from `CARDINAL.ensureDb()` plus Drizzle rather than `CARDINAL.models`, the page's chunk vectors from `pageEmbeddingChunks` (so it must run after `embedPage`), and tag vectors would be cached per process.

## Why, and what this does not show

- The margin over tag-name ranking is 4.9 points of F0.5 on 52 expected tags, which is a preference, not a proof. The reasons that tip it are practical: the chosen method is deterministic, explainable to an author ("the page says `docker`"), cheap, and has no model or download dependency.
- **Its recall is exactly the fraction of tags whose word appears on the page**, 32 of 52 (62%) in this fixture, a rate the fixture's author set. It can never assign a category-style tag (`runbook`, `onboarding`, `oncall`) to a page that does not use the word, and no method did better on those in a way that could be applied automatically: tag-name ranking found 2 of 20, and the only method with real signal there, neighbour voting, found 9 of 20 at 50% precision on the pooled fixture.
- **Passing mentions fool it, and tag-name ranking too.** The three empty-gold pages that name technologies in passing were tagged by both. The 0.15 threshold and the three-tag cap limit the damage; they do not remove it. Because tags are applied automatically and are otherwise manual, #3593 should keep the trigger narrow (no tags at creation, as decided) and #3592 should not overwrite anything.
- The corpus is small and hand-written, and it was revised after a first run. The first draft named its technology tags on only 4 of 52 expected tags, which scored keyword extraction near zero and was unrealistic for a wiki, so the pages were rewritten to mention them naturally (32 of 52) and the three passing-mention negatives were added as a counterweight. That revision favoured keyword extraction; the 5-point margin should be read with it in mind.

## Fallback and when to revisit

Rerun `node scripts/evaluate-auto-tag.ts` after adding real pages to the fixture. If the share of expected tags whose word appears on the page falls well below about 40%, switch to **tag-name ranking at threshold 0.25** (73.5% precision at 48.1% recall), which is the better method once literal mentions are rare and needs no tagged corpus. Neighbour voting is not recommended for a young or sparsely tagged wiki (sparse recall 23.1% at its best threshold).

## Consequences for the follow-up tasks

- **#3591**: implement the pure helper in `helpers/` (application code does not import from `scripts/`); it takes the page text and the existing tag names and returns up to three tags, best first, ties by name. `tokenize`, `tagTokens`, `extractKeywords` and `selectTags` in `evaluate-auto-tag.ts` are the reference behaviour, and the fixture is a ready-made test corpus. Once the helper exists, the script should import it rather than keep a copy.
- **#3592/#3593**: the parent's rule that no tags are applied when semantic search is unavailable was written for a model-based method. The chosen method works without the model, so that gate is now a product choice rather than a technical requirement; until it is revisited, keep the parent's behaviour.
