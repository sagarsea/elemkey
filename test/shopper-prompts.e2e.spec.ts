import { expect, test, type Page } from "@playwright/test";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown>; execute(input: unknown): Promise<unknown> };
type Result = { status: string; data: Record<string, any>; ui_region: string };

async function installWebMCP(page: Page) {
  await page.addInitScript(() => {
    const tools: unknown[] = [];
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool: unknown) { tools.push(tool); } }, configurable: true });
    Object.defineProperty(window, "__tools", { value: tools });
  });
}

async function execute(page: Page, name: string, input: unknown) {
  return page.evaluate(async ({ name, input }) => {
    const tools = (window as unknown as { __tools: Tool[] }).__tools;
    const tool = [...tools].reverse().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return { selected_tool: tool.name, arguments: input, result: await tool.execute(input) };
  }, { name, input }) as Promise<{ selected_tool: string; arguments: unknown; result: Result }>;
}

test("exact shopper prompts select goal-focused tools, explain results, update visible state, and stop safely", async ({ page }) => {
  await installWebMCP(page);
  await page.goto("/shop");

  const searchDescription = await page.evaluate(() => (window as unknown as { __tools: Tool[] }).__tools.find(({ name }) => name === "search_products")?.description);
  expect(searchDescription).toContain("merchant-verified member_offer_preview");
  expect(searchDescription).toContain("stable personalized baseline is 5–15%");

  const rawWireless = await execute(page, "search_products", { query: "wireless headphones under £400" });
  const veloraPrompt = "The Velora N9 is £288.99 delivered. Signed-in members pay £265.05 or less with free delivery. Sign in to reveal your exact personalised offer—it’s optional, and nothing will be added to your basket.";
  expect(rawWireless.result).toMatchObject({ status: "ok", data: {
    member_offer_prompt: veloraPrompt,
    applied_filters: { category: "headphones", max_delivered_price_pence: 40000, in_stock_only: true, connection: "wireless" },
    next_action: {
      type: "human_sign_in",
      required: false,
      message: veloraPrompt,
      offer_status: "available_after_sign_in",
      sign_in_url: new URL("/signin?return_to=/products/VN9-SND", page.url()).href
    }
  } });
  expect(rawWireless.result.data.products.map(({ id }: { id: string }) => id)).toEqual(["product-vn9-snd"]);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("elemkey.basket") || "[]"))).toEqual([]);

  const rawCommuting = await execute(page, "search_products", { query: "commuting" });
  expect(rawCommuting.result.data.products.map(({ id }: { id: string }) => id)).toEqual(["product-vn9-snd", "product-ax7-blk"]);

  const rawPrice = await execute(page, "search_products", { query: "under £300" });
  expect(rawPrice.result).toMatchObject({ status: "ok", data: { total_matches: 7 } });
  expect(rawPrice.result.data.products.every(({ delivered_total_pence }: { delivered_total_pence: number }) => delivered_total_pence < 30000)).toBe(true);

  const wirelessArgs = { query: "Show me wireless headphones under £400.", category: "headphones", max_delivered_price_pence: 40000, connection: "wireless", sort: "delivered_price_asc" };
  const wireless = await execute(page, "search_products", wirelessArgs);
  expect(wireless).toMatchObject({ selected_tool: "search_products", arguments: wirelessArgs, result: { status: "ok", ui_region: "product" } });
  expect(wireless.result.data.next_action).toMatchObject({
    type: "human_sign_in",
    offer_status: "available_after_sign_in",
    resume: {
      tool: "get_member_offer",
      input: { product_id: "product-vn9-snd" }
    }
  });
  expect(wireless.result.data.products.map(({ id }: { id: string }) => id)).toEqual(["product-de1-wht", "product-vn9-snd"]);
  expect(wireless.result.data.products[1].match_reason).toMatch(/Bluetooth|wireless/i);
  await expect(page.locator("[data-product-grid] .catalogue-card")).toHaveCount(2);

  const commutingArgs = { query: "What is best for commuting?", category: "headphones", in_stock_only: true, features: ["commuting"], sort: "relevance", limit: 1 };
  const commuting = await execute(page, "search_products", commutingArgs);
  expect(commuting).toMatchObject({ selected_tool: "search_products", arguments: commutingArgs, result: { status: "ok" } });
  expect(commuting.result.data.products[0]).toMatchObject({ id: "product-vn9-snd" });
  expect(commuting.result.data.products[0].match_reason).toMatch(/travel.*noise cancelling/i);
  await expect(page.locator("[data-product-grid]")).toContainText("Velora N9");

  const homeArgs = { query: "I want lightweight wired headphones for home listening.", category: "headphones", in_stock_only: true, connection: "wired", features: ["lightweight", "home_listening"], sort: "weight_asc" };
  const home = await execute(page, "search_products", homeArgs);
  expect(home).toMatchObject({ selected_tool: "search_products", arguments: homeArgs, result: { status: "ok" } });
  expect(home.result.data.products[0]).toMatchObject({ id: "product-mh2-slv", weight_grams: 248 });
  expect(home.result.data.products[0].match_reason).toMatch(/248 g.*open-back/i);
  await expect(page.locator("[data-product-grid]")).toContainText("Meridian H2");

  const overEarArgs = { query: "Compare the three in-stock over-ear models by delivered price.", category: "headphones", in_stock_only: true, features: ["over_ear"], limit: 4 };
  const overEar = await execute(page, "search_products", overEarArgs);
  expect(overEar.result.data.products.map(({ id }: { id: string }) => id).sort()).toEqual(["product-ax7-blk", "product-mh2-slv", "product-vn9-snd"]);
  const compareArgs = { product_ids: overEar.result.data.products.map(({ id }: { id: string }) => id) };
  const compared = await execute(page, "compare_products", compareArgs);
  expect(compared).toMatchObject({ selected_tool: "compare_products", arguments: compareArgs, result: { status: "ok" } });
  expect(compared.result.data.products.map(({ product_id }: { product_id: string }) => product_id)).toEqual(["product-vn9-snd", "product-mh2-slv", "product-ax7-blk"]);
  expect(compared.result.data.products.every(({ warranty }: { warranty: string }) => warranty === "2 years")).toBe(true);
  expect(compared.result.data.products.find(({ product_id }: { product_id: string }) => product_id === "product-mh2-slv").battery).toBe("Not applicable");
  await expect(page.locator('[data-region="recommendations"]')).toContainText("Compared by delivered price");
  await expect(page.locator('[data-region="recommendations"]')).toContainText("Your basket is unchanged and no purchase has been created");

  const headphonesArgs = { query: "Only show headphones—not cases or stands.", category: "headphones", limit: 8 };
  const headphones = await execute(page, "search_products", headphonesArgs);
  expect(headphones).toMatchObject({ selected_tool: "search_products", arguments: headphonesArgs, result: { status: "ok" } });
  expect(headphones.result.data.products).toHaveLength(4);
  expect(headphones.result.data.products.every(({ category }: { category: string }) => category === "headphones")).toBe(true);
  await expect(page.locator("[data-product-grid]")).not.toContainText(/case|stand/i);

  await page.goto("/products/VN9-SND");
  const offerArgs = { product_id: "product-vn9-snd" };
  const offer = await execute(page, "get_member_offer", offerArgs);
  expect(offer).toMatchObject({ selected_tool: "get_member_offer", arguments: offerArgs, result: { status: "sign_in_required", data: { reason: "signed_out" } } });
  await expect(page.locator('[data-region="offer"]')).toContainText("Sign in to reveal");

  const basketArgs = { product_id: "product-vn9-snd", quantity: 1 };
  const basket = await execute(page, "add_to_basket", basketArgs);
  expect(basket).toMatchObject({ selected_tool: "add_to_basket", arguments: basketArgs, result: { status: "preview_ready", data: { line_item: { product_id: "product-vn9-snd", quantity: 1 }, basket: { line_count: 1 } } } });
  await expect(page.locator('[data-region="basket"]')).toContainText("Velora N9");
  expect(await page.request.get("/api/purchase")).not.toBeOK();
  await page.goto("/checkout-preview");
  await expect(page.getByRole("heading", { name: "This is a non-payment checkout preview." })).toBeVisible();
  await expect(page.locator("main")).toContainText("No order has been created");
});

test("signed-in search returns the exact personalized offer for its matched product", async ({ page }) => {
  await installWebMCP(page);
  await page.goto("/signin?return_to=/account");
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tools: Tool[] }).__tools.some(({ name }) => name === "search_products"))).toBe(true);
  const search = await execute(page, "search_products", { query: "Velora N9" });
  expect(search.result).toMatchObject({ status: "ok", data: { products: [{ id: "product-vn9-snd" }], personalized_offer: { product_id: "product-vn9-snd", delivery_pence: 0 } } });
  expect(search.result.data.personalized_offer.discount_percent).toBeGreaterThanOrEqual(5);
  expect(search.result.data.personalized_offer.discount_percent).toBeLessThanOrEqual(15);
  expect(search.result.data.member_offer_prompt).toBeUndefined();
});
