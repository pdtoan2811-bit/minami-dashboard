"use client";

// Account status indicator — tells you, anywhere in the app, which Claude account you are actually
// burning tokens on.
//
// Why this exists: token-slayer silently auto-fails-over to a READY slot when the active one's
// credential dies, and nothing in the UI says so — you just quietly start burning the wrong
// account's weekly limit for hours. Observed live on 2026-07-29: a switch back to the preferred
// account reported success, then the session was on a different one minutes later, with no signal
// anywhere.
//
// Trigger comes from /api/accounts's `live` block, which reads ~/.claude.json's oauthAccount —
// the identity Claude Code actually authenticated with — NOT token-slayer's own `active` label,
// which has been caught claiming the wrong account. See that route for the full reasoning.
//
// ── UX model ────────────────────────────────────────────────────────────────────────────────────
// Three levels, each with its own glyph and words so colour is never the only carrier (colour-blind
// users, greyscale screens):
//
//   ok        ✓ emerald   on the preferred account
//   warn      ⚠ amber     running on a fallback account
//   critical  ✕ red       fallback AND self-recovery is untrustworthy (token-slayer's banner
//                         disagrees with the real credential, or a switch-back silently no-op'd)
//
// Two sizes: an expanded card (explains + acts) and a collapsed chip (dot + label, always present
// while unhealthy). Dismissing collapses card → chip; it never removes the indicator, so you can
// always see at a glance which account you're on.
//
// Healthy renders NOTHING. A status light that is permanently green trains you to stop seeing it,
// which is precisely when it turns amber and you miss it. Instead the indicator's presence is
// itself the signal, and recovery gets a loud, self-retiring green card.
//
// Docked bottom-right rather than top-right: every page's header already owns the top-right corner
// (Nav, search, window pickers), so a permanent chip up there would sit on top of them. Bottom-right
// is free on all pages, identical regardless of page layout, and thumb-reachable on mobile.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type SpawnerPin = {
  name: string;
  model: string | null;
  source: string;
  drifted: boolean;
};

type ModelPins = {
  pinned: string;
  spawners: SpawnerPin[];
  drifted: boolean;
};

type Live = {
  email: string | null;
  displayName: string | null;
  preferred: string;
  offPreferred: boolean;
  claimsMismatch: boolean;
  // Optional: a dashboard build older than the model-pin check won't send this. Treated as
  // "nothing to report" rather than "no drift" — absent evidence isn't evidence.
  models?: ModelPins;
};

type Level = "ok" | "warn" | "critical";

// An "episode" is one continuous run of the same problem. Identifying it as a string lets collapse,
// re-expand, and recovery all key off one value instead of three booleans that drift out of sync —
// and lets a *different* problem (fell onto another fallback account, a second spawner drifted)
// re-expand a card you'd already collapsed, which is the behaviour you want: new information.
//
// Empty string means healthy. Everything downstream derives from that.
const episodeKey = (l: Live): string => {
  const account = l.offPreferred ? `acct:${l.email}` : "";
  const models = (l.models?.spawners ?? [])
    .filter((s) => s.drifted)
    .map((s) => `${s.name}=${s.model}`)
    .join(",");
  return [account, models ? `model:${models}` : ""].filter(Boolean).join("|");
};

const driftedSpawners = (l: Live | null): SpawnerPin[] =>
  (l?.models?.spawners ?? []).filter((s) => s.drifted);

// The episode record we remember between polls: its identity, plus enough detail to word the
// recovery card in terms of what was actually wrong ("was <the wrong account>" vs "back on the pin").
const episodeOf = (l: Live) => ({
  key: episodeKey(l),
  account: l.offPreferred ? l.email : null,
  models: driftedSpawners(l).length > 0,
});

const POLL_MS = 30_000;
// How long the green recovery card stays up before retiring itself. Counts down only while the tab
// is visible (see the timer effect) so a recovery that lands while you're in another tab is still
// waiting for you when you come back — otherwise the one moment you most want to see is the one
// most likely to expire unseen.
const RECOVERY_MS = 9_000;

const SS_KEY = "minami.accountStatus.collapsed"; // sessionStorage: "<offending email>"

// Full literal class strings per level — Tailwind's JIT cannot see interpolated fragments, so these
// must never be built by string concatenation.
const STYLE: Record<Level, {
  glyph: string;
  dot: string;
  card: string;
  chip: string;
  title: string;
  body: string;
  action: string;
  quiet: string;
}> = {
  warn: {
    glyph: "⚠",
    dot: "bg-amber-500",
    card: "border-amber-500/40 bg-amber-950/90",
    chip: "border-amber-500/40 bg-amber-950/90 text-amber-100 hover:bg-amber-900/70",
    title: "text-amber-100",
    body: "text-amber-200/80",
    action: "bg-amber-600 hover:bg-amber-700",
    quiet: "text-amber-200/60 hover:bg-amber-900/40",
  },
  critical: {
    glyph: "✕",
    dot: "bg-red-500",
    card: "border-red-500/40 bg-red-950/90",
    chip: "border-red-500/40 bg-red-950/90 text-red-100 hover:bg-red-900/70",
    title: "text-red-100",
    body: "text-red-200/80",
    action: "bg-red-600 hover:bg-red-700",
    quiet: "text-red-200/60 hover:bg-red-900/40",
  },
  ok: {
    glyph: "✓",
    dot: "bg-emerald-500",
    card: "border-emerald-500/40 bg-emerald-950/90",
    chip: "border-emerald-500/40 bg-emerald-950/90 text-emerald-100",
    title: "text-emerald-100",
    body: "text-emerald-200/80",
    action: "bg-emerald-600 hover:bg-emerald-700",
    quiet: "text-emerald-200/60 hover:bg-emerald-900/40",
  },
};

const shortName = (email: string) => email.split("@")[0];

export function AccountStatus() {
  // /canvas is a BROADCAST surface — Recall.ai streams it as Minami's screen share into a meeting
  // with clients and investors in it. Operator chrome must never render there: an amber
  // "you're on the wrong Claude account" card appearing over a live pitch is the exact opposite of
  // what this component is for. Suppressed at the route level rather than by the page, because the
  // whole point of this widget is that it mounts globally and nothing has to remember it exists.
  const onCanvas = usePathname()?.startsWith("/canvas") ?? false;

  const [live, setLive] = useState<Live | null>(null);
  const [switching, setSwitching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A switch-back that reported success but left us on the same account. Promotes the level to
  // `critical`, because it means the usual one-click remedy is not going to save you.
  const [switchStuck, setSwitchStuck] = useState(false);
  // Collapsed = card hidden, chip still showing. Keyed by the *episode*, so collapsing a
  // wrong-account episode doesn't pre-suppress a different account — or a model drift — later.
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  // Set on the unhealthy → healthy transition. Drives the green card.
  const [recovered, setRecovered] = useState<{ account: string | null; models: boolean } | null>(null);
  const [tabVisible, setTabVisible] = useState(true);

  // null = we haven't observed a poll yet this mount. Distinguishing "unknown" from "was healthy"
  // matters: on a fresh page load the first poll already reports the problem, and treating that as
  // a healthy→unhealthy *transition* would wipe the stored collapse on every navigation (and could
  // fire a bogus recovery). Transitions are only real when we actually saw the previous state.
  const prevEpisode = useRef<{ key: string; account: string | null; models: boolean } | null>(null);
  const prevLevel = useRef<Level>("ok");

  const key = live ? episodeKey(live) : "";
  const accountDrift = !!live?.offPreferred;
  const modelDrift = driftedSpawners(live).length > 0;

  // Account drift outranks model drift for severity: the credential failure modes (a switch that
  // silently no-ops, a banner that lies) are the ones with no one-click fix. A model that fell off
  // the pin is always fixable — you edit a file — so it stays at `warn` however long it persists.
  const level: Level = !live || key === ""
    ? "ok"
    : accountDrift && (live.claimsMismatch || switchStuck)
      ? "critical"
      : "warn";

  // ── data ──────────────────────────────────────────────────────────────────────────────────────
  const load = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d: { live?: Live; error?: string }) => {
        if (!d?.live) return; // route errored (token-slayer missing on this host) — stay silent
        setLive(d.live);

        const k = episodeKey(d.live);
        const prev = prevEpisode.current;

        // Only act on an observed *change*. On first poll (prev === null) we may simply be loading a
        // page mid-episode that the user already collapsed — which must stay collapsed.
        if (prev && k !== prev.key) {
          try { sessionStorage.removeItem(SS_KEY); } catch { /* private mode */ }
          setCollapsedFor(null);
          setSwitchStuck(false);
          if (k === "") {
            // Recovered. Announce unconditionally — a dismissal applies to the problem, never to
            // its resolution. Report what actually got fixed, not a generic all-clear.
            setRecovered({ account: prev.account, models: prev.models });
          } else {
            // A different problem than the one being shown: re-expand, drop any stale green.
            setRecovered(null);
          }
        }

        prevEpisode.current = episodeOf(d.live);
      })
      .catch(() => { /* offline / route down — nothing useful to say */ });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    const onVis = () => {
      const vis = document.visibilityState === "visible";
      setTabVisible(vis);
      // Coming back to the tab is exactly when you want to know you've been on the wrong account.
      if (vis) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  // Restore collapsed state after mount (not in a useState initialiser — reading sessionStorage
  // during render would desync server and client HTML and throw a hydration error).
  useEffect(() => {
    try {
      const v = sessionStorage.getItem(SS_KEY);
      if (v) setCollapsedFor(v);
    } catch { /* private mode */ }
  }, []);

  // Escalation re-opens the card even if you collapsed it: warn → critical is new information, and
  // silently leaving it collapsed would hide the fact that the one-click fix no longer works.
  useEffect(() => {
    if (prevLevel.current === "warn" && level === "critical") {
      setCollapsedFor(null);
      try { sessionStorage.removeItem(SS_KEY); } catch { /* private mode */ }
    }
    prevLevel.current = level;
  }, [level]);

  // Retire the green card. The countdown is paused while the tab is hidden, so the timer measures
  // "time you could actually have seen it" rather than wall-clock.
  const recoveryLeft = useRef(RECOVERY_MS);
  useEffect(() => {
    if (!recovered) { recoveryLeft.current = RECOVERY_MS; return; }
    if (!tabVisible) return;
    const startedAt = Date.now();
    const t = setTimeout(() => setRecovered(null), recoveryLeft.current);
    return () => {
      clearTimeout(t);
      recoveryLeft.current = Math.max(0, recoveryLeft.current - (Date.now() - startedAt));
    };
  }, [recovered, tabVisible]);

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const switchBack = useCallback(async () => {
    if (!live) return;
    setSwitching(true);
    setNote(null);
    try {
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: live.preferred }),
      });
      const d = await r.json();
      if (!r.ok) { setNote(d?.error || "switch failed"); return; }
      // Don't trust the CLI's "Switched to …" — re-read the real identity and let the indicator
      // decide for itself what it should be showing. A switch that reports success while the
      // credential is dead is the exact failure mode this component was built for.
      await new Promise((res) => setTimeout(res, 800));
      const verify = await fetch("/api/accounts").then((x) => x.json()).catch(() => null);
      if (verify?.live) {
        const prev = prevEpisode.current;
        setLive(verify.live);
        const k = episodeKey(verify.live);
        // Only a full all-clear counts as recovery. Switching the account back while a spawner is
        // still off the model pin leaves the card up, correctly showing what's left.
        if (prev && k !== prev.key) {
          setSwitchStuck(false);
          if (k === "") setRecovered({ account: prev.account, models: prev.models });
        }
        prevEpisode.current = episodeOf(verify.live);
        if (verify.live.offPreferred) {
          setSwitchStuck(true);
          setNote("switch reported success but the account didn't change — the credential is probably dead");
        }
      }
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    } finally {
      setSwitching(false);
    }
  }, [live]);

  const collapse = useCallback(() => {
    if (!key) return;
    setCollapsedFor(key);
    try { sessionStorage.setItem(SS_KEY, key); } catch { /* private mode */ }
  }, [key]);

  const expand = useCallback(() => {
    setCollapsedFor(null);
    try { sessionStorage.removeItem(SS_KEY); } catch { /* private mode */ }
  }, []);

  // ── render ────────────────────────────────────────────────────────────────────────────────────
  if (onCanvas) return null;                            // broadcast surface — see note at top of fn
  if (!live) return null;                               // no data — say nothing
  const unhealthy = level !== "ok";
  if (!unhealthy && !recovered) return null;            // healthy at rest — no permanent green nag

  const s = STYLE[unhealthy ? level : "ok"];
  const collapsed = unhealthy && collapsedFor === key;
  const drifted = driftedSpawners(live);
  // What the chip says. Account drift names the account you're wrongly burning; a model-only
  // episode has no wrong account to name, so it says what IS wrong instead of naming the account
  // you are correctly on, which would read as all-clear.
  const chipLabel = accountDrift ? shortName(live.email ?? "unknown") : "model pin";

  const motion = (
    <style>{`
      @keyframes msIn{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
      .ms-in{animation:msIn .22s ease-out}
      @keyframes msPulse{0%,100%{opacity:1}50%{opacity:.35}}
      .ms-pulse{animation:msPulse 1.6s ease-in-out infinite}
      @media (prefers-reduced-motion: reduce){
        .ms-in{animation:none}
        .ms-pulse{animation:none}
      }
    `}</style>
  );

  // Collapsed: a chip that still answers "which account am I on?" at a glance.
  if (collapsed) {
    return (
      <div className="fixed bottom-3 right-3 z-[100]">
        {motion}
        <button
          onClick={expand}
          aria-expanded={false}
          aria-label={`${level === "critical" ? "Critical" : "Warning"}: ${
            accountDrift ? `running on ${live.email}, not ${live.preferred}` : ""
          }${accountDrift && modelDrift ? "; " : ""}${
            modelDrift ? `${drifted.length} spawner${drifted.length === 1 ? "" : "s"} off the ${live.models?.pinned} pin` : ""
          }. Show details.`}
          title={
            accountDrift
              ? `Running on ${live.email} — click for details`
              : `Off the ${live.models?.pinned} model pin — click for details`
          }
          className={`ms-in flex items-center gap-1.5 rounded-full border py-1 pl-2 pr-2.5 text-[11px] font-medium shadow-lg backdrop-blur transition-colors ${s.chip}`}
        >
          <span aria-hidden className="relative flex h-2 w-2">
            <span className={`absolute inline-flex h-full w-full rounded-full ${s.dot} ${level === "critical" ? "ms-pulse" : ""}`} />
          </span>
          <span aria-hidden>{s.glyph}</span>
          <span className="tabular-nums">{chipLabel}</span>
        </button>
      </div>
    );
  }

  // Expanded: recovery (green) or problem (amber/red).
  const isRecovery = !unhealthy;

  return (
    <div
      role={isRecovery ? "status" : "alert"}
      aria-live={isRecovery ? "polite" : "assertive"}
      className={`ms-in fixed bottom-3 right-3 z-[100] w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border p-3 shadow-lg backdrop-blur ${s.card}`}
    >
      {motion}
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
          <span className={`inline-flex h-2 w-2 rounded-full ${s.dot} ${level === "critical" ? "ms-pulse" : ""}`} />
        </span>

        <div className="min-w-0 flex-1">
          <p className={`text-xs font-semibold ${s.title}`}>
            {isRecovery
              ? recovered?.account
                ? "Back on your main account"
                : "Back on the model pin"
              : level === "critical"
                ? "Stuck on the fallback account"
                : accountDrift
                  ? "Running on the fallback account"
                  : "Off the model pin"}
          </p>

          {/* Recovery names what was actually fixed — a generic all-clear after a model-only
              episode would wrongly imply the account had been wrong too. */}
          {isRecovery ? (
            <p className={`mt-1 text-[11px] leading-relaxed ${s.body}`}>
              {recovered?.account ? (
                <>
                  Claude Code is authenticated as{" "}
                  <span className="font-medium tabular-nums">{live.preferred}</span> again — was{" "}
                  <span className="tabular-nums">{recovered.account}</span>.{" "}
                </>
              ) : null}
              {recovered?.models ? (
                <>
                  Every spawner is back on{" "}
                  <span className="font-medium tabular-nums">{live.models?.pinned}</span>.
                </>
              ) : null}
            </p>
          ) : accountDrift ? (
            <p className={`mt-1 text-[11px] leading-relaxed ${s.body}`}>
              Claude Code is authenticated as{" "}
              <span className="font-medium tabular-nums">{live.email}</span>, not{" "}
              <span className="font-medium tabular-nums">{live.preferred}</span>.
            </p>
          ) : null}

          {/* Model drift. Names the file to edit rather than offering a button: unlike an account
              switch there is no safe one-click fix — the pin lives in source, and silently
              rewriting a repo from a status widget is not a thing this should do. */}
          {!isRecovery && modelDrift && (
            <div className={`mt-1 space-y-0.5 text-[11px] leading-relaxed ${s.body}`}>
              {drifted.map((sp) => (
                <p key={sp.name}>
                  <span className="font-medium">{sp.name}</span> spawns on{" "}
                  <span className="font-medium tabular-nums">{sp.model}</span>, not{" "}
                  <span className="font-medium tabular-nums">{live.models?.pinned}</span>
                  <span className="opacity-70"> — {sp.source}</span>
                </p>
              ))}
            </div>
          )}

          {!isRecovery && live.claimsMismatch && (
            <p className={`mt-1 text-[10px] leading-relaxed ${s.body}`}>
              token-slayer still claims it&rsquo;s on the preferred slot — its status banner is out of
              sync with the real credential.
            </p>
          )}

          {note && (
            <p className={`mt-1.5 rounded-md bg-white/10 px-1.5 py-1 text-[10px] leading-relaxed ${s.title}`}>
              {note}
            </p>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            {isRecovery ? (
              <button
                onClick={() => setRecovered(null)}
                className={`rounded-md px-2 py-1 text-[11px] ${s.quiet}`}
              >
                dismiss
              </button>
            ) : (
              <>
                {/* Only offered for account drift — it's the one problem here with a real one-click
                    remedy. On a model-only episode the button would do nothing relevant. */}
                {accountDrift && (
                  <button
                    onClick={switchBack}
                    disabled={switching}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium text-white transition disabled:opacity-50 ${s.action}`}
                  >
                    {switching ? "switching…" : `switch to ${shortName(live.preferred)}`}
                  </button>
                )}
                <button
                  onClick={collapse}
                  aria-expanded
                  title="Collapse to a status dot — it stays visible until you're back on your main account"
                  className={`rounded-md px-2 py-1 text-[11px] ${s.quiet}`}
                >
                  collapse
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
