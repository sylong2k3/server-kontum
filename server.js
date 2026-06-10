const app = require("./src/app");
const db = require("./src/configs/database");
// Tạm tắt các module chưa tồn tại
// const { initializeEarthEngine, isInitialized } = require("./src/configs/gge");
// const {
//   initWebSocketServer,
//   closeWebSocketServer,
// } = require("./src/realtime/websocket.server");
// const TokenManager = require("./src/utils/tokenManager");
// const NotificationPushWorker = require("./src/services/notification-push.worker");
// const ScheduledReportService = require("./src/services/scheduled-report.service");
require("dotenv").config();

const PORT = process.env.PORT || 8881;
const HOST = process.env.HOST || "0.0.0.0";
const WS_PATH = "/ws";

const IS_SINGLETON_WORKER =
  !process.env.CLUSTER_WORKER_ID || process.env.CLUSTER_WORKER_ID === "0";

let server;
let isShuttingDown = false;

function formatField(label, value) {
  return `${label.padEnd(14)}: ${value}`;
}

function printStartupBanner({ dbStatus }) {
  const publicHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  const lines = [
    "KON TUM SERVER API",
    formatField("HTTP", `http://${publicHost}:${PORT}`),
    formatField("WebSocket", `(disabled)`),
    formatField("Environment", process.env.NODE_ENV || "development"),
    formatField("Database", process.env.DB_NAME || "(not configured)"),
    formatField(
      "DB Host",
      `${process.env.DB_HOST || "(not configured)"}:${process.env.DB_PORT || "(not configured)"}`,
    ),
    formatField("PostgreSQL", dbStatus),
    formatField("File Storage", "✓ Local (public/uploads)"),
    formatField("Earth Engine", `✗ Uninitialized (disabled)`),
  ];

  const width = Math.max(...lines.map((line) => line.length), 48);
  const border = "─".repeat(width + 2);

  console.log(`\n┌${border}┐`);

  lines.forEach((line, index) => {
    console.log(`│ ${line.padEnd(width)} │`);
    if (index === 0) {
      console.log(`├${border}┤`);
    }
  });

  console.log(`└${border}┘`);
}

async function getDatabaseStartupStatus() {
  try {
    await db.query("SELECT 1");
    return "✓ Connected";
  } catch (error) {
    const reason = error.code || error.message || "Unknown";
    return `✗ Error (${reason})`;
  }
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal} signal. Shutting down server gracefully...`);

  // Dừng cleanup interval (tạm tắt do thiếu module)
  // if (IS_SINGLETON_WORKER) {
  //   TokenManager.stopCleanup();
  //   NotificationPushWorker.stop();
  //   ScheduledReportService.stop();
  // }

  if (server) {
    server.close(async () => {
      console.log("HTTP server closed");

      // closeWebSocketServer();

      try {
        await db.pool.end();
        console.log("Database connection closed");
      } catch (error) {
        console.error("Error closing database connection:", error);
      }

      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  // Force exit sau 10s nếu graceful shutdown bị treo
  setTimeout(() => {
    console.error("Graceful shutdown timeout, forcing exit...");
    process.exit(1);
  }, 10000).unref();
}

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION! Shutting down server...");
  console.error(error.name, error.message);
  console.error(error.stack);
  gracefulShutdown("uncaughtException").finally(() => process.exit(1));
});

// Initialize and start server
const initializeAndStartServer = async () => {
  try {
    // await initializeEarthEngine();

    const dbStatus = await getDatabaseStartupStatus();

    // Start HTTP server
    server = app.listen(PORT, HOST, () => {
      printStartupBanner({ dbStatus });
    });

    // initWebSocketServer(server, { path: WS_PATH });

    // Singleton services: only worker 0 runs (temporarily disabled)
    // if (IS_SINGLETON_WORKER) {
    //   TokenManager.initializeCleanup();
    //   NotificationPushWorker.start();
    //   ScheduledReportService.start();
    // }

    // Handle unhandled Promise rejections
    process.on("unhandledRejection", (error) => {
      console.error("UNHANDLED PROMISE REJECTION! Shutting down server...");
      console.error(error.name, error.message);
      console.error(error.stack);
      gracefulShutdown("unhandledRejection");
    });

    // Graceful shutdown signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    return server;
  } catch (error) {
    console.error("✗ Earth Engine initialization error:", error.message);
    console.error("  Shutting down server...");
    process.exit(1);
  }
};

// Start server
initializeAndStartServer();

module.exports = server;
