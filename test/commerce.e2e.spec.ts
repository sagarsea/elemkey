import { expect, test } from "@playwright/test";

test("ordinary storefront completes the reversible journey without WebMCP", async ({ page }) => {
  await page.goto("/products/AX7-BLK");
  await expect(page.getByRole("heading", { name: "Auralux X7 Studio Headphones" })).toBeVisible();
  await page.getByLabel("Search products").fill("AX7-BLK");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator('[data-region="product"]')).toContainText("£499.00");
  await page.getByRole("link", { name: "Sign in yourself" }).click();
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/products\/AX7-BLK/);
  await page.getByRole("button", { name: "Get my member offer" }).click();
  await expect(page.locator('[data-region="offer"]')).toContainText("£474.05");
  await page.getByRole("button", { name: "Prepare basket for review" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("£474.05");
  await page.getByRole("button", { name: "Prepare basket for review" }).click();
  await expect(page.locator('[data-region="basket"] .line-item')).toHaveCount(1);
  await page.getByRole("link", { name: "Review basket" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("Verified by Northmere Audio");
  await page.getByRole("link", { name: "Continue to non-payment preview" }).click();
  await expect(page.getByRole("heading", { name: "This is a non-payment checkout preview." })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/place order|pay now/i);
});

test("keeps the three legacy WebMCP tools backward compatible inside the expanded product scope", async ({ page }) => {
  await page.addInitScript(() => {
    const registrations: Array<Record<string, unknown>> = [];
    Object.defineProperty(document, "modelContext", { value: {
      registerTool(tool: Record<string, unknown>, lifecycle: { signal: AbortSignal }) {
        lifecycle.signal.addEventListener("abort", () => sessionStorage.setItem("elemkey.lifecycleAborted", "1"));
        registrations.push({ ...tool, hasSignal: lifecycle.signal instanceof AbortSignal });
      }
    }, configurable: true });
    Object.defineProperty(window, "__registrations", { value: registrations });
  });
  await page.goto("/products/AX7-BLK");
  const registrations = await page.evaluate(() => (window as unknown as { __registrations: Array<Record<string, unknown>> }).__registrations.map(({ name, inputSchema, annotations, hasSignal }) => ({ name, inputSchema, annotations, hasSignal })));
  expect(registrations).toHaveLength(9);
  expect(registrations.map(({ name }) => name)).toEqual(["search_products", "view_product", "get_store_policies", "view_basket", "get_product_details", "get_member_offer", "verify_purchase_terms", "prepare_basket", "add_to_basket"]);
  expect(registrations.find(({ name }) => name === "search_products")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, hasSignal: true, inputSchema: { additionalProperties: false, required: ["query"] } });
  expect(registrations.find(({ name }) => name === "get_member_offer")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id"] } });
  expect(registrations.find(({ name }) => name === "prepare_basket")).toMatchObject({ annotations: { readOnlyHint: false, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id", "offer_quote", "quantity"] } });

  const signedOut = await page.evaluate(async () => {
    const tools = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }).__registrations;
    return tools.find(({ name }) => name === "get_member_offer")!.execute({ product_id: "product-ax7-blk" });
  });
  expect(signedOut).toMatchObject({ status: "sign_in_required", ui_region: "offer" });
  await expect(page.locator('[data-region="offer"]')).toContainText("Sign in to reveal");
  await page.goto("/signin?return_to=/products/AX7-BLK");
  expect(await page.evaluate(() => sessionStorage.getItem("elemkey.lifecycleAborted"))).toBe("1");
});

test("network failure preserves public state, newest search wins, and unknown offer status fails safely", async ({ page }) => {
  await page.goto("/products/AX7-BLK");
  await page.route("**/api/products/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("query");
    if (query === "offline") return route.abort();
    if (query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ok", observed_at: new Date().toISOString(), data: { product: { id: "old", title: "Old stale result", sku: "OLD", description: "stale", unit_price_pence: 1, delivery_pence: 0, delivery_estimate: "old" } }, error: null, ui_region: "product" }) });
    }
    return route.continue();
  });
  await page.getByLabel("Search products").fill("offline");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator('[data-region="product"]')).toContainText("Auralux X7 Studio Headphones");
  await expect(page.locator("[data-search-message]")).toContainText("temporarily unavailable");

  await page.getByLabel("Search products").fill("slow");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Search products").fill("AX7-BLK");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForTimeout(250);
  await expect(page.locator('[data-region="product"]')).toContainText("Auralux X7 Studio Headphones");
  await expect(page.locator('[data-region="product"]')).not.toContainText("Old stale result");

  await page.unroute("**/api/products/search**");
  await page.goto("/signin?return_to=/products/AX7-BLK");
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.route("**/api/offers/evaluate", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "unknown_new_status", data: { delivered_total_pence: 1 }, error: null, ui_region: "offer" }) }));
  await page.getByRole("button", { name: "Get my member offer" }).click();
  await expect(page.locator('[data-region="offer"]')).toContainText("could not be shown safely");
  expect(await page.evaluate(() => sessionStorage.getItem("elemkey.offerQuote"))).toBeNull();
});

test("safe trace excludes inputs, identity, credentials, and quotes; logout clears commercial state", async ({ page }) => {
  await page.goto("/signin?return_to=/products/AX7-BLK");
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Get my member offer" }).click();
  await page.getByRole("button", { name: "Prepare basket for review" }).click();
  const trace = await page.evaluate(() => sessionStorage.getItem("elemkey.trace"));
  expect(trace).toBeTruthy();
  expect(trace).not.toMatch(/sagar|ElemKeyDemo|offer_quote|product_id|eyJ/i);
  expect(JSON.parse(trace!)[0]).toEqual(expect.objectContaining({ call_name: expect.any(String), status: expect.any(String), at: expect.any(String), duration_ms: expect.any(Number), ui_region: expect.any(String) }));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/logged_out=1/);
  expect(await page.evaluate(() => ({ quote: sessionStorage.getItem("elemkey.offerQuote"), preview: sessionStorage.getItem("elemkey.basketPreview") }))).toEqual({ quote: null, preview: null });
});
