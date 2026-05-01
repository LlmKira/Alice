// Alice production PM2 config.
//
// Usage:
//   cp runtime/.env.example runtime/.env
//   $EDITOR runtime/.env
//   alice doctor
//   pm2 start ecosystem.config.cjs

const path = require("node:path");

const runtimeDir = path.resolve(__dirname, "runtime");

module.exports = {
  apps: [
    {
      name: "alice-runtime",
      cwd: runtimeDir,
      script: "node_modules/.bin/tsx",
      args: "--env-file=.env src/index.ts",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 10,
      kill_timeout: 30000,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
        ALICE_STATE_DIR: runtimeDir,
        ALICE_SYSTEM_BIN_DIR: path.join(runtimeDir, "dist/bin"),
      },
    },
  ],
};
