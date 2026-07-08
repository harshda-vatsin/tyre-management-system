'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Warehouse, Bus, CircleDot, ScanLine, ClipboardList,
  ListChecks, AlertTriangle, CalendarCheck, FileBarChart, Users as UsersIcon,
  SlidersHorizontal, History, Menu, X, LogOut, Truck, Settings,
} from 'lucide-react';
import { useAuth } from './AuthContext.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { ROLES } from '../lib/roles.js';

const EVENT_LOGGING_ROLES = [ROLES.ADMIN, ROLES.DEPOT_MANAGER, ROLES.TYRE_SUPERVISOR];

const NAV_GROUPS = [
  {
    label: 'Dashboard',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Depots',
    items: [
      { to: '/depots', label: 'Depots', icon: Warehouse },
    ],
  },
  {
    label: 'Bus',
    items: [
      { to: '/buses', label: 'Buses', icon: Bus },
      { to: '/bus-models', label: 'Bus Models', icon: Truck },
    ],
  },
  {
    label: 'Tyres',
    items: [
      { to: '/scan', label: 'Scan Tyre QR', icon: ScanLine },
      { to: '/log-event', label: 'Log Event', icon: ClipboardList, roles: EVENT_LOGGING_ROLES },
      { to: '/tyres', label: 'Tyres', icon: CircleDot },
      { to: '/batch-inspection', label: 'Batch Inspection', icon: ListChecks, roles: EVENT_LOGGING_ROLES },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { to: '/alerts', label: 'Alerts', icon: AlertTriangle },
      { to: '/inspection-compliance', label: 'Inspection Compliance', icon: CalendarCheck },
      { to: '/reports', label: 'Reports', icon: FileBarChart },
      { to: '/audit-log', label: 'Audit Log', icon: History, roles: [ROLES.ADMIN, ROLES.NATIONAL_FLEET_MANAGER, ROLES.AUDITOR] },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users', icon: UsersIcon, roles: [ROLES.ADMIN] },
      { to: '/admin/thresholds', label: 'Thresholds', icon: SlidersHorizontal },
      { to: '/admin/settings', label: 'System Parameters', icon: Settings, roles: [ROLES.ADMIN] },
    ],
  },
];

function isActive(pathname, to) {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const visibleGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.roles || item.roles.includes(user?.role)) }))
    .filter((group) => group.items.length > 0);

  const sidebarContent = (
    <>
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark"><Truck size={17} /></div>
        <div className="sidebar-brand-text">
          <strong>EBTMS</strong>
        </div>
        <button type="button" className="ghost icon-btn" style={{ marginLeft: 'auto', color: 'var(--sidebar-ink-strong)', display: mobileOpen ? 'inline-flex' : 'none' }} onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>
      <nav className="sidebar-nav">
        {visibleGroups.map((group, gi) => (
          <div className="sidebar-group" key={group.label || `g${gi}`}>
            {group.label && <div className="sidebar-group-label">{group.label}</div>}
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.to} href={item.to} className={isActive(pathname, item.to) ? 'active' : ''}>
                  <Icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        {userMenuOpen && (
          <div className="sidebar-user-menu">
            <button type="button" onClick={logout}>
              <LogOut size={15} /> Log out
            </button>
          </div>
        )}
        <button type="button" className="sidebar-user" onClick={() => setUserMenuOpen((o) => !o)}>
          <span className="sidebar-user-avatar">{initials(user?.full_name || user?.username)}</span>
          <span className="sidebar-user-meta">
            <strong>{user?.full_name || user?.username}</strong>
            <span>{user?.role}</span>
          </span>
        </button>
        <ThemeToggle />
      </div>
    </>
  );

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button type="button" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <Menu size={20} />
        </button>
        <strong>EBTMS</strong>
      </div>

      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <aside className={`sidebar${mobileOpen ? ' open' : ''}`}>
        {sidebarContent}
      </aside>

      <div className="main-content">
        {children}
      </div>
    </div>
  );
}
