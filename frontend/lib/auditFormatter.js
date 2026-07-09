/**
 * @file auditFormatter.js
 * @description Centralized EBTMS Audit Log formatting engine. Resolves human-readable labels,
 * maps database field names to labels, translates codes/constants, and generates change summaries.
 */

export const POSITION_MAP = {
  FL: 'Front Left',
  FR: 'Front Right',
  RL: 'Rear Left',
  RR: 'Rear Right',
  RLO: 'Rear Left Outer',
  RLI: 'Rear Left Inner',
  RRO: 'Rear Right Outer',
  RRI: 'Rear Right Inner',
};

export const EVENT_TYPE_MAP = {
  nsd_reading: 'NSD Reading',
  pressure_reading: 'Pressure Reading',
  rotation: 'Tyre Rotation',
  replacement: 'Tyre Replacement',
  puncture_repair: 'Puncture Repair',
  inter_bus_transfer: 'Inter-Bus Transfer',
  send_to_store: 'Sending to Store',
  condemnation: 'Condemnation',
};

export const ACTION_LABELS = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deactivated',
  TRANSFER: 'Transferred',
  AMEND_EVENT: 'Event Amended',
};

export const FIELD_LABELS = {
  // Tyre fields
  tyre_number: 'Tyre Number',
  brand: 'Brand',
  model: 'Model',
  size: 'Size',
  purchase_date: 'Purchase Date',
  initial_nsd: 'Initial NSD',
  status: 'Status',
  current_bus_id: 'Bus',
  current_position: 'Position',
  current_depot_id: 'Depot',
  
  // Bus fields
  registration_no: 'Registration Number',
  chassis_no: 'Chassis Number (VIN)',
  bus_model_id: 'Bus Model',
  year_of_manufacture: 'Year of Manufacture',
  date_of_entry_into_fleet: 'Date of Entry',
  is_active: 'Status',

  // Depot fields
  name: 'Name',
  code: 'Code',
  region: 'Region',
  address: 'Address',

  // Threshold fields
  parameter_type: 'Parameter Type',
  scope_type: 'Scope Type',
  scope_id: 'Scope ID',
  warning_min: 'Warning Min',
  warning_max: 'Warning Max',
  critical_min: 'Critical Min',
  critical_max: 'Critical Max',
  unit: 'Unit',

  // User fields
  username: 'Username',
  full_name: 'Full Name',
  role: 'Role',
  depot_id: 'Depot',

  // Tyre Event fields
  event_type: 'Event Type',
  event_date: 'Event Date',
  nsd_value: 'NSD Value',
  pressure_value: 'Pressure Value',
  repair_type: 'Repair Type',
  reason: 'Reason',
  notes: 'Notes',
  stored_at: 'Stored At',
  odometer_km: 'Odometer (km)',
};

export function humanizePosition(pos) {
  if (!pos) return 'Not set';
  return POSITION_MAP[pos] || pos;
}

export function humanizeEventType(type) {
  if (!type) return 'Unknown Event';
  return EVENT_TYPE_MAP[type] || type;
}

export function formatFieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

export function formatValue(field, value, contextObj = {}) {
  if (value === null || value === undefined || value === '') {
    return 'Not set';
  }
  if (typeof value === 'boolean') {
    if (field === 'is_active') return value ? 'Active' : 'Inactive';
    return value ? 'Yes' : 'No';
  }
  if (field === 'is_active') {
    return value === 1 || value === true ? 'Active' : 'Inactive';
  }
  if (field === 'current_position' || field === 'position' || field === 'from_position' || field === 'to_position') {
    return humanizePosition(value);
  }
  if (field === 'event_type') {
    return humanizeEventType(value);
  }
  if (field === 'nsd_value' || field === 'initial_nsd' || field === 'warning_max' || field === 'critical_max') {
    if (contextObj.parameter_type === 'PRESSURE' || field.includes('pressure')) {
      return `${value} PSI`;
    }
    if (contextObj.parameter_type === 'INSPECTION_INTERVAL') {
      return `${value} Days`;
    }
    if (contextObj.parameter_type === 'ESCALATION_DAYS') {
      return `${value} Days`;
    }
    return `${value} mm`;
  }
  if (field === 'pressure_value' || field === 'warning_min' || field === 'critical_min') {
    return `${value} PSI`;
  }
  if (field === 'current_bus_id' || field === 'bus_id' || field === 'to_bus_id' || field === 'from_bus_id') {
    // If context object has registration number name attached
    const regKey = field === 'from_bus_id' ? 'from_bus_registration_no' : (field === 'to_bus_id' ? 'to_bus_registration_no' : 'bus_registration_no');
    return contextObj[regKey] || `Bus ID: ${value}`;
  }
  if (field === 'current_depot_id' || field === 'depot_id' || field === 'to_depot_id' || field === 'from_depot_id') {
    const depKey = field === 'from_depot_id' ? 'from_depot_name' : (field === 'to_depot_id' ? 'to_depot_name' : 'depot_name');
    return contextObj[depKey] || `Depot ID: ${value}`;
  }
  if (field === 'bus_model_id') {
    return contextObj.bus_model_name || `Model ID: ${value}`;
  }
  if (field === 'user_id' || field === 'amended_by') {
    return contextObj.username || contextObj.amended_by_username || `User ID: ${value}`;
  }
  return String(value);
}

export function formatAuditEntry(log) {
  let before = null;
  let after = null;
  try { before = log.before_json ? JSON.parse(log.before_json) : null; } catch (e) {}
  try { after = log.after_json ? JSON.parse(log.after_json) : null; } catch (e) {}

  let entityLabel = log.entity_type;
  let entityRef = '';

  switch (log.entity_type) {
    case 'user':
      entityLabel = 'User';
      entityRef = after?.username || before?.username || '';
      break;
    case 'tyre':
      entityLabel = 'Tyre';
      entityRef = after?.tyre_number || before?.tyre_number || '';
      break;
    case 'depot':
      entityLabel = 'Depot';
      entityRef = after?.name || before?.name || '';
      break;
    case 'bus':
      entityLabel = 'Bus';
      entityRef = after?.registration_no || before?.registration_no || '';
      break;
    case 'bus_model':
      entityLabel = 'Bus Model';
      entityRef = after?.name || before?.name || '';
      break;
    case 'threshold':
      entityLabel = 'Threshold';
      const pType = after?.parameter_type || before?.parameter_type || '';
      const sType = after?.scope_type || before?.scope_type || 'GLOBAL';
      const scopeVal = sType === 'GLOBAL' ? 'Global' : (sType === 'DEPOT' ? 'Depot Override' : 'Model Override');
      entityRef = `${pType} (${scopeVal})`;
      break;
    case 'system_setting':
      entityLabel = 'System Setting';
      entityRef = after?.key || before?.key || '';
      break;
    case 'tyre_event':
      entityLabel = 'Tyre Event';
      const evType = humanizeEventType(after?.event_type || before?.event_type);
      const tyrNum = after?.tyre_number || before?.tyre_number || `Tyre ID: ${after?.tyre_id || before?.tyre_id}`;
      entityRef = `${evType} · ${tyrNum}`;
      break;
    case 'alert':
      entityLabel = 'Alert';
      const prmType = after?.parameter_type || before?.parameter_type || '';
      const tNum = after?.tyre_number || before?.tyre_number || `Tyre ID: ${after?.tyre_id || before?.tyre_id}`;
      entityRef = `${prmType} · ${tNum}`;
      break;
    default:
      entityLabel = log.entity_type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      entityRef = log.entity_id || '';
  }

  const changeSummary = getChangeSummary(log, before, after);

  return {
    ...log,
    before,
    after,
    entityLabel,
    entityRef,
    changeSummary,
  };
}

function getChangeSummary(log, before, after) {
  const { action, entity_type } = log;

  if (action === 'CREATE') {
    switch (entity_type) {
      case 'tyre':
        return `Created tyre ${after?.tyre_number || ''}`;
      case 'bus':
        return `Created bus ${after?.registration_no || ''}`;
      case 'depot':
        return `Created depot ${after?.name || ''}`;
      case 'user':
        return `Created user ${after?.username || ''}`;
      case 'bus_model':
        return `Created bus model ${after?.name || ''}`;
      case 'threshold':
        return `Created ${after?.parameter_type} threshold (${after?.scope_type === 'GLOBAL' ? 'Global' : 'Override'})`;
      case 'tyre_event':
        return `Logged ${humanizeEventType(after?.event_type)} for ${after?.tyre_number || `Tyre ID: ${after?.tyre_id}`}`;
      case 'alert':
        return `Triggered ${after?.parameter_type} alert on ${after?.tyre_number || ''}`;
      case 'system_setting':
        return `Created setting ${after?.key}`;
      default:
        return `Created new ${entity_type}`;
    }
  }

  if (action === 'DELETE') {
    switch (entity_type) {
      case 'tyre':
        return `Deleted tyre ${before?.tyre_number || ''}`;
      case 'bus':
        return `Deleted bus ${before?.registration_no || ''}`;
      case 'depot':
        return `Deleted depot ${before?.name || ''}`;
      case 'user':
        return `Deleted user ${before?.username || ''}`;
      case 'bus_model':
        return `Deleted bus model ${before?.name || ''}`;
      default:
        return `Deleted ${entity_type}`;
    }
  }

  if (action === 'TRANSFER') {
    return `Bus transferred: ${formatValue('from_depot_id', before?.from_depot_id, before)} → ${formatValue('to_depot_id', after?.to_depot_id, after)}`;
  }

  if (action === 'AMEND_EVENT') {
    const tyr = after?.corrected_values?.tyre_number || before?.tyre_number || `Tyre ID: ${before?.tyre_id}`;
    return `Amended event for ${tyr}: ${after?.reason || ''}`;
  }

  if (action === 'UPDATE') {
    if (!before || !after) return 'Updated attributes';

    // Identify changed fields
    const changedFields = [];
    const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const key of allKeys) {
      if (['created_at', 'updated_at', 'updated_by'].includes(key)) continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changedFields.push(key);
      }
    }

    if (changedFields.length === 0) {
      return 'Updated metadata';
    }

    if (entity_type === 'threshold') {
      const pType = after.parameter_type || before.parameter_type;
      const unit = after.unit || before.unit || '';
      
      const parts = [];
      if (changedFields.includes('warning_max') && before.warning_max !== after.warning_max) {
        parts.push(`Warning Max: ${before.warning_max} → ${after.warning_max} ${unit}`);
      }
      if (changedFields.includes('critical_max') && before.critical_max !== after.critical_max) {
        parts.push(`Critical Max: ${before.critical_max} → ${after.critical_max} ${unit}`);
      }
      if (changedFields.includes('warning_min') && before.warning_min !== after.warning_min) {
        parts.push(`Warning Min: ${before.warning_min} → ${after.warning_min} ${unit}`);
      }
      if (changedFields.includes('critical_min') && before.critical_min !== after.critical_min) {
        parts.push(`Critical Min: ${before.critical_min} → ${after.critical_min} ${unit}`);
      }
      if (changedFields.includes('is_active')) {
        parts.push(`Status: ${before.is_active ? 'Active' : 'Inactive'} → ${after.is_active ? 'Active' : 'Inactive'}`);
      }
      
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }

    if (changedFields.length === 1) {
      const field = changedFields[0];
      if (field === 'status') {
        return `Status changed: ${before.status} → ${after.status}`;
      }
      if (field === 'current_position' || field === 'position') {
        return `Position changed: ${humanizePosition(before[field])} → ${humanizePosition(after[field])}`;
      }
      if (field === 'is_active') {
        const entityLabel = entity_type === 'depot' ? 'Depot status' : 'Status';
        const bLabel = before.is_active === 1 || before.is_active === true ? 'Active' : 'Inactive';
        const aLabel = after.is_active === 1 || after.is_active === true ? 'Active' : 'Inactive';
        return `${entityLabel} changed: ${bLabel} → ${aLabel}`;
      }
      if (field === 'current_depot_id' || field === 'depot_id') {
        return `Depot changed: ${formatValue(field, before[field], before)} → ${formatValue(field, after[field], after)}`;
      }
      if (field === 'current_bus_id' || field === 'bus_id') {
        return `Bus changed: ${formatValue(field, before[field], before)} → ${formatValue(field, after[field], after)}`;
      }
      return `${formatFieldLabel(field)} changed: ${formatValue(field, before[field], before)} → ${formatValue(field, after[field], after)}`;
    }

    // Multiple fields changed
    const labels = changedFields.slice(0, 3).map(formatFieldLabel).join(', ');
    const suffix = changedFields.length > 3 ? ` (+${changedFields.length - 3} more)` : '';
    return `${changedFields.length} fields changed: ${labels}${suffix}`;
  }

  return `${action} ${entity_type}`;
}
