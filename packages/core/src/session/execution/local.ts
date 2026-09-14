import { Cause, Effect, Exit, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        // A Session that moves mid-drain leaves the runner bound to the previous
        // Location, so the runner self-interrupts at the next provider-turn
        // boundary (session/runner/llm.ts). That interrupt happens before the
        // provider call, so re-resolving the Location and continuing is a
        // continuation rather than a provider retry. Force the follow-up run:
        // the interrupted turn had already consumed its inbox rows, so an
        // advisory drain would find nothing eligible and stop early.
        let attempt = force
        while (true) {
          const session = yield* store.get(sessionID)
          if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
          const exit = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: attempt })).pipe(
            Effect.provide(locations.get(session.location)),
            Effect.exit,
          )
          if (Exit.isSuccess(exit)) return
          if (!Cause.hasInterruptsOnly(exit.cause)) {
            yield* Effect.logError("Failed to drain Session", exit.cause).pipe(Effect.annotateLogs({ sessionID }))
            return yield* exit
          }
          // Distinguish a move-induced interrupt from a real one. Reading the
          // store here is also the interruption checkpoint for a drain the
          // coordinator is stopping, so a user interrupt exits the loop.
          const next = yield* store.get(sessionID)
          if (
            next?.location.directory === session.location.directory &&
            next?.location.workspaceID === session.location.workspaceID
          )
            return yield* exit
          attempt = true
        }
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
