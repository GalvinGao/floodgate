import { describe, expect, it } from "vitest"

import { isPrCommitUrl, parsePrUrl } from "./github-pr"

const SHA = "ead092bc8781c79bf01f7db2b641ddeef2b0a181"

describe("parsePrUrl", () => {
  it("parses a PR URL and its subtabs", () => {
    expect(parsePrUrl("https://github.com/acme/api/pull/409")).toEqual({
      owner: "acme",
      repo: "api",
      number: 409
    })
    expect(parsePrUrl("https://github.com/o/r/pull/409/files")).toEqual({
      owner: "o",
      repo: "r",
      number: 409
    })
  })

  it("rejects non-PR pages and non-github hosts", () => {
    for (const url of [
      "https://github.com/o/r/pulls",
      "https://github.com/o/r/issues/409",
      "https://github.dev/o/r/pull/409",
      "https://gist.github.com/o/r/pull/409",
      "https://example.com/o/r/pull/409",
      "not a url"
    ]) {
      expect(parsePrUrl(url)).toBeNull()
    }
  })

  it("still resolves a specific-commit URL to its PR ref", () => {
    // parsePrUrl collapses every subtab onto the PR; isPrCommitUrl is what
    // distinguishes the single-commit view for the dedup carve-out.
    expect(
      parsePrUrl(`https://github.com/acme/api/pull/31/commits/${SHA}`)
    ).toEqual({
      owner: "acme",
      repo: "api",
      number: 31
    })
  })
})

describe("isPrCommitUrl", () => {
  it("matches a specific-commit view within a PR", () => {
    expect(
      isPrCommitUrl(`https://github.com/acme/api/pull/31/commits/${SHA}`)
    ).toBe(true)
    // abbreviated sha + trailing slash
    expect(
      isPrCommitUrl("https://github.com/o/r/pull/9/commits/ead092b/")
    ).toBe(true)
  })

  it("does not match the PR itself or its non-commit subtabs", () => {
    for (const url of [
      "https://github.com/acme/api/pull/31",
      "https://github.com/acme/api/pull/31/files",
      "https://github.com/acme/api/pull/31/checks",
      // the commits *list* tab is part of the PR, not a single commit
      "https://github.com/acme/api/pull/31/commits",
      "https://github.com/acme/api/pull/31/commits/"
    ]) {
      expect(isPrCommitUrl(url)).toBe(false)
    }
  })

  it("rejects non-PR and non-github URLs", () => {
    for (const url of [
      `https://github.com/o/r/commit/${SHA}`,
      `https://github.dev/o/r/pull/31/commits/${SHA}`,
      "https://github.com/o/r/pull/31/commits/not-a-sha",
      "not a url"
    ]) {
      expect(isPrCommitUrl(url)).toBe(false)
    }
  })
})
