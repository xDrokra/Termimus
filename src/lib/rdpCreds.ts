// Transient RDP credential hand-off, keyed by session id.
//
// When a host has no stored password (e.g. an SSH key-only host, or a pure
// Windows RDP box), the user enters credentials in a prompt. We stash them here
// for the brief window between `openRdpSession` creating the tab and `RdpView`
// calling `rdp_connect`. Kept OUT of the Zustand store on purpose so passwords
// never land in app state / devtools; read-once and cleared immediately.

export interface RdpCredentials {
  username?: string;
  password?: string;
  domain?: string;
}

const pending = new Map<string, RdpCredentials>();

export function setPendingRdpCreds(sessionId: string, creds: RdpCredentials): void {
  pending.set(sessionId, creds);
}

/** Return and remove the credentials for a session (one-shot). */
export function takePendingRdpCreds(sessionId: string): RdpCredentials | undefined {
  const c = pending.get(sessionId);
  pending.delete(sessionId);
  return c;
}
