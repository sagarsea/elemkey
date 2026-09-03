import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/domain";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const config = loadConfig({ SESSION_COOKIE_SECRET: secret(51), OFFER_TOKEN_SECRET: secret(52), MEMBER_BINDING_SECRET: secret(53) });
const servers: Server[] = [];
const roots: string[] = [];
let clock = new Date("2026-08-30T10:00:00.000Z");
async function serve() {
  mkdirSync("data", { recursive: true });
  const root = mkdtempSync("data/admin-http-test-"); roots.push(root);
  const server = createApp(config, { now: () => clock, offerStorePath: `${root}/offers.json` }).listen(0, "127.0.0.1");
  servers.push(server); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => { clock = new Date("2026-08-30T10:00:00.000Z"); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cookie = (response: Response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const token = (html: string) => html.match(/<meta name="request-token" content="([^"]+)"/)?.[1] ?? "";
const releaseStageLanguage = /\b(?:demo|demonstration|staging|sandbox|prototype)\b/i;
async function ownerSignIn(origin: string) {
  const page = await fetch(`${origin}/admin/signin`); const guest = cookie(page); const requestToken = token(await page.text());
  const login = await fetch(`${origin}/admin/signin`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guest, origin }, body: new URLSearchParams({ email: "owner@northmere.audio", password: "NorthmereOwner2026!", request_token: requestToken }) });
  const jar = cookie(login); const workspace = await fetch(`${origin}/admin/offers`, { headers: { cookie: jar } }); const html = await workspace.text();
  return { jar: cookie(workspace) || jar, requestToken: token(html), html };
}
const draft = { name: "VIP Meridian", product_ids: ["product-mh2-slv"], audience: { type: "tier", tier: "vip" }, discount_percent: 20, delivery_pence: 0, status: "active", starts_at: null, ends_at: null };

test("owner cookie, CSRF boundary, logout, and member privilege are isolated", async () => {
  const origin = await serve();
  assert.equal((await fetch(`${origin}/api/admin/offers`)).status, 401);
  const owner = await ownerSignIn(origin);
  assert.doesNotMatch(owner.html, releaseStageLanguage);
  assert.equal((await fetch(`${origin}/account`, { headers: { cookie: owner.jar } })).status, 200);
  assert.doesNotMatch(await (await fetch(`${origin}/account`, { headers: { cookie: owner.jar } })).text(), /Welcome back/);
  assert.equal((await fetch(`${origin}/api/admin/offers`, { headers: { cookie: owner.jar } })).status, 200);
  const rejected = await fetch(`${origin}/api/admin/offers/preview`, { method: "POST", headers: { "content-type": "application/json", cookie: owner.jar, origin: "https://evil.test", "x-request-token": owner.requestToken }, body: JSON.stringify({ operation: "create", expected_version: 1, draft }) });
  assert.equal(rejected.status, 403);
  const logout = await fetch(`${origin}/admin/logout`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: owner.jar, origin }, body: new URLSearchParams({ request_token: owner.requestToken }) });
  assert.equal(logout.status, 303);
  assert.equal((await fetch(`${origin}/api/admin/offers`, { headers: { cookie: cookie(logout) || owner.jar } })).status, 401);
});

test("preview-bound create, expiry, revision, status, and two-tab conflicts append versions", async () => {
  const origin = await serve(); const owner = await ownerSignIn(origin);
  const headers = { "content-type": "application/json", cookie: owner.jar, origin, "x-request-token": owner.requestToken };
  const previewResponse = await fetch(`${origin}/api/admin/offers/preview`, { method: "POST", headers, body: JSON.stringify({ operation: "create", expected_version: 1, draft }) });
  const preview = await previewResponse.json(); assert.equal(preview.status, "preview_ready"); assert.equal(preview.data.samples[0].delivered_total_pence, 27920);
  const createdResponse = await fetch(`${origin}/api/admin/offers`, { method: "POST", headers, body: JSON.stringify({ preview_token: preview.data.preview_token }) });
  const created = await createdResponse.json(); assert.equal(created.status, "created"); assert.equal(created.data.version, 2);
  const offerId = created.data.revision.offer_id;

  const conflict = await fetch(`${origin}/api/admin/offers`, { method: "POST", headers, body: JSON.stringify({ preview_token: preview.data.preview_token }) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).status, "version_conflict");
  const revisePreview = await (await fetch(`${origin}/api/admin/offers/preview`, { method: "POST", headers, body: JSON.stringify({ operation: "revise", offer_id: offerId, expected_version: 2, draft: { ...draft, discount_percent: 25 } }) })).json();
  clock = new Date("2026-08-30T10:05:00.001Z");
  const expired = await fetch(`${origin}/api/admin/offers/${offerId}`, { method: "PUT", headers, body: JSON.stringify({ preview_token: revisePreview.data.preview_token }) });
  assert.equal((await expired.json()).status, "preview_expired");
  clock = new Date("2026-08-30T10:00:00.000Z");
  const fresh = await (await fetch(`${origin}/api/admin/offers/preview`, { method: "POST", headers, body: JSON.stringify({ operation: "revise", offer_id: offerId, expected_version: 2, draft: { ...draft, discount_percent: 25 } }) })).json();
  assert.equal((await (await fetch(`${origin}/api/admin/offers/${offerId}`, { method: "PUT", headers, body: JSON.stringify({ preview_token: fresh.data.preview_token }) })).json()).status, "revised");
  assert.equal((await (await fetch(`${origin}/api/admin/offers/${offerId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "inactive", expected_version: 3 }) })).json()).status, "status_changed");
  const list = await (await fetch(`${origin}/api/admin/offers`, { headers: { cookie: owner.jar } })).json();
  assert.doesNotMatch(JSON.stringify(list), releaseStageLanguage);
  assert.equal(list.data.revisions.filter((item: { offer_id: string }) => item.offer_id === offerId).length, 3);
  assert.equal(list.data.offers.find((item: { offer_id: string }) => item.offer_id === offerId).status, "inactive");
});

test("new targeted winner reaches the right member and deactivation makes the old quote stale", async () => {
  const origin = await serve(); const owner = await ownerSignIn(origin);
  const ownerHeaders = { "content-type": "application/json", cookie: owner.jar, origin, "x-request-token": owner.requestToken };
  const preview = await (await fetch(`${origin}/api/admin/offers/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ operation: "create", expected_version: 1, draft }) })).json();
  const created = await (await fetch(`${origin}/api/admin/offers`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ preview_token: preview.data.preview_token }) })).json();

  const signIn = async (email: string, password: string) => {
    const page = await fetch(`${origin}/signin?return_to=/products/MH2-SLV`); const guest = cookie(page); const requestToken = token(await page.text());
    const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: guest, origin }, body: new URLSearchParams({ email, password, request_token: requestToken, return_to: "/products/MH2-SLV" }) });
    let jar = cookie(login); const product = await fetch(`${origin}/products/MH2-SLV`, { headers: { cookie: jar } }); jar = cookie(product) || jar;
    return { jar, requestToken: token(await product.text()) };
  };
  const standard = await signIn("member@northmere.audio", "NorthmereMember2026!");
  const standardOffer = await (await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: standard.jar }, body: JSON.stringify({ product_id: "product-mh2-slv" }) })).json();
  assert.equal(standardOffer.status, "eligible"); assert.equal(standardOffer.data.delivered_total_pence, 30712);
  const vip = await signIn("vip@northmere.audio", "NorthmereVip2026!");
  const offer = await (await fetch(`${origin}/api/offers/evaluate`, { method: "POST", headers: { "content-type": "application/json", cookie: vip.jar }, body: JSON.stringify({ product_id: "product-mh2-slv" }) })).json();
  assert.equal(offer.status, "eligible"); assert.equal(offer.data.delivered_total_pence, 27920);
  await fetch(`${origin}/api/admin/offers/${created.data.revision.offer_id}/status`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ status: "inactive", expected_version: 2 }) });
  const basket = await (await fetch(`${origin}/api/basket/preview`, { method: "POST", headers: { "content-type": "application/json", cookie: vip.jar, origin, "x-request-token": vip.requestToken }, body: JSON.stringify({ product_id: "product-mh2-slv", offer_quote: offer.data.offer_quote, quantity: 1 }) })).json();
  assert.equal(basket.status, "quote_stale");
});
