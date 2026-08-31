import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Docker packages the compiled Node 24 service without project state", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.equal((dockerfile.match(/^FROM node:24-bookworm-slim/gm) ?? []).length, 2);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*fetch\('http:\/\/127\.0\.0\.1:3000\/healthz'\)/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/src\/server\.js"\]$/m);
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM node:24-bookworm-slim"));
  assert.doesNotMatch(runtimeStage, /COPY (test|screenshots)|playwright/i);

  const compose = readFileSync("compose.yaml", "utf8");
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /NODE_ENV: development/);
  for (const name of ["SESSION_COOKIE_SECRET", "OFFER_TOKEN_SECRET", "MEMBER_BINDING_SECRET"]) {
    assert.match(compose, new RegExp(name + ": \\$\\{" + name + ":\\?"));
  }
  assert.match(compose, /OFFER_STORE_PATH: \/data\/offers\.json/);
  assert.match(compose, /\.\/data:\/data/);

  const ignored = readFileSync(".dockerignore", "utf8");
  for (const path of ["node_modules", "dist", "test-results", ".gstack", ".env*", "*.png"]) assert.ok(ignored.split(/\r?\n/).includes(path));
});
