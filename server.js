const app = require("./src/app");
const db = require("./src/configs/database");
const tokenCleanupJob = require("./src/jobs/token-cleanup.job");
const notificationCleanupJob = require("./src/jobs/notification-cleanup.job");
const {
  initWebSocketServer,
  closeWebSocketServer,
} = require("./src/realtime/websocket.server");
require("dotenv").config();

const PORT = process.env.PORT || 8881;
const HOST = process.env.HOST || "0.0.0.0";
const WS_PATH = "/ws";

const IS_SINGLETON_WORKER = !process.env.CLUSTER_WORKER_ID || process.env.CLUSTER_WORKER_ID === "0";

let server;
let isShuttingDown = false;

function formatField(label, value) {
  return `${label.padEnd(14)}: ${value}`;
}

function printStartupBanner({ dbStatus }) {
  const publicHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  const lines = [
    "APP QUẢN LÝ GIS KONTUM",
    formatField("HTTP", `http://${publicHost}:${PORT}`),
    formatField("WebSocket", `ws://${publicHost}:${PORT}${WS_PATH}`),
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

  tokenCleanupJob.stop();
  notificationCleanupJob.stop();
  closeWebSocketServer();

  if (server) {
    server.close(async () => {
      console.log("HTTP server closed");
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

  setTimeout(() => {
    console.error("Graceful shutdown timeout, forcing exit...");
    process.exit(1);
  }, 10000).unref();
}

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION! Shutting down server...");
  console.error(error.name, error.message);
  console.error(error.stack);
  gracefulShutdown("uncaughtException").finally(() => process.exit(1));
});

const initializeAndStartServer = async () => {
  try {
    const dbStatus = await getDatabaseStartupStatus();

    server = app.listen(PORT, HOST, () => {
      printStartupBanner({ dbStatus });
    });

    // Kích hoạt WebSocket realtime (dùng chung HTTP server qua sự kiện 'upgrade').
    initWebSocketServer(server, { path: WS_PATH });

    if (IS_SINGLETON_WORKER) {
      tokenCleanupJob.start();
      notificationCleanupJob.start();
    }

    process.on("unhandledRejection", (error) => {
      console.error("UNHANDLED PROMISE REJECTION! Shutting down server...");
      console.error(error.name, error.message);
      console.error(error.stack);
      gracefulShutdown("unhandledRejection");
    });

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    return server;
  } catch (error) {
    console.error("✗ Earth Engine initialization error:", error.message);
    console.error("  Shutting down server...");
    process.exit(1);
  }
};

initializeAndStartServer();

module.exports = server;
