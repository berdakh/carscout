// CarScout AI layer for the static site. Talks to Claude or ChatGPT straight from the
// browser with the user's own key (stored only in this browser's localStorage), using
// the official SDKs bundled in vendor/ai-sdks.js. Tools run locally against engine.js,
// the free NHTSA APIs, and the saved watchlist; web search runs on the provider's side.
(function (global) {
  const MODELS = {
    anthropic: [["claude-opus-5-5", "Claude Opus 5.5 (most capable)"], ["claude-sonnet-5-5", "Claude Sonnet 5.5 (about half the cost)"], ["claude-haiku-5-5", "Claude Haiku 5.5 (cheapest)"]],
    openai: [["gpt-5.5", "GPT-5.5"], ["gpt-5.4-mini", "GPT-5.4 mini (cheaper)"]],
  };
  const FALLBACK_BETA = "server-side-fallback-2026-07-01";
  const FALLBACK_PREFIXES = ["claude-opus-5", "claude-sonnet-5-5", "claude-fable-5"];
  const MAX_STEPS = 14;
  const MAX_TOOL_CHARS = 20000;

  // ---------------------------------------------------------------- settings
  const SETTINGS_KEY = "carscout.settings";
  const DEFAULTS = { provider: "anthropic", anthropicKey: "", openaiKey: "", anthropicModel: "claude-opus-5-5", openaiModel: "gpt-5.5",
    location: "", githubRepo: "", githubToken: "" };
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch {}
    const out = Object.assign({}, DEFAULTS, s);
    if (!out.githubRepo && typeof location !== "undefined" && location.hostname.endsWith(".github.io")) {
      const repo = location.pathname.split("/").filter(Boolean)[0];
      if (repo) out.githubRepo = `${location.hostname.split(".")[0]}/${repo}`;
    }
    return out;
  }
  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }
  function activeProvider(s = loadSettings()) {
    if (s.provider === "openai" && s.openaiKey) return "openai";
    if (s.provider === "anthropic" && s.anthropicKey) return "anthropic";
    if (s.anthropicKey) return "anthropic";
    if (s.openaiKey) return "openai";
    return null;
  }
  function describe(s = loadSettings()) {
    const p = activeProvider(s);
    if (!p) return null;
    return { provider: p, model: p === "anthropic" ? s.anthropicModel : s.openaiModel, label: p === "anthropic" ? "Claude" : "ChatGPT" };
  }

  // ---------------------------------------------------------------- prompts
  function systemPrompt(s) {
    const where = s.location ? `The user is near ${s.location}; use that for local prices and listings.` : "The user has not set a location; ask for a city or ZIP when local prices matter.";
    return `You are CarScout, a research assistant for first-time used-car buyers in the United States.

Help the user figure out what they can afford, which cars fit, whether a listing is a good deal, and how to buy safely. You have no paid listing feed. You reason from a seed table of popular models (budget_search, seed_lookup, grade_listing, finance_calc), free government data (vehicle_recalls, decode_vin), the user's saved watchlist and daily scan report (get_watchlist), and live web search.

How to work:
- For a monthly budget, call budget_search first, then explain the top picks in plain language. Rankings are by total monthly cost, not sticker price.
- For a pasted listing, call grade_listing. For a model not in the seed table, search the web for price ranges (CarGurus, Edmunds, KBB, iSeeCars) and reliability (RepairPal, CarComplaints, owner forums). Give a range with sources, never a single invented number.
- Call vehicle_recalls for any specific year and model the user is seriously considering.
- When asked about saved cars, changes, or "today", call get_watchlist.
- Be concrete about next steps: get the VIN, book a pre-purchase inspection, what to check on the test drive, an opening offer.
- Facebook Marketplace and Craigslist pages usually cannot be fetched. Ask the user to paste the text.
- Insurance and APR figures are national-average estimates. Say so.

Tone: direct, friendly, plain words. Short paragraphs and lists. Never invent a price, mileage, URL or fact you did not get from a tool or the user. If a tool fails, say what you could not check.

${where} Today is ${new Date().toISOString().slice(0, 10)}.`;
  }

  // ---------------------------------------------------------------- tools
  const nullable = t => ({ anyOf: [{ type: t }, { type: "null" }] });
  const CREDIT = { type: "string", enum: ["super_prime", "prime", "nonprime", "subprime", "deep_subprime"], description: "Credit tier. prime is 661-780." };
  const TOOL_SPECS = [
    { name: "budget_search", description: "Turn a monthly payment into a maximum purchase price and list seed-table cars that fit, ranked by total monthly cost (payment + fuel + insurance estimate + typical repairs).",
      schema: { type: "object", required: ["monthly_payment"], properties: {
        monthly_payment: { type: "number", description: "Monthly loan payment the user can afford, USD." },
        down_payment: { type: "number" }, term_months: { type: "integer", description: "36, 48, 60 or 72." }, credit_tier: CREDIT,
        driver_age: { type: "integer" }, body_types: { type: "array", items: { type: "string", enum: ["sedan", "hatchback", "suv", "truck", "minivan", "wagon", "coupe"] } },
        min_reliability: { type: "number", description: "1 to 5." }, max_age_years: { type: "integer" }, limit: { type: "integer", description: "Max results, default 8." } } } },
    { name: "grade_listing", description: "Grade a specific listing: asking vs expected price for its seller type, verdict, suggested offer, red flags, prices of the same car at dealer / private / Facebook / auction, financing and total monthly cost.",
      schema: { type: "object", required: ["year", "make", "model", "price"], properties: {
        year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: { type: "string" }, price: { type: "number" }, mileage: { type: "integer" },
        seller_type: { type: "string", enum: ["dealer", "private", "online_retailer", "auction", "unknown"] },
        title_status: { type: "string", enum: ["clean", "rebuilt", "salvage", "lemon", "unknown"] },
        accident_reported: { type: "boolean" }, red_flags_in_text: { type: "array", items: { type: "string" } },
        down_payment: { type: "number" }, term_months: { type: "integer" }, credit_tier: CREDIT, driver_age: { type: "integer" } } } },
    { name: "finance_calc", description: "Monthly payment, total interest, and months owing more than the car is worth, for a price.",
      schema: { type: "object", required: ["price"], properties: { price: { type: "number" }, down_payment: { type: "number" }, term_months: { type: "integer" },
        credit_tier: CREDIT, apr_pct: { type: "number", description: "Exact APR if the user has a quote." }, depreciation_yearly_pct: { type: "number" } } } },
    { name: "seed_lookup", description: "Seed-table data for a model: prices by age, reliability, repair cost, insurance tier, mpg, known issues. Returns null if not in the table.",
      schema: { type: "object", required: ["make", "model"], properties: { make: { type: "string" }, model: { type: "string" } } } },
    { name: "vehicle_recalls", description: "NHTSA safety recalls for a model year. Free and authoritative.",
      schema: { type: "object", required: ["year", "make", "model"], properties: { year: { type: "integer" }, make: { type: "string" }, model: { type: "string" } } } },
    { name: "decode_vin", description: "Decode a 17-character VIN with the NHTSA database.",
      schema: { type: "object", required: ["vin"], properties: { vin: { type: "string" } } } },
    { name: "get_watchlist", description: "The user's saved searches and listings, plus the latest daily scan report (price changes, sold listings, new recalls, market research).",
      schema: { type: "object", properties: {} } },
  ];
  const STEP_LABELS = { budget_search: "Running the budget search", grade_listing: "Grading the listing", finance_calc: "Working out financing",
    seed_lookup: "Looking up the model", vehicle_recalls: "Checking NHTSA recalls", decode_vin: "Decoding the VIN", get_watchlist: "Reading your watchlist",
    web_search: "Searching the web", web_fetch: "Reading a web page" };

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
    return r.json();
  }
  async function runTool(name, input) {
    const CS = global.CarScout;
    switch (name) {
      case "budget_search": return CS.budgetSearch({ limit: 8, ...input });
      case "grade_listing": {
        const { down_payment = 0, term_months = 60, credit_tier = "prime", driver_age = 30, ...listing } = input;
        const g = CS.grade(listing, down_payment, term_months, credit_tier, driver_age);
        return g;
      }
      case "finance_calc": {
        const apr = input.apr_pct ?? CS.aprForTier(input.credit_tier || "prime");
        const { schedule, ...rest } = CS.loanSummary(input.price, input.down_payment || 0, apr, input.term_months || 60, input.depreciation_yearly_pct ?? 12);
        return rest;
      }
      case "seed_lookup": return CS.find(input.make, input.model);
      case "vehicle_recalls": {
        const q = new URLSearchParams({ make: input.make, model: input.model, modelYear: String(input.year) });
        const d = await getJSON(`https://api.nhtsa.gov/recalls/recallsByVehicle?${q}`);
        const items = (d.results || []).map(x => ({ campaign: x.NHTSACampaignNumber, date: x.ReportReceivedDate, component: x.Component, summary: x.Summary, remedy: x.Remedy }));
        return { year: input.year, make: input.make, model: input.model, count: items.length, recalls: items };
      }
      case "decode_vin": {
        const vin = String(input.vin || "").trim().toUpperCase();
        if (vin.length !== 17) return { error: "A VIN is 17 characters." };
        const d = await getJSON(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
        const row = (d.Results || [])[0] || {};
        const keep = ["Make", "Model", "ModelYear", "Trim", "BodyClass", "DriveType", "EngineCylinders", "DisplacementL", "FuelTypePrimary", "TransmissionStyle", "PlantCountry", "ErrorText"];
        return Object.fromEntries([["vin", vin], ...keep.filter(k => row[k]).map(k => [k, row[k]])]);
      }
      case "get_watchlist": {
        const report = await global.CarScoutStore.latestReport().catch(() => null);
        return { watchlist: global.CarScoutStore.get(), latest_report: report && { date: report.date, digest: report.digest, highlights: report.highlights,
          listings: report.listings, recalls: (report.recalls || []).filter(r => r.new && r.new.length), searches: report.searches } };
      }
      default: throw new Error(`Unknown tool ${name}`);
    }
  }
  async function runToolSafe(name, input) {
    try {
      let out = JSON.stringify(await runTool(name, input || {}));
      if (out === undefined) out = "null";
      if (out.length > MAX_TOOL_CHARS) out = out.slice(0, MAX_TOOL_CHARS) + "…(truncated)";
      return { ok: true, text: out };
    } catch (e) { return { ok: false, text: `Error: ${e.message || e}` }; }
  }

  // ---------------------------------------------------------------- errors
  function friendlyError(e) {
    const status = e && e.status;
    if (status === 401) return "The API key was rejected. Check it in Settings.";
    if (status === 403) return "This key is not allowed to use that model or feature.";
    if (status === 404) return "That model was not found for this key. Pick another model in Settings.";
    if (status === 429) return "Rate limited or out of credit. Wait a minute, or check billing on your account.";
    if (status && status >= 500) return "The AI service had an error. Try again shortly.";
    if (e && /fetch|network|Connection/i.test(String(e.message))) return "Could not reach the AI service. Check your connection.";
    return (e && e.message) || String(e);
  }

  // ---------------------------------------------------------------- Claude
  function claudeClient(s) { return new global.AISDK.Anthropic({ apiKey: s.anthropicKey, dangerouslyAllowBrowser: true }); }
  function usesFallback(model) { return FALLBACK_PREFIXES.some(p => model.startsWith(p)); }
  async function claudeCreate(client, params) {
    if (usesFallback(params.model)) return client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
    return client.beta.messages.create(params);
  }
  function claudeServerTools(model) {
    if (model.startsWith("claude-haiku")) return [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { type: "web_fetch_20250910", name: "web_fetch", max_uses: 4 }];
    return [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 }];
  }
  const claudeText = resp => resp.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();

  async function claudeTurn(state, s, userContent, onStep) {
    const client = claudeClient(s), model = s.anthropicModel;
    state.messages.push({ role: "user", content: userContent });
    const tools = [...TOOL_SPECS.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })), ...claudeServerTools(model)];
    const steps = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const resp = await claudeCreate(client, { model, max_tokens: 16000, cache_control: { type: "ephemeral" },
        system: systemPrompt(s), tools, messages: state.messages, output_config: { effort: "medium" } });
      if (resp.stop_reason === "refusal") { state.messages.pop(); return { text: "Claude declined to answer that. Try rephrasing.", steps }; }
      state.messages.push({ role: "assistant", content: resp.content });
      for (const b of resp.content) if (b.type === "server_tool_use") { steps.push(b.name); onStep(STEP_LABELS[b.name] || b.name); }
      if (resp.stop_reason === "pause_turn") { onStep("Still researching"); continue; }
      const uses = resp.content.filter(b => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) {
        const text = claudeText(resp);
        return { text: resp.stop_reason === "max_tokens" ? text + "\n\n(The answer was cut off. Ask me to continue.)" : text, steps };
      }
      const results = await Promise.all(uses.map(async u => {
        steps.push(u.name); onStep(STEP_LABELS[u.name] || u.name);
        const r = await runToolSafe(u.name, u.input);
        return { type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.ok ? {} : { is_error: true }) };
      }));
      state.messages.push({ role: "user", content: results });
    }
    return { text: "I hit my step limit for one answer. Ask a narrower question or say \"continue\".", steps };
  }

  // ---------------------------------------------------------------- OpenAI
  function openaiClient(s) { return new global.AISDK.OpenAI({ apiKey: s.openaiKey, dangerouslyAllowBrowser: true }); }
  async function openaiTurn(state, s, userContent, onStep) {
    const client = openaiClient(s), model = s.openaiModel;
    const tools = [...TOOL_SPECS.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.schema, strict: false })), { type: "web_search" }];
    let input = [{ role: "user", content: userContent }];
    const steps = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const resp = await client.responses.create({ model, instructions: systemPrompt(s), input, tools,
        ...(state.previousResponseId ? { previous_response_id: state.previousResponseId } : {}) });
      state.previousResponseId = resp.id;
      for (const o of resp.output || []) if (o.type === "web_search_call") { steps.push("web_search"); onStep(STEP_LABELS.web_search); }
      const calls = (resp.output || []).filter(o => o.type === "function_call");
      if (!calls.length) return { text: (resp.output_text || "").trim(), steps };
      input = await Promise.all(calls.map(async c => {
        steps.push(c.name); onStep(STEP_LABELS[c.name] || c.name);
        let args = {};
        try { args = JSON.parse(c.arguments || "{}"); } catch { return { type: "function_call_output", call_id: c.call_id, output: "Error: arguments were not valid JSON" }; }
        const r = await runToolSafe(c.name, args);
        return { type: "function_call_output", call_id: c.call_id, output: r.text };
      }));
    }
    return { text: "I hit my step limit for one answer. Ask a narrower question or say \"continue\".", steps };
  }

  // ---------------------------------------------------------------- chat session
  function newChat() { return { provider: null, model: null, messages: [], previousResponseId: null }; }
  async function chat(state, text, onStep = () => {}) {
    const s = loadSettings(), d = describe(s);
    if (!d) throw new Error("Add a Claude or OpenAI API key in Settings first.");
    if (state.provider !== d.provider || state.model !== d.model) Object.assign(state, newChat(), { provider: d.provider, model: d.model });
    const before = state.messages.length;
    try {
      return d.provider === "anthropic" ? await claudeTurn(state, s, text, onStep) : await openaiTurn(state, s, text, onStep);
    } catch (e) {
      state.messages.length = before; // keep history valid for the next try
      throw new Error(friendlyError(e));
    }
  }

  // ---------------------------------------------------------------- listing parser
  const LISTING_SCHEMA = { type: "object", additionalProperties: false,
    required: ["year", "make", "model", "trim", "price", "mileage", "seller_type", "title_status", "location", "vin", "accident_reported", "url", "red_flags_in_text"],
    properties: { year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: nullable("string"), price: { type: "number" },
      mileage: nullable("integer"), seller_type: { type: "string", enum: ["dealer", "private", "online_retailer", "auction", "unknown"] },
      title_status: { type: "string", enum: ["clean", "rebuilt", "salvage", "lemon", "unknown"] }, location: nullable("string"), vin: nullable("string"),
      accident_reported: nullable("boolean"), url: nullable("string"), red_flags_in_text: { type: "array", items: { type: "string" } } } };
  const PARSER_PROMPT = "Extract the structured fields of this used-car for-sale listing. Infer seller_type from context (dealer stock numbers, 'no haggle', or a dealership name mean dealer; 'clean title in hand' or 'my car' mean private; Facebook and Craigslist posts by individuals are private). Set title_status only if stated, else unknown. Put anything suspicious in red_flags_in_text: price far below typical, deposit before viewing, out of state, no test drives, 'title coming', mismatched photos, pressure to pay by gift card, wire or crypto, or a story about deployment or divorce. Use null when the listing does not say.";

  async function parseListing({ text = "", imageDataUrl = null, url = null }) {
    const s = loadSettings(), d = describe(s);
    if (!d) throw new Error("Add a Claude or OpenAI API key in Settings to parse listings.");
    const body = (url ? `Listing URL: ${url}\n\n` : "") + (text || "Extract the listing from the screenshot.");
    try {
      let raw;
      if (d.provider === "anthropic") {
        const content = [];
        if (imageDataUrl) { const [meta, data] = imageDataUrl.split(","); content.push({ type: "image", source: { type: "base64", media_type: meta.slice(5, meta.indexOf(";")), data } }); }
        content.push({ type: "text", text: body });
        const resp = await claudeCreate(claudeClient(s), { model: s.anthropicModel, max_tokens: 4000, system: PARSER_PROMPT, messages: [{ role: "user", content }],
          output_config: { effort: "low", format: { type: "json_schema", schema: LISTING_SCHEMA } } });
        if (resp.stop_reason === "refusal") throw new Error("The model declined to read this listing.");
        raw = claudeText(resp);
      } else {
        const content = [{ type: "input_text", text: body }];
        if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl, detail: "auto" });
        const resp = await openaiClient(s).responses.create({ model: s.openaiModel, instructions: PARSER_PROMPT, input: [{ role: "user", content }],
          text: { format: { type: "json_schema", name: "listing", schema: LISTING_SCHEMA, strict: true } } });
        raw = resp.output_text;
      }
      const listing = JSON.parse(raw);
      if (url && !listing.url) listing.url = url;
      return listing;
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error("The model returned something that was not a listing. Try pasting more of the text.");
      throw new Error(friendlyError(e));
    }
  }

  // ---------------------------------------------------------------- connection test
  async function testConnection(provider) {
    const s = loadSettings();
    try {
      if (provider === "anthropic") {
        if (!s.anthropicKey) throw new Error("No Claude key entered.");
        const r = await claudeCreate(claudeClient(s), { model: s.anthropicModel, max_tokens: 1000, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
        return `Connected to ${r.model}.`;
      }
      if (!s.openaiKey) throw new Error("No OpenAI key entered.");
      const r = await openaiClient(s).responses.create({ model: s.openaiModel, input: "Reply with the single word: ready" });
      return `Connected to ${r.model}.`;
    } catch (e) { throw new Error(friendlyError(e)); }
  }

  global.CarScoutAI = { MODELS, loadSettings, saveSettings, activeProvider, describe, newChat, chat, parseListing, testConnection, TOOL_SPECS, runTool };
})(typeof window !== "undefined" ? window : globalThis);
