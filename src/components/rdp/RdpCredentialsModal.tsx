import { useEffect, useState } from "react";
import { X, Monitor, Eye, EyeOff } from "lucide-react";
import { Host } from "../../lib/api";
import { RdpCredentials } from "../../lib/rdpCreds";

interface RdpCredentialsModalProps {
  host: Host | null;
  onClose: () => void;
  onSubmit: (host: Host, creds: RdpCredentials) => void;
}

/**
 * Collects RDP credentials when the host has no usable stored password
 * (e.g. an SSH key-only host, or a pure Windows RDP box). The values are passed
 * straight through to `rdp_connect` and never persisted.
 */
export function RdpCredentialsModal({ host, onClose, onSubmit }: RdpCredentialsModalProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setUsername(host?.username ?? "");
    setPassword("");
    setDomain("");
    setShowPassword(false);
  }, [host]);

  if (!host) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!host) return;
    onSubmit(host, {
      username: username.trim() || undefined,
      password,
      domain: domain.trim() || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface-low)] p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-[var(--border)] pb-3">
          <div className="flex items-center gap-2">
            <Monitor size={17} className="text-[var(--primary)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Credenziali RDP — {host.label}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--border)] hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Username
            </label>
            <input
              type="text"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="es. Administrator"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/50 focus:border-[var(--primary)] focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password RDP"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 pr-9 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/50 focus:border-[var(--primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Dominio <span className="opacity-60">(opzionale)</span>
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="es. WORKGROUP"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/50 focus:border-[var(--primary)] focus:outline-none"
            />
          </div>

          <p className="text-[11px] text-[var(--text-muted)]">
            Le credenziali non vengono salvate: servono solo per questa sessione.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--border)] hover:text-white"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={!password}
              className="rounded-md bg-[var(--primary)] px-3.5 py-1.5 text-xs font-semibold text-[var(--on-primary)] transition hover:bg-[var(--primary-hover)] disabled:opacity-50"
            >
              Connetti
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
