const app = require("./src/app");
const db = require("./src/configs/database");
const { initializeEarthEngine, isInitialized } = require("./src/configs/gge");
const { logGeeGeometrySources } = require("./src/utils/gee-satellite.util");
const fireRiskCfg = require("./src/configs/fire-risk");
const { initMinio, healthCheck: minioHealthCheck } = require("./src/configs/minioClient");
const geoserverClient = require("./src/utils/geoserver.client");

const tokenCleanupJob = require("./src/jobs/token-cleanup.job");
const notificationCleanupJob = require("./src/jobs/notification-cleanup.job");
const weatherJob = require("./src/jobs/weather.job");
const fireRiskJob            = require("./src/jobs/fire-risk.job");
const forestClassificationJob = require("./src/jobs/forest-classification.job");
const satelliteJob           = require("./src/jobs/satellite.job");
const imageProcessingWorker = require("./src/workers/imageProcessing.worker");
const geoImportWorker       = require("./src/workers/geoImport.worker");
const rasterIngestWorker    = require("./src/workers/rasterIngest.worker");
const {
  initWebSocketServer,
  closeWebSocketServer,
} = require("./src/realtime/websocket.server");
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

function printStartupBanner({ dbStatus, minioStatus, earthEngineStatus, geoserverStatus }) {
  const publicHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  const lines = [
    "APP QUẢN LÝ GIS KONTUM",
    formatField("HTTP", `http://${publicHost}:${PORT}`),
    formatField("WebSocket", `ws://${publicHost}:${PORT}${WS_PATH}`),
    formatField("Environment", process.env.NODE_ENV || "development"),
    formatField("Database", process.env.DB_NAME || "(not configured)"),
    formatField("DB Host",
      `${process.env.DB_HOST || "(not configured)"}:${process.env.DB_PORT || "(not configured)"}`,
    ),
    formatField("PostgreSQL", dbStatus),
    formatField("MinIO",      minioStatus),
    formatField("Earth Engine", earthEngineStatus),
    formatField("GeoServer",    geoserverStatus),
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

  console.log(
    `\nReceived ${signal} signal. Shutting down server gracefully...`,
  );

  tokenCleanupJob.stop();
  notificationCleanupJob.stop();
  weatherJob.stop();
  fireRiskJob.stop();
  forestClassificationJob.stop();
  satelliteJob.stop();
  imageProcessingWorker.stopWorker();
  geoImportWorker.stopWorker();
  rasterIngestWorker.stopWorker();
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
    console.log("Đang khởi tạo Earth Engine...");
    await initializeEarthEngine();
    const earthEngineInitialized = isInitialized();
    console.log(`Earth Engine isInitialized: ${earthEngineInitialized}`);
    console.log("✓ Earth Engine khởi tạo thành công");

    await initMinio();
    const dbStatus          = await getDatabaseStartupStatus();
    const minioOk           = await minioHealthCheck();
    const minioStatus       = minioOk
      ? `✓ Connected (${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000})`
      : `⚠ Unavailable (${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000})`;
    const earthEngineStatus = earthEngineInitialized ? "Initialized" : "Uninitialized";
    const geoserverOk       = await geoserverClient.healthCheck();
    const geoserverStatus   = geoserverOk
      ? `✓ Connected (${process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver'})`
      : `⚠ Unavailable (${process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver'})`;

    server = app.listen(PORT, HOST, () => {
      printStartupBanner({ dbStatus, minioStatus, earthEngineStatus, geoserverStatus });
      // Kiểm tra file geometry local + trạng thái GCS ngay khi startup —
      // cảnh báo sớm nếu production thiếu file để fallback FAO / thiếu bucket
      // để bỏ raster export.
      logGeeGeometrySources();
      if (fireRiskCfg.isGcsConfigured()) {
        console.log(`[FIRE-RISK] ✓ GEE_GCS_BUCKET=${fireRiskCfg.GCS_BUCKET} — raster export sẽ chạy`);
      } else {
        console.log('[FIRE-RISK] ⚠ GEE_GCS_BUCKET chưa cấu hình — raster export sẽ bỏ qua ' +
          '(DB snapshot + GEE tile vẫn tạo bình thường)');
      }
    });
    // Kích hoạt WebSocket realtime (dùng chung HTTP server qua sự kiện 'upgrade').
    initWebSocketServer(server, { path: WS_PATH });

    if (IS_SINGLETON_WORKER) {
      tokenCleanupJob.start();
      notificationCleanupJob.start();
      weatherJob.start();
      fireRiskJob.start();
      forestClassificationJob.start();
      satelliteJob.start();
      imageProcessingWorker.startWorker();
      geoImportWorker.startWorker();
      rasterIngestWorker.startWorker();
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
    // Nếu chỉ là lỗi Earth Engine, tiếp tục khởi động server với trạng thái cảnh báo
    console.warn(`⚠ Earth Engine initialization warning: ${error.message}`);
    console.warn("  Server vẫn khởi động bình thường. GEE sẽ không hoạt động.");

    await initMinio();
    const dbStatus = await getDatabaseStartupStatus();
    const minioOk  = await minioHealthCheck();
    const minioStatus = minioOk
      ? `✓ Connected (${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000})`
      : `⚠ Unavailable (${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000})`;
    const earthEngineStatus = "⚠ Unavailable";
    const geoserverOk       = await geoserverClient.healthCheck();
    const geoserverStatus   = geoserverOk
      ? `✓ Connected (${process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver'})`
      : `⚠ Unavailable (${process.env.GEOSERVER_URL || 'http://localhost:8080/geoserver'})`;

    server = app.listen(PORT, HOST, () => {
      printStartupBanner({ dbStatus, minioStatus, earthEngineStatus, geoserverStatus });
      // Kiểm tra file geometry local + trạng thái GCS ngay khi startup —
      // cảnh báo sớm nếu production thiếu file để fallback FAO / thiếu bucket
      // để bỏ raster export.
      logGeeGeometrySources();
      if (fireRiskCfg.isGcsConfigured()) {
        console.log(`[FIRE-RISK] ✓ GEE_GCS_BUCKET=${fireRiskCfg.GCS_BUCKET} — raster export sẽ chạy`);
      } else {
        console.log('[FIRE-RISK] ⚠ GEE_GCS_BUCKET chưa cấu hình — raster export sẽ bỏ qua ' +
          '(DB snapshot + GEE tile vẫn tạo bình thường)');
      }
    });
    initWebSocketServer(server, { path: WS_PATH });

    if (IS_SINGLETON_WORKER) {
      tokenCleanupJob.start();
      notificationCleanupJob.start();
      weatherJob.start();
      fireRiskJob.start();
      forestClassificationJob.start();
      satelliteJob.start();
      imageProcessingWorker.startWorker();
      geoImportWorker.startWorker();
      rasterIngestWorker.startWorker();
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
  }
};

initializeAndStartServer();

module.exports = server;
