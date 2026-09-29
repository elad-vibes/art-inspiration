// Re-encodes a photo in the browser before it is uploaded (ART-PLAN §4):
// drawing it onto a canvas drops EXIF — including the GPS location — and the
// long side is capped at MAX_SIDE. WebP when the browser can encode it,
// otherwise JPEG (Safari's canvas may not encode WebP).
import { fitSize, MAX_BYTES, MAX_SIDE } from "../domain/images.ts";

export interface Encoded { blob: Blob; width: number; height: number; ext: "webp" | "jpg"; type: "image/webp" | "image/jpeg" }

async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  if ("createImageBitmap" in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch { /* fall back to <img> (e.g. formats only the <img> decoder knows) */ }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw Object.assign(new Error("לא הצלחנו לפתוח את התמונה הזאת. אפשר לנסות תמונה אחרת."), { code: "decode" });
  }
  return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

const toBlob = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((res) => c.toBlob(res, type, q));

export async function encodePhoto(file: Blob): Promise<Encoded> {
  const d = await decode(file);
  try {
    for (const [side, q] of [[MAX_SIDE, 0.85], [1600, 0.8], [1280, 0.75]] as const) {
      const { w, h } = fitSize(d.w, d.h, side);
      if (!w || !h) break;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(d.src, 0, 0, w, h);
      let blob = await toBlob(c, "image/webp", q);
      let webp = blob?.type === "image/webp";
      if (!webp) {
        blob = await toBlob(c, "image/jpeg", q);
        webp = false;
      }
      c.width = c.height = 0; // free the canvas memory on iOS
      if (blob && blob.size <= MAX_BYTES) {
        return { blob, width: w, height: h, ext: webp ? "webp" : "jpg", type: webp ? "image/webp" : "image/jpeg" };
      }
    }
  } finally {
    d.done();
  }
  throw Object.assign(new Error("התמונה גדולה מדי. אפשר לנסות תמונה אחרת."), { code: "too_big" });
}
