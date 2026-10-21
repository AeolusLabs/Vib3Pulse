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

test("the Money tab uses the right chart for each measure and every chart has a table twin", () => {
  const src = read(PAGE);
  // trend over time = line; part of a whole = one stacked bar; ranking = horizontal bars; daily counts = columns; headline numbers = stat tiles
  for (const id of ["chart-gross-line", "chart-split-bar", "chart-tier-bars", "chart-rooms-bars", "chart-hosts-bars", "chart-rooms-started-cols", "chart-peak-cols", "kpi-gross", "kpi-count", "kpi-average", "kpi-payers", "kpi-reversed", "kpi-rooms-started", "kpi-hosts", "kpi-peak", "kpi-tickets"])
    assert.ok(src.includes(`"${id}"`), `${id} missing`);
  assert.ok(src.includes('data-testid={`view-${v}`}') && src.includes('data-testid="money-tables"'), "the Charts and Tables switch is missing");
  assert.ok(!/dual|secondaryAxis|yAxisRight/i.test(src), "no dual-axis charts");
});

test("the chart palette is the validated dark set and chart text never wears a series colour", () => {
  const tokens = read("client/src/components/admin/charts/tokens.ts");
  assert.match(tokens, /"#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"/);
  for (const f of ["DayCharts.tsx", "BarCharts.tsx"]) assert.ok(!/<text[^>]*fill={color}/.test(read(`client/src/components/admin/charts/${f}`)), `${f} colours text with the series colour`);
});

// ---------------------------------------------------------------- rooms rates plan, task 7
const TAB = "client/src/pages/admin/RoomRatesTab.tsx";

test("the Rates tab is registered and shows the saved rates, the edit flow, the preview and the history", () => {
  const page = read(PAGE);
  assert.ok(page.includes('id: "rates" as const'), "tab rates missing");
  assert.ok(page.includes('import RoomRatesTab from "./RoomRatesTab"') && page.includes("<RoomRatesTab"), "RoomRatesTab not wired");
  assert.ok(existsSync(TAB), "RoomRatesTab.tsx is missing");
  const tab = read(TAB);
  assert.ok(tab.includes("Applies to new sprays and tickets from now. Existing records keep their original split."), "the settled-records notice is missing");
  assert.ok(tab.includes('"/api/admin/rooms/rates"') || tab.includes("/api/admin/rooms/rates"), "the tab must use the rates endpoint");
  for (const id of ["rates-form", "rates-history"]) assert.ok(tab.includes(`"${id}"`), `${id} missing`);
  assert.ok(tab.includes("data-testid={`rate-row-${"), "per-rate rows need test ids");
  assert.ok(/validateRate/.test(tab) && /sprayBreakdown|ticketBreakdown/.test(tab), "the edit dialog validates with the shared rule and previews the effect with the shared breakdown");
  assert.ok(/VAT/.test(tab) && /card fees/i.test(tab), "the tab says VAT and card fees are fixed");
  assert.ok(tab.includes("isSuper"), "edit controls must depend on the super-admin role");
});

test("the Rates tab follows the copy rules (no em dashes, no emoji, no side-stripe borders)", () => {
  const tab = read(TAB);
  assert.ok(!tab.includes("\u2014"), "em dash found");
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(tab), "emoji found");
  assert.ok(!/border-l-[2-9]|border-r-[2-9]/.test(tab), "side-stripe border found");
});

test("the Money tab shows Room earnings and Ticket sales, each with the right chart form", () => {
  const src = read(PAGE);
  assert.ok(src.includes("/api/admin/rooms/tickets"), "the Money tab must read the ticket sales endpoint");
  for (const id of [
    "kpi-room-sales", "kpi-room-host", "kpi-room-platform", "kpi-room-other", "chart-sales-by-source", "chart-platform-by-source",
    "kpi-ticket-gross", "kpi-ticket-count", "kpi-ticket-average", "kpi-ticket-buyers", "kpi-ticket-refunded",
    "chart-ticket-line", "chart-ticket-split-bar", "chart-ticket-rooms-bars", "chart-ticket-hosts-bars",
  ]) assert.ok(src.includes(`"${id}"`), `${id} missing`);
  assert.ok(src.includes("Total room sales") && src.includes("Platform share") && src.includes("Host share"), "the three headline numbers are missing");
  assert.ok(!/dual|secondaryAxis|yAxisRight/i.test(src), "no dual-axis charts");
});

test("the Rates and Ticket sales copy never invents a percentage in the page (rates come from the server)", () => {
  const tab = read(TAB);
  assert.ok(!/we take 15|Platform 15%/.test(tab) && !/\b(30|25|20|15)%/.test(tab.replace(/\/\/.*$/gm, "")), "a hard-coded rate appears in the tab");
});
