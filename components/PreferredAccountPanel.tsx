"use client";

// Settings → Account. Picks which Claude account the wrong-account alert measures against.
//
// This is NOT the same action as the "switch" buttons in AccountsPanel. Switching rewrites the
// shared Keychain credential and kills every running `claude` on the box; this only records which
// account *should* be live. Kept apart so that choosing a target in Settings can never drop your
// sessions as a side effect. The alert then tells you when the two disagree, and offers the switch.
//
// Stored on disk via /api/accounts (PUT), not in localStorage, because the reader is the API route
// itself — see lib/preferred-account.ts.

import { useCallback, useEffect, useState } from "react";

type Account = { name?: string; email?: string; state?: string; active?: boolean };
type Live = { email: string | null; preferred: string; preferredPinned?: boolean; offPreferred?: boolean };

export default function PreferredAccountPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/accounts", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "could not read accounts");
      setAccounts(Array.isArray(d.accounts) ? d.accounts : []);
      setLive(d.live ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(email: string) {
    if (email === live?.preferred) return;
    setSaving(email);
    setError(null);
    try {
      const r = await fetch("/api/accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferred: email }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "could not save");
      // Re-read rather than trusting the optimistic value: `offPreferred` is computed server-side
      // from the live credential, and the banner should update in the same beat as the choice.
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const emails = accounts
    .map((a) => a.email || a.name)
    .filter((e): e is string => typeof e === "string" && e.length > 0);

  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
        Account
      </h2>
      <div className="space-y-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Preferred account</p>
              <p className="text-xs text-neutral-500">
                The account every session should be billing. Fall off it and the header raises an
                alert. Choosing here doesn&rsquo;t switch anything — it sets the target.
              </p>
            </div>
          </div>

          {!loaded ? (
            <p className="mt-3 text-xs text-neutral-500">reading pool…</p>
          ) : emails.length === 0 ? (
            <p className="mt-3 text-xs text-amber-400">
              No accounts reported by token-slayer. Run <code className="font-mono">tok setup</code>{" "}
              first.
            </p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {emails.map((email) => {
                const isPreferred = live?.preferred === email;
                const isLive = live?.email === email;
                return (
                  <button
                    key={email}
                    onClick={() => choose(email)}
                    disabled={saving !== null}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                      isPreferred
                        ? "border-[var(--sakura)]/50 bg-[var(--sakura)]/10"
                        : "border-white/10 hover:border-white/20 hover:bg-white/[0.04]"
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 shrink-0 rounded-full border ${
                        isPreferred
                          ? "border-[var(--sakura)] bg-[var(--sakura)]"
                          : "border-white/25"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{email}</span>
                    {isLive && (
                      <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] text-green-400">
                        live now
                      </span>
                    )}
                    {saving === email && (
                      <span className="shrink-0 text-[10px] text-neutral-400">saving…</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          {loaded && !error && live && (
            <p className="mt-3 text-[11px] text-neutral-500">
              {/* Three states, not two. "No account chosen yet" is not the same as "you match",
                  and saying "matches the preferred account" when there is no preferred account
                  claims an all-clear nobody asked for — the check is simply off until you pick. */}
              {!live.preferred ? (
                <>
                  No preferred account chosen, so the wrong-account alert is off. Pick one above to
                  arm it — you&rsquo;re currently on{" "}
                  <span className="font-mono text-neutral-300">{live.email ?? "an unknown account"}</span>.
                </>
              ) : live.offPreferred ? (
                <>
                  Currently running on{" "}
                  <span className="font-mono text-amber-400">{live.email}</span> — not the preferred
                  account. Use the header alert to switch (it drops running sessions).
                </>
              ) : (
                <>
                  Live credential matches the preferred account.
                  {live.preferredPinned === false && " (From MINAMI_PREFERRED_ACCOUNT — not yet pinned.)"}
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
