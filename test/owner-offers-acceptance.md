# Owner-managed offers acceptance — 2026-08-30

Target: `http://127.0.0.1:3000` from the Docker Compose service.

## Local regression

- `npm test`
- Result: 30 Node unit/HTTP tests passed; 16 Playwright tests passed; three explicitly gated acceptance/native tests skipped.
- Coverage includes store seeding/reload/corruption/atomic failure, immutable revisions, schedule boundaries, all/tier/member audiences, deterministic winner selection, owner cookie and privilege isolation, CSRF, preview expiry/binding, version conflicts, lifecycle changes, targeted member visibility, stale quote recovery, owner UI failure recovery, page tool scopes, and all legacy shopper journeys.

## Mocked WebMCP wiring

- `E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e`
- Result against Docker: 16 passed; the two native tests skipped by design.
- Owner sign-in registered zero mocked tools. Signed-in `/admin/offers` registered exactly `list_member_offers`, `preview_member_offer`, `create_member_offer`, `revise_member_offer`, and `set_member_offer_status`, each with a lifecycle abort signal.
- Human controls and mocked tool handlers updated the same normalized preview and visible offer list. Safe traces contained only tool name, status, duration, and UI region.

## Native Chrome Canary WebMCP

- `xvfb-run -a env NATIVE_WEBMCP=1 E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test test/native-webmcp.e2e.spec.ts --workers=1`
- Shopper journey: passed real discovery and execution of the unchanged product/member/basket tools, including AX7 `£474.05` and VN9 `£265.05` arithmetic.
- Owner journey: passed real discovery of only the five owner tools, then listed, previewed, and created `Native Canary persistence proof` through `document.modelContext`.
- Native owner screenshot: [native-owner-webmcp.png](native-owner-webmcp.png).

## Docker recreation and visible sessions

- Docker was rebuilt and force-recreated after the final source change; health and deployed smoke passed.
- Before and after recreation, `data/offers.json` had SHA-256 `7dfc29e1d2583ba6ba9b3f3c78a6cf22b0d14054ac5e4cb35fd7929b0c2e8ad9`.
- Reloaded snapshot: schema version 1, store version 3, three immutable revisions, including the native Canary offer.
- `MANUAL_ACCEPTANCE=1 E2E_BASE_URL=http://127.0.0.1:3000 npx playwright test test/docker-manual-acceptance.e2e.spec.ts --workers=1`
- Result: passed with separate owner, standard-member, and VIP-member browser contexts and no console errors.
- Owner saw the recreated offers: [docker-owner-acceptance.png](docker-owner-acceptance.png).
- Standard member saw the four seeded eligible products and no Tide D3 offer: [docker-standard-member-acceptance.png](docker-standard-member-acceptance.png).
- VIP member saw and checked the targeted Tide D3 offer at `£219.12`: [docker-vip-member-acceptance.png](docker-vip-member-acceptance.png).

Mocked Playwright evidence and native Chrome Canary WebMCP evidence are intentionally recorded in separate sections because mocked registration proves application wiring only.
