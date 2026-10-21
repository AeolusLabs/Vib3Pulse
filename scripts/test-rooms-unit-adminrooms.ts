// Rooms admin page wiring (rooms admin plan, task 6): route, nav entry, and that the page only talks to the endpoints the plan defines.
// No database.   npm run test:rooms
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) => readFileSync(p, "utf8");
const PAGE = "client/src/pages/admin/AdminRooms.tsx";

test("the page file exists and is registered as /admin/rooms", () => {
  assert.ok(existsSync(PAGE), "AdminRooms.tsx is missing");
  const app = read("client/src/App.tsx");
  assert.match(app, /import AdminRooms from "@\/pages\/admin\/AdminRooms"/);
  assert.match(app, /<Route path="\/admin\/rooms" component=\{AdminRooms\} \/>/);
});

test("the nav has a Rooms item for the three roles that can use some part of it", () => {
  const layout = read("client/src/pages/admin/AdminLayout.tsx");
  const m = layout.match(/label: "Rooms",\s*path: "\/admin\/rooms",[\s\S]*?roles: \[([^\]]*)\]/);
  assert.ok(m, "no Rooms nav item");
  for (const role of ["super_admin", "content_moderator", "finance_manager"]) assert.ok(m![1].includes(`"${role}"`), `${role} missing from the nav roles`);
  assert.ok(!m![1].includes('"user_support"'), "user_support must not see Rooms");
});

test("the page only calls the endpoints the plan defines", () => {
  const src = read(PAGE);
  const allowed = [
    "/api/admin/rooms/live", "/api/admin/rooms/reported", "/api/admin/rooms/overview", "/api/admin/rooms/sprays", "/api/admin/rooms/controls",
    "/api/admin/rooms/hosts", "/api/admin/rooms", "/api/admin/finance/room-tickets", "/api/admin/me",
  ];
  const found = [...src.matchAll(/["'`](\/api\/admin\/[A-Za-z0-9/_${}.:-]*)/g)].map((x) => x[1]);
  assert.ok(found.length >= 7, `expected the page to use the admin endpoints, found ${found.length}`);
  for (const f of found) assert.ok(allowed.some((a) => f === a || f.startsWith(a + "/") || f.startsWith(a + "?")), `unexpected endpoint ${f}`);
});

test("the page carries the settled-money warning and the four tabs (live, reported, money, controls)", () => {
  const src = read(PAGE);
  assert.match(src, /A pause stops new money only\. Money already settled to a bank cannot be recalled here\./);
  assert.ok(src.includes("data-testid={`tab-${t.id}`}"), "tab test ids missing");
  for (const id of ["live", "reported", "money", "controls"]) assert.ok(src.includes(`id: "${id}" as const`), `tab ${id} missing`);
});

test("copy rules: no em dashes and no emoji icons in the page", () => {
  const src = read(PAGE);
  assert.ok(!src.includes("—"), "em dash found");
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(src), "emoji found");
});
