import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const secret = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const externalBaseURL = process.env.E2E_BASE_URL;
const nativeWebMCP = process.env.NATIVE_WEBMCP === "1";
const executablePath = existsSync("/usr/bin/google-chrome-canary") ? "/usr/bin/google-chrome-canary" : undefined;
const localOfferStore = resolve("data/playwright-offers.json");

export default defineConfig({
  testDir: "test",
  testMatch: "*.e2e.spec.ts",
  timeout: 20_000,
  use: {
    baseURL: externalBaseURL ?? "http://127.0.0.1:4187",
    trace: "retain-on-failure",
    headless: nativeWebMCP ? false : undefined,
    launchOptions: {
      executablePath,
      args: nativeWebMCP ? ["--enable-experimental-web-platform-features", "--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport"] : []
    }
  },
  webServer: externalBaseURL ? undefined : {
    command: "npm run build && node dist/src/server.js",
    url: "http://127.0.0.1:4187/healthz",
    env: {
      PORT: "4187",
      SESSION_COOKIE_SECRET: secret(11),
      OFFER_TOKEN_SECRET: secret(12),
      MEMBER_BINDING_SECRET: secret(13),
      OFFER_STORE_PATH: localOfferStore
    },
    reuseExistingServer: false
  }
});
