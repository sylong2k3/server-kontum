const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    min: parseInt(process.env.DB_POOL_MIN, 10) || 5,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 25,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT_MS, 10) || 10000,
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT, 10) || 30000,
    query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT, 10) || 30000,
    options: '-c search_path=public,core,auth,gis,fire,cms,field,raster',
});

pool.on('error', (err) => {
    console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.DB_SLOW_QUERY_MS, 10) || 500;

const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        if (duration > SLOW_QUERY_THRESHOLD_MS) {
            const shortSql = text.replace(/\s+/g, ' ').substring(0, 200);
            console.warn(`[SLOW QUERY] ${duration}ms | rows=${res.rowCount} | ${shortSql}`);
        }
        return res;
    } catch (err) {
        const duration = Date.now() - start;
        const shortSql = text.replace(/\s+/g, ' ').substring(0, 150);
        const detail = err.message || err.errors?.map((e) => e.message).join('; ') || err.code || String(err);
        console.error(`[DB ERROR] ${duration}ms | code=${err.code || '-'} | ${detail} | ${shortSql}`);
        throw err;
    }
};

const getClient = async () => {
    return await pool.connect();
};

const POOL_MONITOR_INTERVAL_MS = parseInt(process.env.DB_POOL_MONITOR_MS, 10) || 30000;
let poolMonitorId = null;

const startPoolMonitor = () => {
    if (poolMonitorId) {return;}

    poolMonitorId = setInterval(() => {
        const { totalCount, idleCount, waitingCount } = pool;
        const activeCount = totalCount - idleCount;

        if (waitingCount > 0) {
            console.warn(
                `[DB Pool PRESSURE] waiting=${waitingCount} active=${activeCount} idle=${idleCount} total=${totalCount}/${pool.options.max}`
            );
        }

        if (totalCount > 0 && activeCount / pool.options.max > 0.8) {
            console.warn(
                `[DB Pool HIGH USAGE] ${Math.round((activeCount / pool.options.max) * 100)}% | active=${activeCount} max=${pool.options.max}`
            );
        }
    }, POOL_MONITOR_INTERVAL_MS);

    if (typeof poolMonitorId.unref === 'function') {
        poolMonitorId.unref();
    }
};

const stopPoolMonitor = () => {
    if (poolMonitorId) {
        clearInterval(poolMonitorId);
        poolMonitorId = null;
    }
};

startPoolMonitor();

module.exports = {
    pool,
    query,
    getClient,
    startPoolMonitor,
    stopPoolMonitor,
};
