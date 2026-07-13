import { describe, expect, it } from "vitest"

import {
  detectTerminalState,
  findMergeboxRegion,
  mergeboxSignature
} from "./mergebox"

function root(html: string): HTMLElement {
  const el = document.createElement("div")
  el.innerHTML = html
  return el
}

// Mirrors the real merged mergebox (origin doc fragment), trimmed to the stable
// hooks: data-testid, the mergeability icon's aria-label + Octicon class, heading.
const MERGED = `
  <div class="tmp-ml-md-6" data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg data-component="Octicon" aria-label="Merged"
           class="octicon octicon-git-merge fgColor-onEmphasis"></svg>
    </div>
    <h3 class="MergeBoxSectionHeader-module__heading__Kr_f8">Pull request successfully merged and closed</h3>
  </div>`

const CLOSED = `
  <div data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg aria-label="Closed" class="octicon octicon-git-pull-request-closed"></svg>
    </div>
    <h3>Closed with unmerged commits</h3>
  </div>`

const OPEN = `
  <div data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg aria-label="Open" class="octicon octicon-git-pull-request"></svg>
    </div>
    <h3>This branch has no conflicts with the base branch</h3>
    <svg aria-label="3 checks passed" class="octicon octicon-check"></svg>
  </div>`

// An OPEN, mergeable PR renders the SAME git-merge glyph as a merged PR (only the
// color + aria-label differ). With no "Merged" aria-label this must NOT be read as
// merged — regression guard for the favicon flashing purple on every ready-to-merge
// PR while the confirming fetch was still in flight.
const OPEN_MERGEABLE_BY_CLASS = `
  <div data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg class="octicon octicon-git-merge"></svg>
    </div>
    <h3>This branch has no conflicts with the base branch</h3>
  </div>`

// Closed PR whose icon dropped the aria-label → exercises the retained class
// fallback (the closed glyph is unique to closed PRs, so it stays trustworthy).
const CLOSED_BY_CLASS = `
  <div data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg class="octicon octicon-git-pull-request-closed"></svg>
    </div>
  </div>`

// Open PR, but a status check elsewhere in the region is literally named "Merged".
// The mergeability icon (the authoritative signal) says Open → must stay null.
const FALSE_FRIEND = `
  <div data-testid="mergebox-partial">
    <div data-testid="mergeability-icon-wrapper">
      <svg aria-label="Open" class="octicon octicon-git-pull-request"></svg>
    </div>
    <svg aria-label="Merged" class="octicon octicon-check"></svg>
  </div>`

// Only a hashed CSS-module class signals "merged" — no aria-label, no octicon class.
const HASHED_ONLY = `
  <div data-testid="mergebox-partial">
    <div class="MergeBox-module__merged__MTXP9"><span>merged</span></div>
  </div>`

const NO_REGION = `<div data-testid="files-tab"><div class="diff">@@ -1 +1 @@</div></div>`

describe("findMergeboxRegion", () => {
  it("returns the partial when present, null when absent", () => {
    expect(findMergeboxRegion(root(MERGED))).not.toBeNull()
    expect(findMergeboxRegion(root(NO_REGION))).toBeNull()
  })
})

describe("detectTerminalState", () => {
  it("reads merged from the mergeability icon aria-label", () => {
    expect(detectTerminalState(root(MERGED))).toBe("merged")
  })

  it("reads closed from aria-label + octicon class", () => {
    expect(detectTerminalState(root(CLOSED))).toBe("closed")
  })

  it("reads closed from the octicon class when the aria-label is absent", () => {
    expect(detectTerminalState(root(CLOSED_BY_CLASS))).toBe("closed")
  })

  it("does NOT read merged from the git-merge glyph alone (open mergeable PR)", () => {
    // The glyph is shared with a merged PR; only aria-label="Merged" is decisive.
    expect(detectTerminalState(root(OPEN_MERGEABLE_BY_CLASS))).toBeNull()
  })

  it("returns null for an open PR", () => {
    expect(detectTerminalState(root(OPEN))).toBeNull()
  })

  it("ignores a non-mergeability octicon named 'Merged' (no false positive)", () => {
    expect(detectTerminalState(root(FALSE_FRIEND))).toBeNull()
  })

  it("returns null when the region is absent", () => {
    expect(detectTerminalState(root(NO_REGION))).toBeNull()
  })

  it("does NOT infer state from hashed CSS-module class names", () => {
    expect(detectTerminalState(root(HASHED_ONLY))).toBeNull()
  })
})

describe("mergeboxSignature", () => {
  it("is empty when the region is absent", () => {
    expect(mergeboxSignature(root(NO_REGION))).toBe("")
  })

  it("is stable for identical input and differs across lifecycle states", () => {
    expect(mergeboxSignature(root(MERGED))).toBe(
      mergeboxSignature(root(MERGED))
    )
    expect(mergeboxSignature(root(MERGED))).not.toBe(
      mergeboxSignature(root(OPEN))
    )
  })

  it("changes when the checks summary changes", () => {
    const passing = mergeboxSignature(root(OPEN))
    const failing = mergeboxSignature(
      root(OPEN.replace("3 checks passed", "1 check failed"))
    )
    expect(passing).not.toBe(failing)
  })

  it("ignores streaming content that isn't a status icon or the heading", () => {
    const before = mergeboxSignature(root(OPEN))
    const withLog = mergeboxSignature(
      root(
        OPEN.replace(
          "</div>",
          "</div><div class='timeline'>build log line streamed in</div>"
        )
      )
    )
    expect(withLog).toBe(before)
  })
})
