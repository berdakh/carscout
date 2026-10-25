const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const money = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const pct = n => (n > 0 ? "+" : "") + n + "%";

// Tabs
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  $$(".panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
  try { localStorage.setItem("carscout.tab", t.dataset.tab); } catch {}
}));
try { const saved = localStorage.getItem("carscout.tab"); if (saved) $(`.tab[data-tab="${saved}"]`)?.click(); } catch {}

// Health
let aiEnabled = false;
fetch("/api/health").then(r => r.json()).then(h => {
  aiEnabled = h.ai_enabled;
  const s = $("#status");
  s.textContent = h.ai_enabled ? `AI on · ${h.model} · search: ${h.search_provider} · ${h.seed_models} models` : `AI off (set ANTHROPIC_API_KEY) · ${h.seed_models} seed models · calculators work`;
  s.className = "status " + (h.ai_enabled ? "on" : "off");
}).catch(() => { $("#status").textContent = "API unreachable"; });

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.multiple) { o[el.name] = [...el.selectedOptions].map(x => x.value); if (!o[el.name].length) delete o[el.name]; }
    else if (el.type === "number") { o[el.name] = el.value === "" ? null : Number(el.value); }
    else if (el.type !== "file") o[el.name] = el.value;
  }
  return o;
}

// Budget search
$("#budget-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("button", e.target); btn.disabled = true;
  try {
    const data = await postJSON("/api/budget", formData(e.target));
    const i = data.inputs;
    $("#budget-summary").classList.remove("hidden");
    $("#budget-summary").innerHTML = `
      <div class="grid3">
        <div><div class="muted small">Maximum purchase price</div><div class="big">${money(data.max_purchase_price)}</div>
          <div class="muted small">at ${i.apr_pct}% APR over ${i.term_months} months with ${money(i.down_payment)} down, incl. tax and fees</div></div>
        <div><div class="muted small">Cars that fit</div><div class="big">${data.count}</div><div class="muted small">from the seed table, newest year that fits</div></div>
        <div><div class="muted small">Ranked by</div><div><b>Total monthly cost</b></div><div class="muted small">payment + fuel + insurance estimate + typical repairs</div></div>
      </div>`;
    $("#budget-results").innerHTML = data.results.map(r => `
      <div class="card car">
        <div class="name">${r.suggested_year} ${r.make} ${r.model}</div>
        <div class="seg">${r.segment} · reliability ${r.reliability}/5 · ${r.mpg_combined} mpg</div>
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
        <div class="muted small">${r.novice_notes}</div>
        <div class="chips">${r.known_issues.map(k => `<span class="chip">${k}</span>`).join("")}</div>
        <button class="primary small" data-grade='${JSON.stringify({ year: r.suggested_year, make: r.make, model: r.model, price: r.expected_retail }).replace(/'/g, "&#39;")}'>Grade a listing for this car</button>
      </div>`).join("") || `<p class="muted">Nothing fits. Try a longer term, more down, or a lower reliability floor.</p>`;
    $$("[data-grade]").forEach(b => b.addEventListener("click", () => {
      const g = JSON.parse(b.dataset.grade); const f = $("#manual-form");
      f.year.value = g.year; f.make.value = g.make; f.model.value = g.model; f.price.value = g.price;
      $(`.tab[data-tab="grade"]`).click(); f.scrollIntoView({ behavior: "smooth" });
    }));
  } catch (err) { $("#budget-summary").classList.remove("hidden"); $("#budget-summary").innerHTML = `<span class="err">${err.message}</span>`; }
  finally { btn.disabled = false; }
});

// Grade: manual
$("#manual-form").addEventListener("submit", async e => {
  e.preventDefault();
  const d = formData(e.target);
  const listing = { year: d.year, make: d.make, model: d.model, trim: d.trim || null, price: d.price, mileage: d.mileage,
    seller_type: d.seller_type, title_status: d.title_status };
  try {
    renderGrade(await postJSON("/api/grade", { listing, down_payment: d.down_payment, term_months: d.term_months, credit_tier: d.credit_tier, driver_age: d.driver_age }));
  } catch (err) { $("#grade-result").innerHTML = `<p class="err">${err.message}</p>`; }
});

// Grade: paste / screenshot
$("#paste-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#paste-btn"); btn.disabled = true; btn.textContent = "Reading the listing…";
  try {
    const fd = new FormData(e.target);
    if (!fd.get("image")?.size) fd.delete("image");
    const r = await fetch("/api/listing/parse", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || r.statusText);
    renderGrade(data);
  } catch (err) { $("#grade-result").innerHTML = `<p class="err">${err.message}</p>`; }
  finally { btn.disabled = false; btn.textContent = "Parse and grade with AI"; }
});

function renderGrade(g) {
  const el = $("#grade-result");
  if (g.status === "unknown_model") { el.innerHTML = `<div class="card"><p>${g.message}</p></div>`; el.scrollIntoView({ behavior: "smooth" }); return; }
  const L = g.listing, m = g.market, f = g.financing, c = g.monthly_cost;
  el.innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center">
      <div><div class="muted small">${L.seller_type} · ${L.title_status} title · ${L.mileage ? L.mileage.toLocaleString() + " mi" : "mileage unknown"}</div>
        <h2 style="margin:0">${L.year} ${L.make} ${L.model} ${L.trim || ""} · asking ${money(L.price)}</h2></div>
      <span class="verdict v-${g.verdict}">${g.verdict_label}</span>
    </div>
    <div class="grid3" style="margin-top:12px">
      <div><div class="muted small">Expected for this channel</div><div class="big">${money(m.expected_price_for_channel)}</div><div class="muted small">asking is ${pct(m.asking_vs_expected_pct)} vs expected</div></div>
      <div><div class="muted small">Suggested opening offer</div><div class="big">${money(g.suggested_offer)}</div><div class="muted small">dealer baseline ${money(m.expected_retail)} · mileage adj ${pct(m.mileage_adjustment_pct)}</div></div>
      <div><div class="muted small">All-in monthly</div><div class="big">${money(c.total)}</div><div class="muted small">${money(f.monthly_payment)} loan at ${f.apr_pct}% · ${money(c.insurance)} ins · ${money(c.fuel)} fuel · ${money(c.maintenance_repairs)} repairs</div></div>
    </div>
    <p class="muted small" style="margin-top:8px">${g.car.novice_notes}</p>
  </div>
  <div class="two-col">
    <div class="card"><h2>Flags to check</h2>${g.flags.map(x => `<div class="flag ${x.level}">${x.text}</div>`).join("") || "<p class='muted'>None.</p>"}</div>
    <div class="card"><h2>Same car, other channels</h2>
      <table class="table"><tr><th>Where</th><th>Typical</th><th>All-in</th><th>vs dealer</th></tr>
      ${g.channels.map(ch => `<tr><td title="${ch.note}">${ch.label}</td><td>${money(ch.typical_price)}</td><td>${money(ch.all_in)}</td><td>${pct(ch.vs_dealer_pct)}</td></tr>`).join("")}</table>
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
  <p class="muted small">${g.disclaimer}</p>`;
  el.scrollIntoView({ behavior: "smooth" });
}

// Chat
const history = [];
function addMsg(role, text, cls = "") { const d = document.createElement("div"); d.className = `msg ${role} ${cls}`; d.textContent = text; $("#chat-log").appendChild(d); d.scrollIntoView(); return d; }
$("#chat-form").addEventListener("submit", async e => {
  e.preventDefault();
  const q = e.target.q.value.trim(); if (!q) return;
  e.target.q.value = "";
  addMsg("user", q);
  history.push({ role: "user", content: q });
  const thinking = addMsg("bot", "Researching…", "thinking");
  const btn = $("button", e.target); btn.disabled = true;
  try {
    const data = await postJSON("/api/chat", { messages: history });
    history.push(...data.new_messages);
    thinking.remove();
    addMsg("bot", data.text || "(no reply)");
    $("#chat-tools").textContent = data.tool_calls.length ? "Tools used: " + data.tool_calls.map(t => t.name).join(", ") : "";
  } catch (err) { thinking.remove(); addMsg("bot", "Error: " + err.message); history.pop(); }
  finally { btn.disabled = false; }
});
