'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { compressImage } from '../lib/imageCompress.js';

export const MAX_PHOTOS = 5;

// Optional photo attachment for a reading. The parent owns the File[] and
// uploads it after the reading itself is saved (see uploadEventPhotos in
// lib/api.js), so a failed upload never loses the reading.
export default function PhotoPicker({ files, onChange, max = MAX_PHOTOS, disabled = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

  async function handleSelect(e) {
    const picked = Array.from(e.target.files || []).slice(0, max - files.length);
    e.target.value = '';
    if (picked.length === 0) return;

    setError('');
    setBusy(true);
    try {
      const compressed = await Promise.all(picked.map(compressImage));
      onChange([...files, ...compressed]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label>Photos (optional)</label>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {previews.map((url, i) => (
          <div key={url} style={{ position: 'relative' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`Attached photo ${i + 1}`} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
            <button
              type="button"
              className="ghost icon-btn"
              aria-label={`Remove photo ${i + 1}`}
              disabled={disabled}
              onClick={() => onChange(files.filter((_, idx) => idx !== i))}
              style={{ position: 'absolute', top: -8, right: -8 }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {files.length < max && (
          <button type="button" className="secondary" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
            <Camera size={14} /> {busy ? 'Processing...' : 'Add photo'}
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={handleSelect} />
      {error && <span className="error-text">{error}</span>}
      <span className="field-hint">Up to {max} photos. Compressed on your device before upload.</span>
    </div>
  );
}
