/**
 * PM2 process definitions for EBTMS. Run from the repo root on the VM:
 *   pm2 start ecosystem.config.js
 *
 * Both apps bind to loopback only (127.0.0.1) -- Nginx is the sole public
 * entry point, reverse-proxying / to the frontend and /api to the backend.
 * Neither process needs its port opened in the VM firewall.
 */
module.exports = {
  apps: [
    {
      name: 'ebtms-backend',
      cwd: __dirname + '/backend',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
      },
      // A clean SIGTERM (handled in src/index.js) closes the HTTP server,
      // stops the pg-boss job queue gracefully, and closes the Postgres
      // pool before PM2 kills the process.
      kill_timeout: 5000,
      max_restarts: 10,
      restart_delay: 2000,
      // Zip-bomb defense in depth (README.md's "Memory limit" note): the
      // MIS Excel importer's row/cell ceilings run only after a workbook
      // has already been decompressed into memory, so this is the actual
      // backstop against a genuinely adversarial file. 1GB is a starting
      // point, not a measured figure -- size it to what this VM can
      // actually spare before relying on it.
      max_memory_restart: '1G',
    },
    {
      name: 'ebtms-frontend',
      cwd: __dirname + '/frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      kill_timeout: 5000,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
