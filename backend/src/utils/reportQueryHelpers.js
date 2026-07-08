/**
 * @file reportQueryHelpers.js
 * @description Dynamic SQL-fragment builder helper methods shared across reporting pipelines.
 * Standardizes depot-level scoping checks, date filtering, and subqueries.
 */

/**
 * Appends a depot restriction clause to the sql clauses array.
 * 
 * @param {string} column - SQL column reference (e.g. 't.current_depot_id')
 * @param {number|string|null} depotId - Depot ID to restrict by (ignored if null/undefined)
 * @param {string[]} clauses - Accumulator array of SQL filter statements
 * @param {object} params - SQL bind parameters object
 * @param {string} [paramName='depotId'] - Parameter name for binding key
 */
function depotScopeClause(column, depotId, clauses, params, paramName = 'depotId') {
  if (depotId) {
    clauses.push(`${column} = @${paramName}`);
    params[paramName] = depotId;
  }
}

/**
 * Appends standard date range boundaries filter checks to the SQL clauses array.
 * 
 * @param {string} column - SQL date column reference (e.g. 'e.event_date')
 * @param {string|null} from - Start date string (YYYY-MM-DD)
 * @param {string|null} to - End date string (YYYY-MM-DD)
 * @param {string[]} clauses - Accumulator array of SQL filter statements
 * @param {object} params - SQL bind parameters object
 * @param {string} [prefix=''] - Prefix for sql bind parameter keys
 */
function dateRangeClause(column, from, to, clauses, params, prefix = '') {
  if (from) {
    clauses.push(`${column} >= @${prefix}from`);
    params[`${prefix}from`] = from;
  }
  if (to) {
    clauses.push(`${column} <= @${prefix}to`);
    params[`${prefix}to`] = to;
  }
}

/**
 * Generates an SQL subquery string resolving the last recorded event parameter of a given event type.
 * 
 * @param {string} eventType - The tyre event type key (e.g. 'nsd_reading')
 * @param {string} field - The event column parameter name to select (e.g. 'nsd_value')
 * @param {string} [asOfParam] - Optional SQL parameter key representing 'As Of Date' boundary
 * @returns {string} SQL subquery string fragment
 */
function lastEventValueSql(eventType, field, asOfParam) {
  const bound = asOfParam ? ` AND event_date <= @${asOfParam}` : '';
  return `(SELECT ${field} FROM tyre_events WHERE tyre_id = t.id AND event_type = '${eventType}'${bound} ORDER BY event_date DESC, id DESC LIMIT 1)`;
}

module.exports = { depotScopeClause, dateRangeClause, lastEventValueSql };
