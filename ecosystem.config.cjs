module.exports = {
  apps: [
    {
      name: 'gis-kontum',
      script: './server.js',
      cwd: __dirname,
      interpreter: 'node',
      // Giới hạn V8 old-gen heap ở 400MB — thấp hơn max_memory_restart (512M).
      // GC chạy thường xuyên hơn nhưng mỗi lần pause ngắn (~1-2s thay vì 25s).
      node_args: '--max-old-space-size=400',

      // Production runtime
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_memory_restart: '512M',
      restart_delay: 3000,
      kill_timeout: 10000,

      // Logs
      time: true,
      merge_logs: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env: {
        NODE_ENV: 'development',
        PORT: 3005,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3005,
      },
    },
  ],
};
