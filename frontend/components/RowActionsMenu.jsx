'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

// Overflow "..." menu for table rows. `actions` is an array of
// { label, onClick, danger, hidden }: hidden entries are skipped so callers
// can keep RBAC checks inline without extra conditionals at the call site.
//
// The menu is positioned with `fixed` (computed from the trigger button's
// rect) rather than `absolute` inside the row, because table rows sit inside
// a horizontally-scrollable `.table-wrap` (`overflow-x: auto`) , per the CSS
// overflow spec that forces `overflow-y` to clip too, so an absolutely
// positioned menu near the bottom of the table gets cut off after the first
// item. Fixed positioning escapes that clipping entirely.
export default function RowActionsMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function handleDismiss() {
      setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, []);

  const visibleActions = actions.filter((a) => !a.hidden);
  if (visibleActions.length === 0) return null;

  function toggleOpen(e) {
    e.stopPropagation();
    setOpen((wasOpen) => {
      if (!wasOpen && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
      }
      return !wasOpen;
    });
  }

  return (
    <div className="row-actions" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="ghost icon-btn"
        onClick={toggleOpen}
        aria-label="Row actions"
      >
        <MoreVertical size={16} />
      </button>
      {open && pos && (
        <div
          className="row-actions-menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {visibleActions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={a.danger ? 'danger' : ''}
              onClick={() => { setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
