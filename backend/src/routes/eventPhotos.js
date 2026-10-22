/**
 * @file eventPhotos.js
 * @description Optional photos attached to a tyre event (typically an NSD or
 * pressure reading). Uploaded separately from the event itself so a failed
 * photo upload never loses the reading. Files are served only through an
 * authenticated route, never as public static files.
 */

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, isDepotScoped } = require('../utils/roles');
const { asyncHandler } = require('../utils/asyncHandler');
const { MAX_PHOTOS_PER_EVENT, MAX_PHOTO_BYTES, detectImageType, pathFor, savePhoto, deletePhotoFile } = require('../utils/eventPhotoStorage');

const router = express.Router();

const WRITE_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_EVENT },
}).array('photos', MAX_PHOTOS_PER_EVENT);

function parseUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Each photo must be ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)}MB or smaller`
        : `At most ${MAX_PHOTOS_PER_EVENT} photos can be uploaded at once`;
      return res.status(400).json({ error: message });
    }
    return next(err);
  });
}

router.use(authenticate);

// Loads the event and enforces depot scoping; returns null after responding if access is denied.
async function loadEventForUser(req, res, eventId) {
  const event = await db.prepare('SELECT id, tyre_id, depot_id FROM tyre_events WHERE id = ?').get(eventId);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  if (isDepotScoped(req.user) && event.depot_id !== req.user.depot_id) {
    res.status(403).json({ error: 'Not authorized for this depot' });
    return null;
  }
  return event;
}

router.get('/', asyncHandler(async (req, res) => {
  const { tyre_id, event_id } = req.query;
  if (!tyre_id && !event_id) return res.status(400).json({ error: 'tyre_id or event_id is required' });

  const clauses = [];
  const params = {};
  if (tyre_id) { clauses.push('p.tyre_id = @tyre_id'); params.tyre_id = Number(tyre_id); }
  if (event_id) { clauses.push('p.event_id = @event_id'); params.event_id = Number(event_id); }
  if (isDepotScoped(req.user)) { clauses.push('e.depot_id = @depot_id'); params.depot_id = req.user.depot_id; }

  const rows = await db
    .prepare(`
      SELECT p.id, p.event_id, p.tyre_id, p.mime_type, p.size_bytes, p.created_at
      FROM event_photos p JOIN tyre_events e ON e.id = p.event_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.id
    `)
    .all(params);
  res.json(rows);
}));

router.post('/events/:eventId', authorize(...WRITE_ROLES), parseUpload, asyncHandler(async (req, res) => {
  const event = await loadEventForUser(req, res, req.params.eventId);
  if (!event) return;

  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'No photos were uploaded' });

  const existing = (await db.prepare('SELECT COUNT(*) c FROM event_photos WHERE event_id = ?').get(event.id)).c;
  if (existing + files.length > MAX_PHOTOS_PER_EVENT) {
    return res.status(400).json({ error: `An event can have at most ${MAX_PHOTOS_PER_EVENT} photos (${existing} already attached)` });
  }

  const typed = files.map((file) => ({ file, type: detectImageType(file.buffer) }));
  if (typed.some((t) => !t.type)) {
    return res.status(400).json({ error: 'Only JPEG, PNG or WebP images are allowed' });
  }

  const created = [];
  for (const { file, type } of typed) {
    const fileName = await savePhoto(file.buffer, type.ext);
    try {
      const info = await db
        .prepare('INSERT INTO event_photos (event_id, tyre_id, file_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.id, event.tyre_id, fileName, type.mime, file.size, req.user.id);
      created.push({ id: info.lastInsertRowid, event_id: event.id, tyre_id: event.tyre_id, mime_type: type.mime, size_bytes: file.size });
    } catch (err) {
      await deletePhotoFile(fileName);
      throw err;
    }
  }
  res.status(201).json(created);
}));

router.get('/:id/file', asyncHandler(async (req, res) => {
  const photo = await db
    .prepare('SELECT p.file_name, p.mime_type, e.depot_id FROM event_photos p JOIN tyre_events e ON e.id = p.event_id WHERE p.id = ?')
    .get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  if (isDepotScoped(req.user) && photo.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }
  res.set('Content-Type', photo.mime_type);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(pathFor(photo.file_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Photo file is missing' });
  });
}));

router.delete('/:id', authorize(...WRITE_ROLES), asyncHandler(async (req, res) => {
  const photo = await db
    .prepare('SELECT p.id, p.file_name, e.depot_id FROM event_photos p JOIN tyre_events e ON e.id = p.event_id WHERE p.id = ?')
    .get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  if (isDepotScoped(req.user) && photo.depot_id !== req.user.depot_id) {
    return res.status(403).json({ error: 'Not authorized for this depot' });
  }
  await db.prepare('DELETE FROM event_photos WHERE id = ?').run(photo.id);
  await deletePhotoFile(photo.file_name);
  res.status(204).end();
}));

module.exports = router;
