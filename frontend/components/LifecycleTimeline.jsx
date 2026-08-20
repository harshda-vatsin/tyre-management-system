'use client';

import React from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { EVENT_TYPE_LABELS, describeEvent } from '../lib/tyreLifecycle.js';
import { formatDateTime } from '../lib/dates.js';
import { AMENDABLE_FIELDS } from '../lib/amendableFields.js';
import AmendmentTimeline from './AmendmentTimeline.jsx';
import EmptyState from './EmptyState.jsx';

// Tyre Passport timeline: a vertical, chronologically-ordered view of every
// tyre_events row for one tyre (Date, Time, Event, User, Bus, Position,
// Remarks), replacing the previous flat table. Reuses AmendmentTimeline for
// the expanded correction detail rather than duplicating that rendering.
export default function LifecycleTimeline({
  events, pressureUnit, formatPressure, amendmentsMap, expandedIds, onToggleExpand,
  canAmend, onAmend, busMap,
}) {
  if (events.length === 0) {
    return <EmptyState title="No events recorded yet" />;
  }

  return (
    <div className="lifecycle-timeline">
      {events.map((e, idx) => {
        const amendments = amendmentsMap[e.id] || [];
        const isCorrected = amendments.length > 0;
        const isExpanded = expandedIds.has(e.id);
        const isLast = idx === events.length - 1;
        return (
          <div className="lifecycle-timeline-item" key={e.id}>
            <div className="lifecycle-timeline-rail">
              <span className="lifecycle-timeline-dot" />
              {!isLast && <span className="lifecycle-timeline-line" />}
            </div>
            <div className="lifecycle-timeline-content">
              <div className="lifecycle-timeline-header">
                <span className="badge">{EVENT_TYPE_LABELS[e.event_type] || e.event_type}</span>
                {Boolean(e.system_backfilled) && <span className="badge badge-info">System Backfilled</span>}
                {isCorrected && (
                  <span className="badge badge-warning"><AlertTriangle size={11} /> Corrected</span>
                )}
                <span className="lifecycle-timeline-date">{formatDateTime(e.event_date)}</span>
              </div>
              <div className="lifecycle-timeline-desc">{describeEvent(e, pressureUnit, formatPressure)}</div>
              <div className="lifecycle-timeline-meta">
                {e.performed_by_name ? `By ${e.performed_by_name}` : 'By system'}
                {e.bus_registration_no && (
                  <> &middot; <strong>Bus:</strong> {e.bus_registration_no}{e.position ? ` / ${e.position}` : ''}</>
                )}
              </div>
              <div className="lifecycle-timeline-actions">
                {isCorrected && (
                  <button type="button" className="ghost" onClick={() => onToggleExpand(e.id)}>
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {isExpanded ? 'Collapse' : 'Expand'}
                  </button>
                )}
                {canAmend && AMENDABLE_FIELDS[e.event_type] && (
                  <button type="button" className="secondary" onClick={() => onAmend(e)}>
                    <Pencil size={13} /> Amend Event
                  </button>
                )}
              </div>
              {isExpanded && (
                <div className="lifecycle-timeline-amendments">
                  <AmendmentTimeline event={e} amendments={amendments} pressureUnit={pressureUnit} busMap={busMap} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
