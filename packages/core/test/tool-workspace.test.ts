import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorkspaceTool } from "@opencode-ai/core/tool/workspace"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_workspace_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  // Ignore any hooks the developer configured globally; a commit-msg or
  // pre-commit hook would otherwise reject this fixture's commit.
  await $`git config core.hooksPath ${path.join(directory, ".git", "no-hooks")}`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

/**
 * Builds a real repository plus a linked worktree, because the tool's contract is
 * defined by Git worktree identity: `Project.resolve` must map both checkouts to
 * the same project ID for the move to be allowed.
 */
const withWorkspace = <A, E>(
  body: (input: {
    readonly registry: ToolRegistry.Interface
    readonly source: AbsolutePath
    readonly linked: AbsolutePath
    readonly plain: AbsolutePath
    readonly directoryOf: (id: SessionV2.ID) => Effect.Effect<string | undefined>
  }) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const source = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
    const linkedPath = `${root.path}-linked`
    const plainPath = `${root.path}-plain`
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.all([
          fs.rm(linkedPath, { recursive: true, force: true }),
          fs.rm(plainPath, { recursive: true, force: true }),
        ]),
      ).pipe(Effect.ignore),
    )
    yield* Effect.promise(() => $`git worktree add --detach ${linkedPath} HEAD`.cwd(root.path).quiet())
    yield* Effect.promise(() => fs.mkdir(plainPath, { recursive: true }))
    const linked = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(linkedPath)))
    const plain = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(plainPath)))

    const activeLocation = Layer.succeed(Location.Service, Location.Service.of(location({ directory: source })))
    return yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "workspace",
          directory: source,
          title: "workspace",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* body({
        registry: yield* ToolRegistry.Service,
        source,
        linked,
        plain,
        directoryOf: (id) =>
          db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, id))
            .get()
            .pipe(
              Effect.orDie,
              Effect.map((row) => row?.directory),
            ),
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            MoveSession.node,
            Project.node,
            ProjectDirectories.node,
            SessionProjector.node,
            SessionStore.node,
            ToolRegistry.node,
            ToolRegistry.toolsNode,
            WorkspaceTool.node,
          ]),
          [
            [Location.node, activeLocation],
            [PermissionV2.node, permission],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        ),
      ),
    )
  }).pipe(Effect.scoped)

const run = <A, E>(body: Parameters<typeof withWorkspace<A, E>>[0]) =>
  Effect.runPromise(
    Effect.suspend(() => {
      assertions.length = 0
      denyAction = undefined
      return withWorkspace(body)
    }),
  )

const call = (directory: string, id = "call-workspace") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: WorkspaceTool.name, input: { directory } },
})

describe("WorkspaceTool", () => {
  test("registers and moves the session to a linked worktree", async () => {
    await run(({ registry, source, linked, directoryOf }) =>
      Effect.gen(function* () {
        expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([WorkspaceTool.name])
        expect(yield* settleTool(registry, call(linked))).toMatchObject({
          output: { structured: { directory: linked, previous: source } },
        })
        expect(yield* directoryOf(sessionID)).toBe(linked)
        expect(assertions).toMatchObject([{ sessionID, action: "workspace", resources: [linked], save: [linked] }])
      }),
    )
  })

  test("resolves a relative directory against the current workspace", async () => {
    await run(({ registry, linked, directoryOf }) =>
      Effect.gen(function* () {
        const relative = path.relative(path.dirname(linked), linked)
        yield* settleTool(registry, call(path.join("..", relative)))
        expect(yield* directoryOf(sessionID)).toBe(linked)
      }),
    )
  })

  test("leaves the workspace unchanged when permission is denied", async () => {
    await run(({ registry, source, linked, directoryOf }) =>
      Effect.gen(function* () {
        denyAction = WorkspaceTool.name
        expect(yield* executeTool(registry, call(linked))).toEqual({
          type: "error",
          value: "Workspace switch was not permitted",
        })
        expect(yield* directoryOf(sessionID)).toBe(source)
      }),
    )
  })

  test("leaves the workspace unchanged for a directory that does not exist", async () => {
    await run(({ registry, source, linked, directoryOf }) =>
      Effect.gen(function* () {
        const missing = path.join(linked, "nope")
        expect(yield* executeTool(registry, call(missing))).toEqual({
          type: "error",
          value: `Directory does not exist or is not readable: ${missing}`,
        })
        expect(yield* directoryOf(sessionID)).toBe(source)
      }),
    )
  })

  test("leaves the workspace unchanged for a file", async () => {
    await run(({ registry, source, linked, directoryOf }) =>
      Effect.gen(function* () {
        const file = path.join(linked, "tracked.txt")
        expect(yield* executeTool(registry, call(file))).toEqual({
          type: "error",
          value: `Not a directory: ${file}`,
        })
        expect(yield* directoryOf(sessionID)).toBe(source)
      }),
    )
  })

  test("leaves the workspace unchanged for a directory outside any repository", async () => {
    await run(({ registry, source, plain, directoryOf }) =>
      Effect.gen(function* () {
        expect(yield* executeTool(registry, call(plain))).toEqual({
          type: "error",
          value: `Not a Git repository: ${plain}. Create the worktree before switching to it.`,
        })
        expect(yield* directoryOf(sessionID)).toBe(source)
      }),
    )
  })
})
