import { expect, test } from "@playwright/test";

test("WebMCP verifies a visible decision receipt without purchasing or sharing comparison context", async ({ page }) => {
  await page.addInitScript(() => {
    const registrations: Array<Record<string, unknown>> = [];
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool: Record<string, unknown>) { registrations.push(tool); } }, configurable: true });
    Object.defineProperty(window, "__registrations", { value: registrations });
  });
  await page.goto("/signin?return_to=/products/AX7-BLK");
  await page.getByLabel("Email").fill("sagar@example.test");
  await page.getByLabel("Password").fill("ElemKeyDemo2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __registrations: Array<{ name: string }> }).__registrations.some(({ name }) => name === "verify_purchase_terms"))).toBe(true);

  const tools = await page.evaluate(() => (window as unknown as { __registrations: Array<Record<string, unknown>> }).__registrations.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })));
  expect(tools.find(({ name }) => name === "verify_purchase_terms")).toMatchObject({ annotations: { readOnlyHint: true, untrustedContentHint: false }, inputSchema: { additionalProperties: false, required: ["product_id", "offer_quote", "quantity"] } });

  const result = await page.evaluate(async () => {
    const registrations = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<any> }> }).__registrations;
    const offer = await registrations.find(({ name }) => name === "get_member_offer")!.execute({ product_id: "product-ax7-blk" });
    return registrations.find(({ name }) => name === "verify_purchase_terms")!.execute({ product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 1 });
  });
  expect(result).toMatchObject({ status: "verified", data: { product: { sku: "AX7-BLK", variant: "Black" }, terms: { delivered_total_pence: 42914, delivery_estimate: "Arrives Tuesday" }, privacy: { credentials_shared: false, competitor_data_shared: false, purchase_created: false } } });
  const receipt = page.locator('[data-region="purchase_terms"]');
  await expect(receipt).toContainText("Merchant-verified purchase terms");
  await expect(receipt).toContainText("AX7-BLK");
  await expect(receipt).toContainText("Black");
  await expect(receipt).toContainText(/429\.14/);
  await expect(receipt).toContainText("Arrives Tuesday");
  await expect(receipt).toContainText("30-day returns");
  await expect(receipt).toContainText("No purchase has been created");
});
