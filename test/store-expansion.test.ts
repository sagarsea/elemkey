import assert from "node:assert/strict";
import { test } from "node:test";
import { compareProducts, evaluateOffer, loadConfig, searchProducts } from "../src/domain";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = () => loadConfig({
  SESSION_COOKIE_SECRET: secret(21),
  OFFER_TOKEN_SECRET: secret(22),
  MEMBER_BINDING_SECRET: secret(23)
});
const instant = new Date("2026-08-30T10:00:00.000Z");

test("catalogue contains sixteen complete, unique, immutable products", () => {
  const products = config().products;
  assert.equal(products.length, 16);
  assert.deepEqual(Object.fromEntries(["headphones", "speakers", "sources", "accessories"].map((category) => [category, products.filter((product) => product.category === category).length])), {
    headphones: 4, speakers: 4, sources: 4, accessories: 4
  });
  for (const key of ["id", "sku", "product_url", "image_url"] as const) assert.equal(new Set(products.map((product) => product[key])).size, 16);
  for (const product of products) {
    assert.equal(product.currency, "GBP");
    assert.equal(Number.isInteger(product.unit_price_pence) && product.unit_price_pence > 0, true);
    assert.equal(Number.isInteger(product.stock_quantity) && product.stock_quantity >= 0, true);
    assert.match(product.image_url, /^\/images\/[a-z0-9-]+\.svg$/);
    assert.equal(Object.keys(product.specifications).length >= 3, true);
    assert.equal(Object.isFrozen(product), true);
  }
  assert.throws(() => { (products as unknown as unknown[]).push({}); }, TypeError);
});

test("catalogue search preserves best match and adds deterministic compact results", () => {
  const cfg = config();
  const ax7 = searchProducts({ query: "AX7-BLK" }, cfg.products, instant);
  assert.equal(ax7.status, "ok");
  assert.equal(ax7.data?.products[0]?.id, "product-ax7-blk");
  assert.deepEqual(ax7.data?.products?.map(({ id }) => id), ["product-ax7-blk"]);

  const headphones = searchProducts({ query: "", category: "headphones", sort: "price_asc" }, cfg.products, instant);
  assert.deepEqual(headphones.data?.products?.map(({ sku }) => sku), ["DE1-WHT", "VN9-SND", "MH2-SLV", "AX7-BLK"]);
  const filtered = searchProducts({ max_price_pence: 25000, in_stock_only: true, sort: "price_desc" }, cfg.products, instant);
  assert.deepEqual(filtered.data?.products?.map(({ sku }) => sku), ["TD3-SLV", "HO1-CRM", "BC2-BLK", "HC1-GRY", "AS1-BLK", "SP3-BLK"]);
  assert.equal(searchProducts({ category: "unknown" }, cfg.products, instant).status, "invalid_input");
  assert.equal(searchProducts({ max_price_pence: 1.5 }, cfg.products, instant).status, "invalid_input");
  assert.equal(searchProducts({ in_stock_only: "true" }, cfg.products, instant).status, "invalid_input");
});

test("shopper prompts produce compact explainable searches and one delivered-price comparison", () => {
  const cfg = config();
  const wireless = searchProducts({
    query: "Show me wireless headphones under £400.", category: "headphones",
    max_delivered_price_pence: 40000, connection: "wireless", sort: "delivered_price_asc"
  }, cfg.products, instant);
  assert.deepEqual(wireless.data?.products.map(({ id }) => id), ["product-de1-wht", "product-vn9-snd"]);
  assert.equal("product" in (wireless.data ?? {}), false);
  assert.equal("specifications" in (wireless.data?.products[0] ?? {}), false);
  assert.match(wireless.data?.products[1]?.match_reason ?? "", /wireless|Bluetooth/i);

  const commuting = searchProducts({
    query: "What is best for commuting?", category: "headphones", in_stock_only: true,
    features: ["commuting"], sort: "relevance", limit: 1
  }, cfg.products, instant);
  assert.deepEqual(commuting.data?.products.map(({ id }) => id), ["product-vn9-snd"]);
  assert.match(commuting.data?.products[0]?.match_reason ?? "", /travel|noise cancelling/i);

  const home = searchProducts({
    query: "I want lightweight wired headphones for home listening.", category: "headphones",
    in_stock_only: true, connection: "wired", features: ["lightweight", "home_listening"], sort: "weight_asc"
  }, cfg.products, instant);
  assert.deepEqual(home.data?.products.map(({ id }) => id), ["product-mh2-slv"]);
  assert.match(home.data?.products[0]?.match_reason ?? "", /248 g.*open-back|open-back.*248 g/i);

  const headphonesOnly = searchProducts({
    query: "Only show headphones—not cases or stands.", category: "headphones", limit: 8
  }, cfg.products, instant);
  assert.equal(headphonesOnly.data?.products.length, 4);
  assert.equal(headphonesOnly.data?.products.every(({ category }) => category === "headphones"), true);

  const rawWireless = searchProducts({ query: "wireless headphones under £400" }, cfg.products, instant);
  assert.equal(rawWireless.status, "ok");
  if (rawWireless.status !== "ok") assert.fail();
  assert.deepEqual(rawWireless.data?.products.map(({ id }) => id), ["product-vn9-snd"]);
  assert.deepEqual(rawWireless.data?.applied_filters, { category: "headphones", max_delivered_price_pence: 40000, in_stock_only: true, connection: "wireless", sort: "delivered_price_asc" });

  const rawCommuting = searchProducts({ query: "commuting" }, cfg.products, instant);
  assert.equal(rawCommuting.status, "ok");
  if (rawCommuting.status !== "ok") assert.fail();
  assert.deepEqual(rawCommuting.data?.products.map(({ id }) => id), ["product-vn9-snd", "product-ax7-blk"]);
  assert.deepEqual(rawCommuting.data?.applied_filters, { category: "headphones", in_stock_only: true, features: ["commuting"], sort: "relevance" });

  const rawPrice = searchProducts({ query: "under £300" }, cfg.products, instant);
  assert.equal(rawPrice.status, "ok");
  assert.equal(rawPrice.data?.total_matches, 7);
  assert.equal(rawPrice.data?.products.every(({ delivered_total_pence }) => delivered_total_pence < 30000), true);

  const compared = compareProducts([
    "product-ax7-blk", "product-mh2-slv", "product-vn9-snd"
  ], cfg.products, () => "sign_in_required", instant);
  assert.deepEqual(compared.data?.products.map(({ product_id, delivered_price_pence }) => ({ product_id, delivered_price_pence })), [
    { product_id: "product-vn9-snd", delivered_price_pence: 28899 },
    { product_id: "product-mh2-slv", delivered_price_pence: 35899 },
    { product_id: "product-ax7-blk", delivered_price_pence: 51399 }
  ]);
  assert.deepEqual(compared.data?.products.map(({ member_offer_status }) => member_offer_status), ["sign_in_required", "sign_in_required", "sign_in_required"]);
  assert.deepEqual(compared.data?.products.map(({ weight_grams }) => weight_grams), [262, 248, 286]);
  assert.equal(compared.data?.products[0]?.noise_control, "Hybrid noise cancelling");
  assert.equal(compared.data?.products.every(({ warranty }) => warranty === "2 years"), true);
  assert.equal(compared.data?.products.find(({ product_id }) => product_id === "product-mh2-slv")?.battery, "Not applicable");
});

test("member offers cover the four active SKUs without changing AX7 arithmetic", () => {
  const cfg = config();
  for (const sku of ["AX7-BLK", "VN9-SND", "FS8-WAL", "NT2-WAL"]) {
    const product = cfg.productsBySku.get(sku)!;
    const rule = cfg.rules.find((candidate) => candidate.product_sku === sku);
    assert.equal(evaluateOffer(product.id, true, product, rule, instant).status, "eligible");
  }
  const ax7 = evaluateOffer("product-ax7-blk", true, cfg.product, cfg.rule, instant);
  assert.equal(ax7.status, "eligible");
  if (ax7.status === "eligible") assert.equal(ax7.snapshot.delivered_total_pence, 47405);
  const noRule = cfg.productsBySku.get("MH2-SLV")!;
  assert.equal(evaluateOffer(noRule.id, true, noRule, undefined, instant).status, "ineligible");
  const unavailable = cfg.productsBySku.get("DE1-WHT")!;
  assert.equal(evaluateOffer(unavailable.id, false, unavailable, undefined, instant).status, "out_of_stock");
  assert.equal(evaluateOffer("unknown", true, undefined, undefined, instant).status, "invalid_input");
});
