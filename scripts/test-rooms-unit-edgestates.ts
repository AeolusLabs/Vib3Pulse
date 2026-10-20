// Edge states (task 6.7, flows board 11), no database:   npx tsx scripts/test-rooms-unit-edgestates.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEDIA_ISSUE_COPY, classifyMediaFailure, mediaIssueFromLine, mediaIssueLine } from "../client/src/lib/mediaIssues";
import { EDGE_SCENES, parseEdgeFixture } from "../client/src/lib/roomFixtures";
import { SPRAY_SCENES, fixtureSprayStart, parseSprayFixture } from "../client/src/lib/sprayFixtures";
import { SPRAY_FAIL_COPY } from "../client/src/lib/sprayUi";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("classifyMediaFailure: browser errors map to denied / missing / busy", () => {
  assert.equal(classifyMediaFailure({ name: "NotAllowedError", message: "Permission denied" }), "denied");
  assert.equal(classifyMediaFailure({ name: "NotFoundError", message: "Requested device not found" }), "missing");
  assert.equal(classifyMediaFailure({ name: "NotReadableError", message: "Could not start video source" }), "busy");
  assert.equal(classifyMediaFailure(null), "busy");
  assert.equal(classifyMediaFailure("weird"), "busy");
});

test("every line maps back to the issue it came from, and nothing else does", () => {
  for (const device of ["mic", "camera"] as const) {
    for (const reason of ["denied", "busy", "missing"] as const) {
      const line = MEDIA_ISSUE_COPY[device][reason].line;
      const got = mediaIssueFromLine(device === "mic" ? line : null, device === "camera" ? line : null);
      assert.deepEqual(got, { device, reason });
    }
  }
  assert.equal(mediaIssueFromLine("Audio disconnected. Tap to reconnect.", "Your camera or microphone was disconnected, so the stream stopped."), null);
  assert.equal(mediaIssueFromLine(null, null), null);
  assert.equal(mediaIssueLine("mic", { name: "NotAllowedError" }), MEDIA_ISSUE_COPY.mic.denied.line);
});

test("copy: plain words, no em dashes, always a next step", () => {
  for (const d of Object.values(MEDIA_ISSUE_COPY)) for (const c of Object.values(d)) {
    for (const t of [c.line, c.title, c.body, c.primary]) assert.ok(t.length > 0 && !t.includes("—"));
    assert.match(c.body, /Try again/);
  }
});

test("fixture scenes parse; unknown values fall back to null", () => {
  for (const e of EDGE_SCENES) assert.equal(parseEdgeFixture(`?edge=${e}`), e);
  assert.equal(parseEdgeFixture("?edge=nope"), null);
  assert.equal(parseEdgeFixture(""), null);
  for (const s of ["unavailable", "offline"] as const) {
    assert.ok((SPRAY_SCENES as readonly string[]).includes(s));
    assert.equal(parseSprayFixture(`?spray=${s}`), s);
  }
});

test("spray unavailable / offline scenes open the failed sheet with the generic copy (no reason given)", () => {
  const u = fixtureSprayStart("unavailable", 0, "http://x");
  const o = fixtureSprayStart("offline", 0, "http://x");
  assert.ok(u.flow.kind === "failed" && u.flow.reason === "UNAVAILABLE");
  assert.ok(o.flow.kind === "failed" && o.flow.reason === "NOT_SENT");
  assert.equal(SPRAY_FAIL_COPY.UNAVAILABLE.body, "Spraying is not available here.");
  assert.ok(!/adult|verified|18|age|region|country/i.test(SPRAY_FAIL_COPY.UNAVAILABLE.title + SPRAY_FAIL_COPY.UNAVAILABLE.body));
});

test("wiring: shell shows the sheet; hook uses the shared lines; fixtures stay DEV-only", () => {
  assert.ok(src("../client/src/components/rooms/shell/RoomShell.tsx").includes("MediaIssueSheet"));
  assert.ok(src("../client/src/hooks/useRoomVoice.ts").includes("mediaIssueLine"));
  assert.ok(src("../client/src/App.tsx").includes("import.meta.env.DEV ? lazy(() => import(\"@/pages/dev/RoomFixture\"))"));
  assert.ok(!src("../client/src/components/rooms/shell/RoomShell.tsx").includes("parseEdgeFixture"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
