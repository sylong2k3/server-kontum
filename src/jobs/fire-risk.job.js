'use strict';

/**
 * Fire Risk Cron Job (EP-06).
 *
 * Tick 1 (daily, FIRE_RISK_CRON = '0 6 * * *' → 06:00 VN):
 *   → runAnalysis(today) — tính stats từ GEE, lưu DB
 *   → nếu GCS được cấu hình: submit raster export task
 *   → auto-enqueue raster-ingest (MinIO → GeoServer), back-link snapshot
 *
 * Tick 2 (mỗi 30 phút, để poll task GEE export đang chạy):
 *   → pollExports() — kiểm tra task COMPLETED → harvest GeoServer
 *
 * Recovery watchdog (v3 — 2026-07-24):
 *   Sau khi lifecycle.start() schedule cron, delay 60s rồi check DB; sau đó
 *   kiểm tra lại mỗi 5 phút:
 *     - Nếu snapshot mới nhất KHÔNG PHẢI hôm nay (VN) VÀ hiện đã QUÁ giờ cron
 *       → chạy runDailyAnalysis(today) ngay để bù (server có thể vừa restart
 *         sau khi miss tick sáng nay, hoặc node-cron thức dậy trễ).
 *     - Nếu hôm nay đã có snapshot ở bất kỳ trạng thái nào → skip để tránh
 *       chạy trùng/retry nóng khi GEE đang tính hoặc vừa thất bại.
 *   Toggle: FIRE_RISK_CATCHUP=false để tắt (default: true).
 *   Delay 60s: tránh chạy analysis lúc server chưa initialize xong (GEE, GDAL).
 *
 * Cleanup: ĐÃ BỎ. Chính sách hiện tại là "giữ toàn bộ lịch sử snapshot" —
 * không xoá bất kỳ hàng nào để đảm bảo audit + so sánh long-term. Nếu về sau
 * cần dọn, ưu tiên archive ra bảng history riêng thay vì DELETE.
 *
 * Debug: bật FIRE_RISK_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state transitions.
 */

const cron = require('node-cron');
const cfg  = require('../configs/fire-risk');
const svc  = require('../services/fire-risk.service');
const repo = require('../repositories/fire-risk.repository');

// Daily analysis cron: mặc định 06:00 sáng VN. Cron string đọc theo TZ đã set
// ở lifecycle.start (FIRE_RISK_CRON_TZ, mặc định Asia/Ho_Chi_Minh).
// Nếu env FIRE_RISK_CRON không set, mặc định "0 6 * * *" (06:00 VN).
const ANALYSIS_CRON = process.env.FIRE_RISK_CRON || cfg.CRON || '0 6 * * *';

// Poll export tasks every 30 min.
const POLL_CRON     = process.env.FIRE_RISK_POLL_CRON || '*/30 * * * *';

const DEBUG = process.env.FIRE_RISK_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FIRE-RISK-JOB] ${msg}`); };

// Catch-up: mặc định ON. FIRE_RISK_CATCHUP=false để tắt (VD staging không
// muốn tự chạy analysis khi restart pod).
const CATCHUP_ENABLED = process.env.FIRE_RISK_CATCHUP !== 'false';
const WATCHDOG_INTERVAL_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

// Parse "0 6 * * *" → { hour: 6, minute: 0 }. Trả null nếu không match dạng
// chuẩn ngày-thường (dùng cho catch-up quyết định "đã qua giờ cron chưa").
// Không handle cron phức tạp (step, list, range) — nếu user set expr đặc biệt,
// catch-up sẽ skip (không risk sai) và trong log warn.
function _parseCronHourMinute(expr) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const minute = Number(parts[0]);
    const hour   = Number(parts[1]);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    if (!Number.isInteger(hour)   || hour   < 0 || hour   > 23) return null;
    return { hour, minute };
}

let analysisTask = null;
let pollTask     = null;
let watchdogStartupTimer = null;
let watchdogInterval     = null;

// Overlap protection cho poll (30-min tick nhưng GCS→MinIO→GeoServer harvest
// đôi khi mất > 30 min khi có nhiều task cùng lúc).
let pollRunning     = false;
let analysisRunning = false;

// Counters — log định kỳ khi idle để chứng minh cron vẫn chạy.
let pollTicks     = 0;
let pollIdleTicks = 0;

// ── Handlers ──────────────────────────────────────────────────────────────────

function _getCronLocalTime(now = new Date()) {
    const cronTz = process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: cronTz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).reduce((a, p) => {
        if (p.type !== 'literal') a[p.type] = p.value;
        return a;
    }, {});

    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        timezone: cronTz,
    };
}

// Chuyển analysis_date (DATE trong Postgres → JS Date theo local tz của Node)
// về "YYYY-MM-DD" trong CRON timezone. Trước đây dùng `toISOString().slice(0,10)`
// → so sánh với `localDate` (đã format theo VN tz) luôn lệch 1 ngày do server
// Node ở VN (+7): pg-node parse DATE '2026-07-24' thành `2026-07-24T00:00+07`
// → ISO UTC = '2026-07-23T17:00Z' → slice = '2026-07-23'. Watchdog vì thế
// TRIGGER lại phân tích mỗi 5 phút dù snapshot hôm nay đã completed
// → spam GEE compute + broadcast notification tới 3 role.
function _toCronLocalDate(dateLike) {
    if (dateLike == null || dateLike === '') return null;
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (!Number.isFinite(d.getTime())) return null;
    return _getCronLocalTime(d).date;
}

const runDailyAnalysis = async (analysisDate) => {
    if (analysisRunning) {
        console.warn('[FIRE RISK] Daily analysis skipped: previous run still active');
        return;
    }
    analysisRunning = true;
    const t0 = Date.now();
    // Cron chạy lúc 06:00 VN, khi UTC vẫn có thể là ngày hôm trước. Luôn lấy
    // analysis_date theo timezone của cron thay vì Date#toISOString().
    const today = analysisDate || _getCronLocalTime().date;

    // Guard trước khi bắt đầu (migration 040 fix): nếu today đã có attempt
    // completed/published/exporting thì SKIP — tránh watchdog trigger run
    // đè lên kết quả đã có, đồng thời tránh spam GEE quota. Không dùng
    // getLatest() vì với schema mới có thể tồn tại attempt failed mới hơn
    // dòng completed cũ (retry sau khi thành công).
    try {
        if (await repo.hasCompletedAttempt(today)) {
            console.log(`[FIRE RISK] Daily analysis SKIP date=${today} — đã có completed attempt (migration 040 guard)`);
            return;
        }
    } catch (guardErr) {
        console.warn(`[FIRE RISK] Daily analysis guard failed (proceeding): ${guardErr.message}`);
    }

    console.log(`[FIRE RISK] Daily analysis START date=${today} gcs=${cfg.isGcsConfigured() ? 'on' : 'off'}`);
    try {
        const snap = await svc.runAnalysis(today);
        await repo.clearRetryState(snap.id);
        const riskDist = snap.province_summary?.riskLevelDist || {};
        console.log(
            `[FIRE RISK] Daily analysis DONE date=${today} status=${snap.status} ` +
            `snapshotId=${snap.id || '-'} ` +
            `riskLevel5Ha=${Math.round(riskDist[5] || 0)} riskLevel4Ha=${Math.round(riskDist[4] || 0)} ` +
            `gtZones=${snap.gt_zone_count ?? 0} gtPoints=${snap.gt_point_count ?? 0} ` +
            (snap.gee_task_id ? `geeTask=${snap.gee_task_id} ` : 'no export ') +
            `elapsed=${Date.now() - t0}ms`,
        );
        dbg(`riskDist=${JSON.stringify(riskDist)}`);
    } catch (err) {
        console.error(`[FIRE RISK] Daily analysis FAILED date=${today} elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        try {
            // Đếm tổng attempt failed cho date thay vì đọc retry_count từ 1 dòng
            // (migration 040: mỗi lần chạy tạo dòng mới, retry_count reset về 0).
            // failedCount đã bao gồm attempt vừa fail này → RETRY_DELAYS_MS[failedCount-1]
            // là khoảng chờ TỚI lần thứ (failedCount+1).
            const failedCount = await repo.countFailedAttempts(today);
            if (failedCount < RETRY_DELAYS_MS.length) {
                const failed = await repo.getLatest();
                const failedDate = _toCronLocalDate(failed?.analysis_date);
                if (failedDate === today && failed?.id) {
                    const scheduled = await repo.scheduleRetry(
                        failed.id,
                        RETRY_DELAYS_MS[failedCount - 1] || RETRY_DELAYS_MS[0],
                        err.message,
                    );
                    if (scheduled) {
                        console.warn(
                            `[FIRE RISK] retry ${failedCount}/${RETRY_DELAYS_MS.length} scheduled at ` +
                            `${new Date(scheduled.next_retry_at).toISOString()}`,
                        );
                    }
                }
            } else {
                console.error(`[FIRE RISK] retry limit reached for ${today} (${failedCount}/${RETRY_DELAYS_MS.length}) — dừng retry`);
            }
        } catch (retryErr) {
            console.error(`[FIRE RISK] failed to persist retry state: ${retryErr.message}`);
        }
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        analysisRunning = false;
    }
};

const runPollExports = async () => {
    if (pollRunning) {
        console.warn('[FIRE RISK] pollExports SKIPPED: previous run still active');
        return;
    }
    pollRunning = true;
    pollTicks  += 1;
    const t0    = Date.now();
    try {
        const pending = await repo.listExporting().catch(() => []);
        dbg(`pollExports tick ${pollTicks} — ${pending.length} exporting snapshot(s)`);

        await svc.pollExports();

        if (pending.length === 0) {
            pollIdleTicks += 1;
            if (pollIdleTicks % 24 === 0) {
                console.log(`[FIRE RISK] pollExports IDLE ${pollIdleTicks}/${pollTicks} ticks (no exports pending)`);
            }
        } else {
            console.log(`[FIRE RISK] pollExports DONE processed=${pending.length} elapsed=${Date.now() - t0}ms`);
        }
    } catch (err) {
        console.error(`[FIRE RISK] pollExports ERROR elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        pollRunning = false;
    }
};

// ── Catch-up on startup ─────────────────────────────────────────────────────
// Nếu server vừa restart sau khi miss cron tick sáng nay, chạy lại analysis
// cho ngày hôm nay. Guard bằng "đã qua giờ cron chưa" — trước 06:00 VN thì
// đợi tick tự nhiên, không chạy sớm.
async function _catchupIfNeeded() {
    if (!CATCHUP_ENABLED) {
        console.log('[FIRE RISK] catch-up disabled (FIRE_RISK_CATCHUP=false) — skip startup check');
        return;
    }

    const scheduled = _parseCronHourMinute(ANALYSIS_CRON);
    if (!scheduled) {
        console.warn(`[FIRE RISK] catch-up SKIPPED — không parse được cron "${ANALYSIS_CRON}" (expr đặc biệt)`);
        return;
    }
    const local = _getCronLocalTime();
    const cronTz = local.timezone;
    const localDate = local.date;
    const localHour = local.hour;
    const localMin  = local.minute;

    // "Đã qua giờ cron" — so sánh (hour, minute) hiện tại với scheduled.
    const passedCronTime =
        localHour > scheduled.hour ||
        (localHour === scheduled.hour && localMin >= scheduled.minute);

    if (!passedCronTime) {
        dbg(
            `recovery watchdog SKIP — chưa tới giờ cron. Now=${localDate} ${String(localHour).padStart(2,'0')}:${String(localMin).padStart(2,'0')} ` +
            `cron=${String(scheduled.hour).padStart(2,'0')}:${String(scheduled.minute).padStart(2,'0')} tz=${cronTz}`,
        );
        return;
    }

    // Đã qua giờ — kiểm tra 3 tình huống theo thứ tự ưu tiên (migration 040):
    //   1. Đã có attempt completed cho localDate → SKIP tuyệt đối (dù có attempt
    //      failed mới hơn thì kết quả trước vẫn còn giá trị).
    //   2. Tổng số attempt failed hôm nay >= RETRY_DELAYS_MS.length → SKIP —
    //      đã hết quota retry, không spam GEE nữa.
    //   3. Có attempt failed với next_retry_at đã qua → trigger retry.
    //   4. Chưa có snapshot nào cho localDate → trigger run mới.
    let hasCompleted = false;
    try { hasCompleted = await repo.hasCompletedAttempt(localDate); }
    catch (err) { console.warn(`[FIRE RISK] watchdog hasCompletedAttempt fail: ${err.message}`); }

    if (hasCompleted) {
        dbg(`recovery watchdog SKIP — có completed attempt cho ${localDate}`);
        return;
    }

    let failedCount = 0;
    try { failedCount = await repo.countFailedAttempts(localDate); }
    catch (err) { console.warn(`[FIRE RISK] watchdog countFailedAttempts fail: ${err.message}`); }

    if (failedCount >= RETRY_DELAYS_MS.length) {
        dbg(`recovery watchdog SKIP — retry limit reached (${failedCount}/${RETRY_DELAYS_MS.length}) cho ${localDate}`);
        return;
    }

    const latest = await repo.getLatest().catch((err) => {
        console.warn(`[FIRE RISK] recovery watchdog: getLatest failed: ${err.message}`);
        return null;
    });
    const latestDate = _toCronLocalDate(latest?.analysis_date);

    if (latestDate === localDate) {
        // Có snapshot hôm nay nhưng chưa completed. Nếu là computing → đợi.
        // Nếu failed + next_retry_at qua → retry.
        if (['pending', 'computing', 'exporting'].includes(latest.status)) {
            dbg(`recovery watchdog SKIP — snapshot ${localDate} đang ${latest.status} (id=${latest.id})`);
            return;
        }
        const retryDue = latest.status === 'failed'
            && latest.next_retry_at
            && new Date(latest.next_retry_at).getTime() <= Date.now();
        if (retryDue) {
            console.warn(`[FIRE RISK] recovery watchdog starting retry ${failedCount + 1}/${RETRY_DELAYS_MS.length} for ${localDate}`);
            runDailyAnalysis(localDate).catch((err) => {
                console.error(`[FIRE RISK] retry analysis error: ${err.message}`);
            });
            return;
        }
        dbg(`recovery watchdog SKIP — snapshot ${localDate} status=${latest.status} (chưa tới retry time)`);
        return;
    }

    console.log(
        `[FIRE RISK] recovery watchdog TRIGGER — daily cron may have been missed. ` +
        `latest=${latestDate || 'none'} today=${localDate} tz=${cronTz}. ` +
        `Chạy runAnalysis(${localDate}) ngay.`,
    );
    // Fire-and-forget — không chờ, không throw (analysis chạy vài phút, không
    // được block server startup).
    runDailyAnalysis(localDate).catch((err) => {
        console.error(`[FIRE RISK] recovery analysis error: ${err.message}`);
    });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (analysisTask) { return; }

    if (!cron.validate(ANALYSIS_CRON)) {
        console.warn(`[FIRE RISK] Invalid cron "${ANALYSIS_CRON}" — daily job not started`);
        return;
    }
    if (!cron.validate(POLL_CRON)) {
        console.warn(`[FIRE RISK] Invalid poll cron "${POLL_CRON}" — poll job not started`);
        return;
    }

    // Timezone: mặc định Asia/Ho_Chi_Minh — cron string "0 6 * * *" nghĩa là
    // 06:00 sáng VN thực. Override bằng FIRE_RISK_CRON_TZ nếu triển khai đa
    // region cần tz khác.
    const cronOpts = { timezone: process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh' };

    // node-cron v4 passes TaskContext to callbacks. Wrapping prevents that
    // object from being mistaken for an analysis date ("[object Object]").
    analysisTask = cron.schedule(ANALYSIS_CRON, () => runDailyAnalysis(), cronOpts);
    pollTask     = cron.schedule(POLL_CRON,     runPollExports,   cronOpts);

    const staleRunMaxAgeMs = Number(process.env.FIRE_RISK_ACTIVE_RUN_MAX_AGE_MS)
        || 45 * 60 * 1000;
    repo.failStaleActiveRuns(staleRunMaxAgeMs)
        .then((rows) => {
            if (rows.length > 0) {
                console.warn(
                    `[FIRE RISK] Đã đóng ${rows.length} snapshot bị gián đoạn: `
                    + rows.map((row) => `#${row.id}`).join(', '),
                );
            }
        })
        .catch((error) => {
            console.warn(`[FIRE RISK] Không thể dọn snapshot bị gián đoạn: ${error.message}`);
        });

    console.log(
        `[FIRE RISK] STARTED analysis="${ANALYSIS_CRON}" poll="${POLL_CRON}" ` +
        `timezone=${cronOpts.timezone} catchup=${CATCHUP_ENABLED ? 'on' : 'off'} ` +
        `gcsConfigured=${cfg.isGcsConfigured() ? 'yes' : 'NO — province GCS export skipped; district direct export enabled'} ` +
        `debug=${DEBUG} snapshot_retention=UNLIMITED (cleanup disabled)`,
    );
    console.log(`  ✓ Fire risk analysis job scheduled (${ANALYSIS_CRON} @ ${cronOpts.timezone})`);
    console.log(`  ✓ Fire risk export poll job scheduled (${POLL_CRON})`);

    // Watchdog dùng setInterval thay vì một cron khác: nếu event loop bị block,
    // timer sẽ chạy ngay sau khi được giải phóng và tự bù tick node-cron đã miss.
    const runWatchdog = () => {
        _catchupIfNeeded().catch((err) => {
            console.error(`[FIRE RISK] recovery watchdog error: ${err.message}`);
        });
    };
    if (CATCHUP_ENABLED) {
        watchdogStartupTimer = setTimeout(() => {
            runWatchdog();
            watchdogInterval = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
            watchdogInterval.unref?.();
        }, 60_000);
        watchdogStartupTimer.unref?.();
    }
};

const stop = () => {
    [analysisTask, pollTask].forEach((t) => { if (t) t.stop(); });
    if (watchdogStartupTimer) clearTimeout(watchdogStartupTimer);
    if (watchdogInterval) clearInterval(watchdogInterval);
    analysisTask = null;
    pollTask     = null;
    watchdogStartupTimer = null;
    watchdogInterval     = null;
    console.log(`[FIRE RISK] STOPPED — pollTicks=${pollTicks} pollIdle=${pollIdleTicks}`);
};

module.exports = { start, stop, runDailyAnalysis, runPollExports };
