"use client";

// The room screen for an in-person meeting (§17b): open this on the TV or the laptop on the table,
// BEFORE anyone presses Start, and it hands itself to the full canvas, memes included, the moment
// a meeting begins.
//
// It exists because the canvas needs a meeting id, and that id is minted on the phone when Start is
// pressed. Typing `phone-20261012-1415-x7k2` into a TV remote is not a plan. A short address that
// waits and follows is.

import { useEffect, useState } from "react";

export default function MeetScreen() {
  const [host, setHost] = useState("");
  const [err, setErr] = useState(false);
  useEffect(() => {
    setHost(window.location.host);
    let gone = false;
    const look = async () => {
      try {
        const r = await fetch("/api/meet/status?latest=1", { cache: "no-store" });
        const j = (await r.json()) as { id: string | null };
        setErr(false);
        // replace(), not assign(): Back from the board should not land on a page that instantly
        // forwards to the board again.
        if (!gone && j.id) window.location.replace(`/canvas?present=1&meeting=${encodeURIComponent(j.id)}`);
      } catch { setErr(true); }
    };
    void look();
    const t = setInterval(look, 2000);
    return () => { gone = true; clearInterval(t); };
  }, []);

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-[#0a0a0a] px-8 text-center text-white/90">
      <div className="h-4 w-4 animate-pulse rounded-full bg-emerald-400" />
      <h1 className="text-4xl font-semibold tracking-tight">Minami is ready</h1>
      <p className="max-w-xl text-xl leading-relaxed text-white/60">
        Press <span className="text-white">Start listening</span> on your phone, or play a recording. The board
        appears here on its own.
      </p>
      <p className="font-mono text-base text-white/35">{host ? `${host}/meet` : ""}</p>
      {err && <p className="text-base text-amber-300/80">Can&apos;t reach the Mac. Retrying…</p>}
    </main>
  );
}
