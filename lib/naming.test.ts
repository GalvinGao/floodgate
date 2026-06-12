import { describe, expect, it } from "vitest"

import { deriveGroupName } from "./naming"

describe("deriveGroupName", () => {
  it("derives '{repo} #{n}' from a GitHub issue or PR URL", () => {
    expect(
      deriveGroupName({
        url: "https://github.com/acme/api/issues/409"
      })
    ).toBe("api #409")
    expect(
      deriveGroupName({
        url: "https://github.com/acme/api/pull/410"
      })
    ).toBe("api #410")
  })

  it("falls back to the page title for non-GitHub pages", () => {
    expect(
      deriveGroupName({ url: "https://example.com/x", title: "Example Board" })
    ).toBe("Example Board")
  })

  it("falls back to hostname when the title is empty", () => {
    expect(deriveGroupName({ url: "https://example.com/x", title: "  " })).toBe(
      "example.com"
    )
  })

  it("falls back to 'Tab Group' when there is no host or title", () => {
    expect(deriveGroupName({ url: "about:blank", title: "" })).toBe("Tab Group")
  })

  it("does not treat non-issue/PR GitHub pages as a stack", () => {
    expect(
      deriveGroupName({
        url: "https://github.com/search?q=plasmo",
        title: "Search"
      })
    ).toBe("Search")
  })
})
