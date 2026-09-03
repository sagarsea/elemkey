import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/domain";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = loadConfig({ SESSION_COOKIE_SECRET: secret(1), OFFER_TOKEN_SECRET: secret(2), MEMBER_BINDING_SECRET: secret(3) });
const servers: Server[] = [];

async function serve(options: Parameters<typeof createApp>[1] = {}) {
  const server = createApp(config, options).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const token = (html: string) => html.match(/<meta name="request-token" content="([^"]+)"/)?.[1] ?? "";

test("health, catalogue API, pages, and missing routes have stable contracts", async () => {
  const origin = await serve();
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: "ok" });

  const found = await fetch(`${origin}/api/products/search?query=ax7-blk`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).status, "ok");
  const invalid = await fetch(`${origin}/api/products/search?query=`);
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).error.code, "INVALID_INPUT");

  for (const path of ["/products/AX7-BLK", "/signin", "/basket", "/checkout-preview", "/offer-rule"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /Northmere Audio/);
  }
  assert.equal((await fetch(`${origin}/api/purchase`)).status, 404);
});

test("dynamic responses are private and static assets keep their own cache policy", async () => {
  const origin = await serve();
  for (const path of ["/", "/account", "/api/products/search?query=ax7", "/healthz", "/missing"]) {
    assert.equal((await fetch(origin + path)).headers.get("cache-control"), "private, no-store", path);
  }
  assert.notEqual((await fetch(`${origin}/styles.css`)).headers.get("cache-control"), "private, no-store");
});

test("sign-in is human-only, generic, same-origin protected, encrypted, and safely redirected", async () => {
  const origin = await serve({ secureCookie: true });
  const page = await fetch(`${origin}/signin?return_to=https://evil.test`);
  const guestCookie = cookie(page);
  const requestToken = token(await page.text());
  const setCookie = page.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /sagar|member-demo/i);

  const rejected = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guestCookie, origin: "https://evil.test" },
    body: new URLSearchParams({ email: "sagar@example.test", password: "wrong", request_token: requestToken, return_to: "https://evil.test" })
  });
  assert.equal(rejected.status, 403);
  assert.match(await rejected.text(), /Unable to sign in/);

  const accepted = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guestCookie, origin },
    body: new URLSearchParams({ email: "sagar@example.test", password: "ElemKeyDemo2026!", request_token: requestToken, return_to: "https://evil.test" })
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/products/AX7-BLK");
  assert.notEqual(cookie(accepted), guestCookie);
});

test("signed-out and signed-in offer envelopes feed a deterministic protected basket preview", async () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  const origin = await serve({ now: () => now });
  const productPage = await fetch(`${origin}/products/AX7-BLK`);
  let jar = cookie(productPage);
  let requestToken = token(await productPage.text());

  const signedOut = await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ product_id: "product-ax7-blk" }) });
  assert.equal(signedOut.status, 200);
  assert.deepEqual(await signedOut.json(), {
    status: "sign_in_required", observed_at: now.toISOString(),
    data: { product_id: "product-ax7-blk", reason: "signed_out", sign_in_url: "/signin?return_to=/products/AX7-BLK" },
    error: null, ui_region: "offer"
  });

  const login = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar, origin },
    body: new URLSearchParams({ email: "sagar@example.test", password: "ElemKeyDemo2026!", request_token: requestToken, return_to: "/products/AX7-BLK" })
  });
  jar = cookie(login);
  const refreshed = await fetch(`${origin}/products/AX7-BLK`, { headers: { cookie: jar } });
  jar = cookie(refreshed) || jar;
  requestToken = token(await refreshed.text());
  assert.notEqual(requestToken, token(await (await fetch(`${origin}/signin`, { headers: { cookie: cookie(productPage) } })).text()));

  const eligible = await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ product_id: "product-ax7-blk" }) });
  const offer = await eligible.json();
  assert.equal(offer.status, "eligible");
  assert.equal(offer.data.delivered_total_pence, 42914);
  assert.equal(offer.data.expires_at, "2026-08-30T10:05:00.000Z");

  const rejected = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers: { "content-type": "application/json", cookie: jar, origin }, body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 2 }) });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).status, "invalid_request");

  const headers = { "content-type": "application/json", cookie: jar, origin, "x-request-token": requestToken };
  const invalidQuantity = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 2 }) });
  assert.equal(invalidQuantity.status, 400);
  assert.equal((await invalidQuantity.json()).status, "invalid_input");

  for (let retry = 0; retry < 2; retry++) {
    const response = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: offer.data.offer_quote, quantity: 1 }) });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.status, "preview_ready");
    assert.equal(preview.data.line_item.delivered_total_pence, 42914);
    assert.equal(preview.data.checkout_preview_url, "/checkout-preview");
  }
});

test("expired sessions, expired quotes, and altered quotes recover without detail leakage", async () => {
  let clock = new Date("2026-08-30T10:00:00.000Z");
  const origin = await serve({ now: () => clock });
  const signin = await fetch(`${origin}/signin`);
  const guest = cookie(signin);
  const guestToken = token(await signin.text());
  const login = await fetch(`${origin}/signin`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guest, origin },
    body: new URLSearchParams({ email: "sagar@example.test", password: "ElemKeyDemo2026!", request_token: guestToken, return_to: "/products/AX7-BLK" })
  });
  let jar = cookie(login);
  const page = await fetch(`${origin}/products/AX7-BLK`, { headers: { cookie: jar } });
  jar = cookie(page) || jar;
  const memberToken = token(await page.text());
  const offerResponse = await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ product_id: "product-ax7-blk" }) });
  jar = cookie(offerResponse) || jar;
  const quote = (await offerResponse.json()).data.offer_quote;
  const headers = { "content-type": "application/json", cookie: jar, origin, "x-request-token": memberToken };

  const altered = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: `${quote}x`, quantity: 1 }) });
  const alteredBody = await altered.json();
  assert.equal(altered.status, 400);
  assert.equal(alteredBody.status, "invalid_quote");
  assert.doesNotMatch(JSON.stringify(alteredBody), /signature|member-demo|sagar/i);

  clock = new Date("2026-08-30T10:05:00.001Z");
  const expiredQuote = await fetch(`${origin}/api/basket/preview`, { method: "POST", headers, body: JSON.stringify({ product_id: "product-ax7-blk", offer_quote: quote, quantity: 1 }) });
  assert.equal((await expiredQuote.json()).status, "quote_expired");

  clock = new Date("2026-08-30T10:30:00.001Z");
  const expiredSession = await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: JSON.stringify({ product_id: "product-ax7-blk" }) });
  assert.equal((await expiredSession.json()).data.reason, "session_expired");
  assert.match(expiredSession.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("unexpected API and page failures use stable final boundaries", async () => {
  const origin = await serve({ failOperation: "catalogue" });
  const api = await fetch(`${origin}/api/products/search?query=ax7`);
  assert.equal(api.status, 503);
  const body = await api.json();
  assert.equal(typeof body.observed_at, "string");
  delete body.observed_at;
  assert.deepEqual(body, {
    status: "service_unavailable", data: null,
    error: { code: "CATALOGUE_UNAVAILABLE", message: "Product search is temporarily unavailable.", retryable: true }, ui_region: "product"
  });
  const pageOrigin = await serve({ failOperation: "product_page" });
  const page = await fetch(`${pageOrigin}/products/AX7-BLK`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Please refresh and try again/);
});
