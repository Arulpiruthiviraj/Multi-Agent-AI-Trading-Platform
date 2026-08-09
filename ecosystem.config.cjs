module.exports = {
  apps: [
    {
      name: 'argus',
      script: 'server.ts',
      interpreter: 'node_modules/.bin/tsx',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
