// A Session's workspace move arrives under two names. The released protocol
// publishes `session.moved` carrying `projectID`/`subpath`; the current in-repo
// protocol publishes `session.next.moved` carrying `subdirectory` (see
// `packages/schema/src/session-event.ts`). The app talks to both server
// generations, and the vendored client only declares the released name, so
// callers match on a widened string and normalize the payload here.
export function isSessionMovedType(type: string | undefined) {
  return type === "session.moved" || type === "session.next.moved"
}

export type SessionMovedData = {
  readonly sessionID: string
  readonly directory: string
  readonly workspaceID?: string
  readonly projectID?: string
  readonly subpath?: string
}

export function sessionMovedData(data: unknown): SessionMovedData | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const payload = data as {
    sessionID?: unknown
    location?: { directory?: unknown; workspaceID?: unknown }
    projectID?: unknown
    subpath?: unknown
    subdirectory?: unknown
  }
  if (typeof payload.sessionID !== "string") return undefined
  if (typeof payload.location?.directory !== "string") return undefined
  const subpath = payload.subpath ?? payload.subdirectory
  return {
    sessionID: payload.sessionID,
    directory: payload.location.directory,
    workspaceID: typeof payload.location.workspaceID === "string" ? payload.location.workspaceID : undefined,
    projectID: typeof payload.projectID === "string" ? payload.projectID : undefined,
    subpath: typeof subpath === "string" ? subpath : undefined,
  }
}
