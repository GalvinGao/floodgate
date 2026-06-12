---
date: 2026-06-11
topic: watched-repos-auto-open
builds-on: docs/brainstorms/2026-06-10-pr-unread-indicator-requirements.md
---

# Watched Repositories → auto-open new PRs in a Primary Window

## Problem Frame

The extension already turns open PR tabs into a glanceable, live status surface (split-color
favicon + unread dot + auto-pin/dedup). But you still have to *manually open* each PR. For repos
you actively review, you want new PRs to **show up on their own** — accumulating as a passive
review queue in one window — **without** interrupting whatever you're doing in another window.

This feature lets the user mark repos as **watched**; when a *new* PR is opened in a watched repo,
the extension auto-opens it (inactive, never stealing focus) in a designated **Primary Window**.
It composes with everything already built: auto-opened tabs get pinned, deduped, and carry the
status favicon + unread indicator.

## Core Model (resolved in brainstorm)

| Decision | Resolution |
|----------|------------|
| **Designate Primary Window** | A "Set current window as Primary" button on the Options page captures the window the Options tab is open in. |
| **When Primary Window is gone** (closed, or after a browser restart — window IDs don't persist) | **Fall back to the last-focused normal window.** No paused state; self-healing. |
| **Focus discipline** | Auto-opened tabs always open **inactive** (`active: false`) and the target window is **never** focused/raised — so even the fallback never switches your active tab. |
| **Add/remove watched repos** | A list on the Options page (type `owner/repo`, remove from list). |
| **Detection** | Poll each watched repo's open PRs on the existing ~60s alarm tick (fast). |
| **Renovate** *(hardcoded)* | PRs authored by the Renovate bot are skipped. |
| **Only-after-add** *(hardcoded)* | Only PRs **created after** the repo was added to the watch list are opened — never the pre-existing backlog. |

## Requirements

`W#`-prefixed to stay distinct from the favicon doc's `R#` and the unread doc's `U#`. This feature
extends that system.

**Watched repositories**
- **W1.** The Options page lets the user **add** a watched repo by `owner/repo`, see the current
  list, and **remove** entries. The list persists in `chrome.storage.local` (survives restart, like
  the token). Basic validation: well-formed `owner/repo`; ignore duplicates.
- **W2.** **Only-after-add watermark — by PR number, not clock.** When a repo is added, do one list
  fetch and record the **highest existing open-PR number** as the watermark. A PR is a candidate
  only if its **number > watermark**. PR numbers are server-assigned and monotonic, which avoids the
  client-vs-GitHub **clock skew** a `createdAt`-vs-`Date.now()` comparison would suffer (skew could
  open the backlog or skip a just-opened PR). The pre-existing backlog (number ≤ watermark) is never
  opened and is *implicitly* handled — no per-PR storage needed for it (see W6).
- **W3.** **Token-gated.** Watched-repo polling uses the existing GitHub token (background-only).
  With no token the feature is inert (no polling, no errors) — same posture as the favicon.

**Detection & filtering**
- **W4.** On each poll tick (~60s, reusing the existing `chrome.alarms` cadence), for each watched
  repo, list its **open** PRs (number, author login, `isDraft`, title; ordered **desc**, bounded
  **`first: ~30`** to cap response size + worst-case opens) via one GitHub query per repo. New-PR
  detection is by **number > watermark** (W2). Per-repo fetch errors are **typed, never thrown**, and
  **isolated** — one inaccessible / private / typo'd repo must not break the tick (nor the favicon
  polling sharing it); surface a per-repo error cue (W13), don't spam.
- **W4a.** **Alarm lifecycle (change to existing code).** The poll alarm is today created only while
  there are pollable PR *tabs* (`hasPollable(prRegistry)`) and cleared when none are open. Watched-
  repo polling must keep the alarm alive whenever **(watched repos configured AND a token is set)**,
  even with zero PR tabs — otherwise the feature silently never runs. This modifies `reconcilePollAlarm`
  (and the `tokenChanged` / `tokenCleared` paths), not just a layered query.
- **W5.** **Skip Renovate** *(hardcoded)* — a PR whose author login matches Renovate
  (case-insensitive `/renovate/`, covering `renovate[bot]` and common self-hosted `renovate` /
  `renovate-bot` logins), via a named constant so variants are a one-line add. *(A more robust
  structural signal — `author.__typename === "Bot"` in the GraphQL Actor type — is noted for later;
  v1 deliberately filters Renovate specifically, not all bots.)*
- **W5a.** **Skip drafts until ready** *(decided v1)* — a PR that is a **draft** at detection is not
  auto-opened and is **left unhandled**, so it opens once it flips to ready-for-review (its number is
  still > watermark on a later tick). A review queue surfaces only review-ready PRs.
- **W6.** **Open-once / respect-close.** A PR is auto-opened **at most once**. Persist a per-repo
  **handled set** of PR numbers the extension opened, in **`chrome.storage.local`** (survives restart
  — *not* `session`), so a closed auto-opened PR is **not re-opened** next tick. Numbers **≤ the
  watermark** (W2) are implicitly handled and need no entry, so the explicit set only holds
  post-watermark numbers the extension opened — bounding growth (Renovate / below-watermark PRs are
  filtered by W5/W2, not stored individually). *Known v1 limitation:* a PR you reviewed-and-closed
  will **not** re-surface even if the author later pushes commits (see Resolve-Before-Planning).

**Opening**
- **W7.** **Don't duplicate an already-open PR.** Before opening, check whether the PR is already
  open in **any tab in any window** via **`chrome.tabs.query`** (match each tab's URL through
  `parsePrUrl`) — **not** via `prRegistry`, which only holds tabs whose content script has registered
  (it misses tabs opened before install, just-opened-not-yet-loaded tabs, and — since it lives in
  `storage.session` — *all* tabs right after a restart). Also guard against double-open **within a
  tick** (record a number as opening in-memory before the async `tabs.create` resolves). If already
  open, **skip without adding it to the W6 handled set** — only PRs the extension itself opened are
  recorded, so a manually-opened-then-closed PR can still be surfaced later.
- **W8.** **Target window.** Open in the **Primary Window** if set and still existing; otherwise the
  **last-focused normal window**, resolved via `chrome.windows.getLastFocused({ windowTypes:
  ["normal"] })` (excludes the Options / devtools / popup windows). Always `active: false`.
- **W8a.** **Focus discipline is an assumption to verify.** "Never steal focus" rests on
  `chrome.tabs.create({ windowId, active: false })` **not raising the target window** — but the
  existing code only ever creates inactive tabs *without* a `windowId` (current window), so the
  cross-window targeted-create path is **untested here**. Planning must verify that opening into a
  **background or minimized** window doesn't surface it (and decide the behavior if it does).
- **W8b.** **Per-tick open cap (decided v1).** Open at most **~5** PRs per poll tick across all
  watched repos. Remaining candidates (still > watermark and unhandled) open on subsequent ticks — a
  natural rate-limit that prevents a burst / wake-from-sleep flood, dropping nothing. A PR is marked
  handled only when actually opened, not when deferred by the cap.
- **W9.** **Compose with auto-pin + dedup + favicon/unread.** An auto-opened PR tab is an ordinary
  PR tab: it flows through the existing auto-pin (gets pinned) and same-window dedup, and its
  content script registers for the status favicon + unread indicator. No special unread treatment —
  the tab appearing is itself the "new PR" signal (a never-viewed tab shows no dot until it changes,
  per the unread model).

**Primary Window**
- **W10.** The Options page shows the current Primary Window state ("set / not set") and a button
  to set it to the window the Options tab is in. The Primary Window id is validated before each use
  via `chrome.windows.get` (the window may have closed, or the id may be a stale/recycled value after
  a restart); an invalid/absent id triggers the W8 fallback rather than an error.

**Lifecycle & restart**
- **W11.** **Restart readiness gate.** `chrome.alarms` persist across restarts and can fire before
  the async load of watched-repo state. The watched-repo branch of the poll must **await a readiness
  promise** that resolves once the watch list + per-repo watermarks + handled sets have loaded from
  `chrome.storage.local`, so the **first post-restart tick cannot re-open the backlog**.

**Options UX & states**
- **W12.** **Add-repo interaction & feedback.** Explicit add affordance (a "Watch" button +
  Enter-submit); the input clears on success. Per-case inline feedback: bad format → "Use owner/repo
  format"; duplicate → "Already watching owner/repo"; no token → disable Add with a "Save a token
  first" hint. Whether Add does a live access-probe (showing a no-access error + a brief loading
  state) vs. local-format-only validation is a planning call.
- **W13.** **Options states & IA.** (a) Each watched-repo row: `owner/repo` (linked) + Remove, plus a
  per-repo cue (last-polled / error from W4). (b) An empty state mirroring the existing monitored-PR
  empty copy. (c) When the token is absent/invalid **and** the watch list is non-empty, a "Polling
  paused — save a valid token" callout. (d) Primary Window control: instruction copy ("Open this
  Options page in your review window, then click Set"), a post-set confirmation with a weak identity
  cue (e.g. "Primary set — window with N tabs"), and a clear **unset/stale** display after restart
  ("Not set — new PRs open in your last-focused window"). (e) Page section order:
  token → watched repos → Primary Window → monitored PRs → legend (setup before diagnostics).
  (f) Remove is immediate; note its side effect (clears that repo's watermark + handled set, so
  re-adding re-baselines).

## Success Criteria
- Add `owner/repo` to watched repos. A teammate opens a new (non-Renovate) PR there → within ~a
  minute a pinned tab for that PR appears **inactive** in the Primary Window, and your active tab /
  focused window are unchanged.
- A Renovate PR opened in a watched repo does **not** auto-open.
- PRs that were already open in the repo *before* you added it are **never** auto-opened.
- A PR auto-opened once and then closed does **not** re-appear on the next poll.
- A PR you already have open in another window is not opened a second time.
- With the Primary Window closed (or after a browser restart), new PRs still open — inactive — in
  the last-focused normal window, without switching your active tab.
- With no token set, nothing polls and no errors surface.

## Scope Boundaries
- **No webhooks / push** — detection is client-side polling (a browser extension can't receive
  GitHub webhooks). Latency is bounded by the poll cadence.
- **Auto-open only** — the feature opens PR tabs; it does **not** auto-close merged/closed PR tabs
  or otherwise manage the queue's lifecycle (out of v1).
- **No per-repo customization** in v1 — the Renovate filter, draft-skip (W5a), and after-add rule
  are **hardcoded** (not per-repo toggles). No author/label allow/deny lists.
- **No *interruptive* notifications** — no OS toast, sound, badge count, or focus-stealing. Auto-
  opening an inactive tab is the passive delivery channel (the deliberate-inbox direction reframes
  the unread doc's "not a notification system" line as "no *interruptive* notifications").
- **github.com only**, single token — inherited from the favicon feature.
- Designation is Options-only (no in-page "watch" button, no keyboard command) in v1.

## Key Decisions
- **Fall back to last-focused window (not pause)** — auto-open never gets stuck waiting for
  re-designation; because tabs always open inactive, even the fallback is non-disruptive. This
  trades a dedicated-window guarantee (when Primary is gone) for zero paused-state friction.
- **Inactive-only opening** — the single invariant that makes "without re-focusing" true regardless
  of which window is targeted.
- **Open-once, persisted** (W6) + **already-open guard** (W7) — the two rules that keep the queue
  from re-opening PRs the user dismissed or already has open. Without these, polling would fight the
  user.
- **Reuse the existing alarm + token + auto-pin/dedup/favicon stack** — watched-repo polling is a
  new *list* query layered onto the existing background poller; opened tabs are just PR tabs, so the
  favicon/unread/auto-pin stack applies downstream. **Not entirely free**, though: the alarm
  lifecycle (W4a) and the cross-window dedup (W7) are real changes to existing background code.
- **Hardcode Renovate + after-add** — per the request; keeps v1 simple and avoids a per-repo config
  surface. Both are isolated so they can become configurable later.
- **Per-tick open cap (~5)** (W8b) — bounds the worst-case flood without dropping PRs; the cheapest
  guard against the most likely abandonment trigger.
- **Strict open-once for v1** (W6) — a reviewed-then-closed PR doesn't re-surface even on new
  commits; re-surface-on-new-commits is deferred to v2.
- **Skip drafts until ready** (W5a) — the queue surfaces only review-ready PRs.
- **Deliberate inbox direction** — auto-opening tabs is owned as a *passive PR inbox*; the prior
  "not a notification system" boundary is reframed as "no *interruptive* notifications," so future
  inbox features (new-PR count, queue lifecycle, mark-read) are coherent rather than ad hoc.

## Dependencies / Assumptions
- **New GitHub query: list a repo's open PRs** — `github-api.ts` currently has only the single-PR
  status query + `validateToken`; a new "list open PRs for `owner/repo`" query (number,
  `author.login`, `isDraft`, title; `first:~30`, desc) is needed, reusing the existing `githubGraphQL`
  helper. Covered by the existing token scope (**Pull requests: Read**) — no new scope (assumption to
  confirm in planning).
- **Two changes to existing background code** (not just additions): `reconcilePollAlarm` must keep the
  alarm alive for watched-repos-without-PR-tabs (W4a), and the W7 dedup uses `chrome.tabs.query`
  across windows (the existing `maybeAutoPin` dedup is same-window/pinned-only).
- **No new extension permissions** — `chrome.tabs.create` / `chrome.tabs.query` and the
  `chrome.windows` API need no permission beyond what's present (`tabs`); `chrome.storage.local`
  already holds the token. (Verify against `package.json` in planning.)
- **Storage:** watched-repo list + per-repo watermark + per-repo handled-PR set in
  `chrome.storage.local`; Primary Window id wherever a stale-after-restart value cleanly resolves to
  the W8 fallback.
- **Renovate login** — assume the GitHub App identity `renovate[bot]`; confirm the exact match set
  (incl. self-hosted variants) in planning.
- Builds on `background/index.ts` (alarm + registry + auto-pin/dedup), `lib/github-api.ts`,
  `lib/github-pr.ts` (`parsePrUrl`/`PrRef`), `options.tsx`.

## Outstanding Questions

### Resolve Before Planning
- (resolved 2026-06-11) — the four product decisions are folded in above: tab-flood cap → **W8b**;
  strict open-once → **W6**; skip drafts until ready → **W5a**; deliberate-inbox direction → Scope
  Boundaries / Key Decisions. The review's technical fixes are in W2 / W4 / W4a / W6 / W7 / W8 / W8a
  / W11–W13.

> **Known v1 behavior (accepted):** window ids don't persist, so the Primary Window is unset on every
> browser restart → new PRs land (inactive) in the last-focused window until it's re-set. This is the
> chosen fallback (over pausing); revisit only if the restart frequency proves annoying.

### Deferred to Planning / v2
- **[v2] Re-surface on new commits** — re-open a closed, handled PR when its head commit changes
  after close (relaxes strict open-once / W6).
- **[v2] Auto-close / queue lifecycle** — closing merged/closed auto-opened tabs, or a "clear
  reviewed" action (the consumer-side control that keeps a growing queue manageable).
- **[v2] Configurable filters** — per-repo Renovate toggle, author/label allow-deny, draft handling.
- **[v2] In-page "Watch this repo" affordance** and/or a keyboard command to set the Primary Window.
- **[Technical — resolved in review]** Watermark = highest PR number (W2); list bounded `first:~30`
  (W4); handled-set in `storage.local`, bounded by the number watermark (W6); cross-window dedup via
  `chrome.tabs.query` (W7); last-focused-normal via `getLastFocused({windowTypes:['normal']})` +
  `chrome.windows.get` validation (W8/W10); restart readiness gate (W11). **Remaining detail:**
  per-tick stagger/ordering of the new list queries vs. the existing per-PR status fan-out.

## Next Steps
-> `/ce-plan` for structured implementation planning
