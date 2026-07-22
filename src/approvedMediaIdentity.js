'use strict';

const fs = require('fs');
const path = require('path');

const APPROVED_MEDIA_KEYS = Object.freeze(['sha256', 'byteSize', 'mimeType', 'fileName', 'container']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MP4_MIME_TYPE = 'video/mp4';
const MP4_CONTAINER = 'mp4';
const RECOGNIZED_MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42',
  'avc1', 'dash', 'M4V ', 'MSNV'
]);

function sanitizeApprovedMediaIdentity(value, { maxByteSize = Number.MAX_SAFE_INTEGER } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== APPROVED_MEDIA_KEYS.length || keys.some((key, index) => key !== [...APPROVED_MEDIA_KEYS].sort()[index])) {
    return null;
  }
  const sha256 = String(value.sha256 || '');
  const byteSize = Number(value.byteSize);
  const mimeType = String(value.mimeType || '');
  const fileName = String(value.fileName || '');
  const container = String(value.container || '');
  if (
    !SHA256_PATTERN.test(sha256)
    || !Number.isSafeInteger(byteSize)
    || byteSize <= 0
    || byteSize > maxByteSize
    || mimeType !== MP4_MIME_TYPE
    || container !== MP4_CONTAINER
    || !fileName
    || fileName.length > 255
    || path.basename(fileName) !== fileName
    || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(fileName)
    || !/\.mp4$/i.test(fileName)
  ) return null;
  return { sha256, byteSize, mimeType: MP4_MIME_TYPE, fileName, container: MP4_CONTAINER };
}

function inspectMp4Buffer(buffer, totalByteSize = buffer && buffer.length) {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(totalByteSize) || totalByteSize < 24 || buffer.length < 16) {
    return { valid: false, code: 'MP4_TRUNCATED' };
  }
  const boxSize = buffer.readUInt32BE(0);
  const boxType = buffer.toString('ascii', 4, 8);
  if (boxType !== 'ftyp') return { valid: false, code: 'MP4_FTYP_REQUIRED' };
  if (boxSize < 16 || boxSize > totalByteSize || boxSize > buffer.length) {
    return { valid: false, code: 'MP4_FTYP_TRUNCATED' };
  }
  const brands = [];
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (offset === 12) continue; // minor_version is not a brand.
    brands.push(buffer.toString('ascii', offset, offset + 4));
  }
  if (!brands.some((brand) => RECOGNIZED_MP4_BRANDS.has(brand))) {
    return { valid: false, code: 'MP4_BRAND_UNRECOGNIZED' };
  }
  if (totalByteSize <= boxSize || buffer.length < Math.min(totalByteSize, boxSize + 8)) {
    return { valid: false, code: 'MP4_MEDIA_BOX_REQUIRED' };
  }
  const nextBoxSize = buffer.readUInt32BE(boxSize);
  const nextBoxType = buffer.toString('ascii', boxSize + 4, boxSize + 8);
  if (nextBoxSize < 8 || boxSize + nextBoxSize > totalByteSize || !/^[\x20-\x7e]{4}$/.test(nextBoxType)) {
    return { valid: false, code: 'MP4_BOX_TRUNCATED' };
  }
  return { valid: true, mimeType: MP4_MIME_TYPE, container: MP4_CONTAINER, brands };
}

async function inspectMp4File(filePath) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile() || stats.size <= 0) return { valid: false, code: 'MP4_EMPTY' };
  const length = Math.min(stats.size, 1024 * 1024);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return inspectMp4Buffer(buffer.subarray(0, bytesRead), stats.size);
  } finally {
    await handle.close();
  }
}

function approvedMediaMatches(identity, observed) {
  return Boolean(identity && observed
    && identity.sha256 === observed.sha256
    && identity.byteSize === observed.byteSize
    && identity.mimeType === observed.mimeType
    && identity.container === observed.container);
}

module.exports = {
  APPROVED_MEDIA_KEYS,
  MP4_CONTAINER,
  MP4_MIME_TYPE,
  RECOGNIZED_MP4_BRANDS,
  approvedMediaMatches,
  inspectMp4Buffer,
  inspectMp4File,
  sanitizeApprovedMediaIdentity
};
