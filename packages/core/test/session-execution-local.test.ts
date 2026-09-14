import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_execution_local_test")
const source = AbsolutePath.make("/source")
const moved = AbsolutePath.make("/moved")

const runs: Array<{ readonly directory: string; readonly force: boolean }> = []
/** Replaced per test to script what the Location-bound runner does on each drain. */
let onRun: (input: { readonly directory: string; readonly attempt: number }) => Effect.Effect<void> = () => Effect.void

/**
 * Stands in for the Location-scoped services the real map builds. Only
 * `Location` and `SessionRunner` matter here: the drain resolves the runner
 * through this map, which is exactly the binding a mid-drain move invalidates.
 */
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    (ref: Location.Ref) =>
      Layer.mergeAll(
        Layer.succeed(Location.Service, Location.Service.of(location(ref))),
        Layer.succeed(
          SessionRunner.Service,
          SessionRunner.Service.of({
            run: (input) =>
              Effect.suspend(() => {
                runs.push({ directory: ref.directory, force: input.force })
                return onRun({ directory: ref.directory, attempt: runs.length })
              }),
          }),
        ),
      ),
    // The real map carries the full Location service union. This fake supplies
    // only the two services the drain touches, so widen it deliberately.
  ) as unknown as Effect.Effect<LocationServiceMap.Service["Service"], never, Scope.Scope>,
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecutionLocal.node,
    ]),
    [[LocationServiceMap.node, locations]],
  ),
)

const setup = Effect.gen(function* () {
  runs.length = 0
  onRun = () => Effect.void
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "execution-local",
      directory: source,
      title: "execution local",
      version: "test",
      time_created: 1,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)
})

const mover = (events: EventV2.Interface) => (directory: AbsolutePath) =>
  events
    .publish(SessionEvent.Moved, {
      sessionID,
      location: Location.Ref.make({ directory }),
      timestamp: DateTime.makeUnsafe(1),
    })
    .pipe(Effect.asVoid)

describe("SessionExecutionLocal", () => {
  it.effect("continues the drain at the new Location after a mid-drain move", () =>
    Effect.gen(function* () {
      yield* setup
      const execution = yield* SessionExecution.Service
      const move = mover(yield* EventV2.Service)
      // Mirrors the real runner: it observes the moved Session at the next
      // provider-turn boundary and interrupts itself before any provider call.
      onRun = (input) => (input.attempt === 1 ? move(moved).pipe(Effect.andThen(Effect.interrupt)) : Effect.void)

      yield* execution.resume(sessionID)

      expect(runs).toEqual([
        { directory: source, force: true },
        // Forced: the interrupted turn already consumed its inbox rows, so an
        // advisory drain would find nothing eligible and stop early.
        { directory: moved, force: true },
      ])
    }),
  )

  it.effect("propagates a genuine interrupt without redraining", () =>
    Effect.gen(function* () {
      yield* setup
      const execution = yield* SessionExecution.Service
      onRun = () => Effect.interrupt

      const exit = yield* execution.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(runs).toEqual([{ directory: source, force: true }])
    }),
  )

  it.effect("keeps following the Session across repeated moves", () =>
    Effect.gen(function* () {
      yield* setup
      const execution = yield* SessionExecution.Service
      const move = mover(yield* EventV2.Service)
      const second = AbsolutePath.make("/moved-again")
      onRun = (input) => {
        if (input.attempt === 1) return move(moved).pipe(Effect.andThen(Effect.interrupt))
        if (input.attempt === 2) return move(second).pipe(Effect.andThen(Effect.interrupt))
        return Effect.void
      }

      yield* execution.resume(sessionID)

      expect(runs.map((run) => run.directory)).toEqual([source, moved, second])
    }),
  )

  it.effect("does not redrain when the runner completes normally", () =>
    Effect.gen(function* () {
      yield* setup
      const execution = yield* SessionExecution.Service
      const move = mover(yield* EventV2.Service)
      onRun = () => move(moved)

      yield* execution.resume(sessionID)

      expect(runs).toEqual([{ directory: source, force: true }])
    }),
  )
})
