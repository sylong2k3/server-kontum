// ── Timezone: khoá về VN (+07:00) ────────────────────────────────────────────
// PHẢI set trước MỌI `require` khác — vì Date/logger cache TZ lúc khởi tạo.
// Ảnh hưởng: log timestamp, cron string ("0 6 * * *" → 06:00 VN thực),
// analysisDate/computed_at hiển thị theo VN. TIMESTAMPTZ trong DB vẫn store
// UTC (không đổi), chỉ affect cách Node.js FORMAT thôi.
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';
require("dotenv").config({ quiet: true });

const app = require("./src/app");
const db = require("./src/configs/database");
const { initializeEarthEngine, isInitialized } = require("./src/configs/gge");
const { logGeeGeometrySources } = require("./src/utils/gee-satellite.util");
const fireRiskCfg = require("./src/configs/fire-risk");
const { initMinio, healthCheck: minioHealthCheck } = require("./src/configs/minioClient");
const geoserverClient = require("./src/utils/geoserver.client");

const tokenCleanupJob = require("./src/jobs/token-cleanup.job");
const notificationCleanupJob = require("./src/jobs/notification-cleanup.job");
const analysisRetentionJob = require("./src/jobs/analysis-retention.job");
const memoryMonitorJob = require("./src/jobs/memory-monitor.job");
const weatherJob = require("./src/jobs/weather.job");
const fireRiskJob            = require("./src/jobs/fire-risk.job");
const fireRiskUrlRefreshJob  = require("./src/jobs/fire-risk-url-refresh.job");
const forestClassificationJob = require("./src/jobs/forest-classification.job");
const imageProcessingWorker = require("./src/workers/imageProcessing.worker");
const geoImportWorker       = require("./src/workers/geoImport.worker");
const rasterIngestWorker    = require("./src/workers/rasterIngest.worker");
const geeInterruptedRunRecovery = require("./src/workers/geeInterruptedRunRecovery.worker");
const geeTaskQueue = require("./src/queues/gee-task.queue");
const {
  initWebSocketServer,
  closeWebSocketServer,
} = require("./src/realtime/websocket.server");

const PORT = process.env.PORT || 8881;
const HOST = process.env.HOST || "0.0.0.0";
const WS_PATH = "/ws";

const IS_SINGLETON_WORKER =
  !process.env.CLUSTER_WORKER_ID || process.env.CLUSTER_WORKER_ID === "0";

let server;
let isShuttingDown = false;
let backgroundWorkerLockClient = null;

const startBackgroundWorkers = async () => {
  if (!IS_SINGLETON_WORKER) return;

  try {
    const client = await db.pool.connect();
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [20260727, 1],
    );
    if (!rows[0]?.acquired) {
      client.release();
      console.warn(
        "[WORKERS] Một runtime khác đang giữ quyền chạy tác vụ nền; runtime này chỉ phục vụ HTTP.",
      );
      return;
    }
    backgroundWorkerLockClient = client;
  } catch (error) {
    console.warn(
      `[WORKERS] Không lấy được khóa tác vụ nền; bỏ qua scheduler/worker: ${error.message}`,
    );
    return;
  }

  geeTaskQueue.start();
  try {
    await geeInterruptedRunRecovery.recoverInterruptedRuns();
  } catch (error) {
    console.warn(`[GEE-RECOVERY] Không thể chạy startup recovery: ${error.message}`);
  }

  tokenCleanupJob.start();
  notificationCleanupJob.start();
  analysisRetentionJob.start();
  weatherJob.start();
  fireRiskJob.start();
  fireRiskUrlRefreshJob.start();
  forestClassificationJob.start();
  imageProcessingWorker.startWorker();
  geoImportWorker.startWorker();
  rasterIngestWorker.startWorker();
};

const stopBackgroundWorkers = async () => {
  tokenCleanupJob.stop();
  notificationCleanupJob.stop();
  analysisRetentionJob.stop();
  weatherJob.stop();
  fireRiskJob.stop();
  fireRiskUrlRefreshJob.stop();
  forestClassificationJob.stop();
  imageProcessingWorker.stopWorker();
  geoImportWorker.stopWorker();
  rasterIngestWorker.stopWorker();
  geeTaskQueue.stop();

  if (!backgroundWorkerLockClient) return;
  const client = backgroundWorkerLockClient;
  backgroundWorkerLockClient = null;
  try {
    await client.query(
      "SELECT pg_advisory_unlock($1::integer, $2::integer)",
      [20260727, 1],
    );
  } catch (error) {
    console.warn(`[WORKERS] Không thể nhả khóa tác vụ nền: ${error.message}`);
  } finally {
    client.release();
  }
};

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

  await stopBackgroundWorkers();
  memoryMonitorJob.stop();
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

    memoryMonitorJob.start();
    await startBackgroundWorkers();

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

    memoryMonitorJob.start();
    await startBackgroundWorkers();

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
