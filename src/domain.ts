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

const connections = ["wired", "wireless"] as const;
const features = ["commuting", "home_listening", "lightweight", "over_ear", "noise_control"] as const;
const searchSorts = ["relevance", "price_asc", "price_desc", "name", "delivered_price_asc", "delivered_price_desc", "weight_asc"] as const;
type Connection = typeof connections[number];
type Feature = typeof features[number];
type MemberOfferStatus = "available" | "not_available" | "sign_in_required";

const connectionFor = (product: Product) => product.specifications.Connection ?? product.specifications.Inputs ?? "Not provided";
const weightFor = (product: Product) => Number(product.specifications.Weight?.match(/^\d+/)?.[0]) || null;
const noiseControlFor = (product: Product) => /hybrid noise cancelling/i.test(product.description) ? "Hybrid noise cancelling" : /adaptive noise control/i.test(product.description) ? "Adaptive noise control" : "Not provided";
const isConnection = (product: Product, connection: Connection) => connection === "wireless" ? /wireless|bluetooth/i.test(connectionFor(product)) : /wired|3\.5 mm/i.test(connectionFor(product));
const featureScore = (product: Product, feature: Feature) => {
  const text = `${product.title} ${product.description} ${product.image_alt}`.toLocaleLowerCase("en-GB");
  if (feature === "commuting") return (/travel/.test(text) ? 3 : 0) + (/noise control|noise cancelling/.test(text) ? 2 : 0);
  if (feature === "home_listening") return (/open-back|reference/.test(text) ? 3 : 0) + (/studio/.test(text) ? 1 : 0);
  if (feature === "lightweight") return weightFor(product) !== null && weightFor(product)! <= 260 ? 2 : 0;
  if (feature === "over_ear") return /headphones/.test(product.title.toLocaleLowerCase("en-GB")) && !/earphones/.test(product.title.toLocaleLowerCase("en-GB")) ? 1 : 0;
  return noiseControlFor(product) !== "Not provided" ? 1 : 0;
};

function matchReason(product: Product, input: Record<string, unknown>, queryScore: number) {
  const reasons: string[] = [];
  const requested = input.features as Feature[] | undefined;
  if (requested?.includes("lightweight")) reasons.push(`${weightFor(product)} g lightweight design`);
  if (requested?.includes("home_listening")) reasons.push(/open-back/i.test(product.description) ? "open-back reference tuning for home listening" : "studio tuning for home listening");
  if (requested?.includes("commuting")) reasons.push(/travel/i.test(product.description) ? "travel design with hybrid noise cancelling" : "adaptive noise control for commuting");
  if (requested?.includes("over_ear")) reasons.push("over-ear headphone design");
  if (requested?.includes("noise_control")) reasons.push(noiseControlFor(product));
  if (input.connection) reasons.push(`${connectionFor(product)} connection`);
  if (input.max_delivered_price_pence !== undefined) reasons.push(`£${((product.unit_price_pence + product.delivery_pence) / 100).toFixed(2)} delivered`);
  if (input.category && !reasons.length) reasons.push(`${product.category} category`);
  if (!reasons.length && queryScore >= 0) reasons.push(`Matches ${product.sku}, model or product description`);
  return `${reasons.join("; ")}.`;
}

const productSummary = (product: Product, reason: string) => Object.freeze({
  id: product.id, title: product.title, sku: product.sku, category: product.category,
  unit_price_pence: product.unit_price_pence, delivery_pence: product.delivery_pence,
  delivered_total_pence: product.unit_price_pence + product.delivery_pence,
  stock_status: product.stock_quantity > 0 ? "in_stock" as const : "out_of_stock" as const,
  connection: connectionFor(product), weight_grams: weightFor(product), product_url: product.product_url,
  match_reason: reason
});

function inferSearchFilters(query: string) {
  const text = query.toLocaleLowerCase("en-GB");
  const price = text.match(/(?:under|below|up to|maximum(?: of)?|max(?:imum)?(?: of)?)\s*£\s*(\d{1,7}(?:\.\d{1,2})?)\b/);
  const requestedFeatures = features.filter((feature) => feature === "commuting" ? /commut|travel/.test(text) : feature === "home_listening" ? /home listening/.test(text) : feature === "lightweight" ? /lightweight/.test(text) : feature === "over_ear" ? /over[- ]ear/.test(text) : /noise (?:control|cancell)/.test(text));
  const category = categories.find((candidate) => new RegExp(`\\b${candidate.replace(/s$/, "")}s?\\b`).test(text)) ?? (requestedFeatures.length ? "headphones" as const : undefined);
  const connection = /\bwireless\b/.test(text) ? "wireless" as const : /\bwired\b/.test(text) ? "wired" as const : undefined;
  if (!price && !requestedFeatures.length && !category && !connection) return {};
  return {
    ...(category ? { category } : {}),
    ...(price ? { max_delivered_price_pence: Math.round(Number(price[1]) * 100) } : {}),
    in_stock_only: true,
    ...(connection ? { connection } : {}),
    ...(requestedFeatures.length ? { features: requestedFeatures } : {}),
    sort: price ? "delivered_price_asc" as const : "relevance" as const
  };
}

export function searchProducts(input: unknown, catalogue: Product | readonly Product[], now = new Date()) {
  const invalid = () => ({ status: "invalid_input" as const, observed_at: now.toISOString(), data: null, error: { code: "INVALID_INPUT", message: "Enter a product name, model, SKU, or valid catalogue filters.", retryable: false }, ui_region: "product" as const });
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const record = input as Record<string, unknown>;
  const allowed = ["query", "category", "max_price_pence", "max_delivered_price_pence", "in_stock_only", "connection", "features", "sort", "limit"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return invalid();
  if (record.query !== undefined && typeof record.query !== "string") return invalid();
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (query.length > 100 || (!query && (Object.keys(record).length === 0 || (Object.keys(record).length === 1 && "query" in record)))) return invalid();
  if (record.category !== undefined && !categories.includes(record.category as Category)) return invalid();
  if (record.max_price_pence !== undefined && !integer(record.max_price_pence)) return invalid();
  if (record.max_delivered_price_pence !== undefined && !integer(record.max_delivered_price_pence)) return invalid();
  if (record.in_stock_only !== undefined && typeof record.in_stock_only !== "boolean") return invalid();
  if (record.connection !== undefined && !connections.includes(record.connection as Connection)) return invalid();
  if (record.features !== undefined && (!Array.isArray(record.features) || record.features.length < 1 || record.features.length > features.length || new Set(record.features).size !== record.features.length || record.features.some((feature) => !features.includes(feature as Feature)))) return invalid();
  if (record.sort !== undefined && !searchSorts.includes(record.sort as typeof searchSorts[number])) return invalid();
  if (record.limit !== undefined && (!integer(record.limit, 1) || (record.limit as number) > 8)) return invalid();
  const explicitlyStructured = ["category", "max_price_pence", "max_delivered_price_pence", "in_stock_only", "connection", "features"].some((key) => record[key] !== undefined);
  const inferred: Record<string, unknown> = explicitlyStructured ? {} : inferSearchFilters(query);
  const effective: Record<string, unknown> = { ...inferred, ...record };
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
  const deliveredMaximum = effective.max_delivered_price_pence as number | undefined;
  const requestedFeatures = effective.features as Feature[] | undefined;
  const structured = explicitlyStructured || Object.keys(inferred).length > 0;
  const passes = (product: Product, filters: Record<string, unknown>) =>
    (filters.category === undefined || product.category === filters.category)
    && (filters.max_price_pence === undefined || product.unit_price_pence <= (filters.max_price_pence as number))
    && (filters.max_delivered_price_pence === undefined || product.unit_price_pence + product.delivery_pence <= (filters.max_delivered_price_pence as number))
    && (filters.in_stock_only !== true || product.stock_quantity > 0)
    && (filters.connection === undefined || isConnection(product, filters.connection as Connection))
    && (filters.features === undefined || (filters.features as Feature[]).every((feature) => featureScore(product, feature) > 0));
  let matches = products.filter((product) => (!query || structured || score(product) >= 0) && passes(product, effective));
  const sort = effective.sort ?? "relevance";
  const relevance = (product: Product) => Math.max(0, score(product)) + (requestedFeatures?.reduce((total, feature) => total + featureScore(product, feature), 0) ?? 0) * 10;
  matches = [...matches].sort(sort === "price_asc" ? (a, b) => a.unit_price_pence - b.unit_price_pence || a.sku.localeCompare(b.sku) : sort === "price_desc" ? (a, b) => b.unit_price_pence - a.unit_price_pence || a.sku.localeCompare(b.sku) : sort === "delivered_price_asc" ? (a, b) => a.unit_price_pence + a.delivery_pence - b.unit_price_pence - b.delivery_pence || a.sku.localeCompare(b.sku) : sort === "delivered_price_desc" ? (a, b) => b.unit_price_pence + b.delivery_pence - a.unit_price_pence - a.delivery_pence || a.sku.localeCompare(b.sku) : sort === "weight_asc" ? (a, b) => (weightFor(a) ?? Infinity) - (weightFor(b) ?? Infinity) || a.sku.localeCompare(b.sku) : sort === "name" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => relevance(b) - relevance(a) || a.unit_price_pence + a.delivery_pence - b.unit_price_pence - b.delivery_pence);
  const total = matches.length;
  const listed = matches.slice(0, (effective.limit as number | undefined) ?? 6).map((product) => productSummary(product, matchReason(product, effective, score(product))));
  if (listed.length) return { status: "ok" as const, observed_at: now.toISOString(), data: { query, products: listed, result_count: listed.length, total_matches: total, ...(Object.keys(inferred).length ? { applied_filters: inferred } : {}) }, error: null, ui_region: "product" as const };
  const relaxed = { ...effective };
  delete relaxed.max_delivered_price_pence;
  const closest = deliveredMaximum === undefined ? undefined : products.filter((product) => passes(product, relaxed)).sort((a, b) => a.unit_price_pence + a.delivery_pence - b.unit_price_pence - b.delivery_pence)[0];
  const compound = !structured && /headphones?/i.test(query) && /(wireless|wired)/i.test(query) && /£?\d+/.test(query);
  const suggested_filters = Object.keys(inferred).length ? { ...inferred, ...(closest ? { max_delivered_price_pence: closest.unit_price_pence + closest.delivery_pence } : {}) } : compound ? {
    category: "headphones" as const,
    max_delivered_price_pence: Number(query.match(/£?(\d+)/)?.[1]) * 100,
    connection: /wireless/i.test(query) ? "wireless" as const : "wired" as const
  } : {};
  return { status: "empty" as const, observed_at: now.toISOString(), data: { query, products: [], result_count: 0, total_matches: 0, reason: compound ? "compound_query_not_supported" as const : "no_catalogue_match" as const, suggested_filters }, error: null, ui_region: "product" as const };
}

export function compareProducts(input: unknown, catalogue: readonly Product[], memberOfferStatus: (product: Product) => MemberOfferStatus, now = new Date()) {
  const invalid = () => ({ status: "invalid_input" as const, observed_at: now.toISOString(), data: null, error: { code: "INVALID_INPUT", message: "Choose two to four different catalogue product IDs.", retryable: false }, ui_region: "product" as const });
  if (!Array.isArray(input) || input.length < 2 || input.length > 4 || new Set(input).size !== input.length || input.some((id) => typeof id !== "string")) return invalid();
  const byId = new Map(catalogue.map((product) => [product.id, product]));
  const selected = input.map((id) => byId.get(id));
  if (selected.some((product) => !product)) return invalid();
  const products = (selected as Product[]).sort((a, b) => a.unit_price_pence + a.delivery_pence - b.unit_price_pence - b.delivery_pence).map((product) => ({
    product_id: product.id, title: product.title, sku: product.sku,
    delivered_price_pence: product.unit_price_pence + product.delivery_pence,
    stock_status: product.stock_quantity > 0 ? "in_stock" as const : "out_of_stock" as const,
    connection: connectionFor(product), weight_grams: weightFor(product),
    battery: product.specifications.Battery ?? (isConnection(product, "wired") ? "Not applicable" : "Not provided"),
    noise_control: noiseControlFor(product), warranty: product.specifications.Warranty ?? "Not provided",
    member_offer_status: memberOfferStatus(product)
  }));
  return { status: "ok" as const, observed_at: now.toISOString(), data: { products, ordered_by: "delivered_price_asc" as const }, error: null, ui_region: "product" as const };
}

export function evaluateOffer(productId: unknown, authenticated: boolean, product: Product | undefined, rule: OfferRule | undefined, _now = new Date(), expired = false): OfferOutcome {
  if (!product || productId !== product.id) return { status: "invalid_input" };
  if (product.stock_quantity < 1) return { status: "out_of_stock", reason: "This product is currently out of stock." };
  if (!authenticated) return { status: "sign_in_required", reason: expired ? "session_expired" : "signed_out" };
  if (!rule || rule.status !== "active" || rule.product_sku !== product.sku || !rule.authenticated_customer) return { status: "ineligible", reason: "No active member offer applies to this product." };
  const discount_pence = Math.round(product.unit_price_pence * rule.discount_percent / 100);
  return { status: "eligible", snapshot: Object.freeze({ product_id: product.id, sku: product.sku, rule_id: rule.rule_id, rule_version: rule.version, currency: product.currency, unit_price_pence: product.unit_price_pence, stock_quantity: product.stock_quantity, discount_percent: rule.discount_percent, discount_pence, delivery_pence: rule.delivery_pence, delivered_total_pence: product.unit_price_pence - discount_pence + rule.delivery_pence, reason: "Signed-in members receive 5% off and free delivery." }) };
}
