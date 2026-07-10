const WebSocket = require('ws');
const TokenManager = require('../utils/tokenManager.util');

const clients = new Set();
const MAX_CHANNELS = parseInt(process.env.WS_MAX_CHANNELS, 10) || 20;
const MAX_MESSAGES_PER_MINUTE = parseInt(process.env.WS_MAX_MESSAGES_PER_MINUTE, 10) || 60;
const MAX_CHANNEL_LENGTH = 100;
let wss = null;
let upgradeHandler = null;

function createMessage(event, data) {
    return JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString(),
    });
}

function safelySend(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {return false;}

    try {
        ws.send(message);
        return true;
    } catch (_) {
        return false;
    }
}

function cleanupClient(ws) {
    clients.delete(ws);
}

function setupSocketState(ws, req) {
    const userId = req._wsUser ? String(req._wsUser.userId) : null;

    ws._wsState = {
        userId,
        role: req._wsUser?.role || null,
        channels: new Set(),
        messageCount: 0,
        messageWindowStartedAt: Date.now(),
    };

    clients.add(ws);

    safelySend(ws, createMessage('connected', {
        userId,
        message: 'WebSocket connected',
    }));

    ws.on('message', (rawPayload) => {
        try {
            const now = Date.now();
            if (now - ws._wsState.messageWindowStartedAt >= 60_000) {
                ws._wsState.messageWindowStartedAt = now;
                ws._wsState.messageCount = 0;
            }
            ws._wsState.messageCount += 1;
            if (ws._wsState.messageCount > MAX_MESSAGES_PER_MINUTE) {
                ws.close(1008, 'Message rate exceeded');
                return;
            }

            const payload = Buffer.isBuffer(rawPayload)
                ? rawPayload.toString('utf8')
                : String(rawPayload);
            const message = JSON.parse(payload);

            if (message.action === 'subscribe' && Array.isArray(message.channels)) {
                const requested = message.channels
                    .map((ch) => String(ch).trim())
                    .filter((ch) => ch && ch.length <= MAX_CHANNEL_LENGTH)
                    .filter((ch) => !ch.startsWith('role:') || ch === `role:${ws._wsState.role}`);

                for (const channel of requested) {
                    if (ws._wsState.channels.size >= MAX_CHANNELS) { break; }
                    ws._wsState.channels.add(channel);
                }

                safelySend(ws, createMessage('subscribed', {
                    channels: Array.from(ws._wsState.channels),
                }));
            }
        } catch (_) {
            safelySend(ws, createMessage('error', {
                message: 'Invalid WebSocket message format',
            }));
        }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
}

function initWebSocketServer(server, options = {}) {
    const path = options.path || '/ws';

    if (wss) {return;}

    wss = new WebSocket.Server({
        noServer: true,
        maxPayload: parseInt(process.env.WS_MAX_PAYLOAD_BYTES, 10) || 64 * 1024,
    });

    upgradeHandler = async (req, socket, head) => {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);

        if (requestUrl.pathname !== path) {
            socket.destroy();
            return;
        }

        const allowedOrigins = (process.env.CORS_ORIGINS || '')
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin && origin !== '*');
        const origin = req.headers.origin;
        if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }

        const authorization = req.headers.authorization || '';
        const [scheme, token] = authorization.split(' ');
        if (scheme !== 'Bearer' || !token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        try {
            req._wsUser = TokenManager.verifyAccessToken(token);
        } catch (_) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            setupSocketState(ws, req);
        });
    };

    server.on('upgrade', upgradeHandler);
}

function broadcast(event, data) {
    const message = createMessage(event, data);
    clients.forEach((ws) => {
        if (!safelySend(ws, message)) {clients.delete(ws);}
    });
}

function notifyUser(userId, event, data) {
    const message = createMessage(event, data);
    clients.forEach((ws) => {
        if (ws._wsState?.userId === String(userId)) {
            if (!safelySend(ws, message)) {clients.delete(ws);}
        }
    });
}

function notifyChannel(channel, event, data) {
    const message = createMessage(event, data);
    clients.forEach((ws) => {
        if (ws._wsState?.channels?.has(channel)) {
            if (!safelySend(ws, message)) {clients.delete(ws);}
        }
    });
}

function closeWebSocketServer() {
    clients.forEach((ws) => {
        try { ws.close(1000, 'Server shutting down'); } catch (_) { /* no-op */ }
    });

    clients.clear();

    if (wss) {
        wss.close();
        wss = null;
    }
}

module.exports = {
    initWebSocketServer,
    closeWebSocketServer,
    broadcast,
    notifyUser,
    notifyChannel,
};
