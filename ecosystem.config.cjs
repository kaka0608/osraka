module.exports = {
  apps: [{
    name: 'os-minter-bot',
    script: './os-minter-bot.js',
    cwd: '/home/rakatzy/opensea-minter-bot',
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 10,
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    watch: false,
  }],
};