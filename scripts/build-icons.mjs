#!/usr/bin/env node
// Rebuilds every icon file from assets/icon/icon.svg:  npm run icons
//
// Needs rsvg-convert on the PATH (macOS: brew install librsvg; Debian: librsvg2-bin).
//
// To rebrand: replace assets/icon/icon.svg, keeping a background shape with
// id="tile" and the artwork in a group with id="art", then run this again.
// assets/icon/icon-<size>.svg, when present, is used for that size inside
// favicon.ico (small sizes usually need their own whole-pixel drawing).
//
// The script reads back the pixel size of every file it wrote and fails if
// one is not the size it should be.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "assets/icon");
const ICO_SIZES = [16, 32, 48];
// A maskable icon may be cropped to a circle 80% of its width. At this scale
// the corners of square artwork that fills 69% of the tile stay inside it.
const MASKABLE_ART_SCALE = 0.75;

const fail = (msg) => { console.error(`build-icons: ${msg}`); process.exit(1); };

try { execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" }); }
catch { fail("rsvg-convert not found. Install librsvg (macOS: brew install librsvg)."); }

const master = readFileSync(join(SRC, "icon.svg"), "utf8");
const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(master);
if (!box || box[1] !== box[2]) fail('icon.svg needs a square viewBox="0 0 N N".');
const side = Number(box[1]);

const tileTag = /<[a-z]+\b[^>]*\bid="tile"[^>]*>/.exec(master)?.[0];
const artTag = /<g\b[^>]*\bid="art"[^>]*>/.exec(master)?.[0];
if (!tileTag) fail('icon.svg has no element with id="tile".');
if (!artTag) fail('icon.svg has no <g id="art">.');
if (/\btransform=/.test(artTag)) fail('<g id="art"> must not carry its own transform.');

// Square corners: iOS and Android cut their own corner shape.
const square = master.replace(tileTag, tileTag.replace(/\s+r[xy]="[^"]*"/g, ""));
const shift = (side * (1 - MASKABLE_ART_SCALE)) / 2;
const maskable = square.replace(artTag, artTag.replace(/>$/, ` transform="translate(${shift} ${shift}) scale(${MASKABLE_ART_SCALE})">`));

const tmp = mkdtempSync(join(tmpdir(), "fleet-icons-"));
const render = (svgText, size, outPath) => {
  const svgPath = join(tmp, `in-${size}-${Math.random().toString(36).slice(2)}.svg`);
  writeFileSync(svgPath, svgText);
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outPath, svgPath]);
};
const pngSize = (buf) => {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") fail("not a PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

const written = [];
const png = (svgText, size, rel) => {
  const out = join(ROOT, rel);
  render(svgText, size, out);
  written.push({ rel, want: size, got: pngSize(readFileSync(out)) });
};

writeFileSync(join(ROOT, "app/icon.svg"), master);
png(square, 180, "app/apple-icon.png");
png(master, 192, "public/icon-192.png");
png(master, 512, "public/icon-512.png");
png(maskable, 512, "public/icon-512-maskable.png");

// favicon.ico: one PNG per size, packed by hand (the format is a 6-byte
// header, a 16-byte entry per image, then the images).
const frames = ICO_SIZES.map((size) => {
  const own = join(SRC, `icon-${size}.svg`);
  const out = join(tmp, `ico-${size}.png`);
  render(existsSync(own) ? readFileSync(own, "utf8") : master, size, out);
  return { size, data: readFileSync(out) };
});
const head = Buffer.alloc(6 + 16 * frames.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
let offset = head.length;
frames.forEach((f, i) => {
  const at = 6 + 16 * i;
  head.writeUInt8(f.size, at); head.writeUInt8(f.size, at + 1);
  head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
  head.writeUInt32LE(f.data.length, at + 8); head.writeUInt32LE(offset, at + 12);
  offset += f.data.length;
});
writeFileSync(join(ROOT, "app/favicon.ico"), Buffer.concat([head, ...frames.map((f) => f.data)]));

// Read the .ico back from disk the way a browser would: follow each entry to its image.
const ico = readFileSync(join(ROOT, "app/favicon.ico"));
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const at = 6 + 16 * i, len = ico.readUInt32LE(at + 8), off = ico.readUInt32LE(at + 12);
  written.push({ rel: `app/favicon.ico [${i}]`, want: ICO_SIZES[i], got: pngSize(ico.subarray(off, off + len)) });
}
rmSync(tmp, { recursive: true, force: true });

let bad = 0;
for (const w of written) {
  const ok = w.got[0] === w.want && w.got[1] === w.want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${w.rel}  ${w.got[0]}x${w.got[1]}${ok ? "" : `  (wanted ${w.want}x${w.want})`}`);
}
console.log(`app/icon.svg written. ${written.length} images measured, ${bad} wrong.`);
process.exit(bad ? 1 : 0);
