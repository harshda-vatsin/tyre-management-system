/**
 * @file asyncHandler.js
 * @description Express 4 does not catch rejected promises from an async
 * route handler -- an unhandled rejection there would hang the request
 * instead of reaching app.js's error handler. Wrapping every handler with
 * this forwards any thrown/rejected error to next(err) instead.
 */

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
