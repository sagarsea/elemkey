# Local Docker acceptance record

Date: 2026-08-31
Target: `http://127.0.0.1:3000`
Image: `elemkey:local`
Browser: Google Chrome Canary 154.0.8031.0
WebMCP mode: native Chromium discovery and execution, not an injected mock

## Deployment gate

- PASS — image builds from `node:24-bookworm-slim` and starts on Node 24.
- PASS — missing or malformed secrets fail closed before the server listens.
- PASS — Compose binds only to `127.0.0.1:3000`.
- PASS — container runs as user `node`, mounts `./data:/data` for persistent offer revisions, and reports healthy.
- PASS — deployed smoke verifies health, API/cookie behavior, and absence of shared-cache TTLs.
- PASS — `docker compose up --build --force-recreate --wait` followed by the deployed smoke test proves clean recreation.
- PASS — ordinary storefront and injected WebMCP wiring suite: 17/17 applicable tests, with three environment-specific tests separately skipped.
- PASS — real Chrome Canary native WebMCP journey: nine product-page tools, signed-out tool call, manual sign-in, redirect, eligible AX7 offer, verified purchase terms, basket preview, and safe trace.
- PASS — responsive acceptance at 375×812, 768×1024 and 1280×720: no overflow, broken image or console error; current screenshots are stored under `.gstack/qa-reports/screenshots/`.

## Signed-in My Offers acceptance

Checked `2026-08-31T00:13:09Z` against a rebuilt, force-recreated healthy container.

### Mocked Playwright wiring

- PASS — `npm test`: 31/31 unit and HTTP checks; 17/17 ordinary/injected browser journeys; three environment-specific tests skipped.
- PASS — Docker-target run: 17/17 applicable browser journeys at `http://127.0.0.1:3000`; three environment-specific tests skipped.
- PASS — signed-out account exposes four global tools; signed-in account exposes those four plus unchanged `get_member_offer` and `prepare_basket` contracts.
- PASS — the four canonical offer identities are required while additional valid owner-created offers are allowed; recovery coverage includes ready, checking, eligible, in-basket, expired, stale, out-of-stock, ineligible and unavailable recovery states.
- PASS — 375, 768 and 1280px account layout checks have no horizontal overflow and preserve 44px mobile actions.

### Native Chrome Canary WebMCP

- PASS — 1/1 native-only journey on Chrome Canary with Chromium WebMCP flags and no injected `document.modelContext`.
- PASS — native discovery found the exact six signed-in account tools; native offer and basket execution updated the Velora row and verified basket visibly.
- Evidence: `.gstack/qa-reports/screenshots/native-webmcp-complete.png` (1265×2509).

### Docker and cache contract

- PASS — deployed smoke passed after `docker compose up --build --force-recreate --wait`.
- PASS — dynamic `/account` returned `Cache-Control: private, no-store`; static `/styles.css` retained `public, max-age=0`.

## Ten fresh native sessions

Completed `2026-08-31T00:13:09Z`. Ten isolated Playwright browser contexts ran the complete native shopper journey with one worker.

| Run | Result |
| ---: | :----- |
| 1 | PASS |
| 2 | PASS |
| 3 | PASS |
| 4 | PASS |
| 5 | PASS |
| 6 | PASS |
| 7 | PASS |
| 8 | PASS |
| 9 | PASS |
| 10 | PASS |

Final result: **10/10 PASS**.

Each run discovered the exact nine product-page tools and completed signed-out offer handling, human sign-in, £474.05 member evaluation, purchase-term verification, reversible basket preparation, account offer execution, and safe-trace checks.

## Merchant-verified purchase terms acceptance

Checked on 2026-08-31 against a rebuilt, force-recreated healthy container.

- PASS — deployed smoke at `http://127.0.0.1:3000`.
- PASS — mocked Docker WebMCP receipt journey: 1/1.
- PASS — native Chrome Canary `document.modelContext` journey: 1/1, with nine exact product-page tools including read-only `verify_purchase_terms`.
- PASS — the native tool visibly verified exact SKU/variant, £474.05 delivered total, current stock and delivery, 30-day returns, missing warranty information, and that no purchase was created.
- PASS — existing offer and reversible basket steps completed unchanged in the same native journey.

## Boundary check

The journey ends at a reversible basket and human-only checkout preview. The verification endpoint is read-only; no purchase endpoint, payment control, order record, or WebMCP purchase tool exists.
