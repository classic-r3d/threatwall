import { FETCHERS, rssSource, type Item } from "./sources.ts";
import { getConfig, type Config, type CustomTab } from "./config.ts";

const AI_TERMS = /\b(AI|LLM|GPT|machine learning|ML model|prompt injection|deepfake|neural|copilot|agentic|jailbreak|model|Anthropic|OpenAI)\b/i;
const CVE_RE = /CVE-\d{4}-\d{4,7}/i;
const HOT_TERMS = /\b(0-?day|zero-?day|RCE|exploit|actively exploited|in the wild|critical|unauthenticated|ransomware|backdoor|supply chain|privilege escalation|bypass|PoC|proof of concept)\b/i;
const OFFENSIVE_TERMS = /\b(exploit|payload|red team|pentest|penetration|attack|malware|C2|beacon|reverse shell|privilege|recon|phishing|bypass|evasion|shellcode)\b/i;

function enrichTags(it: Item): void {
  const text = `${it.title} ${it.summary || ""}`;
  const t = new Set(it.tags);
  if (CVE_RE.test(text)) t.add("CVE");
  if (AI_TERMS.test(text)) t.add("AI");
  if (HOT_TERMS.test(text)) t.add("hot");
  if (OFFENSIVE_TERMS.test(text)) t.add("offensive");
  it.tags = [...t];
}

// Filter categories. An item can belong to several. Keyword-driven, not curated.
const CAT_RE: Record<string, RegExp> = {
  webapp: /\b(web ?app|xss|sql ?injection|sqli|ssrf|csrf|owasp|request smuggling|deserial|web cache|jwt|oauth|graphql|\bapi\b|cookie|session hijack|\bwaf\b|cross-site|web shell)\b/i,
  mobile: /\b(android|ios\b|iphone|ipad|mobile app|\bapk\b|frida|smartphone|app store|play store|objective-c|swiftui|mobile malware)\b/i,
  aisec: /\b(prompt injection|\bllm\b|jailbreak|ai security|adversarial|model poisoning|deepfake|ml model|agentic|\bmcp\b|ai model|ai agent|hallucinat)\b/i,
  cloud: /\b(cloud|\baws\b|azure|\bgcp\b|s3 bucket|kubernetes|\bk8s\b|container|docker|serverless|\biam\b|\beks\b|lambda|cloudfront|terraform|okta)\b/i,
  network: /\b(network|firewall|\bvpn\b|router|packet|\btcp\b|\bdns\b|\bbgp\b|\bids\b|\bips\b|\bsmb\b|\brdp\b|lateral movement|proxy|port scan|\bvlan\b)\b/i,
  wireless: /\b(wi-?fi|wireless|wpa\d?|bluetooth|\bble\b|zigbee|802\.11|\bsdr\b|\brfid\b|\bnfc\b|radio frequency|deauth)\b/i,
  // Bug bounty — includes relevant research articles/writeups, not just bounty news
  bugbounty: /\b(bug ?bounty|bounty|hackerone|bugcrowd|intigriti|disclosed report|\bvdp\b|responsible disclosure|\bp1\b|reward|triage|\bidor\b|account takeover|subdomain takeover|write-?up|proof of concept|\bpoc\b|attack chain|chained|exploit chain|hall of fame)\b/i,
  iot: /\b(\biot\b|firmware|embedded device|smart home|smart device|\buart\b|\bjtag\b|\bmqtt\b|router firmware|ip camera|scada|\bics\b)\b/i,
  // Cryptography (the security discipline — not cryptocurrency). Includes post-quantum crypto.
  crypto: /\b(cryptograph|encryption|encrypt|decrypt|\bcipher\b|\bAES\b|\bRSA\b|\bTLS\b|\bSSL\b|\bPKI\b|\bHSM\b|digital signature|key exchange|diffie-?hellman|elliptic curve|\bECC\b|hash function|\bHMAC\b|\bx509\b|certificate authority|end-to-end encryption|\bE2EE\b|side-channel|post-?quantum|quantum-?resistant|quantum-?safe|\bPQC\b|quantum key distribution|\bQKD\b|Shor'?s algorithm|\bML-KEM\b|\bML-DSA\b|\bKyber\b|\bDilithium\b|NIST PQC|harvest[ -]now[, ]+decrypt[ -]later|quantum (crypto|encryption|threat|attack))\b/i,
  // Hardware / chip vulnerabilities. Bare "intel"/"amd" excluded (they match "threat intel",
  // "Intel stock", etc.) — chip-vendor news arrives tagged via the dedicated chipVulns source.
  hardware: /\b(qualcomm|snapdragon|ryzen|\bxeon\b|\bepyc\b|\bcpu\b|processor|chipset|microcode|silicon|\buefi\b|spectre|meltdown|rowhammer|downfall|zenbleed|speculative execution|side-channel)\b/i,
  // CTF — includes writeups/walkthroughs/challenge articles, not just event news
  ctf: /\b(\bctf\b|capture the flag|write-?up|walkthrough|\bpwn\b|reversing challenge|crackme|flag\{|pwnable|boot2root|hack ?the ?box|\bhtb\b|tryhackme|\bthm\b|challenge writeup|exploit dev)\b/i,
};
const AITREND_CTX = /\b(defen|detect|\bsoc\b|blue ?team|automat|copilot|threat intel|security operations|analyst|governance|adoption|enterprise|workflow)\b/i;

// Politics filter — drop overtly partisan/electoral items UNLESS they're clearly security/tech.
// (Nation-state cyber threats stay: they match the security terms below.)
const POLITICS_RE = /\b(election|electoral|voters?|ballots?|campaign trail|Trump|Biden|Harris|Kamala|Democrats?|Republicans?|\bGOP\b|congressional|\bsenator\b|parliament|prime minister|presidential (race|candidate|campaign)|political party|left-?wing|right-?wing|abortion|immigration (policy|debate|bill)|impeach|partisan|culture war)\b/i;
// U.S. law & politics — the user wants these OUT entirely (legal process + U.S. gov/policy).
const US_LAW_POLITICS_RE = /\b(class action|lawsuit|litigation|files? suit|\bsues\b|\bsued\b|plaintiff|defendant|court (rules?|ruling|order|filing|documents?)|supreme court|federal (court|judge|prosecutors?|law)|\bDOJ\b|department of justice|\bFTC\b|SEC (charges|fines|lawsuit|filing)|subpoena|indict(ed|ment)?|plea deal|attorney general|congress\b|\bsenate\b|house of representatives|capitol hill|executive order|white house|state legislature|ballot measure)\b/i;
const SEC_STRONG = /\b(cyber|security|vulnerab|\bCVE\b|exploit|malware|ransomware|breach|hack|phish|threat|\bAPT\b|encrypt|cryptograph|quantum|\bAI\b|\bLLM\b|patch|zero-?day|attack|infosec|firewall|botnet)\b/i;

// Overall program scope — ethical hacking / offensive security & AI-in-cybersecurity. A custom
// source's items must match this to be kept (general/off-topic articles from that feed are dropped).
const SCOPE_RE = /\b(security|cyber|vulnerab|\bCVE\b|exploit|malware|ransomware|breach|hack(ing|er|ed|s)?|phish|threat|\bAPT\b|pentest|penetration test|red ?team|blue ?team|bug ?bounty|infosec|offensive security|encrypt|decrypt|cryptograph|firewall|botnet|zero-?day|\b0-?day\b|backdoor|payload|\bc2\b|shellcode|privilege escalation|lateral movement|osint|forensic|incident response|\bSOC\b|\bSIEM\b|spyware|rootkit|prompt inject|jailbreak|model poisoning|adversarial (ml|ai|attack)|deepfake|LLM security|AI security|AI-powered (attack|threat|security)|agentic|\bMCP\b)\b/i;
export function isPolitical(it: Item): boolean {
  const text = `${it.title} ${it.summary || ""}`;
  if (US_LAW_POLITICS_RE.test(text)) return true;               // exclude U.S. law & politics outright
  return POLITICS_RE.test(text) && !SEC_STRONG.test(text);       // exclude partisan unless clearly security
}

function categorize(it: Item): string[] {
  const text = `${it.title} ${it.summary || ""}`;
  const cats: string[] = [];
  // explicit category hints (e.g. curated X handles tagged "cat:aisec")
  for (const t of it.tags) if (t.startsWith("cat:")) cats.push(t.slice(4));
  // dedicated tweets filter — every X/social item
  if (it.sourceType === "social") cats.push("tweets");
  // dedicated source filters
  if (it.tags.includes("youtube")) cats.push("youtube");
  if (it.tags.includes("linkedin")) cats.push("linkedin");
  if (it.tags.includes("tool") || it.sourceType === "tool") cats.push("tools");
  if (it.tags.includes("uae")) cats.push("uae");
  if (it.tags.includes("hardware")) cats.push("hardware");
  // HTB / THM machine writeups: 0xdf & writeup-tagged accounts, or explicit HTB/THM machine text
  if (it.tags.includes("writeup") || (/\b(hack ?the ?box|HTB|tryhackme|THM|vulnhub|proving grounds)\b/i.test(text) && /\b(machine|box|writeup|walkthrough|root|user flag|pwned|foothold)\b/i.test(text))) cats.push("writeups");
  // remaining categories are keyword-driven (ctf removed)
  for (const [id, re] of Object.entries(CAT_RE)) if (id !== "ctf" && re.test(text)) cats.push(id);
  // "quantum" news counts as cryptography when it co-occurs with crypto (e.g. "quantum breaks RSA")
  if (/\bquantum\b/i.test(text) && /\b(RSA|encryption|cryptograph|cipher|\bkey\b|crypto)\b/i.test(text) && !cats.includes("crypto")) cats.push("crypto");
  // AI trends in cybersecurity = AI signal in a defensive/operational context
  if (AI_TERMS.test(text) && AITREND_CTX.test(text) && !cats.includes("aitrends")) cats.push("aitrends");
  if (it.tags.includes("AI") && !cats.includes("aisec") && !cats.includes("aitrends")) cats.push("aisec");
  // user-created tabs — match by their keywords (custom-source items already carry cat:<id>)
  for (const tab of activeCustomTabs) {
    if (cats.includes(tab.id)) continue;
    if ((tab.keywords || []).some((k) => k && text.toLowerCase().includes(k.toLowerCase()))) cats.push(tab.id);
  }
  return [...new Set(cats)];
}

// Computed priority: engagement + recency + threat keywords. Not curated.
export function score(it: Item): number {
  const text = `${it.title} ${it.summary || ""}`;
  let s = 0;

  const ageH = (Date.now() - Date.parse(it.publishedAt)) / 3.6e6;
  s += Math.max(0, 60 - ageH); // recency: fresh = up to +60, ~0 after 60h

  s += Math.min(50, (it.points || 0) * 0.4);   // HN points
  s += Math.min(25, (it.comments || 0) * 0.3); // discussion

  if (it.sourceType === "cve") s += 55;          // KEV = actively exploited
  if (CVE_RE.test(text)) s += 30;
  if (HOT_TERMS.test(text)) s += 35;
  if (OFFENSIVE_TERMS.test(text)) s += 15;
  if (AI_TERMS.test(text)) s += 18;
  if (it.sourceType === "research") s += 8;
  if (it.sourceType === "social") s += 6;
  if (it.sourceType === "video") s += 4;

  return Math.round(s);
}

export type Scored = Item & { score: number; categories: string[] };
export type Aggregated = {
  items: Scored[];
  sources: Record<string, number>;
  categories: Record<string, number>;
  fetchedAt: string;
  ok: string[];
  failed: string[];
};

// Per-source last-good cache: if a fetcher fails or returns empty this cycle (e.g. YouTube
// briefly blocks the IP), we reuse its previous items so its filter/tab never goes empty.
const lastGood: Record<string, Item[]> = {};

// custom tabs active for the current aggregate pass (read by categorize())
let activeCustomTabs: CustomTab[] = [];

export async function aggregate(): Promise<Aggregated> {
  const cfg: Config = getConfig();
  activeCustomTabs = cfg.customTabs || [];
  const disabled = new Set([...(cfg.disabledSources || []), ...(cfg.removedSources || [])].map((s) => s.toLowerCase()));
  const mutes = (cfg.muteRules || []).map((m) => m.toLowerCase().trim()).filter(Boolean);

  // Built-in fetchers + user-added custom sources. A custom source is just a REFERENCE feed;
  // its items are NOT force-tagged into a tab — they're filtered (on-scope + tab-relevant) below.
  const customByName: Record<string, (typeof cfg.customSources)[number]> = {};
  for (const cs of cfg.customSources || []) customByName[cs.name] = cs;
  const fetchers = [
    ...FETCHERS,
    ...(cfg.customSources || []).map((cs) => ({
      name: cs.name,
      fn: () => rssSource(cs.url, cs.name, "news", [...(cs.tags || [])]),
    })),
  ];

  const results = await Promise.allSettled(fetchers.map((f) => f.fn()));
  const ok: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  let items: Scored[] = [];

  // Reconcile each fetcher's output with its last-good snapshot before merging.
  const perSource: Item[][] = results.map((r, i) => {
    const name = fetchers[i].name;
    if (r.status === "fulfilled" && r.value.length > 0) {
      lastGood[name] = r.value;
      return r.value;
    }
    return lastGood[name] || [];
  });

  results.forEach((r, i) => {
    const name = fetchers[i].name;
    const live = r.status === "fulfilled" && r.value.length > 0;
    (live ? ok : failed).push(name + (r.status === "fulfilled" && !live && (lastGood[name]?.length) ? "(cached)" : ""));
    if (r.status === "rejected") console.error(`[aggregate] ${name} failed:`, (r.reason as Error)?.message);
    const cs = customByName[name]; // set only for user-added custom sources
    for (const it of perSource[i]) {
      if (disabled.has(it.source.toLowerCase())) continue;          // source turned off in the panel
      if (isPolitical(it)) continue;                                // stay away from politics
      const text = `${it.title} ${it.summary || ""}`.toLowerCase();
      if (mutes.some((m) => text.includes(m))) continue;            // user mute rules
      // strip only the fragment/trailing slash — NOT the query (YouTube's video id lives in ?v=)
      const key = it.url.replace(/#.*$/, "").replace(/\/+$/, "");
      if (seen.has(key)) continue;
      enrichTags(it);
      const cats = categorize(it);
      if (cs) {
        // custom reference feed: keep only items on-scope, and if attached to specific tab(s),
        // only items that actually match those tab(s).
        if (!SCOPE_RE.test(`${it.title} ${it.summary || ""}`)) continue;
        if ((cs.tabs || []).length && !cs.tabs.some((t) => cats.includes(t))) continue;
      }
      seen.add(key);
      items.push({ ...it, score: score(it), categories: cats });
    }
  });

  items.sort((a, b) => b.score - a.score);

  const sources: Record<string, number> = {};
  const categories: Record<string, number> = {};
  for (const it of items) {
    sources[it.source] = (sources[it.source] || 0) + 1;
    for (const c of it.categories) categories[c] = (categories[c] || 0) + 1;
  }

  return { items, sources, categories, fetchedAt: new Date().toISOString(), ok, failed };
}
