import assert from "node:assert/strict";
import {
  sanitizeAvatarConfig,
  validateAvatarConfig,
  avatarVersion,
  avatarImageUrl,
  isAvatarImageUrl,
  avatarSaveUpdates,
  photoSetUpdates,
  photoDeleteUpdates,
  defaultAvatar,
  switchAvatarType,
  HAIR_BY_TYPE,
  EXPRESSIONS,
  FACIAL,
  OUTFITS,
  EYEWEAR,
  HEADWEAR,
  type AvatarConfig,
} from "../shared/avatar";
import { avatarSvg, avatarPinSvg, avatarPictureSvg } from "../shared/avatar-render/render";

const KEYS = ["v", "type", "skin", "hair", "hairColor", "expression", "facial", "outfit", "outfitColor", "eyewear", "headwear", "hoops"].sort();

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n`, e);
    process.exitCode = 1;
  }
}

run("non-objects sanitize to null", () => {
  assert.equal(sanitizeAvatarConfig("x"), null);
  assert.equal(sanitizeAvatarConfig(null), null);
  assert.equal(sanitizeAvatarConfig([]), null);
  assert.equal(sanitizeAvatarConfig(7), null);
});

run("female never keeps facial hair", () => {
  const c = sanitizeAvatarConfig({ type: "female", facial: "beard" })!;
  assert.equal(c.facial, "none");
});

run("hair is forced into the type's list", () => {
  assert.equal(sanitizeAvatarConfig({ type: "male", hair: "long" })!.hair, "fade");
  assert.equal(sanitizeAvatarConfig({ type: "female", hair: "long" })!.hair, "long");
  assert.equal(sanitizeAvatarConfig({ type: "female", hair: "mohawk" })!.hair, "long");
});

run("indexes are clamped", () => {
  const c = sanitizeAvatarConfig({ skin: 99, hairColor: -3, outfitColor: 3.7 })!;
  assert.equal(c.skin, 7);
  assert.equal(c.hairColor, 0);
  assert.equal(c.outfitColor, 3);
});

run("unknown keys and prototype tricks are dropped", () => {
  const hostile = JSON.parse('{"type":"male","__proto__":{"x":1},"extra":"y","constructor":"z"}');
  const c = sanitizeAvatarConfig(hostile)!;
  assert.deepEqual(Object.keys(c).sort(), KEYS);
  assert.equal((c as any).extra, undefined);
  assert.equal(({} as any).x, undefined);
});

run("unknown enum ids fall back to defaults", () => {
  const c = sanitizeAvatarConfig({ type: "alien", expression: "evil", outfit: "cape", eyewear: "monocle", headwear: "crown", hoops: "yes" })!;
  assert.equal(c.type, "female");
  assert.equal(c.expression, "smile");
  assert.equal(c.outfit, "hoodie");
  assert.equal(c.eyewear, "none");
  assert.equal(c.headwear, "none");
  assert.equal(c.hoops, true); // female default, "yes" is not a boolean
});

run("sanitize is idempotent over fuzz", () => {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < 50; i++) {
    const t = pick(["female", "male", "neutral", "zzz"]);
    const input = {
      type: t,
      skin: Math.floor(Math.random() * 30) - 10,
      hair: pick([...HAIR_BY_TYPE.female, ...HAIR_BY_TYPE.male, "nope"]),
      hairColor: Math.random() * 12 - 2,
      expression: pick([...EXPRESSIONS, "x"]),
      facial: pick([...FACIAL, "x"]),
      outfit: pick([...OUTFITS, "x"]),
      outfitColor: Math.floor(Math.random() * 12),
      eyewear: pick([...EYEWEAR, "x"]),
      headwear: pick([...HEADWEAR, "x"]),
      hoops: Math.random() > 0.5,
    };
    const once = sanitizeAvatarConfig(input)!;
    assert.deepEqual(sanitizeAvatarConfig(once), once);
    assert.ok(HAIR_BY_TYPE[once.type].includes(once.hair));
    if (once.type === "female") assert.equal(once.facial, "none");
  }
});

run("defaultAvatar is valid for every type", () => {
  for (const t of ["female", "male", "neutral"] as const) {
    const d = defaultAvatar(t);
    assert.deepEqual(sanitizeAvatarConfig(d), d);
  }
});

run("switchAvatarType resets hair, hoops and facial but keeps look", () => {
  const male: AvatarConfig = { ...defaultAvatar("male"), facial: "beard", skin: 5, hairColor: 2, outfit: "bomber", outfitColor: 4, expression: "grin" };
  const f = switchAvatarType(male, "female");
  assert.equal(f.type, "female");
  assert.equal(f.facial, "none");
  assert.ok(HAIR_BY_TYPE.female.includes(f.hair));
  assert.equal(f.hair, "long");
  assert.equal(f.hoops, true);
  assert.equal(f.skin, 5);
  assert.equal(f.hairColor, 2);
  assert.equal(f.outfit, "bomber");
  assert.equal(f.expression, "grin");
  const back = switchAvatarType(f, "male");
  assert.equal(back.hair, "fade");
  assert.equal(back.hoops, false);
});

// ---- renderer smoke: every option renders to one well-formed svg ----------------------------------------
function wellFormed(svg: string): string | null {
  if (!svg.startsWith("<svg")) return "does not start with <svg";
  if (/NaN|undefined|\[object|null/.test(svg.replace(/aria-label="[^"]*"/g, ""))) return "contains NaN/undefined/object/null";
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) { if (stack.pop() !== name) return `unbalanced </${name}>`; } else stack.push(name);
  }
  return stack.length ? `unclosed <${stack.pop()}>` : null;
}
const variants: AvatarConfig[] = [];
for (const type of ["female", "male", "neutral"] as const) {
  const base = defaultAvatar(type);
  for (const hair of HAIR_BY_TYPE[type]) for (const headwear of ["none", "cap", "beanie", "headphones"] as const) variants.push({ ...base, hair, headwear });
  for (const outfit of OUTFITS) variants.push({ ...base, outfit });
  for (const expression of EXPRESSIONS) variants.push({ ...base, expression });
  for (const facial of FACIAL) variants.push({ ...base, facial });
  for (const eyewear of EYEWEAR) variants.push({ ...base, eyewear, hoops: true });
}
run(`renderer: ${variants.length} variants render well-formed, single root`, () => {
  for (const v of variants) {
    for (const mode of ["full", "bust", "head", "face", "outfit", "lower"] as const) {
      const svg = avatarSvg(v, mode);
      const bad = wellFormed(svg);
      assert.equal(bad, null, `${JSON.stringify(v)} ${mode}: ${bad}`);
      assert.equal((svg.match(/<svg/g) ?? []).length, 1, `${v.type}/${v.hair} ${mode}: nested svg`);
    }
    const pin = avatarPinSvg(v);
    assert.equal(wellFormed(pin), null, `pin ${JSON.stringify(v)}`);
  }
});

run("renderer: junk config renders nothing, never throws", () => {
  for (const junk of [null, undefined, "x", 7, [], { type: "alien", hair: 5 }]) {
    assert.doesNotThrow(() => avatarSvg(junk as any));
    assert.doesNotThrow(() => avatarPinSvg(junk as any));
  }
  assert.equal(avatarSvg("x"), "");
  assert.equal(avatarSvg(null), "");
  assert.equal(avatarPinSvg([]), "");
  // a partially valid object is repaired, not dropped
  assert.ok(avatarSvg({ type: "male" }).startsWith("<svg"));
});

run("renderer: 30 pins on one page never share an element id", () => {
  const pins = Array.from({ length: 30 }, (_, i) => avatarPinSvg({ ...defaultAvatar(i % 2 ? "male" : "female"), skin: i % 8 })).join("");
  const ids = [...pins.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 30, "pins define ids");
  assert.equal(new Set(ids).size, ids.length, "duplicate ids");
  for (const m of pins.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]), `dangling url(#${m[1]})`);
});

run("renderer: output has no free-text from config (only enums and numbers)", () => {
  const svg = avatarSvg({ type: "male", hair: "<script>alert(1)</script>", expression: "\"onload=x", skin: "<img>" });
  assert.ok(!/<script|onload|<img/i.test(svg));
});

// ---- strict validation: what the API uses to answer 400 with the failing field ----------------------------
run("validateAvatarConfig accepts a complete valid config and drops unknown keys", () => {
  const good = { ...defaultAvatar("male"), hair: "mohawk", facial: "beard" };
  const hostile = JSON.parse(JSON.stringify({ ...good, evil: "<script>" }).replace("{", '{"__proto__":{"x":1},'));
  const r = validateAvatarConfig(hostile);
  assert.equal(r.ok, true);
  if (r.ok) { assert.deepEqual(Object.keys(r.value).sort(), KEYS); assert.equal(r.value.hair, "mohawk"); }
  assert.equal(({} as any).x, undefined);
});

run("validateAvatarConfig names the failing field", () => {
  const good = defaultAvatar("female");
  const field = (patch: Record<string, unknown>) => { const r = validateAvatarConfig({ ...good, ...patch }); return r.ok ? "ok" : r.field; };
  assert.equal(field({ type: "robot" }), "type");
  assert.equal(field({ hair: "mohawk" }), "hair"); // valid id, but not for female
  assert.equal(field({ skin: 8 }), "skin");
  assert.equal(field({ skin: 1.5 }), "skin");
  assert.equal(field({ hairColor: -1 }), "hairColor");
  assert.equal(field({ outfitColor: "3" }), "outfitColor");
  assert.equal(field({ expression: "evil" }), "expression");
  assert.equal(field({ facial: "beard" }), "facial"); // female
  assert.equal(field({ outfit: "cape" }), "outfit");
  assert.equal(field({ eyewear: "monocle" }), "eyewear");
  assert.equal(field({ headwear: "crown" }), "headwear");
  assert.equal(field({ hoops: "yes" }), "hoops");
  assert.equal(field({}), "ok");
});

run("validateAvatarConfig rejects non-objects and incomplete objects", () => {
  for (const bad of ["x", 7, null, undefined, [], true]) assert.deepEqual(validateAvatarConfig(bad), { ok: false, field: "avatar" });
  assert.equal(validateAvatarConfig({}).ok, false);
  assert.equal(validateAvatarConfig({ type: "male" }).ok, false);
});

run("renderer: picker crops show what they are for", () => {
  const box = (svg: string) => { const m = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)!; return { top: +m[2], bottom: +m[2] + +m[4] }; };
  const cfg = defaultAvatar("male");
  assert.ok(box(avatarSvg(cfg, "head")).top <= -2, "head crop shows the tallest hair (mohawk tip is at y=-2)");
  assert.ok(box(avatarSvg(cfg, "outfit")).bottom >= 250 && box(avatarSvg(cfg, "outfit")).top <= 130, "outfit crop shows the torso");
  assert.ok(box(avatarSvg(cfg, "lower")).bottom >= 172, "lower crop shows the full beard (reaches y=170)");
  assert.ok(box(avatarSvg(cfg, "full")).top <= -2, "full view is not clipped above the mohawk tip");
});

run("renderer: decorative avatars are hidden from assistive tech, others are labelled", () => {
  const plain = avatarSvg(defaultAvatar("female"));
  assert.ok(plain.includes('role="img"') && plain.includes('aria-label="female avatar"'));
  const deco = avatarSvg(defaultAvatar("female"), "head", { decorative: true });
  assert.ok(deco.includes('aria-hidden="true"') && !deco.includes('role="img"') && !deco.includes("aria-label"));
  assert.ok(avatarPinSvg(defaultAvatar("male")).includes('aria-hidden="true"'));
});

run("renderer: element ids carry a vpav- prefix so they cannot clash with page ids", () => {
  const ids = [...avatarSvg(defaultAvatar("male")).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0 && ids.every((id) => id.startsWith("vpav-")), ids.join(","));
});

// ---- avatar as profile picture: avatarUrl swap state machine ---------------------------------------------------
const ME = "user-1";
const PHOTO = "/api/media/abc123";
const cfg = defaultAvatar("male");
const cfg2 = { ...cfg, hair: "mohawk" };
const img = (c: AvatarConfig) => avatarImageUrl(ME, c);

run("avatar image url: stable, versioned by content, recognisable", () => {
  assert.equal(avatarVersion(cfg), avatarVersion({ ...cfg }));
  assert.notEqual(avatarVersion(cfg), avatarVersion(cfg2));
  assert.match(avatarVersion(cfg), /^[0-9a-f]{8}$/);
  assert.equal(img(cfg), `/api/avatar-img/${ME}.svg?v=${avatarVersion(cfg)}`);
  assert.equal(isAvatarImageUrl(img(cfg)), true);
  for (const no of [PHOTO, null, undefined, "", "https://x.test/api/avatar-img/a.svg", "/api/avatar-img"]) assert.equal(isAvatarImageUrl(no as any), false, String(no));
});

run("save with picture on: photo is backed up and avatarUrl points at the avatar image", () => {
  const u = avatarSaveUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }, cfg, true);
  assert.deepEqual(u, { avatar: cfg, avatarUrl: img(cfg), profilePhotoUrl: PHOTO });
});

run("save with picture on and no photo: nothing to back up", () => {
  const u = avatarSaveUpdates({ id: ME, avatarUrl: null, profilePhotoUrl: null }, cfg, true);
  assert.deepEqual(u, { avatar: cfg, avatarUrl: img(cfg), profilePhotoUrl: null });
});

run("re-save while on (usePicture omitted) keeps the mode, bumps the version, keeps the backup", () => {
  const u = avatarSaveUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: PHOTO }, cfg2);
  assert.deepEqual(u, { avatar: cfg2, avatarUrl: img(cfg2), profilePhotoUrl: PHOTO });
  assert.notEqual(img(cfg), img(cfg2));
});

run("picture off while on restores the photo", () => {
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: PHOTO }, cfg, false), { avatar: cfg, avatarUrl: PHOTO, profilePhotoUrl: null });
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: null }, cfg, false), { avatar: cfg, avatarUrl: null, profilePhotoUrl: null });
});

run("picture off (or omitted) while already off changes only the avatar", () => {
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }, cfg, false), { avatar: cfg });
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }, cfg), { avatar: cfg });
});

run("clearing the avatar restores the photo when it was the picture, and is harmless otherwise", () => {
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: PHOTO }, null), { avatar: null, avatarUrl: PHOTO, profilePhotoUrl: null });
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }, null), { avatar: null });
  assert.deepEqual(avatarSaveUpdates({ id: ME, avatarUrl: null, profilePhotoUrl: null }, null, true), { avatar: null });
});

run("uploading a photo turns avatar-as-picture off and reports the file to delete", () => {
  const on = photoSetUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: PHOTO }, "/api/media/new");
  assert.deepEqual(on, { updates: { avatarUrl: "/api/media/new", profilePhotoUrl: null }, replaced: PHOTO });
  const onNoBackup = photoSetUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: null }, "/api/media/new");
  assert.deepEqual(onNoBackup, { updates: { avatarUrl: "/api/media/new", profilePhotoUrl: null }, replaced: null });
  const off = photoSetUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }, "/api/media/new");
  assert.deepEqual(off, { updates: { avatarUrl: "/api/media/new", profilePhotoUrl: null }, replaced: PHOTO });
});

run("deleting the photo while avatar-as-picture is on removes only the backup", () => {
  assert.deepEqual(photoDeleteUpdates({ id: ME, avatarUrl: img(cfg), profilePhotoUrl: PHOTO }), { profilePhotoUrl: null });
  assert.deepEqual(photoDeleteUpdates({ id: ME, avatarUrl: PHOTO, profilePhotoUrl: null }), { avatarUrl: null });
});

run("avatarPictureSvg: square, well formed, labelled, empty for junk", () => {
  const svg = avatarPictureSvg(cfg);
  assert.equal(wellFormed(svg), null);
  const m = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)!;
  assert.equal(+m[3], +m[4], "square viewBox so a round crop never distorts");
  assert.ok(svg.includes("<rect"), "has a background so transparent edges do not show");
  assert.equal(avatarPictureSvg("junk"), "");
  assert.equal(avatarPictureSvg(null), "");
});

if (!process.exitCode) console.log("avatar unit: ok");
