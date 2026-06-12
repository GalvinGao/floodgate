import { describe, expect, it } from "vitest"

import { parsePrUrl } from "./github-pr"

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
})
