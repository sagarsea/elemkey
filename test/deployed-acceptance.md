# Deployed acceptance record

Automated local Playwright evidence and real WebMCP evidence are separate. This record is backed by the public Render build and native Chrome Canary.

## Deployment

- URL: https://elemkey.onrender.com
- Repository: https://github.com/sagarsea/elemkey
- Host: Render Web Service, Docker, Frankfurt; 512 MB instance with a 1 GB persistent disk mounted at `/data`
- Source: commit `49a817e`
- Browser and version: Google Chrome Canary 154.0.8031.0 with WebMCP testing features enabled
- Checked at (UTC): 2026-08-31T01:56:50Z
- `BASE_URL=https://elemkey.onrender.com npm run smoke`: PASS
- Dynamic response cache headers: PASS — `Cache-Control: private, no-store`; no `s-maxage`
- GitHub Actions CI #2: PASS

## 90-second golden path

- [x] Signed-out `get_member_offer` returns `sign_in_required`.
- [x] Human manually signs in with the fictional credentials through the ordinary form; no WebMCP tool receives credentials.
- [x] Product navigation registers the nine page-scoped tools, including all three legacy tools and `verify_purchase_terms`.
- [x] Signed-in `get_member_offer` returns £474.05.
- [x] `verify_purchase_terms` returns `verified` with `purchase_created: false`.
- [x] Public addition and `prepare_basket` create one visible, reversible line without duplicate SKUs.
- [x] Cookie continuity survives navigation to `/basket`.
- [x] Human continuation stops at `/checkout-preview`; no payment or order capability exists and the page has zero action buttons.

The ten-run reliability check used ten clean native browser contexts. The separate manual handoff and signed-in completion were witnessed at 2026-08-31T01:56:50Z.

## Ten fresh sessions

| Run | UTC time | Search | Sign-in handoff | Offer | Basket preview | Non-payment stop | Result |
|---:|---|---|---|---|---|---|---|
| 1 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 2 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 3 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 4 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 5 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 6 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 7 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 8 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 9 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
| 10 | 2026-08-31 01:52Z | pass | ordinary form | £474.05 | one line | pass | pass |
