# ElemKey

ElemKey is a 16-product WebMCP storefront demonstration for the fictional retailer Northmere Audio. Public search, filtering, product details, policies and a reversible basket are shared by shoppers and agents; owner-managed member prices appear only after the shopper signs in themselves.

The demo stops at a reversible basket and explicitly non-payment checkout preview. It has no purchase endpoint, payment processor, order record, competitor-price input, customer identifier in a shopper tool schema, or managed production database.

## Run locally

Requirements: Node.js 24 and Chromium (Playwright installs its own test browser).

```bash
npm ci
export SESSION_COOKIE_SECRET="$(openssl rand -base64 32)"
export OFFER_TOKEN_SECRET="$(openssl rand -base64 32)"
export MEMBER_BINDING_SECRET="$(openssl rand -base64 32)"
npm run build
npm start
```

Open `http://localhost:3000/`.

### Run in Docker

For a local production-like run:

```bash
export SESSION_COOKIE_SECRET="$(openssl rand -base64 32)"
export OFFER_TOKEN_SECRET="$(openssl rand -base64 32)"
export MEMBER_BINDING_SECRET="$(openssl rand -base64 32)"
docker compose up -d --build --wait
BASE_URL=http://127.0.0.1:3000 npm run smoke
```

The service is then available at `http://127.0.0.1:3000/`. Compose binds only to loopback, runs the application as a non-root user, mounts `./data` at `/data` for atomic offer snapshots, and refuses to start without all three secrets.

Fictional judge credentials:

- Email: `sagar@example.test`
- Password: `ElemKeyDemo2026!`

VIP member:

- Email: `vip@northmere.test`
- Password: `ElemKeyVip2026!`

Northmere owner workspace (`/admin/signin`):

- Email: `owner@northmere.test`
- Password: `NorthmereOwner2026!`

The fixture stores only a `crypto.scrypt` salt/hash. All three runtime secrets must be distinct base64 values decoding to at least 32 bytes; startup fails closed otherwise.

## Architecture and contracts

One Express service serves plain server-rendered HTML, CSS, browser JavaScript, local SVG product art, the existing shopper APIs, and five owner APIs used by both human controls and WebMCP handlers:

- `GET /api/products/search` → `search_products`
- `POST /api/offers/evaluate` → `get_member_offer`
- `POST /api/purchase-terms/verify` → `verify_purchase_terms`
- `POST /api/basket/preview` → `prepare_basket`
- `GET /api/products/:product_id` → `view_product`, `get_product_details`
- `GET /api/store/policies` → `get_store_policies`
- `GET /api/admin/offers` → `list_member_offers`
- `POST /api/admin/offers/preview` → `preview_member_offer`
- `POST /api/admin/offers` → `create_member_offer`
- `PUT /api/admin/offers/:offer_id` → `revise_member_offer`
- `POST /api/admin/offers/:offer_id/status` → `set_member_offer_status`

`iron-session` encrypts/authenticates separate HttpOnly, SameSite=Lax member and owner cookies. Sessions have a 30-minute idle limit and eight-hour absolute limit. Node HMAC signs five-minute member quotes and owner previews. `data/offers.json` is schema validated at startup and replaced atomically on every immutable revision. The reversible basket remains in current-tab `sessionStorage` and is revalidated against the current winning offer on `/basket`.

The browser feature-detects `document.modelContext`. Without it, the same journeys remain available through normal controls. Shopper pages keep their existing page-scoped tool sets. Signed-in `/admin/offers` registers only the five owner tools; both sign-in pages and checkout-preview register no tools. Every registration has an aborted page-lifecycle signal, and no schema accepts credentials, competitor evidence, or a purchase instruction.

## Verification

```bash
npm test
BASE_URL=http://127.0.0.1:3000 npm run smoke
```

`npm test` runs TypeScript checking, compiled `node:test` domain/security/live-HTTP tests, and Playwright storefront/WebMCP wiring tests. Mock WebMCP proves local application wiring only. Local native discovery/execution is recorded in [test/local-docker-acceptance.md](test/local-docker-acceptance.md); public production evidence is recorded separately in [test/deployed-acceptance.md](test/deployed-acceptance.md).

After the Docker service is healthy, run the browser suites against that exact container:

```bash
E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test test/commerce.e2e.spec.ts
xvfb-run -a env NATIVE_WEBMCP=1 E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test test/native-webmcp.e2e.spec.ts --repeat-each=10 --workers=1
```

The native test uses installed Chrome Canary with WebMCP testing features enabled. The completed local gate is recorded in [test/local-docker-acceptance.md](test/local-docker-acceptance.md).

## Deployment status

- Live application: https://elemkey.onrender.com
- Public source: https://github.com/sagarsea/elemkey
- Local Docker: `http://127.0.0.1:3000`

The Render smoke test, GitHub Actions, complete regression suite, native WebMCP journey, manual sign-in handoff, and ten fresh deployed Canary sessions are green. The service uses a persistent Render disk at `/data` and stops at a non-payment checkout preview.

Licensed under the [MIT License](LICENSE).
