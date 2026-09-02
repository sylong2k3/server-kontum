# Corn Migration — Tổng hợp Cronjob & Scheduler

> Đây là **bản sao dùng để tra cứu / migrate** của toàn bộ file liên quan tới cronjob và các tác vụ nền chạy theo lịch (scheduled tasks) của server GIS Kon Tum. File gốc vẫn nằm trong [server/src/](../src/) — mỗi khi thay đổi source, phải sync lại thư mục này bằng cách xoá và copy lại.
>
> **Lưu ý tên thư mục**: `corn_migration` là typo lịch sử — thực chất là **cron** (crontab). Giữ nguyên tên vì đã có convention trong dự án.

---

## 1. Bố cục thư mục

```
corn_migration/
├── README.md                                  ← file này
├── jobs/                                       ← toàn bộ định nghĩa cron/scheduler
│   ├── analysis-retention.job.js               ← dọn snapshot fire/forest quá hạn (03:45 VN)
│   ├── fire-risk.job.js                        ← daily fire-risk analysis (06:00 VN) + poll GCS export mỗi 30′
│   ├── fire-risk-url-refresh.job.js            ← refresh GEE download URL khi bị 401 url_expired (mỗi 5′)
│   ├── forest-classification.job.js            ← monthly classify (00:00 ngày 1) + recovery watchdog
│   ├── memory-monitor.job.js                   ← sample process.memoryUsage() (không phải node-cron)
│   ├── notification-cleanup.job.js             ← dọn notification/device token quá hạn (03:30 VN)
│   ├── satellite.job.js                        ← poll GeoServer publish cho satellite on-demand (mỗi 30′) — ORPHAN, xem §5
│   ├── token-cleanup.job.js                    ← dọn refresh/blacklist/reset token hết hạn (đầu mỗi giờ)
│   └── weather.job.js                          ← refresh cache OpenWeather + wind grid (đầu mỗi giờ)
├── configs/
│   ├── analysis-retention.js                   ← ENV: ANALYSIS_RETENTION_CRON, FIRE_RISK_RETENTION_DAYS, …
│   ├── fire-risk.js                            ← ENV: FIRE_RISK_CRON, FIRE_RISK_CATCHUP, tất cả param GEE
│   ├── forest-classification.js                ← ENV: FC_CRON, FC_CATCHUP_ENABLED, sample budget, RF params
│   └── weather.js                              ← ENV: WEATHER_CRON, OPENWEATHER_API_KEY, TTL, bbox
├── services/
│   ├── analysis-retention.service.js           ← cleanupCandidate() — gỡ GeoServer + MinIO + DB
│   └── weather.service.js                      ← refreshCache() → point + wind grid
└── repositories/
    ├── analysis-retention.repository.js        ← listFireCandidates/listForestCandidates, deleteSnapshot
    ├── notification.repository.js              ← cleanupExpired({ retentionDays, staleTokenDays })
    ├── token.repository.js                     ← cleanupExpired() → refreshToken + blacklist + reset + oauth
    └── weather.repository.js                   ← deleteExpired(graceDays) → purge cache cũ
```

> Repository fire-risk / forest-classification / satellite được cả cron dùng nhưng **thuộc chuyên mảng GEE** — xem bản sao trong [../gee_migration/](../gee_migration/README.md).

---

## 2. Khởi chạy — nơi cron được đăng ký

Điểm vào duy nhất: [server/server.js](../server.js)

```js
// Chỉ khởi động background workers khi runtime lấy được PostgreSQL advisory lock
// pg_try_advisory_lock(20260727, 1)  ← cluster-wide singleton
const startBackgroundWorkers = async () => {
  geeTaskQueue.start();
  await geeInterruptedRunRecovery.recoverInterruptedRuns();

  tokenCleanupJob.start();          // hourly
  notificationCleanupJob.start();   // 03:30 daily
  analysisRetentionJob.start();     // 03:45 daily
  weatherJob.start();               // hourly + immediate warm-up
  fireRiskJob.start();              // 06:00 daily + poll 30′ + watchdog 5′
  fireRiskUrlRefreshJob.start();    // every 5′
  forestClassificationJob.start();  // 00:00 day-1 monthly + watchdog 5′
  imageProcessingWorker.startWorker();
  geoImportWorker.startWorker();
  rasterIngestWorker.startWorker();
};
```

`memoryMonitorJob` KHÔNG cần lock — luôn start ngay khi server up (mỗi runtime tự sample RSS/heap của process mình).

**Timezone**: `server.js` set `process.env.TZ = 'Asia/Ho_Chi_Minh'` **trước** mọi `require`. Cron string như `"0 6 * * *"` do đó là **06:00 giờ VN**, không phải UTC. `node-cron` được truyền `{ timezone: 'Asia/Ho_Chi_Minh' }` để double-safe khi container base image có TZ khác.

---

## 3. Bảng tổng hợp cron schedules

| Job                        | Cron (mặc định)    | ENV để override                    | Mục đích                                                  |
|----------------------------|--------------------|------------------------------------|-----------------------------------------------------------|
| `token-cleanup`            | `0 * * * *`        | `TOKEN_CLEANUP_CRON`               | Xoá refresh/blacklist/reset/oauth token hết TTL           |
| `notification-cleanup`     | `30 3 * * *`       | `NOTIFICATION_CLEANUP_CRON`        | Notification quá 90d + device token idle 60d              |
| `analysis-retention`       | `45 3 * * *`       | `ANALYSIS_RETENTION_CRON`          | Fire snapshot > 90d, forest > 36 tháng — gỡ tuần tự       |
| `weather` (refresh)        | `0 * * * *`        | `WEATHER_CRON`                     | Điểm current-weather + wind grid Open-Meteo               |
| `fire-risk` (analysis)     | `0 6 * * *`        | `FIRE_RISK_CRON`                   | Chạy GEE fire-risk pipeline v8.1 cho ngày hôm nay         |
| `fire-risk` (poll)         | `*/30 * * * *`     | `FIRE_RISK_POLL_CRON`              | Poll GCS export task → harvest → GeoServer publish        |
| `fire-risk` (watchdog)     | `setInterval 5′`   | (constant)                         | Chạy bù nếu miss cron sáng hoặc restart giữa run          |
| `fire-risk-url-refresh`    | `*/5 * * * *`      | `FIRE_RISK_URL_REFRESH_CRON`       | Regen GEE URL khi worker gặp HTTP 401 url_expired         |
| `forest-classification`    | `0 0 1 * *`        | `FC_CRON`                          | Classify **tháng vừa kết thúc** vào 00:00 ngày 1          |
| `forest-classification` WD | `setInterval 5′`   | (constant)                         | Chạy bù nếu miss tick ngày 1                              |
| `satellite` (poll)         | `*/30 * * * *`     | `SATELLITE_POLL_CRON`              | Poll pending publish của satellite on-demand — **orphan** |
| `memory-monitor`           | `setInterval 60s`  | `PROCESS_MEMORY_MONITOR_INTERVAL_MS` | Sample RSS/heap, warn nếu > 1GB, critical > 1.5GB       |

---

## 4. Chi tiết từng pipeline

### 4.1 `analysis-retention.job` — dọn snapshot cũ

- **Handler**: `service.runCleanup()`
- **Flow**:
  1. `repo.listFireCandidates({ retentionDays, limit: batchSize })` → snapshot fire có `analysis_date < NOW - retentionDays`
  2. `repo.listForestCandidates({ retentionMonths })` → tương tự cho forest
  3. Với mỗi candidate: `cleanupCandidate(kind, candidate)`
     - `repo.listArtifacts()` → mọi raster ingest job / map_layer đã publish
     - Nếu còn `job_status ∈ {pending, running, retrying}` → **throw** (giữ lại, thử lần sau)
     - Loop artifacts:
       - `geoserver.deleteCoverageStore(store)` (hoặc `unpublishLayer(layer)`)
       - `fs.unlink(GEOSERVER_DATA_DIR/gee-rasters/<store>.tif)`
       - `minio.removeObject(minio_key, minio_bucket)`
     - `repo.deleteSnapshot({ jobIds, layerIds })` — cascade
- **Cấu hình quan trọng**: `FIRE_RISK_RETENTION_DAYS=90`, `FOREST_CLASSIFICATION_RETENTION_MONTHS=36`, `ANALYSIS_RETENTION_BATCH_SIZE=20`
- **Overlap protection**: `running` flag toàn cục — tick sau bỏ qua nếu tick trước chưa xong

### 4.2 `fire-risk.job` — daily fire warning + poll export

3 sub-schedule:

**Tick A — `runDailyAnalysis(today)` (06:00 VN)**
- Guard: nếu `repo.hasCompletedAttempt(today)` → SKIP (migration 040)
- Gọi `svc.runAnalysis(today)` → xem [../gee_migration/README.md §3.1](../gee_migration/README.md#31-fire-risk-pipeline-ep-06)
- Nếu lỗi: đếm `countFailedAttempts(today)` → `scheduleRetry` với delay `[15′, 60′, 6h]`, cap 3 lần

**Tick B — `runPollExports()` (mỗi 30′)**
- `repo.listExporting()` → snapshot còn ở status `exporting` (đang chờ GEE export task)
- `svc.pollExports()` → check task GCS, harvest → GeoServer, cập nhật `status=published`
- Log IDLE mỗi 24 tick (~12h) để chứng minh cron còn sống

**Tick C — Watchdog `setInterval(5′)` sau startup 60s**
- Nếu `passedCronTime(now, "0 6 * * *")` VÀ chưa có completed attempt cho `today` VÀ chưa vượt retry limit
- → trigger `runDailyAnalysis(today)` ngay (bù khi server vừa restart lúc 06:05)
- Delay 60s trước tick đầu để đợi Earth Engine init xong

**Tại sao dùng `setInterval` cho watchdog thay vì cron thứ hai?**
> `node-cron v4` bỏ hẳn tick bị trễ nếu event loop bị block (GEE evaluate() có thể chặn > 5′). `setInterval` sẽ chạy ngay sau khi loop giải phóng và tự bù. Xem comment trong file `fire-risk.job.js:369`.

### 4.3 `fire-risk-url-refresh.job` — regen GEE URL 401

Cron `*/5 * * * *`. Quét `gis.raster_ingest_jobs.status = 'url_expired'` (worker gặp HTTP 401 lúc download → chuyển sang trạng thái này thay vì retry vô hạn), gom theo `analysis_date`, gọi `svc.refreshExpiredDistrictUrls()` để:
1. Gọi lại `getEeDownloadUrl(image)` per district → URL mới
2. `UPDATE raster_ingest_jobs SET source_url=?, status='pending'` → worker sẽ pickup

**Dedup**: `svc` dùng `activeRuns` Map theo `analysis_date`. Nhiều tick 5′ liên tiếp gọi cùng ngày sẽ dùng chung Promise → không double-invoke GEE.

### 4.4 `forest-classification.job` — monthly classify

Cron `0 0 1 * *` — 00:00 giờ VN ngày 1 mỗi tháng. `resolveTargetPeriod()` luôn trả **tháng vừa kết thúc** (tính bằng `Intl.DateTimeFormat` theo TZ để không sai edge case UTC).

Watchdog `setInterval(5′)` sau startup 60s: nếu `hasCompletedAttempt(year, month) === false` VÀ chưa vượt retry (`countFailedAttempts < 3`) VÀ (`existing` là stale-active > 2h) → `runScheduledAnalysis({ recoverStale: true })`.

Retry delays giống fire-risk: `[15′, 60′, 6h]`.

### 4.5 `notification-cleanup.job`

- `retentionDays=90`, `staleTokenDays=60`
- `repo.cleanupExpired()` chạy 3 query:
  1. `DELETE FROM notifications WHERE expires_at < NOW()`
  2. `DELETE FROM notifications WHERE created_at < NOW - retentionDays`
  3. `DELETE FROM device_tokens WHERE last_used_at < NOW - staleTokenDays`

### 4.6 `token-cleanup.job`

`tokenRepository.cleanupExpired()` return `{ refreshDeleted, blacklistDeleted, resetDeleted, oauthCodeDeleted }`. Không có overlap flag — query đơn, dưới 100ms.

### 4.7 `weather.job`

- Warm ngay tại start (không chặn startup): `runRefresh({ lang: 'vi' })`
- Trong `runRefresh()`:
  - `svc.refreshCache()` — gọi OpenWeather (current @ Kon Tum bbox center) + Open-Meteo (wind grid NxN, N mặc định 8) → upsert `gis.weather_cache`
  - `repo.deleteExpired(WEATHER_CACHE_GRACE_DAYS=7)` — dọn dòng cũ
- Fallback nếu OpenWeather offline: reader (`GET /api/v1/weather/point`) tự trả bản cache gần nhất kèm `stale=true`

### 4.8 `memory-monitor.job`

Không phải `node-cron` — dùng `setInterval(SAMPLE_INTERVAL_MS)` mặc định 60s. Đọc `process.memoryUsage()`, track peak. Log:
- Level WARN nếu `rss > 1024MB` (cooldown 15′)
- Level CRITICAL nếu `rss > 1536MB`
- SUMMARY định kỳ mỗi 15′ (peakRss, peakHeap)

Không tương tác DB / MinIO / GeoServer — pure observability.

---

## 5. Ghi chú kỹ thuật quan trọng

### 5.1 `satellite.job` KHÔNG được start bởi `server.js`

`server.js` KHÔNG import `satellite.job`. File này chạy được nhưng **không tự động khởi động**. Nếu muốn bật:

```diff
+ const satelliteJob = require('./src/jobs/satellite.job');
  …
  fireRiskUrlRefreshJob.start();
+ satelliteJob.start();
  forestClassificationJob.start();
```

Lý do có thể là do flow satellite hiện dùng `getEeMapId` (tile CDN, không cần publish GeoServer) nên poll job trở thành no-op cho hầu hết request. Chỉ endpoint `POST /satellite/publish` mới cần harvest và endpoint đó handle inline.

### 5.2 PostgreSQL Advisory Lock (singleton worker)

```js
SELECT pg_try_advisory_lock(20260727, 1) AS acquired
```

Runtime NÀO lấy được lock sẽ:
1. Start toàn bộ background jobs
2. Giữ lock đến khi `stopBackgroundWorkers()` chạy (SIGTERM/SIGINT)

Các runtime khác chỉ phục vụ HTTP. Cho phép chạy nhiều PM2 instance hoặc replicas mà không lo cron double-fire. Trên PM2 dùng `CLUSTER_WORKER_ID` để chỉ singleton (`0`) mới thử lấy lock — các worker khác thậm chí không query.

### 5.3 Recovery on startup

Trước khi start cron, `geeInterruptedRunRecovery.recoverInterruptedRuns()` chạy 1 lần:
- Đóng mọi snapshot fire/forest `status ∈ {pending, computing, exporting}` (chắc chắn orphan vì process cũ đã chết)
- Tạo attempt mới qua queue GEE — tránh chờ watchdog 5′-45′

Xem chi tiết trong [../gee_migration/workers/geeInterruptedRunRecovery.worker.js](../gee_migration/workers/geeInterruptedRunRecovery.worker.js).

### 5.4 Chống chạy chồng (overlap protection)

Mỗi job có 1 `isRunning`/`analysisRunning`/`pollRunning` flag. Tick tiếp theo sẽ **skip + log warn** nếu tick trước chưa kết thúc. Điều này rất quan trọng cho:

- `fire-risk.job pollExports` — 30′ tick nhưng GCS→MinIO→GeoServer harvest đôi khi > 30′ khi có nhiều task đồng thời
- `weather.job` — có thể chậm khi Open-Meteo trả về 5s + wind grid 64 điểm

---

## 6. Cách chạy thủ công (dev / ops)

Mọi job export `runXxx()` handler public:

```bash
# Fire-risk cho hôm nay
node -e "require('./src/jobs/fire-risk.job').runDailyAnalysis()"

# Fire-risk cho ngày cụ thể
node -e "require('./src/jobs/fire-risk.job').runDailyAnalysis('2026-08-04')"

# Forest classification cho kỳ vừa kết thúc
node -e "require('./src/jobs/forest-classification.job').runScheduledAnalysis()"

# Cleanup snapshot
node -e "require('./src/jobs/analysis-retention.job').runCleanup()"

# Refresh weather cache ngay
node -e "require('./src/jobs/weather.job').runRefresh()"
```

Reset toàn bộ dữ liệu fire+forest (đã có sẵn script): [../scripts/reset-fire-forest-data.js](../scripts/reset-fire-forest-data.js)

---

## 7. Env vars — bảng nhanh

```dotenv
# ── Global ──────────────────────────────────────────────────────────────────
TZ=Asia/Ho_Chi_Minh

# ── Token cleanup ───────────────────────────────────────────────────────────
TOKEN_CLEANUP_CRON=0 * * * *

# ── Notification cleanup ────────────────────────────────────────────────────
NOTIFICATION_CLEANUP_CRON=30 3 * * *
NOTIFICATION_RETENTION_DAYS=90
DEVICE_TOKEN_STALE_DAYS=60

# ── Weather ─────────────────────────────────────────────────────────────────
WEATHER_CRON=0 * * * *
OPENWEATHER_API_KEY=...
WEATHER_CACHE_GRACE_DAYS=7
WEATHER_WIND_GRID_SIZE=8

# ── Fire-risk ───────────────────────────────────────────────────────────────
FIRE_RISK_CRON=0 6 * * *
FIRE_RISK_POLL_CRON=*/30 * * * *
FIRE_RISK_CATCHUP=true
FIRE_RISK_URL_REFRESH_CRON=*/5 * * * *
FIRE_RISK_URL_REFRESH=true
FIRE_RISK_CRON_TZ=Asia/Ho_Chi_Minh
FIRE_RISK_DEBUG=false

# ── Forest classification ───────────────────────────────────────────────────
FC_CRON=0 0 1 * *
FC_CATCHUP_ENABLED=true
FC_CATCHUP_DELAY_MS=60000
FC_CRON_TZ=Asia/Ho_Chi_Minh
FC_DEBUG=false

# ── Analysis retention ──────────────────────────────────────────────────────
ANALYSIS_RETENTION_ENABLED=true
ANALYSIS_RETENTION_CRON=45 3 * * *
ANALYSIS_RETENTION_TZ=Asia/Ho_Chi_Minh
FIRE_RISK_RETENTION_DAYS=90
FOREST_CLASSIFICATION_RETENTION_MONTHS=36
ANALYSIS_RETENTION_BATCH_SIZE=20

# ── Memory monitor ──────────────────────────────────────────────────────────
PROCESS_MEMORY_MONITOR_INTERVAL_MS=60000
PROCESS_MEMORY_LOG_INTERVAL_MS=900000
PROCESS_MEMORY_WARNING_COOLDOWN_MS=900000
PROCESS_MEMORY_WARN_RSS_MB=1024
PROCESS_MEMORY_CRITICAL_RSS_MB=1536

# ── Satellite job (orphan — chỉ dùng khi thủ công bật) ─────────────────────
SATELLITE_POLL_CRON=*/30 * * * *
SATELLITE_CRON_TZ=Asia/Ho_Chi_Minh
SATELLITE_DEBUG=false
```

---

## 8. Đánh giá hiện trạng — điểm mạnh & điểm yếu

### 8.1 Điểm mạnh (nên GIỮ)

| # | Pattern                                              | Vì sao hợp lý                                                                                                            |
|---|------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| 1 | **PostgreSQL advisory lock** làm cluster singleton   | Không cần Zookeeper/Redis/etcd riêng — DB đã có sẵn, atomic 100%. Ideal cho scale nhỏ-vừa (≤ 3 nodes)                    |
| 2 | **Watchdog `setInterval` thay vì cron thứ hai**      | `node-cron v4` DROP tick khi event loop bị block > interval. `setInterval` bù ngay khi loop rảnh                          |
| 3 | **Overlap flag `isRunning`**                         | Tránh 2 tick chồng nhau khi handler chậm — pattern quen thuộc, dễ debug                                                  |
| 4 | **Guard `hasCompletedAttempt(period)` (migration 040)** | Cho phép nhiều attempt/period mà không risk watchdog trigger đè kết quả completed cũ                                     |
| 5 | **Timezone lock tại `server.js` line 6** trước mọi `require` | Log, Date, cron string đều nhất quán VN — tránh bug lệch 1 ngày do UTC drift                                             |
| 6 | **Weather refresh warm ngay khi start**              | UX tốt: user hit `/weather` không phải chờ tick đầu tiên                                                                 |
| 7 | **Retry backoff hàm mũ `[15′, 60′, 6h]`**            | Không spam GEE quota khi lỗi transient, đủ chậm để ops kịp nhìn log                                                     |
| 8 | **Job export handler public** (`runXxx()`)           | Dễ chạy thủ công qua `node -e` cho dev/ops mà không cần HTTP endpoint                                                    |

### 8.2 Điểm yếu — cần khắc phục

| # | Vấn đề                                                                                          | Rủi ro thực tế                                                                                                    | Ưu tiên |
|---|-------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|---------|
| A | **`satellite.job` orphan** — không được `server.js` start, nhưng vẫn tồn tại                    | Confuse dev mới: đọc code tưởng chạy nhưng không. Nếu ops bật nhầm sẽ tăng DB load                                | P1      |
| B | **Zero observability** — chỉ có `console.log`                                                   | Ops phải grep log để biết cron chạy chưa, không có alerting. Nếu container mất log không có history               | **P0**  |
| C | **Không có metrics / SLA tracking**                                                             | Không biết bao lâu 1 job chạy, tỷ lệ success/fail theo tuần, giờ nào peak                                          | P1      |
| D | **Retry limit hard-coded 3 lần**                                                                | Tuần đầu triển khai có thể cần cao hơn; forest classification quá 3 fail → chờ tháng sau (30 ngày data gap)      | P2      |
| E | **Không có "circuit breaker"**                                                                  | GEE hoàn toàn down 1h → job vẫn thử liên tục → burn quota, log noise                                              | P1      |
| F | **`analysis-retention` không có priority**                                                      | Batch=20 xoá theo `analysis_date < NOW - 90d` — snapshot lỗi lâu sẽ được xoá cuối cùng dù chiếm disk              | P2      |
| G | **`notification-cleanup` cứng 90d/60d cho mọi user**                                            | User admin cần lưu lâu hơn; user Zalo có thể chỉ cần 7d — không có config per-role                                | P2      |
| H | **Weather cache TTL cứng 1h**                                                                   | Bão / hạn hán nặng cần refresh 15′; ngày bình thường 3h cũng đủ — không adaptive                                  | P2      |
| I | **Advisory lock là SPOF logic**                                                                 | Nếu node giữ lock crash NHƯNG DB connection chưa timeout (60s TCP keepalive) → không node nào start cron          | P1      |
| J | **`FIRE_RISK_ACTIVE_RUN_MAX_AGE_MS = 45′` cứng**                                                | Pipeline v5 tương lai có thể lâu hơn 45′ → job bị mark stale sai → duplicate run                                  | P2      |
| K | **Không có "dry-run" mode** cho retention job                                                   | Sysadmin không thể xem "sẽ xoá gì" trước khi thực sự xoá                                                          | P2      |
| L | **Không có alerting khi job fail retry limit**                                                  | Fire-risk fail 3 lần liên tiếp → ngày đó không có bản tin → không ai biết đến khi user complain                    | **P0**  |
| M | **`memory-monitor` chỉ log — không tự action**                                                  | RSS > 1.5GB nhưng không auto-throttle GEE queue hay kill child process nào → OOM crash cả runtime                | P1      |
| N | **Timezone hard-coded VN**                                                                      | Nếu tương lai deploy cho tỉnh khác → phải rebuild image; nên đọc từ DB config                                     | P3      |
| O | **`weather.job` không rate-limit gọi OpenWeather**                                              | Free tier OpenWeather 60 call/min — nếu 24 tick × 65 điểm wind grid liên tiếp gọi thì có thể vượt                | P1      |

---

## 9. Kế hoạch cải thiện (roadmap)

### 9.1 P0 — Trong 2 tuần tới (blocking cho production stability)

#### 9.1.1 Structured logging + Log aggregation
- **Vấn đề**: `console.log` free-form không parse được, mất log khi container restart
- **Đề xuất**:
  - Thay `console.log/warn/error` bằng logger có structured JSON (pino hoặc winston)
  - Field bắt buộc: `ts`, `level`, `job`, `event`, `duration_ms`, `error.code`, `error.stack`
  - Ship về Loki/Elasticsearch qua Promtail/Filebeat
  - Log correlation ID: mỗi job run gắn `jobRunId=<uuid>` xuyên suốt các step
- **Effort**: 2-3 ngày (1 dev)
- **Non-goal**: chưa cần OpenTelemetry traces — log đủ dùng giai đoạn đầu

#### 9.1.2 Alerting khi job fail hoặc miss tick
- **Vấn đề**: Fire-risk fail 3 lần → không có bản tin trong ngày → không ai biết
- **Đề xuất**:
  - Thêm hook `onTerminalFailure(job, error)` gọi vào `notification.service` với channel `admin_ops`
  - Alerting theo 3 tầng:
    - **Warning**: 1 attempt fail → notification in-app cho admin
    - **Error**: retry limit reached → email + Zalo group ops
    - **Critical**: cron miss tick > 2× cycle (fire miss 12h, forest miss 3 ngày) → SMS oncall
  - Optional: publish sang Prometheus Alertmanager nếu team có sẵn
- **Effort**: 3-4 ngày
- **Phụ thuộc**: cần có channel ops (Zalo bot hoặc SMS gateway)

### 9.2 P1 — Trong 1-2 tháng (nâng cao độ tin cậy)

#### 9.2.1 Metrics + Dashboard
- Expose `/api/v1/internal/jobs/stats` (chỉ super-admin):
  ```json
  {
    "fire-risk": {
      "lastRun": {"date": "2026-08-06", "status": "published", "elapsed_ms": 421000},
      "lastFailure": null,
      "next_scheduled": "2026-08-07T06:00:00+07:00",
      "runs_last_7d": {"success": 6, "failed": 1, "skipped": 0},
      "avg_duration_ms": 385000
    }
  }
  ```
- Grafana dashboard: 1 row/job × (success rate, avg duration, last run age, active flag)
- Trigger từ metrics store (Postgres bảng `job_run_history`) — không cần Prometheus giai đoạn đầu
- **Effort**: 5-7 ngày (tạo bảng history + agg query + UI)

#### 9.2.2 Circuit breaker cho GEE
- Nếu GEE fail liên tiếp ≥ 5 request trong 10′ → mở circuit 15′
- Trong 15′ đó: mọi cron GEE bỏ qua tick + log `circuit_open`
- Sau 15′: half-open — thử 1 request, nếu OK → close
- Áp cho: fire-risk analysis, forest classification, satellite on-demand
- **Effort**: 3-4 ngày (thư viện `opossum` hoặc custom trong `queues/gee-task.queue.js`)

#### 9.2.3 Auto-throttle từ memory-monitor
- Khi RSS > CRITICAL: gọi `geeTaskQueue.pause()` — dừng nhận job mới nhưng để job đang chạy hoàn tất
- Khi RSS trở lại < WARN sau cooldown 3′ → `resume()`
- Khi RSS > CRITICAL × 1.2 (VD 1.8GB): kill child process đang chạy GEE
- **Effort**: 2 ngày (queue đã có `stop()/start()`, cần thêm `pause()/resume()`)

#### 9.2.4 Advisory lock heartbeat
- Chống SPOF khi node giữ lock crash im lặng
- Đề xuất:
  - Thêm bảng `worker_heartbeat(node_id, updated_at)` — node giữ lock UPDATE mỗi 30s
  - Khi node khác thấy `updated_at < NOW - 90s` → gọi `pg_advisory_unlock` cưỡng bức + retry lock
- **Effort**: 2-3 ngày
- **Rủi ro**: sai heartbeat threshold → 2 node cùng chạy cron (double-fire) — nên set 3× interval

#### 9.2.5 OpenWeather rate limit + circuit breaker
- Wrap `openweather.client.js` bằng `p-throttle` (max 55 req/min để chừa margin)
- Nếu 429/500 → không upsert cache, giữ cache cũ với flag `stale=true`
- **Effort**: 1 ngày

#### 9.2.6 Xử lý dứt điểm `satellite.job`
Chọn 1:
- **A**: Xoá file + xoá reference — kết luận không cần
- **B**: Import vào `server.js` + document là "poll các satellite publish thủ công"
- Đề xuất **B** vì `POST /satellite/publish` hiện tại chạy inline, nếu server chết giữa lúc export chưa xong → không có ai harvest → cần poll bù
- **Effort**: 1 ngày (1 dòng import + review)

### 9.3 P2 — 3-6 tháng (chất lượng vận hành)

#### 9.3.1 Retention job thông minh hơn
- Priority score = `f(snapshot_status, disk_bytes, is_referenced_by_map_layer)`
- Xoá theo score DESC thay vì `analysis_date ASC` — dọn "worst offenders" trước
- Thêm `--dry-run` flag: `runCleanup({ dryRun: true })` → return `{ toDelete: [...], estimatedFreeBytes }`
- **Effort**: 3-4 ngày

#### 9.3.2 Config động cho retention/notification
- Move `FIRE_RISK_RETENTION_DAYS`, `NOTIFICATION_RETENTION_DAYS` từ env → bảng `system_config`
- Admin UI chỉnh runtime (không phải rebuild)
- Cache 5′ trong process, invalidate qua pub/sub Postgres LISTEN/NOTIFY
- **Effort**: 5-7 ngày

#### 9.3.3 Adaptive weather refresh
- Interval mặc định 60′; giảm xuống 15′ khi:
  - Có cảnh báo bão trong 24h tới (đọc từ OpenWeather alerts API)
  - Đang trong mùa khô (Mar-Apr) VÀ fire-risk snapshot có level ≥ 4
- **Effort**: 3-4 ngày

#### 9.3.4 Dry-run + audit trail
- Mọi retention/cleanup ghi vào bảng `audit_log(operation, target, deleted_at, deleted_by, restore_hint)`
- Retention giữ file MinIO 7 ngày trong bucket `trash/` trước khi thực xoá — hỗ trợ recovery
- **Effort**: 4-5 ngày

#### 9.3.5 Timezone theo config runtime
- Đọc từ bảng `system_config.default_timezone` khi khởi động
- Cho phép chạy cùng codebase ở tỉnh khác (Gia Lai, Đắk Lắk) không cần rebuild
- **Effort**: 2 ngày (chỉ cần thay 1 chỗ set `process.env.TZ`)

### 9.4 P3 — Long-term (kiến trúc)

- Migrate sang **BullMQ** (Redis-backed) nếu số job/task > 100/giờ → có UI (Bull Board), retry auto, delayed job
- Split `cronjob` thành **service riêng** (deployment unit riêng) → runtime HTTP không có node-cron code loaded → gọn RAM
- Thay advisory lock bằng **Redis SET NX + expire** → cluster > 3 nodes performant hơn

---

## 10. Nguyên tắc khi triển khai roadmap

1. **Không phá bỏ pattern hiện có nếu chưa có metric chứng minh**. VD: đừng migrate BullMQ khi log chưa đủ để prove số job/giờ.
2. **P0 phải hoàn thành trước khi thêm feature mới**. Structured logging + alerting là **infra**, không phải "nice to have".
3. **Mỗi thay đổi cần có metric quan sát trước/sau** (bảng 9.2.1). Nếu không đo được → không biết cải thiện hay không.
4. **Backward-compatible envelope**: mọi env var mới phải có default an toàn, không require ops set → giữ deploy đơn giản.
5. **Feature flag** cho mọi thay đổi behavior — ví dụ `CIRCUIT_BREAKER_ENABLED=false` mặc định trong 2 tuần đầu, bật sau khi verify không false-positive.
