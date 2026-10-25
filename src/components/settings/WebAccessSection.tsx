import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  Loader2,
  Copy,
  Check,
  ShieldAlert,
  Lock,
  Power,
} from "lucide-react";
import { api, WebServerStatus } from "../../lib/api";
import { useVaultStore } from "../../stores/useVaultStore";

/**
 * "Web Access (LAN)" settings panel. Toggles the embedded HTTP/WebSocket server
 * that lets a browser on the local network open SSH terminals against configured
 * hosts. The pairing link carries a token; the master password never leaves the
 * desktop (credentials are decrypted server-side only while the vault is
 * unlocked).
 */
export function WebAccessSection() {
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const isUnlocked = useVaultStore((s) => s.isUnlocked);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.webServerStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = status?.running
        ? await api.webServerStop()
        : await api.webServerStart();
      setStatus(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pairingLink = (baseUrl: string) =>
    `${baseUrl}/?token=${encodeURIComponent(status?.token ?? "")}`;

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const running = status?.running ?? false;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-[var(--primary)]/10 p-2">
          <Globe size={18} className="text-[var(--primary)]" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Web Access (LAN)
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
            Open your SSH terminals from a browser on the same network (e.g. your
            phone). The server runs inside this app and only streams terminal
            bytes — your master password never leaves this computer.
          </p>
        </div>
      </div>

      {/* Toggle card */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-low)] p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                running ? "bg-green-500 animate-pulse" : "bg-[var(--text-muted)]/40"
              }`}
            />
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {running ? "Running" : "Stopped"}
            </span>
            {running && status && (
              <span className="text-xs font-mono text-[var(--text-muted)]">
                port {status.port}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-60 ${
              running
                ? "bg-[var(--surface-high)] text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface-container)]"
                : "bg-[var(--primary)] text-white hover:opacity-90"
            }`}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Power size={14} />
            )}
            {running ? "Stop server" : "Enable server"}
          </button>
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-400 break-words">{error}</p>
        )}
      </div>

      {/* Pairing details */}
      {running && status && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-low)] p-4 flex flex-col gap-4">
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wide">
              Open on another device
            </h4>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Visit one of these links in a browser on the same network. The link
              already includes the access token.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {status.urls.map((url) => {
              const link = pairingLink(url);
              return (
                <div
                  key={url}
                  className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-high)] px-3 py-2"
                >
                  <span className="flex-1 text-xs font-mono text-[var(--text-secondary)] truncate">
                    {link}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(link, url)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-container)]"
                  >
                    {copied === url ? (
                      <Check size={12} className="text-green-500" />
                    ) : (
                      <Copy size={12} />
                    )}
                    {copied === url ? "Copied" : "Copy"}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">
              Token
            </span>
            <code className="flex-1 text-xs font-mono text-[var(--text-secondary)] truncate">
              {status.token}
            </code>
            <button
              type="button"
              onClick={() => copy(status.token, "__token")}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-container)]"
            >
              {copied === "__token" ? (
                <Check size={12} className="text-green-500" />
              ) : (
                <Copy size={12} />
              )}
              {copied === "__token" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Vault-locked warning */}
      {running && !isUnlocked && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <Lock size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="text-xs text-amber-200/90 leading-relaxed">
            The vault is locked. The browser can list hosts, but connecting will
            fail until you unlock the vault on this computer.
          </p>
        </div>
      )}

      {/* Security note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-low)] p-3">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          Use this only on networks you trust. Traffic on the local network is
          not encrypted, so anyone able to sniff your LAN could read the session.
          Keep the token private, and turn the server off when you don't need it.
        </p>
      </div>
    </div>
  );
}
