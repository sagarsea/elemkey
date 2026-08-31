import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateOffer, loadConfig, searchProducts } from "../src/domain";

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

test("catalogue search preserves best match and adds deterministic complete results", () => {
  const cfg = config();
  const ax7 = searchProducts({ query: "AX7-BLK" }, cfg.products, instant);
  assert.equal(ax7.status, "ok");
  assert.equal(ax7.data?.product?.id, "product-ax7-blk");
  assert.deepEqual(ax7.data?.products?.map(({ id }) => id), ["product-ax7-blk"]);

  const headphones = searchProducts({ query: "", category: "headphones", sort: "price_asc" }, cfg.products, instant);
  assert.deepEqual(headphones.data?.products?.map(({ sku }) => sku), ["DE1-WHT", "VN9-SND", "MH2-SLV", "AX7-BLK"]);
  const filtered = searchProducts({ max_price_pence: 25000, in_stock_only: true, sort: "price_desc" }, cfg.products, instant);
  assert.deepEqual(filtered.data?.products?.map(({ sku }) => sku), ["TD3-SLV", "HO1-CRM", "BC2-BLK", "HC1-GRY", "AS1-BLK", "SP3-BLK"]);
  assert.equal(searchProducts({ category: "unknown" }, cfg.products, instant).status, "invalid_input");
  assert.equal(searchProducts({ max_price_pence: 1.5 }, cfg.products, instant).status, "invalid_input");
  assert.equal(searchProducts({ in_stock_only: "true" }, cfg.products, instant).status, "invalid_input");
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
