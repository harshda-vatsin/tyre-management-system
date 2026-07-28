/**
 * @file apiError.js
 * @description Shared HTTP-status-carrying error class. Extracted so that
 * tyreEvents.js and lifecycleStateMachine.js throw the same class -- routes
 * check `err instanceof ApiError` against whichever module they imported it
 * from, so two independently-defined classes would silently fail that check
 * and fall through to a generic 500.
 */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { ApiError };
