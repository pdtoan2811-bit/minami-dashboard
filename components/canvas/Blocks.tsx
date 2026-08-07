// Block renderers for the meeting canvas.
//
// This surface is not a dashboard. It is streamed as a screen share into Google Meet and read by
// clients and investors — often in a tile a few hundred pixels wide, often while someone is talking
// over it. That single fact drives every choice here:
//
//  · Type is much larger than dashboard type. Nothing below 13px, and the things that matter
//    (values, decisions) are 18–28px. Density is the enemy; a canvas nobody can read at a glance is
//    just a distraction on someone else's screen.
//  · No hover, no tooltips, no interaction. Nobody can point at this — it is a broadcast. Anything
//    that only reveals on hover is invisible here, so every value is directly labelled.
//  · Motion is entrance-only and short. Something sliding around while a client is mid-sentence
//    reads as broken, not delightful. Items animate in once and then hold still.
//  · Colour carries almost nothing. One accent (--sakura) for "live", and status colour only where
//    it is paired with a word — never colour alone, since a CVD viewer in the call can't decode it.
import type { Block, Decision, Person, Stat, Todo } from "@/lib/canvas-schema";
import { hueOf, initialsOf } from "@/lib/canvas-schema";

/* ── shared shell ─────────────────────────────────────────────────────────── */

function Card({ children, title, className = "" }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] ${className}`}
    >
      {title ? (
        <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-white/45">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

/** Status dot + word. Colour never travels alone — the word is the accessible carrier. */
function Dot({ tone }: { tone: "good" | "warning" | "critical" | "muted" }) {
  const c = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", muted: "rgba(255,255,255,0.28)" }[tone];
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: c }} aria-hidden />;
}

/* ── blocks ───────────────────────────────────────────────────────────────── */

function People({ people }: { people: Person[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {people.map((p, i) => {
        const h = hueOf(p.key || p.name);
        return (
          <div
            key={i}
            className="flex items-center gap-2.5 rounded-full border border-white/[0.07] bg-white/[0.04] py-1.5 pl-1.5 pr-4"
          >
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white/90"
              style={{
                background: `hsl(${h} 46% 34%)`,
                // A speaking ring rather than a colour change: identity colour must stay stable, or
                // people appear to "become someone else" every time they take a turn.
                boxShadow: p.speaking ? "0 0 0 2px var(--sakura), 0 0 0 4px rgba(232,133,155,0.22)" : "none",
              }}
            >
              {initialsOf(p.name)}
            </span>
            <span className="leading-tight">
              <span className="block text-[14px] font-medium text-white/90">{p.name}</span>
              {p.role ? <span className="block text-[11.5px] text-white/45">{p.role}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Todos({ items, title }: { items: Todo[]; title?: string }) {
  return (
    <Card title={title || "Action items"}>
      <ul className="space-y-2.5">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-[7px]">
              <Dot tone={t.done ? "good" : "muted"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[15px] leading-snug ${t.done ? "text-white/40 line-through" : "text-white/90"}`}>
                {t.text}
              </span>
              {t.owner || t.due ? (
                <span className="mt-0.5 block text-[12px] text-white/45">
                  {t.owner}
                  {t.owner && t.due ? " · " : ""}
                  {t.due}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Decisions({ items, title }: { items: Decision[]; title?: string }) {
  const tone = (s?: Decision["status"]) =>
    s === "rejected" ? "critical" : s === "parked" ? "warning" : "good";
  return (
    <Card title={title || "Decided"}>
      <ul className="space-y-2.5">
        {items.map((d, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-[7px]">
              <Dot tone={tone(d.status) as "good" | "warning" | "critical"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] leading-snug text-white/90">{d.text}</span>
              <span className="mt-0.5 block text-[12px] capitalize text-white/45">
                {d.status || "agreed"}
                {d.at ? ` · ${d.at}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Diverging meter. Alignment is a STATE, not a series, so status colour is legitimate here — and it
 *  ships with the number and a word, never colour alone. Midpoint is a true neutral grey so "no
 *  signal yet" reads as nothing rather than as mild agreement. */
function Alignment({ value, note, title }: { value: number; note?: string; title?: string }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = ((v + 1) / 2) * 100;
  const word = v > 0.25 ? "converging" : v < -0.25 ? "diverging" : "neutral";
  const color = v > 0.25 ? "#0ca30c" : v < -0.25 ? "#d03b3b" : "rgba(255,255,255,0.4)";
  return (
    <Card title={title || "Alignment"}>
      <div className="tabular-nums text-[30px] font-semibold leading-none text-white/95">
        {v > 0 ? "+" : ""}
        {v.toFixed(2)}
      </div>
      <div className="mt-1 text-[13px] capitalize" style={{ color }}>
        {word}
      </div>
      <div className="relative mt-4 h-2 rounded-full bg-white/[0.07]">
        {/* centre tick — the reference the bar is read against */}
        <span className="absolute left-1/2 top-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-white/25" />
        <span
          className="absolute top-0 h-2 rounded-full transition-[left,width] duration-[var(--dur-3)] ease-[var(--ease-out)]"
          style={{
            background: color,
            left: `${Math.min(50, pct)}%`,
            width: `${Math.abs(pct - 50)}%`,
          }}
        />
      </div>
      {note ? <p className="mt-3 text-[12.5px] leading-snug text-white/50">{note}</p> : null}
    </Card>
  );
}

function Stats({ items }: { items: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((s, i) => (
        <Card key={i} className="!p-4">
          <div className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-white/45">{s.label}</div>
          <div className="tabular-nums mt-1.5 text-[28px] font-semibold leading-none text-white/95">{s.value}</div>
          {s.hint ? <div className="mt-1.5 text-[12px] text-white/45">{s.hint}</div> : null}
        </Card>
      ))}
    </div>
  );
}

function Agenda({ items, title }: { items: { text: string; done?: boolean }[]; title?: string }) {
  const done = items.filter((i) => i.done).length;
  return (
    <Card title={title || "Agenda"}>
      <div className="tabular-nums text-[13px] text-white/55">
        {done} of {items.length}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        {items.map((it, i) => (
          <span
            key={i}
            className="h-1.5 flex-1 rounded-full"
            style={{ background: it.done ? "var(--sakura)" : "rgba(255,255,255,0.10)" }}
          />
        ))}
      </div>
      <ul className="mt-3.5 space-y-2">
        {items.map((it, i) => (
          <li key={i} className={`text-[14px] leading-snug ${it.done ? "text-white/35 line-through" : "text-white/85"}`}>
            {it.text}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Quote({ text, by }: { text: string; by?: string }) {
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-7 py-6">
      <p className="text-[22px] font-medium leading-snug text-white/92">“{text}”</p>
      {by ? <p className="mt-3 text-[13px] text-white/50">— {by}</p> : null}
    </section>
  );
}

function Recall({ text, source, title }: { text: string; source?: string; title?: string }) {
  return (
    <Card title={title || "From your second brain"} className="border-[var(--sakura)]/25 bg-[var(--sakura)]/[0.05]">
      <p className="text-[15px] leading-relaxed text-white/88">{text}</p>
      {source ? <p className="mt-3 truncate font-mono text-[11.5px] text-white/40">{source}</p> : null}
    </Card>
  );
}

function Moodboard({ shots, title }: { shots: { src: string; caption?: string }[]; title?: string }) {
  return (
    <Card title={title || "Shared screens"}>
      <div className="grid grid-cols-3 gap-2.5">
        {shots.map((s, i) => (
          <figure key={i} className="min-w-0">
            <div className="aspect-video overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.05]">
              {/* Plain <img>: these are runtime screenshots from the call, not build-time assets, so
                  next/image's optimiser would add a round-trip for zero benefit. */}
              {s.src ? (
                <img src={s.src} alt={s.caption || ""} className="size-full object-cover" />
              ) : (
                <div className="grid size-full place-items-center text-[11px] text-white/25">no capture</div>
              )}
            </div>
            {s.caption ? <figcaption className="mt-1.5 truncate text-[11.5px] text-white/45">{s.caption}</figcaption> : null}
          </figure>
        ))}
      </div>
    </Card>
  );
}

function Timeline({ items, title }: { items: { at: string; text: string }[]; title?: string }) {
  return (
    <Card title={title || "Moments"}>
      <ul className="space-y-3">
        {items.map((m, i) => (
          <li key={i} className="flex gap-3">
            <span className="tabular-nums w-11 shrink-0 pt-px text-[12px] text-white/40">{m.at}</span>
            <span className="text-[14px] leading-snug text-white/85">{m.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Note({ text, title }: { text: string; title?: string }) {
  return (
    <Card title={title}>
      <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-white/85">{text}</p>
    </Card>
  );
}

/* ── dispatch ─────────────────────────────────────────────────────────────── */

export function renderBlock(b: Block, i: number) {
  switch (b.kind) {
    case "heading":
      return (
        <header key={i}>
          <h1 className="text-[30px] font-semibold leading-tight text-white/95">{b.title}</h1>
          {b.subtitle ? <p className="mt-1 text-[14px] text-white/50">{b.subtitle}</p> : null}
        </header>
      );
    case "people": return <People key={i} people={b.people} />;
    case "todos": return <Todos key={i} items={b.items} title={b.title} />;
    case "decisions": return <Decisions key={i} items={b.items} title={b.title} />;
    case "quote": return <Quote key={i} text={b.text} by={b.by} />;
    case "moodboard": return <Moodboard key={i} shots={b.shots} title={b.title} />;
    case "alignment": return <Alignment key={i} value={b.value} note={b.note} title={b.title} />;
    case "stats": return <Stats key={i} items={b.items} />;
    case "agenda": return <Agenda key={i} items={b.items} title={b.title} />;
    case "recall": return <Recall key={i} text={b.text} source={b.source} title={b.title} />;
    case "timeline": return <Timeline key={i} items={b.items} title={b.title} />;
    case "note": return <Note key={i} text={b.text} title={b.title} />;
    default:
      // Unknown kind from a newer producer: skip it. A live client meeting is the worst possible
      // place to throw, and a missing block is a far smaller failure than a blank screen share.
      return null;
  }
}
