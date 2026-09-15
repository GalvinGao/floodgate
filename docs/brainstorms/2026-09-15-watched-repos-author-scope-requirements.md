---
date: 2026-09-15
topic: watched-repos-author-scope
---

# Watched Repositories — Whose PRs Should Auto-Open?

## Problem Frame

A watched repo auto-opens **every** author's new PRs
([lib/watched.ts:71](../../lib/watched.ts), `selectPrsToOpen`): the only
exclusions are drafts, Renovate, the pre-add backlog (`number > watermark`), and
PRs already opened (`handled`). On a small repo that is exactly right — a new PR
is news.

On a busy repo it inverts. A monorepo that merges dozens of PRs a day hands you
five new tabs a minute (`WATCHED_TICK_CAP`), none of them yours. The feature that
was supposed to stop you missing your own PR is the reason you close twenty tabs
an hour, and the practical fix today is to unwatch the repo — which is the one
repo you most wanted watched.

So the wanted shape is: keep watching the repo, but narrow what counts as news to
**the pull requests you opened**. That is the whole ask. What follows is why
"and the ones awaiting my review" is _not_ folded into it.

## Why Author Scope Is Cheap

GraphQL's `PullRequest` implements `Comment`, so the existing list query can ask
for `viewerDidAuthor` — GitHub's own answer to "did this token's user open it" —
in the fields it already fetches. No search endpoint, no second request per tick,
no stored login to go stale when the token is swapped for another account's.

The newest-30 window is not a problem for this axis either. The poll runs every
minute and orders by `CREATED_AT DESC`, so a PR you just opened sits at position
one the moment it exists. Filtering the window client-side answers correctly for
everything the watermark could have opened anyway.

## Why Review Scope Is Not

"PRs awaiting my review" looks like a sibling of "PRs I opened". It isn't:

1. **The watermark model doesn't hold.** A review request lands on a PR of any
   age — routinely one created before you added the repo, and often outside the
   newest-30 window entirely. `number > watermark` is the wrong question, so the
   axis needs `search(query:"repo:o/r is:pr is:open review-requested:@me")`: a
   second query per repo per tick, and a second "already seen" model that isn't a
   number watermark.

2. **The volume is a different order.** On a repo with an active review rotation,
   the set of open PRs requesting your team's review runs to the hundreds. Adding
   such a repo would open every one of them. Making it safe means seeding a
   baseline at add time plus a cap of its own — more machinery than the author
   axis needs, in service of a signal most people would turn off within a day.

3. **Team requests drown out personal ones.** `review-requested:@me` matches
   requests routed through a team you belong to, which on a team-reviewed repo is
   effectively all of them; `user-review-requested:@me` matches only the ones
   where somebody named you. The second is the signal worth a tab. The first is a
   broadcast, and auto-opening a broadcast is how you teach someone to ignore it.

The honest read is that the author axis and the review axis share a sentence in
the feature request and nothing else — different query, different bookkeeping,
different failure mode. Shipping them together would mean shipping the cheap,
obviously-correct one behind the expensive, arguable one.

## Decisions

- **Per repo, not global.** The watch list is already per repo, and the split is
  the point: a project of your own stays every-author, a busy repo you work in
  narrows to yours. A single global switch would force the same answer on both.
- **Absent means every author, so nothing migrates.** Repos already on a watch
  list keep the behavior they have; only the value an add writes changes.
- **A new repo starts narrowed.** The flood is the pain the feature exists for,
  so watching every author is what you opt into, not what you have to notice and
  opt out of. This also removes the only argument for a second control on the add
  form: a repo added every-author would start opening strangers' PRs before you
  could reach its row. Measured rather than assumed — `reconcilePollAlarm` calls
  `chrome.alarms.create` with `periodInMinutes` and no `when`, so the first poll
  after an add is a full minute away, which is not a window one checkbox-click
  can lose. Two near-identically worded checkboxes stacked together, one meaning
  "the next repo" and the other "this repo", cost more than they bought.
- **Review scope is out of scope.** If it is ever built, the shape above is the
  starting point: `user-review-requested:@me`, off by default, baselined at add.

## Open Question

`viewerDidAuthor` is evaluated against the token's user, and the failure mode if
a least-privilege fine-grained PAT cannot resolve a viewer is silence — a
narrowed repo that never opens anything, with nothing on screen to say why. It
was verified against a live token on the exact query shape this feature uses; a
restricted-PAT check is worth doing before this is assumed safe for every token
the Options page accepts.
