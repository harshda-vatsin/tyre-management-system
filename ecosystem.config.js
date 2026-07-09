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
      // better-sqlite3 keeps a synchronous file handle open; a clean SIGTERM
      // (handled in src/index.js) lets it close the DB before PM2 kills it.
      kill_timeout: 5000,
      max_restarts: 10,
      restart_delay: 2000,
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
