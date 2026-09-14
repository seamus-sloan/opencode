export * as WorkspaceTool from "./workspace"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { MoveSession } from "../control-plane/move-session"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "workspace"

export const Input = Schema.Struct({
  directory: Schema.String.annotate({
    description:
      "Directory to make the active workspace. Absolute, or relative to the current workspace. Must be a Git checkout of the same repository, such as a linked worktree.",
  }),
  moveChanges: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Transfer uncommitted changes from the current workspace to the destination and reset the current workspace. Defaults to false, which leaves both working trees untouched.",
  }),
})

export const Output = Schema.Struct({
  directory: AbsolutePath,
  previous: AbsolutePath,
})
export type Output = typeof Output.Type

// Takes the encoded shape so it can be reused from `toModelOutput`, where the
// tool surface hands back plain strings rather than branded paths.
export const toModelOutput = (output: { readonly directory: string; readonly previous: string }) =>
  `Workspace switched to ${output.directory} (was ${output.previous}). Subsequent tool calls and the file/change views now use the new workspace.`

/**
 * Repoints the Session's Location at another checkout of the same project.
 *
 * This exists because shell state cannot carry a directory change: the bash tool
 * spawns one process per call rooted at the current Location, so a `cd` (or a
 * worktree helper such as `wt switch`) dies with its subprocess. An explicit tool
 * call is the only reliable signal, and it keeps arbitrary `cd` output from
 * silently repointing a Session.
 *
 * The move is durable (`session.next.moved`), so file browsing, the git status
 * watcher, and the changed-files view all rebind, while the conversation and its
 * durable history are untouched.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const move = yield* MoveSession.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: [
            "Switch the active workspace directory for this session.",
            "",
            "Use this after creating or selecting a Git worktree so that file browsing, git status, and the changed-files view follow the checkout you are working in. A shell `cd` cannot do this: each command runs in its own process, so the directory change is lost when it exits.",
            "",
            "The destination must be an existing Git checkout of the same repository as the current workspace, for example a linked worktree. The conversation is preserved. Subsequent tool calls resolve relative paths against the new workspace.",
          ].join("\n"),
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const directory = AbsolutePath.make(path.resolve(location.directory, input.directory))
              // Gate on `workspace` alone. The destination is by definition outside
              // the current workspace, but it becomes the workspace, so an
              // additional `external_directory` prompt for the same decision would
              // only be noise.
              yield* permission.assert({
                action: name,
                resources: [directory],
                save: [directory],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* move.moveSession({
                sessionID: context.sessionID,
                destination: { directory },
                moveChanges: input.moveChanges ?? false,
              })
              return { directory, previous: location.directory }
            }).pipe(
              Effect.mapError((error) => {
                if (error._tag === "MoveSession.InvalidDestinationError")
                  return new ToolFailure({
                    message: {
                      missing: `Directory does not exist or is not readable: ${error.directory}`,
                      not_directory: `Not a directory: ${error.directory}`,
                      not_git: `Not a Git repository: ${error.directory}. Create the worktree before switching to it.`,
                    }[error.reason],
                  })
                if (error._tag === "MoveSession.DestinationProjectMismatchError")
                  return new ToolFailure({
                    message:
                      "Destination belongs to a different project. Only checkouts of the current repository, such as its linked worktrees, can become the workspace.",
                  })
                if (error._tag === "PermissionV2.BlockedError" || error._tag === "PermissionV2.CorrectedError")
                  return new ToolFailure({ message: "Workspace switch was not permitted" })
                return new ToolFailure({ message: `Unable to switch workspace: ${error._tag}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/workspace",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node, MoveSession.node],
})
