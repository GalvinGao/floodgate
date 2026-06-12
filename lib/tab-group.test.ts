import { describe, expect, it, vi } from "vitest"

import { openAndGroup, type TabGroupApi } from "./tab-group"

function mockApi(overrides: Partial<TabGroupApi> = {}): TabGroupApi {
  let nextId = 1
  return {
    create: vi.fn(async () => nextId++),
    group: vi.fn(async () => 99),
    update: vi.fn(async () => {}),
    ...overrides
  }
}

describe("openAndGroup", () => {
  it("creates every tab, then groups all ids once, then titles + colors", async () => {
    const api = mockApi()
    const result = await openAndGroup(
      ["https://a", "https://b", "https://c"],
      "api #409",
      0,
      api
    )

    expect(api.create).toHaveBeenCalledTimes(3)
    expect(api.group).toHaveBeenCalledTimes(1)
    expect(api.group).toHaveBeenCalledWith([1, 2, 3])
    expect(api.update).toHaveBeenCalledWith(99, {
      title: "api #409",
      color: "grey"
    })
    expect(result).toMatchObject({ groupId: 99, opened: 3, failed: 0 })
  })

  it("places the lead tab (current page) first in the group", async () => {
    const api = mockApi() // create() returns 1, 2, 3…
    const result = await openAndGroup(
      ["https://a", "https://b"],
      "x",
      0,
      api,
      7
    )

    // Lead tab id prepended ahead of the freshly opened link tabs.
    expect(api.group).toHaveBeenCalledWith([7, 1, 2])
    // The lead tab is not counted as "opened" — only the links are.
    expect(result).toMatchObject({ opened: 2, failed: 0, groupId: 99 })
  })

  it("omits the lead tab from the group when none is provided", async () => {
    const api = mockApi()
    await openAndGroup(["https://a"], "x", 0, api)
    expect(api.group).toHaveBeenCalledWith([1])
  })

  it("does not group or update an empty link set", async () => {
    const api = mockApi()
    const result = await openAndGroup([], "x", 0, api)

    expect(api.create).not.toHaveBeenCalled()
    expect(api.group).not.toHaveBeenCalled()
    expect(api.update).not.toHaveBeenCalled()
    expect(result.groupId).toBeNull()
  })

  it("keeps successful tabs when some creates fail (partial-open accepted)", async () => {
    const api = mockApi({
      create: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error("blocked"))
        .mockResolvedValueOnce(3)
    })
    const result = await openAndGroup(["a", "b", "c"], "x", 0, api)

    expect(api.group).toHaveBeenCalledWith([1, 3])
    expect(result).toMatchObject({ opened: 2, failed: 1, groupId: 99 })
  })

  it("does not group when every create fails", async () => {
    const api = mockApi({
      create: vi.fn().mockRejectedValue(new Error("blocked"))
    })
    const result = await openAndGroup(["a", "b"], "x", 0, api)

    expect(api.group).not.toHaveBeenCalled()
    expect(result).toMatchObject({ opened: 0, failed: 2, groupId: null })
  })

  it("picks the color from the passed counter", async () => {
    const api = mockApi()
    const result = await openAndGroup(["https://a"], "x", 1, api)

    expect(result.colorUsed).toBe("blue")
    expect(api.update).toHaveBeenCalledWith(99, { title: "x", color: "blue" })
  })
})
