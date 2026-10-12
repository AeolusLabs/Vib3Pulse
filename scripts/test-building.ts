import assert from "node:assert/strict";
import {
  BUILDING_STYLES,
  BUILDING_ACCENTS,
  validateBuildingConfig,
  defaultBuildingStyle,
  resolveBuilding,
} from "../shared/building";
import { buildingSvg } from "../shared/avatar-render/building";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n`, e);
    process.exitCode = 1;
  }
}

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

const good = { v: 1, style: "stage", accent: 3 };

run("validateBuildingConfig accepts a valid config, forces v=1, drops unknown keys", () => {
  const hostile = JSON.parse('{"__proto__":{"x":1},"style":"club","accent":0,"evil":"<script>","v":9}');
  const r = validateBuildingConfig(hostile);
  assert.equal(r.ok, true);
  if (r.ok) { assert.deepEqual(Object.keys(r.value).sort(), ["accent", "style", "v"]); assert.equal(r.value.v, 1); }
  assert.equal(({} as any).x, undefined);
  assert.equal(validateBuildingConfig(good).ok, true);
});

run("validateBuildingConfig names the failing field", () => {
  const field = (patch: Record<string, unknown>) => { const r = validateBuildingConfig({ ...good, ...patch }); return r.ok ? "ok" : r.field; };
  assert.equal(field({ style: "castle" }), "style");
  assert.equal(field({ style: 3 }), "style");
  assert.equal(field({ accent: -1 }), "accent");
  assert.equal(field({ accent: 8 }), "accent");
  assert.equal(field({ accent: 1.5 }), "accent");
  assert.equal(field({ accent: "1" }), "accent");
  for (const bad of ["x", 7, null, undefined, [], true]) assert.deepEqual(validateBuildingConfig(bad), { ok: false, field: "building" });
  assert.deepEqual(validateBuildingConfig({}), { ok: false, field: "style" });
  assert.deepEqual(validateBuildingConfig({ style: "club" }), { ok: false, field: "accent" });
});

run("defaults come from the category so existing venues and events look right", () => {
  assert.equal(defaultBuildingStyle("venue", "Club"), "club");
  assert.equal(defaultBuildingStyle("venue", "Nightclub"), "club");
  assert.equal(defaultBuildingStyle("venue", "Pub"), "bar");
  assert.equal(defaultBuildingStyle("venue", "Lounge"), "bar");
  assert.equal(defaultBuildingStyle("venue", "Bar"), "bar");
  assert.equal(defaultBuildingStyle("venue", "Rooftop"), "rooftop");
  assert.equal(defaultBuildingStyle("venue", "???"), "club");
  assert.equal(defaultBuildingStyle("venue", null), "club");
  assert.equal(defaultBuildingStyle("event", "Music"), "stage");
  assert.equal(defaultBuildingStyle("event", "Sports"), "stadium");
  assert.equal(defaultBuildingStyle("event", "Food & Drink"), "tent");
  assert.equal(defaultBuildingStyle("event", "Tech"), "rooftop");
  assert.equal(defaultBuildingStyle("event", "party"), "tent");
  assert.equal(defaultBuildingStyle("event", undefined), "tent");
  for (const k of ["venue", "event"] as const) for (const c of ["Club", "Music", "x", null]) assert.ok((BUILDING_STYLES as readonly string[]).includes(defaultBuildingStyle(k, c)));
});

run("resolveBuilding uses the stored value when valid, else the category default (never throws)", () => {
  assert.deepEqual(resolveBuilding("venue", "Club", { v: 1, style: "tent", accent: 5 }), { v: 1, style: "tent", accent: 5 });
  for (const junk of [null, undefined, "x", 7, [], { style: "castle", accent: 0 }, { style: "club" }]) {
    assert.deepEqual(resolveBuilding("venue", "Rooftop", junk), { v: 1, style: "rooftop", accent: 0 });
  }
});

run("buildingSvg: every style x accent x glow renders well-formed with one root", () => {
  let n = 0;
  for (const style of BUILDING_STYLES) for (let accent = 0; accent < BUILDING_ACCENTS.length; accent++) for (const glow of [undefined, "verified", "promoted"] as const) {
    const svg = buildingSvg({ v: 1, style, accent }, { glow });
    assert.equal(wellFormed(svg), null, `${style}/${accent}/${glow}`);
    assert.equal((svg.match(/<svg/g) ?? []).length, 1);
    n++;
  }
  assert.equal(n, 6 * 8 * 3);
});

run("buildingSvg: junk renders nothing; output has no free text", () => {
  for (const junk of [null, "x", 7, [], { style: "castle", accent: 0 }]) assert.equal(buildingSvg(junk as any), "");
  assert.ok(!/<script|onload|<img|javascript:/i.test(buildingSvg({ v: 1, style: "club", accent: 0 })));
  const labelled = buildingSvg({ v: 1, style: "stadium", accent: 2 });
  assert.ok(labelled.includes('role="img"') && labelled.includes('aria-label="stadium building"'));
  assert.ok(buildingSvg({ v: 1, style: "stadium", accent: 2 }, { decorative: true }).includes('aria-hidden="true"'));
});

run("buildingSvg: 40 markers on one page never share an element id", () => {
  const all = Array.from({ length: 40 }, (_, i) => buildingSvg({ v: 1, style: BUILDING_STYLES[i % 6], accent: i % 8 }, { glow: i % 3 ? "verified" : undefined })).join("");
  const ids = [...all.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 25, "glowing markers define ids");
  assert.equal(new Set(ids).size, ids.length, "duplicate ids");
  assert.ok(ids.every((id) => id.startsWith("vpav-")));
  for (const m of all.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]), `dangling url(#${m[1]})`);
});

if (!process.exitCode) console.log("building unit: ok");
