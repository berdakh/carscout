// CarScout engine: a faithful JavaScript port of app/services/{finance,seed,deal}.py
// so the static site on GitHub Pages gives the same numbers as the Python backend.
// Pure functions; data is injected via init().
(function (global) {
  const CURRENT_YEAR = new Date().getFullYear();
  let RATES = null, CARS = null, SETTINGS = { salesTaxPct: 7.0, docFees: 500, gasPrice: 3.40, milesPerYear: 12000 };

  function init(rates, seed, settings) { RATES = rates; CARS = seed.cars; Object.assign(SETTINGS, settings || {}); }
  const round2 = x => Math.round(x * 100) / 100;

  // ---------- finance ----------
  function aprForTier(tier) { const t = RATES.used_car_apr_by_credit_tier; return Number(t[tier] ?? t.prime); }
  function monthlyPayment(principal, aprPct, months) {
    if (months <= 0) throw new Error("months must be positive");
    if (principal <= 0) return 0;
    const r = aprPct / 100 / 12;
    return r === 0 ? principal / months : principal * r / (1 - Math.pow(1 + r, -months));
  }
  function maxLoanForPayment(payment, aprPct, months) {
    if (payment <= 0) return 0;
    const r = aprPct / 100 / 12;
    return r === 0 ? payment * months : payment * (1 - Math.pow(1 + r, -months)) / r;
  }
  function maxPurchasePrice(payment, down, aprPct, months, taxPct = SETTINGS.salesTaxPct, fees = SETTINGS.docFees) {
    const loan = maxLoanForPayment(payment, aprPct, months);
    return Math.max(0, (loan + down - fees) / (1 + taxPct / 100));
  }
  function amountFinanced(price, down, taxPct = SETTINGS.salesTaxPct, fees = SETTINGS.docFees) {
    return Math.max(0, price * (1 + taxPct / 100) + fees - down);
  }
  function depreciationCurve(price, months, yearlyPct) {
    const f = Math.pow(1 - yearlyPct / 100, 1 / 12);
    return Array.from({ length: months }, (_, i) => price * Math.pow(f, i + 1));
  }
  function loanSummary(price, down, aprPct, months, depYearlyPct = 12, taxPct, fees) {
    const financed = amountFinanced(price, down, taxPct, fees);
    const pay = monthlyPayment(financed, aprPct, months);
    const r = aprPct / 100 / 12;
    let balance = financed, totalInterest = 0, underwater = 0, worst = 0;
    const values = depreciationCurve(price, months, depYearlyPct), schedule = [];
    for (let m = 1; m <= months; m++) {
      const interest = balance * r, principal = Math.min(pay - interest, balance);
      balance = Math.max(0, balance - principal); totalInterest += interest;
      const equity = values[m - 1] - balance;
      if (equity < 0) { underwater++; worst = Math.min(worst, equity); }
      schedule.push({ month: m, payment: round2(pay), interest: round2(interest), principal: round2(principal), balance: round2(balance), est_value: round2(values[m - 1]), equity: round2(equity) });
    }
    return { price: round2(price), amount_financed: round2(financed), apr_pct: aprPct, months, monthly_payment: round2(pay),
      total_interest: round2(totalInterest), total_cost: round2(down + pay * months), months_underwater: underwater, worst_negative_equity: round2(worst), schedule };
  }
  function monthlyFuelCost(mpg, milesPerYear = SETTINGS.milesPerYear, gas = SETTINGS.gasPrice) { return mpg <= 0 ? 0 : milesPerYear / mpg * gas / 12; }
  function monthlyInsuranceEstimate(tier, driverAge = 30) {
    const base = RATES.insurance_monthly_by_tier[String(Math.trunc(tier))];
    let factor = 1.0;
    for (const b of RATES.insurance_driver_age_factor) if (b.min_age <= driverAge && driverAge <= b.max_age) { factor = b.factor; break; }
    return base * factor;
  }
  function totalMonthlyCost(payment, mpg, tier, annualRepair, driverAge = 30, milesPerYear) {
    const fuel = monthlyFuelCost(mpg, milesPerYear ?? SETTINGS.milesPerYear), ins = monthlyInsuranceEstimate(tier, driverAge), rep = annualRepair / 12;
    return { payment: round2(payment), fuel: round2(fuel), insurance: round2(ins), maintenance_repairs: round2(rep), total: round2(payment + fuel + ins + rep) };
  }

  // ---------- seed ----------
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  function find(make, model) {
    const m = norm(make), mo = norm(model);
    return CARS.find(c => norm(c.make) === m && norm(c.model) === mo)
      || CARS.find(c => norm(c.make) === m && (norm(c.model).startsWith(mo) || mo.startsWith(norm(c.model))))
      || CARS.find(c => norm(c.make) === m && (norm(c.model).includes(mo) || mo.includes(norm(c.model))))
      || null;
  }
  function priceAtAge(car, age) {
    const pts = Object.entries(car.price_by_age).map(([a, p]) => [Number(a), Number(p)]).sort((x, y) => x[0] - y[0]);
    if (!pts.length) return null;
    if (age <= pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) { const [a0, p0] = pts[i], [a1, p1] = pts[i + 1]; if (a0 <= age && age <= a1) return p0 + (p1 - p0) * (age - a0) / (a1 - a0); }
    const [aL, pL] = pts[pts.length - 1];
    return pL * Math.pow(1 - car.depreciation_yearly_pct / 100, age - aL);
  }
  function expectedRetailPrice(car, year, mileage = null, title = "clean") {
    const age = Math.max(0, CURRENT_YEAR - year), base = priceAtAge(car, age);
    const adj = RATES.mileage_adjustment, expectedMiles = adj.expected_miles_per_year * Math.max(age, 0.5);
    let mileagePct = 0;
    if (mileage != null) mileagePct = Math.max(-45, Math.min(25, (mileage - expectedMiles) / 10000 * adj.pct_per_10k_miles));
    const titleMult = RATES.title_multipliers[title] ?? 1.0;
    return { age_years: age, base_price_for_age: Math.round(base), expected_mileage: Math.round(expectedMiles),
      mileage_adjustment_pct: Math.round(mileagePct * 10) / 10, title_multiplier: titleMult, expected_retail: Math.round(base * (1 + mileagePct / 100) * titleMult) };
  }
  const CHANNEL_LABELS = {
    cpo_dealer: ["Certified pre-owned at a dealer", "Warranty included, inspected, highest price."],
    dealer_retail: ["Dealer retail", "Baseline. Negotiable, adds doc fees, may offer financing."],
    online_retailer: ["Carvana / CarMax / Vroom style", "No-haggle, 7-day return, delivery fee."],
    private_party: ["Private seller (Craigslist, Autotrader private)", "Cheapest clean-title route. No warranty, you handle title and payment safety."],
    facebook_marketplace: ["Facebook Marketplace", "Similar to private party, more scams. Meet at a bank or police station."],
    auction_hammer: ["Public or broker auction (Copart, IAAI, GovDeals)", "Sold as-is, often salvage. Buyer fee and broker fee added; no test drive."],
  };
  function channelPrices(retail) {
    const mult = RATES.channel_price_multipliers;
    return ["cpo_dealer", "dealer_retail", "online_retailer", "private_party", "facebook_marketplace", "auction_hammer"].map(key => {
      const price = retail * mult[key];
      const extra = key === "auction_hammer" ? price * RATES.auction_buyer_fee_pct / 100 + RATES.auction_broker_fee : 0;
      const [label, note] = CHANNEL_LABELS[key];
      return { channel: key, label, note, typical_price: Math.round(price), fees: Math.round(extra), all_in: Math.round(price + extra), vs_dealer_pct: Math.round((price + extra - retail) / retail * 1000) / 10 };
    });
  }
  function budgetSearch({ monthly_payment, down_payment = 0, term_months = 60, credit_tier = "prime", driver_age = 30, miles_per_year = null,
    body_types = null, min_reliability = 0, max_age_years = 12, limit = 15 }) {
    const apr = aprForTier(credit_tier), maxPrice = maxPurchasePrice(monthly_payment, down_payment, apr, term_months);
    const results = [];
    for (const car of CARS) {
      if (body_types && body_types.length && !body_types.map(b => b.toLowerCase()).includes(car.body)) continue;
      if (car.reliability < min_reliability) continue;
      const newest = Math.min(car.years[1], CURRENT_YEAR), oldest = Math.max(car.years[0], CURRENT_YEAR - max_age_years);
      let chosen = null;
      for (let y = newest; y >= oldest; y--) { const e = expectedRetailPrice(car, y); if (e.expected_retail <= maxPrice) { chosen = [y, e.expected_retail]; break; } }
      if (!chosen) continue;
      const [year, price] = chosen;
      const loan = loanSummary(price, down_payment, apr, term_months, car.depreciation_yearly_pct);
      const tco = totalMonthlyCost(loan.monthly_payment, car.mpg_combined, car.insurance_tier, car.annual_repair_cost, driver_age, miles_per_year ?? undefined);
      results.push({ id: car.id, make: car.make, model: car.model, body: car.body, segment: car.segment, suggested_year: year, age_years: CURRENT_YEAR - year,
        expected_retail: price, private_party_estimate: Math.round(price * RATES.channel_price_multipliers.private_party), reliability: car.reliability,
        mpg_combined: car.mpg_combined, monthly_payment: loan.monthly_payment, total_monthly_cost: tco.total, cost_breakdown: tco,
        months_underwater: loan.months_underwater, known_issues: car.known_issues, novice_notes: car.novice_notes });
    }
    results.sort((a, b) => a.total_monthly_cost - b.total_monthly_cost || b.reliability - a.reliability);
    return { inputs: { monthly_payment, down_payment, term_months, credit_tier, apr_pct: apr, driver_age }, max_purchase_price: Math.round(maxPrice), count: results.length, results: results.slice(0, limit) };
  }

  // ---------- deal ----------
  const CHANNEL_FOR_SELLER = { dealer: "dealer_retail", private: "private_party", online_retailer: "online_retailer", auction: "auction_hammer", unknown: "dealer_retail" };
  function grade(listing, down_payment = 0, term_months = 60, credit_tier = "prime", driver_age = 30) {
    const L = Object.assign({ seller_type: "unknown", title_status: "unknown", mileage: null, red_flags_in_text: [] }, listing);
    const car = find(L.make, L.model);
    if (!car) return { status: "unknown_model", message: `${L.make} ${L.model} is not in the seed table yet. The full app can research it live with the AI assistant; add it with scripts/build_seed.py.`, listing: L };
    const title = L.title_status !== "unknown" ? L.title_status : "clean";
    const exp = expectedRetailPrice(car, L.year, L.mileage, title);
    const channelKey = CHANNEL_FOR_SELLER[L.seller_type] || "dealer_retail";
    const expectedForChannel = exp.expected_retail * RATES.channel_price_multipliers[channelKey];
    const diffPct = (L.price - expectedForChannel) / expectedForChannel * 100;
    const flags = [];
    let verdict, label;
    if (diffPct <= -20) { verdict = "suspicious"; label = "Far below market. Verify it is real before you get excited."; flags.push({ level: "danger", text: "Price is more than 20% under market. Common scam pattern, or an undisclosed salvage title or mechanical problem." }); }
    else if (diffPct <= -10) { verdict = "great"; label = "Well below market"; }
    else if (diffPct <= -3) { verdict = "good"; label = "Below market"; }
    else if (diffPct <= 5) { verdict = "fair"; label = "Around market"; }
    else if (diffPct <= 12) { verdict = "high"; label = "Above market, negotiate"; }
    else { verdict = "overpriced"; label = "Well above market"; }
    const age = exp.age_years;
    if (L.mileage != null) {
      if (L.mileage > 150000) flags.push({ level: "warn", text: "Over 150k miles. Expect wear items (suspension, mounts, seals). Price should reflect it." });
      if (L.mileage > exp.expected_mileage * 1.5 && age >= 2) flags.push({ level: "warn", text: "Mileage is well above average for the age. Probably highway or fleet use; ask." });
      if (age >= 3 && L.mileage < exp.expected_mileage * 0.35) flags.push({ level: "info", text: "Unusually low miles. Check for long storage (dry seals, old tires) or odometer issues on the history report." });
    } else flags.push({ level: "warn", text: "No mileage given. Never evaluate a car without it." });
    if (["rebuilt", "salvage", "lemon"].includes(L.title_status)) flags.push({ level: "danger", text: `${L.title_status[0].toUpperCase() + L.title_status.slice(1)} title. Hard to insure fully, hard to resell, and the expected price already includes a steep discount.` });
    if (L.title_status === "unknown") flags.push({ level: "info", text: "Title status not stated. Ask for a photo of the title and run the VIN." });
    if (L.accident_reported) flags.push({ level: "warn", text: "Accident reported. Get the repair records and have a shop check frame and paint thickness." });
    if (["private", "unknown"].includes(L.seller_type) && !L.vin) flags.push({ level: "info", text: "No VIN in the listing. Ask for it before meeting; a seller who refuses is a red flag." });
    if (L.seller_type === "auction") flags.push({ level: "warn", text: "Auction purchase: no test drive, sold as-is, buyer fees of roughly 10% plus a broker fee for non-dealers." });
    if (age >= 12) flags.push({ level: "info", text: "12+ years old. Rubber, hoses, and electronics age regardless of miles. Budget a maintenance catch-up." });
    for (const i of car.known_issues) flags.push({ level: "model", text: i });
    for (const r of L.red_flags_in_text || []) flags.push({ level: "warn", text: r });
    let offer = Math.min(L.price, expectedForChannel * (L.seller_type !== "online_retailer" ? 0.93 : 1.0));
    offer = Math.round(offer / 100) * 100;
    const apr = aprForTier(credit_tier);
    const loan = loanSummary(L.price, down_payment, apr, term_months, car.depreciation_yearly_pct);
    const { schedule, ...financing } = loan;
    const tco = totalMonthlyCost(loan.monthly_payment, car.mpg_combined, car.insurance_tier, car.annual_repair_cost, driver_age);
    return { status: "ok", listing: L,
      car: { make: car.make, model: car.model, segment: car.segment, reliability: car.reliability, annual_repair_cost: car.annual_repair_cost, mpg_combined: car.mpg_combined, novice_notes: car.novice_notes },
      market: { ...exp, channel_assumed: channelKey, expected_price_for_channel: Math.round(expectedForChannel), asking_vs_expected_pct: Math.round(diffPct * 10) / 10 },
      verdict, verdict_label: label, suggested_offer: offer, flags, channels: channelPrices(exp.expected_retail), financing, monthly_cost: tco,
      disclaimer: "Estimates from a seed table of national averages and planning assumptions, not quotes. Local prices vary 5-10%." };
  }

  global.CarScout = { init, CURRENT_YEAR, aprForTier, monthlyPayment, maxLoanForPayment, maxPurchasePrice, loanSummary, monthlyInsuranceEstimate, totalMonthlyCost,
    find, priceAtAge, expectedRetailPrice, channelPrices, budgetSearch, grade, get cars() { return CARS; } };
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined") module.exports = globalThis.CarScout;
