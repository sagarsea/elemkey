import { expect, test, type Page } from "@playwright/test";

const captureTools = (page: Page) => page.addInitScript(() => {
  const registrations: Array<Record<string, unknown>> = [];
  Object.defineProperty(document, "modelContext", { value: { registerTool(tool: Record<string, unknown>, lifecycle: { signal: AbortSignal }) { registrations.push({ ...tool, hasSignal: lifecycle.signal instanceof AbortSignal }); } }, configurable: true });
  Object.defineProperty(window, "__registrations", { value: registrations });
});
async function ownerSignIn(page: Page) {
  await page.goto("/admin/signin");
  await page.getByLabel("Owner email").fill("owner@northmere.audio");
  await page.getByLabel("Owner password").fill("NorthmereOwner2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/offers/);
  await page.waitForLoadState("load");
}

test("owner sign-in exposes no tools and the owner workspace exposes exactly five lifecycle-bound tools", async ({ page }) => {
  await captureTools(page);
  await page.goto("/admin/signin");
  expect(await page.evaluate(() => (window as unknown as { __registrations: unknown[] }).__registrations.length)).toBe(0);
  await page.getByLabel("Owner email").fill("owner@northmere.audio");
  await page.getByLabel("Owner password").fill("NorthmereOwner2026!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/offers/);
  await page.waitForLoadState("load");
  const tools = await page.evaluate(() => (window as unknown as { __registrations: Array<{ name: string; annotations: unknown; hasSignal: boolean }> }).__registrations.map(({ name, annotations, hasSignal }) => ({ name, annotations, hasSignal })));
  expect(tools.map(({ name }) => name)).toEqual(["list_member_offers", "preview_member_offer", "create_member_offer", "revise_member_offer", "set_member_offer_status"]);
  expect(tools.every(({ hasSignal }) => hasSignal)).toBe(true);
  expect(tools.find(({ name }) => name === "list_member_offers")?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.find(({ name }) => name === "create_member_offer")?.annotations).toMatchObject({ readOnlyHint: false });
});

test("human form and WebMCP functions share normalized preview, visible list, failure recovery, and safe traces", async ({ page }) => {
  await captureTools(page);
  await ownerSignIn(page);
  await page.getByLabel("Internal name").fill("Human VIP offer");
  await page.getByLabel(/Meridian H2 Headphones/).check();
  await page.getByLabel("Audience").selectOption("tier");
  await page.locator('[name="tier"]').selectOption("vip");
  await page.getByLabel("Discount percent").fill("20");
  await page.locator('[name="delivery_mode"]').selectOption("override");
  await page.locator('[name="delivery_pence"]').fill("0");
  await page.getByRole("button", { name: "Preview offer" }).click();
  await expect(page.locator('[data-region="admin_preview"]')).toContainText("£279.20");
  await page.getByRole("button", { name: "Confirm and create" }).click();
  await expect(page.locator('[data-region="admin_offers"]')).toContainText("Offer created.");
  await expect(page.locator("#admin-offer-list")).toContainText("Human VIP offer");

  await page.route("**/api/admin/offers/preview", (route) => route.abort());
  await page.getByLabel("Internal name").fill("Network failure");
  await page.getByLabel(/Tide D3 DAC/).check();
  await page.getByRole("button", { name: "Preview offer" }).click();
  await expect(page.locator('[data-region="admin_preview"]')).toContainText("request could not be completed");
  await expect(page.getByRole("button", { name: /Confirm/ })).toBeDisabled();
  await page.unroute("**/api/admin/offers/preview");

  const listed = await page.evaluate(async () => {
    const tool = (window as unknown as { __registrations: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }).__registrations.find(({ name }) => name === "list_member_offers")!;
    return tool.execute({});
  }) as { status: string };
  expect(listed.status).toBe("ok");
  await expect(page.locator("#admin-offer-list")).toContainText("Human VIP offer");
  const trace = await page.evaluate(() => sessionStorage.getItem("elemkey.trace") || "");
  expect(trace).not.toMatch(/owner@|NorthmereOwner|preview_token|offer-/i);
});
