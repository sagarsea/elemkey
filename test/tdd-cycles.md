# Store expansion TDD record

Date: 2026-08-30

| Slice | RED evidence | GREEN evidence |
|---|---|---|
| 16-product domain and search filters | TypeScript failed because `products` and multi-result contracts did not exist. | 11 focused domain/security tests passed. |
| Offers, retail routes, public basket | `/` and new APIs returned 404; public basket returned 403. | 20 domain/HTTP compatibility tests passed. |
| Human basket and page-scoped WebMCP | Three focused Playwright tests failed on the old storefront and three-tool scope. | 3/3 expansion browser tests passed. |
| Local assets and accessibility | Asset test failed on the first missing product image. | Asset, alt-text, landmark, label, focus and responsive CSS checks passed. |
| Store polish | Visual acceptance found four same-category features and a missing favicon. | One feature per category, local favicon, no broken images, no console errors and no horizontal overflow. |
| Private dynamic responses and account offers | Cache/account HTTP checks failed on missing `private, no-store` and zero signed-in rows. | Focused HTTP checks passed with four rule-derived rows and unchanged static caching. |
| Independent offer rows and basket recovery | Seven account browser journeys failed before row actions and account tools existed. | 7/7 passed for calculations, isolation, stale/expiry/session recovery, title-preserving basket upgrades, tool parity and responsive layouts. |
| Merchant-verified purchase terms | Focused HTTP returned 404 and focused Playwright found no `verify_purchase_terms` registration. | Focused HTTP 1/1 and affected browser 8/8 passed; full `npm test` passed 31 unit/HTTP and 17 runnable browser checks. |

The final `npm test`, Docker and native Canary results are recorded in `local-docker-acceptance.md`.
