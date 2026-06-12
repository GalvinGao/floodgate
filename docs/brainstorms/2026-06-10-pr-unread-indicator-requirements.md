---
date: 2026-06-10
topic: pr-unread-indicator
builds-on: docs/brainstorms/2026-06-09-pr-status-favicon-requirements.md
---

# PR Unread Indicator — "changed while you were away"

## Problem Frame

The PR status favicon (the `2026-06-09-pr-status-favicon` feature) already tells
you each PR's *current* review/check state at a glance. But when you box-select a
stack of PRs into a group and walk away, the color alone can't tell you **which
ones changed since you last looked**. A favicon that turned green an hour ago and
one that turned green ten seconds ago look identical. Across a 10-PR stack you
re-scan every icon and still can't tell what's *new*.

This feature adds an **unread indicator** — a dot in the **top-right corner of the
favicon** — that lights up when a PR's favicon changes while you aren't looking at
that tab, and clears when you look again. It composes directly with box-select +
the status favicon: box a stack, walk away, come back, and the dots point you
straight at the PRs that moved.

It is **multi-surface**: the same unread state also drives the Options page's
"Currently monitoring" list, so you can triage from one place.

## Core Model (resolved in brainstorm)

| Decision | Resolution |
|----------|------------|
| **When does the dot light?** | A PR tab's favicon **visibly changes** (review color, check color, the "+", or a lifecycle flip) **while the tab is not visible**. |
| **What's the baseline?** | The favicon as of the **last time the tab was visible**. Set silently on first load — a freshly opened background tab shows **no dot** until it *changes*. |
| **Flap behavior** | **Latched.** Once any change occurs while hidden, the dot stays lit until you refocus — even if the favicon flaps back to the baseline. The dot means "*something happened while you were away*," not "*looks different right now*." |
| **What clears it?** | **Refocusing the tab** (it becomes visible). Clearing also re-baselines to the current state. |
| **Where is it shown?** | Favicon top-right corner **and** the Options "Currently monitoring" list. |

## Requirements

Requirements use the **U-prefix** to stay unambiguous from the favicon doc's
`R#` numbering, which code comments already reference. This feature **extends**
that system; it does not replace any `R#`.

**Visibility tracking**
- **U1.** The **content script is the source of truth for visibility.** It uses the
  Page Visibility API (`document.visibilityState` / `visibilitychange`) — which is
  exactly "this tab is the foreground tab of a non-minimized window" — and reports
  each transition (`visible` / `hidden`) to the background. It also reports its
  **initial** visibility at registration time.
- **U1a.** Visibility is reported **upward to the background**; the background does
  **not** reconstruct focus from `chrome.windows.onFocusChanged` /
  `chrome.tabs.onActivated`. This is both more reliable (the page knows its own
  visibility) and avoids multi-window focus bugs.
- **U1b.** **Window/app-level blur is out of scope** for v1: if the PR tab stays the
  foreground tab while you switch to another application, `visibilityState` remains
  `visible` and the tab is treated as "being looked at." Page Visibility is the
  single authoritative signal — this deliberately avoids the focus churn of
  devtools / omnibox / alt-tab. (See Deferred.)

**Unread state (background-owned)**
- **U2.** Each registry entry gains: `seenStatus` (the `PrStatus` the user last saw —
  the baseline), `visible` (last-reported visibility), and `unread` (the latch flag).
  These live in the existing `chrome.storage.session` registry, so unread state
  **survives service-worker eviction** (the registry is already mirrored there).
- **U3.** **Baseline on register:** when a tab's first status is fetched, set
  `seenStatus = <that status>` and `unread = false` — regardless of visibility. A
  never-seen background tab therefore shows **no dot** until its status later
  changes (resolved: "no dot until it changes").
- **U4.** **On a poll/status update for a tab:**
  - If the tab is **visible** → set `seenStatus = newStatus`, leave `unread = false`
    (you saw it change live).
  - If the tab is **hidden** → if the **rendered favicon** of `newStatus` differs
    from that of `seenStatus`, set `unread = true` (**latch**; never auto-clear here).
    `seenStatus` is left unchanged.
- **U4a.** "Differs" is measured on the **rendered favicon** — i.e. `toFaviconSpec`
  equality, not raw `PrStatus` field equality. If two statuses produce the same icon
  (no visible change), the dot does **not** light (resolved: "any *visible* favicon
  change"). **`FaviconSpec` has optional fields (`plus?`, `whole?`), so a naive `===`
  / `JSON.stringify` comparison is unreliable** — define a canonical
  `faviconSpecEqual(a, b)`: when `a.whole` (or `b.whole`) is true, compare only
  `whole` + `left`; otherwise compare `left`, `right`, and `!!a.plus === !!b.plus`
  (normalize `undefined`→`false`). This comparator is the **single source of
  "differs"** and should be a unit-tested pure function in `lib/pr-status.ts`. Note
  the latch catches the *intermediate* state of a flap (a failing check renders red,
  which differs from the baseline), which is why "failed then recovered" still lights
  the dot even though the endpoints render identically.
- **U5.** **On visibility → `visible`:** set `unread = false` and `seenStatus =
  currentStatus` (clear + re-baseline), and push a redraw so the dot disappears.
- **U6.** **On visibility → `hidden`:** set `seenStatus = currentStatus`,
  `unread = false` (re-baseline at the moment of blur; nothing is unread yet). Only
  changes *after* this point can latch the dot.

**Rendering**
- **U7.** `drawFavicon` (canvas) and `faviconSvg` (Options legend/list) both render a
  small **top-right corner dot** when unread — drawn from the **shared `geometry()`**
  so canvas and SVG never drift (same discipline as the existing split + "+"). **Pass
  `unread` as a separate draw argument** (e.g. `drawFavicon(spec, size, { unread })`),
  **not** as a field on `FaviconSpec` — adding it to the spec would pollute U4a's
  equality comparison (the latch would diff the dot against itself). The dot must
  render on **both** the two-half path **and** the `whole` (lifecycle) path; note the
  canvas `whole` branch currently `return`s early, so it needs an explicit dot draw
  before returning (gated on the U7-lifecycle decision in Resolve-Before-Planning).
- **U7a.** The dot must read as "**new**" against **any** underlying half-color and at
  the real **16px** favicon size. A high-contrast treatment (e.g. an accent fill with
  a thin contrasting ring) is required; exact color/size/ring is a **planning design
  detail**. It must sit in the **top-right**, clear of the "+" (which lives low in the
  **left** half — no collision). **Locked constraint:** the dot's hue must be
  **orthogonal to the five status colors** (green / amber / red / grey / purple) so it
  reads as a temporal "activity" signal, **not a third status channel** — avoid a
  generic notification-blue that competes with the check/review semantics. The ~4px
  top-right quadrant budget at 16px means the geometry must be prototyped at both 16px
  and 32px before the size/ring is finalized.
- **U7b.** The background pushes `unread` alongside status (`{ type: "prStatus",
  status, unread }`), and pushes a redraw when `unread` flips on a visibility change.
  **The background is the single authoritative owner of `unread`.** The content script
  *may* clear its own dot **optimistically and instantly** on the `visible` transition
  to avoid round-trip lag, but this is **best-effort, idempotent**: the background's
  subsequent U5 push is authoritative, and if the optimistic clear is ever lost the
  next push reconciles it. The content script must **not** maintain its own latch state
  — there is exactly one clear path (U5), with the optimistic clear as a pure render
  shortcut on top of it.

**Options page (second surface)**
- **U8.** The "Currently monitoring" list surfaces unread: a PR row is **unread if any
  of its tabs** is unread (OR across the coalesced tabs). This requires extending
  `RegistryEntry` (`lib/registry.ts`) with the `unread` flag (per U2) **and**
  `coalesce()` in `options.tsx` to OR it into `MonitoredItem` — `coalesce` currently
  only carries `status`/`error`, so the per-tab `unread` must be threaded through.
  Show a dot/indicator on the row, and a count in the header. **Header copy rules:**
  when zero rows are unread, **omit** the suffix entirely ("Currently monitoring (5)");
  otherwise append "· N with updates", using the singular "· 1 update" for N=1.
- **U8c.** **Row states.** A row awaiting its first fetch (registered, no status yet
  per U3) shows **no dot** and a neutral "Awaiting status…" — never a flash of unread.
  A row that is both fetch-errored and unread must communicate **both** (see
  Resolve-Before-Planning for the error+unread composition).

**Polling & entry lifecycle (extends favicon R8/R8a) — resolves the two P0 blockers**
- **U9.** **Polling must continue past "settled" so post-settle changes still latch.**
  Today `isSettled` (approved+passing, **or** merged/closed) stops the poll alarm. Redefine
  the stop condition: **only lifecycle-terminal PRs (merged/closed) stop polling.** Open PRs
  — including approved+passing — keep polling at a **slower cadence** (target ~5 min vs the
  ~60 s unsettled floor) so an approved PR that later gets `CHANGES_REQUESTED` or a re-run
  check **while you are away** is still fetched and latches a dot. This is a **three-tier
  cadence**: unsettled (fast) · settled-but-open (slow) · merged/closed (stop). It modifies
  the favicon feature's `isSettled`-driven poll model (R8/R8a) and slightly raises rate-limit
  use for long-open stacks — acceptable given centralized coalescing (R10) and the slow tier.
- **U10.** **A failed redraw push must not prune the registry entry.** `chrome.tabs.onRemoved`
  is the **sole authoritative prune signal** (already wired in `background/index.ts`); SPA
  navigation off a PR already sends `unregisterPr`. Stop deleting the entry inside the
  push-on-failure path — a rejected `sendMessage` to a backgrounded/discarded tab now means
  only "couldn't redraw right now," and the `unread` latch + `seenStatus` + Options row
  **persist** until the tab is actually closed. This is what makes U2's "survives SW eviction"
  (and survives transient/discard send failures) actually hold. Registry memory cost of
  keeping a few stale-receiver entries is trivial.
- **U8a.** It updates **live** via the existing `chrome.storage.onChanged`
  subscription — focusing a PR tab clears its dot, and the Options list reflects that
  without a reload.
- **U8b.** Opening a PR from the list naturally clears its unread (the tab becomes
  visible → U5). No separate "mark read" affordance is required in v1 (a "mark all
  read" button is Deferred).

## Success Criteria
- Box a 10-PR stack, walk away, come back: dots appear on **exactly** the PRs whose
  favicons changed while you were away — none on the rest.
- A freshly boxed stack shows **zero** dots until something actually changes.
- A check that **failed then recovered** while you were away still shows a dot
  (latch) — you learn it flapped.
- Refocusing a PR tab clears its dot **immediately**, and the Options "Currently
  monitoring" entry clears live.
- The unread latch **survives a service-worker eviction** (e.g. 30s+ idle, then a
  poll lands a change on a hidden tab).
- No regression to the favicon, box-select, or token flows.

## Scope Boundaries
- **Not a notification system** — no OS notifications, no sound, no popups. Purely a
  passive visual marker on surfaces you already look at (tab strip + Options).
- **No directional/severity styling** — one dot style for any visible change; the dot
  doesn't encode "got better" vs "got worse" (the half-colors already do).
- **Page Visibility only** (U1b) — app/window-level blur while the tab stays
  foreground does not count as "away" in v1.
- **Favicon + Options list only** — *not* an aggregate count on the toolbar action
  icon in v1 (see Deferred — there's a real conflict with the per-tab `ON` / `!`
  badges).
- Inherits all favicon scope boundaries (github.com only, single token, requires a
  loaded document, etc.).

## Key Decisions
- **Content script reports visibility; background owns the latch** — the page knows
  its own visibility natively (Page Visibility API), so we avoid reconstructing
  multi-window focus in the background while still centralizing unread state for the
  Options surface. This is the load-bearing architectural choice.
- **Latched, not diff-based** — the dot means "activity happened while you were away,"
  so a self-healing flap still leaves a trace until you look.
- **Baseline measured on the rendered favicon** (`toFaviconSpec`), not raw status — an
  unread dot on a visually-identical icon would be confusing.
- **Baseline set silently on first load** — a boxed stack stays clean; the dot
  strictly means "changed since opened / last looked."
- **State reuses the `storage.session` registry** — survives SW eviction for free; the
  Options list already reads this registry, so the second surface is cheap.
- **No new permissions** — `tabs`, `storage`, `alarms` are already in the manifest;
  Page Visibility is a plain web API (verified against `package.json`).
- **Three-tier poll cadence; only merged/closed stop** (U9, resolved 2026-06-11) — the
  unread dot needs ongoing change detection, so an open PR keeps polling (slowly) even after
  it's approved+passing; only lifecycle-terminal PRs stop. Chosen over "accept the gap"
  because catching "approved → changes-requested while away" is a high-value signal.
- **`onRemoved` is the only prune signal** (U10, resolved 2026-06-11) — failed redraw pushes
  no longer delete the entry, so the latch survives backgrounding/discard. Chosen over a
  `tabs.get` re-check on failure because `onRemoved` already authoritatively covers tab close
  and avoids an extra API round-trip on the failure path.

## Dependencies / Assumptions
- **Builds on the PR status favicon feature** — reuses the background registry +
  central `chrome.alarms` poll (`background/index.ts`), the content script
  (`contents/github-pr-favicon.ts`), the favicon renderers (`lib/favicon.ts`), the
  status model (`lib/pr-status.ts`), the registry shape (`lib/registry.ts`), and the
  Options list (`options.tsx`). All are present and committed.
- **No new permissions** (verified: `permissions: [tabs, tabGroups, storage, alarms]`,
  `host_permissions: [https://*/*]`).
- **New message type** `visibility` (content → background); `registerPr` extended to
  carry initial visibility; `prStatus` push extended with `unread`.
- **Favicon redraw works while backgrounded** — assumption to confirm in planning, but
  consistent with how the existing feature already repaints hidden tabs on poll.

## Outstanding Questions

### Resolve Before Planning
*(surfaced by the 2026-06-11 document review — these change behavior or are load-bearing
correctness gaps, so resolve them before `/ce-plan` rather than discovering them mid-build.)*

> **Resolved 2026-06-11** (the two P0 blockers): poll continuation → **U9**; registry-entry
> lifecycle / no prune-on-push → **U10**. See those requirements and Key Decisions.

- **[P1] Page-Visibility-only vs the "walk away" promise.** If the PR tab stays the
  foreground tab while you alt-tab to another app, `visibilityState` stays `visible` → **no
  dot lights** — yet "walk away" is the headline use case. **Decide:** re-scope the
  problem-frame/success-criteria to "changed while this tab was *backgrounded*," or pull the
  v2 `document.hasFocus()`/window-blur signal into v1 for the single-PR-window workflow.
- **[P1] Multi-tab (1 PR open in N tabs) latch — per-tab or per-PR?** U4 latches per-tab; U8
  ORs per-PR. Focusing one tab clears its dot but the Options row stays unread (another
  hidden tab still latched), **contradicting the "Options entry clears live" success
  criterion.** Recommended resolution: focusing **any** tab of a PR clears the latch on
  **all** coalesced tabs of that PR.
- **[P1] Visibility / poll / register ordering (races).** Visibility messages arrive async
  while `chrome.alarms` fires polls; a stale `visible` flag can mark a real change "seen
  live" (lost dot) or latch a change you watched. **Decide** a happens-before guarantee
  (e.g. a monotonic visibility sequence/timestamp on each message + entry; U4 evaluates
  against the latest only) and define handling of a `visibility` message for a tab not yet
  in the registry (buffer vs drop).
- **[P1] Lifecycle "whole" icons + the dot.** Does a merge/close *while away* show a dot
  (it can imply "actionable" on a done PR)? If yes, the canvas `whole` early-return must
  draw the dot too (per U7). **Decide** whether lifecycle-final states suppress or show it.
- **[P1] Never-viewed boxed tab — confirm the contract.** U3 baselines on first fetch
  regardless of visibility, so for a tab you never looked at the dot means "changed since
  **auto-open**," not "since you last looked." Confirm that's intended (it likely is), or
  suppress the latch until the tab has been visible at least once.
- **[P1] Options row: error + unread composition.** A row can be simultaneously
  fetch-errored and unread (e.g. changed, then token revoked). Define how the row shows both.
- **[P2] Robust multi-surface tier vs a cheaper alternative.** The existing Options list
  already updates live; a **relative-timestamp column ("changed 2m ago")** would answer
  "which moved" on the triage surface with no visibility tracking, latch state-machine, new
  message type, or eviction-survival concerns. You chose robust deliberately — but confirm
  the tab-strip dot's glance value justifies that subsystem's ongoing cost over the
  near-free timestamp option, or note why the dot is worth it.

**Advisory (FYI — no decision required, but worth a look):**
- Consider **dropping U6** (re-baseline on `hidden`): U3 (baseline on first load) + U5
  (re-baseline on `visible`) already cover it, and dropping U6 removes a hide-window race.
- Latched dots that never auto-clear risk a **stale/noisy stack** across a long-lived group
  — watch for "dot fatigue" where most flaps self-heal into non-events.
- The unread/seen/latch + header-count model is structurally an inbox; the deferred items
  (mark-all-read, aggregate badge, discard-survival) read like a notifications roadmap,
  which sits in tension with the "not a notification system" boundary — decide if that's a
  deliberate direction or a hard line.
- `prError` (failed poll) interaction with the latch and `seenStatus` is currently
  undefined — specify in planning whether an error→recovery while hidden latches.

### Deferred to Planning / v2
- **[v2] Aggregate toolbar-icon badge** — a global "N PRs with updates" count was
  considered and **declined for v1**: the action badge is already per-tab-overloaded
  (`ON` for box-select, `!` for token errors), and a global count showing on
  unrelated tabs is semantically muddy. Revisit only with a clear badge-precedence
  design.
- **[v2] Survive tab *discard*** — unread survives SW eviction (U2) but **not** a
  Chrome tab-discard: a discarded tab's content script dies, the entry is pruned on
  the next failed push (current behavior), and it re-baselines on restore. Keeping
  unread across discard needs distinguishing discard-vs-close (`chrome.tabs.get`) —
  out of v1.
- **[v2] Count window/app-level blur as "away"** (U1b) — would require also factoring
  `document.hasFocus()` / window blur, with noise-suppression for devtools/omnibox.
- **[v2] "Mark all read"** affordance in the Options list (U8b).
- **[Design][Affects U7]** Exact dot geometry/color/ring at 16px and 32px, validated
  on every half-color background and against the "+".
- **[Technical][Affects U8]** Whether to reorder unread PRs to the top of the Options
  list, and the exact header count copy.
- **[Technical][Affects U4/U5/U6]** Per-tab vs per-PR latch when one PR is open in
  multiple tabs (current model: per-tab, OR'd for the Options row — confirm this is
  the desired behavior).

## Next Steps
-> `/ce-plan` for structured implementation planning
