'use strict';

const fs = require('fs');
const path = require('path');

const cfg = require('../configs/analysis-retention');
const rasterCfg = require('../configs/raster-ingest');
const repo = require('../repositories/analysis-retention.repository');
const minio = require('./minio.service');
const geoserver = require('../utils/geoserver.client');

const SAFE_STORE_RE = /^[a-zA-Z0-9_-]+$/;

const isNotFound = (error) =>
    error?.status === 404 ||
    error?.code === 'NotFound' ||
    /not found|no such/i.test(String(error?.message || ''));

const uniqueNumbers = (values) =>
    Array.from(new Set(values.map(Number).filter(Number.isSafeInteger)));

const removeGeoServerArtifact = async ({ geoserver_store: store, geoserver_layer: layer }) => {
    try {
        if (store) {
            if (!SAFE_STORE_RE.test(store)) {
                throw new Error(`Unsafe GeoServer store name: ${store}`);
            }
            await geoserver.deleteCoverageStore(store);
        } else if (layer) {
            await geoserver.unpublishLayer(layer);
        }
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
};

const removeMinioArtifact = async ({ minio_bucket: bucket, minio_key: objectKey }) => {
    if (!objectKey) return;
    try {
        await minio.removeObject(objectKey, bucket || rasterCfg.MINIO_BUCKET);
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
};

const removeLocalArtifact = async ({ geoserver_store: store }) => {
    if (!store || !process.env.GEOSERVER_DATA_DIR) return;
    if (!SAFE_STORE_RE.test(store)) {
        throw new Error(`Unsafe local raster store name: ${store}`);
    }
    const rasterDir = path.resolve(process.env.GEOSERVER_DATA_DIR, 'gee-rasters');
    const filePath = path.resolve(rasterDir, `${store}.tif`);
    if (path.dirname(filePath) !== rasterDir) {
        throw new Error(`Raster cleanup path escaped configured directory: ${filePath}`);
    }
    await fs.promises.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
    });
};

const cleanupCandidate = async (kind, candidate) => {
    const artifacts = await repo.listArtifacts(kind, candidate.id);
    const activeJob = artifacts.find(
        (item) =>
            item.job_id &&
            !['completed', 'failed', 'cancelled'].includes(item.job_status),
    );
    if (activeJob) {
        throw new Error(
            `Raster job #${activeJob.job_id} is still ${activeJob.job_status}.`,
        );
    }
    const seenStores = new Set();
    const seenObjects = new Set();

    for (const artifact of artifacts) {
        const storeKey = artifact.geoserver_store || artifact.geoserver_layer;
        if (storeKey && !seenStores.has(storeKey)) {
            await removeGeoServerArtifact(artifact);
            await removeLocalArtifact(artifact);
            seenStores.add(storeKey);
        }

        const objectKey = artifact.minio_key
            ? `${artifact.minio_bucket || rasterCfg.MINIO_BUCKET}/${artifact.minio_key}`
            : null;
        if (objectKey && !seenObjects.has(objectKey)) {
            await removeMinioArtifact(artifact);
            seenObjects.add(objectKey);
        }
    }

    const deleted = await repo.deleteSnapshot({
        kind,
        snapshotId: candidate.id,
        jobIds: uniqueNumbers(artifacts.map((item) => item.job_id)),
        layerIds: uniqueNumbers(artifacts.map((item) => item.layer_id)),
    });
    return {
        deleted,
        artifacts: Math.max(seenStores.size, seenObjects.size),
    };
};

const cleanupKind = async (kind, candidates) => {
    const result = { scanned: candidates.length, deleted: 0, failed: 0, artifacts: 0 };
    for (const candidate of candidates) {
        try {
            const cleaned = await cleanupCandidate(kind, candidate);
            if (cleaned.deleted) result.deleted += 1;
            result.artifacts += cleaned.artifacts;
        } catch (error) {
            result.failed += 1;
            console.warn(
                `[ANALYSIS-RETENTION] giữ lại ${kind} snapshot=#${candidate.id} ` +
                `period=${candidate.period}: ${error.message}`,
            );
        }
    }
    return result;
};

const runCleanup = async () => {
    const [fireCandidates, forestCandidates] = await Promise.all([
        repo.listFireCandidates({
            retentionDays: cfg.FIRE_RISK_DAYS,
            limit: cfg.BATCH_SIZE,
        }),
        repo.listForestCandidates({
            retentionMonths: cfg.FOREST_CLASSIFICATION_MONTHS,
            limit: cfg.BATCH_SIZE,
        }),
    ]);

    const fire = await cleanupKind('fire-risk', fireCandidates);
    const forest = await cleanupKind('forest-classification', forestCandidates);
    return { fire, forest };
};

module.exports = {
    runCleanup,
};
