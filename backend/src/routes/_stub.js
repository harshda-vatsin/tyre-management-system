const express = require('express');
const { authenticate } = require('../middleware/auth');

// Generates a minimal authenticated stub router for a resource that hasn't
// been built out yet. Replaced with real CRUD + business logic in later checkpoints.
function makeStubRouter(resourceName) {
  const router = express.Router();
  router.use(authenticate);
  router.get('/', (req, res) => {
    res.json({ resource: resourceName, message: 'Not implemented yet', data: [] });
  });
  return router;
}

module.exports = makeStubRouter;
