# GTM 10 — History Reset & the Move to GitLab

**Date:** 2026-09-13 · Part of the [war room set](2026-09-13-gtm-00-war-room.md).

**Your intent:** squash all history into a fresh `main`, move from GitHub to GitLab, likely at
`cardinal/cardinaljs`. This doc covers what that collides with, the options, and the order of operations.
Every GitLab fact below was checked against GitLab's own docs or API on 2026-09-13.

---

## 1. Findings that shape the decision

| # | Finding | Source |
|---|---|---|
| F1 | **`gitlab.com/cardinal` is taken.** On GitLab.com, users and groups share one namespace, and an active user named `Cardinal` exists. `cardinal/cardinaljs` is not possible | GitLab API `users?username=cardinal` |
| F2 | **`cardinaljs` looks free**: no public group and no user. A *private* group would also return 404, so reserve it before trusting this | GitLab API |
| F3 | **The fork's own legal review says not to do the full flatten.** `docs/legal/07-recommended-actions.md` §F: *"Do not rewrite git history to remove upstream authorship. It is the fork's best attribution."* `docs/legal/03-cardinal-fork.md` calls the intact history back to 2016 *"the strongest attribution the fork has."* The README calls the commit history "the full record of those modifications" | Repo |
| F4 | **The public history isn't archived anywhere yet.** Software Heritage has no record of `github.com/dylan-hart/wiki`, so deleting the GitHub repo after a reset really does remove the fork-era history from public view | Software Heritage API |
| F5 | **GitLab can push-mirror to GitHub on the Free tier** (syncs within 5 minutes, or 1 minute for protected branches only) | GitLab docs |
| F6 | **GitLab is a CVE Numbering Authority.** Public projects on any tier can request CVE IDs from a confidential issue. That replaces GitHub's advisories and CVE flow | GitLab docs |
| F7 | **GitLab-hosted CI on the Free tier is 400 compute minutes/month** (the same cap applies to public projects). Cardinal's quality, e2e and Docker jobs would burn through that quickly | GitLab docs |
| F8 | **The GitLab for Open Source program** (Ultimate + 50,000 CI minutes) requires that *"your organization can't seek to make a profit by selling services, by charging for enhancements or add-ons, or by other means."* That conflicts with doc 08's paid migration and support offers | about.gitlab.com join page |
| F9 | **awesome-selfhosted is fine with non-GitHub hosting**: 30+ entries use `gitlab.com` source URLs and 31 use Codeberg, BookStack included | awesome-selfhosted-data search |
| F10 | **How far the change reaches** (measured): 11 files reference `dylan-hart/wiki`. `scarlett` appears in all four workflows, `scripts/verify-ci.sh`, `RELEASING.md`, `README.md`, `CLAUDE.md`, `backend/test/release-workflow.test.ts`, `backend/test/quarantineLaneCi.test.ts` and a frontend test. `backend/test/verifyCi.test.ts` parses `.github/workflows/quality.yml` directly | Repo grep |

---

## 2. History: three options

### Option A — Full flatten (what you described)
A single orphan root commit containing today's tree.

**Pros**
- A clean slate.
- The ~731 fork commits are gone, and the process history people could dig through goes with them: duplicate bug filings, chronic red-CI fixes, same-day feat→fix churn (`ngpixel-field-notes.md`), and private OpenProject IDs in commit messages.
- Upstream's tags, the `scarlett` branch name and the Claude co-author trailer count all disappear.

**Cons**
- **Contradicts the fork's own legal review (F3).** Removing history isn't an AGPL violation in itself; notices and the §5(a) statement are what the licence requires.
- **Creates the cheapest attack in doc 09.** `git blame` would attribute every line, including NGPixel's ~1,780 commits of work, to you. The headline writes itself: "fork erased the original author from his own code."
- **Upstream security fixes become manual patching.** With no shared merge base, `git merge` and clean cherry-picks from upstream stop working.
- **Erases the AI disclosure after the fact.** 497 `Co-Authored-By: Claude` trailers vanish. "They scrubbed the AI commits before launch" is exactly the concealment story that draws fire (the "undercover mode" backlash).
- Loses `git bisect` over fork-era changes.

### Option B — Graft onto upstream's fork point (recommended)
A new `main` whose parent is upstream's `d0c5a8bfa`, containing **one** squashed commit (or a few, grouped by area) with today's tree.

**Pros**
- Every upstream commit keeps its real author and **the same hashes as `requarks/wiki`**, so anyone can check the attribution.
- The fork noise, internal IDs and churn still disappear.
- A merge base with upstream remains, so porting upstream security fixes stays a normal git operation.
- Blame is accurate: lines you changed show you, lines you didn't show their authors.
- The squash message carries the AI disclosure in one line.

**Cons**
- It isn't "fresh": the repo keeps upstream's ~2,300 commits.
- You must be careful never to push upstream's tags.

**Mechanics** (run in a scratch clone, never your working checkout):

```sh
git fetch <upstream-or-local-clone>                      # make sure d0c5a8bfa is present
NEW=$(git commit-tree HEAD^{tree} -p d0c5a8bfa -F squash-message.txt)
git branch main "$NEW"
git log --oneline -3 main                                # squash on top of upstream's fork point
git push <gitlab-remote> main                            # push ONLY main: no --tags, no --all
```

`squash-message.txt` should state:
- the date range and commit count it squashes;
- "Modified from Wiki.js `requarks/wiki@d0c5a8bfa`";
- the AI disclosure;
- a `Co-Authored-By: Claude …` trailer.

### Option C — Full flatten with a provenance kit
Option A, plus everything needed to answer the attribution attack. **If you choose A anyway, treat C as mandatory:**
- A root commit message naming `https://github.com/requarks/wiki/commit/d0c5a8bfa` as the origin.
- A `NOTICE` (already recommended in doc 04 A5) plus an `AUTHORS` file generated from upstream's `git shortlog -sne` up to the fork point.
- A README "History" section: "Development history before <date> was squashed at the move to GitLab. Upstream history: requarks/wiki. Fork-era work was done by one maintainer directing AI agents."
- `docs/legal/03` and `07` updated to record the decision and its reasoning. They currently advise against it.
- A private offline `git bundle` of the old repo kept indefinitely, as your own evidence if provenance is ever disputed (the OpenTofu C&D lesson).
- An upstream-porting workflow that uses patch files instead of merges.

### Either way
- **Scan the tree for secrets before the first push** (e.g. gitleaks). Resetting history doesn't clean the current files.
- Push **only** `main`. No upstream tags, no `scarlett`, no work-cycle branches.
- Decide what happens to the GitHub repo (§5) *before* announcing anything.

| | A: Flatten | B: Graft | C: Flatten + kit |
|---|---|---|---|
| Removes fork noise | ✅ | ✅ | ✅ |
| Upstream attribution verifiable in git | ❌ | ✅ | ⚠️ in files only |
| Consistent with `docs/legal/` | ❌ | ✅ | ⚠️ after the docs are updated |
| Easy upstream security ports | ❌ | ✅ | ❌ |
| AI disclosure survives | ❌ | ✅ (squash trailer) | ⚠️ (README statement) |
| "Fresh" feel | ✅ | ⚠️ | ✅ |
| Effort | S | S | M |

---

## 3. Namespace

`cardinal` is taken (F1). Options, in order of preference:
1. **`gitlab.com/cardinaljs/cardinal`**: the group is the product's handle, the project is the product.
2. `gitlab.com/cardinaljs/cardinaljs`: fine, a little stuttery.
3. `gitlab.com/cardinal-wiki/cardinal`: reads well, but spreads the name across two forms.

**Reserve the group today** (it's free and takes seconds), regardless of the trademark search outcome (doc 04 A2). Match it everywhere you can: Docker Hub `cardinaljs`, a GitHub org `cardinaljs` for the read-only mirror, and social handles.

---

## 4. What the GitLab move changes elsewhere in this strategy

| Area | GitHub assumption in docs 03–09 | On GitLab |
|---|---|---|
| **CI** | GitHub Actions, SHA-pinned, `attest-build-provenance` | Port the four workflows to `.gitlab-ci.yml`. **Run a project runner on your own hardware**: F7's 400 minutes won't cover the gate, and F8 rules out the Open Source program if you ever sell services. Replace build provenance with Sigstore/cosign keyless signing using GitLab OIDC `id_tokens` *(verify the current recipe when porting)*. Update `scripts/verify-ci.sh` and `verifyCi.test.ts` to parse the new file |
| **Registry** | GHCR (`ghcr.io/dylan-hart/wiki`) | `registry.gitlab.com/cardinaljs/cardinal`. TrueNAS prefers GHCR images, so consider **also** pushing to GHCR (under the mirror org) or Docker Hub `cardinaljs` |
| **Dependency updates** | Dependabot | Renovate (self-hosted on the runner, or the Renovate app) |
| **Security reporting** (doc 04 B1, doc 09 P1) | GitHub private vulnerability reporting + advisories | A confidential-issue template for vulnerabilities, a `security@` address on your domain, and CVE requests through GitLab's CNA (F6). Publish advisories as project releases/pages. `SECURITY.md` describes that flow |
| **Community channel** (doc 07 §6) | GitHub Discussions | GitLab has no Discussions equivalent. At launch: issues with a `support` label and a support issue template. Later: Matrix, or a Discourse forum. Keep answers public and searchable |
| **Funding** (doc 08) | `.github/FUNDING.yml` Sponsor button | No GitLab equivalent. Use a funding section in the README and on the website, plus `funding.json`. A GitHub Sponsors profile still works from your GitHub account |
| **Trust signals** (doc 03 §6) | "Commits carry a co-author trailer" | True from the reset onward. Under Option A it's a README statement instead (§2) |
| **Discovery** (doc 05) | Stars, GitHub trending, contributors already signed in; Coolify's catalog needs **≥1,000 GitHub stars** | **Read-only GitHub push mirror** (F5) under the `cardinaljs` GitHub org: issues and PRs disabled, description "Mirror — development happens on GitLab". Stars pile up there too, so your social proof is split across two sites |
| **Update check** (`check-version.ts`) | GitHub releases API | GitLab releases API (`/api/v4/projects/:id/releases/permalink/latest`) |
| **AGPL §13 source link** | Footer → GitHub at the build's revision | Footer → GitLab at the build's revision |
| **Your work-cycle tooling** | The openproject-workflows `workcycle`/cleanup skills use `gh`, `gh pr checks`, `refs/pull/N/head` recovery, and `baseBranch: scarlett` | Needs GitLab support (merge requests, pipelines, `refs/merge-requests/N/head`) and `baseBranch: main` **before the next work-cycle run against the new home**. That's a change to your openproject-mcp plugin project |
| **OpenProject links** | WPs link GitHub PRs and commit hashes | Links to the old repo break once it's deleted. That's internal history and harmless, but worth knowing |
| **EU sovereignty angle** (doc 03 S4) | — | GitLab.com is US-hosted. If the sovereignty story ever matters, Codeberg is the stronger signal; BookStack moved there. You don't need to reopen the decision, just be aware of it |

---

## 5. Order of operations

1. **Decide**: history option (D13), namespace (D14), runner/CI approach (D15).
2. **Reserve**: GitLab group `cardinaljs`, GitHub org `cardinaljs` (mirror), Docker Hub `cardinaljs`.
3. **Set up a GitLab project runner** on hardware you control and register it to the group.
4. **In the current repo, on a worktree branch**:
   - port CI to `.gitlab-ci.yml`;
   - update `verify-ci.sh` and the three CI-parsing tests;
   - rename `scarlett` → `main` in workflows, docs and tests;
   - repoint the 11 `dylan-hart/wiki` references, `check-version.ts`, the footer source link, OCI labels and package.json fields;
   - add `.gitlab/issue_templates/` (bug, feature, support, migration, vulnerability, the last one confidential).
   - Also do the doc 04 A5/A6 branding and legal residue now: the reset is the natural moment for the first commit people see to be clean.
5. **Secret scan** of the final tree.
6. **Build the new `main`** per the chosen option (§2) in a scratch clone.
7. **Push `main` only** to GitLab; set `main` protected and the default branch; confirm the pipeline is green on your runner.
8. **Turn on push mirroring** to the GitHub mirror repo; disable issues and PRs there.
9. **Redeploy every running instance** (your coworkers' and your home machine's) from a GitLab build, so each footer source link points at code that exists. AGPL §13 means anyone using those instances over the network is owed source, and the old GitHub link must keep working until this step is done.
10. **Retire `github.com/dylan-hart/wiki`**:
    - delete it, or make it private, if erasing fork-era history is the goal (F4: nothing public preserves it);
    - otherwise archive it with a README pointer.
    - Delete or retag old GHCR images so nobody pulls `ghcr.io/dylan-hart/wiki` by accident.
11. **Update** the openproject-mcp work-cycle tooling for GitLab (§4) before the next automated run.
12. **Update this strategy's references**:
    - CLAUDE.md "What verified means" and Testing (CI) sections;
    - `docs/versioning.md` and `docs/release-checklist.md`;
    - `docs/legal/03`, `/04`, `/07`, which name GitHub URLs and the history.
13. **Then** cut `v0.9.0` on GitLab (doc 04 C1). awesome-selfhosted's 4-month clock starts at that tag, not at the repo move.

---

## 6. New decisions for the war-room table

| # | Decision | Recommendation |
|---|---|---|
| D13 | History reset method | **Option B (graft onto `d0c5a8bfa`)**. If you want A, do C |
| D14 | GitLab namespace | `gitlab.com/cardinaljs/cardinal` (`cardinal` is taken) |
| D15 | CI compute | Your own project runner. Don't join the GitLab for Open Source program unless you commit to never selling services |
