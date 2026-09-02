import express, { type NextFunction, type Request, type Response } from "express";
import { getIronSession } from "iron-session";
import { resolve } from "node:path";
import { authenticate, createMemberSession, createOwnerSession, createRequestToken, issueOfferPreview, issueOfferQuote, ownerAccount, safeReturnTo, validateOwnerSession, validateRequest, validateSession, verifyOfferPreview, verifyOfferQuote, type MemberSession, type OwnerSession } from "./security";
import { compareProducts, publicProduct, searchProducts, type AppConfig, type Product } from "./domain";
import { OfferStore, OfferValidationError, VersionConflictError, deliveredTotal, offerPhase, selectMemberOffer } from "./offer-store";
import { accountView, adminOffersView, adminSignInView, basketView, checkoutView, homeView, notFoundView, policyView, productView, recoveryView, ruleView, shopView, signInView } from "./views";

type AppSession = Partial<MemberSession>;
type AdminSession = Partial<OwnerSession>;
export type AppOptions = { now?: () => Date; secureCookie?: boolean; failOperation?: "catalogue" | "offer" | "basket" | "product_page" | "admin"; offerStore?: OfferStore; offerStorePath?: string };
const policies = Object.freeze({
  delivery: { title: "Delivery", body: "In-stock products show their current estimate and delivery price. Member delivery is free only when an eligible offer says so." },
  returns: { title: "Returns", body: "Unused products may be returned within 30 days in their original condition and packaging. This demonstration does not start or track returns." },
  member_offers: { title: "Member offers", body: "Selected signed-in members receive 5% off and free delivery on selected products. Offers expire after five minutes and are checked again before basket display." }
});
type PolicyTopic = keyof typeof policies;
const policyTopic = (value: unknown): value is PolicyTopic => typeof value === "string" && value in policies;

export function createApp(config: AppConfig, options: AppOptions = {}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  const offerStore = options.offerStore ?? OfferStore.open(options.offerStorePath ?? process.env.OFFER_STORE_PATH ?? "data/offers.json", config.productsById, config.membersById, config.rules, now());
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4kb" }));
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use(express.static(resolve("public")));
  app.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });

  const sessionFor = (req: Request, res: Response) => getIronSession<AppSession>(req, res, {
    password: config.secrets.session.toString("base64"), cookieName: "elemkey_session", ttl: 8 * 60 * 60,
    cookieOptions: { httpOnly: true, secure: options.secureCookie ?? process.env.NODE_ENV === "production", sameSite: "lax", path: "/" }
  });
  const ownerSessionFor = (req: Request, res: Response) => getIronSession<AdminSession>(req, res, {
    password: config.secrets.session.toString("base64"), cookieName: "elemkey_owner", ttl: 8 * 60 * 60,
    cookieOptions: { httpOnly: true, secure: options.secureCookie ?? process.env.NODE_ENV === "production", sameSite: "lax", path: "/" }
  });
  const originFor = (req: Request) => `${req.protocol}://${req.get("host")}`;
  const requestTokenFor = async (req: Request, res: Response) => {
    const session = await sessionFor(req, res);
    if (!session.request_token) { session.request_token = createRequestToken(); await session.save(); }
    return { session, token: session.request_token };
  };
  const ownerRequestTokenFor = async (req: Request, res: Response) => {
    const session = await ownerSessionFor(req, res);
    if (!session.request_token) { session.request_token = createRequestToken(); await session.save(); }
    return { session, token: session.request_token };
  };
  const activeSession = async (req: Request, res: Response) => {
    const session = await sessionFor(req, res);
    const state = validateSession(session, now());
    if (state.active) { session.last_seen_at = now().toISOString(); await session.save(); return { session: session as MemberSession, reason: "active" as const }; }
    if (state.reason === "session_expired") session.destroy();
    return { session: null, reason: state.reason };
  };
  const signedIn = async (req: Request, res: Response) => validateSession(await sessionFor(req, res), now()).active;
  const activeOwner = async (req: Request, res: Response) => {
    const session = await ownerSessionFor(req, res);
    const state = validateOwnerSession(session, now());
    if (state.active) { session.last_seen_at = now().toISOString(); await session.save(); return { session: session as OwnerSession, reason: "active" as const }; }
    if (state.reason === "session_expired") session.destroy();
    return { session: null, reason: state.reason };
  };
  const invalidRequest = (res: Response) => res.status(403).json({ status: "invalid_request", observed_at: now().toISOString(), data: null, error: { code: "REQUEST_REJECTED", message: "Refresh the page and try again.", retryable: false }, ui_region: "basket" });
  const invalidInput = (res: Response, region: "product" | "offer" | "basket" | "purchase_terms", message: string) => res.status(400).json({ status: "invalid_input", observed_at: now().toISOString(), data: null, error: { code: "INVALID_INPUT", message, retryable: false }, ui_region: region });
  const winnerFor = (product: Product, memberId: string) => {
    const member = config.membersById.get(memberId);
    return member ? selectMemberOffer(product, member, offerStore.all(), now()) : undefined;
  };
  const adminEnvelope = (status: string, data: unknown = null, error: unknown = null) => ({ status, observed_at: now().toISOString(), data, error, ui_region: "admin_offers" });
  const adminFailure = (res: Response, status: number, code: string, message: string, state = "invalid_input") => res.status(status).json(adminEnvelope(state, null, { code, message, retryable: false }));
  const requireOwner = async (req: Request, res: Response, mutation = false) => {
    const auth = await activeOwner(req, res);
    if (!auth.session) { adminFailure(res, 401, "OWNER_SIGN_IN_REQUIRED", "Owner sign-in is required.", "sign_in_required"); return null; }
    if (mutation && !validateRequest(req.get("origin"), req.get("x-request-token") ?? req.body?.request_token, originFor(req), auth.session.request_token)) { adminFailure(res, 403, "REQUEST_REJECTED", "Refresh the page and try again.", "invalid_request"); return null; }
    return auth.session;
  };

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.get("/api/products/search", (req, res) => {
    if (options.failOperation === "catalogue") throw new Error("catalogue");
    const input: Record<string, unknown> = {};
    if ("query" in req.query) input.query = req.query.query;
    if ("category" in req.query) input.category = req.query.category;
    if ("max_price_pence" in req.query) input.max_price_pence = typeof req.query.max_price_pence === "string" && /^\d+$/.test(req.query.max_price_pence) ? Number(req.query.max_price_pence) : req.query.max_price_pence;
    if ("max_delivered_price_pence" in req.query) input.max_delivered_price_pence = typeof req.query.max_delivered_price_pence === "string" && /^\d+$/.test(req.query.max_delivered_price_pence) ? Number(req.query.max_delivered_price_pence) : req.query.max_delivered_price_pence;
    if ("in_stock_only" in req.query) input.in_stock_only = req.query.in_stock_only === "true" ? true : req.query.in_stock_only === "false" ? false : req.query.in_stock_only;
    if ("connection" in req.query) input.connection = req.query.connection;
    if ("features" in req.query) input.features = Array.isArray(req.query.features) ? req.query.features : [req.query.features];
    if ("sort" in req.query) input.sort = req.query.sort;
    if ("limit" in req.query) input.limit = typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : req.query.limit;
    const result = searchProducts(input, config.products, now());
    res.status(result.status === "invalid_input" ? 400 : 200).json(result);
  });

  app.post("/api/products/compare", async (req, res) => {
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
    const auth = await activeSession(req, res);
    const result = compareProducts(keys.length === 1 && keys[0] === "product_ids" ? req.body.product_ids : null, config.products, (product) => auth.session ? (winnerFor(product, auth.session.member_id) ? "available" : "not_available") : "sign_in_required", now());
    return res.status(result.status === "invalid_input" ? 400 : 200).json(result);
  });

  app.get("/api/products/:product_id", (req, res) => {
    const product = config.productsById.get(req.params.product_id);
    if (!product) return invalidInput(res, "product", "Choose a product from the catalogue.");
    return res.json({ status: "ok", observed_at: now().toISOString(), data: { product: publicProduct(product) }, error: null, ui_region: "product" });
  });

  app.get("/api/store/policies", (req, res) => {
    if (!policyTopic(req.query.topic)) return invalidInput(res, "product", "Choose delivery, returns, or member_offers.");
    return res.json({ status: "ok", observed_at: now().toISOString(), data: { topic: req.query.topic, ...policies[req.query.topic] }, error: null, ui_region: "product" });
  });

  app.get("/api/admin/offers", async (req, res) => {
    if (!await requireOwner(req, res)) return;
    if (options.failOperation === "admin") throw new Error("admin");
    const data = offerStore.list();
    return res.json(adminEnvelope("ok", { ...data, offers: data.offers.map((offer) => ({ ...offer, phase: offerPhase(offer, now()) })) }));
  });

  app.post("/api/admin/offers/preview", async (req, res) => {
    const owner = await requireOwner(req, res, true);
    if (!owner) return;
    try {
      const operation = req.body?.operation === "revise" ? "revise" : req.body?.operation === "create" ? "create" : null;
      const offerId = operation === "revise" && typeof req.body?.offer_id === "string" ? req.body.offer_id : null;
      if (!operation || (operation === "revise" && !offerId) || !Number.isInteger(req.body?.expected_version) || req.body.expected_version !== offerStore.version) throw req.body?.expected_version !== offerStore.version ? new VersionConflictError() : new OfferValidationError("Choose create or revise and use the current version.");
      const draft = offerStore.validate(req.body?.draft);
      if (operation === "revise") {
        const existing = offerStore.current().find(({ offer_id }) => offer_id === offerId);
        if (!existing || existing.status === "archived") throw new OfferValidationError("Choose a revisable offer.");
      }
      const samples = draft.product_ids.map((id) => {
        const product = config.productsById.get(id)!;
        const discount_pence = Math.round(product.unit_price_pence * draft.discount_percent / 100);
        return { product_id: id, sku: product.sku, public_delivered_total_pence: product.unit_price_pence + product.delivery_pence, discount_pence, delivery_pence: draft.delivery_pence ?? product.delivery_pence, delivered_total_pence: deliveredTotal(product, draft) };
      });
      const preview_token = issueOfferPreview(draft, operation, offerId, req.body.expected_version, owner, config.secrets.offer, config.secrets.binding, now());
      return res.json(adminEnvelope("preview_ready", { draft, samples, expected_version: req.body.expected_version, preview_token, expires_at: new Date(now().getTime() + 5 * 60_000).toISOString() }));
    } catch (error) {
      if (error instanceof VersionConflictError) return adminFailure(res, 409, "VERSION_CONFLICT", error.message, "version_conflict");
      if (error instanceof OfferValidationError) return adminFailure(res, 400, "INVALID_OFFER", error.message);
      throw error;
    }
  });

  const commitPreview = async (req: Request, res: Response, operation: "create" | "revise", offerId: string | null) => {
    const owner = await requireOwner(req, res, true);
    if (!owner) return;
    const verification = verifyOfferPreview(req.body?.preview_token, operation, offerId, owner, config.secrets.offer, config.secrets.binding, now());
    if (verification.status === "expired") return adminFailure(res, 400, "PREVIEW_EXPIRED", "Preview expired. Preview the offer again.", "preview_expired");
    if (verification.status === "invalid") return adminFailure(res, 400, "PREVIEW_INVALID", "Preview the complete offer before saving it.", "invalid_preview");
    try {
      const revision = operation === "create"
        ? await offerStore.create(verification.claims.draft, verification.claims.expected_version, owner.owner_id, now())
        : await offerStore.revise(offerId!, verification.claims.draft, verification.claims.expected_version, owner.owner_id, now());
      return res.status(201).json(adminEnvelope(operation === "create" ? "created" : "revised", { revision, version: offerStore.version }));
    } catch (error) {
      if (error instanceof VersionConflictError) return adminFailure(res, 409, "VERSION_CONFLICT", error.message, "version_conflict");
      if (error instanceof OfferValidationError) return adminFailure(res, 400, "INVALID_OFFER", error.message);
      throw error;
    }
  };
  app.post("/api/admin/offers", (req, res) => commitPreview(req, res, "create", null));
  app.put("/api/admin/offers/:offer_id", (req, res) => commitPreview(req, res, "revise", req.params.offer_id));
  app.post("/api/admin/offers/:offer_id/status", async (req, res) => {
    const owner = await requireOwner(req, res, true);
    if (!owner) return;
    try {
      const revision = await offerStore.setStatus(req.params.offer_id, req.body?.status, req.body?.expected_version, owner.owner_id, now());
      return res.json(adminEnvelope("status_changed", { revision, version: offerStore.version }));
    } catch (error) {
      if (error instanceof VersionConflictError) return adminFailure(res, 409, "VERSION_CONFLICT", error.message, "version_conflict");
      if (error instanceof OfferValidationError) return adminFailure(res, 400, "INVALID_OFFER", error.message);
      throw error;
    }
  });

  app.post("/api/offers/evaluate", async (req, res) => {
    if (options.failOperation === "offer") throw new Error("offer");
    if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length !== 1 || typeof req.body.product_id !== "string") return invalidInput(res, "offer", "Choose a listed product.");
    const product = config.productsById.get(req.body.product_id);
    if (!product) return invalidInput(res, "offer", "Choose a listed product.");
    const auth = await activeSession(req, res);
    if (!auth.session) return res.json({ status: "sign_in_required", observed_at: now().toISOString(), data: { product_id: product.id, reason: auth.reason, sign_in_url: `/signin?return_to=${product.product_url}` }, error: null, ui_region: "offer" });
    if (product.stock_quantity < 1) return res.json({ status: "out_of_stock", observed_at: now().toISOString(), data: { product_id: product.id, reason: "This product is currently out of stock." }, error: null, ui_region: "offer" });
    const snapshot = winnerFor(product, auth.session.member_id);
    if (!snapshot) return res.json({ status: "ineligible", observed_at: now().toISOString(), data: { product_id: product.id, reason: "No active member offer applies to this product." }, error: null, ui_region: "offer" });
    const issuedAt = now();
    const offerQuote = issueOfferQuote(snapshot, auth.session, config.secrets.offer, config.secrets.binding, issuedAt);
    return res.json({ status: "eligible", observed_at: issuedAt.toISOString(), data: { offer_quote: offerQuote, ...snapshot, stock_quantity: undefined, issued_at: issuedAt.toISOString(), expires_at: new Date(issuedAt.getTime() + 5 * 60_000).toISOString() }, error: null, ui_region: "offer" });
  });

  app.post("/api/purchase-terms/verify", async (req, res) => {
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body).sort().join(",") : "";
    const product = typeof req.body?.product_id === "string" ? config.productsById.get(req.body.product_id) : undefined;
    if (keys !== "offer_quote,product_id,quantity" || !product || req.body.quantity !== 1 || typeof req.body.offer_quote !== "string") return invalidInput(res, "purchase_terms", "Purchase-term verification requires a listed product, current offer quote, and quantity 1.");
    const auth = await activeSession(req, res);
    if (!auth.session) return res.json({ status: "sign_in_required", observed_at: now().toISOString(), data: { product_id: product.id, reason: auth.reason, sign_in_url: `/signin?return_to=${product.product_url}` }, error: null, ui_region: "purchase_terms" });
    const winner = winnerFor(product, auth.session.member_id);
    if (!winner) return res.json({ status: "quote_stale", observed_at: now().toISOString(), data: { reason: "This member offer has changed.", refresh_offer: true }, error: null, ui_region: "purchase_terms" });
    const verification = verifyOfferQuote(req.body.offer_quote, auth.session, product, winner, config.secrets.offer, config.secrets.binding, now());
    if (verification.status === "invalid") return res.status(400).json({ status: "invalid_quote", observed_at: now().toISOString(), data: null, error: { code: "OFFER_INVALID", message: "Refresh your member offer and try again.", retryable: false }, ui_region: "purchase_terms" });
    if (verification.status === "expired") return res.json({ status: "quote_expired", observed_at: now().toISOString(), data: { reason: "This member offer expired.", refresh_offer: true }, error: null, ui_region: "purchase_terms" });
    if (verification.status === "stale") return res.json({ status: "quote_stale", observed_at: now().toISOString(), data: { reason: "This member offer has changed.", refresh_offer: true }, error: null, ui_region: "purchase_terms" });
    if (verification.status === "out_of_stock") return res.json({ status: "out_of_stock", observed_at: now().toISOString(), data: { reason: "This product is currently out of stock." }, error: null, ui_region: "purchase_terms" });
    const claims = verification.claims;
    const publicTotal = product.unit_price_pence + product.delivery_pence;
    const verifiedAt = now().toISOString();
    return res.json({ status: "verified", observed_at: verifiedAt, data: {
      merchant: "Northmere Audio",
      product: { product_id: product.id, title: product.title, sku: claims.sku, variant: product.variant, quantity: 1 },
      terms: { currency: claims.currency, unit_price_pence: claims.unit_price_pence, public_delivery_pence: product.delivery_pence, public_delivered_total_pence: publicTotal, discount_pence: claims.discount_pence, member_delivery_pence: claims.delivery_pence, delivered_total_pence: claims.delivered_total_pence, savings_pence: publicTotal - claims.delivered_total_pence, stock_status: "in_stock", stock_quantity: claims.stock_quantity, delivery_estimate: product.delivery_estimate, returns: { window_days: 30, summary: policies.returns.body }, warranty: { status: "not_provided", summary: "Warranty information is not provided by this demonstration." } },
      benefit: { rule_id: claims.rule_id, rule_version: claims.rule_version, reason: winner.reason },
      verified_at: verifiedAt, valid_until: claims.expires_at,
      privacy: { credentials_shared: false, competitor_data_shared: false, purchase_created: false }
    }, error: null, ui_region: "purchase_terms" });
  });

  app.post("/api/basket/preview", async (req, res) => {
    if (options.failOperation === "basket") throw new Error("basket");
    const session = await sessionFor(req, res);
    if (!session.request_token || !validateRequest(req.get("origin"), req.get("x-request-token"), originFor(req), session.request_token)) return invalidRequest(res);
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body).sort().join(",") : "";
    const offered = keys === "offer_quote,product_id,quantity";
    const publicPrice = keys === "product_id,quantity";
    const product = typeof req.body?.product_id === "string" ? config.productsById.get(req.body.product_id) : undefined;
    if ((!offered && !publicPrice) || !product || req.body.quantity !== 1 || (offered && typeof req.body.offer_quote !== "string")) return invalidInput(res, "basket", "Basket preview requires a listed product and quantity 1.");
    if (product.stock_quantity < 1) return res.json({ status: "out_of_stock", observed_at: now().toISOString(), data: { product_id: product.id, reason: "This product is currently out of stock." }, error: null, ui_region: "basket" });
    if (publicPrice) {
      const line_item = { product_id: product.id, sku: product.sku, quantity: 1, currency: product.currency, unit_price_pence: product.unit_price_pence, discount_pence: 0, delivery_pence: product.delivery_pence, delivered_total_pence: product.unit_price_pence + product.delivery_pence, pricing: "public" };
      return res.json({ status: "preview_ready", observed_at: now().toISOString(), data: { line_item, basket: { line_count: 1, currency: "GBP", delivered_total_pence: line_item.delivered_total_pence }, checkout_preview_url: "/checkout-preview" }, error: null, ui_region: "basket" });
    }
    const state = validateSession(session, now());
    if (!state.active) {
      if (state.reason === "session_expired") session.destroy();
      return res.json({ status: "sign_in_required", observed_at: now().toISOString(), data: { product_id: product.id, reason: state.reason, sign_in_url: `/signin?return_to=${product.product_url}` }, error: null, ui_region: "basket" });
    }
    session.last_seen_at = now().toISOString();
    await session.save();
    const winner = winnerFor(product, (session as MemberSession).member_id);
    if (!winner) return res.json({ status: "quote_stale", observed_at: now().toISOString(), data: { reason: "This member offer has changed.", refresh_offer: true }, error: null, ui_region: "basket" });
    const verification = verifyOfferQuote(req.body.offer_quote, session as MemberSession, product, winner, config.secrets.offer, config.secrets.binding, now());
    if (verification.status === "invalid") return res.status(400).json({ status: "invalid_quote", observed_at: now().toISOString(), data: null, error: { code: "OFFER_INVALID", message: "Refresh your member offer and try again.", retryable: false }, ui_region: "basket" });
    if (verification.status === "expired") return res.json({ status: "quote_expired", observed_at: now().toISOString(), data: { reason: "This member offer expired.", refresh_offer: true }, error: null, ui_region: "basket" });
    if (verification.status === "stale") return res.json({ status: "quote_stale", observed_at: now().toISOString(), data: { reason: "This member offer has changed.", refresh_offer: true }, error: null, ui_region: "basket" });
    if (verification.status === "out_of_stock") return res.json({ status: "out_of_stock", observed_at: now().toISOString(), data: { reason: "This product is currently out of stock." }, error: null, ui_region: "basket" });
    const claims = verification.claims;
    const line_item = { product_id: claims.product_id, sku: claims.sku, quantity: 1, currency: claims.currency, unit_price_pence: claims.unit_price_pence, discount_pence: claims.discount_pence, delivery_pence: claims.delivery_pence, delivered_total_pence: claims.delivered_total_pence };
    return res.json({ status: "preview_ready", observed_at: now().toISOString(), data: { line_item, basket: { line_count: 1, currency: "GBP", delivered_total_pence: line_item.delivered_total_pence }, applied_rule: { rule_id: claims.rule_id, rule_version: claims.rule_version }, checkout_preview_url: "/checkout-preview" }, error: null, ui_region: "basket" });
  });

  app.get("/", async (req, res) => { const { token } = await requestTokenFor(req, res); res.send(homeView(config.products, token, await signedIn(req, res))); });
  app.get("/shop", async (req, res) => { const { token } = await requestTokenFor(req, res); res.send(shopView(config.products, token, await signedIn(req, res))); });
  app.get("/products/:sku", async (req, res) => {
    if (options.failOperation === "product_page") throw new Error("product page");
    const canonical = req.params.sku.toUpperCase();
    const product = config.productsBySku.get(canonical);
    if (!product) return res.status(404).send(notFoundView());
    if (req.params.sku !== canonical) return res.redirect(308, product.product_url);
    const { token } = await requestTokenFor(req, res);
    return res.send(productView(product, token, await signedIn(req, res)));
  });
  app.get("/account", async (req, res) => {
    const { token } = await requestTokenFor(req, res);
    const auth = await activeSession(req, res);
    const offerProducts = auth.session ? config.products.filter((product) => Boolean(winnerFor(product, auth.session!.member_id))) : [];
    res.send(accountView(token, Boolean(auth.session), offerProducts));
  });
  app.get("/policies/:topic", async (req, res) => {
    if (!policyTopic(req.params.topic)) return res.status(404).send(notFoundView());
    const { token } = await requestTokenFor(req, res);
    const policy = policies[req.params.topic];
    return res.send(policyView(req.params.topic, policy.title, policy.body, token, await signedIn(req, res)));
  });
  app.get("/signin", async (req, res) => { const { token } = await requestTokenFor(req, res); res.send(signInView(token, safeReturnTo(req.query.return_to), req.query.error === "1" ? "Unable to sign in with those credentials." : "")); });
  app.post("/signin", async (req, res) => {
    const session = await sessionFor(req, res);
    const returnTo = safeReturnTo(req.body?.return_to);
    const validBoundary = Boolean(session.request_token) && validateRequest(req.get("origin"), req.body?.request_token, originFor(req), session.request_token!);
    if (!validBoundary) return res.status(403).send(signInView(session.request_token ?? "", returnTo, "Unable to sign in. Refresh the page and try again."));
    const member = typeof req.body?.email === "string" ? config.membersByEmail.get(req.body.email.toLocaleLowerCase("en-GB")) : undefined;
    if (!member || !await authenticate(req.body?.email, req.body?.password, member)) return res.status(401).send(signInView(session.request_token!, returnTo, "Unable to sign in with those credentials."));
    Object.assign(session, createMemberSession(member.id, now()));
    await session.save();
    return res.redirect(303, returnTo);
  });
  app.get("/admin/signin", async (req, res) => {
    const { token } = await ownerRequestTokenFor(req, res);
    if ((await activeOwner(req, res)).session) return res.redirect(303, "/admin/offers");
    return res.send(adminSignInView(token, req.query.error === "1" ? "Unable to sign in with those credentials." : ""));
  });
  app.post("/admin/signin", async (req, res) => {
    const session = await ownerSessionFor(req, res);
    if (!session.request_token || !validateRequest(req.get("origin"), req.body?.request_token, originFor(req), session.request_token)) return res.status(403).send(adminSignInView(session.request_token ?? "", "Unable to sign in. Refresh the page and try again."));
    if (!await authenticate(req.body?.email, req.body?.password, ownerAccount)) return res.status(401).send(adminSignInView(session.request_token, "Unable to sign in with those credentials."));
    Object.assign(session, createOwnerSession(ownerAccount.id, now()));
    await session.save();
    return res.redirect(303, "/admin/offers");
  });
  app.get("/admin/offers", async (req, res) => {
    const auth = await activeOwner(req, res);
    if (!auth.session) return res.redirect(303, "/admin/signin");
    return res.send(adminOffersView(auth.session.request_token, config.products, config.members, offerStore.list(), now()));
  });
  app.post("/admin/logout", async (req, res) => {
    const session = await ownerSessionFor(req, res);
    if (!session.request_token || !validateRequest(req.get("origin"), req.body?.request_token, originFor(req), session.request_token)) return res.status(403).send(recoveryView());
    session.destroy();
    return res.redirect(303, "/admin/signin");
  });
  app.post("/logout", async (req, res) => {
    const session = await sessionFor(req, res);
    const supplied = req.get("x-request-token") ?? req.body?.request_token;
    if (!session.request_token || !validateRequest(req.get("origin"), supplied, originFor(req), session.request_token)) return res.status(403).send(recoveryView());
    session.destroy();
    return res.redirect(303, "/products/AX7-BLK?logged_out=1");
  });
  app.get("/basket", async (req, res) => { const { token } = await requestTokenFor(req, res); res.send(basketView(token, await signedIn(req, res))); });
  app.get("/checkout-preview", async (req, res) => res.send(checkoutView((await requestTokenFor(req, res)).token)));
  app.get("/offer-rule", async (req, res) => res.send(ruleView((await requestTokenFor(req, res)).token, offerStore.current())));

  app.use((_req, res) => res.status(404).send(notFoundView()));
  app.use((_error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (req.path.startsWith("/api/")) {
      const operation = req.path.includes("/admin/") ? ["ADMIN_UNAVAILABLE", "Offer management is temporarily unavailable.", "admin_offers"] : req.path.includes("products") ? ["CATALOGUE_UNAVAILABLE", "Product search is temporarily unavailable.", "product"] : req.path.includes("purchase-terms") ? ["TERMS_UNAVAILABLE", "Purchase terms are temporarily unavailable.", "purchase_terms"] : req.path.includes("offers") ? ["OFFER_UNAVAILABLE", "Member offers are temporarily unavailable.", "offer"] : ["BASKET_UNAVAILABLE", "Basket preview is temporarily unavailable.", "basket"];
      return res.status(503).json({ status: "service_unavailable", observed_at: now().toISOString(), data: null, error: { code: operation[0], message: operation[1], retryable: true }, ui_region: operation[2] });
    }
    return res.status(503).send(recoveryView());
  });
  return app;
}
