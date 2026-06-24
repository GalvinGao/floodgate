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

  it("returns null for an open PR", () => {
    expect(detectTerminalState(root(OPEN))).toBeNull()
  })

  it("returns null when the region is absent", () => {
    expect(detectTerminalState(root(NO_REGION))).toBeNull()
  })

  it("does NOT infer state from hashed CSS-module class names (R7)", () => {
    expect(detectTerminalState(root(HASHED_ONLY))).toBeNull()
  })
})

describe("mergeboxSignature", () => {
  it("is empty when the region is absent", () => {
    expect(mergeboxSignature(root(NO_REGION))).toBe("")
  })

  it("is stable for identical input and differs across lifecycle states", () => {
    expect(mergeboxSignature(root(MERGED))).toBe(mergeboxSignature(root(MERGED)))
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

  it("ignores streaming content that isn't a status icon or the heading (R4)", () => {
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
