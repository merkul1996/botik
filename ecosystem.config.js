module.exports = {
  apps: [{
    name: "neurosputnik",
    script: "src/server.js",
    instances: 2,
    exec_mode: "cluster",
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    env: {
      NODE_ENV: "production",
    },
    env_development: {
      NODE_ENV: "development",
      instances: 1,
    },
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }],
};
