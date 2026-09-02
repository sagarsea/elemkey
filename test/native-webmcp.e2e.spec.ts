import { expect, test } from "@playwright/test";

test("real Chromium discovers and executes the complete local WebMCP journey", async ({ page }) => {
  test.skip(process.env.NATIVE_WEBMCP !== "1", "Requires headed Chromium with the WebMCP testing flag");

  await page.goto("/products/AX7-BLK");
  const tools = await page.evaluate(async () => {
    const context = (document as Document & { modelContext?: { getTools(): Promise<Array<{ name: string; inputSchema: unknown; annotations: unknown }>> } }).modelContext;
    if (!context) return [];
    return (await context.getTools()).map((tool) => ({ ...tool, inputSchema: typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema }));
  });
  expect(tools.map(({ name }) => name).sort()).toEqual(["add_to_basket", "compare_products", "get_member_offer", "get_product_details", "get_store_policies", "prepare_basket", "search_products", "verify_purchase_terms", "view_basket", "view_product"]);
  expect(tools.find(({ name }) => name === "search_products")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["query"] } });
  expect(tools.find(({ name }) => name === "compare_products")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_ids"] } });
  expect(tools.find(({ name }) => name === "get_member_offer")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id"] } });
  expect(tools.find(({ name }) => name === "verify_purchase_terms")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id", "offer_quote", "quantity"] } });
  expect(tools.find(({ name }) => name === "prepare_basket")).toMatchObject({ annotations: { readOnlyHint: false, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id", "offer_quote", "quantity"] } });

  const execute = (name: string, input: unknown) => page.evaluate(async ({ name, input }) => {
    type Tool = { name: string };
    const context = (document as Document & { modelContext: { getTools(): Promise<Tool[]>; executeTool(tool: Tool, input: string): Promise<unknown> } }).modelContext;
    const tool = (await context.getTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    const result = await context.executeTool(tool, JSON.stringify(input));
    return typeof result === "string" ? JSON.parse(result) : result;
  }, { name, input });

  expect(await execute("search_products", { query: "AX7-BLK" })).toMatchObject({ status: "ok", ui_region: "product", data: { member_offer_prompt: "You may qualify for a special offer. Sign in to reveal your personal offer." } });
  expect(await execute("search_products", { query: "wireless headphones under £400" })).toMatchObject({ status: "ok", data: { products: [{ id: "product-vn9-snd" }], applied_filters: { category: "headphones", max_delivered_price_pence: 40000, in_stock_only: true, connection: "wireless" } } });
  const commuting = await execute("search_products", { query: "What is best for commuting?", category: "headphones", in_stock_only: true, features: ["commuting"], sort: "relevance", limit: 1 }) as { data: { products: Array<{ id: string; match_reason: string }> } };
  expect(commuting.data.products).toEqual([expect.objectContaining({ id: "product-vn9-snd", match_reason: expect.stringMatching(/travel.*noise cancelling/i) })]);
  const compared = await execute("compare_products", { product_ids: ["product-ax7-blk", "product-mh2-slv", "product-vn9-snd"] }) as { data: { products: Array<{ product_id: string; battery: string; warranty: string }> } };
  expect(compared.data.products.map(({ product_id }) => product_id)).toEqual(["product-vn9-snd", "product-mh2-slv", "product-ax7-blk"]);
  expect(compared.data.products.every(({ warranty }) => warranty === "2 years")).toBe(true);
  expect(compared.data.products.find(({ product_id }) => product_id === "product-mh2-slv")?.battery).toBe("Not applicable");
  await expect(page.locator('[data-region="recommendations"]')).toContainText("Your basket is unchanged and no purchase has been created");
  expect(await execute("get_member_offer", { product_id: "product-ax7-blk" })).toMatchObject({ status: "sign_in_required", ui_region: "offer" });
  await expect(page.locator('[data-region="offer"]')).toContainText("Sign in to reveal");

  await page.getByRole("link", { name: "Sign in yourself" }).click();
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/products\/AX7-BLK/);
  await expect.poll(async () => (await page.evaluate(async () => (await (document as Document & { modelContext: { getTools(): Promise<Array<{ name: string }>> } }).modelContext.getTools()).map(({ name }) => name))).sort()).toEqual(["add_to_basket", "compare_products", "get_member_offer", "get_product_details", "get_store_policies", "prepare_basket", "search_products", "verify_purchase_terms", "view_basket", "view_product"]);

  const offer = await execute("get_member_offer", { product_id: "product-ax7-blk" }) as { status: string; data: { offer_quote: string; delivered_total_pence: number } };
  expect(offer.status).toBe("eligible");
  expect(offer.data.delivered_total_pence).toBe(47405);
  await expect(page.locator('[data-region="offer"]')).toContainText("£474.05");

  const terms = await execute("verify_purchase_terms", { product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 1 });
  expect(terms).toMatchObject({ status: "verified", data: { product: { sku: "AX7-BLK", variant: "Black" }, terms: { delivered_total_pence: 47405 }, privacy: { purchase_created: false } } });
  await expect(page.locator('[data-region="purchase_terms"]')).toContainText("Merchant-verified purchase terms");
  await expect(page.locator('[data-region="purchase_terms"]')).toContainText("No purchase has been created");

  const preview = await execute("prepare_basket", { product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 1 });
  expect(preview).toMatchObject({ status: "preview_ready", data: { line_item: { quantity: 1, delivered_total_pence: 47405 } } });
  await expect(page.locator('[data-region="basket"]')).toContainText("£474.05");
  expect(await page.locator('[data-region="basket"] .line-item').count()).toBe(1);

  await page.goto("/account");
  expect((await page.evaluate(async () => (await (document as Document & { modelContext: { getTools(): Promise<Array<{ name: string }>> } }).modelContext.getTools()).map(({ name }) => name))).sort()).toEqual(["compare_products", "get_member_offer", "get_store_policies", "prepare_basket", "search_products", "view_basket", "view_product"]);
  const accountOffer = await execute("get_member_offer", { product_id: "product-vn9-snd" }) as { data: { offer_quote: string } };
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("£265.05");
  await execute("prepare_basket", { product_id: "product-vn9-snd", offer_quote: accountOffer.data.offer_quote, quantity: 1 });
  await expect(page.locator('[data-offer-product-id="product-vn9-snd"] [data-offer-result]')).toContainText("In basket");
  await expect(page.locator('[data-region="basket"]')).toContainText("Velora N9 Headphones");

  const trace = await page.evaluate(() => sessionStorage.getItem("elemkey.trace") ?? "");
  expect(trace).not.toMatch(/sagar|ElemKeyDemo|offer_quote|product_id|eyJ/i);
  await page.screenshot({ path: "native-webmcp-complete.png", fullPage: true });
});

test("real Chromium exposes only owner tools and creates a visible persisted offer", async ({ page }) => {
  test.skip(process.env.NATIVE_WEBMCP !== "1", "Requires headed Chromium with the WebMCP testing flag");
  await page.goto("/admin/signin");
  await page.getByLabel("Owner email").fill("owner@northmere.test");
  await page.getByLabel("Owner password").fill("NorthmereOwner2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  const execute = (name: string, input: unknown) => page.evaluate(async ({ name, input }) => {
    type Tool = { name: string };
    const context = (document as Document & { modelContext: { getTools(): Promise<Tool[]>; executeTool(tool: Tool, input: string): Promise<unknown> } }).modelContext;
    const tool = (await context.getTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    const result = await context.executeTool(tool, JSON.stringify(input));
    return typeof result === "string" ? JSON.parse(result) : result;
  }, { name, input });
  const names = await page.evaluate(async () => (await (document as Document & { modelContext: { getTools(): Promise<Array<{ name: string }>> } }).modelContext.getTools()).map(({ name }) => name));
  expect(names.sort()).toEqual(["create_member_offer", "list_member_offers", "preview_member_offer", "revise_member_offer", "set_member_offer_status"]);
  const listed = await execute("list_member_offers", {}) as { data: { version: number } };
  const preview = await execute("preview_member_offer", { operation: "create", expected_version: listed.data.version, draft: { name: "Native Canary persistence proof", product_ids: ["product-td3-slv"], audience: { type: "member_ids", member_ids: ["member-demo-vip"] }, discount_percent: 12, delivery_pence: 0, status: "active", starts_at: null, ends_at: null } }) as { data: { preview_token: string } };
  const created = await execute("create_member_offer", { preview_token: preview.data.preview_token });
  expect(created).toMatchObject({ status: "created", ui_region: "admin_offers" });
  await expect(page.locator("#admin-offer-list")).toContainText("Native Canary persistence proof");
  await page.screenshot({ path: "test/native-owner-webmcp.png", fullPage: true });
});
