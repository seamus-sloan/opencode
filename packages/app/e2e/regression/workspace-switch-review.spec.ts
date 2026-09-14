import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const root = "C:/OpenCode/WorkspaceSwitch"
const worktree = "C:/OpenCode/WorkspaceSwitch-feature"
const projectID = "proj_workspace_switch"
const sessionID = "ses_workspace_switch"
const title = "Workspace switch"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

const rootFile = "src/root-only.ts"
const worktreeFile = "src/worktree-only.ts"

// The server's projector rewrites `session.directory` when it publishes
// `session.next.moved`, and the app re-resolves the session afterwards. The mock
// has to move with it, otherwise the re-resolve reverts the workspace.
function sessionRow(directory: string) {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

// End-to-end contract for an agent-driven workspace switch: the session starts in
// the repository root, the server publishes `session.next.moved` when the
// `workspace` tool repoints it at a linked worktree, and the Files Changed panel
// must rebind to the worktree without losing the conversation.
test("follows a session workspace switch in the Files Changed panel", async ({ page }) => {
  const transport = await installSseTransport<{ directory: string; payload: unknown }>(page, { server, retry: 20 })
  const sessions = await setup(page)

  await page.goto(sessionHref())
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  await page.getByRole("button", { name: "Toggle review" }).click()
  const review = page.locator('#review-panel [data-component="session-review-v2"]')
  await expectAppVisible(review)

  const rootChange = page.getByRole("button", { name: "root-only.ts" })
  const worktreeChange = page.getByRole("button", { name: "worktree-only.ts" })
  await expectAppVisible(rootChange)
  await expect(worktreeChange).toHaveCount(0)

  await moveSession(transport, sessions, worktree)

  // Rebinds to the worktree: its change appears and the root's disappears.
  await expectAppVisible(worktreeChange)
  await expect(rootChange).toHaveCount(0)
  // The conversation survives the move.
  await expectSessionTitle(page, title)

  // Switching back restores the root's changes.
  await moveSession(transport, sessions, root)
  await expectAppVisible(rootChange)
  await expect(worktreeChange).toHaveCount(0)
  await expectSessionTitle(page, title)
})

// A rejected switch never reaches the event stream, so the panel must keep
// showing the current workspace.
test("keeps the Files Changed panel bound when a workspace switch fails", async ({ page }) => {
  const transport = await installSseTransport<{ directory: string; payload: unknown }>(page, { server, retry: 20 })
  const sessions = await setup(page)

  await page.goto(sessionHref())
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  await page.getByRole("button", { name: "Toggle review" }).click()
  await expectAppVisible(page.locator('#review-panel [data-component="session-review-v2"]'))
  await expectAppVisible(page.getByRole("button", { name: "root-only.ts" }))

  // A failed `workspace` call surfaces as a tool failure, not a move.
  await transport.send({
    directory: root,
    payload: {
      type: "session.error",
      properties: { sessionID, error: { name: "UnknownError", data: { message: "Not a Git repository" } } },
    },
  })

  await expectAppVisible(page.getByRole("button", { name: "root-only.ts" }))
  await expect(page.getByRole("button", { name: "worktree-only.ts" })).toHaveCount(0)
})

async function moveSession(
  transport: Awaited<ReturnType<typeof installSseTransport<{ directory: string; payload: unknown }>>>,
  sessions: Record<string, unknown>[],
  directory: string,
) {
  sessions[0]!.directory = directory
  await transport.send({
    directory: root,
    payload: {
      type: "session.next.moved",
      properties: { sessionID, location: { directory }, subdirectory: "", timestamp: Date.now() },
    },
  })
}

async function setup(page: Page) {
  const sessions = [sessionRow(root)]
  await mockOpenCodeServer(page, {
    directory: root,
    workspaces: [worktree],
    project: {
      id: projectID,
      worktree: root,
      vcs: "git",
      name: "workspace-switch",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions,
    vcsDiff: (directory) => [fileDiff(directory === worktree ? worktreeFile : rootFile)],
    pageMessages: () => ({ items: [] }),
  })

  await page.addInitScript(
    ({ root, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: root, expanded: true }] },
          lastProject: { local: root },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { root, server, sessionID },
  )
  return sessions
}

function sessionHref() {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function fileDiff(file: string) {
  return {
    file,
    additions: 1,
    deletions: 1,
    status: "modified",
    patch: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const value = 'before'\n+export const value = 'after'\n`,
  }
}
