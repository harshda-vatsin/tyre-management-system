const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { REPORTS } = require('../utils/reportService');
const { buildXlsx, buildPdf } = require('../utils/exportService');
const { isDepotScoped } = require('../utils/roles');

const router = express.Router();

// SRS §6: every role can access reports ("view all tyre cards and reports
// for own depot" / "view all dashboards and reports" / "Read-only access to
// all records, reports..."). What's role-aware is the DATA scope, not which
// report types exist -- so no role is blocked from the report list itself.
router.use(authenticate);

// Applies RBAC depot scoping per report shape. Depot-scoped roles cannot see
// another depot's data regardless of what filters the client sends.
function scopeFilters(key, filters, user) {
  if (!isDepotScoped(user)) return { filters, error: null };

  if (key === 'inter-bus-transfer') {
    return { filters: { ...filters, from_depot_id: undefined, to_depot_id: undefined, scopeDepotId: user.depot_id }, error: null };
  }
  if (key === 'tyre-history') {
    if (filters.tyre_number) {
      const tyre = db.prepare('SELECT current_depot_id FROM tyres WHERE tyre_number = ?').get(filters.tyre_number);
      if (tyre && tyre.current_depot_id !== user.depot_id) return { filters, error: 'Not authorized for this tyre' };
    }
    return { filters, error: null };
  }
  if (key === 'bus-tyre-health') {
    if (filters.bus_id) {
      const bus = db.prepare('SELECT depot_id FROM buses WHERE id = ?').get(filters.bus_id);
      if (bus && bus.depot_id !== Number(user.depot_id)) return { filters, error: 'Not authorized for this bus' };
      return { filters, error: null };
    }
    return { filters: { ...filters, depot_id: user.depot_id }, error: null };
  }
  // All other reports take a plain depot_id filter -- force it.
  return { filters: { ...filters, depot_id: user.depot_id }, error: null };
}

// Export headers show human-readable filter values (depot/bus names), not
// raw IDs -- resolved once here rather than at every call site.
function displayFilters(schema, filters) {
  const display = { ...filters };
  for (const f of schema) {
    if ((f.type === 'depot') && display[f.key]) {
      display[f.key] = db.prepare('SELECT name FROM depots WHERE id = ?').get(display[f.key])?.name ?? display[f.key];
    }
    if (f.type === 'bus' && display[f.key]) {
      display[f.key] = db.prepare('SELECT registration_no FROM buses WHERE id = ?').get(display[f.key])?.registration_no ?? display[f.key];
    }
  }
  return display;
}

function parseFilters(schema, query) {
  const filters = {};
  for (const f of schema) {
    if (query[f.key] !== undefined && query[f.key] !== '') {
      filters[f.key] = ['depot_id', 'bus_id', 'from_depot_id', 'to_depot_id', 'days_overdue'].includes(f.key)
        ? Number(query[f.key])
        : query[f.key];
    }
  }
  return filters;
}

router.get('/', (req, res) => {
  res.json(
    Object.entries(REPORTS).map(([key, r]) => ({ key, name: r.name, filters: r.filters, columns: r.columns }))
  );
});

router.get('/:key', (req, res) => {
  const report = REPORTS[req.params.key];
  if (!report) return res.status(404).json({ error: 'Unknown report' });

  const rawFilters = parseFilters(report.filters, req.query);
  const { filters, error } = scopeFilters(req.params.key, rawFilters, req.user);
  if (error) return res.status(403).json({ error });

  const missingRequired = report.filters.find((f) => f.required && !filters[f.key]);
  if (missingRequired) return res.status(400).json({ error: `${missingRequired.label} is required` });

  if (req.params.key === 'bus-tyre-health' && !filters.bus_id && !filters.depot_id) {
    return res.status(400).json({ error: 'Either Depot or Bus filter is required' });
  }

  const allRows = report.getRows(filters);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  res.json({
    data: allRows.slice(offset, offset + pageSize),
    total: allRows.length,
    page,
    pageSize,
    columns: report.columns,
    filters: report.filters,
  });
});

router.get('/:key/export', async (req, res) => {
  const report = REPORTS[req.params.key];
  if (!report) return res.status(404).json({ error: 'Unknown report' });

  const format = req.query.format;
  if (!['xlsx', 'pdf'].includes(format)) return res.status(400).json({ error: 'format must be xlsx or pdf' });

  const rawFilters = parseFilters(report.filters, req.query);
  const { filters, error } = scopeFilters(req.params.key, rawFilters, req.user);
  if (error) return res.status(403).json({ error });

  const missingRequired = report.filters.find((f) => f.required && !filters[f.key]);
  if (missingRequired) return res.status(400).json({ error: `${missingRequired.label} is required` });

  if (req.params.key === 'bus-tyre-health' && !filters.bus_id && !filters.depot_id) {
    return res.status(400).json({ error: 'Either Depot or Bus filter is required' });
  }

  const rows = report.getRows(filters); // full, unpaginated
  const meta = {
    reportName: report.name,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    generatedByUsername: req.user.username,
    filterSchema: report.filters,
    filters: displayFilters(report.filters, filters),
    columns: report.columns,
    rows,
  };

  const fileBase = report.name.replace(/[^a-z0-9]+/gi, '_');

  if (format === 'xlsx') {
    const buffer = await buildXlsx(meta);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
    return res.send(Buffer.from(buffer));
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
  buildPdf(meta, res);
});

module.exports = router;
