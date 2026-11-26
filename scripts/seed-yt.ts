// One-off: seed yt-cache.json by fetching each channel SLOWLY (long gaps + retries) so YouTube
// doesn't flag the IP. The server loads this cache on startup, then refreshes gently over time.
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
const TOPIC = /\b(hack|exploit|pentest|penetration|malware|ransomware|vulnerab|\bCVE\b|payload|reverse ?eng|\bpwn\b|bug ?bounty|red ?team|blue ?team|\bCTF\b|privilege|bypass|\bc2\b|shellcode|binary exploit|\brop\b|recon|phish|active directory|osint|nmap|burp|metasploit|wifi|network security|cyber|\bAI\b|\bLLM\b|\bGPT\b|prompt ?inject|machine learning|deepfake|jailbreak|agentic|\bmodel\b)\b/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function dec(s: string){ return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&amp;/g,"&"); }
function hash(s: string){ let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0; return (h>>>0).toString(36); }
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

async function fetchChannel(id: string, name: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error("http " + r.status);
      const xml = await r.text();
      const entries = xml.split(/<entry>/i).slice(1).map(b => b.split(/<\/entry>/i)[0]);
      const out: any[] = [];
      for (const e of entries) {
        const vid = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
        const title = dec((e.match(/<title>([\s\S]*?)<\/title>/) || [,""])[1]).trim();
        const published = (e.match(/<published>([^<]+)<\/published>/) || [,""])[1];
        const desc = dec((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [,""])[1]).replace(/\s+/g," ").slice(0,300);
        if (!vid || !title) continue;
        if (!TOPIC.test(`${title} ${desc}`)) continue;
        out.push({
          id: hash(name + `https://www.youtube.com/watch?v=${vid}`),
          title, url: `https://www.youtube.com/watch?v=${vid}`,
          source: name, sourceType: "video",
          publishedAt: published ? new Date(published).toISOString() : new Date().toISOString(),
          summary: desc, image: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          tags: ["video","youtube","viral"],
        });
        if (out.length >= 5) break;
      }
      return out;
    } catch (err) {
      console.error(`  ${name} attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt < 3) await sleep(20000);
    }
  }
  return null;
}

const cachePath = new URL("../yt-cache.json", import.meta.url);
const cache: Record<string, any[]> = {};
try { Object.assign(cache, JSON.parse(await Bun.file(cachePath).text())); } catch {}

for (let i = 0; i < YT.length; i++) {
  const c = YT[i];
  const vids = await fetchChannel(c.id, c.name);
  if (vids && vids.length) { cache[c.id] = vids; console.log(`✓ ${c.name}: ${vids.length} videos`); }
  else console.log(`✗ ${c.name}: none`);
  await Bun.write(cachePath, JSON.stringify(cache)); // save progressively
  if (i < YT.length - 1) await sleep(9000); // slow, human-like pacing
}
const total = Object.values(cache).flat().length;
console.log(`\nDONE — ${total} videos across ${Object.keys(cache).length} channels cached.`);
