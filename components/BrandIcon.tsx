"use client";
// A brand/tech icon rendered as a rounded "app-icon" tile with a WHITE background, so every brand —
// light or dark — reads clearly in dark mode (accessibility). The glyph is the brand colour, darkened
// only when the brand itself is near-white. If we don't have an SVG for a slug (trademark-removed
// brands like Slack/OpenAI), it falls back to a lettermark tile, so every detected tech shows something.
export type Icon = { title: string; hex: string; path: string };

// Colour + short label for common brands simple-icons doesn't ship an SVG for.
const FALLBACK: Record<string, { label: string; hex: string; title?: string }> = {
  slack: { label: "S", hex: "4A154B", title: "Slack" },
  openai: { label: "AI", hex: "000000", title: "OpenAI" },
  amazonwebservices: { label: "aws", hex: "FF9900", title: "AWS" },
  microsoftazure: { label: "Az", hex: "0078D4", title: "Azure" },
  microsoftexcel: { label: "XL", hex: "217346", title: "Excel" },
  microsoftword: { label: "W", hex: "2B579A", title: "Word" },
  microsoftoutlook: { label: "O", hex: "0F6CBD", title: "Outlook" },
  microsoftteams: { label: "T", hex: "6264A7", title: "Teams" },
  microsoftsharepoint: { label: "SP", hex: "036C70", title: "SharePoint" },
  java: { label: "J", hex: "ED8B00", title: "Java" },
  csharp: { label: "C#", hex: "512BD4", title: "C#" },
  twilio: { label: "Tw", hex: "F22F46", title: "Twilio" },
  sendgrid: { label: "SG", hex: "1A82E2", title: "SendGrid" },
  segment: { label: "Sg", hex: "52BD94", title: "Segment" },
  salesforce: { label: "SF", hex: "00A1E0", title: "Salesforce" },
  tableau: { label: "Tb", hex: "E97627", title: "Tableau" },
  dbt: { label: "dbt", hex: "FF694B", title: "dbt" },
  heroku: { label: "H", hex: "430098", title: "Heroku" },
  linode: { label: "Ln", hex: "00A95C", title: "Linode" },
  playwright: { label: "Pw", hex: "2EAD33", title: "Playwright" },
};

const lum = (hex: string) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
// Glyph colour on a white tile: the brand colour, darkened when the brand is itself near-white.
const glyphColor = (hex: string) => (lum(hex) > 0.82 ? "#1f1d24" : `#${hex.replace("#", "")}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function BrandIcon({ slug, icons, size = 22 }: { slug: string; icons: Record<string, Icon>; size?: number }) {
  const icon = icons[slug];
  const hex = icon ? icon.hex : (FALLBACK[slug]?.hex || "3a3346");
  const fg = glyphColor(hex);
  const title = icon?.title || FALLBACK[slug]?.title || cap(slug);
  const glyph = Math.round(size * 0.62);
  return (
    <span title={title} aria-label={title}
      className="inline-flex shrink-0 items-center justify-center rounded-[26%] bg-white shadow-[0_2px_6px_-1px_rgba(0,0,0,0.5)] ring-1 ring-black/10 transition-transform hover:scale-110"
      style={{ width: size, height: size }}>
      {icon
        ? <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill={fg}><path d={icon.path} /></svg>
        : <span style={{ color: fg, fontSize: Math.max(8, size * 0.44), fontWeight: 800, lineHeight: 1 }}>{FALLBACK[slug]?.label || slug.slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}
