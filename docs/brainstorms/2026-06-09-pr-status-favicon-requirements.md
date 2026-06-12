---
date: 2026-06-09
topic: pr-status-favicon
---

# GitHub PR Status in the Favicon

## Problem Frame

When juggling many open PR tabs — especially a stack opened in one gesture via
the box-select tool — you can't tell which PRs are approved or passing without
clicking into each. GitHub surfaces neither **review** nor **check** status in
the favicon. This feature encodes both into the favicon of each GitHub PR tab,
so a glance across the tab strip tells you each PR's state. It composes directly
with box-select: box a PR stack into a group, then scan the favicons.

## Status → Favicon Mapping

| Slot | Source (GitHub GraphQL) | States |
|------|-------------------------|--------|
| **A — review** | `pullRequest.reviewDecision` | `APPROVED` → 👍 · `CHANGES_REQUESTED` → 🙏 · `REVIEW_REQUIRED` / none → — (not reviewed) |
| **B — checks** | `commit.statusCheckRollup.state` (head commit) | `SUCCESS` → 🟢 · `PENDING`/`EXPECTED` → 🟡 · `FAILURE`/`ERROR` → 🔴 · no checks → neutral |

In the 16px favicon these render as **color + a corner badge**, not literal
emoji: check status (B) drives the icon's main color, review status (A) is a
small corner badge. `reviewDecision` reflects the *required*-review verdict — a
PR approved but with no required reviewers reads as "not reviewed"; the badge's
meaning is "required-review decision," not raw approval count.

Two constraints are **locked here** (exact glyphs remain a planning design detail):
- **Color-blind safe** — states must differ by **shape**, not hue alone, and be
  validated at real 16px / 32px (the corner badge has a ~6px budget).
- **Distinct, non-empty states** — including **"no checks" (neutral)** and a
  **"fetching"** state (before the first result). None may look like the
  unmodified GitHub favicon, so the user can always tell the extension is active.

## Requirements

**Activation & Scope**
- R1. Acts only on GitHub PR pages — path `/{owner}/{repo}/pull/{number}` on `github.com` (including the PR's `/files`, `/commits`, `/checks` subtabs); no effect on other pages, and explicitly not on `github.dev` or `gist.github.com`. The match is re-evaluated on SPA navigation (R7).
- R2. Status is read from the GitHub GraphQL API in a **single query per fetch** (`reviewDecision`, head-commit `statusCheckRollup.state`, plus PR `state` and `isDraft`); R8 governs how often that fetch repeats. The fetch runs in the **background worker** (existing `host_permissions: ["https://*/*"]` already covers `api.github.com`, so no CORS issue); the **derived status only — never the token —** is messaged to the content script.
- R9. **Normalize the result:** any null field (`reviewDecision` null; `statusCheckRollup` null for no-checks / fork / no-commit head) maps to a defined state and **never throws** into the fail-silent path. Distinguish "no checks" from "no access" where the API allows. For `CLOSED`/`MERGED` PRs, stop polling (R8) and show a distinct terminal favicon (or restore GitHub's); drafts are treated as open.

**Token & Settings**
- R3. An extension **Options page** lets the user paste, store, and **clear** a GitHub personal access token. It is stored in **`chrome.storage.local`** — persists across restarts; **not** `sync` (would replicate the secret across devices), **not** `session` (wiped on restart, unlike the box-select color counter).
- R3a. **The token stays in the background worker.** Only the background reads it from storage and calls the API; it is never messaged to, nor read by, any content script (the box-select content script runs on *all* https pages). The endpoint is **hard-coded to `https://api.github.com/graphql`**, never built from page input.
- R4. Until a token is configured, the favicon is left untouched — a silent no-op, no nag.
- R5. On network / API / rate-limit / auth failure, leave the **page** favicon unchanged and never break the page.
- R5a. But a token problem must be **discoverable** — surface auth/token errors where the user can see them (a badge on the extension action icon and/or a "last error / token invalid" line on the Options page), so a revoked or expired token doesn't silently freeze every favicon at a stale, trusted-looking state.

**Rendering & Lifecycle**
- R6. Replace the page favicon by **capturing** GitHub's `<link rel="icon">`, removing it, and injecting a `<canvas>`-drawn data-URI icon encoding A + B per the mapping. Show the **"fetching"** state immediately on injection, before the first result lands.
- R7. Keep the custom favicon asserted against GitHub's own updates (Turbo/pjax soft nav, GitHub re-setting its icon) via a `<head>` `MutationObserver` that **ignores its own writes** (tag the injected node) and **debounces** re-assertion — avoiding a self-triggered loop or visible flicker. Re-detect the PR on SPA navigation.
- R7a. **Restore** GitHub's captured original favicon when leaving the PR (SPA nav to a non-PR URL), when the token is cleared, and on teardown — so R1's "no effect on other pages" holds across soft navigation.
- R8. **Refresh model:** fetch on page **load** (so background tabs opened by box-select paint once loaded — *not* gated on focus) and on tab focus; poll while **not settled**, stop when settled. **Settled** = check ∈ {`SUCCESS`, `FAILURE`/`ERROR`} **and** review ∈ {`APPROVED`, `CHANGES_REQUESTED`}, **or** PR `state` is `CLOSED`/`MERGED`.
- R8a. Polling is driven by **`chrome.alarms`** (an MV3 service worker is evicted after ~30s idle, so `setTimeout`/`setInterval` won't survive) at the **~60s floor** with per-PR jitter; the still-pending set persists in `chrome.storage.session` across worker restarts. Requires a new **`alarms`** permission.
- R10. **Cross-tab coordination:** fetching/polling for all PR tabs is centralized in the background worker, which coalesces requests and backs off on secondary rate-limit — so a large box-selected stack (the core use case) doesn't exhaust the GitHub rate limit.

## Success Criteria
- With a token set, a PR tab's favicon reflects both review + check status within a few seconds of load, and a pending→complete check updates within ~a minute (the `chrome.alarms` floor) without a manual refresh.
- After box-selecting a PR stack, the favicons of the **loaded** tabs show at a glance which PRs are approved and which are passing/failing — no clicking in. (A tab that has never loaded has no favicon yet.)
- With **no** token, the extension never changes the page and produces no errors; a token *problem* is discoverable (R5a), not a silent freeze of stale icons.

## Scope Boundaries
- **Favicon only** — the `A | B | original-title` title-prefix idea is out for this feature (a favicon has no text; slot C doesn't apply).
- **github.com only** — GitHub Enterprise, `github.dev`, and gist are out of v1.
- Single token; no multi-account / per-org tokens.
- No user-customizable colors/glyphs in v1.
- The favicon is per **loaded** document — a tab must have loaded at least once for its favicon to update; the extension does not render into never-loaded tabs.
- Does not change or conflict with the box-select toolbar-click activation; the Options page is a separate surface.

## Key Decisions
- **GitHub GraphQL API + token over DOM scraping** (user choice) — authoritative and stable; one query returns both `reviewDecision` and `statusCheckRollup.state`.
- **Fetch in the background worker, draw in the content script** — background avoids CORS and reuses `https://*/*` host permission; content script owns the favicon DOM.
- **Color + corner badge encoding** — two legible channels at 16px; avoids unreliable emoji-on-canvas and cramped split halves.
- **Poll-while-pending @ ~60s + jitter, stop when settled** — live `🟡→🟢` updates without burning rate limit on long-settled PRs; jitter avoids a thundering herd when many PR tabs are open.
- **Options page for the token; silent until set** — no setup nag (but errors are discoverable, R5a).
- **Token in `chrome.storage.local`, confined to the background worker** — persists across restarts, never crosses into a content script; API endpoint hard-coded to `api.github.com`.
- **`chrome.alarms`-driven polling** — survives MV3 worker eviction (a plain timer would not); centralized in the background for cross-tab rate-limit safety.
- **Capture & restore GitHub's original favicon** — leaving a PR (incl. SPA nav) reverts cleanly so other pages are untouched.

## Dependencies / Assumptions
- `host_permissions: ["https://*/*"]` (current manifest) already covers `https://api.github.com/*` — **no new host permission needed** (verified against the current manifest).
- `storage` permission is already present (added for the box-select color counter) — reused for the token.
- **New `"alarms"` permission required** (for R8a polling) — not in the current manifest.
- New surface: a Plasmo **Options page** (`options.tsx`) — the extension currently has no popup/options page (`popup.tsx` was removed). Verified: adding `options.tsx` does **not** re-introduce a `default_popup` or alter the box-select `chrome.action.onClicked` activation.
- A GitHub-scoped content script — note the existing `https://*/*` box-select content script **already runs on PR pages**, so the two coexist on the same document and share the `chrome.runtime` message channel; each `onMessage` listener must return false for message types it doesn't own. Reuse-vs-new is a planning call.
- Token scope: **prefer a fine-grained PAT** with **Pull requests: Read** + **Commit statuses: Read** (least privilege); a classic `repo` token also works but grants write access — avoid for this read-only feature.

## Outstanding Questions

### Resolve Before Planning
- (none — all product decisions resolved)

### Deferred to Planning
- [Affects R6][Technical] Exact favicon visual within the locked constraints: glyph/shape set, palette, custom status icon vs tinted GitHub mark, corner-badge position.
- [Affects R7][Needs research] How aggressively GitHub re-sets its own favicon on a PR page today, to size the R7 debounce + self-mutation guard.
- [Affects R2/R9][Technical] Exact GraphQL query shape, and whether to also query `latestReviews` to separate "approved but not required" from "genuinely unreviewed."
- [Affects R3/R5a][Technical] Concrete Options-page token-validation UX (a `GET /user` "test token" call? inline error states?).
- [Affects R10][Technical] Concrete batching/coalescing + back-off strategy for centralized cross-tab fetching.

## Next Steps
-> `/ce-plan` for structured implementation planning
