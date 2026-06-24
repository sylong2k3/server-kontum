const ee = require("@google/earthengine");
const privateKey = require("../../ggeServiceKey.json");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

let isInitialized = false;
let initializationPromise = null;

function normalizeError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }

  const message =
    typeof error === "string"
      ? error
      : error?.message || error?.error?.message || fallbackMessage;
  const normalizedError = new Error(message);
  normalizedError.code = error?.code || error?.error?.code;
  normalizedError.status = error?.status || error?.response?.status;
  return normalizedError;
}

function isTransientError(error) {
  const code = error?.code || error?.errno;
  const status = error?.status || error?.response?.status;
  const message = String(error?.message || "").toLowerCase();

  return (
    TRANSIENT_ERROR_CODES.has(code) ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    message.includes("premature close") ||
    message.includes("socket hang up") ||
    message.includes("network")
  );
}

function authenticate() {
  return new Promise((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(
      privateKey,
      resolve,
      (error) => reject(normalizeError(error, "Earth Engine authentication failed")),
    );
  });
}

function initializeClient() {
  return new Promise((resolve, reject) => {
    ee.initialize(
      null,
      null,
      resolve,
      (error) => reject(normalizeError(error, "Earth Engine initialization failed")),
    );
  });
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function initializeWithRetry(maxAttempts, retryDelayMs) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await authenticate();
      await initializeClient();
      isInitialized = true;
      return;
    } catch (error) {
      const canRetry = attempt < maxAttempts && isTransientError(error);

      if (!canRetry) {
        throw error;
      }

      const waitMs = retryDelayMs * 2 ** (attempt - 1);
      console.warn(
        `Earth Engine tạm thời không kết nối được (${error.code || error.message}). ` +
          `Thử lại ${attempt + 1}/${maxAttempts} sau ${waitMs}ms.`,
      );
      await delay(waitMs);
    }
  }
}

function initializeEarthEngine(options = {}) {
  if (isInitialized) {
    return Promise.resolve();
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  const maxAttempts =
    Number.parseInt(options.maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs =
    Number.parseInt(options.retryDelayMs, 10) || DEFAULT_RETRY_DELAY_MS;

  initializationPromise = initializeWithRetry(maxAttempts, retryDelayMs).finally(
    () => {
      initializationPromise = null;
    },
  );

  return initializationPromise;
}

module.exports = {
  ee,
  initializeEarthEngine,
  isInitialized: () => isInitialized,
};