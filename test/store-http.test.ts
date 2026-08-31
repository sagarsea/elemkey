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

test("retail routes, canonical products, and recovery are complete", async () => {
  const origin = await serve();
  for (const path of ["/", "/shop", "/account", "/policies/delivery", "/policies/returns", "/policies/member_offers", ...config.products.map(({ product_url }) => product_url)]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /Northmere Audio/, path);
  }
  const canonical = await fetch(`${origin}/products/ax7-blk`, { redirect: "manual" });
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.get("location"), "/products/AX7-BLK");
  const missing = await fetch(`${origin}/products/NOPE-1`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Return to the shop/);
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
    body: new URLSearchParams({ email: "sagar@example.test", password: "ElemKeyDemo2026!", request_token: token(signedOutHtml), return_to: "/account" })
  });
  jar = cookie(login);
  const account = await fetch(`${origin}/account`, { headers: { cookie: jar } });
  const html = await account.text();
  assert.match(html, /Active membership/);
  assert.match(html, /Order history is not part of this demonstration/);
  assert.match(html, /href="\/policies\/member_offers"/);
  assert.equal((html.match(/data-offer-product-id=/g) ?? []).length, 4);
  for (const sku of ["AX7-BLK", "VN9-SND", "FS8-WAL", "NT2-WAL"]) assert.equal((html.match(new RegExp(sku, "g")) ?? []).length, 1, sku);
  for (const sku of ["MH2-SLV", "DE1-WHT"]) assert.doesNotMatch(html, new RegExp(sku));
  assert.equal((html.match(/<article class="member-offer-row"/g) ?? []).length, 4);
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
  }
  assert.equal((await fetch(`${origin}/api/store/policies?topic=orders`)).status, 400);
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
  assert.doesNotMatch(html, /https?:\/\//);
  assert.equal(existsSync("public/favicon.svg"), true);
  assert.match(html, /href="\/favicon\.svg"/);
  const home = await (await fetch(origin)).text();
  for (const sku of ["AX7-BLK", "FS8-WAL", "NT2-WAL", "AS1-BLK"]) assert.match(home, new RegExp(sku));
  const css = readFileSync("public/styles.css", "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width:\s*760px\)/);
});
