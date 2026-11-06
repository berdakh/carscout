// End-to-end test of the static site with the real bundled SDKs. Every external API
// (Anthropic, OpenAI, NHTSA, GitHub) is intercepted, so no keys or network are needed.
// Usage: node tests/e2e/site.e2e.js http://127.0.0.1:PORT/
const { chromium } = require("playwright");
const assert = require("assert");
const BASE = process.argv[2];

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "content-type": "application/json" };
const json = (route, body, status = 200) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
const claudeMsg = (content, stop_reason) => ({ id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model: "claude-opus-5-5",
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
const oaResp = (id, output) => ({ id, object: "response", created_at: 1, status: "completed", model: "gpt-5.5", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const oaText = t => ({ type: "message", id: "m_" + Math.random().toString(36).slice(2), role: "assistant", status: "completed", content: [{ type: "output_text", text: t, annotations: [] }] });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });

  // ---------------- mocks
  const seen = { anthropic: [], openai: [], github: [], nhtsa: [] };
  let claudeScript = [], oaScript = [];
  await page.route("https://api.anthropic.com/**", async route => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.anthropic.push({ headers: await req.allHeaders(), body: JSON.parse(req.postData()) });
    const next = claudeScript.shift();
    return next && next.__status ? json(route, next.body, next.__status) : json(route, next);
  });
  await page.route("https://api.openai.com/**", async route => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.openai.push({ headers: await req.allHeaders(), body: JSON.parse(req.postData()) });
    return json(route, oaScript.shift());
  });
  await page.route("https://api.nhtsa.gov/**", route => { seen.nhtsa.push(route.request().url());
    return json(route, { Count: 1, results: [{ NHTSACampaignNumber: "19V123", Component: "FUEL SYSTEM", Summary: "Fuel pump may fail.", Remedy: "Replace pump.", ReportReceivedDate: "2019-02-01" }] }); });
  let ghFile = null;
  await page.route("https://api.github.com/**", async route => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.github.push({ method: req.method(), url: req.url(), headers: await req.allHeaders(), body: req.postData() && JSON.parse(req.postData()) });
    if (req.url().includes("/dispatches")) return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === "GET") return ghFile ? json(route, { sha: "abc", content: ghFile }) : json(route, { message: "Not Found" }, 404);
    ghFile = JSON.parse(req.postData()).content; return json(route, { content: { sha: "def" } }, 201);
  });
  const REPORT = { date: "2026-11-06", generated_at: "2026-11-06T12:30:00Z", provider: "anthropic", model: "claude-opus-5-5", location: "Austin, TX",
    digest: "**Act today:** the Camry dropped $600.", highlights: ["Price drop: 2018 Toyota Camry now $16,900 (-3.4%)."],
    listings: [{ id: "a", title: "2018 Toyota Camry", url: "https://dealer.example/camry", status: "price_drop", previous_price: 17500, current_price: 16900, change_pct: -3.4, notes: "", grade: { label: "Around market", suggested_offer: 15800 } },
      { id: "x", title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", status: "gone", previous_price: 9000, current_price: null, change_pct: null, notes: "" }],
    recalls: [{ key: "k", title: "2018 Toyota Camry", count: 3, campaigns: [], new: [{ campaign: "26V999", component: "AIR BAGS", summary: "Inflator may rupture." }] }],
    searches: [{ id: "s1", name: "Cheap and reliable", max_purchase_price: 14285, matches: 30, picks: [{ year: 2020, make: "Honda", model: "Fit" }],
      market: { cars: [{ year: 2020, make: "Honda", model: "Fit", price_low: 13000, price_high: 16000, typical_price: 14500, typical_change_pct: -2.1, trend: "falling",
        notable_listings: [{ title: "2020 Fit LX", url: "https://example.com/fit", price: 14200, mileage: 41000 }], notes: "Plenty of supply." }], sources: ["https://example.com/fit"] } }],
    errors: [], counts: { price_drops: 1, new_recalls: 1 } };
  await page.route(/\/reports\/index\.json/, r => json(r, { reports: [{ date: "2026-11-06", highlight: "x", counts: REPORT.counts }] }));
  await page.route(/\/reports\/2026-11-06\.json|\/reports\/latest\.json/, r => json(r, REPORT));

  // ---------------- boot, no key
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => /AI off/.test(document.querySelector("#status").textContent));
  assert.ok(await page.isDisabled("#paste-btn"), "paste disabled without key");
  assert.ok(await page.evaluate(() => typeof AISDK.Anthropic === "function" && typeof AISDK.OpenAI === "function"), "SDK bundle loaded");

  // ---------------- settings: Claude key
  await page.click("#open-settings");
  await page.check('input[name="provider"][value="anthropic"]');
  await page.fill('input[name="anthropicKey"]', "sk-ant-test-key");
  await page.fill('#settings-form input[name="location"]', "Austin, TX");
  await page.fill('input[name="githubRepo"]', "berdakh/carscout");
  await page.fill('input[name="githubToken"]', "github_pat_test");
  await page.click("#settings-form button.primary");
  await page.waitForFunction(() => /AI on · Claude · claude-opus-5-5/.test(document.querySelector("#status").textContent));
  console.log("ok settings");

  // ---------------- Claude chat: client tool, pause_turn, then answer
  claudeScript = [
    claudeMsg([{ type: "text", text: "Let me run the numbers." }, { type: "tool_use", id: "toolu_1", name: "budget_search", input: { monthly_payment: 300, down_payment: 1500 } },
      { type: "tool_use", id: "toolu_2", name: "vehicle_recalls", input: { year: 2019, make: "Honda", model: "Fit" } }], "tool_use"),
    claudeMsg([{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "2019 Honda Fit price Austin" } }], "pause_turn"),
    claudeMsg([{ type: "text", text: "**Top pick:** 2019 Honda Fit.\n\n- Cheap to run\n- One open recall" }], "end_turn"),
  ];
  await page.click('.tab[data-tab="chat"]');
  await page.fill("#chat-form textarea", "I can do $300 a month with $1,500 down");
  await page.click("#chat-form button");
  await page.waitForSelector(".msg.bot:not(.thinking) b");
  const reply = await page.textContent(".msg.bot:not(.thinking)");
  assert.ok(reply.includes("Top pick") && reply.includes("One open recall"), reply);
  assert.equal(seen.anthropic.length, 3);
  const [c1, c2, c3] = seen.anthropic;
  assert.equal(c1.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.ok(c1.headers["x-api-key"] === "sk-ant-test-key" || c1.headers.authorization === "Bearer sk-ant-test-key", "key sent");
  assert.ok((c1.headers["anthropic-beta"] || "").includes("server-side-fallback-2026-07-01"), "fallback beta header");
  assert.equal(c1.body.fallbacks, "default");
  assert.equal(c1.body.model, "claude-opus-5-5");
  assert.ok(c1.body.tools.some(t => t.type === "web_search_20260209") && c1.body.tools.some(t => t.name === "grade_listing"));
  assert.ok(c1.body.system.includes("Austin, TX"), "location in system prompt");
  const results = c2.body.messages.at(-1).content;
  assert.equal(results.length, 2, "both tool results in one user message");
  const budget = JSON.parse(results.find(r => r.tool_use_id === "toolu_1").content);
  assert.ok(budget.max_purchase_price > 10000 && budget.results.length > 0, "budget tool ran in browser");
  assert.ok(results.find(r => r.tool_use_id === "toolu_2").content.includes("19V123"), "NHTSA recall fetched");
  assert.equal(c3.body.messages.at(-1).role, "assistant", "pause_turn resumed with the paused assistant turn last");
  assert.ok((await page.textContent("#chat-tools")).includes("web_search"));
  console.log("ok claude chat");

  // follow-up keeps history
  claudeScript = [claudeMsg([{ type: "text", text: "Yes, offer $13,500." }], "end_turn")];
  await page.fill("#chat-form textarea", "Should I offer less?");
  await page.press("#chat-form textarea", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg.bot:not(.thinking)").length === 2);
  assert.equal(seen.anthropic.at(-1).body.messages.length, 6, "history carried into the next turn");

  // API error surfaces as a friendly message and history stays valid
  // the SDK retries 5xx/429 but not 401, so one scripted reply is enough
  claudeScript = [{ __status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }];
  await page.fill("#chat-form textarea", "hello?");
  await page.click("#chat-form button");
  await page.waitForSelector(".msg.bot.err");
  const errText = await page.textContent(".msg.bot.err"); assert.ok(errText.includes("API key was rejected"), errText);
  console.log("ok claude errors");

  // ---------------- listing parser (Claude structured output) + save to watchlist
  claudeScript = [claudeMsg([{ type: "text", text: JSON.stringify({ year: 2018, make: "Toyota", model: "Camry", trim: "SE", price: 16900, mileage: 70000, seller_type: "private",
    title_status: "clean", location: "Austin, TX", vin: null, accident_reported: null, url: null, red_flags_in_text: ["Asks for a deposit before viewing"] }) }], "end_turn")];
  await page.click('.tab[data-tab="grade"]');
  await page.fill('#paste-form textarea[name="text"]', "2018 Camry SE 70k miles $16,900, clean title. Deposit required to hold.");
  await page.fill('#paste-form input[name="url"]', "https://dealer.example/camry");
  await page.click("#paste-btn");
  await page.waitForSelector("#grade-result .verdict");
  const parseReq = seen.anthropic.at(-1).body;
  assert.equal(parseReq.output_config.format.type, "json_schema");
  assert.ok((await page.textContent("#grade-result")).includes("Asks for a deposit before viewing"));
  await page.click("#save-listing");
  await page.waitForFunction(() => document.querySelector("#watch-count").textContent === "1");
  console.log("ok listing parse + save");

  // ---------------- watchlist auto-sync to GitHub
  await page.waitForFunction(() => /Saved to GitHub/.test(document.querySelector("#sync-status").textContent), null, { timeout: 8000 }).catch(() => {});
  await page.click('.tab[data-tab="watch"]');
  await page.waitForFunction(() => /Saved to GitHub/.test(document.querySelector("#sync-status").textContent), null, { timeout: 8000 });
  const put = seen.github.find(g => g.method === "PUT");
  assert.ok(put && put.url.endsWith("/repos/berdakh/carscout/contents/docs/data/watchlist.json"));
  assert.equal(put.headers.authorization, "Bearer github_pat_test");
  const saved = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
  assert.equal(saved.listings[0].url, "https://dealer.example/camry");
  assert.equal(saved.listings[0].make, "Toyota");
  console.log("ok github sync");

  // ---------------- switch to OpenAI, analyze watchlist (function call -> answer)
  await page.click("#open-settings");
  await page.check('input[name="provider"][value="openai"]');
  await page.fill('input[name="openaiKey"]', "sk-openai-test");
  await page.click("#settings-form button.primary");
  await page.waitForFunction(() => /ChatGPT · gpt-5.5/.test(document.querySelector("#status").textContent));
  oaScript = [
    oaResp("resp_1", [{ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x" } },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_watchlist", arguments: "{}", status: "completed" }]),
    oaResp("resp_2", [oaText("Your Camry is the best deal. Watch the deposit request.")]),
  ];
  await page.click('.tab[data-tab="watch"]');
  await page.click("#analyze-btn");
  await page.waitForFunction(() => [...document.querySelectorAll(".msg.bot:not(.thinking)")].some(m => m.textContent.includes("best deal")));
  const [o1, o2] = seen.openai;
  assert.equal(o1.headers.authorization, "Bearer sk-openai-test");
  assert.ok(o1.body.tools.some(t => t.type === "web_search") && o1.body.tools.some(t => t.type === "function" && t.name === "get_watchlist"));
  assert.equal(o2.body.previous_response_id, "resp_1");
  const out = JSON.parse(o2.body.input[0].output);
  assert.equal(o2.body.input[0].type, "function_call_output");
  assert.equal(out.watchlist.listings[0].model, "Camry");
  assert.ok(out.latest_report && out.latest_report.date === "2026-11-06", "report passed to the model");
  console.log("ok openai analyze");

  // ---------------- daily report renders and escapes untrusted content
  page.on("dialog", d => { if (/^Remove the Claude/.test(d.message())) return d.accept(); errors.push("unexpected dialog: " + d.message()); return d.dismiss(); });
  await page.click('.tab[data-tab="report"]');
  await page.waitForSelector("#report-body .status-tag");
  const body = await page.textContent("#report-body");
  assert.ok(body.includes("Price drop") && body.includes("AIR BAGS") && body.includes("2020 Fit LX") && body.includes("Act today"));
  assert.equal(await page.$$eval('#report-body a[href^="javascript"]', a => a.length), 0, "no javascript: links");
  assert.equal(await page.$$eval("#report-body img", a => a.length), 0, "HTML in report is escaped");
  await page.click("#scan-now");
  await page.waitForFunction(() => /Scan started/.test(document.querySelector("#report-meta").textContent));
  assert.ok(seen.github.some(g => g.url.endsWith("/actions/workflows/daily-scan.yml/dispatches")));
  await page.screenshot({ path: process.argv[3] || "/dev/null", fullPage: true }).catch(() => {});
  console.log("ok report + run scan");

  // ---------------- clear keys
  await page.click("#open-settings");
  await page.click("#clear-keys");
  await page.waitForFunction(() => /AI off/.test(document.querySelector("#status").textContent));
  assert.ok(await page.evaluate(() => !JSON.parse(localStorage.getItem("carscout.settings")).anthropicKey));
  console.log("ok clear keys");

  assert.deepEqual(errors, [], "no page errors or unexpected dialogs");
  await browser.close();
  console.log("E2E PASSED");
})().catch(e => { console.error("E2E FAILED:", e); process.exit(1); });
