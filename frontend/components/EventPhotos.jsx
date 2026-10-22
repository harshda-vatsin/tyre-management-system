'use client';

import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import { api, fetchPhotoObjectUrl } from '../lib/api.js';
import Modal from './Modal.jsx';

// Collapsed "Photos (n)" toggle for one event; photos are only fetched once
// it is opened so a long timeline doesn't fire a request per event.
export default function EventPhotos({ eventId, count, canDelete = false }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const urls = [];
    (async () => {
      try {
        const list = await api.get(`/event-photos?event_id=${eventId}`);
        const withUrls = await Promise.all(list.map(async (p) => {
          const url = await fetchPhotoObjectUrl(p.id);
          urls.push(url);
          return { ...p, url };
        }));
        if (!cancelled) setPhotos(withUrls);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [open, eventId]);

  async function handleDelete(photo) {
    try {
      await api.del(`/event-photos/${photo.id}`);
      setPhotos((list) => list.filter((p) => p.id !== photo.id));
      setViewing(null);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ marginTop: '0.25rem' }}>
      <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>
        <ImageIcon size={14} /> Photos ({count})
      </button>
      {open && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
          {photos.map((p) => (
            <button key={p.id} type="button" className="ghost" onClick={() => setViewing(p)} aria-label="View photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="Tyre reading" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6 }} />
            </button>
          ))}
          {error && <span className="error-text">{error}</span>}
        </div>
      )}
      {viewing && (
        <Modal title="Tyre photo" onClose={() => setViewing(null)} width={720}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing.url} alt="Tyre reading" style={{ width: '100%', borderRadius: 6 }} />
          {canDelete && (
            <div className="form-actions">
              <button type="button" className="secondary" onClick={() => handleDelete(viewing)}>
                <Trash2 size={14} /> Delete photo
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
