// Rooms gaming: per-player LiveKit sources (no database, no network):   npx tsx scripts/test-rooms-unit-game-voice.ts
import assert from "node:assert/strict";
import { FakeVoice } from "../server/rooms/voice/fakeVoice";
import { LiveKitVoice } from "../server/rooms/voice/livekitVoice";

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

await test("FakeVoice: setPublishSources grants exactly the screen sources, listed by listParticipants", async () => {
  const f = new FakeVoice();
  await f.setPublishSources("r", "u", ["screen_share", "screen_share_audio"]);
  const [p] = await f.listParticipants("r");
  assert.equal(p.identity, "u");
  assert.deepEqual(p.sources, ["screen_share", "screen_share_audio"]);
  assert.equal(p.canPublish, true);
  assert.equal(p.canCamera, false);
  assert.deepEqual(f.calls, [{ op: "setPublishSources", roomId: "r", userId: "u", canPublish: true, sources: ["screen_share", "screen_share_audio"] }]);
});
await test("FakeVoice: [] leaves canPublish false", async () => {
  const f = new FakeVoice();
  f.participants.push({ identity: "u", canPublish: true });
  await f.setPublishSources("r", "u", []);
  const [p] = await f.listParticipants("r");
  assert.equal(p.canPublish, false);
  assert.deepEqual(p.sources, []);
});
await test("FakeVoice: legacy setCanPublish is unchanged (no sources recorded, participants untouched)", async () => {
  const f = new FakeVoice();
  f.participants.push({ identity: "u", canPublish: false });
  await f.setCanPublish("r", "u", true);
  await f.setCanPublish("r", "v", true, true);
  assert.deepEqual(f.calls, [{ op: "setCanPublish", roomId: "r", userId: "u", canPublish: true }, { op: "setCanPublish", roomId: "r", userId: "v", canPublish: true, camera: true }]);
  const list = await f.listParticipants("r");
  assert.deepEqual(list, [{ identity: "u", canPublish: false, canCamera: false, hasCamera: false }], "no sources / publishing keys on legacy entries");
});
await test("FakeVoice: a mint without sources records no sources key", async () => {
  const f = new FakeVoice();
  await f.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true });
  assert.equal("sources" in f.calls[0], false);
});

const lk = new LiveKitVoice("wss://lk.example.test", "APIkeyForTests", "a-secret-that-is-long-enough-for-hs256-signing-000");
await test("LiveKitVoice: a player's token grants the two screen sources and no microphone", async () => {
  const claims = b64json((await lk.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: false, sources: ["screen_share", "screen_share_audio"] })).split(".")[1]);
  assert.equal(claims.video.canPublish, true);
  assert.deepEqual(claims.video.canPublishSources, ["screen_share", "screen_share_audio"]);
});
await test("LiveKitVoice: sources [] means no publishing (never the empty = any-source list)", async () => {
  const claims = b64json((await lk.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true, sources: [] })).split(".")[1]);
  assert.equal(claims.video.canPublish, false);
  assert.ok(Array.isArray(claims.video.canPublishSources) && claims.video.canPublishSources.length > 0, JSON.stringify(claims.video));
});
await test("LiveKitVoice: legacy tokens are unchanged (microphone only; camera only for the holder)", async () => {
  const mic = b64json((await lk.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true })).split(".")[1]);
  assert.deepEqual(mic.video.canPublishSources, ["microphone"]);
  const cam = b64json((await lk.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true, camera: true })).split(".")[1]);
  assert.deepEqual(cam.video.canPublishSources, ["microphone", "camera"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
