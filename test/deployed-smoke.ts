import assert from "node:assert/strict";

async function main() {
  const origin = process.env.BASE_URL?.replace(/\/$/, "");
  if (!origin) throw new Error("Set BASE_URL to the deployed HTTPS origin");

  const dynamicPaths = ["/healthz", "/", "/shop", "/products/AX7-BLK", "/products/FS8-WAL", "/account", "/policies/delivery", "/signin", "/basket", "/checkout-preview", "/offer-rule", "/api/products/search?query=AX7-BLK", "/api/products/product-fs8-wal", "/api/store/policies?topic=returns"];
  for (const path of dynamicPaths) {
    const response: Response = await fetch(origin + path);
    assert.equal(response.ok, true, `${path} returned ${response.status}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store", `${path} cache policy`);
  }
  assert.notEqual((await fetch(`${origin}/styles.css`)).headers.get("cache-control"), "private, no-store", "static assets keep their own policy");
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: "ok" });
  assert.equal((await (await fetch(`${origin}/api/products/search?query=AX7-BLK`)).json()).status, "ok");
  assert.equal((await (await fetch(`${origin}/api/products/search?sort=relevance`)).json()).data.products.length, 16);
  assert.equal((await fetch(`${origin}/api/purchase`)).status, 404);
  console.log(`ElemKey deployed smoke passed: ${origin}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Deployed smoke failed");
  process.exitCode = 1;
});
