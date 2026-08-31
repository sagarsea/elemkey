import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const categories = ["headphones", "speakers", "sources", "accessories"] as const;
export type Category = typeof categories[number];
export type Product = Readonly<{
  id: string; title: string; model: string; sku: string; category: Category; variant: string;
  description: string; currency: "GBP"; unit_price_pence: number; stock_quantity: number;
  delivery_pence: number; delivery_estimate: string; public_offers: readonly string[];
  product_url: string; image_url: string; image_alt: string; specifications: Readonly<Record<string, string>>;
}>;
export type MemberTier = "standard" | "vip";
export type Member = Readonly<{ id: string; email: string; tier: MemberTier; password_salt: string; password_hash: string }>;
export type OfferRule = Readonly<{ rule_id: "MEMBER-5-FREE"; version: number; status: "active" | "inactive"; product_sku: string; authenticated_customer: true; discount_percent: number; delivery_pence: number }>;
export type AppConfig = Readonly<{
  products: readonly Product[]; productsById: ReadonlyMap<string, Product>; productsBySku: ReadonlyMap<string, Product>;
  rules: readonly OfferRule[]; product: Product; rule: OfferRule; member: Member; members: readonly Member[];
  membersById: ReadonlyMap<string, Member>; membersByEmail: ReadonlyMap<string, Member>;
  secrets: Readonly<{ session: Buffer; offer: Buffer; binding: Buffer }>;
}>;
export type OfferSnapshot = Readonly<{
  product_id: string; sku: string; rule_id: string; rule_version: number; currency: "GBP";
  unit_price_pence: number; stock_quantity: number; discount_percent: number; discount_pence: number;
  delivery_pence: number; delivered_total_pence: number; reason: string;
}>;
export type OfferOutcome =
  | Readonly<{ status: "eligible"; snapshot: OfferSnapshot }>
  | Readonly<{ status: "sign_in_required"; reason: "signed_out" | "session_expired" }>
  | Readonly<{ status: "ineligible"; reason: string }>
  | Readonly<{ status: "out_of_stock"; reason: string }>
  | Readonly<{ status: "invalid_input" }>;

type SecretEnv = Record<string, string | undefined>;
const secretNames = ["SESSION_COOKIE_SECRET", "OFFER_TOKEN_SECRET", "MEMBER_BINDING_SECRET"] as const;
const productKeys = ["id", "title", "model", "sku", "category", "variant", "description", "currency", "unit_price_pence", "stock_quantity", "delivery_pence", "delivery_estimate", "public_offers", "product_url", "image_url", "image_alt", "specifications"] as const;
const ruleKeys = ["rule_id", "version", "status", "product_sku", "authenticated_customer", "discount_percent", "delivery_pence"] as const;
const fail = (): never => { throw new Error("Invalid ElemKey configuration"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) fail(); };
const integer = (value: unknown, minimum = 0) => Number.isInteger(value) && (value as number) >= minimum;

export function validateSecrets(env: SecretEnv): [Buffer, Buffer, Buffer] {
  const values = secretNames.map((name) => {
    const raw = env[name];
    if (!raw || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) fail();
    const decoded = Buffer.from(raw as string, "base64");
    if (decoded.length < 32) fail();
    return decoded;
  }) as [Buffer, Buffer, Buffer];
  if (new Set(values.map((value) => value.toString("hex"))).size !== 3) fail();
  return values;
}

function validateProduct(value: unknown): Product {
  const product = object(value);
  exactKeys(product, productKeys);
  if (typeof product.id !== "string" || !/^product-[a-z0-9-]+$/.test(product.id) || typeof product.title !== "string" || typeof product.model !== "string" || typeof product.sku !== "string" || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(product.sku) || !categories.includes(product.category as Category) || typeof product.variant !== "string" || typeof product.description !== "string" || product.currency !== "GBP" || !integer(product.unit_price_pence, 1) || !integer(product.stock_quantity) || !integer(product.delivery_pence) || typeof product.delivery_estimate !== "string" || !Array.isArray(product.public_offers) || product.product_url !== `/products/${product.sku}` || typeof product.image_url !== "string" || !/^\/images\/[a-z0-9-]+\.svg$/.test(product.image_url) || typeof product.image_alt !== "string" || product.image_alt.length < 5) fail();
  const specifications = object(product.specifications);
  if (Object.keys(specifications).length < 3 || Object.values(specifications).some((item) => typeof item !== "string" || item.length < 1)) fail();
  if (product.sku === "AX7-BLK" && (product.id !== "product-ax7-blk" || product.title !== "Auralux X7 Studio Headphones" || product.unit_price_pence !== 49900 || product.delivery_pence !== 1499)) fail();
  return Object.freeze({ ...product, public_offers: Object.freeze([...(product.public_offers as unknown[])]), specifications: Object.freeze({ ...specifications }) }) as Product;
}

function validateRule(value: unknown): OfferRule {
  const rule = object(value);
  exactKeys(rule, ruleKeys);
  if (rule.rule_id !== "MEMBER-5-FREE" || !integer(rule.version, 1) || !["active", "inactive"].includes(rule.status as string) || typeof rule.product_sku !== "string" || rule.authenticated_customer !== true || !integer(rule.discount_percent) || (rule.discount_percent as number) > 100 || !integer(rule.delivery_pence)) fail();
  return Object.freeze({ ...rule }) as OfferRule;
}

export function validateFixtures(fixturesValue: unknown, ruleValue: unknown) {
  const fixtures = object(fixturesValue);
  const modern = "products" in fixtures;
  exactKeys(fixtures, modern && "members" in fixtures ? ["products", "members"] : modern ? ["products", "member"] : ["product", "member"]);
  const products = modern ? (Array.isArray(fixtures.products) ? fixtures.products.map(validateProduct) : fail()) : [validateProduct(fixtures.product)];
  if (products.length < 1 || new Set(products.map(({ id }) => id)).size !== products.length || new Set(products.map(({ sku }) => sku)).size !== products.length || new Set(products.map(({ product_url }) => product_url)).size !== products.length || new Set(products.map(({ image_url }) => image_url)).size !== products.length) fail();
  const memberValues = "members" in fixtures && Array.isArray(fixtures.members) ? fixtures.members : [fixtures.member];
  const members = memberValues.map((value) => {
    const member = object(value);
    const legacy = !("tier" in member);
    exactKeys(member, legacy ? ["id", "email", "password_salt", "password_hash"] : ["id", "email", "tier", "password_salt", "password_hash"]);
    if (typeof member.id !== "string" || !/^member-[a-z0-9-]+$/.test(member.id) || typeof member.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(member.email) || (!legacy && !["standard", "vip"].includes(member.tier as string)) || typeof member.password_salt !== "string" || !/^[0-9a-f]{32}$/.test(member.password_salt) || typeof member.password_hash !== "string" || !/^[0-9a-f]{128}$/.test(member.password_hash)) fail();
    return Object.freeze({ ...member, tier: legacy ? "standard" : member.tier }) as Member;
  });
  if (members.length < 1 || new Set(members.map(({ id }) => id)).size !== members.length || new Set(members.map(({ email }) => email.toLocaleLowerCase("en-GB"))).size !== members.length) fail();
  const member = members.find(({ email }) => email === "sagar@example.test") ?? fail();
  const rules = (Array.isArray(ruleValue) ? ruleValue : [ruleValue]).map(validateRule);
  if (new Set(rules.map(({ product_sku }) => product_sku)).size !== rules.length || rules.some(({ product_sku }) => !products.some(({ sku }) => sku === product_sku))) fail();
  return { products: Object.freeze(products), member, members: Object.freeze(members), rules: Object.freeze(rules) };
}

export function loadConfig(env: SecretEnv = process.env): AppConfig {
  const validated = validateFixtures(JSON.parse(readFileSync(resolve("config/demo-fixtures.json"), "utf8")), JSON.parse(readFileSync(resolve("config/offer-rule.json"), "utf8")));
  const [session, offer, binding] = validateSecrets(env);
  const product = validated.products.find(({ sku }) => sku === "AX7-BLK") ?? fail();
  const rule = validated.rules.find(({ product_sku }) => product_sku === product.sku) ?? fail();
  return Object.freeze({ ...validated, product, rule, productsById: new Map(validated.products.map((item) => [item.id, item])), productsBySku: new Map(validated.products.map((item) => [item.sku, item])), membersById: new Map(validated.members.map((item) => [item.id, item])), membersByEmail: new Map(validated.members.map((item) => [item.email.toLocaleLowerCase("en-GB"), item])), secrets: Object.freeze({ session, offer, binding }) });
}

export const publicProduct = (product: Product) => Object.freeze({
  id: product.id, title: product.title, model: product.model, sku: product.sku, category: product.category, variant: product.variant,
  description: product.description, currency: product.currency, unit_price_pence: product.unit_price_pence, stock_quantity: product.stock_quantity,
  delivery_pence: product.delivery_pence, delivered_total_pence: product.unit_price_pence + product.delivery_pence,
  delivery_estimate: product.delivery_estimate, public_offers: product.public_offers, product_url: product.product_url,
  image_url: product.image_url, image_alt: product.image_alt, specifications: product.specifications
});

export function searchProducts(input: unknown, catalogue: Product | readonly Product[], now = new Date()) {
  const invalid = () => ({ status: "invalid_input" as const, observed_at: now.toISOString(), data: null, error: { code: "INVALID_INPUT", message: "Enter a product name, model, SKU, or valid catalogue filters.", retryable: false }, ui_region: "product" as const });
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const record = input as Record<string, unknown>;
  const allowed = ["query", "category", "max_price_pence", "in_stock_only", "sort"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return invalid();
  if (record.query !== undefined && typeof record.query !== "string") return invalid();
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (query.length > 100 || (!query && (Object.keys(record).length === 0 || (Object.keys(record).length === 1 && "query" in record)))) return invalid();
  if (record.category !== undefined && !categories.includes(record.category as Category)) return invalid();
  if (record.max_price_pence !== undefined && !integer(record.max_price_pence)) return invalid();
  if (record.in_stock_only !== undefined && typeof record.in_stock_only !== "boolean") return invalid();
  if (record.sort !== undefined && !["relevance", "price_asc", "price_desc", "name"].includes(record.sort as string)) return invalid();
  const products: readonly Product[] = Array.isArray(catalogue) ? catalogue : [catalogue as Product];
  const needle = query.toLocaleLowerCase("en-GB");
  const score = (product: Product) => {
    const fields = [product.sku, product.model, product.title, product.category, product.description].map((value) => value.toLocaleLowerCase("en-GB"));
    if (!needle) return 0;
    if (fields[0] === needle) return 100;
    if (fields[1] === needle || fields[2] === needle) return 90;
    if (fields.some((value) => value.startsWith(needle))) return 70;
    return fields.some((value) => value.includes(needle)) ? 50 : -1;
  };
  const maximum = record.max_price_pence as number | undefined;
  let matches = products.filter((product) => score(product) >= 0 && (record.category === undefined || product.category === record.category) && (maximum === undefined || product.unit_price_pence <= maximum) && (record.in_stock_only !== true || product.stock_quantity > 0));
  const sort = record.sort ?? "relevance";
  matches = [...matches].sort(sort === "price_asc" ? (a, b) => a.unit_price_pence - b.unit_price_pence || a.sku.localeCompare(b.sku) : sort === "price_desc" ? (a, b) => b.unit_price_pence - a.unit_price_pence || a.sku.localeCompare(b.sku) : sort === "name" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => score(b) - score(a));
  const listed = matches.map(publicProduct);
  return { status: listed.length ? "ok" as const : "empty" as const, observed_at: now.toISOString(), data: listed.length ? { product: listed[0], products: listed } : { product: null, products: [], query }, error: null, ui_region: "product" as const };
}

export function evaluateOffer(productId: unknown, authenticated: boolean, product: Product | undefined, rule: OfferRule | undefined, _now = new Date(), expired = false): OfferOutcome {
  if (!product || productId !== product.id) return { status: "invalid_input" };
  if (product.stock_quantity < 1) return { status: "out_of_stock", reason: "This product is currently out of stock." };
  if (!authenticated) return { status: "sign_in_required", reason: expired ? "session_expired" : "signed_out" };
  if (!rule || rule.status !== "active" || rule.product_sku !== product.sku || !rule.authenticated_customer) return { status: "ineligible", reason: "No active member offer applies to this product." };
  const discount_pence = Math.round(product.unit_price_pence * rule.discount_percent / 100);
  return { status: "eligible", snapshot: Object.freeze({ product_id: product.id, sku: product.sku, rule_id: rule.rule_id, rule_version: rule.version, currency: product.currency, unit_price_pence: product.unit_price_pence, stock_quantity: product.stock_quantity, discount_percent: rule.discount_percent, discount_pence, delivery_pence: rule.delivery_pence, delivered_total_pence: product.unit_price_pence - discount_pence + rule.delivery_pence, reason: "Signed-in members receive 5% off and free delivery." }) };
}
