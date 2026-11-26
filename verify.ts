// Verify a user-suggested resource before it's added:
//  1. SECURITY — only http(s); block SSRF to localhost / private / cloud-metadata addresses.
//  2. USABILITY — resolve accounts (@handle, r/sub, YouTube) and sites to a feed URL, then
//     confirm we can actually parse items. Uses feed auto-discovery + a Google News fallback
//     so most reachable sites work even without an obvious /feed path.
import { get, parseFeed } from "./sources.ts";

export type VerifyResult = {
  ok: boolean;
  reason: string;
  kind?: "rss" | "twitter" | "reddit" | "youtube" | "site";
  name?: string;
  feedUrl?: string;
  sampleTitles?: string[];
};

const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1|\[::1\]|fc00:|fd00:|metadata\.google|metadata$)/i;
function isPrivateHost(host: string): boolean {
  if (PRIVATE_HOST.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  return !!(m && +m[1] >= 16 && +m[1] <= 31);
}
function safeUrl(u: string): URL {
  let url: URL;
  try { url = new URL(u); } catch { throw new Error("Not a valid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are allowed.");
  if (isPrivateHost(url.hostname)) throw new Error("Refusing to fetch a local/private/internal address.");
  if (url.username || url.password) throw new Error("Credentials in URL are not allowed.");
  return url;
}
function looksMalicious(input: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(input)) return true; // control characters
  return /javascript:|vbscript:|data:text\/html|<script\b|onerror\s*=|onload\s*=/i.test(input);
}

const ok = (kind: VerifyResult["kind"], name: string, feedUrl: string, feed: { title: string }[]): VerifyResult => ({
  ok: true, reason: `Reachable — parsed ${feed.length} item(s).`, kind, name, feedUrl,
  sampleTitles: feed.slice(0, 3).map((f) => f.title),
});

// fetch a URL (SSRF-gated) and parse it as a feed; returns items (possibly empty)
async function feedItems(url: string) {
  const body = await get(safeUrl(url).toString());
  return { body, feed: parseFeed(body, 5) };
}

// find <link rel="alternate" type="application/rss+xml|atom+xml" href="..."> in a page
function discoverFeeds(html: string, base: string): string[] {
  const out: string[] = [];
  for (const l of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel=["']?alternate/i.test(l)) continue;
    if (!/type=["']application\/(rss|atom)\+xml/i.test(l)) continue;
    const h = l.match(/href=["']([^"']+)["']/i);
    if (h) { try { out.push(new URL(h[1], base).toString()); } catch { /* skip */ } }
  }
  return out;
}

export async function verifyResource(input: string): Promise<VerifyResult> {
  const s = (input || "").trim();
  if (!s) return { ok: false, reason: "Enter a URL or an account (e.g. @handle, r/sub)." };
  if (looksMalicious(s)) return { ok: false, reason: "Input rejected by the security check (suspicious characters/payload)." };

  // --- 1. X/Twitter @handle ---
  const at = s.match(/^@([A-Za-z0-9_]{2,15})$/);
  if (at) {
    const url = `https://nitter.net/${at[1]}/rss`;
    try { const { feed } = await feedItems(url); if (feed.length) return ok("twitter", "@" + at[1], url, feed); }
    catch (e) { return { ok: false, reason: `@${at[1]}: ${(e as Error).message} (Nitter may be down right now).` }; }
    return { ok: false, reason: `No tweets found for @${at[1]} (Nitter may be rate-limited).` };
  }

  // --- 2. Reddit r/sub ---
  const sub = s.match(/^\/?r\/([A-Za-z0-9_]{2,30})\/?$/i) || s.match(/reddit\.com\/r\/([A-Za-z0-9_]{2,30})/i);
  if (sub) {
    const url = `https://www.reddit.com/r/${sub[1]}/.rss`;
    try { const { feed } = await feedItems(url); if (feed.length) return ok("reddit", "r/" + sub[1], url, feed); }
    catch (e) { return { ok: false, reason: `r/${sub[1]}: ${(e as Error).message}` }; }
    return { ok: false, reason: `No posts found for r/${sub[1]}.` };
  }

  // --- 3. YouTube: channel id, /channel/UC..., or @handle / c/ / user/ URL ---
  const chId = (s.match(/channel\/(UC[\w-]{22})/) || s.match(/^(UC[\w-]{22})$/) || [])[1];
  if (chId) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;
    try { const { feed } = await feedItems(url); if (feed.length) return ok("youtube", "YouTube channel", url, feed); }
    catch (e) { return { ok: false, reason: `YouTube: ${(e as Error).message}` }; }
  }
  if (/youtube\.com\/(@[\w.\-]+|c\/[\w.\-]+|user\/[\w.\-]+)/i.test(s)) {
    try {
      const page = await get(safeUrl(/^https?:/i.test(s) ? s : "https://" + s).toString());
      const id = (page.match(/"channelId":"(UC[\w-]{22})"/) || page.match(/channel\/(UC[\w-]{22})/) || [])[1];
      const nm = (s.match(/@[\w.\-]+/) || ["YouTube channel"])[0];
      if (id) {
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
        const { feed } = await feedItems(url);
        if (feed.length) return ok("youtube", nm, url, feed);
      }
      return { ok: false, reason: "Found the YouTube page but couldn't resolve its channel id." };
    } catch (e) { return { ok: false, reason: `YouTube: ${(e as Error).message}` }; }
  }

  // --- 4. A URL or bare domain ---
  let start = "";
  if (/^https?:\/\//i.test(s)) start = s;
  else if (/^[a-z0-9.\-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) start = "https://" + s.replace(/^\/+/, "");
  if (start) {
    let url: URL, body = "";
    try { url = safeUrl(start); } catch (e) { return { ok: false, reason: (e as Error).message }; }
    const host = url.hostname.replace(/^www\./, "");
    try { const r = await feedItems(url.toString()); body = r.body; if (r.feed.length) return ok("rss", host, url.toString(), r.feed); }
    catch (e) { return { ok: false, reason: (e as Error).message }; }

    // (a+b) probe auto-discovered feeds AND common paths in PARALLEL — take the first with items
    const paths = ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml", "/feed/"].map((p) => url.origin + p);
    const tryUrls = [...new Set([...discoverFeeds(body, url.toString()), ...paths])];
    const probes = await Promise.allSettled(tryUrls.map(async (u) => {
      const { feed } = await feedItems(u);
      if (feed.length) return { u, feed };
      throw new Error("empty");
    }));
    const hit = probes.find((p) => p.status === "fulfilled") as PromiseFulfilledResult<{ u: string; feed: { title: string }[] }> | undefined;
    if (hit) return ok("rss", host, hit.value.u, hit.value.feed);
    // (c) fallback: track the site via Google News (works for most reachable sites)
    try {
      const gn = `https://news.google.com/rss/search?q=${encodeURIComponent("site:" + host)}&hl=en-US&gl=US&ceid=US:en`;
      const { feed } = await feedItems(gn);
      if (feed.length) return {
        ok: true, kind: "site", name: host, feedUrl: gn,
        reason: `No native RSS found — will track ${host} via Google News (${feed.length} item(s)).`,
        sampleTitles: feed.slice(0, 3).map((f) => f.title),
      };
    } catch { /* give up */ }
    return { ok: false, reason: "Reachable, but no RSS/Atom feed found and no Google News coverage for this site." };
  }

  return { ok: false, reason: "Couldn't understand that. Try a full URL, @handle, r/sub, or a YouTube channel/URL." };
}
