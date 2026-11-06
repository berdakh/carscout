const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const money = n => n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString();
const pct = n => n == null ? "—" : (n > 0 ? "+" : "") + n + "%";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || "")) ? esc(u) : null;
const AI = window.CarScoutAI, Store = window.CarScoutStore;

// Minimal, escape-first Markdown for assistant replies.
function md(src) {
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`);
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(src).split("\n")) {
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join("");
}

// ---------------------------------------------------------------- tabs
function showTab(name) {
  $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.tab === name));
  $$(".panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  if (name !== "settings") { try { localStorage.setItem("carscout.tab", name); } catch {} }
  if (name === "report") loadReports();
  if (name === "watch") renderWatchlist();
  if (name === "settings") fillSettings();
}
$$(".tab").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("#open-settings").addEventListener("click", () => showTab("settings"));
document.addEventListener("click", e => { if (e.target.matches("[data-open-settings]")) { e.preventDefault(); showTab("settings"); } });

// ---------------------------------------------------------------- boot
let ready = false;
Promise.all([fetch("data/rates.json").then(r => r.json()), fetch("data/seed_cars.json").then(r => r.json())]).then(async ([rates, seed]) => {
  CarScout.init(rates, seed);
  ready = true;
  await Store.seedFromSite().catch(() => {});
  if (Store.syncEnabled()) Store.pull().catch(() => {});
  refreshAIState();
  updateWatchCount();
}).catch(e => { $("#status").textContent = "Could not load data: " + e.message; $("#status").className = "status off"; });

function refreshAIState() {
  const d = AI.describe();
  const s = $("#status");
  if (d) { s.textContent = `AI on · ${d.label} · ${d.model}`; s.className = "status on"; }
  else { s.textContent = `AI off · add a key in Settings · ${CarScout.cars?.length || 0} models`; s.className = "status off"; }
  $$("[data-ai-label]").forEach(el => el.textContent = d ? `(${d.label})` : "");
  $$(".needs-key").forEach(el => el.classList.toggle("hidden", !!d));
  $("#paste-btn").disabled = !d;
  $("#analyze-btn").disabled = !d;
}

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.type === "radio") continue;
    if (el.multiple) { o[el.name] = [...el.selectedOptions].map(x => x.value); if (!o[el.name].length) delete o[el.name]; }
    else if (el.type === "number") o[el.name] = el.value === "" ? null : Number(el.value);
    else if (el.type !== "file") o[el.name] = el.value;
  }
  return o;
}

// ---------------------------------------------------------------- budget
let lastBudgetParams = null;
$("#budget-form").addEventListener("submit", e => {
  e.preventDefault();
  if (!ready) return;
  try {
    lastBudgetParams = formData(e.target);
    const data = CarScout.budgetSearch(lastBudgetParams);
    const i = data.inputs;
    $("#budget-summary").classList.remove("hidden");
    $("#budget-summary").innerHTML = `
      <div class="grid3">
        <div><div class="muted small">Maximum purchase price</div><div class="big">${money(data.max_purchase_price)}</div>
          <div class="muted small">at ${i.apr_pct}% APR over ${i.term_months} months with ${money(i.down_payment)} down, incl. tax and fees</div></div>
        <div><div class="muted small">Cars that fit</div><div class="big">${data.count}</div><div class="muted small">from the seed table, newest year that fits</div></div>
        <div><div class="muted small">Ranked by</div><div><b>Total monthly cost</b></div><div class="muted small">payment + fuel + insurance estimate + typical repairs</div>
          <div class="btn-row" style="margin-top:8px"><button class="ghost small" id="save-search">☆ Save this search</button><button class="ghost small" id="ask-search" ${AI.describe() ? "" : "disabled"}>Ask AI about these</button></div></div>
      </div>`;
    $("#save-search").addEventListener("click", () => {
      const p = lastBudgetParams;
      const name = prompt("Name this search", `${money(p.monthly_payment)}/mo, ${money(p.down_payment)} down${p.body_types ? ", " + p.body_types.join("/") : ""}`);
      if (name === null) return;
      Store.addSearch(name, p, Store.get().settings.location);
      $("#save-search").textContent = "★ Saved"; $("#save-search").disabled = true;
    });
    $("#ask-search").addEventListener("click", () => {
      const top = data.results.slice(0, 5).map(r => `${r.suggested_year} ${r.make} ${r.model}`).join(", ");
      askInChat(`My budget: ${money(i.monthly_payment)} a month, ${money(i.down_payment)} down, ${i.term_months} months, ${i.credit_tier} credit, driver age ${i.driver_age}. The budget search suggested ${top}. Which two would you pick for me and why? Check recalls for your picks and look up what they actually sell for near me.`);
    });
    $("#budget-results").innerHTML = data.results.map(r => `
      <div class="card car">
        <div class="name">${r.suggested_year} ${esc(r.make)} ${esc(r.model)}</div>
        <div class="seg">${esc(r.segment)} · reliability ${r.reliability}/5 · ${r.mpg_combined} mpg</div>
        <div class="kv">
          <span>Expected dealer price</span><b>${money(r.expected_retail)}</b>
          <span>Private party estimate</span><b>${money(r.private_party_estimate)}</b>
          <span>Loan payment</span><b>${money(r.monthly_payment)}/mo</b>
          <span>Fuel</span><span>${money(r.cost_breakdown.fuel)}</span>
          <span>Insurance (est.)</span><span>${money(r.cost_breakdown.insurance)}</span>
          <span>Repairs (typical)</span><span>${money(r.cost_breakdown.maintenance_repairs)}</span>
          <span><b>All-in per month</b></span><b>${money(r.total_monthly_cost)}</b>
          <span>Months owing more than it's worth</span><span>${r.months_underwater}</span>
        </div>
        <div class="muted small">${esc(r.novice_notes)}</div>
        <div class="chips">${r.known_issues.map(k => `<span class="chip">${esc(k)}</span>`).join("")}</div>
        <button class="primary small" data-grade="${esc(JSON.stringify({ year: r.suggested_year, make: r.make, model: r.model, price: r.expected_retail }))}">Grade a listing for this car</button>
      </div>`).join("") || `<p class="muted">Nothing fits. Try a longer term, more down, or a lower reliability floor.</p>`;
    $$("[data-grade]").forEach(b => b.addEventListener("click", () => {
      const g = JSON.parse(b.dataset.grade); const f = $("#manual-form");
      f.year.value = g.year; f.make.value = g.make; f.model.value = g.model; f.price.value = g.price;
      showTab("grade"); f.scrollIntoView({ behavior: "smooth" });
    }));
  } catch (err) { $("#budget-summary").classList.remove("hidden"); $("#budget-summary").innerHTML = `<span class="err">${esc(err.message)}</span>`; }
});

// ---------------------------------------------------------------- grade
let lastGraded = null;
$("#manual-form").addEventListener("submit", e => {
  e.preventDefault();
  if (!ready) return;
  const d = formData(e.target);
  const listing = { year: d.year, make: d.make, model: d.model, trim: d.trim || null, price: d.price, mileage: d.mileage,
    seller_type: d.seller_type, title_status: d.title_status, url: d.url || null };
  try { renderGrade(CarScout.grade(listing, d.down_payment, d.term_months, d.credit_tier, d.driver_age)); }
  catch (err) { $("#grade-result").innerHTML = `<p class="err">${esc(err.message)}</p>`; }
});

const fileToDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
$("#paste-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = $("#paste-btn");
  const text = f.text.value.trim(), file = f.image.files[0], url = f.url.value.trim() || null;
  if (!text && !file) { $("#grade-result").innerHTML = `<p class="err">Paste the listing text or choose a screenshot.</p>`; return; }
  btn.disabled = true; btn.textContent = "Reading the listing…";
  try {
    const listing = await AI.parseListing({ text, imageDataUrl: file ? await fileToDataUrl(file) : null, url });
    const d = formData(f);
    renderGrade(CarScout.grade(listing, d.down_payment, d.term_months, d.credit_tier, d.driver_age));
  } catch (err) { $("#grade-result").innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  finally { btn.disabled = !AI.describe(); btn.textContent = "Parse and grade with AI"; }
});

function renderGrade(g) {
  const el = $("#grade-result");
  if (g.status === "unknown_model") {
    el.innerHTML = `<div class="card"><p>${esc(g.message)}</p>${AI.describe() ? `<button class="primary small" id="ask-unknown">Ask the AI to research it</button>` : ""}</div>`;
    $("#ask-unknown")?.addEventListener("click", () => { const L = g.listing; askInChat(`Is this a good deal? ${L.year} ${L.make} ${L.model}${L.trim ? " " + L.trim : ""}, ${L.mileage ? L.mileage + " miles, " : ""}asking ${money(L.price)} from a ${L.seller_type || "unknown"} seller.${L.url ? " Listing: " + L.url : ""} Research its market price and reliability.`); });
    el.scrollIntoView({ behavior: "smooth" }); return;
  }
  lastGraded = g.listing;
  const L = g.listing, m = g.market, f = g.financing, c = g.monthly_cost;
  el.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center">
      <div><div class="muted small">${esc(L.seller_type)} · ${esc(L.title_status)} title · ${L.mileage ? Number(L.mileage).toLocaleString() + " mi" : "mileage unknown"}${L.location ? " · " + esc(L.location) : ""}</div>
        <h2 style="margin:0">${L.year} ${esc(L.make)} ${esc(L.model)} ${esc(L.trim || "")} · asking ${money(L.price)}</h2></div>
      <span class="verdict v-${g.verdict}">${esc(g.verdict_label)}</span>
    </div>
    <div class="grid3" style="margin-top:12px">
      <div><div class="muted small">Expected for this channel</div><div class="big">${money(m.expected_price_for_channel)}</div><div class="muted small">asking is ${pct(m.asking_vs_expected_pct)} vs expected</div></div>
      <div><div class="muted small">Suggested opening offer</div><div class="big">${money(g.suggested_offer)}</div><div class="muted small">dealer baseline ${money(m.expected_retail)} · mileage adj ${pct(m.mileage_adjustment_pct)}</div></div>
      <div><div class="muted small">All-in monthly</div><div class="big">${money(c.total)}</div><div class="muted small">${money(f.monthly_payment)} loan at ${f.apr_pct}% · ${money(c.insurance)} ins · ${money(c.fuel)} fuel · ${money(c.maintenance_repairs)} repairs</div></div>
    </div>
    <p class="muted small" style="margin-top:8px">${esc(g.car.novice_notes)}</p>
    <div class="btn-row"><button class="ghost small" id="save-listing">☆ Save to watchlist</button>
      ${AI.describe() ? `<button class="ghost small" id="ask-listing">Ask AI for a second opinion</button>` : ""}
      ${L.url && !safeUrl(L.url) ? "" : L.url ? `<a class="small" href="${safeUrl(L.url)}" target="_blank" rel="noopener">Open listing ↗</a>` : `<span class="muted small">Add the listing URL so the daily scan can track price changes.</span>`}</div>
  </div>
  <div class="two-col">
    <div class="card"><h2>Flags to check</h2>${g.flags.map(x => `<div class="flag ${esc(x.level)}">${esc(x.text)}</div>`).join("") || "<p class='muted'>None.</p>"}</div>
    <div class="card"><h2>Same car, other channels</h2>
      <table class="table"><tr><th>Where</th><th>Typical</th><th>All-in</th><th>vs dealer</th></tr>
      ${g.channels.map(ch => `<tr><td title="${esc(ch.note)}">${esc(ch.label)}</td><td>${money(ch.typical_price)}</td><td>${money(ch.all_in)}</td><td>${pct(ch.vs_dealer_pct)}</td></tr>`).join("")}</table>
      <p class="muted small">Hover a row for what the channel means for you.</p>
      <h2 style="margin-top:14px">Financing at asking price</h2>
      <div class="kv">
        <span>Amount financed (tax + fees - down)</span><b>${money(f.amount_financed)}</b>
        <span>Payment</span><b>${money(f.monthly_payment)}/mo × ${f.months}</b>
        <span>Total interest</span><span>${money(f.total_interest)}</span>
        <span>Months owing more than the car is worth</span><span>${f.months_underwater}</span>
        <span>Worst negative equity</span><span>${money(f.worst_negative_equity)}</span>
      </div>
    </div>
  </div>
  <p class="muted small">${esc(g.disclaimer)}</p>`;
  $("#save-listing").addEventListener("click", () => {
    Store.addListing({ ...lastGraded, location: lastGraded.location || Store.get().settings.location || null });
    $("#save-listing").textContent = "★ Saved"; $("#save-listing").disabled = true;
  });
  $("#ask-listing")?.addEventListener("click", () => askInChat(`Second opinion on this listing: ${L.year} ${L.make} ${L.model}${L.trim ? " " + L.trim : ""}, ${L.mileage ? L.mileage + " miles, " : ""}${L.title_status} title, asking ${money(L.price)} from a ${L.seller_type} seller.${L.url ? " Listing: " + L.url : ""} The grader says "${g.verdict_label}" with an expected price of ${money(m.expected_price_for_channel)}. Check recalls, known problems for this year, and local asking prices, then tell me what to offer and what to inspect.`));
  el.scrollIntoView({ behavior: "smooth" });
}

// ---------------------------------------------------------------- chat
let chatState = AI.newChat(), chatBusy = false;
function addMsg(role, content, cls = "") {
  const d = document.createElement("div"); d.className = `msg ${role} ${cls}`;
  if (role === "bot" && !cls) d.innerHTML = md(content); else d.textContent = content;
  $("#chat-log").appendChild(d); d.scrollIntoView({ block: "nearest" }); return d;
}
async function sendChat(q) {
  if (chatBusy || !q) return;
  chatBusy = true; $("#chat-form button").disabled = true;
  addMsg("user", q);
  const thinking = addMsg("bot", "Thinking…", "thinking");
  try {
    const res = await AI.chat(chatState, q, step => { thinking.textContent = step + "…"; });
    thinking.remove();
    addMsg("bot", res.text || "(no reply)");
    const uniq = [...new Set(res.steps)];
    $("#chat-tools").textContent = uniq.length ? "Used: " + uniq.join(", ") : "";
  } catch (err) { thinking.remove(); addMsg("bot", "Error: " + err.message, "err"); }
  finally { chatBusy = false; $("#chat-form button").disabled = false; }
}
function askInChat(q) { showTab("chat"); sendChat(q); }
$("#chat-form").addEventListener("submit", e => { e.preventDefault(); const q = e.target.q.value.trim(); e.target.q.value = ""; sendChat(q); });
$("#chat-form textarea").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
$("#chat-reset").addEventListener("click", () => { chatState = AI.newChat(); $("#chat-log").innerHTML = ""; $("#chat-tools").textContent = ""; });

// ---------------------------------------------------------------- watchlist
function updateWatchCount() { const w = Store.get(); const n = w.searches.length + w.listings.length; $("#watch-count").textContent = n || ""; }
function renderWatchlist() {
  const w = Store.get();
  $("#watch-location").value = w.settings.location || AI.loadSettings().location || "";
  $("#watch-searches").innerHTML = w.searches.map(s => {
    const p = s.params || {};
    return `<div class="item"><div><div class="t">${esc(s.name)}</div><div class="muted small">${money(p.monthly_payment)}/mo · ${money(p.down_payment)} down · ${p.term_months || 60} mo · ${esc(p.credit_tier || "prime")}${p.body_types ? " · " + esc(p.body_types.join(", ")) : ""}${s.location ? " · " + esc(s.location) : ""}</div></div>
      <div class="btn-row"><button class="ghost small" data-run-search="${esc(s.id)}">Run</button><button class="ghost small" data-del="searches:${esc(s.id)}">Remove</button></div></div>`;
  }).join("") || `<p class="muted">No saved searches yet.</p>`;
  $("#watch-listings").innerHTML = w.listings.map(x => {
    const g = ready && x.year && x.make && x.model && x.price ? CarScout.grade(x) : null;
    const url = safeUrl(x.url);
    return `<div class="item"><div><div class="t">${x.year || ""} ${esc(x.make)} ${esc(x.model)} ${esc(x.trim || "")} · ${money(x.price)}</div>
      <div class="muted small">${x.mileage ? Number(x.mileage).toLocaleString() + " mi · " : ""}${esc(x.seller_type || "")}${g && g.status === "ok" ? ` · <b>${esc(g.verdict_label)}</b> (${pct(g.market.asking_vs_expected_pct)})` : ""}
      ${url ? ` · <a href="${url}" target="_blank" rel="noopener">listing ↗</a>` : " · no URL, scan can't track price"}</div></div>
      <div class="btn-row"><button class="ghost small" data-del="listings:${esc(x.id)}">Remove</button></div></div>`;
  }).join("") || `<p class="muted">No saved listings yet.</p>`;
  $$("[data-del]").forEach(b => b.addEventListener("click", () => { const [k, id] = b.dataset.del.split(":"); Store.remove(k, id); }));
  $$("[data-run-search]").forEach(b => b.addEventListener("click", () => {
    const s = Store.get().searches.find(x => x.id === b.dataset.runSearch); if (!s) return;
    const f = $("#budget-form"), p = s.params || {};
    for (const el of f.elements) {
      if (!el.name || !(el.name in p)) continue;
      if (el.multiple) [...el.options].forEach(o => o.selected = (p[el.name] || []).includes(o.value)); else el.value = p[el.name];
    }
    showTab("budget"); f.requestSubmit();
  }));
  const sync = Store.syncEnabled();
  $("#sync-btn").disabled = !sync; $("#pull-btn").disabled = !sync;
  if (!sync) $("#sync-status").textContent = "Saved in this browser. To let the daily scan see it, add a GitHub token in Settings, or download the JSON and commit it to docs/data/watchlist.json.";
}
let pushTimer = null;
Store.onChange(() => {
  updateWatchCount();
  if ($("#tab-watch").classList.contains("active")) renderWatchlist();
  if (Store.syncEnabled()) { clearTimeout(pushTimer); pushTimer = setTimeout(pushWatchlist, 1500); }
});
async function pushWatchlist() {
  $("#sync-status").textContent = "Saving to GitHub…";
  try { await Store.push(); $("#sync-status").textContent = `Saved to GitHub at ${new Date().toLocaleTimeString()}. The next daily scan will use it.`; }
  catch (e) { $("#sync-status").textContent = e.message; }
}
$("#sync-btn").addEventListener("click", pushWatchlist);
$("#pull-btn").addEventListener("click", async () => {
  $("#sync-status").textContent = "Loading from GitHub…";
  try { await Store.pull(); renderWatchlist(); $("#sync-status").textContent = "Loaded the watchlist saved in GitHub."; }
  catch (e) { $("#sync-status").textContent = e.message; }
});
$("#download-btn").addEventListener("click", () => Store.download());
$("#watch-location").addEventListener("change", e => {
  const loc = e.target.value.trim(); Store.setLocation(loc);
  const s = AI.loadSettings(); s.location = loc; AI.saveSettings(s);
});
$("#analyze-btn").addEventListener("click", () => {
  const w = Store.get();
  if (!w.searches.length && !w.listings.length) { $("#sync-status").textContent = "Save a search or a listing first."; return; }
  askInChat("Analyze my watchlist. Call get_watchlist, then rank my saved listings from best to worst deal with a one-line reason each, say which saved search gives me the best value, flag any recalls or red flags, and tell me the single next step I should take this week.");
});

// ---------------------------------------------------------------- report
let reportIndex = null;
async function loadReports() {
  const sel = $("#report-date");
  reportIndex = await Store.reportIndex();
  const dates = (reportIndex && reportIndex.reports) || [];
  if (!dates.length) {
    sel.innerHTML = ""; sel.classList.add("hidden");
    $("#report-meta").textContent = "";
    $("#report-body").innerHTML = `<div class="card"><p>No scans yet. The daily scan runs on GitHub Actions every day at 12:23 UTC, using the watchlist saved in the repository.</p>
      <p class="muted">To start: save a search or listing, save the watchlist to GitHub from the Watchlist tab, then press <b>Run scan now</b> or wait for the next run. Reports appear here a few minutes after the scan finishes.</p></div>`;
    return;
  }
  sel.classList.remove("hidden");
  const current = sel.value;
  sel.innerHTML = dates.map(d => `<option value="${esc(d.date)}">${esc(d.date)}${d.counts && (d.counts.price_drops || d.counts.new_recalls) ? " •" : ""}</option>`).join("");
  if (current && dates.some(d => d.date === current)) sel.value = current;
  renderReport(await Store.report(sel.value));
}
$("#report-date").addEventListener("change", async e => renderReport(await Store.report(e.target.value)));
$("#scan-now").addEventListener("click", async () => {
  try { const link = await Store.runScanNow(); $("#report-meta").innerHTML = `Scan started. It usually takes a few minutes, then the site updates. <a href="${esc(link)}" target="_blank" rel="noopener">Watch it run ↗</a>`; }
  catch (e) { $("#report-meta").textContent = e.message; }
});

const STATUS_TEXT = { price_drop: "Price drop", price_up: "Price up", unchanged: "No change", gone: "No longer listed", blocked: "Site blocks checks",
  unreachable: "Could not load", page_ok: "Page loads", price_unknown: "Price not found", not_tracked: "No URL" };
function renderReport(r) {
  if (!r) { $("#report-body").innerHTML = `<div class="card"><p class="err">Could not load that report.</p></div>`; return; }
  $("#report-meta").textContent = `Generated ${new Date(r.generated_at).toLocaleString()}${r.provider ? ` with ${r.provider === "anthropic" ? "Claude" : "ChatGPT"} (${r.model})` : " without AI (free checks only)"}${r.location ? " · " + r.location : ""}.`;
  const listings = (r.listings || []).map(x => `<tr><td>${safeUrl(x.url) ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</td>
      <td><span class="status-tag s-${esc(x.status)}">${esc(STATUS_TEXT[x.status] || x.status)}</span></td>
      <td>${money(x.current_price ?? x.previous_price)}</td><td>${x.change_pct != null ? pct(x.change_pct) : ""}</td>
      <td>${x.grade ? `${esc(x.grade.label)}<div class="muted small">offer ${money(x.grade.suggested_offer)}</div>` : ""}</td></tr>
      ${x.notes ? `<tr><td colspan="5" class="muted small">${esc(x.notes)}</td></tr>` : ""}`).join("");
  const recalls = (r.recalls || []).map(x => `<div class="flag ${x.new && x.new.length ? "danger" : x.error ? "warn" : "info"}"><b>${esc(x.title)}</b>: ${x.error ? "could not check (" + esc(x.error) + ")" : `${x.count} recall${x.count === 1 ? "" : "s"} on file`}${x.baseline ? " (first check, baseline saved)" : ""}
      ${(x.new || []).map(n => `<div>New: ${esc(n.component || n.campaign)} · ${esc((n.summary || "").slice(0, 220))}</div>`).join("")}</div>`).join("");
  const searches = (r.searches || []).map(s => `<div class="card"><h2>${esc(s.name)}</h2>
      <p class="muted small">Max price ${money(s.max_purchase_price)} · ${s.matches} cars fit · top picks: ${s.picks.map(p => `${p.year} ${esc(p.make)} ${esc(p.model)}`).join(", ") || "none"}</p>
      ${s.notes ? `<p class="muted small">${esc(s.notes)}</p>` : ""}
      ${s.market ? `<div class="results">${s.market.cars.map(c => `<div class="car"><div class="name">${c.year} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="kv"><span>Local range</span><b>${c.price_low ? money(c.price_low) + " – " + money(c.price_high) : "not found"}</b>
          <span>Typical</span><span>${money(c.typical_price)} ${c.typical_change_pct != null ? `(${pct(c.typical_change_pct)} vs last scan)` : ""}</span>
          <span>Trend</span><span>${esc(c.trend)}</span></div>
          ${c.notable_listings.length ? `<ul class="small">${c.notable_listings.map(n => `<li><a href="${safeUrl(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> · ${money(n.price)}${n.mileage ? " · " + Number(n.mileage).toLocaleString() + " mi" : ""}</li>`).join("")}</ul>` : ""}
          <div class="muted small">${esc(c.notes)}</div></div>`).join("")}</div>
        ${s.market.sources.length ? `<p class="muted small">Sources: ${s.market.sources.map(u => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`).join(", ")}</p>` : ""}` : ""}</div>`).join("");
  $("#report-body").innerHTML = `
    <div class="card"><h2>Today</h2>${r.digest ? `<div class="msg bot" style="max-width:none">${md(r.digest)}</div>` : ""}
      <ul>${(r.highlights || []).map(h => `<li>${esc(h)}</li>`).join("")}</ul></div>
    ${listings ? `<div class="card"><h2>Saved listings</h2><table class="table"><tr><th>Car</th><th>Status</th><th>Price</th><th>Change</th><th>Grade</th></tr>${listings}</table></div>` : ""}
    ${recalls ? `<div class="card"><h2>Recalls</h2>${recalls}</div>` : ""}
    ${searches}
    ${(r.errors || []).length ? `<div class="card"><h2>Problems during the scan</h2>${r.errors.map(e => `<div class="flag warn">${esc(e.where)}: ${esc(e.error)}</div>`).join("")}</div>` : ""}`;
}

// ---------------------------------------------------------------- settings
function fillSettings() {
  const s = AI.loadSettings(), f = $("#settings-form");
  $$('input[name="provider"]', f).forEach(r => r.checked = r.value === s.provider);
  f.anthropicModel.innerHTML = AI.MODELS.anthropic.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  $("#openai-models").innerHTML = AI.MODELS.openai.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  for (const k of ["anthropicKey", "openaiKey", "anthropicModel", "openaiModel", "location", "githubRepo", "githubToken"]) f[k].value = s[k] || "";
  $("#settings-saved").textContent = "";
}
function readSettings() {
  const f = $("#settings-form"), s = AI.loadSettings();
  s.provider = ($('input[name="provider"]:checked', f) || {}).value || "anthropic";
  for (const k of ["anthropicKey", "openaiKey", "anthropicModel", "openaiModel", "location", "githubRepo", "githubToken"]) s[k] = f[k].value.trim();
  s.openaiModel ||= "gpt-5.5";
  return s;
}
$("#settings-form").addEventListener("submit", e => {
  e.preventDefault();
  const s = readSettings(); AI.saveSettings(s);
  if (s.location !== (Store.get().settings.location || "")) Store.setLocation(s.location);
  refreshAIState(); renderWatchlist();
  $("#settings-saved").textContent = "Saved.";
});
$$("[data-test]").forEach(b => b.addEventListener("click", async () => {
  const out = $(`[data-test-out="${b.dataset.test}"]`);
  AI.saveSettings(readSettings()); refreshAIState();
  out.textContent = "Testing…";
  try { out.textContent = await AI.testConnection(b.dataset.test); } catch (e) { out.textContent = e.message; }
}));
$("#clear-keys").addEventListener("click", () => {
  if (!confirm("Remove the Claude, OpenAI and GitHub keys from this browser?")) return;
  const s = AI.loadSettings(); s.anthropicKey = s.openaiKey = s.githubToken = ""; AI.saveSettings(s);
  fillSettings(); refreshAIState(); $("#settings-saved").textContent = "Keys removed.";
});
$("#close-settings").addEventListener("click", () => { let t = "budget"; try { t = localStorage.getItem("carscout.tab") || t; } catch {} showTab(t); });

// Restore the last tab once everything above is defined.
try { const saved = localStorage.getItem("carscout.tab"); if (saved && $(`.tab[data-tab="${saved}"]`)) showTab(saved); } catch {}
