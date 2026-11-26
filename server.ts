import { aggregate, type Aggregated } from "./aggregate.ts";
import { loadConfig, getConfig, saveConfig, type Config } from "./config.ts";
import { verifyResource } from "./verify.ts";

const PORT = Number(process.env.PORT || 8090);
const REFRESH_MS = 3 * 60 * 60 * 1000; // re-pull every 3 hours (gentle — avoids source rate-limits/blocks)

let cache: Aggregated = { items: [], sources: {}, categories: {}, fetchedAt: "", ok: [], failed: [] };
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await aggregate();
    if (next.items.length > 0) cache = next; // keep last-good if a full pull yields nothing
    console.log(`[refresh] ${cache.items.length} items | ok=${next.ok.length} failed=${next.failed.length}${next.failed.length ? " (" + next.failed.join(",") + ")" : ""}`);
  } catch (e) {
    console.error("[refresh] fatal:", e);
  } finally {
    refreshing = false;
  }
}

await loadConfig();
await refresh();
setInterval(refresh, REFRESH_MS);

const htmlPath = new URL("./public/index.html", import.meta.url);
const json = (data: unknown, init?: ResponseInit) => Response.json(data, { headers: { "Cache-Control": "no-store" }, ...init });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const method = req.method;

    if (pathname === "/api/health") {
      return json({ status: "ok", items: cache.items.length, fetchedAt: cache.fetchedAt, sources: Object.keys(cache.sources).length });
    }
    if (pathname === "/api/items") {
      return json({
        items: cache.items,
        sources: cache.sources,
        categories: cache.categories,
        customTabs: getConfig().customTabs,
        fetchedAt: cache.fetchedAt,
        failed: cache.failed,
      });
    }
    // ---- Resource Control panel API ----
    if (pathname === "/api/config" && method === "GET") {
      return json(getConfig());
    }
    if (pathname === "/api/config" && method === "POST") {
      try {
        const body = (await req.json()) as Config;
        const saved = await saveConfig(body);
        refresh(); // rebuild the wall with the new config (async — don't block the response)
        return json({ ok: true, config: saved });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, { status: 400 });
      }
    }
    if (pathname === "/api/verify" && method === "POST") {
      try {
        const { input } = (await req.json()) as { input?: string };
        return json(await verifyResource(String(input || "")));
      } catch (e) {
        return json({ ok: false, reason: (e as Error).message }, { status: 400 });
      }
    }
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(await Bun.file(htmlPath).text(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`ThreatWall on http://localhost:${server.port}`);
