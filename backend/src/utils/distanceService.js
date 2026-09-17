/**
 * @file distanceService.js
 * @description Accurately calculates and maintains total distance travelled by tyres and buses.
 * Independently maintains:
 * 1. Tyre Total Distance: Tracks cumulative distance across all historical mounting stints
 *    (fitment, replacement, rotation, repair remount, transfer) plus any active stint on a bus.
 * 2. Bus Total Distance: Sourced from monotonic odometer readings.
 */

const db = require('../db');

/**
 * Pure calculation helper for lifecycle total distance from event history.
 *
 * @param {Array<Object>} events Chronologically ordered tyre events
 * @param {Object|null} currentBus { id, odometer_km } or null if unmounted
 * @returns {number} Total distance in km
 */
function computeTyreDistanceFromStints(events = [], currentBus = null) {
  let totalDistance = 0;
  let currentStint = null; // { busId, startKm }

  for (const ev of events) {
    const isMountEvent =
      ev.event_type === 'fitment_created' ||
      (ev.event_type === 'replacement' && ev.to_position != null) ||
      (ev.event_type === 'puncture_repair' && ev.bus_id != null && ev.position != null) ||
      (ev.event_type === 'purchase_intake' && ev.bus_id != null);

    const isTransferEvent = ev.event_type === 'inter_bus_transfer';

    const isRemovalEvent =
      ev.event_type === 'send_to_store' ||
      ev.event_type === 'send_to_repair' ||
      ev.event_type === 'condemnation' ||
      ev.event_type === 'retread_sent' ||
      (ev.event_type === 'replacement' && ev.from_position != null);

    if (isTransferEvent) {
      if (currentStint) {
        const endKm = ev.odometer_km ?? currentStint.startKm;
        if (endKm >= currentStint.startKm) {
          totalDistance += (endKm - currentStint.startKm);
        }
      }
      const newBusId = ev.to_bus_id || ev.bus_id;
      const startKm = ev.odometer_km ?? 0;
      currentStint = newBusId ? { busId: newBusId, startKm } : null;
      continue;
    }

    if (isMountEvent) {
      if (currentStint && currentStint.busId !== ev.bus_id) {
        const endKm = ev.odometer_km ?? currentStint.startKm;
        if (endKm >= currentStint.startKm) {
          totalDistance += (endKm - currentStint.startKm);
        }
        currentStint = null;
      }
      const busId = ev.bus_id;
      const startKm = ev.odometer_km ?? 0;
      currentStint = busId ? { busId, startKm } : null;
      continue;
    }

    if (isRemovalEvent) {
      if (currentStint) {
        const endKm = ev.odometer_km ?? currentStint.startKm;
        if (endKm >= currentStint.startKm) {
          totalDistance += (endKm - currentStint.startKm);
        }
        currentStint = null;
      }
      continue;
    }
  }

  // If currently mounted, add delta from current stint start to live bus odometer
  if (currentBus && currentBus.odometer_km != null) {
    const startKm = currentStint?.startKm ?? 0;
    if (currentBus.odometer_km >= startKm) {
      totalDistance += (currentBus.odometer_km - startKm);
    }
  }

  return Math.round(totalDistance);
}

/**
 * Computes the lifecycle total distance (in km) travelled by a tyre.
 * Accurate across mounts, unmounts, rotations, inter-bus transfers, and repairs.
 *
 * @param {number} tyreId
 * @returns {Promise<number>} Total distance travelled in km (integer >= 0)
 */
async function computeTyreDistance(tyreId) {
  if (!tyreId) return 0;

  const tyre = await db.prepare('SELECT id, current_bus_id, status FROM tyres WHERE id = ?').get(tyreId);
  if (!tyre) return 0;

  const events = await db
    .prepare(`
      SELECT id, event_type, event_date, bus_id, from_bus_id, to_bus_id,
             from_position, to_position, position, odometer_km
      FROM tyre_events
      WHERE tyre_id = ?
      ORDER BY event_date ASC, id ASC
    `)
    .all(tyreId);

  let currentBus = null;
  if (tyre.current_bus_id) {
    const bus = await db.prepare('SELECT id, odometer_km FROM buses WHERE id = ?').get(tyre.current_bus_id);
    if (bus) currentBus = bus;
  }

  return computeTyreDistanceFromStints(events, currentBus);
}

/**
 * Computes live total distance travelled for a bus.
 *
 * @param {number} busId
 * @returns {Promise<number>}
 */
async function computeBusDistance(busId) {
  if (!busId) return 0;
  const bus = await db.prepare('SELECT odometer_km FROM buses WHERE id = ?').get(busId);
  return bus?.odometer_km ?? 0;
}

module.exports = {
  computeTyreDistance,
  computeTyreDistanceFromStints,
  computeBusDistance,
};

