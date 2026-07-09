'use client';

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { api } from '../lib/api.js';

export default function NotificationBell() {
  const router = useRouter();
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  async function fetchAlerts() {
    try {
      // Fetch open alerts with a limit of 5 for the notification listing
      const res = await api.get('/alerts?status=Open&pageSize=5');
      setAlerts(res.data || []);
      setTotal(res.total || 0);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    }
  }

  useEffect(() => {
    fetchAlerts();
    // Poll for new alerts every 20 seconds
    const interval = setInterval(fetchAlerts, 20000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function formatTime(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr.includes(' ') && !dateStr.includes('T') ? dateStr.replace(' ', 'T') + 'Z' : dateStr);
      if (isNaN(d.getTime())) return dateStr;
      
      const now = new Date();
      const diffMs = now - d;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHrs = Math.floor(diffMins / 60);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHrs < 24) return `${diffHrs}h ago`;
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }

  function handleAlertClick(id) {
    setIsOpen(false);
    router.push(`/alerts/${id}`);
  }

  return (
    <div className="notification-bell-wrap" ref={dropdownRef}>
      <button
        type="button"
        className="notification-bell-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="View notifications"
      >
        <Bell size={18} />
        {total > 0 && (
          <span className="notification-badge">
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <h4>Notifications</h4>
            {total > 0 && <span className="badge badge-info">{total} Active</span>}
          </div>
          
          <div className="notification-list">
            {alerts.length === 0 ? (
              <div className="notification-empty">
                All systems normal. No active alerts.
              </div>
            ) : (
              alerts.map((a) => (
                <div
                  key={a.id}
                  className={`notification-item ${a.severity === 'Critical' ? 'critical' : 'warning'}`}
                  onClick={() => handleAlertClick(a.id)}
                >
                  <div className="notification-item-title">
                    {a.severity.toUpperCase()}: {a.parameter_type} Breach
                  </div>
                  <div className="notification-item-desc">
                    Tyre {a.tyre_number} on Bus {a.bus_registration_no || 'Unmounted'} ({a.depot_name || '-'})
                  </div>
                  <div className="notification-item-time">
                    {formatTime(a.created_at)}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="notification-footer">
            <Link href="/alerts" onClick={() => setIsOpen(false)}>
              View All Alerts
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
