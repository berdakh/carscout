// Watchlist storage. Lives in this browser's localStorage. With a GitHub token in
// Settings it is also saved to docs/data/watchlist.json in the repo, which is what the
// daily scan (GitHub Actions) reads. Without a token, "Download" gives you the file to
// commit by hand.
(function (global) {
  const KEY = "carscout.watchlist";
  const PATH = "docs/data/watchlist.json";
  const WORKFLOW = "daily-scan.yml";
  const empty = () => ({ version: 1, updated: null, settings: { location: "" }, searches: [], listings: [] });
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  let cache = null;

  function get() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { cache = null; }
    if (!cache || typeof cache !== "object") cache = empty();
    cache.searches ||= []; cache.listings ||= []; cache.settings ||= { location: "" };
    return cache;
  }
  function persist(w) {
    w.updated = new Date().toISOString();
    cache = w;
    try { localStorage.setItem(KEY, JSON.stringify(w)); } catch {}
    listeners.forEach(fn => { try { fn(w); } catch {} });
    return w;
  }
  const listeners = [];
  function onChange(fn) { listeners.push(fn); }

  function addSearch(name, params, location) {
    const w = get();
    w.searches.push({ id: uid(), name: name || "Saved search", params, location: location || "", added: new Date().toISOString() });
    return persist(w);
  }
  function addListing(listing) {
    const w = get();
    const keep = ["year", "make", "model", "trim", "price", "mileage", "seller_type", "title_status", "location", "vin", "url", "accident_reported", "notes"];
    const item = Object.fromEntries(keep.filter(k => listing[k] != null && listing[k] !== "").map(k => [k, listing[k]]));
    const dupe = w.listings.find(x => (item.url && x.url === item.url) || (item.vin && x.vin === item.vin));
    if (dupe) { Object.assign(dupe, item); return persist(w); }
    w.listings.push({ id: uid(), added: new Date().toISOString(), ...item });
    return persist(w);
  }
  function remove(kind, id) { const w = get(); w[kind] = w[kind].filter(x => x.id !== id); return persist(w); }
  function setLocation(loc) { const w = get(); w.settings.location = loc || ""; return persist(w); }
  function replace(w) { return persist(Object.assign(empty(), w)); }

  function download() {
    const blob = new Blob([JSON.stringify(get(), null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "watchlist.json" });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------- GitHub
  function gh() {
    const s = global.CarScoutAI.loadSettings();
    if (!s.githubToken || !s.githubRepo) return null;
    return { repo: s.githubRepo, headers: { Authorization: `Bearer ${s.githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } };
  }
  const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), c => c.charCodeAt(0)));
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str); let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function ghError(r, what) {
    let msg = ""; try { msg = (await r.json()).message || ""; } catch {}
    if (r.status === 401) return new Error(`GitHub rejected the token (${what}).`);
    if (r.status === 403 || r.status === 404) return new Error(`GitHub refused ${what}: ${msg || r.status}. Check the token can access ${gh().repo} with the needed permission.`);
    return new Error(`GitHub ${what} failed: ${r.status} ${msg}`);
  }
  async function remoteFile() {
    const g = gh(); if (!g) throw new Error("Add a GitHub token and repository in Settings.");
    const r = await fetch(`https://api.github.com/repos/${g.repo}/contents/${PATH}?ref=main`, { headers: g.headers, cache: "no-store" });
    if (r.status === 404) return { sha: null, data: null };
    if (!r.ok) throw await ghError(r, "reading the watchlist");
    const j = await r.json();
    return { sha: j.sha, data: JSON.parse(b64decode(j.content)) };
  }
  async function pull() { const { data } = await remoteFile(); if (data) replace(data); return get(); }
  async function push() {
    const g = gh(); if (!g) throw new Error("Add a GitHub token and repository in Settings.");
    const { sha } = await remoteFile();
    const r = await fetch(`https://api.github.com/repos/${g.repo}/contents/${PATH}`, { method: "PUT", headers: g.headers,
      body: JSON.stringify({ message: "Update CarScout watchlist", content: b64encode(JSON.stringify(get(), null, 1) + "\n"), branch: "main", ...(sha ? { sha } : {}) }) });
    if (!r.ok) throw await ghError(r, "saving the watchlist");
    return true;
  }
  async function runScanNow() {
    const g = gh(); if (!g) throw new Error("Add a GitHub token and repository in Settings.");
    const r = await fetch(`https://api.github.com/repos/${g.repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", headers: g.headers, body: JSON.stringify({ ref: "main" }) });
    if (!r.ok) throw await ghError(r, "starting the scan");
    return `https://github.com/${g.repo}/actions/workflows/${WORKFLOW}`;
  }
  const syncEnabled = () => !!gh();

  // ---------------------------------------------------------------- reports
  async function fetchJSON(path) {
    const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    try { return await r.json(); } catch { return null; }
  }
  const reportIndex = () => fetchJSON("reports/index.json");
  const report = date => fetchJSON(`reports/${date}.json`);
  const latestReport = () => fetchJSON("reports/latest.json");

  // The site's own copy seeds an empty browser (for example on a new phone).
  async function seedFromSite() {
    const w = get();
    if (w.searches.length || w.listings.length) return w;
    const site = await fetchJSON("data/watchlist.json");
    if (site && ((site.searches || []).length || (site.listings || []).length)) return replace(site);
    return w;
  }

  global.CarScoutStore = { get, addSearch, addListing, remove, setLocation, replace, onChange, download, pull, push, runScanNow,
    syncEnabled, reportIndex, report, latestReport, seedFromSite };
})(typeof window !== "undefined" ? window : globalThis);
