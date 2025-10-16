// Generate PNG icons from public/favicon.ico
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(process.cwd());
const srcIco = resolve(root, "public/favicon.ico");
const outApple = resolve(root, "public/apple-touch-icon.png");
const out192 = resolve(root, "public/icon-192.png");
const out512 = resolve(root, "public/icon-512.png");

async function ensureDir(p) {
  await mkdir(dirname(p), { recursive: true });
}

async function main() {
  const ico = await readFile(srcIco);
  await ensureDir(outApple);
  // Minimal ICO parser: pick largest PNG-encoded image inside .ico
  const dv = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const reserved = dv.getUint16(0, true);
  const type = dv.getUint16(2, true);
  const count = dv.getUint16(4, true);
  if (reserved !== 0 || type !== 1 || count === 0) {
    throw new Error("Invalid ICO header");
  }
  let best = null;
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    const wByte = dv.getUint8(base + 0);
    const hByte = dv.getUint8(base + 1);
    const width = wByte === 0 ? 256 : wByte;
    const height = hByte === 0 ? 256 : hByte;
    const size = dv.getUint32(base + 8, true);
    const offset = dv.getUint32(base + 12, true);
    const sig0 = ico[offset + 0];
    const sig1 = ico[offset + 1];
    const sig2 = ico[offset + 2];
    const sig3 = ico[offset + 3];
    const sig4 = ico[offset + 4];
    const sig5 = ico[offset + 5];
    const sig6 = ico[offset + 6];
    const sig7 = ico[offset + 7];
    const isPng =
      sig0 === 0x89 &&
      sig1 === 0x50 &&
      sig2 === 0x4e &&
      sig3 === 0x47 &&
      sig4 === 0x0d &&
      sig5 === 0x0a &&
      sig6 === 0x1a &&
      sig7 === 0x0a;
    if (!isPng) continue;
    if (!best || width * height > best.width * best.height) {
      best = { width, height, buffer: ico.subarray(offset, offset + size) };
    }
  }
  if (!best) {
    throw new Error(
      "ICO does not contain PNG images. Please replace favicon.ico with a PNG-based ICO."
    );
  }
  const basePng = Buffer.from(best.buffer);

  // Apple touch icon 180x180
  await sharp(basePng, { limitInputPixels: false })
    .resize(180, 180, { fit: "cover" })
    .png()
    .toFile(outApple);

  // Android/Web Manifest icons
  await sharp(basePng, { limitInputPixels: false })
    .resize(192, 192, { fit: "cover" })
    .png()
    .toFile(out192);
  await sharp(basePng, { limitInputPixels: false })
    .resize(512, 512, { fit: "cover" })
    .png()
    .toFile(out512);

  // Write simple log file
  await writeFile(
    resolve(root, "public/.icons-generated"),
    new Date().toISOString()
  );
  console.log("Icons generated:", outApple, out192, out512);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
