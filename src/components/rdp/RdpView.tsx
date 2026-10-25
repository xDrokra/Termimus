import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, MonitorX, MonitorUp } from "lucide-react";
import { api, RdpInputEvent } from "../../lib/api";
import { useSessionStore } from "../../stores/useSessionStore";
import { takePendingRdpCreds } from "../../lib/rdpCreds";

interface RdpViewProps {
  sessionId: string;
  hostId: string;
  visible: boolean;
  isFocused?: boolean;
}

/**
 * Per-session RDP state kept at module scope — exactly like `XtermView`'s
 * terminal pool. This makes the connection survive StrictMode's dev double-mount
 * and ordinary remounts: the backend connects once, and frames are always
 * painted to whichever canvas is currently mounted (`entry.ctx`). The lifecycle
 * is owned by the store (`openRdpSession` / `closeSession` → `disposeRdpSession`),
 * never by component unmount.
 */
interface RdpPoolEntry {
  channel: Channel<ArrayBuffer>;
  desktop: { w: number; h: number };
  status: "connecting" | "connected" | "closed";
  error: string | null;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
}

const rdpPool = new Map<string, RdpPoolEntry>();

/** Called by the session store when a tab closes. */
export function disposeRdpSession(sessionId: string) {
  rdpPool.delete(sessionId);
}

/**
 * Browser `KeyboardEvent.code` → PC/AT scan code (set 1). Extended keys carry
 * the `0xE000` prefix; the Rust side's `Scancode::from_u16` decodes the
 * extended bit from it. Covers the common keys; unmapped keys are dropped.
 */
const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28,
  Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31,
  KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, F11: 0x57, F12: 0x58,
  // Extended keys (0xE000 prefix)
  ControlRight: 0xe01d, AltRight: 0xe038, NumpadEnter: 0xe01c,
  NumpadDivide: 0xe035, PrintScreen: 0xe037,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051,
  Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

/**
 * Paint a batched frame: one or more dirty rectangles concatenated as
 * `[left u16][top u16][w u16][h u16][RGBA…]` (little-endian) each. The backend
 * coalesces every tile produced in a ~16ms window into a single message, so we
 * walk the buffer and blit each rectangle in turn.
 */
function paintFrame(entry: RdpPoolEntry, buf: ArrayBuffer) {
  const ctx = entry.ctx;
  if (!ctx) return;
  const view = new DataView(buf);
  let off = 0;
  while (off + 8 <= buf.byteLength) {
    const left = view.getUint16(off, true);
    const top = view.getUint16(off + 2, true);
    const w = view.getUint16(off + 4, true);
    const h = view.getUint16(off + 6, true);
    off += 8;
    const nbytes = w * h * 4;
    if (w === 0 || h === 0) continue;
    if (off + nbytes > buf.byteLength) break; // truncated — stop
    try {
      const pixels = new Uint8ClampedArray(buf, off, nbytes);
      ctx.putImageData(new ImageData(pixels, w, h), left, top);
    } catch {
      // malformed region — ignore
    }
    off += nbytes;
  }
}

export function RdpView({ sessionId, hostId, visible, isFocused = true }: RdpViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest visible/focused flags for use inside long-lived event handlers.
  const activeRef = useRef(false);
  activeRef.current = visible && isFocused;

  const setConnected = useSessionStore((s) => s.setSessionConnected);
  const setError = useSessionStore((s) => s.setSessionError);

  const [status, setStatus] = useState<RdpPoolEntry["status"]>(
    () => rdpPool.get(sessionId)?.status ?? "connecting",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(
    () => rdpPool.get(sessionId)?.error ?? null,
  );
  // Set when we hand a legacy server off to the native Windows client (mstsc).
  const [externalMsg, setExternalMsg] = useState<string | null>(null);

  // Attach this mount's canvas to the (possibly pre-existing) pool entry and,
  // on first mount for this session, kick off the backend connection.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let entry = rdpPool.get(sessionId);
    const firstMount = !entry;

    if (!entry) {
      const channel = new Channel<ArrayBuffer>();
      entry = {
        channel,
        desktop: { w: 0, h: 0 },
        status: "connecting",
        error: null,
        canvas: null,
        ctx: null,
      };
      rdpPool.set(sessionId, entry);
      const e = entry;
      channel.onmessage = (buf) => paintFrame(e, buf);
    }

    // Point the pool at the current canvas; size it if we already know the size.
    entry.canvas = canvas;
    if (entry.desktop.w > 0) {
      canvas.width = entry.desktop.w;
      canvas.height = entry.desktop.h;
      entry.ctx = canvas.getContext("2d");
    }
    setStatus(entry.status);
    setErrorMsg(entry.error);

    if (firstMount) {
      const parent = canvas.parentElement;
      // Round down to a multiple of 4 — RDP dislikes odd widths.
      const w = Math.max(640, (parent?.clientWidth ?? 1024) & ~3);
      const h = Math.max(480, (parent?.clientHeight ?? 768) & ~3);
      const e = entry;
      const creds = takePendingRdpCreds(sessionId);
      api
        .rdpConnect(
          { hostId, sessionId, width: w, height: h, ...creds },
          e.channel,
        )
        .then((info) => {
          e.desktop = { w: info.width, h: info.height };
          e.status = "connected";
          if (e.canvas) {
            e.canvas.width = info.width;
            e.canvas.height = info.height;
            e.ctx = e.canvas.getContext("2d");
          }
          setStatus("connected");
          setConnected(sessionId, true);
        })
        .catch(async (err: unknown) => {
          const msg = typeof err === "string" ? err : String(err);
          // Legacy server (RC4 "Standard RDP Security") — IronRDP can't speak it.
          // Fall back automatically to the native Windows client (mstsc).
          if (/standard rdp security|negotiation/i.test(msg)) {
            try {
              await api.rdpLaunchExternal({
                hostId,
                username: creds?.username,
                domain: creds?.domain,
              });
              e.status = "closed";
              e.error = null;
              setStatus("closed");
              setExternalMsg(
                "Server legacy (solo RDP standard): aperto nel client Windows (mstsc).",
              );
              setConnected(sessionId, false);
              return;
            } catch (le) {
              const lmsg = typeof le === "string" ? le : String(le);
              const combined = `${msg}\n\nFallback mstsc fallito: ${lmsg}`;
              e.status = "closed";
              e.error = combined;
              setStatus("closed");
              setErrorMsg(combined);
              setError(sessionId, combined);
              return;
            }
          }
          e.status = "closed";
          e.error = msg;
          setStatus("closed");
          setErrorMsg(msg);
          setError(sessionId, msg);
        });
    }

    // NOTE: no disconnect here — the store owns teardown (disposeRdpSession +
    // api.rdpDisconnect in closeSession), so the session survives remounts.
    return () => {
      const e = rdpPool.get(sessionId);
      if (e && e.canvas === canvas) {
        e.canvas = null;
        e.ctx = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hostId]);

  // Backend lifecycle events (disconnect / server-side errors).
  useEffect(() => {
    const unlistenP = listen<{ sessionId: string; status: string; message?: string }>(
      "rdp-status",
      (ev) => {
        if (ev.payload.sessionId !== sessionId) return;
        if (ev.payload.status === "disconnected") {
          const e = rdpPool.get(sessionId);
          if (e) {
            e.status = "closed";
            if (ev.payload.message) e.error = ev.payload.message;
          }
          setStatus("closed");
          if (ev.payload.message) setErrorMsg(ev.payload.message);
          setConnected(sessionId, false);
        }
      },
    );
    return () => {
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, [sessionId, setConnected]);

  // ── Input ─────────────────────────────────────────────────────────────────
  const send = useCallback(
    (ev: RdpInputEvent) => {
      api.rdpInput(sessionId, [ev]).catch(() => {});
    },
    [sessionId],
  );

  const toDesktopCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const desktop = rdpPool.get(sessionId)?.desktop;
      if (!canvas || !desktop || desktop.w === 0) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((clientX - rect.left) / rect.width) * desktop.w);
      const y = Math.round(((clientY - rect.top) / rect.height) * desktop.h);
      return {
        x: Math.max(0, Math.min(desktop.w - 1, x)),
        y: Math.max(0, Math.min(desktop.h - 1, y)),
      };
    },
    [sessionId],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!activeRef.current) return;
      const { x, y } = toDesktopCoords(e.clientX, e.clientY);
      send({ kind: "mouseMove", x, y });
    },
    [send, toDesktopCoords],
  );

  const onMouseButton = useCallback(
    (e: React.MouseEvent, down: boolean) => {
      if (!activeRef.current) return;
      e.preventDefault();
      const { x, y } = toDesktopCoords(e.clientX, e.clientY);
      send({ kind: "mouseButton", button: e.button, down, x, y });
    },
    [send, toDesktopCoords],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!activeRef.current) return;
      if (e.deltaY !== 0) {
        send({ kind: "wheel", vertical: true, units: e.deltaY > 0 ? -120 : 120 });
      }
      if (e.deltaX !== 0) {
        send({ kind: "wheel", vertical: false, units: e.deltaX > 0 ? -120 : 120 });
      }
    },
    [send],
  );

  // Keyboard is captured at the window level while this view is active, so the
  // remote desktop receives shortcuts (Alt+Tab, etc.) instead of the browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (!activeRef.current) return;
      const sc = SCANCODES[e.code];
      if (sc === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      send({ kind: "key", scancode: sc, down });
    };
    const kd = (e: KeyboardEvent) => onKey(e, true);
    const ku = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    return () => {
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
    };
  }, [send]);

  return (
    <div
      className="absolute inset-0 bg-black"
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ imageRendering: "pixelated", cursor: "default" }}
        onMouseMove={onMouseMove}
        onMouseDown={(e) => onMouseButton(e, true)}
        onMouseUp={(e) => onMouseButton(e, false)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {status !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--surface)]/90 text-[var(--text)]">
          {status === "connecting" ? (
            <>
              <Loader2 className="animate-spin" size={28} />
              <span className="text-sm">Connessione RDP in corso…</span>
            </>
          ) : externalMsg ? (
            <>
              <MonitorUp size={28} className="text-[var(--primary)]" />
              <span className="text-sm font-medium">Aperto nel client Windows</span>
              <span className="max-w-md px-6 text-center text-xs text-[var(--text-muted)]">
                {externalMsg}
              </span>
            </>
          ) : (
            <>
              <MonitorX size={28} className="text-[var(--danger)]" />
              <span className="text-sm font-medium">Sessione RDP terminata</span>
              {errorMsg && (
                <span className="max-w-md whitespace-pre-line px-6 text-center text-xs text-[var(--text-muted)]">
                  {errorMsg}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
