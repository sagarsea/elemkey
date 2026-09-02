(() => {
  "use strict";

  const storage = { quote: "elemkey.offerQuote", preview: "elemkey.basketPreview", basket: "elemkey.basket", trace: "elemkey.trace" };
  const parse = (value, fallback) => { try { return JSON.parse(value || "") ?? fallback; } catch { return fallback; } };
  const storedLines = parse(sessionStorage.getItem(storage.basket), []).filter((line) => line && typeof line.product_id === "string" && line.quantity === 1 && (line.offer_quote === undefined || typeof line.offer_quote === "string"));
  const commerceState = {
    query: "", product: null, products: [], offer: null, offerToken: sessionStorage.getItem(storage.quote), offers: new Map(), offerTimers: new Map(),
    basketLines: storedLines.slice(0, 16), verifiedLines: new Map(), latest: { product: 0, offer: 0, basket: 0, policy: 0 }
  };
  window.commerceState = commerceState;

  const requestToken = () => document.querySelector('meta[name="request-token"]')?.content || "";
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const region = (name) => document.querySelector(`[data-region="${name}"]`);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const envelope = (status, data, ui_region) => ({ status, observed_at: new Date().toISOString(), data, error: null, ui_region });
  const persistBasket = () => {
    sessionStorage.setItem(storage.basket, JSON.stringify(commerceState.basketLines));
    if (commerceState.basketLines.length) sessionStorage.setItem(storage.preview, JSON.stringify(commerceState.basketLines[0]));
    else sessionStorage.removeItem(storage.preview);
    document.querySelectorAll("[data-basket-count]").forEach((target) => { target.textContent = String(commerceState.basketLines.length); });
  };
  const clearProtectedState = () => {
    commerceState.offer = null;
    commerceState.offerToken = null;
    commerceState.offers.clear();
    for (const timer of commerceState.offerTimers.values()) clearTimeout(timer);
    commerceState.offerTimers.clear();
    commerceState.basketLines = commerceState.basketLines.filter((line) => !line.offer_quote);
    for (const [id, value] of commerceState.verifiedLines) if (value.request.offer_quote) commerceState.verifiedLines.delete(id);
    sessionStorage.removeItem(storage.quote);
    persistBasket();
  };
  const trace = (callName, status, started, uiRegion) => {
    const entries = parse(sessionStorage.getItem(storage.trace), []);
    entries.unshift({ call_name: callName, status, at: new Date().toISOString(), duration_ms: Math.max(0, Math.round(performance.now() - started)), ui_region: uiRegion });
    sessionStorage.setItem(storage.trace, JSON.stringify(entries.slice(0, 12)));
    const target = region("trace");
    if (target) target.replaceChildren(...entries.slice(0, 5).map((entry) => node("li", `${entry.call_name} · ${entry.status} · ${entry.duration_ms} ms`)));
  };
  const invoke = async (callName, uiRegion, url, init = {}, sequenceKey = uiRegion) => {
    const sequence = (commerceState.latest[sequenceKey] || 0) + 1;
    commerceState.latest[sequenceKey] = sequence;
    const started = performance.now();
    try {
      const response = await fetch(url, { credentials: "same-origin", ...init });
      const result = await response.json();
      if (sequence !== commerceState.latest[sequenceKey]) return null;
      trace(callName, typeof result.status === "string" ? result.status : "unknown_response", started, uiRegion);
      return result;
    } catch {
      if (sequence !== commerceState.latest[sequenceKey]) return null;
      trace(callName, "service_unavailable", started, uiRegion);
      return { status: "service_unavailable", observed_at: new Date().toISOString(), data: null, error: { code: "NETWORK_UNAVAILABLE", message: "The request could not be completed.", retryable: true }, ui_region: uiRegion };
    }
  };
  const feedback = (text) => { const target = region("tool-feedback"); if (target) target.textContent = text; };

  function productCard(product) {
    const card = node("article", undefined, "catalogue-card");
    card.dataset.productId = product.id;
    const link = node("a");
    link.href = product.product_url;
    if (product.image_url) {
      const image = node("img");
      image.src = product.image_url;
      image.alt = product.image_alt;
      image.width = 640;
      image.height = 480;
      link.append(image);
    }
    link.append(node("p", `${product.category} · ${product.sku}`, "eyebrow"), node("h2", product.title));
    const foot = node("div", undefined, "card-foot");
    const inStock = product.stock_status ? product.stock_status === "in_stock" : product.stock_quantity > 0;
    foot.append(node("strong", money(product.delivered_total_pence ?? product.unit_price_pence)), node("span", inStock ? "In stock" : "Out of stock", inStock ? "available" : "unavailable"));
    card.append(link, node("p", product.match_reason || product.description), foot);
    return card;
  }

  function renderProducts(result, target = region("product")) {
    if (!target || !["ok", "empty"].includes(result.status)) return;
    commerceState.products = result.data?.products || [];
    commerceState.product = commerceState.products[0] || null;
    if (result.status === "empty") {
      target.replaceChildren(node("div", `No product matched “${result.data?.query || ""}”. Clear or edit your search.`, "notice"));
      return;
    }
    const grid = node("div", undefined, "product-grid");
    grid.dataset.productGrid = "";
    grid.append(...commerceState.products.map(productCard));
    target.replaceChildren(grid);
  }

  function renderHeaderResults(result) {
    const target = region("search-results");
    if (!target) return;
    target.hidden = false;
    if (result.status === "ok") {
      const list = node("div", undefined, "search-results");
      for (const product of result.data.products.slice(0, 5)) {
        const link = node("a", `${product.title} · ${money(product.unit_price_pence)}`);
        link.href = product.product_url;
        list.append(link);
      }
      target.replaceChildren(list);
    } else if (result.status === "empty") target.replaceChildren(node("p", `No product matched “${result.data?.query || ""}”.`, "notice"));
  }

  async function searchProducts(input) {
    commerceState.query = typeof input?.query === "string" ? input.query : "";
    const result = await invoke("search_products", "product", `/api/products/search?${filterQuery(input)}`);
    if (!result) return null;
    if (result.status === "ok" && document.body.dataset.signedIn !== "true") result.data.member_offer_prompt = "You may qualify for a special offer. Sign in to reveal your personal offer.";
    if (["ok", "empty"].includes(result.status)) document.body.dataset.page === "shop" ? renderProducts(result) : renderHeaderResults(result);
    const message = document.querySelector("[data-search-message]");
    if (message) message.textContent = result.status === "invalid_input" ? result.error?.message || "Correct the search." : result.status === "service_unavailable" ? "Search is temporarily unavailable; the last result remains visible." : "";
    return result;
  }

  function filterQuery(input = {}) {
    const params = new URLSearchParams();
    for (const key of ["query", "category", "max_price_pence", "max_delivered_price_pence", "connection", "sort", "limit"]) if (input[key] !== undefined && input[key] !== "") params.set(key, String(input[key]));
    for (const feature of input.features || []) params.append("features", feature);
    if (input.in_stock_only !== undefined) params.set("in_stock_only", String(input.in_stock_only));
    if (!params.size) params.set("sort", "relevance");
    return params;
  }
  async function filterProducts(input = {}) {
    const form = document.querySelector("#catalogue-filters");
    if (form) for (const [key, value] of Object.entries(input)) {
      const control = form.elements.namedItem(key);
      if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = Boolean(value);
      else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.value = String(value);
    }
    const result = await invoke("filter_products", "product", `/api/products/search?${filterQuery(input)}`);
    if (result && ["ok", "empty"].includes(result.status)) renderProducts(result);
    const message = document.querySelector("[data-search-message]");
    if (message && result) message.textContent = result.status === "ok" ? `${result.data.products.length} products shown.` : result.status === "empty" ? "No products match these filters." : result.error?.message || "";
    return result;
  }

  async function getProductDetails() {
    const id = document.querySelector("[data-region=product][data-product-id]")?.dataset.productId;
    if (!id) return envelope("invalid_input", null, "product");
    const result = await invoke("get_product_details", "product", `/api/products/${encodeURIComponent(id)}`);
    if (result?.status === "ok") feedback(`${result.data.product.title} details verified.`);
    return result;
  }
  function renderComparison(result) {
    const target = region("recommendations");
    if (!target || result.status !== "ok") return;
    const table = node("table", undefined, "comparison");
    const head = node("tr");
    for (const label of ["Product", "Delivered", "Stock", "Connection", "Weight", "Battery", "Noise control", "Warranty", "Member offer"]) head.append(node("th", label));
    const thead = node("thead"); thead.append(head); table.append(thead);
    const body = node("tbody");
    for (const product of result.data.products) {
      const row = node("tr");
      for (const value of [product.title, money(product.delivered_price_pence), product.stock_status.replaceAll("_", " "), product.connection, product.weight_grams ? `${product.weight_grams} g` : "Not provided", product.battery, product.noise_control, product.warranty, product.member_offer_status.replaceAll("_", " ")]) row.append(node("td", value));
      body.append(row);
    }
    table.append(body);
    target.hidden = false;
    target.replaceChildren(node("p", "Northmere comparison", "eyebrow"), node("h2", "Compared by delivered price"), table, node("p", "Read-only comparison. Your basket is unchanged and no purchase has been created.", "notice"));
  }
  async function compareProducts(input) {
    const result = await invoke("compare_products", "product", "/api/products/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (result) renderComparison(result);
    return result;
  }
  async function viewProduct(input) {
    const result = await invoke("view_product", "product", `/api/products/${encodeURIComponent(input?.product_id || "")}`);
    if (result?.status === "ok") {
      feedback(`Opening ${result.data.product.title}.`);
      setTimeout(() => location.assign(result.data.product.product_url), 0);
      return { ...result, status: "navigating" };
    }
    return result;
  }
  async function getStorePolicies(input) {
    const result = await invoke("get_store_policies", "policy", `/api/store/policies?topic=${encodeURIComponent(input?.topic || "")}`);
    if (result?.status === "ok") feedback(`${result.data.title}: ${result.data.body}`);
    return result;
  }
  function getVisibleResults() {
    const started = performance.now();
    const result = envelope("ok", { product: commerceState.products[0] || null, products: commerceState.products, result_count: commerceState.products.length }, "product");
    const message = document.querySelector("[data-search-message]");
    if (message) message.textContent = `${commerceState.products.length} visible products read.`;
    trace("get_visible_results", "ok", started, "product");
    return Promise.resolve(result);
  }

  function renderOffer(result) {
    const target = region("offer");
    if (!target) return;
    if (result.status === "sign_in_required") {
      clearProtectedState();
      target.replaceChildren(node("p", "Member offer", "eyebrow"), node("h2", "Sign in to reveal your offer"), node("p", "You complete sign-in yourself. Your agent never receives credentials."));
      const link = node("a", "Sign in yourself", "button secondary");
      link.href = result.data?.sign_in_url || "/signin?return_to=/products/AX7-BLK";
      target.append(link);
    } else if (result.status === "eligible" && result.data?.offer_quote) {
      commerceState.offer = result.data;
      commerceState.offerToken = result.data.offer_quote;
      sessionStorage.setItem(storage.quote, result.data.offer_quote);
      const table = node("dl", undefined, "offer-lines");
      for (const [label, value] of [["Public price", money(result.data.unit_price_pence)], [`Member discount · ${result.data.discount_percent}%`, `−${money(result.data.discount_pence)}`], ["Member delivery", money(result.data.delivery_pence)], ["Your delivered total", money(result.data.delivered_total_pence)]]) table.append(node("dt", label), node("dd", value));
      const prepare = node("button", "Prepare basket for review");
      prepare.type = "button";
      prepare.addEventListener("click", () => prepareBasket({ product_id: result.data.product_id, offer_quote: result.data.offer_quote, quantity: 1 }));
      target.replaceChildren(node("p", "Offer unlocked", "eyebrow"), node("h2", "Your member offer"), node("p", result.data.reason), table, node("p", `Rule ${result.data.rule_id} · version ${result.data.rule_version} · expires ${new Date(result.data.expires_at).toLocaleTimeString("en-GB")}`, "muted"), prepare);
    } else if (["ineligible", "out_of_stock"].includes(result.status)) {
      commerceState.offer = null;
      commerceState.offerToken = null;
      sessionStorage.removeItem(storage.quote);
      target.replaceChildren(node("h2", result.status === "out_of_stock" ? "Currently out of stock" : "No member offer applies"), node("p", result.data?.reason || "Continue with the public product information."));
    } else if (result.status !== "service_unavailable") {
      commerceState.offer = null;
      commerceState.offerToken = null;
      sessionStorage.removeItem(storage.quote);
      target.replaceChildren(node("h2", "Offer could not be shown safely"), node("p", "Refresh the page and try again."));
    }
  }
  const accountRow = (productId) => [...document.querySelectorAll("[data-offer-product-id]")].find((row) => row.dataset.offerProductId === productId);
  const accountAction = (row) => row?.querySelector("[data-offer-action]");
  const accountResult = (row) => row?.querySelector("[data-offer-result]");
  const accountTitle = (row) => row?.querySelector("h2")?.textContent || "this product";
  function setAccountAction(row, mode, label, disabled = false) {
    const action = accountAction(row);
    if (!action) return;
    action.dataset.mode = mode;
    action.textContent = label;
    action.disabled = disabled;
  }
  function offerCalculation(data) {
    const table = node("dl", undefined, "offer-lines");
    for (const [label, value] of [["Public price", money(data.unit_price_pence)], [`Member discount · ${data.discount_percent}%`, `−${money(data.discount_pence)}`], ["Member delivery", money(data.delivery_pence)], ["Your delivered total", money(data.delivered_total_pence)]]) table.append(node("dt", label), node("dd", value));
    const expiry = node("time", new Date(data.expires_at).toLocaleTimeString("en-GB"));
    expiry.dateTime = data.expires_at;
    return [node("p", data.reason), table, node("p", "Expires ", "muted"), expiry];
  }
  function expireAccountOffer(productId, quote) {
    const data = commerceState.offers.get(productId);
    if (!data || data.offer_quote !== quote) return;
    const row = accountRow(productId);
    const target = accountResult(row);
    commerceState.offers.delete(productId);
    if (target) target.replaceChildren(node("p", "This member offer expired. Refresh it before adding the member price.", "notice"));
    setAccountAction(row, "check", `Refresh offer for ${accountTitle(row)}`);
    const applied = commerceState.basketLines.find((line) => line.product_id === productId && line.offer_quote === quote);
    if (applied) prepareBasket({ product_id: productId, offer_quote: quote, quantity: 1 });
  }
  function renderAccountOffer(productId, result) {
    const row = accountRow(productId);
    const target = accountResult(row);
    if (!row || !target) return;
    const title = accountTitle(row);
    const previous = commerceState.offers.get(productId);
    if (result.status === "sign_in_required") {
      clearProtectedState();
      document.querySelectorAll("[data-offer-action]").forEach((action) => { action.disabled = true; });
      const link = node("a", "Sign in to check member offers", "button secondary");
      link.href = "/signin?return_to=/account";
      target.replaceChildren(node("p", "Your member session ended. Public basket lines are still available.", "notice"), link);
    } else if (result.status === "eligible" && result.data?.offer_quote) {
      commerceState.offers.set(productId, result.data);
      target.replaceChildren(...offerCalculation(result.data));
      setAccountAction(row, "apply", `Add member price for ${title}`);
      clearTimeout(commerceState.offerTimers.get(productId));
      commerceState.offerTimers.set(productId, setTimeout(() => expireAccountOffer(productId, result.data.offer_quote), Math.max(0, new Date(result.data.expires_at).getTime() - Date.now())));
    } else if (["ineligible", "out_of_stock"].includes(result.status)) {
      commerceState.offers.delete(productId);
      target.replaceChildren(node("p", result.data?.reason || (result.status === "out_of_stock" ? "This product is currently out of stock." : "No member offer applies."), result.status === "out_of_stock" ? "unavailable" : "muted"));
      setAccountAction(row, "check", `${result.status === "out_of_stock" ? "Check stock" : "Refresh offer"} for ${title}`);
    } else if (result.status === "service_unavailable") {
      if (!previous) target.replaceChildren(node("p", "Member offers are temporarily unavailable. Try again.", "notice"));
      else target.append(node("p", "The last verified calculation is shown, but cannot be added until refreshed.", "notice"));
      setAccountAction(row, "check", `Refresh offer for ${title}`);
    } else {
      commerceState.offers.delete(productId);
      target.replaceChildren(node("p", "This offer could not be shown safely. Refresh it and try again.", "notice"));
      setAccountAction(row, "check", `Refresh offer for ${title}`);
    }
  }
  async function getMemberOffer(input) {
    const productId = input?.product_id;
    const row = accountRow(productId);
    if (row) {
      if (!commerceState.offers.has(productId)) accountResult(row)?.replaceChildren(node("p", "Checking your current member offer…", "muted"));
      setAccountAction(row, "check", `Checking offer for ${accountTitle(row)}…`, true);
    }
    const result = await invoke("get_member_offer", "offer", "/api/offers/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, row ? `offer:${productId}` : "offer");
    if (result) row ? renderAccountOffer(productId, result) : renderOffer(result);
    return result;
  }

  function renderPurchaseTerms(result) {
    const target = region("purchase_terms");
    if (!target) return;
    if (result.status !== "verified") {
      target.replaceChildren(node("p", result.data?.reason || result.error?.message || "Purchase terms could not be verified. Refresh your member offer and try again.", "notice"));
      return;
    }
    const { product, terms, verified_at, valid_until } = result.data;
    const table = node("dl", undefined, "offer-lines");
    for (const [label, value] of [["Public delivered total", money(terms.public_delivered_total_pence)], ["Member discount", `-${money(terms.discount_pence)}`], ["Member delivery", money(terms.member_delivery_pence)], ["Verified delivered total", money(terms.delivered_total_pence)], ["Verified saving", money(terms.savings_pence)]]) table.append(node("dt", label), node("dd", value));
    target.replaceChildren(
      node("p", `${result.data.merchant} / live verification`, "eyebrow"),
      node("h2", "Merchant-verified purchase terms"),
      node("p", `${product.sku} / ${product.variant} / quantity ${product.quantity}`),
      table,
      node("p", `${terms.stock_quantity} in stock / ${terms.delivery_estimate}`),
      node("p", `${terms.returns.window_days}-day returns / Warranty information not provided`),
      node("p", `Verified ${new Date(verified_at).toLocaleTimeString("en-GB")} / valid until ${new Date(valid_until).toLocaleTimeString("en-GB")}`, "muted"),
      node("p", "Credentials and competitor data were not shared. No purchase has been created.", "notice")
    );
  }

  async function verifyPurchaseTerms(input) {
    const result = await invoke("verify_purchase_terms", "purchase_terms", "/api/purchase-terms/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (result) renderPurchaseTerms(result);
    return result;
  }

  const summary = () => {
    const lines = [...commerceState.verifiedLines.values()].map(({ line }) => line);
    return { line_count: lines.length, currency: "GBP", delivered_total_pence: lines.reduce((total, line) => total + line.delivered_total_pence, 0) };
  };
  function renderBasket() {
    persistBasket();
    const target = region("basket");
    if (!target) return;
    const values = [...commerceState.verifiedLines.values()];
    if (!values.length) { target.replaceChildren(node("p", "Your basket is empty.", "muted")); return; }
    const compact = document.body.dataset.page !== "basket";
    const list = node("div", undefined, compact ? "line-item" : "basket-lines");
    if (compact) {
      const total = summary();
      list.append(node("p", "Verified by Northmere Audio", "eyebrow"), node("h2", `${total.line_count} ${total.line_count === 1 ? "piece" : "pieces"} in your basket`), node("p", `${values.map(({ title, line }) => title || line.sku).join(", ")} · ${money(total.delivered_total_pence)}`));
      const review = node("a", "Review basket", "button");
      review.href = "/basket";
      list.append(review);
    } else {
      for (const { line, title } of values) {
        const item = node("article", undefined, "basket-line");
        const copy = node("div");
        copy.append(node("p", line.pricing === "public" ? "Public price" : "Member price", "eyebrow"), node("h2", title || line.sku), node("p", `${line.sku} · quantity 1`));
        const actions = node("div", undefined, "basket-line-actions");
        actions.append(node("strong", money(line.delivered_total_pence)));
        const remove = node("button", `Remove ${line.sku}`, "secondary");
        remove.addEventListener("click", () => removeFromBasket({ product_id: line.product_id }));
        actions.append(remove);
        item.append(copy, actions);
        list.append(item);
      }
      const total = summary();
      const totalRow = node("div", undefined, "basket-total");
      totalRow.append(node("strong", "Delivered total"), node("strong", money(total.delivered_total_pence)));
      const review = node("a", "Continue to non-payment preview", "button");
      review.href = "/checkout-preview";
      list.append(totalRow, node("p", "Verified by Northmere Audio. No order has been created.", "muted"), review);
    }
    target.replaceChildren(list);
  }

  function acceptLine(input, result) {
    const index = commerceState.basketLines.findIndex(({ product_id }) => product_id === input.product_id);
    if (index < 0 && commerceState.basketLines.length >= 16) return { ...result, status: "basket_full", data: { reason: "A basket can contain at most 16 unique products.", basket: summary() } };
    const row = accountRow(input.product_id);
    const title = row?.querySelector("h2")?.textContent || document.querySelector(".product-copy h1")?.textContent || "";
    const request = { product_id: input.product_id, quantity: 1, ...(input.offer_quote ? { offer_quote: input.offer_quote } : {}), ...(title ? { title } : {}) };
    if (index < 0) commerceState.basketLines.push(request); else commerceState.basketLines[index] = request;
    commerceState.verifiedLines.set(input.product_id, { request, line: result.data.line_item, title });
    renderBasket();
    return { ...result, data: { ...result.data, basket: summary() } };
  }
  function renderAccountPrepare(input, result) {
    const row = accountRow(input?.product_id);
    if (!row) return;
    const target = accountResult(row);
    const title = accountTitle(row);
    if (result.status === "preview_ready") {
      target?.append(node("p", "In basket at the verified member price.", "available"));
      setAccountAction(row, "applied", `Member price in basket for ${title}`, true);
    } else if (["quote_expired", "quote_stale", "invalid_quote"].includes(result.status)) {
      commerceState.offers.delete(input.product_id);
      target?.replaceChildren(node("p", result.data?.reason || result.error?.message || "This member offer is no longer current.", "notice"));
      setAccountAction(row, "check", `Refresh offer for ${title}`);
    } else if (result.status === "out_of_stock") {
      commerceState.offers.delete(input.product_id);
      target?.replaceChildren(node("p", result.data?.reason || "This product is currently out of stock.", "unavailable"));
      setAccountAction(row, "check", `Check stock for ${title}`);
    } else if (result.status === "sign_in_required") renderAccountOffer(input.product_id, result);
    else if (result.status === "service_unavailable") renderAccountOffer(input.product_id, result);
  }
  async function prepare(input, callName) {
    const result = await invoke(callName, "basket", "/api/basket/preview", { method: "POST", headers: { "content-type": "application/json", "x-request-token": requestToken() }, body: JSON.stringify(input) });
    if (!result) return null;
    if (result.status === "preview_ready") {
      const accepted = acceptLine(input, result);
      renderAccountPrepare(input, accepted);
      return accepted;
    }
    if (["sign_in_required", "invalid_quote", "quote_expired", "quote_stale", "out_of_stock"].includes(result.status) && input?.offer_quote) {
      commerceState.basketLines = commerceState.basketLines.filter(({ product_id }) => product_id !== input.product_id);
      commerceState.verifiedLines.delete(input.product_id);
      renderBasket();
    }
    renderAccountPrepare(input, result);
    if (!accountRow(input?.product_id) && result.status !== "service_unavailable") {
      const target = region("basket");
      if (target) target.replaceChildren(node("p", result.data?.reason || result.error?.message || "This basket change could not be completed.", "notice"));
    }
    return result;
  }
  const prepareBasket = (input) => prepare(input, "prepare_basket");
  const addToBasket = (input) => prepare(input, "add_to_basket");

  async function validateBasket() {
    const previous = new Map(commerceState.verifiedLines);
    const verified = new Map();
    for (const request of commerceState.basketLines) {
      const body = { product_id: request.product_id, quantity: 1, ...(request.offer_quote ? { offer_quote: request.offer_quote } : {}) };
      const result = await invoke("view_basket", "basket", "/api/basket/preview", { method: "POST", headers: { "content-type": "application/json", "x-request-token": requestToken() }, body: JSON.stringify(body) });
      if (!result) continue;
      if (result.status === "service_unavailable") { commerceState.verifiedLines = previous; renderBasket(); return result; }
      if (result.status === "preview_ready") verified.set(request.product_id, { request, line: result.data.line_item, title: request.title || previous.get(request.product_id)?.title || "" });
    }
    commerceState.verifiedLines = verified;
    commerceState.basketLines = commerceState.basketLines.filter(({ product_id }) => verified.has(product_id));
    renderBasket();
    return envelope("ok", { line_items: [...verified.values()].map(({ line }) => line), basket: summary() }, "basket");
  }
  async function viewBasket() {
    const result = await validateBasket();
    if (document.body.dataset.page !== "basket" && result.status === "ok") feedback(`Basket verified: ${result.data.basket.line_count} items, ${money(result.data.basket.delivered_total_pence)}.`);
    return result;
  }
  function removeFromBasket(input) {
    const started = performance.now();
    const before = commerceState.basketLines.length;
    commerceState.basketLines = commerceState.basketLines.filter(({ product_id }) => product_id !== input?.product_id);
    commerceState.verifiedLines.delete(input?.product_id);
    renderBasket();
    const status = commerceState.basketLines.length < before ? "removed" : "not_found";
    trace("remove_from_basket", status, started, "basket");
    return Promise.resolve(envelope(status, { product_id: input?.product_id, basket: summary() }, "basket"));
  }

  const adminState = parse(document.querySelector("#admin-data")?.textContent, { version: 0, products: [], members: [], offers: [] });
  function adminHeaders() { return { "content-type": "application/json", "x-request-token": requestToken() }; }
  function renderAdminPreview(result) {
    const target = region("admin_preview");
    if (!target || !result) return;
    if (result.status !== "preview_ready") {
      target.replaceChildren(node("p", result.error?.message || "Preview failed. Correct the offer and try again.", "notice"));
      document.querySelector("#save-offer")?.setAttribute("disabled", "");
      return;
    }
    adminState.preview = result.data;
    const list = node("ul");
    for (const sample of result.data.samples) list.append(node("li", `${sample.sku}: ${money(sample.public_delivered_total_pence)} → ${money(sample.delivered_total_pence)}`));
    target.replaceChildren(node("h3", "Normalized preview"), node("p", `${result.data.draft.name} · ${result.data.draft.discount_percent}% discount`), list, node("p", `Preview expires ${new Date(result.data.expires_at).toLocaleTimeString("en-GB")}.`, "muted"));
    const save = document.querySelector("#save-offer");
    if (save) { save.removeAttribute("disabled"); save.textContent = result.data.draft && document.querySelector('[name="operation"]')?.value === "revise" ? "Confirm revision" : "Confirm and create"; }
  }
  function bindAdminOfferActions() {
    document.querySelectorAll("[data-edit-offer]").forEach((button) => button.addEventListener("click", () => editAdminOffer(button.dataset.editOffer)));
    document.querySelectorAll("[data-set-status]").forEach((button) => button.addEventListener("click", () => setMemberOfferStatus({ offer_id: button.dataset.offerId, status: button.dataset.setStatus, expected_version: adminState.version })));
  }
  function renderAdminList(result) {
    if (result?.status !== "ok") return;
    const changed = adminState.version !== result.data.version;
    adminState.version = result.data.version;
    adminState.offers = result.data.offers;
    const formVersion = document.querySelector('[name="expected_version"]');
    if (formVersion) formVersion.value = String(adminState.version);
    const target = document.querySelector("#admin-offer-list");
    if (!target) return;
    const items = result.data.offers.map((offer) => {
      const article = node("article", undefined, "admin-offer");
      article.dataset.adminOfferId = offer.offer_id;
      const copy = node("div");
      copy.append(node("p", `${offer.phase} · version ${offer.version}`, "eyebrow"), node("h3", offer.name), node("p", `${offer.product_ids.length} product${offer.product_ids.length === 1 ? "" : "s"} · ${offer.discount_percent}% off · ${offer.delivery_pence === null ? "public delivery" : money(offer.delivery_pence) + " delivery"}`), node("small", offer.offer_id));
      const actions = node("div", undefined, "admin-actions");
      if (offer.status !== "archived") {
        const edit = node("button", "Revise", "secondary"); edit.type = "button"; edit.setAttribute("aria-label", `Revise ${offer.name}`); edit.dataset.editOffer = offer.offer_id; actions.append(edit);
        const action = offer.status === "active" ? "Deactivate" : "Activate";
        const toggle = node("button", action, "secondary"); toggle.type = "button"; toggle.setAttribute("aria-label", `${action} ${offer.name}`); toggle.dataset.setStatus = offer.status === "active" ? "inactive" : "active"; toggle.dataset.offerId = offer.offer_id; actions.append(toggle);
        const archive = node("button", "Archive", "secondary"); archive.type = "button"; archive.setAttribute("aria-label", `Archive ${offer.name}`); archive.dataset.setStatus = "archived"; archive.dataset.offerId = offer.offer_id; actions.append(archive);
      }
      article.append(copy, actions);
      return article;
    });
    target.replaceChildren(...items);
    const history = document.querySelector("#offer-history");
    if (history) history.replaceChildren(...result.data.revisions.map((offer) => node("li", `${offer.name} · ${offer.offer_id} v${offer.version} · ${offer.status} · ${offer.updated_at}`)));
    const summary = document.querySelector("#history-summary");
    if (summary) summary.textContent = `Revision history (${result.data.revisions.length})`;
    if (changed && adminState.preview) invalidateAdminPreview();
    bindAdminOfferActions();
  }
  async function listMemberOffers() {
    const result = await invoke("list_member_offers", "admin_offers", "/api/admin/offers", {}, "admin_offers");
    renderAdminList(result);
    return result;
  }
  async function previewMemberOffer(input) {
    region("admin_preview")?.replaceChildren(node("p", "Checking and normalizing this offer…", "muted"));
    document.querySelector("#save-offer")?.setAttribute("disabled", "");
    const result = await invoke("preview_member_offer", "admin_offers", "/api/admin/offers/preview", { method: "POST", headers: adminHeaders(), body: JSON.stringify(input) }, "admin_preview");
    renderAdminPreview(result);
    return result;
  }
  async function saveAdminPreview(operation, offerId, previewToken) {
    const result = await invoke(operation === "create" ? "create_member_offer" : "revise_member_offer", "admin_offers", operation === "create" ? "/api/admin/offers" : `/api/admin/offers/${encodeURIComponent(offerId)}`, { method: operation === "create" ? "POST" : "PUT", headers: adminHeaders(), body: JSON.stringify({ preview_token: previewToken }) }, "admin_offers");
    const message = region("admin_offers");
    if (["created", "revised"].includes(result?.status)) {
      if (message) message.textContent = operation === "create" ? "Offer created." : "Offer revised.";
      resetAdminForm();
      await listMemberOffers();
    } else if (message && result) message.textContent = result.error?.message || "The offer was not saved.";
    return result;
  }
  const createMemberOffer = (input) => saveAdminPreview("create", null, input?.preview_token);
  const reviseMemberOffer = (input) => saveAdminPreview("revise", input?.offer_id, input?.preview_token);
  async function setMemberOfferStatus(input) {
    const result = await invoke("set_member_offer_status", "admin_offers", `/api/admin/offers/${encodeURIComponent(input?.offer_id || "")}/status`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ status: input?.status, expected_version: input?.expected_version ?? adminState.version }) }, "admin_offers");
    const message = region("admin_offers");
    if (result?.status === "status_changed") { if (message) message.textContent = `Offer ${input.status}.`; await listMemberOffers(); }
    else if (message && result) message.textContent = result.error?.message || "Status was not changed.";
    return result;
  }
  const isoInput = (value) => value ? new Date(value).toISOString().slice(0, 16) : "";
  function editAdminOffer(offerId) {
    const offer = adminState.offers.find((item) => item.offer_id === offerId);
    const form = document.querySelector("#admin-offer-form");
    if (!offer || !form) return;
    form.reset();
    form.elements.operation.value = "revise"; form.elements.offer_id.value = offer.offer_id; form.elements.name.value = offer.name;
    form.elements.discount_percent.value = String(offer.discount_percent); form.elements.status.value = offer.status; form.elements.starts_at.value = isoInput(offer.starts_at); form.elements.ends_at.value = isoInput(offer.ends_at);
    form.elements.audience_type.value = offer.audience.type; form.elements.tier.value = offer.audience.tier || "standard";
    form.elements.delivery_mode.value = offer.delivery_pence === null ? "public" : "override"; form.elements.delivery_pence.value = String(offer.delivery_pence ?? 0);
    form.querySelectorAll('[name="product_ids"]').forEach((control) => { control.checked = offer.product_ids.includes(control.value); });
    form.querySelectorAll('[name="member_ids"]').forEach((control) => { control.checked = offer.audience.member_ids?.includes(control.value) || false; });
    document.querySelector("#offer-form-title").textContent = `Revise ${offer.name}`;
    document.querySelector("#cancel-revision").hidden = false;
    syncAdminFields(); invalidateAdminPreview(); form.scrollIntoView({ behavior: "smooth" });
  }
  function resetAdminForm() {
    const form = document.querySelector("#admin-offer-form"); if (!form) return;
    form.reset(); form.elements.operation.value = "create"; form.elements.offer_id.value = ""; form.elements.expected_version.value = String(adminState.version);
    document.querySelector("#offer-form-title").textContent = "Create an offer"; document.querySelector("#cancel-revision").hidden = true; syncAdminFields(); invalidateAdminPreview();
  }
  function syncAdminFields() {
    const form = document.querySelector("#admin-offer-form"); if (!form) return;
    document.querySelector("[data-audience-tier]").hidden = form.elements.audience_type.value !== "tier";
    document.querySelector("[data-audience-members]").hidden = form.elements.audience_type.value !== "member_ids";
    document.querySelector("[data-delivery-override]").hidden = form.elements.delivery_mode.value !== "override";
  }
  function invalidateAdminPreview() {
    adminState.preview = null; document.querySelector("#save-offer")?.setAttribute("disabled", "");
    region("admin_preview")?.replaceChildren(node("p", "Preview required before saving.", "muted"));
  }
  function adminDraft(form) {
    const audienceType = form.elements.audience_type.value;
    const value = (name) => form.elements[name].value;
    return { name: value("name"), product_ids: [...form.querySelectorAll('[name="product_ids"]:checked')].map((control) => control.value), audience: audienceType === "all" ? { type: "all" } : audienceType === "tier" ? { type: "tier", tier: value("tier") } : { type: "member_ids", member_ids: [...form.querySelectorAll('[name="member_ids"]:checked')].map((control) => control.value) }, discount_percent: Number(value("discount_percent")), delivery_pence: value("delivery_mode") === "public" ? null : Number(value("delivery_pence")), status: value("status"), starts_at: value("starts_at") ? new Date(value("starts_at")).toISOString() : null, ends_at: value("ends_at") ? new Date(value("ends_at")).toISOString() : null };
  }

  document.querySelector("#search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    searchProducts({ query: new FormData(event.currentTarget).get("query") });
  });
  document.querySelector("#catalogue-filters")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = Object.fromEntries([...data].filter(([, value]) => value !== ""));
    input.in_stock_only = data.has("in_stock_only");
    if (input.max_price_pence) input.max_price_pence = Number(input.max_price_pence);
    filterProducts(input);
  });
  document.querySelector("#offer-action")?.addEventListener("click", (event) => getMemberOffer({ product_id: event.currentTarget.dataset.productId }));
  document.querySelectorAll("[data-offer-action]").forEach((button) => button.addEventListener("click", () => {
    const productId = button.dataset.productId;
    const offer = commerceState.offers.get(productId);
    if (button.dataset.mode === "apply" && offer) prepareBasket({ product_id: productId, offer_quote: offer.offer_quote, quantity: 1 });
    else getMemberOffer({ product_id: productId });
  }));
  document.querySelectorAll(".public-add").forEach((button) => button.addEventListener("click", () => addToBasket({ product_id: button.dataset.productId, quantity: 1 })));
  document.querySelector("#logout-form")?.addEventListener("submit", clearProtectedState);
  const adminForm = document.querySelector("#admin-offer-form");
  adminForm?.addEventListener("change", () => { syncAdminFields(); invalidateAdminPreview(); });
  adminForm?.addEventListener("input", invalidateAdminPreview);
  adminForm?.addEventListener("submit", (event) => { event.preventDefault(); previewMemberOffer({ operation: adminForm.elements.operation.value, offer_id: adminForm.elements.offer_id.value || undefined, expected_version: adminState.version, draft: adminDraft(adminForm) }); });
  document.querySelector("#save-offer")?.addEventListener("click", () => { if (!adminState.preview) return; const operation = adminForm.elements.operation.value; saveAdminPreview(operation, adminForm.elements.offer_id.value || null, adminState.preview.preview_token); });
  document.querySelector("#cancel-revision")?.addEventListener("click", resetAdminForm);
  if (adminForm) { syncAdminFields(); bindAdminOfferActions(); }
  persistBasket();

  if (document.body.dataset.page === "shop") {
    commerceState.products = parse(document.querySelector("#catalogue-data")?.textContent, []);
    commerceState.product = commerceState.products[0] || null;
  }
  if (document.body.dataset.page === "basket") setTimeout(viewBasket, 0);

  const modelContext = document.modelContext;
  const page = document.body.dataset.page;
  if (modelContext?.registerTool && page === "admin_offers") {
    const controller = new AbortController();
    const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
    const readOnly = { readOnlyHint: true, untrustedContentHint: false };
    const mutating = { readOnlyHint: false, untrustedContentHint: false };
    const ids = adminState.products.map(({ id }) => id);
    const memberIds = adminState.members.map(({ id }) => id);
    const offerId = { type: "string", pattern: "^[A-Za-z0-9-]{1,80}$" };
    const audience = { oneOf: [schema({ type: { const: "all" } }, ["type"]), schema({ type: { const: "tier" }, tier: { type: "string", enum: ["standard", "vip"] } }, ["type", "tier"]), schema({ type: { const: "member_ids" }, member_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: memberIds } } }, ["type", "member_ids"])] };
    const draft = schema({ name: { type: "string", minLength: 1, maxLength: 100 }, product_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ids } }, audience, discount_percent: { type: "integer", minimum: 0, maximum: 100 }, delivery_pence: { type: ["integer", "null"], minimum: 0 }, status: { type: "string", enum: ["active", "inactive"] }, starts_at: { type: ["string", "null"] }, ends_at: { type: ["string", "null"] } }, ["name", "product_ids", "audience", "discount_percent", "delivery_pence", "status", "starts_at", "ends_at"]);
    const tools = [
      { name: "list_member_offers", description: "List current owner-managed member offers and revisions.", inputSchema: schema({}), annotations: readOnly, execute: listMemberOffers },
      { name: "preview_member_offer", description: "Validate and visibly preview a complete offer draft before saving.", inputSchema: schema({ operation: { type: "string", enum: ["create", "revise"] }, offer_id: offerId, expected_version: { type: "integer", minimum: 0 }, draft }, ["operation", "expected_version", "draft"]), annotations: readOnly, execute: previewMemberOffer },
      { name: "create_member_offer", description: "Create exactly the owner-session-bound preview.", inputSchema: schema({ preview_token: { type: "string", minLength: 20, maxLength: 16384 } }, ["preview_token"]), annotations: mutating, execute: createMemberOffer },
      { name: "revise_member_offer", description: "Append a revision from an owner-session-bound preview.", inputSchema: schema({ offer_id: offerId, preview_token: { type: "string", minLength: 20, maxLength: 16384 } }, ["offer_id", "preview_token"]), annotations: mutating, execute: reviseMemberOffer },
      { name: "set_member_offer_status", description: "Activate, deactivate, or permanently archive an offer.", inputSchema: schema({ offer_id: offerId, status: { type: "string", enum: ["active", "inactive", "archived"] }, expected_version: { type: "integer", minimum: 0 } }, ["offer_id", "status", "expected_version"]), annotations: mutating, execute: setMemberOfferStatus }
    ];
    for (const tool of tools) modelContext.registerTool(tool, { signal: controller.signal });
    addEventListener("pagehide", () => controller.abort(), { once: true });
  }
  if (modelContext?.registerTool && !["signin", "admin_signin", "admin_offers", "checkout"].includes(page)) {
    const controller = new AbortController();
    const ids = ["product-ax7-blk", "product-mh2-slv", "product-vn9-snd", "product-de1-wht", "product-fs8-wal", "product-cc4-blk", "product-ho1-crm", "product-af12-blk", "product-nt2-wal", "product-td3-slv", "product-sr1-blk", "product-ra5-slv", "product-as1-blk", "product-bc2-blk", "product-sp3-blk", "product-hc1-gry"];
    const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) });
    const readOnly = { readOnlyHint: true, untrustedContentHint: false };
    const mutating = { readOnlyHint: false, untrustedContentHint: false };
    const productId = { type: "string", enum: ids, description: "Merchant product identifier returned by search_products." };
    const feature = { type: "string", enum: ["commuting", "home_listening", "lightweight", "over_ear", "noise_control"] };
    const tools = [
      { name: "search_products", description: "Search products from the shopper's raw request with optional precise category, delivered-price, stock, connection and listening-use filters. Returns compact summaries with match reasons. Relay member_offer_prompt to signed-out shoppers when present.", inputSchema: schema({ query: { type: "string", minLength: 1, maxLength: 100 }, category: { type: "string", enum: ["headphones", "speakers", "sources", "accessories"] }, max_delivered_price_pence: { type: "integer", minimum: 0 }, in_stock_only: { type: "boolean" }, connection: { type: "string", enum: ["wired", "wireless"] }, features: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: feature }, sort: { type: "string", enum: ["relevance", "delivered_price_asc", "delivered_price_desc", "weight_asc"] }, limit: { type: "integer", minimum: 1, maximum: 8 } }, ["query"]), annotations: readOnly, execute: searchProducts },
      { name: "compare_products", description: "Compare two to four products by delivered price, stock, connection, weight, battery, noise control, warranty and member-offer status. Results are ordered by delivered price.", inputSchema: schema({ product_ids: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: productId } }, ["product_ids"]), annotations: readOnly, execute: compareProducts },
      { name: "view_product", description: "Open a product page from a merchant product identifier.", inputSchema: schema({ product_id: productId }, ["product_id"]), annotations: readOnly, execute: viewProduct },
      { name: "get_store_policies", description: "Read a Northmere delivery, returns, or member-offer policy.", inputSchema: schema({ topic: { type: "string", enum: ["delivery", "returns", "member_offers"] } }, ["topic"]), annotations: readOnly, execute: getStorePolicies },
      { name: "view_basket", description: "Revalidate and inspect this tab's reversible basket.", inputSchema: schema({}), annotations: readOnly, execute: viewBasket }
    ];
    if (page === "shop") tools.push(
      { name: "filter_products", description: "Filter and sort the visible product collection.", inputSchema: schema({ category: { type: "string", enum: ["headphones", "speakers", "sources", "accessories"] }, max_price_pence: { type: "integer", minimum: 0 }, in_stock_only: { type: "boolean" }, sort: { type: "string", enum: ["relevance", "price_asc", "price_desc", "name"] } }), annotations: readOnly, execute: filterProducts },
      { name: "get_visible_results", description: "Read the products currently visible in the shop.", inputSchema: schema({}), annotations: readOnly, execute: getVisibleResults },
      { name: "add_to_basket", description: "Add one public-price product to this tab's reversible basket.", inputSchema: schema({ product_id: productId, quantity: { type: "integer", const: 1 } }, ["product_id", "quantity"]), annotations: mutating, execute: addToBasket }
    );
    if (page === "product") tools.push(
      { name: "get_product_details", description: "Read details for the product on the current page.", inputSchema: schema({}), annotations: readOnly, execute: getProductDetails },
      { name: "get_member_offer", description: "Check the signed-in member offer for a product.", inputSchema: schema({ product_id: productId }, ["product_id"]), annotations: readOnly, execute: getMemberOffer },
      { name: "verify_purchase_terms", description: "Verify current exact product, member total, stock, delivery, returns, and warranty information without purchasing.", inputSchema: schema({ product_id: productId, offer_quote: { type: "string", minLength: 20, maxLength: 2048 }, quantity: { type: "integer", const: 1 } }, ["product_id", "offer_quote", "quantity"]), annotations: readOnly, execute: verifyPurchaseTerms },
      { name: "prepare_basket", description: "Prepare one quoted member-price line without purchasing.", inputSchema: schema({ product_id: productId, offer_quote: { type: "string", minLength: 20, maxLength: 2048 }, quantity: { type: "integer", const: 1 } }, ["product_id", "offer_quote", "quantity"]), annotations: mutating, execute: prepareBasket },
      { name: "add_to_basket", description: "Add this product at its public price to this tab's reversible basket.", inputSchema: schema({ product_id: productId, quantity: { type: "integer", const: 1 } }, ["product_id", "quantity"]), annotations: mutating, execute: addToBasket }
    );
    if (page === "account" && document.body.dataset.signedIn === "true") tools.push(
      { name: "get_member_offer", description: "Check the signed-in member offer for a product.", inputSchema: schema({ product_id: productId }, ["product_id"]), annotations: readOnly, execute: getMemberOffer },
      { name: "prepare_basket", description: "Prepare one quoted member-price line without purchasing.", inputSchema: schema({ product_id: productId, offer_quote: { type: "string", minLength: 20, maxLength: 2048 }, quantity: { type: "integer", const: 1 } }, ["product_id", "offer_quote", "quantity"]), annotations: mutating, execute: prepareBasket }
    );
    if (page === "basket") tools.push(
      { name: "remove_from_basket", description: "Remove one product from this tab's reversible basket.", inputSchema: schema({ product_id: productId }, ["product_id"]), annotations: mutating, execute: removeFromBasket }
    );
    for (const tool of tools) modelContext.registerTool(tool, { signal: controller.signal });
    addEventListener("pagehide", () => controller.abort(), { once: true });
  }
})();
