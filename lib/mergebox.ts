/**
 * Pure helpers for reading GitHub's PR "mergebox" from the DOM. Used by the
 * content script's signal observer (lib has no DOM at runtime, but jsdom lets
 * these be unit-tested against the real markup).
 *
 * Robustness rule (R7): match only GitHub's *stable* hooks —
 * `data-testid="mergebox-partial"`, the mergeability icon's `aria-label`, and the
 * Octicon class — never the content-hashed CSS-module class names
 * (`MergeBox-module__…`), which rotate on every GitHub deploy.
 */

export type TerminalState = "merged" | "closed"

const OCTICON_WITH_LABEL = "[class~='octicon'][aria-label]"

/** The mergebox partial, or null when it isn't on the page (e.g. a sub-tab without it). */
export function findMergeboxRegion(root: ParentNode): Element | null {
  return root.querySelector("[data-testid='mergebox-partial']")
}

/** Read the lifecycle terminal state from a known mergebox region element. */
function lifecycleFromRegion(region: Element): TerminalState | null {
  // Primary: the mergeability status icon's aria-label reflects the lifecycle
  // ("Merged" / "Closed" / "Open" / "Draft" / …). Authoritative and stable.
  for (const icon of region.querySelectorAll(OCTICON_WITH_LABEL)) {
    const label = icon.getAttribute("aria-label")?.trim().toLowerCase()
    if (label === "merged") return "merged"
    if (label === "closed") return "closed"
  }
  // Fallback: the Octicon class, but ONLY inside the dedicated mergeability icon
  // wrapper, so a "Merge" button's git-merge octicon elsewhere can't false-positive.
  const wrapper = region.querySelector(
    "[data-testid='mergeability-icon-wrapper']"
  )
  const cls =
    wrapper?.querySelector("[class~='octicon']")?.getAttribute("class") ?? ""
  if (/\bocticon-git-merge\b/.test(cls)) return "merged"
  if (/octicon-git-pull-request-closed/.test(cls)) return "closed"
  return null
}

/**
 * The unambiguous terminal state (merged / closed) if the mergebox shows one,
 * else null. Returns null for open/draft/conflicting and when the region is absent.
 */
export function detectTerminalState(root: ParentNode): TerminalState | null {
  const region = findMergeboxRegion(root)
  return region ? lifecycleFromRegion(region) : null
}

/**
 * A cheap, stable-hook signature of the mergebox's *meaningful* state. The signal
 * observer pokes only when this changes, so streaming CI logs / comments / reactions
 * (which don't touch the lifecycle, the status-icon aria-labels, or the summary
 * heading) don't generate pokes. Empty string when the region is absent.
 */
export function mergeboxSignature(root: ParentNode): string {
  const region = findMergeboxRegion(root)
  if (!region) return ""
  const terminal = lifecycleFromRegion(region) ?? "open"
  // Every status icon's aria-label — review state, checks rollup, mergeability —
  // captures review/check changes that render as icons.
  const labels = Array.from(region.querySelectorAll(OCTICON_WITH_LABEL))
    .map((el) => el.getAttribute("aria-label")?.trim() ?? "")
    .filter(Boolean)
    .sort()
  // The summary heading captures state GitHub renders as prose rather than an icon.
  const heading =
    region.querySelector("h3")?.textContent?.trim().slice(0, 120) ?? ""
  return `${terminal}|${labels.join(",")}|${heading}`
}
