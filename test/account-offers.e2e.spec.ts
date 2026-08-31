import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, returnTo = "/account") {
  await page.goto(`/signin?return_to=${returnTo}`);
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
}

const installToolCapture = async (page: Page) => page.addInitScript(() => {
  const registrations: Array<Record<string, unknown>> = [];
  Object.defineProperty(document, "modelContext", { value: { registerTool(tool: Record<string, unknown>, lifecycle: { signal: AbortSignal }) { registrations.push({ ...tool, hasSignal: lifecycle.signal instanceof AbortSignal }); } }, configurable: true });
  Object.defineProperty(window, "__registrations", { value: registrations });
});

test("account checks exact offers and upgrades one public line without losing another SKU", async ({ page }) => {
  await page.goto("/products/VN9-SND");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await page.goto("/products/TD3-SLV");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("Tide D3 DAC");
  await signIn(page);

  for (const productId of ["product-ax7-blk", "product-vn9-snd", "product-fs8-wal", "product-nt2-wal"])
    await expect(page.locator(`[data-offer-product-id="${productId}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Check offer for Auralux X7 Studio Headphones" }).click();
  await expect(page.locator('[data-offer-product-id="product-ax7-blk"] [data-offer-result]')).toContainText("£499.00");
  await expect(page.locator('[data-offer-product-id="product-ax7-blk"] [data-offer-result]')).toContainText("£24.95");
  await expect(page.locator('[data-offer-product-id="product-ax7-blk"] [data-offer-result]')).toContainText("£474.05");

  await page.getByRole("button", { name: "Check offer for Velora N9 Headphones" }).click();
  const vn9 = page.locator('[data-offer-product-id="product-vn9-snd"]');
  await expect(vn9.locator("[data-offer-result]")).toContainText("£279.00");
  await expect(vn9.locator("[data-offer-result]")).toContainText("£13.95");
  await expect(vn9.locator("[data-offer-result]")).toContainText("£265.05");
  await expect(vn9.locator("time")).toHaveAttribute("datetime", /T/);
  await page.getByRole("button", { name: "Add member price for Velora N9 Headphones" }).click();
  await expect(vn9.locator("[data-offer-result]")).toContainText("In basket");
  await page.goto("/basket");
  await expect(page.locator(".basket-line")).toHaveCount(2);
  await expect(page.locator('[data-region="basket"]')).toContainText("Velora N9 Headphones");
  await expect(page.locator('[data-region="basket"]')).toContainText("Tide D3 DAC");
  await expect(page.locator('[data-region="basket"]')).toContainText("£265.05");
});

test("offer requests are isolated by product and newest same-product response wins", async ({ page }) => {
  await installToolCapture(page);
  await signIn(page);
  let axCalls = 0;
  await page.route("**/api/offers/evaluate", async (route) => {
    const id = route.request().postDataJSON().product_id;
    if (id === "product-vn9-snd") return route.abort();
    axCalls += 1;
    if (axCalls === 1) await new Promise((resolve) => setTimeout(resolve, 180));
    const total = axCalls === 1 ? 1 : 47405;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "eligible", observed_at: new Date().toISOString(), data: { product_id: id, sku: "AX7-BLK", offer_quote: `quote-${axCalls}-xxxxxxxxxxxxxxxxxxxx`, unit_price_pence: 49900, discount_percent: 5, discount_pence: 2495, delivery_pence: 0, delivered_total_pence: total, reason: "Eligible member offer.", rule_id: "MEMBER-5-FREE", rule_version: 1, expires_at: new Date(Date.now() + 300000).toISOString() }, error: null, ui_region: "offer" }) });
  });

  await page.getByRole("button", { name: "Check offer for Auralux X7 Studio Headphones" }).click();
  await page.getByRole("button", { name: "Check offer for Velora N9 Headphones" }).click();
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("temporarily unavailable");
  await expect(page.locator('[data-offer-product-id="product-ax7-blk"] [data-offer-result]')).toContainText("£0.01");

  const results = await page.evaluate(async () => {
    const tool = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }).__registrations.find(({ name }) => name === "get_member_offer")!;
    return Promise.all([tool.execute({ product_id: "product-ax7-blk" }), tool.execute({ product_id: "product-ax7-blk" })]);
  });
  expect(results[0]).toBeNull();
  expect(results[1]).toMatchObject({ status: "eligible", data: { delivered_total_pence: 47405 } });
  await expect(page.locator('[data-offer-product-id="product-ax7-blk"] [data-offer-result]')).toContainText("£474.05");
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("temporarily unavailable");
});

test("expiry revalidates protected lines and session loss offers an account return", async ({ page }) => {
  await signIn(page);
  let previews = 0;
  await page.route("**/api/offers/evaluate", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "eligible", observed_at: new Date().toISOString(), data: { product_id: "product-ax7-blk", sku: "AX7-BLK", offer_quote: "expiring-quote-xxxxxxxxxxxx", unit_price_pence: 49900, discount_percent: 5, discount_pence: 2495, delivery_pence: 0, delivered_total_pence: 47405, reason: "Eligible member offer.", rule_id: "MEMBER-5-FREE", rule_version: 1, expires_at: new Date(Date.now() + 350).toISOString() }, error: null, ui_region: "offer" }) }));
  await page.route("**/api/basket/preview", (route) => {
    previews += 1;
    if (previews > 1) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "quote_expired", observed_at: new Date().toISOString(), data: { reason: "This member offer expired.", refresh_offer: true }, error: null, ui_region: "basket" }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "preview_ready", observed_at: new Date().toISOString(), data: { line_item: { product_id: "product-ax7-blk", sku: "AX7-BLK", quantity: 1, currency: "GBP", unit_price_pence: 49900, discount_pence: 2495, delivery_pence: 0, delivered_total_pence: 47405 }, basket: { line_count: 1, currency: "GBP", delivered_total_pence: 47405 }, checkout_preview_url: "/checkout-preview" }, error: null, ui_region: "basket" }) });
  });
  await page.getByRole("button", { name: "Check offer for Auralux X7 Studio Headphones" }).click();
  await page.getByRole("button", { name: "Add member price for Auralux X7 Studio Headphones" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("£474.05");
  await expect(page.getByRole("button", { name: "Refresh offer for Auralux X7 Studio Headphones" })).toBeVisible({ timeout: 3000 });
  await expect(page.locator('[data-region="basket"]')).toContainText("empty");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("elemkey.basket") || "[]"))).toEqual([]);

  await page.unroute("**/api/offers/evaluate");
  await page.route("**/api/offers/evaluate", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "sign_in_required", observed_at: new Date().toISOString(), data: { product_id: "product-vn9-snd", reason: "session_expired", sign_in_url: "/signin?return_to=/products/VN9-SND" }, error: null, ui_region: "offer" }) }));
  await page.getByRole("button", { name: "Check offer for Velora N9 Headphones" }).click();
  await expect(page.getByRole("link", { name: "Sign in to check member offers" })).toHaveAttribute("href", "/signin?return_to=/account");
});

test("signed-in account adds the two existing offer tools and drives the same visible row", async ({ page }) => {
  await installToolCapture(page);
  await page.goto("/account");
  const names = () => page.evaluate(() => (window as unknown as { __registrations: Array<{ name: string }> }).__registrations.map(({ name }) => name));
  expect(await names()).toEqual(["search_products", "view_product", "get_store_policies", "view_basket"]);
  await signIn(page);
  await expect.poll(names).toEqual(["search_products", "view_product", "get_store_policies", "view_basket", "get_member_offer", "prepare_basket"]);
  const offer = await page.evaluate(async () => {
    const tool = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }).__registrations.find(({ name }) => name === "get_member_offer")!;
    return tool.execute({ product_id: "product-vn9-snd" });
  }) as { data: { offer_quote: string } };
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("£265.05");
  await page.evaluate(async ({ quote }) => {
    const tool = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }).__registrations.find(({ name }) => name === "prepare_basket")!;
    await tool.execute({ product_id: "product-vn9-snd", offer_quote: quote, quantity: 1 });
  }, { quote: offer.data.offer_quote });
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("In basket");
  await expect(page.locator('[data-region="basket"]')).toContainText("Velora N9 Headphones");
});

test("offer rows remain editorial and usable at desktop, tablet, and mobile widths", async ({ page }) => {
  await signIn(page);
  const row = page.locator('[data-offer-product-id="product-ax7-blk"]');
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await row.evaluate((element) => getComputedStyle(element).display)).toBe("grid");
  const desktop = await row.locator("img").boundingBox();
  expect(desktop?.width).toBeGreaterThan(140);

  await page.setViewportSize({ width: 768, height: 900 });
  const title = await row.locator("h2").boundingBox();
  const result = await row.locator("[data-offer-result]").boundingBox();
  expect(result!.y).toBeGreaterThan(title!.y);

  await page.setViewportSize({ width: 375, height: 900 });
  const mobileRow = await row.boundingBox();
  const image = await row.locator("img").boundingBox();
  const action = await row.locator("[data-offer-action]").boundingBox();
  expect(Math.round(image!.width)).toBe(96);
  expect(action!.height).toBeGreaterThanOrEqual(44);
  expect(action!.width).toBeGreaterThanOrEqual(mobileRow!.width - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test("account rows expose loading, ineligible, out-of-stock, and stale recovery states", async ({ page }) => {
  await signIn(page);
  const ax7 = page.locator('[data-offer-product-id="product-ax7-blk"]');
  await expect(ax7.locator("[data-offer-result]")).toContainText("hidden until checked");
  let release: (() => void) | undefined;
  await page.route("**/api/offers/evaluate", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ineligible", observed_at: new Date().toISOString(), data: { product_id: "product-ax7-blk", reason: "No member offer applies." }, error: null, ui_region: "offer" }) });
  });
  await page.getByRole("button", { name: "Check offer for Auralux X7 Studio Headphones" }).click();
  await expect(ax7.locator("[data-offer-result]")).toContainText("Checking");
  await expect(ax7.locator("[data-offer-action]")).toBeDisabled();
  release!();
  await expect(ax7.locator("[data-offer-result]")).toContainText("No member offer applies");

  await page.unroute("**/api/offers/evaluate");
  await page.route("**/api/offers/evaluate", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "out_of_stock", observed_at: new Date().toISOString(), data: { product_id: "product-ax7-blk", reason: "This product is currently out of stock." }, error: null, ui_region: "offer" }) }));
  await ax7.locator("[data-offer-action]").click();
  await expect(ax7.locator("[data-offer-result]")).toContainText("out of stock");

  await page.unroute("**/api/offers/evaluate");
  await page.route("**/api/offers/evaluate", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "eligible", observed_at: new Date().toISOString(), data: { product_id: "product-ax7-blk", sku: "AX7-BLK", offer_quote: "stale-quote-xxxxxxxxxxxxxxx", unit_price_pence: 49900, discount_percent: 5, discount_pence: 2495, delivery_pence: 0, delivered_total_pence: 47405, reason: "Eligible member offer.", rule_id: "MEMBER-5-FREE", rule_version: 1, expires_at: new Date(Date.now() + 300000).toISOString() }, error: null, ui_region: "offer" }) }));
  await ax7.locator("[data-offer-action]").click();
  await page.route("**/api/basket/preview", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "quote_stale", observed_at: new Date().toISOString(), data: { reason: "This member offer has changed.", refresh_offer: true }, error: null, ui_region: "basket" }) }));
  await page.getByRole("button", { name: "Add member price for Auralux X7 Studio Headphones" }).click();
  await expect(ax7.locator("[data-offer-result]")).toContainText("changed");
  await expect(page.getByRole("button", { name: "Refresh offer for Auralux X7 Studio Headphones" })).toBeVisible();
});

test("sign-out removes protected lines but retains valid public lines", async ({ page }) => {
  await page.goto("/products/TD3-SLV");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("Tide D3 DAC");
  await signIn(page);
  await page.getByRole("button", { name: "Check offer for Auralux X7 Studio Headphones" }).click();
  await page.getByRole("button", { name: "Add member price for Auralux X7 Studio Headphones" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("elemkey.basket") || "[]"));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ product_id: "product-td3-slv", quantity: 1 });
  expect(stored[0]).not.toHaveProperty("offer_quote");
});
