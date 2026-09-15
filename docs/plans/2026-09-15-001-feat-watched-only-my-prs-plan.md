---
title: "feat: Watched repositories — narrow a repo to the PRs you opened"
type: feat
status: completed
date: 2026-09-15
origin: docs/brainstorms/2026-09-15-watched-repos-author-scope-requirements.md
---

# feat: Watched repositories — narrow a repo to the PRs you opened

## Overview

A watched repo auto-opens every author's new PRs, which is right on a quiet repo
and unusable on a busy one — five tabs a minute, none of them yours. This adds a
**per-repo** switch: leave it off and nothing changes; turn it on and only the
pull requests **you** opened auto-open there.

"Mine" is decided by GitHub, not by us: the existing list query now also asks for
`viewerDidAuthor`, so there is no search endpoint, no extra request per tick, and
no cached login to go stale when the token changes.

The sibling axis — PRs awaiting your review — is deliberately **not** in this
plan; see the origin brainstorm for why it is a different feature wearing the
same sentence.

## Requirements Trace

- R1. A watched repo can be set to open only the PRs the token's user opened.
- R2. A repo you add starts narrowed; its row widens it to every author.
- R3. An absent value means every author, so an existing watch list keeps its
  behavior with no migration — only what an add writes changes.
- R4. "Reconcile tabs" honors the setting — a repo narrowed to your PRs catches
  up on your PRs only, or the button would quietly undo the setting.
- R5. Changing the setting cannot flood the window (see Key Decisions).
- R6. A rejected change leaves the stored state and the checkbox untouched, with
  a reason on screen.

## Scope Boundaries

**In:** the author axis, per repo, add-time and after-the-fact; the reconcile
path; Options UI; README.

**Out:** the review axis (`review-requested` / `user-review-requested`); any
change to the draft or Renovate exclusions — your own drafts stay skipped, which
is the documented contract and a separate decision; any change to the poll
cadence, tick cap, or the already-open (W7) check.

**Known and left alone:** the poll skips an already-open PR _without_ marking it
handled, so a PR whose tab you close comes back on a later tick. That is
pre-existing for every author and reads as intentional ("reconcile … also reopens
PRs you opened then closed"), but narrowing a repo to your own PRs concentrates
the population on PRs you opened by hand in the browser, where it will be most
noticeable. Flagged, not changed.

## Key Technical Decisions

**`viewerDidAuthor`, not a stored login.** `PullRequest` implements `Comment`, so
the field rides along on the query already being made. A login-comparison
alternative would need a `viewer { login }` fetch, somewhere to cache it, and an
invalidation story for a swapped token. Verified live against the exact
repo-scoped query shape this uses.

**`onlyMine` is required on `selectPrsToOpen`, not defaulted.** Two call sites
(poll and reconcile) must each say which repo's setting they mean. A default of
`false` would turn a forgotten argument into a window full of other people's PRs
— a bug that only shows up as noise, which is exactly the noise this feature
exists to remove.

**A scope change re-baselines the watermark.** This is the non-obvious one.
While a repo is narrowed, other authors' new PRs are passed over _without_ being
marked handled. Turning the filter back off against the original add-time
watermark would therefore treat every PR opened in the meantime as brand new and
open them all — the exact flood the feature prevents, triggered by turning it
off. Re-baselining to the repo's current highest open PR makes a scope change
read like adding the repo does: from here on, new PRs open. Handled numbers at or
below the new watermark are dropped in the same breath, since the watermark
already excludes them and keeping them only grows storage.

That baseline needs the current PR list, so the change is a fetch and can fail.
It gets its own message and response rather than riding on `addWatchedRepo`,
and on failure nothing is written — the Options checkbox renders from stored
state, so it simply stays where it was and the reason appears in the section's
error line.

**Absent means every author; a new watch writes `true`.** `isOnlyMine` accepts
only an explicit `true`, so repos already on the list are untouched and there is
nothing to migrate. New ones start narrowed, because the flood is the pain and
every-author is the thing worth opting into.

**One control, on the row — not two.** An earlier cut also put a checkbox on the
add form, on the theory that a repo added every-author would open strangers' PRs
before you could reach its row. `reconcilePollAlarm` passes `periodInMinutes`
with no `when`, so the first poll after an add is a minute out — no race a
checkbox-click can lose, and none at all once a new repo starts narrowed. What
the second control did buy was two near-identically worded checkboxes stacked
together, one meaning "the next repo" and the other "this repo", both left ticked
after an add.

## Implementation Units

1. **`lib/watched.ts`** — `ListedPr.viewerDidAuthor`; `WatchedRepo.onlyMine?`;
   `isOnlyMine`; `selectPrsToOpen` takes a required `onlyMine` and filters
   `!onlyMine || pr.viewerDidAuthor`.
2. **`lib/github-api.ts`** — `viewerDidAuthor` in `LIST_OPEN_PRS_QUERY`, its
   node type, and the `ListedPr` mapping.
3. **`lib/messages.ts`** — `SetWatchedRepoScope` + `SetWatchedRepoScopeResponse`
   (the add's failure vocabulary minus the add-only cases, plus `not-watched`).
4. **`background/index.ts`** — `handleAddWatchedRepo` writes `onlyMine: true`;
   `handleSetWatchedRepoScope` re-baselines and answers; both `selectPrsToOpen`
   call sites pass `isOnlyMine(entry.onlyMine)`; dispatch the new message.
5. **`options.tsx`** — an "only mine" toggle per row (disabled while a change is
   in flight), `SCOPE_ERROR_MSG`, updated copy.
6. **Tests** — `isOnlyMine` across the values an older build could have stored;
   `selectPrsToOpen` on/off, your-drafts-still-skipped, and that the cap is spent
   on your PRs rather than on ones it filtered out; `fetchOpenPrs` maps the new
   field and the query actually asks for it.

## Risks

**A restricted PAT that cannot resolve a viewer** would make `viewerDidAuthor`
uniformly false, and a narrowed repo would go silent with nothing on screen to
explain it. It fails closed rather than flooding, which is the right direction,
but it is invisible. Verified against a live token on this query shape; a
least-privilege fine-grained PAT is the case still to check.

**Turning the switch on and off again quickly** loses PRs opened in between, via
the re-baseline. Accepted: "from the change onward" is the semantics the setting
advertises.
