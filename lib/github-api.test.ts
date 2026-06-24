import { describe, expect, it, vi } from "vitest"

import {
  fetchOpenPrs,
  fetchPrStatus,
  githubGraphQL,
  validateToken
} from "./github-api"

function mockFetch(opts: {
  status?: number
  body?: unknown
  scopes?: string
  throws?: boolean
}) {
  return vi.fn(async () => {
    if (opts.throws) throw new Error("network")
    const status = opts.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "x-oauth-scopes" ? opts.scopes ?? null : null
      },
      json: async () => opts.body ?? {}
    } as unknown as Response
  })
}

describe("githubGraphQL request timeout", () => {
  it("passes an abort signal to fetch", async () => {
    let init: RequestInit | undefined
    const f = vi.fn(async (_url: string, i: RequestInit) => {
      init = i
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: {} })
      } as unknown as Response
    })
    await githubGraphQL(f as unknown as typeof fetch, "t", "query { x }")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("aborts (rejects) a request that hangs past the timeout", async () => {
    // A fetch that never resolves on its own but honors the abort signal — the
    // real GitHub-stall case. With a tiny timeout the AbortSignal fires quickly.
    const hanging = vi.fn(
      (_url: string, i: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          i.signal?.addEventListener("abort", () =>
            reject((i.signal as AbortSignal).reason)
          )
        })
    )
    await expect(
      githubGraphQL(hanging as unknown as typeof fetch, "t", "q", undefined, 10)
    ).rejects.toBeTruthy()
    // The thrown abort is what callers convert to a typed "network" error
    // (covered by the throw → network cases below), so the in-flight guard clears.
  })
})

describe("validateToken", () => {
  it("empty token → not ok, no fetch", async () => {
    const f = mockFetch({})
    expect(await validateToken(f, "  ")).toEqual({ ok: false })
    expect(f).not.toHaveBeenCalled()
  })

  it("200 with viewer → ok + login", async () => {
    const r = await validateToken(
      mockFetch({ body: { data: { viewer: { login: "octocat" } } } }),
      "t"
    )
    expect(r).toMatchObject({ ok: true, login: "octocat" })
  })

  it("200 without viewer (least-privilege PAT) is still ok", async () => {
    expect(
      await validateToken(mockFetch({ body: { data: { viewer: null } } }), "t")
    ).toMatchObject({ ok: true })
  })

  it("401 → auth error", async () => {
    expect(await validateToken(mockFetch({ status: 401 }), "t")).toEqual({
      ok: false,
      error: "auth"
    })
  })

  it("UNAUTHORIZED graphql error → auth error", async () => {
    expect(
      await validateToken(
        mockFetch({
          body: { errors: [{ type: "UNAUTHORIZED", message: "x" }] }
        }),
        "t"
      )
    ).toEqual({ ok: false, error: "auth" })
  })

  it("network throw → network error", async () => {
    expect(await validateToken(mockFetch({ throws: true }), "t")).toEqual({
      ok: false,
      error: "network"
    })
  })

  it("classic token with write scope → broad-scope warning", async () => {
    const r = await validateToken(
      mockFetch({
        body: { data: { viewer: { login: "x" } } },
        scopes: "repo, gist"
      }),
      "t"
    )
    expect(r).toMatchObject({ ok: true, warn: "broad-scope" })
  })
})

describe("fetchPrStatus", () => {
  const ref = { owner: "o", repo: "r", number: 1 }

  it("happy path → normalized status", async () => {
    const body = {
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            isDraft: false,
            reviewDecision: "APPROVED",
            headRefOid: "h",
            commits: {
              nodes: [
                {
                  commit: { oid: "h", statusCheckRollup: { state: "SUCCESS" } }
                }
              ]
            }
          }
        }
      }
    }
    expect(await fetchPrStatus(mockFetch({ body }), "t", ref)).toEqual({
      ok: true,
      status: {
        review: "approved",
        check: "success",
        state: "open",
        isDraft: false
      }
    })
  })

  it("401 → auth, 403 → rate-limit, throw → network", async () => {
    expect(await fetchPrStatus(mockFetch({ status: 401 }), "t", ref)).toEqual({
      ok: false,
      error: "auth"
    })
    expect(await fetchPrStatus(mockFetch({ status: 403 }), "t", ref)).toEqual({
      ok: false,
      error: "rate-limit"
    })
    expect(await fetchPrStatus(mockFetch({ throws: true }), "t", ref)).toEqual({
      ok: false,
      error: "network"
    })
  })

  it("200 with null repository + errors (no access) → unknown, not none/none", async () => {
    const body = {
      data: { repository: null },
      errors: [{ message: "Resource not accessible by personal access token" }]
    }
    expect(await fetchPrStatus(mockFetch({ body }), "t", ref)).toEqual({
      ok: false,
      error: "unknown"
    })
  })
})

describe("fetchOpenPrs", () => {
  const ref = { owner: "o", repo: "r" }

  it("happy path → maps nodes to ListedPr", async () => {
    const body = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 12,
                isDraft: false,
                title: "Feat",
                author: { login: "octocat" }
              },
              {
                number: 11,
                isDraft: true,
                title: "WIP",
                author: { login: "renovate[bot]" }
              }
            ]
          }
        }
      }
    }
    expect(await fetchOpenPrs(mockFetch({ body }), "t", ref)).toEqual({
      ok: true,
      prs: [
        { number: 12, authorLogin: "octocat", isDraft: false, title: "Feat" },
        {
          number: 11,
          authorLogin: "renovate[bot]",
          isDraft: true,
          title: "WIP"
        }
      ]
    })
  })

  it("null author → empty login; empty nodes → empty list", async () => {
    const nullAuthor = {
      data: {
        repository: {
          pullRequests: { nodes: [{ number: 5, title: "x", author: null }] }
        }
      }
    }
    expect(
      (await fetchOpenPrs(mockFetch({ body: nullAuthor }), "t", ref)).prs
    ).toEqual([{ number: 5, authorLogin: "", isDraft: false, title: "x" }])
    const empty = { data: { repository: { pullRequests: { nodes: [] } } } }
    expect(await fetchOpenPrs(mockFetch({ body: empty }), "t", ref)).toEqual({
      ok: true,
      prs: []
    })
  })

  it("null repository (no access / typo) → notfound", async () => {
    const body = {
      data: { repository: null },
      errors: [{ message: "Could not resolve to a Repository" }]
    }
    expect(await fetchOpenPrs(mockFetch({ body }), "t", ref)).toEqual({
      ok: false,
      error: "notfound"
    })
  })

  it("401 → auth, 403 → rate-limit, throw → network", async () => {
    expect(await fetchOpenPrs(mockFetch({ status: 401 }), "t", ref)).toEqual({
      ok: false,
      error: "auth"
    })
    expect(await fetchOpenPrs(mockFetch({ status: 403 }), "t", ref)).toEqual({
      ok: false,
      error: "rate-limit"
    })
    expect(await fetchOpenPrs(mockFetch({ throws: true }), "t", ref)).toEqual({
      ok: false,
      error: "network"
    })
  })
})
