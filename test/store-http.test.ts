import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { after, afterEach, test } from "node:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/domain";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = loadConfig({ SESSION_COOKIE_SECRET: secret(31), OFFER_TOKEN_SECRET: secret(32), MEMBER_BINDING_SECRET: secret(33) });
const storePath = resolve(`data/store-http-test-${process.pid}.json`);
const servers: Server[] = [];
async function serve() {
  const server = createApp(config, { offerStorePath: storePath }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));
after(() => rmSync(storePath, { force: true }));
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const token = (html: string) => html.match(/<meta name="request-token" content="([^"]+)"/)?.[1] ?? "";
const releaseStageLanguage = /\b(?:demo|demonstration|staging|sandbox|prototype)\b/i;

test("retail routes, canonical products, and recovery are complete", async () => {
  const origin = await serve();
  for (const path of ["/", "/shop", "/account", "/signin", "/admin/signin", "/basket", "/checkout-preview", "/offer-rule", "/policies/delivery", "/policies/returns", "/policies/member_offers", ...config.products.map(({ product_url }) => product_url)]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /Northmere Audio/, path);
    assert.match(html, /Woking, Surrey/, path);
    assert.match(html, /since 2016/i, path);
    assert.doesNotMatch(html, releaseStageLanguage, path);
  }
  const canonical = await fetch(`${origin}/products/ax7-blk`, { redirect: "manual" });
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.get("location"), "/products/AX7-BLK");
  const missing = await fetch(`${origin}/products/NOPE-1`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Return to the shop/);
});

test("every HTML page includes Google Tag Manager at the document boundaries", async () => {
  const origin = await serve();
  const paths = ["/", "/shop", "/products/AX7-BLK", "/account", "/policies/delivery", "/signin", "/admin/signin", "/basket", "/checkout-preview", "/offer-rule"];
  for (const path of paths) {
    const html = await (await fetch(origin + path)).text();
    assert.match(html, /<head><!-- Google Tag Manager --><script>\(function\(w,d,s,l,i\)/, path);
    assert.match(html, /googletagmanager\.com\/gtm\.js\?id='\+i\+dl/, path);
    assert.match(html, /<body[^>]*><!-- Google Tag Manager \(noscript\) --><noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-5D5LMMGL"/, path);
  }
});

test("product pages expose canonical, descriptive, machine-readable merchant facts", async () => {
  const origin = await serve();
  const publicOrigin = "https://elemkey.onrender.com";
  for (const product of config.products) {
    const html = await (await fetch(origin + product.product_url)).text();
    assert.match(html, new RegExp(`<link rel="canonical" href="${publicOrigin}${product.product_url}">`), product.sku);
    const description = `${product.description} From Northmere Audio, an independent audio brand based in Woking, Surrey since 2016.`;
    assert.match(html, new RegExp(`<meta name="description" content="${description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`), product.sku);
    const json = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
    assert.ok(json, product.sku);
    assert.deepEqual(JSON.parse(json), {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.title,
      description: product.description,
      image: publicOrigin + product.image_url,
      sku: product.sku,
      model: product.model,
      color: product.variant,
      category: product.category,
      additionalProperty: Object.entries(product.specifications).map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
      offers: {
        "@type": "Offer",
        url: publicOrigin + product.product_url,
        priceCurrency: product.currency,
        price: (product.unit_price_pence / 100).toFixed(2),
        availability: `https://schema.org/${product.stock_quantity ? "InStock" : "OutOfStock"}`,
        itemCondition: "https://schema.org/NewCondition",
        seller: { "@type": "Organization", name: "Northmere Audio", foundingDate: "2016", address: { "@type": "PostalAddress", addressLocality: "Woking", addressRegion: "Surrey", addressCountry: "GB" } }
      }
    }, product.sku);
  }
});

test("account preserves signed-out copy and signed-in offers follow active rules", async () => {
  const origin = await serve();
  const signedOut = await fetch(`${origin}/account`);
  let jar = cookie(signedOut);
  const signedOutHtml = await signedOut.text();
  assert.match(signedOutHtml, /Membership, without the noise/);
  assert.match(signedOutHtml, /href="\/signin\?return_to=\/account"/);
  assert.doesNotMatch(signedOutHtml, /data-offer-product-id/);

  const login = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar, origin },
    body: new URLSearchParams({ email: "member@northmere.audio", password: "NorthmereMember2026!", request_token: token(signedOutHtml), return_to: "/account" })
  });
  jar = cookie(login);
  const account = await fetch(`${origin}/account`, { headers: { cookie: jar } });
  const html = await account.text();
  assert.match(html, /Active membership/);
  assert.match(html, /Order history is not currently available online/);
  assert.doesNotMatch(html, releaseStageLanguage);
  assert.match(html, /href="\/policies\/member_offers"/);
  assert.equal((html.match(/data-offer-product-id=/g) ?? []).length, config.products.length);
  for (const { sku } of config.products) assert.equal((html.match(new RegExp(sku, "g")) ?? []).length, 1, sku);
  assert.equal((html.match(/<article class="member-offer-row"/g) ?? []).length, config.products.length);
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length >= 4, true);
});

test("product, policy, and filtered catalogue APIs return public merchant data", async () => {
  const origin = await serve();
  const product = await (await fetch(`${origin}/api/products/product-fs8-wal`)).json();
  assert.equal(product.status, "ok");
  assert.equal(product.data.product.sku, "FS8-WAL");
  assert.equal("offer_quote" in product.data.product, false);
  const filtered = await (await fetch(`${origin}/api/products/search?category=speakers&max_price_pence=40000&in_stock_only=true&sort=price_asc`)).json();
  assert.deepEqual(filtered.data.products.map(({ sku }: { sku: string }) => sku), ["HO1-CRM", "CC4-BLK"]);
  for (const topic of ["delivery", "returns", "member_offers"]) {
    const policy = await (await fetch(`${origin}/api/store/policies?topic=${topic}`)).json();
    assert.equal(policy.status, "ok");
    assert.equal(policy.data.topic, topic);
    assert.doesNotMatch(JSON.stringify(policy), releaseStageLanguage);
  }
  assert.equal((await fetch(`${origin}/api/store/policies?topic=orders`)).status, 400);
});

test("structured search and comparison APIs expose compact recoverable shopper facts", async () => {
  const origin = await serve();
  const search = await (await fetch(`${origin}/api/products/search?query=${encodeURIComponent("What is best for commuting?")}&category=headphones&in_stock_only=true&features=commuting&sort=relevance&limit=1`)).json();
  assert.equal(search.status, "ok");
  assert.deepEqual(search.data.products.map(({ id }: { id: string }) => id), ["product-vn9-snd"]);
  assert.equal(search.data.products[0].member_offer_status, "available_after_sign_in");
  assert.deepEqual(search.data.products[0].member_offer_preview, {
    status: "guaranteed_after_sign_in",
    baseline_discount_percent: 5,
    personalized_discount_range_percent: { minimum: 5, maximum: 15 },
    maximum_member_total_pence: 26505,
    delivery_pence: 0,
    owner_targeted_offer_may_be_better: true
  });
  assert.match(search.data.products[0].match_reason, /travel|noise cancelling/i);
  assert.equal(JSON.stringify(search).length < 1500, true);

  const mixed = await (await fetch(`${origin}/api/products/search?query=${encodeURIComponent("Show me wireless headphones under £400.")}&category=headphones&max_delivered_price_pence=40000&connection=wireless&sort=delivered_price_asc`)).json();
  assert.deepEqual(mixed.data.products.map(({ id, member_offer_status }: { id: string; member_offer_status: string }) => [id, member_offer_status]), [
    ["product-de1-wht", "not_guaranteed"],
    ["product-vn9-snd", "available_after_sign_in"]
  ]);

  const compared = await fetch(`${origin}/api/products/compare`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ product_ids: ["product-ax7-blk", "product-mh2-slv", "product-vn9-snd"] })
  });
  assert.equal(compared.status, 200);
  const comparison = await compared.json();
  assert.deepEqual(comparison.data.products.map(({ product_id }: { product_id: string }) => product_id), ["product-vn9-snd", "product-mh2-slv", "product-ax7-blk"]);
  assert.equal(comparison.data.products.every(({ member_offer_status }: { member_offer_status: string }) => member_offer_status === "sign_in_required"), true);
  assert.equal(JSON.stringify(comparison).length < 1500, true);

  const invalid = await fetch(`${origin}/api/products/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_ids: ["product-vn9-snd"] }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_INPUT");
});

test("public basket preparation needs no sign-in but keeps quantity and trust boundaries", async () => {
  const origin = await serve();
  const page = await fetch(`${origin}/products/TD3-SLV`);
  const jar = cookie(page);
  const requestToken = token(await page.text());
  const headers = { "content-type": "application/json", cookie: jar, origin, "x-request-token": requestToken };
  const response = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-td3-slv", quantity: 1 }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "preview_ready");
  assert.deepEqual(body.data.line_item, { product_id: "product-td3-slv", sku: "TD3-SLV", quantity: 1, currency: "GBP", unit_price_pence: 24900, discount_pence: 0, delivery_pence: 699, delivered_total_pence: 25599, pricing: "public" });
  assert.deepEqual(body.data.basket, { line_count: 1, currency: "GBP", delivered_total_pence: 25599 });
  assert.equal((await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-td3-slv", quantity: 2 }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-de1-wht", quantity: 1 }) })).status, 200);
});

test("storefront assets and accessibility basics are local and complete", async () => {
  for (const product of config.products) {
    assert.equal(existsSync(`public${product.image_url}`), true, product.image_url);
    assert.equal(product.image_alt.length > product.model.length, true, product.sku);
  }
  const origin = await serve();
  const html = await (await fetch(`${origin}/shop`)).text();
  for (const landmark of ["<header", "<main", "<footer", "aria-label=\"Primary\"", "aria-label=\"Filter products\""]) assert.match(html, new RegExp(landmark));
  assert.match(html, /Skip to content/);
  assert.match(html, /<label>Category/);
  assert.deepEqual(html.match(/https?:\/\/[^'"<\s]+/g), [
    "https://www.googletagmanager.com/gtm.js?id=",
    "https://www.googletagmanager.com/ns.html?id=GTM-5D5LMMGL"
  ]);
  assert.equal(existsSync("public/favicon.svg"), true);
  assert.match(html, /href="\/favicon\.svg"/);
  const home = await (await fetch(origin)).text();
  for (const sku of ["AX7-BLK", "FS8-WAL", "NT2-WAL", "AS1-BLK"]) assert.match(home, new RegExp(sku));
  const css = readFileSync("public/styles.css", "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width:\s*760px\)/);
});
