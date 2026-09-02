import assert from "node:assert/strict";
import test from "node:test";

import { downloadAndSanitizeExpenseEvidenceImage, sanitizeExpenseEvidenceImage } from "../src/expenseEvidenceImage.js";

test("sanitizes JPEG metadata before analysis", () => {
  const image = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x06, 0x45, 0x58, 0x49, 0x46,
    0xff, 0xda, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x12, 0x34, 0xff, 0xd9
  ]);

  const result = sanitizeExpenseEvidenceImage({ bytes: image, declaredMimeType: "image/jpeg", maxBytes: 1024 });

  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.bytes.includes(Buffer.from("EXIF")), false);
  assert.deepEqual(result.bytes.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.deepEqual(result.bytes.subarray(-2), Buffer.from([0xff, 0xd9]));
});

test("sanitizes only known PNG ancillary metadata chunks", () => {
  const image = png([
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk("tEXt", Buffer.from("merchant=private")),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0))
  ]);

  const result = sanitizeExpenseEvidenceImage({ bytes: image, declaredMimeType: "image/png", maxBytes: 1024 });

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes.includes(Buffer.from("merchant=private")), false);
  assert.ok(result.bytes.includes(Buffer.from("IHDR")));
  assert.ok(result.bytes.includes(Buffer.from("IDAT")));
});

test("rejects declared MIME or malformed containers instead of repairing them", () => {
  assert.throws(
    () => sanitizeExpenseEvidenceImage({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), declaredMimeType: "image/png", maxBytes: 1024 }),
    error => error?.code === "unsupported_image"
  );

  const badCrc = png([
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.from([0, 0, 0, 0])])
  ]);
  assert.throws(
    () => sanitizeExpenseEvidenceImage({ bytes: badCrc, declaredMimeType: "image/png", maxBytes: 1024 }),
    error => error?.code === "malformed_image"
  );
});

test("rejects evidence larger than the configured request boundary", () => {
  assert.throws(
    () => sanitizeExpenseEvidenceImage({ bytes: Buffer.alloc(11), declaredMimeType: "image/jpeg", maxBytes: 10 }),
    error => error?.code === "image_too_large"
  );
});

test("bounds Telegram image downloads before sanitizing their bytes", async () => {
  const calls = [];
  await assert.rejects(
    () => downloadAndSanitizeExpenseEvidenceImage({
      telegramBotToken: "telegram-token",
      fileId: "file-id",
      declaredMimeType: "image/jpeg",
      maxBytes: 10,
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes("/getFile")) {
          return { ok: true, async json() { return { ok: true, result: { file_path: "images/private.jpg" } }; } };
        }
        return {
          ok: true,
          headers: { get() { return null; } },
          body: {
            getReader() {
              return {
                async read() { return { done: false, value: new Uint8Array(11) }; },
                async cancel() {},
                releaseLock() {}
              };
            }
          }
        };
      }
    }),
    error => error?.code === "image_too_large"
  );
  assert.equal(calls.length, 2);
});

function png(chunks) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
