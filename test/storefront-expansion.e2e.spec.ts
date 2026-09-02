import { expect, test } from "@playwright/test";

test("shop filters sixteen products and public basket lines stay unique and removable", async ({ page }) => {
  await page.goto("/shop");
  await expect(page.locator("[data-product-grid] .catalogue-card")).toHaveCount(16);
  await page.getByLabel("Category").selectOption("headphones");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.locator("[data-product-grid] .catalogue-card")).toHaveCount(4);
  await page.goto("/products/TD3-SLV");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("Tide D3");
  await page.goto("/products/HO1-CRM");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await page.getByRole("button", { name: "Add to basket" }).click();
  await page.goto("/basket");
  await expect(page.locator(".basket-line")).toHaveCount(2);
  await expect(page.locator('[data-region="basket"]')).toContainText("£484.98");
  await page.getByRole("button", { name: "Remove HO1-CRM" }).click();
  await expect(page.locator(".basket-line")).toHaveCount(1);
});

test("sign-in returns to the originating product and member price upgrades its public line", async ({ page }) => {
  await page.goto("/products/VN9-SND");
  await page.getByRole("button", { name: "Add to basket" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("£288.99");
  await page.getByRole("link", { name: "Sign in yourself" }).click();
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/products\/VN9-SND/);
  await page.getByRole("button", { name: "Get my member offer" }).click();
  await expect(page.locator('[data-region="offer"]')).toContainText("£265.05");
  await page.getByRole("button", { name: "Prepare basket for review" }).click();
  await expect(page.locator('[data-region="basket"]')).toContainText("£265.05");
  await page.goto("/basket");
  await expect(page.locator(".basket-line")).toHaveCount(1);
  await expect(page.locator('[data-region="basket"]')).toContainText("£265.05");
});

test("WebMCP tools are additive, exact, lifecycle-bound, and page scoped", async ({ page }) => {
  await page.addInitScript(() => {
    const registrations: Array<Record<string, unknown>> = [];
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool: Record<string, unknown>, lifecycle: { signal: AbortSignal }) { registrations.push({ ...tool, hasSignal: lifecycle.signal instanceof AbortSignal }); } }, configurable: true });
    Object.defineProperty(window, "__registrations", { value: registrations });
  });
  const names = async (path: string) => {
    await page.goto(path);
    return page.evaluate(() => (window as unknown as { __registrations: Array<{ name: string }> }).__registrations.map(({ name }) => name).sort());
  };
  expect(await names("/")).toEqual(["compare_products", "get_store_policies", "search_products", "view_basket", "view_product"]);
  expect(await names("/shop")).toEqual(["add_to_basket", "compare_products", "filter_products", "get_store_policies", "get_visible_results", "search_products", "view_basket", "view_product"]);
  expect(await names("/products/AX7-BLK")).toEqual(["add_to_basket", "compare_products", "get_member_offer", "get_product_details", "get_store_policies", "prepare_basket", "search_products", "verify_purchase_terms", "view_basket", "view_product"]);
  expect(await names("/basket")).toEqual(["compare_products", "get_store_policies", "remove_from_basket", "search_products", "view_basket", "view_product"]);
  expect(await names("/signin")).toEqual([]);
  expect(await names("/checkout-preview")).toEqual([]);
  await page.goto("/shop");
  const schemas = await page.evaluate(() => (window as unknown as { __registrations: Array<Record<string, unknown>> }).__registrations.map(({ name, inputSchema, annotations, hasSignal }) => ({ name, inputSchema, annotations, hasSignal })));
  for (const tool of schemas) {
    expect(tool.hasSignal).toBe(true);
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(tool.annotations).toMatchObject({ untrustedContentHint: false });
  }
});
