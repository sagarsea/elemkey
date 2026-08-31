import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function signIn(context: BrowserContext, email: string, password: string) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/signin?return_to=/account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account/);
  return { page, errors };
}

test("Docker acceptance uses separate owner, standard-member, and VIP-member sessions", async ({ browser }) => {
  test.skip(process.env.MANUAL_ACCEPTANCE !== "1", "Run explicitly against the recreated Docker service");
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerErrors: string[] = [];
  owner.on("console", (message) => { if (message.type() === "error") ownerErrors.push(message.text()); });
  await owner.goto("/admin/signin");
  await owner.getByLabel("Owner email").fill("owner@northmere.test");
  await owner.getByLabel("Owner password").fill("NorthmereOwner2026!");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await expect(owner.locator("#admin-offer-list")).toContainText("Native Canary persistence proof");
  await owner.screenshot({ path: "test/docker-owner-acceptance.png", fullPage: true });

  const standardContext = await browser.newContext();
  const standard = await signIn(standardContext, "sagar@example.test", "ElemKeyDemo2026!");
  await expect(standard.page.locator('[data-offer-product-id="product-td3-slv"]')).toHaveCount(0);
  await standard.page.screenshot({ path: "test/docker-standard-member-acceptance.png", fullPage: true });

  const vipContext = await browser.newContext();
  const vip = await signIn(vipContext, "vip@northmere.test", "ElemKeyVip2026!");
  await vip.page.getByRole("button", { name: "Check offer for Tide D3 DAC" }).click();
  await expect(vip.page.locator('[data-offer-product-id="product-td3-slv"]')).toContainText("£219.12");
  await vip.page.screenshot({ path: "test/docker-vip-member-acceptance.png", fullPage: true });

  expect([...ownerErrors, ...standard.errors, ...vip.errors]).toEqual([]);
  await Promise.all([ownerContext.close(), standardContext.close(), vipContext.close()]);
});
