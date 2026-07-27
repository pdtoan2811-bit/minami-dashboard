// Pretty labels + colours for each machine that reports usage. The key is the SOURCE value your
// Stop hook sends (see server/README.md — e.g. MINAMI_SOURCE=local-mac). This is purely cosmetic:
// any source not listed here falls back to its raw name and the accent colour, so the dashboard
// works with any machine names. Add your own machines here to give them a nicer label/colour.
export type SourceMeta = { label: string; short: string; tint: string };

export const SOURCE_META: Record<string, SourceMeta> = {
  "local-mac": { label: "Local · Mac", short: "Mac", tint: "#6c9cf5" },
  "minami-cloud": { label: "Minami · cloud", short: "cloud", tint: "#b98cff" },
};

export function sourceMeta(source: string): SourceMeta {
  return SOURCE_META[source] || { label: source, short: source, tint: "#e8859b" };
}
