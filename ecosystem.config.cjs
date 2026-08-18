/**
 * PM2 process manager config for Argus production deployments.
 *
 * Usage (after `npm run build`):
 *   npm run pm2:start    # start fork-mode process with log rotation + memory cap
 *   npm run pm2:stop     # stop
 *   npm run pm2:logs     # tail combined logs
 *
 * Logs land under data/logs/ (pm2-out.log, pm2-error.log). crash.log is separate
 * (globalErrorHandlers.ts). NODE_OPTIONS --use-system-ca helps TLS to broker APIs on Windows.
 */
module.exports = {
  apps: [
    {
      name: 'argus',
      script: 'dist/server.cjs',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: 'data/logs/pm2-out.log',
      error_file: 'data/logs/pm2-error.log',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--use-system-ca',
      },
      env_development: {
        NODE_ENV: 'development',
        NODE_OPTIONS: '--use-system-ca',
      },
    },
  ],
};
