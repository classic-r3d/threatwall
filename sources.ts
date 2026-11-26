// Source fetchers for the security/AI news dashboard.
// Every fetcher is fault-isolated by the aggregator (Promise.allSettled) — a dead
// source degrades to zero items, never an exception that blanks the wall.

export type Item = {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceType: "news" | "cve" | "forum" | "video" | "social" | "research" | "tool";
  author?: string;
  handle?: string;
  publishedAt: string; // ISO
  points?: number;
  comments?: number;
  summary?: string;
  image?: string; // thumbnail (e.g. YouTube video still)
  tags: string[];
};

const UA = { "User-Agent": "threatwall/1.0 (+local)" };
const TIMEOUT_MS = 9000;

export async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function getJson<T = any>(url: string): Promise<T> {
  return JSON.parse(await get(url, { Accept: "application/json" }));
}

// ---- tiny regex RSS/Atom parser (zero deps) ----
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1]).trim() : "";
}
function pickAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["']`, "i"));
  return m ? decode(m[1]).trim() : "";
}

export type FeedItem = { title: string; link: string; date: string; summary: string; image: string };

// Extract an article's lead image from a feed entry: media:thumbnail/content, enclosure,
// or the first inline <img> in the (possibly escaped) content/description.
function pickImg(block: string): string {
  let m =
    block.match(/<media:thumbnail[^>]*\burl=["']([^"']+)["']/i) ||
    block.match(/<media:content[^>]*\burl=["']([^"']+)["'][^>]*(?:medium=["']image|type=["']image)/i) ||
    block.match(/<media:content[^>]*(?:medium=["']image["']|type=["']image[^"']*["'])[^>]*\burl=["']([^"']+)["']/i) ||
    block.match(/<(?:media:content|enclosure)[^>]*\burl=["']([^"']+\.(?:jpe?g|png|webp|gif)(?:\?[^"']*)?)["']/i) ||
    block.match(/<enclosure[^>]*\burl=["']([^"']+)["'][^>]*type=["']image/i);
  if (m) return decode(m[1]);
  const dec = decode(block);
  m = dec.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  if (m && /^https?:/i.test(m[1])) return m[1];
  return "";
}

export function parseFeed(xml: string, max = 15): FeedItem[] {
  const out: FeedItem[] = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);
  for (const raw of blocks.slice(0, max)) {
    const block = raw.split(isAtom ? /<\/entry>/i : /<\/item>/i)[0];
    const title = stripTags(pick(block, "title"));
    let link = isAtom ? pickAttr(block, "link", "href") : pick(block, "link");
    if (!link) link = pick(block, "guid");
    const date = pick(block, "pubDate") || pick(block, "published") || pick(block, "updated") || pick(block, "dc:date");
    const summary = stripTags(pick(block, "description") || pick(block, "summary") || pick(block, "content")).slice(0, 400);
    if (title && link) out.push({ title, link, date, summary, image: pickImg(block) });
  }
  return out;
}

function toIso(d: string): string {
  const t = Date.parse(d);
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ================= FETCHERS =================

// 1. Hacker News (Algolia) — security/exploit/AI front-page stories
export async function hackerNews(): Promise<Item[]> {
  const q = encodeURIComponent("security OR exploit OR vulnerability OR CVE OR hacking OR malware");
  const data = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&numericFilters=points%3E30&hitsPerPage=25`);
  return (data.hits || []).filter((h: any) => h.title && (h.url || h.objectID)).map((h: any) => ({
    id: "hn-" + h.objectID,
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: "Hacker News",
    sourceType: "forum" as const,
    author: h.author,
    publishedAt: new Date((h.created_at_i || 0) * 1000).toISOString(),
    points: h.points,
    comments: h.num_comments,
    summary: h.story_text ? stripTags(h.story_text).slice(0, 300) : "",
    tags: [],
  }));
}

export async function rssSource(
  url: string, source: string, sourceType: Item["sourceType"], baseTags: string[] = [],
): Promise<Item[]> {
  const feed = parseFeed(await get(url));
  return feed.map((f) => ({
    id: hash(source + f.link),
    title: f.title,
    url: f.link,
    source,
    sourceType,
    publishedAt: toIso(f.date),
    summary: f.summary,
    image: f.image || undefined,
    tags: [...baseTags],
  }));
}

export const theHackerNews = () => rssSource("https://feeds.feedburner.com/TheHackersNews", "The Hacker News", "news");
export const bleepingComputer = () => rssSource("https://www.bleepingcomputer.com/feed/", "BleepingComputer", "news");
export const krebs = () => rssSource("https://krebsonsecurity.com/feed/", "Krebs on Security", "news");
export const portSwigger = () => rssSource("https://portswigger.net/research/rss", "PortSwigger Research", "research", ["offensive"]);
export const darkReading = () => rssSource("https://www.darkreading.com/rss.xml", "Dark Reading", "news");
export const projectZero = () => rssSource("https://googleprojectzero.blogspot.com/feeds/posts/default", "Project Zero", "research", ["offensive"]);
export const simonWillison = () => rssSource("https://simonwillison.net/atom/everything/", "Simon Willison", "research", ["AI"]);
export const netsec = () => rssSource("https://www.reddit.com/r/netsec/.rss", "r/netsec", "forum", ["offensive"]);
export const redteamsec = () => rssSource("https://www.reddit.com/r/redteamsec/.rss", "r/redteamsec", "forum", ["offensive"]);

// arXiv cs.CR (crypto/security) recent — research trend signal
export const arxivSec = () =>
  rssSource("http://export.arxiv.org/api/query?search_query=cat:cs.CR&sortBy=submittedDate&sortOrder=descending&max_results=12", "arXiv cs.CR", "research", ["research"]);

// YouTube channels (RSS, no API key). Curated to offensive-security / AI-security channels.
// View counts are NOT in YouTube RSS, so "viral" = recent uploads from these top channels,
// topic-filtered to offensive security or AI-in-security.
// Offensive-security / AI-security YouTube channels. YouTube RSS has no view counts, so
// "decent interactions" is proxied by curating high-subscriber channels; we then topic-filter.
const YT = [
  { id: "UClcE-kVhqyiHCcjYwcpfj9w", name: "LiveOverflow" },
  { id: "UCa6eh7gCkpPo5XXUDfygQQA", name: "IppSec" },
  { id: "UCVeW9qkBjo3zosnqUbG7CFw", name: "John Hammond" },
  { id: "UCCZDt7MuC3Hzs6IH4xODLBw", name: "NahamSec" },
  { id: "UCP7WmQ_U4GB3K51Od9QvM0w", name: "David Bombal" },
  { id: "UC0ArlFuFYMpEewyRBzdLHiw", name: "TCM Security" },
  { id: "UC9x0AN7BWHpCDHSm9NiJFJQ", name: "NetworkChuck" },
  { id: "UCCsREoj8rSRkEvxWqxr74rQ", name: "Cybernews" },
  { id: "UCVPjtOVcnKaSRI8IO3KSetA", name: "zSecurity" },
  { id: "UC_82czjFMgsYMjodhG_4mIw", name: "Tyler Ramsbey" },
  { id: "UCMIqrmh2lMdzhlCPK5ahsAg", name: "Jack Rhysider" },
  { id: "UCs6dtu4e0JL-N4hVszsFpBw", name: "Tib3rius" },
  { id: "UC0ZTPkdxlAKf-V33tqXwi3Q", name: "HackerSploit" },
  { id: "UCjzceWf-OT3ImIKztzGkipA", name: "OSINT Curious" },
];
const YT_TOPIC = /\b(hack|exploit|pentest|penetration|malware|ransomware|vulnerab|\bCVE\b|payload|reverse ?eng|\bpwn\b|bug ?bounty|red ?team|blue ?team|\bCTF\b|privilege|bypass|\bc2\b|shellcode|binary exploit|\brop\b|recon|phish|active directory|osint|nmap|burp|metasploit|wifi|network security|cyber|\bAI\b|\bLLM\b|\bGPT\b|prompt ?inject|machine learning|deepfake|jailbreak|agentic|\bmodel\b)\b/i;
// Per-channel cache, persisted to disk. YouTube frequently blocks datacenter IPs, so we keep
// each channel's last-good videos and accumulate across cycles — the tab never re-empties, and
// it survives restarts. Channels that succeed refresh their slice; blocked ones keep old videos.
const YT_CACHE_PATH = new URL("./yt-cache.json", import.meta.url);
const ytCache: Record<string, Item[]> = {};
try { Object.assign(ytCache, JSON.parse(await Bun.file(YT_CACHE_PATH).text())); } catch { /* no cache yet */ }

export async function youtube(): Promise<Item[]> {
  // Fetch GENTLY — 2 channels at a time with a pause — so YouTube is less likely to flag the IP.
  for (let i = 0; i < YT.length; i += 2) {
    const batch = YT.slice(i, i + 2);
    const results = await Promise.allSettled(
      batch.map((c) => rssSource(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`, c.name, "video", ["video", "youtube", "viral"])),
    );
    results.forEach((r, k) => {
      if (r.status !== "fulfilled") return;
      const vids = r.value
        .filter((v) => YT_TOPIC.test(`${v.title} ${v.summary || ""}`))
        .slice(0, 5)
        .map((v) => {
          const id = (v.url.match(/(?:v=|\/shorts\/|youtu\.be\/)([\w-]{11})/) || [])[1]; // regular + Shorts
          return id ? { ...v, image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } : v;
        });
      if (vids.length) ytCache[batch[k].id] = vids; // only overwrite when a channel actually returns
    });
    if (i + 2 < YT.length) await new Promise((res) => setTimeout(res, 500));
  }
  try { await Bun.write(YT_CACHE_PATH, JSON.stringify(ytCache)); } catch { /* best effort */ }
  return Object.values(ytCache).flat();
}

// CISA Known Exploited Vulnerabilities — highest-priority CVE signal
export async function cisaKev(): Promise<Item[]> {
  const data = await getJson("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
  const vulns = (data.vulnerabilities || [])
    .slice()
    .sort((a: any, b: any) => Date.parse(b.dateAdded || 0) - Date.parse(a.dateAdded || 0))
    .slice(0, 15);
  return vulns.map((v: any) => ({
    id: "kev-" + v.cveID,
    title: `${v.cveID}: ${v.vulnerabilityName}`,
    url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
    source: "CISA KEV",
    sourceType: "cve" as const,
    publishedAt: v.dateAdded ? new Date(v.dateAdded).toISOString() : new Date().toISOString(),
    summary: `${v.shortDescription || ""} — Action: ${v.requiredAction || "patch"} (due ${v.dueDate || "n/a"}).`,
    tags: ["CVE", "exploited"],
  }));
}

// X / Twitter via Nitter RSS — best-effort. X actively blocks Nitter, so we try multiple
// instances per handle and swallow failures. Curated to popular security pros + AI voices.
// `cat` hints route a handle's tweets into the right filter category (see categorize()).
const NITTER_HOSTS = ["https://nitter.net", "https://xcancel.com"];
// Curated from {{PRINCIPAL_NAME}}'s reference list — bug bounty hunters, HTB/THM writeup
// authors, CVE/threat-intel trackers. `cat` hints route tweets into filters.
const X_ACCOUNTS: Array<{ h: string; cat: string[] }> = [
  { h: "DarkWebInformer", cat: [] },
  { h: "thecybermentor",  cat: ["bugbounty"] },
  { h: "georgehntr",      cat: ["bugbounty"] },
  { h: "rhynorater",      cat: ["bugbounty"] },
  { h: "4osp3l",          cat: ["bugbounty"] },
  { h: "whispersmith_n",  cat: [] },
  { h: "moblig_",         cat: [] },
  { h: "7h3h4ckv157",     cat: ["bugbounty"] },
  { h: "_johnhammond",    cat: [] },
  { h: "gregxsunday",     cat: ["bugbounty"] },
  { h: "0xTib3rius",      cat: ["bugbounty"] },
  { h: "HunterMapping",   cat: [] },
  { h: "CVEshield",       cat: [] },
  { h: "deadrosesxyz",    cat: ["bugbounty"] },
  { h: "hakluke",         cat: ["bugbounty"] },
  { h: "0xdf_",           cat: ["writeups"] },
  { h: "vulnHub",         cat: ["writeups"] },
  { h: "hackthebox_eu",   cat: ["writeups"] },
  { h: "offsectraining",  cat: ["writeups"] },
  { h: "TJ_null",         cat: ["writeups"] },
  { h: "TRyhackme",       cat: ["writeups"] },
  { h: "TCMsecurity",     cat: ["bugbounty"] },
];

async function fetchX(handle: string): Promise<string> {
  for (const host of NITTER_HOSTS) {
    try {
      const xml = await get(`${host}/${handle}/rss`);
      if (/<item/i.test(xml)) return xml;
    } catch { /* try next instance */ }
  }
  throw new Error("no nitter instance served @" + handle);
}

// concurrency-limited runner so we don't hammer a Nitter instance into rate-limiting
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        try { out.push(await fn(items[idx])); } catch { /* skip dead handle */ }
      }
    }),
  );
  return out;
}

// "Viral" proxy: X's like/retweet counts are not exposed via the free Nitter path, so we
// approximate reach by keeping only ORIGINAL posts (drop replies — low reach) from these
// high-follower accounts, and ONLY those that are security- or AI-related.
const SEC_AI_RE = /\b(secur|vulnerab|exploit|malware|ransomware|breach|hack|hacking|CVE|0-?day|zero-?day|phish|\bAPT\b|threat|\bRCE\b|backdoor|patch|attacker|infosec|cyber|pentest|red ?team|bug ?bounty|payload|botnet|\bC2\b|credential|firewall|\bCTF\b|malicious|spyware|rootkit|privilege|bypass|leak|\bAI\b|\bLLM\b|\bGPT\b|prompt ?inject|machine learning|deepfake|jailbreak|agentic|neural|Claude|OpenAI|Anthropic|model)\b/i;
const isReply = (title: string) => /^(R to |RT |@)/i.test(title.trim());
const isViralSecAI = (f: { title: string; summary: string }) =>
  !isReply(f.title) && SEC_AI_RE.test(`${f.title} ${f.summary || ""}`);

export async function twitter(): Promise<Item[]> {
  const perAccount = await pool(X_ACCOUNTS, 4, async (a) => {
    const feed = parseFeed(await fetchX(a.h), 5) // pull more, then keep the on-topic originals
      .filter(isViralSecAI)
      .slice(0, 2);
    return feed.map((f) => ({
      id: hash("x" + a.h + f.link),
      title: f.title,
      url: f.link,
      source: "@" + a.h,
      sourceType: "social" as const,
      author: a.h,
      handle: "@" + a.h,
      publishedAt: toIso(f.date),
      summary: f.summary,
      tags: ["social", "viral", ...a.cat.map((c) => "cat:" + c), ...(a.cat.includes("aisec") ? ["AI"] : [])],
    }));
  });
  return perAccount.flat();
}

// Trending security chatter via Nitter hashtag search — best-effort, often sparse.
export async function twitterTrending(): Promise<Item[]> {
  const q = encodeURIComponent("#infosec OR #bugbounty OR #cybersecurity");
  for (const host of NITTER_HOSTS) {
    try {
      const feed = parseFeed(await get(`${host}/search/rss?f=tweets&q=${q}`), 12).filter(isViralSecAI);
      if (feed.length) return feed.slice(0, 6).map((f) => ({
        id: hash("xtrend" + f.link),
        title: f.title,
        url: f.link,
        source: "X · Trending",
        sourceType: "social" as const,
        author: (f.link.match(/(?:nitter\.net|xcancel\.com)\/([^/]+)/) || [, "x"])[1],
        handle: "#infosec",
        publishedAt: toIso(f.date),
        summary: f.summary,
        tags: ["social", "viral", "trending"],
      }));
    } catch { /* try next */ }
  }
  return [];
}

// ---- CTF: UAE-only (announcements via CTFtime events API + UAE-relevant writeups) ----
const UAE_RE = /(uae|united arab emirates|dubai|abu dhabi|sharjah|ajman|fujairah|ras al[- ]?khaimah|umm al[- ]?quwain|emirat|technology innovation institute|\btii\b|gisec|hitb.*(abu dhabi|dubai)|black hat mea)/i;

// CTF announcements located in / organized from the UAE.
export async function ctfUAE(): Promise<Item[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 60 * 60 * 24 * 60;    // past 60 days
  const finish = now + 60 * 60 * 24 * 365;  // next year
  const events = await getJson<any[]>(`https://ctftime.org/api/v1/events/?limit=100&start=${start}&finish=${finish}`);
  const out: Item[] = [];
  for (const e of Array.isArray(events) ? events : []) {
    const blob = [e.title, e.location, (e.organizers || []).map((o: any) => o.name).join(" "), e.description].join(" ");
    if (!UAE_RE.test(blob)) continue;
    out.push({
      id: "ctfuae-" + e.id,
      title: `[UAE CTF] ${e.title}`,
      url: e.ctftime_url || e.url,
      source: "CTFtime · UAE",
      sourceType: "research",
      publishedAt: e.start ? new Date(e.start).toISOString() : new Date().toISOString(),
      summary: `${e.format || "CTF"} · ${e.location || "online"} · starts ${e.start ? new Date(e.start).toLocaleDateString() : "TBA"}. ${stripTags(e.description || "").slice(0, 220)}`,
      tags: ["ctf", "announcement", "uae"],
    });
  }
  return out;
}

// Writeups that reference UAE teams/events (usually sparse — that is expected).
export async function ctfUAEWriteups(): Promise<Item[]> {
  const items = await rssSource("https://ctftime.org/writeups/rss/", "CTFtime Writeup · UAE", "research", ["ctf", "uae"]);
  return items.filter((i) => UAE_RE.test(`${i.title} ${i.summary || ""}`));
}

// Viral security / AI-security TOOLS — GitHub repos ranked by stars (real virality metric).
async function ghSearch(q: string): Promise<Item[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`;
  const data = await getJson<any>(url);
  return (data.items || []).map((r: any) => ({
    id: "gh-" + r.id,
    title: r.full_name,
    url: r.html_url,
    source: "GitHub",
    sourceType: "tool" as const,
    publishedAt: r.pushed_at || r.created_at || new Date().toISOString(),
    points: r.stargazers_count,
    summary: `${r.description || "Security tool."} · ${r.language || "tool"} · ⭐${(r.stargazers_count / 1000).toFixed(1)}k`,
    tags: ["tool", ...(/\b(AI|LLM|GPT|prompt|machine learning|\bML\b|agentic)\b/i.test(`${r.full_name} ${r.description || ""}`) ? ["AI"] : [])],
  }));
}
export async function tools(): Promise<Item[]> {
  const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const results = await Promise.allSettled([
    ghSearch(`security tool stars:>800 pushed:>${since}`),
    ghSearch(`pentest stars:>500 pushed:>${since}`),
    ghSearch(`AI security stars:>150 pushed:>${since}`),
  ]);
  const seen = new Set<string>();
  return results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}

// HTB / THM machine writeups — 0xdf's blog + Medium tag feeds + InfoSec Write-ups publication.
export const htbWriteups = () => rssSource("https://0xdf.gitlab.io/feed.xml", "0xdf", "research", ["writeup"]);
export const mediumHTB = () => rssSource("https://medium.com/feed/tag/hackthebox", "Medium · HTB", "research", ["writeup"]);
export const mediumTHM = () => rssSource("https://medium.com/feed/tag/tryhackme", "Medium · THM", "research", ["writeup"]);
export const infosecWriteups = () => rssSource("https://infosecwriteups.com/feed", "InfoSec Writeups", "research", ["writeup"]);

// LinkedIn articles relevant to the topic — via Google News RSS scoped to linkedin.com
// (LinkedIn has no public API/RSS; this is the free path to indexed LinkedIn posts).
// LinkedIn — scoped to Cyber Security NEWS and AI TOOLS (drops generic career/business posts).
const LINKEDIN_RE = /\b(cyber ?security|infosec|data breach|\bbreach\b|ransomware|malware|phishing|threat intel|threat actor|vulnerab|\bCVE\b|zero-?day|exploit|cyber ?attack|hacked|\bAPT\b|\bSOC\b|\bSIEM\b|nation-state|AI tool|AI-powered|AI assistant|AI agent|\bLLM\b|\bGPT\b|chatgpt|copilot|gemini|claude|machine learning|prompt inject|agentic|AI model)\b/i;
export async function linkedin(): Promise<Item[]> {
  const q = encodeURIComponent('(cybersecurity OR "cyber security" OR "data breach" OR ransomware OR malware OR "threat intelligence" OR vulnerability OR "zero-day" OR "AI tools" OR "AI security" OR "AI agent" OR LLM OR "AI-powered") site:linkedin.com');
  const feed = parseFeed(await get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`), 35);
  return feed
    .map((f) => ({ ...f, title: f.title.replace(/\s*[-–—]\s*LinkedIn\s*$/i, "").trim() }))
    .filter((f) => LINKEDIN_RE.test(`${f.title} ${f.summary || ""}`))
    .slice(0, 12)
    .map((f) => {
      // Google News uses the whole LinkedIn post as the title — trim to a headline-length
      // lead (prefer first sentence) and keep the full text as the summary.
      const full = f.title;
      const head = (full.match(/^.{40,110}?[.!?…](\s|$)/)?.[0] || full.slice(0, 110)).trim();
      return {
        id: hash("li" + f.link),
        title: head + (full.length > head.length ? " …" : ""),
        url: f.link,
        source: "LinkedIn",
        sourceType: "news" as const,
        publishedAt: toIso(f.date),
        summary: full,
        tags: ["linkedin"],
      };
    });
}

// Darknet Diaries — hacking-story podcast. Cap to newest few so old episodes don't flood.
export async function darknetDiaries(): Promise<Item[]> {
  const items = await rssSource("https://feeds.megaphone.fm/darknetdiaries", "Darknet Diaries", "video", ["podcast"]);
  return items.slice(0, 4);
}

// Google News search → items (used for topic feeds with no native RSS). Strips the
// " - Publisher" suffix Google appends and uses the publisher as the source label.
async function googleNews(query: string, tags: string[], relevance?: (t: string) => boolean): Promise<Item[]> {
  const feed = parseFeed(await get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`), 25);
  return feed
    .map((f) => {
      const m = f.title.match(/^(.*)\s+-\s+([^-]{2,40})$/);
      return { ...f, cleanTitle: (m ? m[1] : f.title).trim(), publisher: (m ? m[2] : "News").trim() };
    })
    .filter((f) => !relevance || relevance(`${f.cleanTitle} ${f.summary || ""}`))
    .slice(0, 12)
    .map((f) => ({
      id: hash("gn" + f.link),
      title: f.cleanTitle,
      url: f.link,
      source: f.publisher,
      sourceType: "news" as const,
      publishedAt: toIso(f.date),
      summary: f.summary,
      image: f.image || undefined,
      tags: [...tags],
    }));
}

// Hardware / chip vulnerabilities — Qualcomm, Intel, AMD CVEs & advisories.
// Requires a chip term AND a vulnerability term (drops stock news, "threat intel", etc.).
export const chipVulns = () => googleNews(
  '(Qualcomm OR Intel OR AMD OR processor OR CPU OR "chipset") (vulnerability OR CVE OR flaw OR exploit OR "security advisory" OR patch OR microcode)',
  ["hardware"],
  (t) =>
    /\b(qualcomm|snapdragon|ryzen|xeon|epyc|\bcpu\b|processor|chipset|microcode|silicon|intel|amd)\b/i.test(t) &&
    /\b(vulnerab|\bCVE\b|flaw|exploit|advisory|patch|attack|breach|zero-?day|escape|speculative|side-channel|\bbug\b|microcode)\b/i.test(t),
);

// UAE cyber-security & top-tech-company news (TII, Mubadala, G42, CyberGate, e&, etc.).
const UAE_ENTITIES = /\b(uae|united arab emirates|dubai|abu dhabi|sharjah|ajman|emirat|\bTII\b|technology innovation institute|\bG42\b|mubadala|cyber ?gate|etisalat|\be&\b|presight|\bcore42\b|\bADNOC\b|khazna)\b/i;
export const uaeNews = () => googleNews(
  '(cybersecurity OR "cyber attack" OR "data breach" OR ransomware OR "cyber threat" OR "artificial intelligence" OR technology OR cloud) ' +
    '(UAE OR "United Arab Emirates" OR Dubai OR "Abu Dhabi" OR "Technology Innovation Institute" OR TII OR Mubadala OR G42 OR CyberGate OR Etisalat OR "e& enterprise" OR "Microsoft UAE")',
  ["uae"],
  (t) =>
    UAE_ENTITIES.test(t) &&
    /\b(cyber|security|breach|ransomware|hack|threat|attack|vulnerab|\bAI\b|artificial intelligence|technolog|chip|semiconductor|quantum|defen|surveillance|data (breach|protection|center|centre)|cloud (security|computing|provider|infrastructure)|digital (transformation|infrastructure|identity)|innovation institute)\b/i.test(t),
);

export const FETCHERS: Array<{ name: string; fn: () => Promise<Item[]> }> = [
  { name: "hackerNews", fn: hackerNews },
  { name: "theHackerNews", fn: theHackerNews },
  { name: "bleepingComputer", fn: bleepingComputer },
  { name: "krebs", fn: krebs },
  { name: "portSwigger", fn: portSwigger },
  { name: "darkReading", fn: darkReading },
  { name: "projectZero", fn: projectZero },
  { name: "simonWillison", fn: simonWillison },
  { name: "netsec", fn: netsec },
  { name: "redteamsec", fn: redteamsec },
  { name: "arxivSec", fn: arxivSec },
  { name: "youtube", fn: youtube },
  { name: "cisaKev", fn: cisaKev },
  { name: "twitter", fn: twitter },
  { name: "twitterTrending", fn: twitterTrending },
  { name: "tools", fn: tools },
  { name: "htbWriteups", fn: htbWriteups },
  { name: "mediumHTB", fn: mediumHTB },
  { name: "mediumTHM", fn: mediumTHM },
  { name: "infosecWriteups", fn: infosecWriteups },
  { name: "linkedin", fn: linkedin },
  { name: "chipVulns", fn: chipVulns },
  { name: "uaeNews", fn: uaeNews },
  { name: "darknetDiaries", fn: darknetDiaries },
];
