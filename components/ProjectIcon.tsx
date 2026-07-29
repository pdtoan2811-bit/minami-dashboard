"use client";
// Project → 3D icon (assets from 3dicons.co, in /public/icons). Shared by the bento grid and the
// collapsed rail, so a project is the same object in both — same glyph, same motion.
//
// Three sources, in order:
//   1. An explicit assignment in `~/.minami-bento/icons.json` (`"my-project": { "icon": "rocket" }`),
//      served through /api/bento/attach and maintained by the `bento-icons` skill.
//   2. Keywords in the project (working-directory) name — zero config, works for anyone's folders.
//   3. A deterministic pick from DISTINCT.
//
// Step 3 is the one that matters most in practice. It used to be a flat `return "cube"`, so every
// project whose name didn't happen to contain one of ~40 English keywords — which is most new topics,
// and every name in another language — got the *same* grey box. A tile you can't tell from its
// neighbour is worse than an arbitrary one: the icon's whole job in the grid and the rail is to be the
// thing you aim at without reading. Hashing the name at least guarantees neighbours differ, and
// guarantees the same project keeps the same glyph forever.
const ICON_KEYWORDS: [RegExp, string][] = [
  [/web|site|landing|www|url|seo|domain/, "link"],
  [/app|mobile|ios|android|flutter|react-native/, "mobile"],
  [/data|analytic|metric|chart|stat|report|dashboard|bento|monitor|observab|telemetry|\bbi\b|warehouse|etl|dbt/, "chart"],
  [/\bai\b|\bml\b|model|intel|brain|agent|llm|gpt|claude|prompt|rag|embed/, "bulb"],
  [/design|\bui\b|\bux\b|figma|brand|theme|style|css|token/, "color-palette"],
  [/doc|guide|note|wiki|content|blog|readme|book|journal|vault|second-?brain/, "notebook"],
  [/tool|kit|util|\bcli\b|script|helper|sdk|lib/, "tools"],
  [/bot|slack|chat|message|mail|inbox|discord|telegram|comment/, "chat"],
  [/money|pay|finance|invoice|billing|revenue|commerce|shop|store|ecom|cart|checkout|price/, "money-bag"],
  [/game|play|puzzle|fun|toy/, "puzzle"],
  [/secur|auth|login|lock|secret|vault|key|token|cred|permission/, "lock"],
  [/config|setting|infra|ops|deploy|server|api|backend|devops|docker|k8s|kube|terraform/, "setting"],
  [/rocket|launch|startup|mvp|growth|scale|central|core|main|hub/, "rocket"],
  [/market|campaign|ad(s|vert)?|promo|social|content-?plan|funnel/, "megaphone"],
  [/crm|customer|client|user|people|team|hr|recruit/, "boy"],
  [/plan|roadmap|sprint|task|todo|project|pm\b|calendar|schedule/, "calendar"],
  [/search|index|crawl|scrape|explore|discover/, "explorer"],
  [/test|qa|lint|check|verify|audit|bench/, "tick"],
  [/media|video|film|stream|record|camera|photo|image|render/, "video-cam"],
  [/music|audio|sound|podcast|voice|speech/, "music"],
  [/map|geo|location|travel|trip|place/, "map-pin"],
  [/mail|news|letter|subscribe|digest/, "mail"],
  [/health|fit|gym|workout|food|recipe|coffee|cafe/, "cup"],
  [/archive|backup|storage|file|drive|folder|repo/, "folder"],
  [/exp|lab|research|prototype|poc|sandbox|scratch|demo/, "lab"],
  [/win|award|goal|okr|target|kpi/, "target"],
];

// Visually distinct at 20px, semantically neutral, and none of them is the "default" of anything.
// Order is load-bearing only in that it must never be reshuffled — an entry moving would silently
// repaint every project that landed on it.
// `cube` is deliberately absent: it was the old catch-all default, so it now reads as "the icon this
// project didn't get". Still assignable by hand — just never handed out automatically.
const DISTINCT = [
  "sphere", "star", "leaf", "flag", "shield", "medal", "trophy", "crown", "key",
  "bell", "heart", "flash", "fire", "moon", "sun", "ribbon", "gift", "candy", "ball",
  "battery", "bookmark", "magic-trick", "potion", "umbrella", "glass", "bucket", "cap",
];
const hashN = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

export function iconOf(project: string, assigned?: string): string {
  if (assigned) return assigned;
  const key = project.toLowerCase();
  for (const [re, icon] of ICON_KEYWORDS) if (re.test(key)) return icon;
  return DISTINCT[hashN(key) % DISTINCT.length];
}

// Assign icons across the WHOLE visible set at once, because distinctness is the entire point and
// `iconOf` alone can't see siblings: `ownego-growth` and `ownegoCentral` both hit the
// `growth|central → rocket` rule and rendered as the same glyph, which is exactly the moment you're
// trying to tell two projects apart. A collision falls through to the next matching rule, then to the
// hash pool.
//
// Iteration is name-sorted, not display-sorted, so a glyph doesn't reshuffle when you change the grid's
// sort order or a project goes quiet. It CAN still change if a new project claims the same keyword
// first alphabetically — the cost of guaranteeing no two tiles look alike, which is the better trade.
export function assignIcons(names: string[], overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  const ordered = [...names].sort();
  for (const n of ordered) { const o = overrides[n]; if (o) { out[n] = o; used.add(o); } } // hand-assignment is never displaced
  for (const n of ordered) {
    if (out[n]) continue;
    const key = n.toLowerCase();
    let pick = "";
    for (const [re, icon] of ICON_KEYWORDS) if (re.test(key) && !used.has(icon)) { pick = icon; break; }
    if (!pick) {
      const h = hashN(key);
      for (let i = 0; i < DISTINCT.length && !pick; i++) { const c = DISTINCT[(h + i) % DISTINCT.length]; if (!used.has(c)) pick = c; }
    }
    out[n] = pick || iconOf(n); // more projects than glyphs: duplicates become unavoidable, stay deterministic
    used.add(out[n]);
  }
  return out;
}

// A transparent 3D icon (static 3dicons render) with a premium default motion: it gently tilts then
// rotates on a seamless loop (CSS `spin3d` keyframes in globals.css). Hovering the parent `.group`
// faces it front and scales it up; active projects run the loop a touch faster.
export function ProjectIcon({ name, icon: assigned, big, active, size }: { name: string; icon?: string; big?: boolean; active?: boolean; size?: number }) {
  const icon = iconOf(name, assigned);
  const s = big ? "h-14 w-14" : "h-9 w-9";
  return (
    <div className={`relative shrink-0 [perspective:600px] transition-transform duration-300 group-hover:scale-[1.16] ${size ? "" : s}`}
      style={size ? { height: size, width: size } : undefined}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/icons/${icon}.webp`} alt="" draggable={false}
        // A hand-assigned slug that isn't in /public/icons would render as a broken image where the
        // project's identity should be. Fall back to the inferred one instead.
        onError={(e) => { const el = e.currentTarget; const f = `/icons/${iconOf(name)}.webp`; if (!el.src.endsWith(f)) el.src = f; }}
        className="motion-icon h-full w-full object-contain [transform-style:preserve-3d] drop-shadow-[0_10px_16px_rgba(0,0,0,0.5)]"
        style={active ? { animation: "spin3d 4.5s ease-in-out infinite" } : undefined}
      />
    </div>
  );
}
