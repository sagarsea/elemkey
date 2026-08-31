import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, searchProducts, evaluateOffer, validateFixtures, validateSecrets } from "../src/domain";
import {
  authenticate,
  createMemberSession,
  issueOfferQuote,
  memberBinding,
  safeReturnTo,
  validateRequest,
  validateSession,
  verifyOfferQuote
} from "../src/security";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");

test("loads the locked catalogue, member hash, and active rule", () => {
  const config = loadConfig({
    SESSION_COOKIE_SECRET: secret(1),
    OFFER_TOKEN_SECRET: secret(2),
    MEMBER_BINDING_SECRET: secret(3)
  });
  assert.equal(config.product.sku, "AX7-BLK");
  assert.equal(config.product.unit_price_pence, 49900);
  assert.equal(config.member.email, "sagar@example.test");
  assert.equal("password" in config.member, false);
  assert.match(config.member.password_hash, /^[0-9a-f]{128}$/);
  assert.deepEqual(config.rule, {
    rule_id: "MEMBER-5-FREE",
    version: 1,
    status: "active",
    product_sku: "AX7-BLK",
    authenticated_customer: true,
    discount_percent: 5,
    delivery_pence: 0
  });
});

test("requires three distinct base64 secrets of at least 32 bytes", () => {
  assert.deepEqual(validateSecrets({
    SESSION_COOKIE_SECRET: secret(1),
    OFFER_TOKEN_SECRET: secret(2),
    MEMBER_BINDING_SECRET: secret(3)
  }).map((value) => value.length), [32, 32, 32]);

  for (const env of [
    {},
    { SESSION_COOKIE_SECRET: "not base64", OFFER_TOKEN_SECRET: secret(2), MEMBER_BINDING_SECRET: secret(3) },
    { SESSION_COOKIE_SECRET: Buffer.alloc(31).toString("base64"), OFFER_TOKEN_SECRET: secret(2), MEMBER_BINDING_SECRET: secret(3) },
    { SESSION_COOKIE_SECRET: secret(1), OFFER_TOKEN_SECRET: secret(1), MEMBER_BINDING_SECRET: secret(3) }
  ]) assert.throws(() => validateSecrets(env), /configuration/i);
});

test("fixture validation rejects unknown and malformed commercial properties", () => {
  const cfg = config();
  const fixture = { product: { ...cfg.product }, member: { ...cfg.member } };
  assert.throws(() => validateFixtures({ ...fixture, extra: true }, cfg.rule), /configuration/i);
  assert.throws(() => validateFixtures({ ...fixture, product: { ...fixture.product, unit_price_pence: 499.00 } }, cfg.rule), /configuration/i);
  assert.throws(() => validateFixtures(fixture, { ...cfg.rule, discount_percent: 101 }), /configuration/i);
  assert.throws(() => validateFixtures(fixture, { ...cfg.rule, version: 0 }), /configuration/i);
});

const config = () => loadConfig({
  SESSION_COOKIE_SECRET: secret(1),
  OFFER_TOKEN_SECRET: secret(2),
  MEMBER_BINDING_SECRET: secret(3)
});
const instant = new Date("2026-08-30T10:00:00.000Z");

test("search is case-insensitive across name, model, and SKU and validates shape", () => {
  for (const query of ["auralux x7 studio headphones", "AURALUX X7", "ax7-blk", "x7 studio"]) {
    const result = searchProducts({ query }, config().product, instant);
    assert.equal(result.status, "ok");
    assert.equal(result.data?.product?.id, "product-ax7-blk");
    assert.equal(result.data?.product?.delivered_total_pence, 51399);
  }
  assert.equal(searchProducts({ query: "speakers" }, config().product, instant).status, "empty");
  for (const input of [{}, { query: "" }, { query: "   " }, { query: "x".repeat(101) }, { query: "x", extra: true }]) {
    assert.equal(searchProducts(input, config().product, instant).status, "invalid_input");
  }
  assert.equal(searchProducts({ query: "x" }, config().product, instant).status, "ok");
  assert.equal(searchProducts({ query: "x".repeat(100) }, config().product, instant).status, "empty");
});

test("offer evaluation uses one exact integer-pence calculation", () => {
  const cfg = config();
  const offer = evaluateOffer("product-ax7-blk", true, cfg.product, cfg.rule, instant);
  assert.equal(offer.status, "eligible");
  if (offer.status !== "eligible") return;
  assert.equal(offer.snapshot.discount_pence, 2495);
  assert.equal(offer.snapshot.delivered_total_pence, 47405);
  assert.equal(offer.snapshot.delivery_pence, 0);

  assert.equal(evaluateOffer("wrong", true, cfg.product, cfg.rule, instant).status, "invalid_input");
  assert.equal(evaluateOffer("product-ax7-blk", false, cfg.product, cfg.rule, instant).status, "sign_in_required");
  assert.equal(evaluateOffer("product-ax7-blk", true, { ...cfg.product, stock_quantity: 0 }, cfg.rule, instant).status, "out_of_stock");
  assert.equal(evaluateOffer("product-ax7-blk", true, cfg.product, { ...cfg.rule, status: "inactive" }, instant).status, "ineligible");
  assert.equal(evaluateOffer("product-ax7-blk", true, cfg.product, { ...cfg.rule, product_sku: "OTHER" }, instant).status, "ineligible");
});

test("credentials, safe returns, and encrypted-session fields stay minimal", async () => {
  const cfg = config();
  assert.equal(await authenticate("sagar@example.test", "ElemKeyDemo2026!", cfg.member), true);
  assert.equal(await authenticate("sagar@example.test", "wrong", cfg.member), false);
  assert.equal(await authenticate("missing@example.test", "ElemKeyDemo2026!", cfg.member), false);
  assert.equal(safeReturnTo("/products/AX7-BLK"), "/products/AX7-BLK");
  for (const value of ["https://evil.test", "//evil.test", "/signin", "not-a-path", undefined]) {
    assert.equal(safeReturnTo(value), "/products/AX7-BLK");
  }
  const session = createMemberSession(cfg.member.id, instant);
  assert.deepEqual(Object.keys(session).sort(), ["issued_at", "last_seen_at", "member_id", "request_token", "session_nonce"]);
  assert.equal("email" in session, false);
  assert.equal("password" in session, false);
});

test("session timeout accepts exact boundaries and expires immediately after", () => {
  const session = createMemberSession("member-demo-1", instant);
  const at = (milliseconds: number) => new Date(instant.getTime() + milliseconds);
  assert.equal(validateSession(session, at(30 * 60_000)).active, true);
  assert.equal(validateSession(session, at(30 * 60_000 + 1)).reason, "session_expired");
  session.last_seen_at = at(7.5 * 60 * 60_000).toISOString();
  assert.equal(validateSession(session, at(8 * 60 * 60_000)).active, true);
  assert.equal(validateSession(session, at(8 * 60 * 60_000 + 1)).reason, "session_expired");
});

test("request token and Origin must both match", () => {
  assert.equal(validateRequest("https://shop.test", "token", "https://shop.test", "token"), true);
  for (const [origin, token] of [[undefined, "token"], ["https://evil.test", "token"], ["https://shop.test", undefined], ["https://shop.test", "wrong"]]) {
    assert.equal(validateRequest(origin, token, "https://shop.test", "token"), false);
  }
});

test("offer quote is five-minute, bound, tamper-resistant, capped, and freshness checked", () => {
  const cfg = config();
  const memberSession = createMemberSession(cfg.member.id, instant);
  const offer = evaluateOffer("product-ax7-blk", true, cfg.product, cfg.rule, instant);
  assert.equal(offer.status, "eligible");
  if (offer.status !== "eligible") return;
  const quote = issueOfferQuote(offer.snapshot, memberSession, cfg.secrets.offer, cfg.secrets.binding, instant);
  const [payload] = quote.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(claims).sort(), ["currency", "delivered_total_pence", "delivery_pence", "discount_pence", "discount_percent", "expires_at", "issued_at", "member_binding", "product_id", "rule_id", "rule_version", "sku", "stock_quantity", "unit_price_pence"]);
  assert.equal(new Date(claims.expires_at).getTime() - new Date(claims.issued_at).getTime(), 5 * 60_000);
  assert.equal(claims.member_binding, memberBinding(memberSession, cfg.secrets.binding));

  assert.equal(verifyOfferQuote(quote, memberSession, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, new Date(instant.getTime() + 5 * 60_000)).status, "valid");
  assert.equal(verifyOfferQuote(quote, memberSession, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, new Date(instant.getTime() + 5 * 60_000 + 1)).status, "expired");
  assert.equal(verifyOfferQuote(`${payload}.bad`, memberSession, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "invalid");
  assert.equal(verifyOfferQuote(`${quote}x`, memberSession, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "invalid");
  assert.equal(verifyOfferQuote("x".repeat(2049), memberSession, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "invalid");
  assert.equal(verifyOfferQuote(quote, { ...memberSession, session_nonce: "other" }, cfg.product, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "invalid");
  assert.equal(verifyOfferQuote(quote, memberSession, { ...cfg.product, unit_price_pence: 50000 }, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "stale");
  assert.equal(verifyOfferQuote(quote, memberSession, cfg.product, { ...cfg.rule, version: 2 }, cfg.secrets.offer, cfg.secrets.binding, instant).status, "stale");
  assert.equal(verifyOfferQuote(quote, memberSession, { ...cfg.product, stock_quantity: 0 }, cfg.rule, cfg.secrets.offer, cfg.secrets.binding, instant).status, "out_of_stock");
});
