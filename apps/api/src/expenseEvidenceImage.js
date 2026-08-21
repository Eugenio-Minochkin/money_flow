const JPEG_MIME_TYPE = "image/jpeg";
const PNG_MIME_TYPE = "image/png";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]);
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

export class ExpenseEvidenceImageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function sanitizeExpenseEvidenceImage({ bytes, declaredMimeType, maxBytes }) {
  const input = Buffer.from(bytes ?? []);
  if (input.length > maxBytes) throw new ExpenseEvidenceImageError("image_too_large");

  const actualMimeType = detectImageMimeType(input);
  if (!actualMimeType || normalizeMimeType(declaredMimeType) !== actualMimeType) {
    throw new ExpenseEvidenceImageError("unsupported_image");
  }

  const sanitized = actualMimeType === JPEG_MIME_TYPE ? sanitizeJpeg(input) : sanitizePng(input);
  return { bytes: sanitized, mimeType: actualMimeType, sizeBucket: imageSizeBucket(sanitized.length) };
}

export async function downloadAndSanitizeExpenseEvidenceImage({
  telegramBotToken,
  fileId,
  declaredMimeType,
  maxBytes,
  fetchImpl = globalThis.fetch
}) {
  if (!telegramBotToken || !fileId || !fetchImpl) throw new ExpenseEvidenceImageError("image_download_failed");
  try {
    const metadataResponse = await fetchImpl(
      `https://api.telegram.org/bot${telegramBotToken}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const metadata = await metadataResponse.json();
    if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
      throw new ExpenseEvidenceImageError("image_download_failed");
    }
    if (Number(metadata.result.file_size) > maxBytes) throw new ExpenseEvidenceImageError("image_too_large");

    const response = await fetchImpl(`https://api.telegram.org/file/bot${telegramBotToken}/${metadata.result.file_path}`);
    if (!response.ok) throw new ExpenseEvidenceImageError("image_download_failed");
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new ExpenseEvidenceImageError("image_too_large");
    const bytes = await readBoundedBody(response, maxBytes);
    return sanitizeExpenseEvidenceImage({ bytes, declaredMimeType, maxBytes });
  } catch (error) {
    if (error instanceof ExpenseEvidenceImageError) throw error;
    throw new ExpenseEvidenceImageError("image_download_failed");
  }
}

function detectImageMimeType(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return JPEG_MIME_TYPE;
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return PNG_MIME_TYPE;
  return null;
}

function normalizeMimeType(value) {
  const mimeType = String(value ?? "").toLowerCase();
  if (mimeType === "image/jpg") return JPEG_MIME_TYPE;
  return mimeType;
}

function sanitizeJpeg(bytes) {
  if (bytes.length < 6 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new ExpenseEvidenceImageError("malformed_image");
  const output = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new ExpenseEvidenceImageError("malformed_image");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === undefined || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new ExpenseEvidenceImageError("malformed_image");
    }
    if (offset + 2 > bytes.length) throw new ExpenseEvidenceImageError("malformed_image");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new ExpenseEvidenceImageError("malformed_image");
    const segmentStart = offset - 2;
    const segmentEnd = offset + segmentLength;
    if (marker === 0xda) {
      output.push(bytes.subarray(segmentStart));
      return Buffer.concat(output);
    }
    if (!JPEG_METADATA_MARKERS.has(marker)) output.push(bytes.subarray(segmentStart, segmentEnd));
    offset = segmentEnd;
  }
  throw new ExpenseEvidenceImageError("malformed_image");
}

function sanitizePng(bytes) {
  if (bytes.length < PNG_SIGNATURE.length + 12) throw new ExpenseEvidenceImageError("malformed_image");
  const output = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let seenIdat = false;
  let seenIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length || seenIend) throw new ExpenseEvidenceImageError("malformed_image");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!/^[A-Za-z]{4}$/.test(type) || dataEnd < dataStart || chunkEnd > bytes.length) throw new ExpenseEvidenceImageError("malformed_image");
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) throw new ExpenseEvidenceImageError("malformed_image");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) throw new ExpenseEvidenceImageError("malformed_image");
    if (chunkIndex > 0 && type === "IHDR") throw new ExpenseEvidenceImageError("malformed_image");
    if (type === "PLTE" && seenIdat) throw new ExpenseEvidenceImageError("malformed_image");
    if (type === "IDAT") seenIdat = true;
    if (type === "IEND") {
      if (!seenIdat || length !== 0 || chunkEnd !== bytes.length) throw new ExpenseEvidenceImageError("malformed_image");
      seenIend = true;
    }
    if (isCriticalPngChunk(type) && !PNG_KNOWN_CRITICAL_CHUNKS.has(type)) throw new ExpenseEvidenceImageError("malformed_image");
    if (!PNG_METADATA_CHUNKS.has(type)) output.push(bytes.subarray(offset, chunkEnd));
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!seenIend) throw new ExpenseEvidenceImageError("malformed_image");
  return Buffer.concat(output);
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new ExpenseEvidenceImageError("image_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ExpenseEvidenceImageError("image_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function isCriticalPngChunk(type) {
  return type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function imageSizeBucket(size) {
  if (size <= 1_048_576) return "<=1mb";
  if (size <= 5_242_880) return "<=5mb";
  return "<=10mb";
}
