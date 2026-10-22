/**
 * @file eventPhotoStorage.js
 * @description Local-disk storage for photos attached to tyre events. Files are
 * named by a server-generated random id, never the client's filename, and the
 * image type is decided from the file's magic bytes rather than the
 * client-supplied MIME type.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PHOTO_DIR = process.env.EVENT_PHOTO_DIR || path.join(__dirname, '..', '..', 'uploads', 'event-photos');

const MAX_PHOTOS_PER_EVENT = 5;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

function pathFor(fileName) {
  // basename guards against a path ever being stored in file_name.
  return path.join(PHOTO_DIR, path.basename(fileName));
}

async function savePhoto(buffer, ext) {
  await fs.mkdir(PHOTO_DIR, { recursive: true });
  const fileName = `${crypto.randomUUID()}${ext}`;
  await fs.writeFile(pathFor(fileName), buffer);
  return fileName;
}

async function deletePhotoFile(fileName) {
  await fs.unlink(pathFor(fileName)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

module.exports = { PHOTO_DIR, MAX_PHOTOS_PER_EVENT, MAX_PHOTO_BYTES, detectImageType, pathFor, savePhoto, deletePhotoFile };
