// No-DB unit test: the service worker must never keep reviewer data or ID photos. Loads client/public/sw.js in a sandbox. Run: npx tsx scripts/test-age-review-unit-sw.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void | Promise<void>) => {
  const ok = () => { passed++; console.log(`PASS ${name}`); };
  const bad = (e: any) => { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); };
  try { const r = fn(); if (r) pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
};
const pending: Promise<void>[] = [];
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = readFileSync(join(root, "client/public/sw.js"), "utf8");

function load() {
  const handlers: Record<string, (e: any) => void> = {};
  const stored: { cache: string; url: string }[] = [];
  const deleted: string[] = [];
  let existing = ["vibepulse-v3", "vibepulse-api-v3", "vibepulse-api-v4", "vibepulse-v2"];
  class FakeHeaders { m = new Map<string, string>(); constructor(i?: any) { if (i) for (const [k, v] of (i instanceof FakeHeaders ? i.m : Object.entries(i))) this.m.set(String(k).toLowerCase(), String(v)); } get(k: string) { return this.m.get(k.toLowerCase()) ?? null; } set(k: string, v: string) { this.m.set(k.toLowerCase(), v); } }
  class FakeResponse { headers: FakeHeaders; status: number; statusText = ""; constructor(public body: any, init: any = {}) { this.headers = new FakeHeaders(init.headers); this.status = init.status ?? 200; } async arrayBuffer() { return new ArrayBuffer(0); } }
  const sandbox: any = {
    self: { addEventListener: (t: string, h: any) => { handlers[t] = h; }, skipWaiting() {}, clients: { claim() {} } },
    caches: {
      open: async (name: string) => ({ put: async (req: any) => { stored.push({ cache: name, url: req.url }); }, match: async () => undefined, addAll: async () => {}, delete: async () => true }),
      keys: async () => existing,
      delete: async (k: string) => { deleted.push(k); return true; },
    },
    Response: FakeResponse, Headers: FakeHeaders, URL, fetch: async () => new FakeResponse("x"), setTimeout, clearTimeout, AbortController, Promise, Date, parseInt, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, handlers, stored, deleted };
}

const fetchEvent = (url: string) => {
  let responded = false;
  return { e: { request: { url, method: "GET", mode: "cors" }, respondWith: () => { responded = true; } }, responded: () => responded };
};

test("bypass list contains both reviewer prefixes", () => {
  const { sandbox } = load();
  const list: string[] = vm.runInContext("NEVER_CACHE_PREFIXES", sandbox);
  assert.ok(list.includes("/api/admin") && list.includes("/api/age-review"));
  assert.ok(list.includes("/api/map/") && list.includes("/api/auth"));
});

test("the service worker does not intercept admin, age review or map requests", () => {
  const { handlers } = load();
  for (const path of ["/api/admin/age-reviews", "/api/admin/age-reviews/abc/evidence/def?token=t", "/api/age-review/me", "/api/map/friends"]) {
    const ev = fetchEvent(`https://app.test${path}`);
    handlers.fetch(ev.e);
    assert.equal(ev.responded(), false, path);
  }
  const normal = fetchEvent("https://app.test/api/events");
  handlers.fetch(normal.e);
  assert.equal(normal.responded(), true);
});

test("no-store and private responses, and token URLs, are not stored", async () => {
  const { sandbox, stored } = load();
  const R = sandbox.Response;
  const put = (url: string, headers: Record<string, string>) => vm.runInContext("putInApiCache", sandbox)({ url }, new R("body", { headers }));
  await put("https://app.test/api/x", { "Cache-Control": "no-store" });
  await put("https://app.test/api/x", { "Cache-Control": "private, max-age=60" });
  await put("https://app.test/api/x?token=abc", {});
  assert.equal(stored.length, 0);
  await put("https://app.test/api/events", { "Cache-Control": "public, max-age=60" });
  assert.equal(stored.length, 1);
});

test("the API cache name is bumped and activate deletes older caches", async () => {
  const { sandbox, handlers, deleted } = load();
  assert.equal(vm.runInContext("API_CACHE", sandbox), "vibepulse-api-v4");
  let waited: Promise<unknown> = Promise.resolve();
  handlers.activate({ waitUntil: (p: Promise<unknown>) => { waited = p; } });
  await waited;
  assert.ok(deleted.includes("vibepulse-api-v3"));
  assert.ok(deleted.includes("vibepulse-v2"));
  assert.ok(!deleted.includes("vibepulse-api-v4") && !deleted.includes("vibepulse-v3"));
});

test("the detail and queue queries are not kept in the client cache", () => {
  const drawer = readFileSync(join(root, "client/src/components/admin/age-review/DetailDrawer.tsx"), "utf8");
  assert.match(drawer, /queryKey: \["age-review-detail", id\][^\n]*gcTime: 0/);
  assert.match(readFileSync(join(root, "client/src/pages/admin/AdminAgeReviews.tsx"), "utf8"), /gcTime: 0/);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
