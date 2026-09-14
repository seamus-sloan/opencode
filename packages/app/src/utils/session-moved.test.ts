import { describe, expect, test } from "bun:test"
import { isSessionMovedType, sessionMovedData } from "./session-moved"

describe("isSessionMovedType", () => {
  test("accepts both protocol names", () => {
    expect(isSessionMovedType("session.moved")).toBe(true)
    expect(isSessionMovedType("session.next.moved")).toBe(true)
  })

  test("rejects anything else", () => {
    expect(isSessionMovedType("session.updated")).toBe(false)
    expect(isSessionMovedType("session.forked")).toBe(false)
    expect(isSessionMovedType(undefined)).toBe(false)
  })
})

describe("sessionMovedData", () => {
  test("reads the in-repo payload with subdirectory", () => {
    expect(
      sessionMovedData({
        sessionID: "ses_1",
        location: { directory: "/worktrees/feature", workspaceID: "wrk_1" },
        subdirectory: "packages/core",
      }),
    ).toEqual({
      sessionID: "ses_1",
      directory: "/worktrees/feature",
      workspaceID: "wrk_1",
      projectID: undefined,
      subpath: "packages/core",
    })
  })

  test("reads the released payload with subpath and projectID", () => {
    expect(
      sessionMovedData({
        sessionID: "ses_1",
        location: { directory: "/repo" },
        projectID: "prj_1",
        subpath: "packages/app",
      }),
    ).toEqual({
      sessionID: "ses_1",
      directory: "/repo",
      workspaceID: undefined,
      projectID: "prj_1",
      subpath: "packages/app",
    })
  })

  test("prefers subpath when a server sends both", () => {
    expect(
      sessionMovedData({
        sessionID: "ses_1",
        location: { directory: "/repo" },
        subpath: "a",
        subdirectory: "b",
      })?.subpath,
    ).toBe("a")
  })

  test("rejects payloads without an addressable session and directory", () => {
    expect(sessionMovedData(undefined)).toBeUndefined()
    expect(sessionMovedData(null)).toBeUndefined()
    expect(sessionMovedData({ sessionID: "ses_1" })).toBeUndefined()
    expect(sessionMovedData({ location: { directory: "/repo" } })).toBeUndefined()
    expect(sessionMovedData({ sessionID: "ses_1", location: {} })).toBeUndefined()
    expect(sessionMovedData({ sessionID: 1, location: { directory: "/repo" } })).toBeUndefined()
  })
})
