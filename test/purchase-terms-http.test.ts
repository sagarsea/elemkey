import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { after, afterEach, test } from "node:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/domain";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = loadConfig({ SESSION_COOKIE_SECRET: secret(41), OFFER_TOKEN_SECRET: secret(42), MEMBER_BINDING_SECRET: secret(43) });
const storePath = resolve(`data/purchase-terms-http-test-${process.pid}.json`);
const servers: Server[] = [];

async function serve(now: Date) {
  const server = createApp(config, { now: () => now, offerStorePath: storePath }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))));
after(() => rmSync(storePath, { force: true }));
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const token = (html: string) => html.match(/<meta name="request-token" content="([^"]+)"/)?.[1] ?? "";

test("verified purchase terms bind exact merchant facts to the current member quote", async () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  const origin = await serve(now);
  const page = await fetch(`${origin}/products/AX7-BLK`);
  const guest = cookie(page);
  const requestToken = token(await page.text());

  const signedOut = await fetch(`${origin}/api/purchase-terms/verify`, {
    method: "POST", headers: { "content-type": "application/json", cookie: guest },
    body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: "not-a-quote", quantity: 1 })
  });
  assert.equal(signedOut.status, 200);
  assert.equal((await signedOut.json()).status, "sign_in_required");

  const login = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guest, origin },
    body: new URLSearchParams({ email: "sagar@example.test", password: "ElemKeyDemo2026!", request_token: requestToken, return_to: "/products/AX7-BLK" })
  });
  let jar = cookie(login);
  const offerResponse = await fetch(`${origin}/api/offers/evaluate`, {
    method: "POST", headers: { "content-type": "application/json", cookie: jar },
    body: JSON.stringify({ product_id: "product-ax7-blk" })
  });
  jar = cookie(offerResponse) || jar;
  const offer = await offerResponse.json();
  const verified = await fetch(`${origin}/api/purchase-terms/verify`, {
    method: "POST", headers: { "content-type": "application/json", cookie: jar },
    body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 1 })
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    status: "verified", observed_at: now.toISOString(),
    data: {
      merchant: "Northmere Audio",
      product: { product_id: "product-ax7-blk", title: "Auralux X7 Studio Headphones", sku: "AX7-BLK", variant: "Black", quantity: 1 },
      terms: {
        currency: "GBP", unit_price_pence: 49900, public_delivery_pence: 1499, public_delivered_total_pence: 51399,
        discount_pence: 2495, member_delivery_pence: 0, delivered_total_pence: 47405, savings_pence: 3994,
        stock_status: "in_stock", stock_quantity: 10, delivery_estimate: "Arrives Tuesday",
        returns: { window_days: 30, summary: "Unused products may be returned within 30 days in their original condition and packaging. This demonstration does not start or track returns." },
        warranty: { status: "provided", summary: "2 years" }
      },
      benefit: { rule_id: "MEMBER-5-FREE", rule_version: 1, reason: "Signed-in members receive 5% off and free delivery." },
      verified_at: now.toISOString(), valid_until: "2026-08-30T10:05:00.000Z",
      privacy: { credentials_shared: false, competitor_data_shared: false, purchase_created: false }
    },
    error: null, ui_region: "purchase_terms"
  });

  const altered = await fetch(`${origin}/api/purchase-terms/verify`, {
    method: "POST", headers: { "content-type": "application/json", cookie: jar },
    body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: `${offer.data.offer_quote}x`, quantity: 1 })
  });
  assert.equal(altered.status, 400);
  assert.equal((await altered.json()).status, "invalid_quote");
});
