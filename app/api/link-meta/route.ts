import { ownUrl } from "@/lib/tailnet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Title, description and image for a link card (components/LinkCard.tsx). Only for urls on this
// machine (see ownUrl): anything else answers `own:false` without a request leaving the box, so a
// transcript can't turn the dashboard into a fetcher for arbitrary addresses.
type Meta = { own: boolean; ok?: boolean; title?: string; description?: string; image?: string; remote?: string | null };
const cache = new Map<string, { at: number; m: Meta }>();
const TTL = 60_000; // short: these are dev servers, and a title changes the moment the page is edited
// Bounded: entries were only ever checked for age, never removed, so every distinct url a transcript
// ever showed stayed in memory (audit: 20k urls → +400 MB). Map keeps insertion order, so the first
// key is the oldest.
const MAX_ENTRIES = 500;
function remember(url: string, m: Meta) {
  cache.delete(url);
  remember(url, m);
  while (cache.size > MAX_ENTRIES) { const k = cache.keys().next().value; if (k === undefined) break; cache.delete(k); }
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ").trim();
function metaTag(html: string, names: string[]): string | undefined {
  for (const n of names) {
    // Attribute order varies between generators, so try both content-after and content-before.
    const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, "i"));
    if (a?.[1]) return decode(a[1]);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url") || "";
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return Response.json(hit.m);
  const own = await ownUrl(url);
  let m: Meta = { own: false };
  if (own) {
    m = { own: true, ok: false, remote: own.remoteUrl };
    for (const f of own.fetchUrls) try {
      const r = await fetch(f, { signal: AbortSignal.timeout(4000), headers: { accept: "text/html" } });
      m.ok = r.ok;
      if (r.ok && (r.headers.get("content-type") || "").includes("html")) {
        // The head is all we read; cap it so a huge page (or a stream that never ends) can't stall us.
        const html = (await r.text()).slice(0, 200_000);
        const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
        m.title = metaTag(html, ["og:title"]) || (t ? decode(t) : undefined);
        m.description = metaTag(html, ["og:description", "description"]);
        const img = metaTag(html, ["og:image"]);
        if (img) { try { m.image = new URL(img, url).toString(); } catch { /* malformed — skip it */ } }
      }
      break;
    } catch { /* refused on this family — try the next; none answering leaves ok false */ }
  }
  cache.set(url, { at: Date.now(), m });
  return Response.json(m);
}
