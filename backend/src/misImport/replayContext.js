/**
 * @file replayContext.js
 * @description The "Replay Context" component (§2, §4): an AsyncLocalStorage
 * flag any non-transactional side effect (currently just alert email
 * delivery -- see utils/emailService.js) must check before firing. A DB
 * rollback is invisible to an email already sent, so preview mode can't
 * rely on the dry-run transaction rollback alone to keep a preview side-
 * effect-free; code that reaches outside the current transaction has to
 * check this explicitly. Standing rule for the codebase (Architecture §4),
 * not a one-off patch -- any future integration that sends something
 * externally must check this the same way any DB write must go through
 * createTyreEvent().
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runInReplayContext(mode, fn) {
  return storage.run({ mode }, fn);
}

function isPreviewMode() {
  return storage.getStore()?.mode === 'preview';
}

module.exports = { runInReplayContext, isPreviewMode };
