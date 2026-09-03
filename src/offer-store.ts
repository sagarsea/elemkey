import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Member, MemberTier, OfferRule, OfferSnapshot, Product } from "./domain";

export type OfferStatus = "active" | "inactive" | "archived";
export type OfferAudience =
  | Readonly<{ type: "all" }>
  | Readonly<{ type: "tier"; tier: MemberTier }>
  | Readonly<{ type: "member_ids"; member_ids: readonly string[] }>;
export type OfferDraft = Readonly<{
  name: string;
  product_ids: readonly string[];
  audience: OfferAudience;
  discount_percent: number;
  delivery_pence: number | null;
  status: OfferStatus;
  starts_at: string | null;
  ends_at: string | null;
}>;
export type OfferRevision = OfferDraft & Readonly<{
  offer_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}>;
export type OfferSnapshotFile = Readonly<{ schema_version: 1; version: number; revisions: readonly OfferRevision[] }>;

export class OfferValidationError extends Error {
  constructor(message: string) { super(message); this.name = "OfferValidationError"; }
}
export class VersionConflictError extends Error {
  constructor() { super("Offer data changed. Refresh and preview again."); this.name = "VersionConflictError"; }
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : (() => { throw new OfferValidationError("Enter a complete offer."); })();
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const utc = (value: unknown, field: string) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new OfferValidationError(`${field} must be a UTC date and time.`);
  return new Date(value).toISOString();
};
const uniqueStrings = (value: unknown, field: string) => {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item)) throw new OfferValidationError(`Select at least one ${field}.`);
  if (new Set(value).size !== value.length) throw new OfferValidationError(`${field} cannot contain duplicates.`);
  return [...value] as string[];
};

function normalizeAudience(value: unknown, members: ReadonlyMap<string, Member>): OfferAudience {
  if (value === "all") return Object.freeze({ type: "all" });
  const audience = record(value);
  if (audience.type === "all" && Object.keys(audience).length === 1) return Object.freeze({ type: "all" });
  if (audience.type === "tier" && Object.keys(audience).length === 2 && ["standard", "vip"].includes(audience.tier as string)) return Object.freeze({ type: "tier", tier: audience.tier as MemberTier });
  if (["members", "member_ids"].includes(audience.type as string)) {
    const ids = uniqueStrings(audience.member_ids, "member");
    if (ids.some((id) => !members.has(id))) throw new OfferValidationError("Choose known members only.");
    return Object.freeze({ type: "member_ids", member_ids: Object.freeze(ids) });
  }
  throw new OfferValidationError("Choose all members, one tier, or selected members.");
}

export function normalizeOfferDraft(value: unknown, products: ReadonlyMap<string, Product>, members: ReadonlyMap<string, Member>): OfferDraft {
  const draft = record(value);
  const allowed = ["name", "product_ids", "audience", "discount_percent", "delivery_pence", "status", "starts_at", "ends_at"];
  if (Object.keys(draft).some((key) => !allowed.includes(key))) throw new OfferValidationError("Enter only supported offer fields.");
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name || name.length > 100) throw new OfferValidationError("Enter an offer name up to 100 characters.");
  const product_ids = uniqueStrings(draft.product_ids, "product");
  if (product_ids.some((id) => !products.has(id))) throw new OfferValidationError("Choose catalogue products only.");
  if (!integer(draft.discount_percent, 0, 100)) throw new OfferValidationError("Discount must be a whole percentage from 0 to 100.");
  if (draft.delivery_pence !== null && !integer(draft.delivery_pence)) throw new OfferValidationError("Delivery must be null or non-negative integer pence.");
  if (!["active", "inactive", "archived"].includes(draft.status as string)) throw new OfferValidationError("Choose active, inactive, or archived status.");
  const starts_at = utc(draft.starts_at, "Start");
  const ends_at = utc(draft.ends_at, "End");
  if (starts_at && ends_at && Date.parse(starts_at) >= Date.parse(ends_at)) throw new OfferValidationError("End must be after start.");
  const normalized = Object.freeze({
    name,
    product_ids: Object.freeze(product_ids),
    audience: normalizeAudience(draft.audience, members),
    discount_percent: draft.discount_percent as number,
    delivery_pence: draft.delivery_pence as number | null,
    status: draft.status as OfferStatus,
    starts_at,
    ends_at
  });
  const improves = product_ids.some((id) => {
    const product = products.get(id)!;
    return deliveredTotal(product, normalized) < product.unit_price_pence + product.delivery_pence;
  });
  if (!improves) throw new OfferValidationError("The offer must improve at least one selected product's delivered total.");
  return normalized;
}

export const deliveredTotal = (product: Product, offer: Pick<OfferDraft, "discount_percent" | "delivery_pence">) =>
  product.unit_price_pence - Math.round(product.unit_price_pence * offer.discount_percent / 100) + (offer.delivery_pence ?? product.delivery_pence);

export const personalizedDiscountPercent = (memberId: string, productId: string) =>
  5 + createHash("sha256").update(`${memberId}:${productId}`).digest()[0] % 11;

const currentRevisions = (revisions: readonly OfferRevision[]) => [...new Map(revisions.map((revision) => [revision.offer_id, revision])).values()];
const migrateLegacyMemberIds = (raw: string) => raw
  .replaceAll('"member-demo-1"', '"member-standard-1"')
  .replaceAll('"member-demo-vip"', '"member-vip-1"');
const writeSnapshotSync = (path: string, snapshot: OfferSnapshotFile) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
  renameSync(temporary, path);
};

function validateSnapshot(value: unknown, products: ReadonlyMap<string, Product>, members: ReadonlyMap<string, Member>): OfferSnapshotFile {
  const snapshot = record(value);
  if (snapshot.schema_version !== 1 || !integer(snapshot.version) || !Array.isArray(snapshot.revisions)) throw new Error("Invalid ElemKey offer data");
  const revisions: OfferRevision[] = [];
  const versions = new Map<string, number>();
  const archived = new Set<string>();
  for (const value of snapshot.revisions) {
    const item = record(value);
    const allowed = ["offer_id", "version", "name", "product_ids", "audience", "discount_percent", "delivery_pence", "status", "starts_at", "ends_at", "created_at", "updated_at", "created_by"];
    if (Object.keys(item).length !== allowed.length || allowed.some((key) => !(key in item)) || typeof item.offer_id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(item.offer_id) || !integer(item.version, 1) || typeof item.created_by !== "string" || !item.created_by || !utc(item.created_at, "Created") || !utc(item.updated_at, "Updated")) throw new Error("Invalid ElemKey offer data");
    const expected = (versions.get(item.offer_id) ?? 0) + 1;
    if (item.version !== expected || archived.has(item.offer_id)) throw new Error("Invalid ElemKey offer data");
    versions.set(item.offer_id, expected);
    const draft = Object.fromEntries(["name", "product_ids", "audience", "discount_percent", "delivery_pence", "status", "starts_at", "ends_at"].map((key) => [key, item[key]]));
    try {
      const revision = Object.freeze({ ...normalizeOfferDraft(draft, products, members), offer_id: item.offer_id, version: item.version, created_at: item.created_at, updated_at: item.updated_at, created_by: item.created_by }) as OfferRevision;
      revisions.push(revision);
      if (revision.status === "archived") archived.add(revision.offer_id);
    }
    catch { throw new Error("Invalid ElemKey offer data"); }
  }
  if (revisions.length < 1 || snapshot.version !== revisions.length) throw new Error("Invalid ElemKey offer data");
  return Object.freeze({ schema_version: 1, version: snapshot.version as number, revisions: Object.freeze(revisions) });
}

export class OfferStore {
  private snapshot: OfferSnapshotFile;
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private readonly products: ReadonlyMap<string, Product>, private readonly members: ReadonlyMap<string, Member>, snapshot: OfferSnapshotFile) { this.snapshot = snapshot; }

  static open(path: string, products: ReadonlyMap<string, Product>, members: ReadonlyMap<string, Member>, rules: readonly OfferRule[], now = new Date()) {
    const fullPath = resolve(path);
    let snapshot: OfferSnapshotFile;
    try {
      const raw = readFileSync(fullPath, "utf8");
      const migrated = migrateLegacyMemberIds(raw);
      snapshot = validateSnapshot(JSON.parse(migrated), products, members);
      if (migrated !== raw) writeSnapshotSync(fullPath, snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const timestamp = now.toISOString();
      const product_ids = rules.map(({ product_sku }) => [...products.values()].find(({ sku }) => sku === product_sku)?.id).filter((id): id is string => Boolean(id));
      const first = rules[0];
      if (!first || product_ids.length !== rules.length) throw new Error("Invalid ElemKey offer seed");
      const seed = normalizeOfferDraft({ name: "Member 5% and free delivery", product_ids, audience: { type: "all" }, discount_percent: first.discount_percent, delivery_pence: first.delivery_pence, status: first.status, starts_at: null, ends_at: null }, products, members);
      snapshot = Object.freeze({ schema_version: 1, version: 1, revisions: Object.freeze([Object.freeze({ ...seed, offer_id: first.rule_id, version: 1, created_at: timestamp, updated_at: timestamp, created_by: "system" })]) });
      writeSnapshotSync(fullPath, snapshot);
    }
    return new OfferStore(fullPath, products, members, snapshot);
  }

  get version() { return this.snapshot.version; }
  all() { return this.snapshot.revisions; }
  current() { return currentRevisions(this.snapshot.revisions); }
  list() { return { schema_version: 1 as const, version: this.snapshot.version, offers: this.current(), revisions: this.snapshot.revisions }; }
  validate(draft: unknown) { return normalizeOfferDraft(draft, this.products, this.members); }

  private transact(expectedVersion: number, change: (snapshot: OfferSnapshotFile) => OfferRevision) {
    const operation = this.queue.then(async () => {
      if (!integer(expectedVersion) || expectedVersion !== this.snapshot.version) throw new VersionConflictError();
      const revision = change(this.snapshot);
      const next = Object.freeze({ schema_version: 1 as const, version: this.snapshot.version + 1, revisions: Object.freeze([...this.snapshot.revisions, revision]) });
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.snapshot = next;
      return revision;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  create(draftValue: unknown, expectedVersion: number, ownerId: string, now = new Date()) {
    const draft = this.validate(draftValue);
    return this.transact(expectedVersion, () => {
      const timestamp = now.toISOString();
      return Object.freeze({ ...draft, offer_id: `offer-${randomUUID()}`, version: 1, created_at: timestamp, updated_at: timestamp, created_by: ownerId });
    });
  }

  revise(offerId: string, draftValue: unknown, expectedVersion: number, ownerId: string, now = new Date()) {
    const draft = this.validate(draftValue);
    return this.transact(expectedVersion, (snapshot) => {
      const prior = currentRevisions(snapshot.revisions).find(({ offer_id }) => offer_id === offerId);
      if (!prior) throw new OfferValidationError("Choose an existing offer.");
      if (prior.status === "archived") throw new OfferValidationError("Archived offers cannot be revised.");
      return Object.freeze({ ...draft, offer_id: offerId, version: prior.version + 1, created_at: prior.created_at, updated_at: now.toISOString(), created_by: ownerId });
    });
  }

  setStatus(offerId: string, status: OfferStatus, expectedVersion: number, ownerId: string, now = new Date()) {
    if (!["active", "inactive", "archived"].includes(status)) throw new OfferValidationError("Choose active, inactive, or archived status.");
    return this.transact(expectedVersion, (snapshot) => {
      const prior = currentRevisions(snapshot.revisions).find(({ offer_id }) => offer_id === offerId);
      if (!prior) throw new OfferValidationError("Choose an existing offer.");
      if (prior.status === "archived") throw new OfferValidationError("Archived offers cannot change status.");
      return Object.freeze({ ...prior, status, version: prior.version + 1, updated_at: now.toISOString(), created_by: ownerId });
    });
  }
}

export function offerPhase(offer: OfferRevision, now = new Date()) {
  if (offer.status !== "active") return offer.status;
  const time = now.getTime();
  if (offer.starts_at && time < Date.parse(offer.starts_at)) return "scheduled" as const;
  if (offer.ends_at && time >= Date.parse(offer.ends_at)) return "expired" as const;
  return "current" as const;
}

export function selectMemberOffer(product: Product, member: Member, revisions: readonly OfferRevision[], now = new Date()): OfferSnapshot | undefined {
  const eligible = currentRevisions(revisions).filter((offer) => offerPhase(offer, now) === "current" && offer.product_ids.includes(product.id) && (
    offer.audience.type === "all" ||
    (offer.audience.type === "tier" && offer.audience.tier === member.tier) ||
    (offer.audience.type === "member_ids" && offer.audience.member_ids.includes(member.id))
  )).map((offer) => {
    const discount_percent = offer.offer_id === "MEMBER-5-FREE" ? Math.max(offer.discount_percent, personalizedDiscountPercent(member.id, product.id)) : offer.discount_percent;
    const discount_pence = Math.round(product.unit_price_pence * discount_percent / 100);
    const delivery_pence = offer.delivery_pence ?? product.delivery_pence;
    return { offer, discount_percent, discount_pence, delivery_pence, delivered_total_pence: product.unit_price_pence - discount_pence + delivery_pence };
  }).sort((left, right) => left.delivered_total_pence - right.delivered_total_pence || right.offer.discount_percent - left.offer.discount_percent || left.delivery_pence - right.delivery_pence || left.offer.offer_id.localeCompare(right.offer.offer_id));
  const winner = eligible[0];
  if (!winner) return undefined;
  return Object.freeze({
    product_id: product.id, sku: product.sku, rule_id: winner.offer.offer_id, rule_version: winner.offer.version, currency: product.currency,
    unit_price_pence: product.unit_price_pence, stock_quantity: product.stock_quantity, discount_percent: winner.discount_percent,
    discount_pence: winner.discount_pence, delivery_pence: winner.delivery_pence, delivered_total_pence: winner.delivered_total_pence,
    reason: winner.offer.offer_id === "MEMBER-5-FREE" ? `Your personalised member offer is ${winner.discount_percent}% off with free delivery.` : `${winner.offer.name} is your best current member offer.`
  });
}
