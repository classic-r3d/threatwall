// User-editable configuration for ThreatWall (managed via the Resource Control panel).
// Persisted to config.json so custom sources/tabs, disabled sources and mute rules survive restarts.

export type CustomSource = {
  id: string;
  name: string;       // display label
  url: string;        // feed URL (RSS/Atom) OR a google-news query URL we build during verify
  tabs: string[];     // category ids this source feeds
  tags: string[];     // extra tags applied to its items
  kind: "rss";        // only RSS/Atom for now
};

export type CustomTab = {
  id: string;
  label: string;
  description: string;
  keywords: string[]; // items matching any keyword land in this tab
};

export type Config = {
  disabledSources: string[]; // source display-names the user unchecked (temporarily off)
  removedSources: string[];  // source display-names removed entirely (hidden from the list too)
  hiddenTabs: string[];      // built-in tab ids the user removed
  customSources: CustomSource[];
  customTabs: CustomTab[];
  muteRules: string[];       // case-insensitive substrings; matching items are hidden
};

const CONFIG_PATH = new URL("./config.json", import.meta.url);

const DEFAULT: Config = { disabledSources: [], removedSources: [], hiddenTabs: [], customSources: [], customTabs: [], muteRules: [] };

let cfg: Config = { ...DEFAULT };

export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await Bun.file(CONFIG_PATH).text());
    cfg = { ...DEFAULT, ...raw };
    // shape guards
    cfg.disabledSources ||= [];
    cfg.removedSources ||= [];
    cfg.hiddenTabs ||= [];
    cfg.customSources ||= [];
    cfg.customTabs ||= [];
    cfg.muteRules ||= [];
  } catch {
    cfg = { ...DEFAULT };
  }
  return cfg;
}

export function getConfig(): Config {
  return cfg;
}

export async function saveConfig(next: Config): Promise<Config> {
  cfg = {
    disabledSources: Array.isArray(next.disabledSources) ? next.disabledSources : [],
    removedSources: Array.isArray(next.removedSources) ? next.removedSources : [],
    hiddenTabs: Array.isArray(next.hiddenTabs) ? next.hiddenTabs : [],
    customSources: Array.isArray(next.customSources) ? next.customSources : [],
    customTabs: Array.isArray(next.customTabs) ? next.customTabs : [],
    muteRules: Array.isArray(next.muteRules) ? next.muteRules : [],
  };
  try { await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { console.error("[config] save failed:", e); }
  return cfg;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
