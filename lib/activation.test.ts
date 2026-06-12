import { describe, expect, it } from "vitest"

import { isArmableUrl } from "./activation"

describe("isArmableUrl", () => {
  it("allows github.com https pages", () => {
    expect(isArmableUrl("https://github.com/acme/api/issues/409")).toBe(true)
    expect(isArmableUrl("https://github.com/")).toBe(true)
  })

  it("rejects non-github hosts (the extension is scoped to GitHub)", () => {
    for (const url of [
      "https://example.com",
      "https://gist.github.com/x", // subdomain, not github.com
      "https://chromewebstore.google.com/detail/x",
      "https://chrome.google.com/webstore/category/extensions"
    ]) {
      expect(isArmableUrl(url)).toBe(false)
    }
  })

  it("rejects non-https and restricted schemes", () => {
    for (const url of [
      "http://github.com",
      "chrome://extensions",
      "chrome-extension://abc/page.html",
      "about:blank",
      "view-source:https://x",
      "file:///tmp/a.html",
      undefined
    ]) {
      expect(isArmableUrl(url)).toBe(false)
    }
  })
})
