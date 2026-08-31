import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Member, OfferRule, OfferSnapshot, Product } from "./domain";
import type { OfferDraft } from "./offer-store";

const scrypt = promisify(scryptCallback);
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 8 * 60 * 60_000;
const QUOTE_MS = 5 * 60_000;

export type MemberSession = {
  member_id: string;
  issued_at: string;
  last_seen_at: string;
  session_nonce: string;
  request_token: string;
};

export type OwnerSession = {
  owner_id: string;
  issued_at: string;
  last_seen_at: string;
  session_nonce: string;
  request_token: string;
};

export const ownerAccount = Object.freeze({
  id: "owner-northmere-1",
  email: "owner@northmere.test",
  password_salt: "f689acc96a173970027dce73ecef387d",
  password_hash: "cdb68c732d3180655fd5cd4bfc25efe61a9ec94824aa3990f91ee60e4569860ba14671f4a94677be8d21b2a72dc429358694d141d10b42b50fd84a4eeaf8eb8d"
});

export async function authenticate(email: unknown, password: unknown, member: Pick<Member, "email" | "password_salt" | "password_hash">): Promise<boolean> {
  const candidate = typeof password === "string" ? password : "";
  const derived = await scrypt(candidate, Buffer.from(member.password_salt, "hex"), 64) as Buffer;
  const expected = Buffer.from(member.password_hash, "hex");
  const emailBuffer = Buffer.from(typeof email === "string" ? email.toLocaleLowerCase("en-GB") : "");
  const expectedEmail = Buffer.from(member.email);
  const emailMatches = emailBuffer.length === expectedEmail.length && timingSafeEqual(emailBuffer, expectedEmail);
  return emailMatches && timingSafeEqual(derived, expected);
}

export function createRequestToken() {
  return randomBytes(32).toString("base64url");
}

export function createMemberSession(memberId: string, now = new Date()): MemberSession {
  const timestamp = now.toISOString();
  return {
    member_id: memberId,
    issued_at: timestamp,
    last_seen_at: timestamp,
    session_nonce: randomBytes(32).toString("base64url"),
    request_token: createRequestToken()
  };
}

export function createOwnerSession(ownerId: string, now = new Date()): OwnerSession {
  const timestamp = now.toISOString();
  return { owner_id: ownerId, issued_at: timestamp, last_seen_at: timestamp, session_nonce: randomBytes(32).toString("base64url"), request_token: createRequestToken() };
}

export function validateSession(session: Partial<MemberSession>, now = new Date()): { active: boolean; reason: "active" | "signed_out" | "session_expired" } {
  if (!session.member_id || !session.issued_at || !session.last_seen_at || !session.session_nonce || !session.request_token) return { active: false, reason: "signed_out" };
  const issued = Date.parse(session.issued_at);
  const seen = Date.parse(session.last_seen_at);
  const time = now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(seen) || time < issued || time - seen > IDLE_MS || time - issued > ABSOLUTE_MS) return { active: false, reason: "session_expired" };
  return { active: true, reason: "active" };
}

export function validateOwnerSession(session: Partial<OwnerSession>, now = new Date()) {
  return validateSession({ ...session, member_id: session.owner_id }, now);
}

export function safeReturnTo(value: unknown) {
  return typeof value === "string" && (/^\/products\/[A-Z0-9]+-[A-Z0-9]+$/.test(value) || value === "/account") ? value : "/products/AX7-BLK";
}

function equalText(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateRequest(origin: unknown, token: unknown, expectedOrigin: string, expectedToken: string) {
  return equalText(origin, expectedOrigin) && equalText(token, expectedToken);
}

export function memberBinding(session: MemberSession, secret: Buffer) {
  return createHmac("sha256", secret).update(`${session.member_id}:${session.session_nonce}`).digest("base64url");
}

type QuoteClaims = Omit<OfferSnapshot, "reason"> & Readonly<{
  member_binding: string;
  issued_at: string;
  expires_at: string;
}>;

export function issueOfferQuote(snapshot: OfferSnapshot, session: MemberSession, offerSecret: Buffer, bindingSecret: Buffer, now = new Date()) {
  const claims: QuoteClaims = {
    member_binding: memberBinding(session, bindingSecret),
    product_id: snapshot.product_id,
    sku: snapshot.sku,
    rule_id: snapshot.rule_id,
    rule_version: snapshot.rule_version,
    currency: snapshot.currency,
    unit_price_pence: snapshot.unit_price_pence,
    stock_quantity: snapshot.stock_quantity,
    discount_percent: snapshot.discount_percent,
    discount_pence: snapshot.discount_pence,
    delivery_pence: snapshot.delivery_pence,
    delivered_total_pence: snapshot.delivered_total_pence,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + QUOTE_MS).toISOString()
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", offerSecret).update(payload).digest("base64url")}`;
}

type PreviewClaims = Readonly<{
  owner_binding: string;
  operation: "create" | "revise";
  offer_id: string | null;
  expected_version: number;
  draft: OfferDraft;
  issued_at: string;
  expires_at: string;
}>;

const sign = (payload: string, secret: Buffer) => createHmac("sha256", secret).update(payload).digest("base64url");
const ownerBinding = (session: OwnerSession, secret: Buffer) => createHmac("sha256", secret).update(`${session.owner_id}:${session.session_nonce}`).digest("base64url");

export function issueOfferPreview(draft: OfferDraft, operation: "create" | "revise", offerId: string | null, expectedVersion: number, session: OwnerSession, secret: Buffer, bindingSecret: Buffer, now = new Date()) {
  const claims: PreviewClaims = { owner_binding: ownerBinding(session, bindingSecret), operation, offer_id: offerId, expected_version: expectedVersion, draft, issued_at: now.toISOString(), expires_at: new Date(now.getTime() + QUOTE_MS).toISOString() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyOfferPreview(token: unknown, operation: "create" | "revise", offerId: string | null, session: OwnerSession, secret: Buffer, bindingSecret: Buffer, now = new Date()): { status: "valid"; claims: PreviewClaims } | { status: "invalid" } | { status: "expired" } {
  if (typeof token !== "string" || token.length < 20 || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { status: "invalid" };
  const [payload, signature] = token.split(".");
  const expected = Buffer.from(sign(payload, secret));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return { status: "invalid" };
  let claims: PreviewClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewClaims; } catch { return { status: "invalid" }; }
  if (!claims || claims.operation !== operation || claims.offer_id !== offerId || claims.owner_binding !== ownerBinding(session, bindingSecret) || !Number.isInteger(claims.expected_version) || typeof claims.expires_at !== "string" || typeof claims.issued_at !== "string" || !claims.draft) return { status: "invalid" };
  return now.getTime() > Date.parse(claims.expires_at) ? { status: "expired" } : { status: "valid", claims };
}

export type QuoteVerification =
  | { status: "valid"; claims: QuoteClaims }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "stale" }
  | { status: "out_of_stock" };

export function verifyOfferQuote(
  quote: unknown,
  session: MemberSession,
  product: Product,
  rule: OfferRule | OfferSnapshot,
  offerSecret: Buffer,
  bindingSecret: Buffer,
  now = new Date()
): QuoteVerification {
  if (typeof quote !== "string" || quote.length > 2048 || quote.length < 20 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(quote)) return { status: "invalid" };
  const [payload, suppliedSignature] = quote.split(".");
  const expectedSignature = createHmac("sha256", offerSecret).update(payload).digest();
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return { status: "invalid" };
  let claims: QuoteClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as QuoteClaims;
  } catch {
    return { status: "invalid" };
  }
  const keys = ["member_binding", "product_id", "sku", "rule_id", "rule_version", "currency", "unit_price_pence", "stock_quantity", "discount_percent", "discount_pence", "delivery_pence", "delivered_total_pence", "issued_at", "expires_at"];
  if (!claims || typeof claims !== "object" || Object.keys(claims).length !== keys.length || keys.some((key) => !(key in claims))) return { status: "invalid" };
  if (!equalText(claims.member_binding, memberBinding(session, bindingSecret)) || claims.product_id !== product.id || claims.sku !== product.sku) return { status: "invalid" };
  const expires = Date.parse(claims.expires_at);
  if (!Number.isFinite(expires)) return { status: "invalid" };
  if (now.getTime() > expires) return { status: "expired" };
  if (product.stock_quantity < 1) return { status: "out_of_stock" };
  const dynamic = "rule_id" in rule && "rule_version" in rule;
  const ruleId = dynamic ? rule.rule_id : rule.rule_id;
  const ruleVersion = dynamic ? rule.rule_version : rule.version;
  const ruleStatus = dynamic ? "active" : rule.status;
  const delivery = rule.delivery_pence;
  const discount = Math.round(product.unit_price_pence * rule.discount_percent / 100);
  if (
    ruleStatus !== "active" || claims.rule_id !== ruleId || claims.rule_version !== ruleVersion ||
    claims.unit_price_pence !== product.unit_price_pence || claims.stock_quantity !== product.stock_quantity || claims.discount_percent !== rule.discount_percent ||
    claims.discount_pence !== discount || claims.delivery_pence !== delivery || claims.delivered_total_pence !== product.unit_price_pence - discount + delivery
  ) return { status: "stale" };
  return { status: "valid", claims };
}
