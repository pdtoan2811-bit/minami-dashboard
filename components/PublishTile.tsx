"use client";
/**
 * The publish tile, first on Bento while a TikTok publish runs and for 6 hours after it ends (§33).
 *
 * Picked 2026-10-23 from the upload-place pitch, round 3, C "Delivery tracker". The batch tray had lived in the chat's
 * agent card, which scrolls with the transcript and exists only in the pane that started it; he asked for it
 * "somewhere else … for easier monitoring", then rejected a calmer tile of chips and a speed meter as "not intuitive
 * and ugly". What he picked answers one question at a time, the way a delivery app does: the video uploading now,
 * large, as its cover, with the minutes left, or how late it will be for its post slot, in red. The rest of the batch
 * is a small row of covers. Colour only appears on trouble; the only motion is the dot while it's live.
 *
 * Polls /api/uploads: 4 s while a publish is live (the writer flushes every 2 s), 30 s otherwise. It's one readdir.
 */
import { useEffect, useState } from "react";
import type { AttnView } from "@/lib/attention";
import type { Publish as PublishBase, PublishVideo } from "@/lib/upload-progress";

/** As /api/uploads sends it: with its attention entry (§34), which holds comments and the Minami chats. */
type Publish = PublishBase & { att?: AttnView };

const C = { ink: "#f2f2f2", mute: "#9a9a9a", faint: "#5f5f5f", ok: "#5fd39a", warn: "#f3c766", bad: "#ff7b7f", up: "#7aa2ff" };
const DISMISSED = "bento:publishDismissed";

const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const mins = (m: number) => (m < 1 ? "<1 min" : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);

function usePublishes(): [Publish[], () => void] {
  const [list, setList] = useState<Publish[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let on = true, t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let next: Publish[] | null = null;
      try { const r = await fetch("/api/uploads", { cache: "no-store" }); if (r.ok) next = (await r.json()).publishes || []; } catch { /* next tick */ }
      if (!on) return;
      if (next) setList(next);
      t = setTimeout(tick, (next ?? list).some((p) => p.live) ? 4000 : 30000);
    };
    tick();
    return () => { on = false; if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return [list, () => setNonce((n) => n + 1)];
}

/** A cover with its state: a ring that fills while it uploads, a badge when posted, held or failed. */
function Cover({ p, v, w, ring = true }: { p: Publish; v: PublishVideo; w: number; ring?: boolean }) {
  const h = Math.round((w * 16) / 9);
  const c = v.state === "done" ? C.ok : v.state === "uploading" ? (p.tone === "late" || p.tone === "stuck" ? C.bad : C.up) : v.state === "held" ? C.warn : v.state === "failed" ? C.bad : "rgba(255,255,255,.14)";
  const bg = v.pct !== undefined ? `conic-gradient(${c} ${v.pct * 3.6}deg, rgba(255,255,255,.1) 0)` : c;
  const dim = v.state === "queued" || v.state === "skipped" ? "brightness(.5)" : v.state === "held" ? "grayscale(1) brightness(.45)" : undefined;
  const badge = v.state === "done" ? "✓" : v.state === "held" ? "✋" : v.state === "failed" ? "!" : null;
  return (
    <span className="relative inline-block shrink-0" title={`${v.n} · ${v.title}${v.slot ? ` · posts ${hm(Date.parse(v.slot))}` : ""}${v.why ? ` · ${v.why}` : ""}`}
      style={{ width: w + 6, height: h + 6, borderRadius: 11, padding: 3, background: ring && v.state !== "queued" ? bg : "transparent" }}>
      {v.cover
        ? <img src={`/api/uploads/cover?pid=${p.pid}&n=${encodeURIComponent(v.n)}`} alt={v.title} loading="lazy" style={{ width: w, height: h, borderRadius: 8, objectFit: "cover", display: "block", filter: dim, border: "2px solid #13161c" }} />
        : <span className="grid place-items-center text-[10px] font-semibold" style={{ width: w, height: h, borderRadius: 8, background: "#1d2129", color: C.mute, filter: dim }}>{v.n}</span>}
      {badge && <span className="absolute -bottom-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold" style={{ background: c, color: "#13161c" }}>{badge}</span>}
    </span>
  );
}

function Btn({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone?: string }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} className="inline-flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition-opacity hover:opacity-85"
      style={tone ? { background: tone, color: "#13161c" } : { background: "rgba(255,255,255,.07)", color: "#d0d0d0" }}>{children}</button>
  );
}

/** The same hand as every flagged item (§34, AttentionRow): type, Enter asks Minami, Comment only saves the note.
 *  Minami's answer is a new chat in the publish's folder with the publish as its subject; it opens as soon as it starts. */
function AskBox({ p, onOpen, onChanged }: { p: Publish; onOpen: (sid: string) => void; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"ask" | "comment" | null>(null);
  const [err, setErr] = useState("");
  const run = async (op: "ask" | "comment") => {
    const text = note.trim() || (op === "ask" ? "Look at this publish and tell me if anything needs me" : "");
    if (!text || busy) return;
    setBusy(op); setErr("");
    const r = await fetch("/api/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, key: p.key, text }) })
      .then((x) => x.json()).catch((e) => ({ error: String(e) }));
    setBusy(null);
    if (r.error) { setErr(r.error); return; }
    setNote(""); onChanged();
    // the board learns about a new chat on its next poll; give it a moment before opening
    if (r.sessionId) setTimeout(() => onOpen(r.sessionId), 1500);
  };
  const bad = p.tone === "late" || p.tone === "stuck" || p.tone === "trouble";
  const n = p.att?.comments.length ?? 0;
  return (
    <div className="mt-3">
      <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); run("ask"); }}>
        <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} disabled={busy === "ask"}
          placeholder={busy === "ask" ? "Starting a chat…" : bad ? `Tell Minami what to do about ${p.cur?.n ?? "it"}, or comment…` : "Tell Minami what to do, or comment…"}
          className="h-8 min-w-0 flex-1 rounded-full bg-transparent px-3.5 text-[13px] outline-none placeholder:text-white/35 disabled:opacity-60"
          style={{ border: "1px solid rgba(255,255,255,.12)", color: C.ink }} />
        {note.trim() && <button type="button" disabled={!!busy} onClick={() => run("comment")}
          className="h-8 shrink-0 rounded-full px-3 text-[12px] hover:text-white" style={{ background: "rgba(255,255,255,.06)", color: C.mute }}>{busy === "comment" ? "…" : "Comment"}</button>}
        <button type="submit" disabled={!!busy} className="h-8 shrink-0 rounded-full px-3.5 text-[12px] font-semibold text-white disabled:opacity-60"
          style={{ background: bad ? C.bad : "#5b7cf0", color: bad ? "#13161c" : "#fff" }}>{busy === "ask" ? "…" : "Minami ↵"}</button>
      </form>
      {(err || n > 0 || p.att?.chat) && (
        <div className="mt-1 flex min-w-0 items-center gap-2 px-1 text-[12px]" style={{ color: C.faint }}>
          {err ? <span style={{ color: C.bad }}>{err}</span>
            : n > 0 ? <span className="min-w-0 truncate" title={p.att!.comments.map((c) => c.text).join("\n")}>💬 {n} · {p.att!.comments[n - 1].text}</span> : null}
          {p.att?.chat && <button onClick={() => onOpen(p.att!.chat!)} className="ml-auto shrink-0 hover:text-white" style={{ color: C.up }}>Minami's chat →</button>}
        </div>
      )}
    </div>
  );
}

function Tile({ p, span, onOpen, onDismiss, onChanged }: { p: Publish; span: string; onOpen: (sid: string) => void; onDismiss: () => void; onChanged: () => void }) {
  const bad = p.tone === "late" || p.tone === "stuck";
  const day = p.label.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const today = day === new Date().toLocaleDateString("en-CA");
  const open = p.sessionId ? () => onOpen(p.sessionId!) : null;
  const head = (
    <div className="flex items-center gap-2 text-[12.5px]" style={{ color: C.mute }}>
      <span className={`h-1.5 w-1.5 rounded-full ${p.live ? "animate-pulse" : ""}`} style={{ background: bad ? C.bad : p.live ? C.up : C.faint }} />
      <span className="truncate">{today ? "Publishing today's videos" : `Publishing ${day ?? p.label}`}</span>
      {open && <button onClick={open} className="ml-auto shrink-0 hover:text-white" style={{ color: C.up }}>chat →</button>}
    </div>
  );
  const frame = (body: React.ReactNode) => (
    <div className={`${span} flex min-w-0 flex-col overflow-hidden rounded-2xl px-[18px] py-4`}
      style={{ background: "#13161c", border: `1px solid ${bad || p.tone === "trouble" ? "rgba(255,123,127,.35)" : "rgba(255,255,255,.08)"}`, color: C.ink }}>
      {head}{body}
      <AskBox p={p} onOpen={onOpen} onChanged={onChanged} />
    </div>
  );

  // ── finished ──
  if (!p.live) {
    const posted = p.videos.filter((v) => v.state === "done").length;
    const notes = p.videos.filter((v) => v.state === "held" || v.state === "failed" || v.state === "skipped");
    const ok = !p.failed;
    return frame(<>
      <div className="mt-4 flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full text-[26px] font-bold" style={{ background: (ok ? C.ok : C.bad) + "22", color: ok ? C.ok : C.bad }}>{ok ? "✓" : "!"}</span>
        <span className="min-w-0">
          <span className="block text-[24px] font-semibold leading-tight">{posted === p.count ? `All ${posted} posted` : `${posted} of ${p.count} posted`}</span>
          <span className="block text-[13.5px] leading-snug" style={{ color: C.mute }}>
            Finished {p.endedAt ? hm(p.endedAt) : ""}{notes.length ? ` · ${notes.map((v) => `${v.n} ${v.state === "held" ? "held" : v.state === "failed" ? "failed" : "skipped"}${v.why ? `: ${v.why.replace(/^joke-judge: ✗ \w+: /, "")}` : ""}`).join(" · ")}` : ""}
          </span>
        </span>
      </div>
      <div className="mt-auto flex items-end gap-2.5">
        {p.videos.map((v) => <Cover key={v.n} p={p} v={v} w={24} ring={false} />)}
        <span className="ml-auto flex gap-2"><Btn onClick={onDismiss}>Dismiss</Btn></span>
      </div>
    </>);
  }

  // ── live ──
  const cur = p.cur ?? p.videos.find((v) => v.state === "queued") ?? null;
  const rest = p.videos.filter((v) => v.n !== cur?.n); // by code: the JSON copy of `cur` is not the same object
  const slotAt = cur?.slot ? Date.parse(cur.slot) : null;
  const etaAt = cur?.leftMin != null ? Date.now() + cur.leftMin * 60e3 : null;
  const tryTxt = p.tryNo && p.tries && p.tryNo > 1 ? `, try ${p.tryNo} of ${p.tries}` : "";
  const big = !p.cur ? "Starting" : p.tone === "late" ? `${mins(cur!.lateMin!)} late` : cur!.leftMin != null ? mins(cur!.leftMin) : "…";
  const sub = !p.cur ? "measuring the speed"
    : p.tone === "late" ? `for its ${hm(slotAt!)} post · ${p.rateKBs} KB/s${tryTxt}`
    : p.tone === "stuck" ? `left · very slow, ${p.rateKBs} KB/s${tryTxt}${slotAt ? ` · posts ${hm(slotAt)}` : ""}`
    : `left${slotAt && etaAt ? ` · posts at ${hm(slotAt)}, ${mins((slotAt - etaAt) / 60e3)} to spare` : ""}`;
  return frame(<>
    <div className="mt-3 flex min-w-0 gap-4">
      {cur && <Cover p={p} v={cur} w={64} />}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]" style={{ color: C.mute }}>{p.tone === "stuck" ? "Stuck uploading" : p.cur ? "Uploading now" : "Up first"} · {cur?.n}</span>
        <span className="block truncate text-[15px] font-medium">{cur?.title}</span>
        <span className="mt-1.5 block text-[34px] font-semibold leading-none tracking-[-.02em]" style={{ color: bad ? C.bad : C.ink, fontVariantNumeric: "tabular-nums" }}>{big}</span>
        <span className="mt-1 block text-[13px] leading-snug" style={{ color: C.mute }}>{sub}</span>
      </span>
    </div>
    <div className="mt-auto flex min-w-0 items-end gap-2.5">
      {rest.map((v) => <Cover key={v.n} p={p} v={v} w={24} ring={v.state !== "queued"} />)}
      <span className="ml-auto shrink-0 self-center text-[12.5px]" style={{ color: C.mute }}>
        {bad ? `the rest wait for ${cur?.n}` : p.leftMin ? `all by ${hm(Date.now() + p.leftMin * 60e3)}` : ""}
      </span>
    </div>
  </>);
}

export function PublishTiles({ onOpen, span = "col-span-2 row-span-2" }: { onOpen: (sid: string) => void; span?: string }) {
  const [list, reload] = usePublishes();
  const [gone, setGone] = useState<number[]>([]);
  useEffect(() => { try { setGone(JSON.parse(localStorage.getItem(DISMISSED) || "[]")); } catch { /* none */ } }, []);
  const dismiss = (pid: number) => {
    const next = [...gone, pid].slice(-50);
    setGone(next);
    try { localStorage.setItem(DISMISSED, JSON.stringify(next)); } catch { /* private mode */ }
  };
  // Live ones always; of the finished, only the newest that hasn't been dismissed. Pids recycle, so a dismissal is
  // matched on pid + end time.
  const live = list.filter((p) => p.live);
  // A finished one only while nothing is live: once the next publish starts, the last one's result is history.
  const last = live.length ? undefined : list.find((p) => !p.live && !gone.includes(p.pid * 1e4 + ((p.endedAt ?? 0) % 1e4)));
  return <>{[...live, ...(last ? [last] : [])].map((p) => (
    <Tile key={`${p.pid}-${p.endedAt ?? "live"}`} p={p} span={span} onOpen={onOpen} onChanged={reload} onDismiss={() => dismiss(p.pid * 1e4 + ((p.endedAt ?? 0) % 1e4))} />
  ))}</>;
}
