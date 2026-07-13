'use strict';

/**
 * A → Z stage logger for long-running GEE pipelines.
 *
 * Goal: khi Fire-Risk / Forest-Classification bị time-out, log này chỉ ra
 * chính xác BƯỚC nào đang treo (build graph vs. evaluate vs. reduceRegions
 * vs. classifier training) để có thể can thiệp trúng đích.
 *
 * Ghi ra console.log tuần tự dạng:
 *   [FIRE-RISK][A][ 0.0s]   ▶ Init Earth Engine
 *   [FIRE-RISK][A][ 0.6s]   ✓ done (612 ms)
 *   [FIRE-RISK][B][ 0.6s]   ▶ Load Kon Tum region + districts
 *   [FIRE-RISK][B][ 0.7s]   ✓ done (48 ms)
 *   [FIRE-RISK][C][ 0.7s]   ▶ Build predictor image (lazy)
 *   [FIRE-RISK][C][ 0.8s]   ✓ done (37 ms) — 18 predictor bands
 *   [FIRE-RISK][D][ 0.8s]   ▶ EVALUATE province summary reduceRegion
 *   [FIRE-RISK][D][65.2s]   ✗ FAILED after 64.4s: GEE evaluate() timeout after 60000ms
 *
 * Cách dùng:
 *
 *   const { makeStageLogger } = require('../utils/stage-logger.util');
 *   const log = makeStageLogger('FIRE-RISK', { correlationId: snapshot.id });
 *   const region = await log.run('Load Kon Tum region', () => Promise.resolve(getKonTumRegion()));
 *   const stats  = await log.run('EVALUATE province summary', () => eeEval(reduced),
 *       { note: 'reduceRegion scale=500 tileScale=8' });
 *
 * Có thể tắt log qua env `PIPELINE_STAGE_LOG=off`.
 */

const ENABLED = process.env.PIPELINE_STAGE_LOG !== 'off';

function stageCode(idx) {
    if (idx < 26) return String.fromCharCode(65 + idx);
    // AA, AB, AC … khi vượt quá 26 stage.
    const first  = String.fromCharCode(65 + Math.floor(idx / 26) - 1);
    const second = String.fromCharCode(65 + (idx % 26));
    return first + second;
}

function fmtRel(t0) {
    const secs = (Date.now() - t0) / 1000;
    return secs.toFixed(1).padStart(5, ' ') + 's';
}

function fmtDur(ms) {
    if (ms < 1000)   return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60_000).toFixed(2)}m`;
}

/**
 * Tạo một stage-logger cho một pipeline / request cụ thể.
 *
 * @param {string} pipelineName - vd 'FIRE-RISK', 'FOREST-CLS'
 * @param {object} [opts]
 * @param {string|number} [opts.correlationId] - id snapshot hoặc request để tra cứu
 * @returns {{
 *   run:   (desc: string, fn: () => any,   opts?: { note?: string }) => Promise<any>,
 *   begin: (desc: string, opts?: { note?: string }) => { done: (note?: string) => void, fail: (err: any) => void },
 *   mark:  (desc: string, note?: string) => void,
 *   summary: () => void
 * }}
 */
function makeStageLogger(pipelineName, opts = {}) {
    const tag  = opts.correlationId != null
        ? `${pipelineName}#${opts.correlationId}`
        : pipelineName;
    const t0   = Date.now();
    let idx    = 0;

    if (!ENABLED) {
        const noop = () => {};
        return {
            run: async (_d, fn) => fn(),
            begin: () => ({ done: noop, fail: noop }),
            mark: noop,
            summary: noop,
        };
    }

    const stages = [];

    function begin(description, o = {}) {
        const code   = stageCode(idx++);
        const stageT = Date.now();
        const note   = o.note ? ` — ${o.note}` : '';
        console.log(
            `[${tag}][${code}][${fmtRel(t0)}]   ▶ ${description}${note}`,
        );
        const record = { code, description, start: stageT, ok: null };
        stages.push(record);
        return {
            done(extra) {
                const dur = Date.now() - stageT;
                record.ok  = true;
                record.dur = dur;
                const suffix = extra ? ` — ${extra}` : '';
                console.log(
                    `[${tag}][${code}][${fmtRel(t0)}]   ✓ done (${fmtDur(dur)})${suffix}`,
                );
            },
            fail(err) {
                const dur = Date.now() - stageT;
                record.ok  = false;
                record.dur = dur;
                const msg = err?.message || String(err);
                console.error(
                    `[${tag}][${code}][${fmtRel(t0)}]   ✗ FAILED after ${fmtDur(dur)}: ${msg}`,
                );
            },
        };
    }

    async function run(description, fn, o = {}) {
        const marker = begin(description, o);
        try {
            const out = await fn();
            marker.done(o.doneNote);
            return out;
        } catch (err) {
            marker.fail(err);
            throw err;
        }
    }

    function mark(description, note) {
        const code = stageCode(idx++);
        const suffix = note ? ` — ${note}` : '';
        console.log(
            `[${tag}][${code}][${fmtRel(t0)}]   • ${description}${suffix}`,
        );
        stages.push({ code, description, start: Date.now(), ok: true, dur: 0, note });
    }

    function summary() {
        const total = Date.now() - t0;
        const ok    = stages.filter((s) => s.ok !== false).length;
        const fail  = stages.filter((s) => s.ok === false).length;
        console.log(
            `[${tag}][SUM][${fmtRel(t0)}]   Σ ${stages.length} stage(s), ${ok} ok, ${fail} failed, tổng ${fmtDur(total)}`,
        );
    }

    return { run, begin, mark, summary };
}

module.exports = { makeStageLogger };
