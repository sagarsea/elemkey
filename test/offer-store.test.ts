import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { loadConfig } from "../src/domain";
import { OfferStore, OfferValidationError, VersionConflictError, offerPhase, personalizedDiscountPercent, selectMemberOffer } from "../src/offer-store";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = loadConfig({ SESSION_COOKIE_SECRET: secret(41), OFFER_TOKEN_SECRET: secret(42), MEMBER_BINDING_SECRET: secret(43) });
const roots: string[] = [];
const instant = new Date("2026-08-30T10:00:00.000Z");
const store = () => {
  mkdirSync("data", { recursive: true });
  const root = mkdtempSync("data/offer-store-test-");
  roots.push(root);
  const path = `${root}/offers.json`;
  return { path, root, store: OfferStore.open(path, config.productsById, config.membersById, config.rules, instant) };
};
const draft = (overrides: Record<string, unknown> = {}) => ({
  name: "Test offer", product_ids: ["product-mh2-slv"], audience: { type: "all" }, discount_percent: 10,
  delivery_pence: null, status: "active", starts_at: null, ends_at: null, ...overrides
});
afterEach(() => { for (const root of roots.splice(0)) { chmodSync(root, 0o755); rmSync(root, { recursive: true, force: true }); } });

test("seeds once, reloads authoritative revisions, detects corruption, and keeps writes atomic", async () => {
  const fixture = store();
  assert.equal(fixture.store.version, 1);
  assert.deepEqual(fixture.store.current()[0].product_ids, config.products.map(({ id }) => id));
  await fixture.store.create(draft(), 1, "owner-northmere-1", instant);
  assert.equal(OfferStore.open(fixture.path, config.productsById, config.membersById, config.rules).version, 2);

  const original = readFileSync(fixture.path, "utf8");
  chmodSync(fixture.root, 0o555);
  await assert.rejects(() => fixture.store.create(draft({ name: "Cannot persist" }), 2, "owner-northmere-1", instant));
  assert.equal(readFileSync(fixture.path, "utf8"), original);
  assert.equal(fixture.store.version, 2);
  chmodSync(fixture.root, 0o755);

  writeFileSync(fixture.path, "{broken");
  assert.throws(() => OfferStore.open(fixture.path, config.productsById, config.membersById, config.rules), /JSON|offer data/i);
  assert.equal(readFileSync(fixture.path, "utf8"), "{broken");
});

test("validates complete drafts and preserves immutable revision history with optimistic writes", async () => {
  const fixture = store();
  for (const invalid of [
    draft({ product_ids: [] }), draft({ product_ids: ["unknown"] }), draft({ product_ids: ["product-mh2-slv", "product-mh2-slv"] }),
    draft({ audience: { type: "member_ids", member_ids: ["unknown"] } }), draft({ discount_percent: 101 }), draft({ discount_percent: 0, delivery_pence: null }),
    draft({ starts_at: "2026-08-31T10:00:00.000Z", ends_at: "2026-08-31T10:00:00.000Z" })
  ]) assert.throws(() => fixture.store.validate(invalid), OfferValidationError);

  const created = await fixture.store.create(draft(), 1, "owner-northmere-1", instant);
  const revised = await fixture.store.revise(created.offer_id, draft({ discount_percent: 12 }), 2, "owner-northmere-1", new Date(instant.getTime() + 1000));
  assert.equal(revised.version, 2);
  assert.equal(fixture.store.all().filter(({ offer_id }) => offer_id === created.offer_id).length, 2);
  await assert.rejects(() => fixture.store.setStatus(created.offer_id, "inactive", 2, "owner-northmere-1"), VersionConflictError);
  await fixture.store.setStatus(created.offer_id, "archived", 3, "owner-northmere-1");
  await assert.rejects(() => fixture.store.setStatus(created.offer_id, "active", 4, "owner-northmere-1"), OfferValidationError);
  await assert.rejects(() => fixture.store.revise(created.offer_id, draft(), 4, "owner-northmere-1"), OfferValidationError);
});

test("applies inclusive starts, exclusive ends, every audience, and deterministic best-total ties", async () => {
  const fixture = store();
  const standard = config.membersById.get("member-demo-1")!;
  const vip = config.membersById.get("member-demo-vip")!;
  const product = config.productsById.get("product-mh2-slv")!;
  const scheduled = await fixture.store.create(draft({ name: "VIP window", audience: { type: "tier", tier: "vip" }, discount_percent: 20, starts_at: "2026-08-30T10:00:00.000Z", ends_at: "2026-08-30T11:00:00.000Z" }), 1, "owner-northmere-1", instant);
  assert.equal(offerPhase(scheduled, new Date("2026-08-30T09:59:59.999Z")), "scheduled");
  assert.equal(selectMemberOffer(product, standard, fixture.store.all(), instant)?.rule_id, "MEMBER-5-FREE");
  assert.equal(selectMemberOffer(product, vip, fixture.store.all(), instant)?.rule_id, scheduled.offer_id);
  assert.equal(offerPhase(scheduled, new Date("2026-08-30T11:00:00.000Z")), "expired");

  const individual = await fixture.store.create(draft({ name: "Individual", audience: { type: "member_ids", member_ids: [standard.id] }, discount_percent: 20 }), 2, "owner-northmere-1", instant);
  assert.equal(selectMemberOffer(product, standard, fixture.store.all(), instant)?.rule_id, individual.offer_id);
  const tieA = await fixture.store.create(draft({ name: "Tie A", audience: { type: "member_ids", member_ids: [standard.id] }, discount_percent: 25, product_ids: [product.id, "product-cc4-blk"] }), 3, "owner-northmere-1", instant);
  const tieB = await fixture.store.create(draft({ name: "Tie B", audience: { type: "member_ids", member_ids: [standard.id] }, discount_percent: 25, product_ids: [product.id] }), 4, "owner-northmere-1", instant);
  assert.equal(selectMemberOffer(product, standard, fixture.store.all(), instant)?.rule_id, [tieA.offer_id, tieB.offer_id].sort()[0]);
});

test("personalized baseline discounts are stable and stay between five and fifteen percent", () => {
  const standard = config.membersById.get("member-demo-1")!;
  const vip = config.membersById.get("member-demo-vip")!;
  const standardDiscounts = config.products.map((product) => personalizedDiscountPercent(standard.id, product.id));
  assert.equal(standardDiscounts.every((discount) => discount >= 5 && discount <= 15), true);
  assert.deepEqual(standardDiscounts, config.products.map((product) => personalizedDiscountPercent(standard.id, product.id)));
  assert.notDeepEqual(standardDiscounts, config.products.map((product) => personalizedDiscountPercent(vip.id, product.id)));
});
