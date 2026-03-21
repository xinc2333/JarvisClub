const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");
const { getRuntimeConfig } = require("./config");
const {
  validateApiKey,
  bindApiKeyToOpenClaw,
  resolveOrCreateOpenClawId,
  ensureOpenClawExists,
  markOpenClawWsConnected,
  markOpenClawWsDisconnected,
  buildTickInput,
  applyTickOutput,
  recordDiagnosticEvent,
} = require("./platformStore");
const { inspectTickSafety } = require("./safetyGuardrails");

const runtimeConfig = getRuntimeConfig();

class WsManager {
  constructor() {
    this.wss = null;
    this.connections = new Map(); // lobsterId -> { ws, keyRow, lobsterId }
    this.pendingTicks = new Map(); // tickId -> { resolve, reject, timer }
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/ws/agent") {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws);
      });
    });
  }

  handleConnection(ws) {
    let authenticated = false;
    let lobsterId = null;

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, "Auth timeout");
      }
    }, runtimeConfig.wsAuthTimeoutMs);

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, runtimeConfig.wsPingIntervalMs);

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      if (!authenticated) {
        if (msg.type === "auth") {
          await this._handleAuth(ws, msg, authTimer, (id) => {
            authenticated = true;
            lobsterId = id;
          });
        } else {
          ws.send(JSON.stringify({ type: "error", error: "Must authenticate first" }));
        }
        return;
      }

      if (msg.type === "tick_response") {
        this._handleTickResponse(msg);
      } else if (msg.type === "message_ack") {
        // agent acknowledged a message, no-op for now
      }
    });

    ws.on("close", async () => {
      clearTimeout(authTimer);
      clearInterval(pingTimer);
      if (lobsterId) {
        this.connections.delete(lobsterId);
        try {
          await markOpenClawWsDisconnected(lobsterId);
        } catch (err) {
          console.warn(`[wsManager] failed to mark disconnected: ${err.message}`);
        }
        this.emit("agent_disconnected", { lobsterId });
      }
    });

    ws.on("error", (err) => {
      console.warn(`[wsManager] ws error: ${err.message}`);
    });
  }

  async _handleAuth(ws, msg, authTimer, onSuccess) {
    const apiKey = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
    const openClawKey = typeof msg.openClawKey === "string" ? msg.openClawKey.trim() : "";
    const displayName = typeof msg.displayName === "string" ? msg.displayName.trim() : "";
    const identitySummary = typeof msg.identitySummary === "string" ? msg.identitySummary.trim() : "";

    if (!apiKey) {
      ws.send(JSON.stringify({ type: "auth_error", error: "Missing apiKey" }));
      ws.close(4002, "Missing apiKey");
      return;
    }

    const keyRow = await validateApiKey(apiKey);
    if (!keyRow) {
      ws.send(JSON.stringify({ type: "auth_error", error: "Invalid or revoked API key" }));
      ws.close(4003, "Invalid key");
      return;
    }

    clearTimeout(authTimer);

    let lobsterId;
    if (keyRow.lobster_id) {
      lobsterId = keyRow.lobster_id;
    } else {
      const resolveKey = openClawKey || `apikey_${keyRow.id}`;
      lobsterId = await resolveOrCreateOpenClawId({
        lobsterKey: resolveKey,
        ownerUserId: keyRow.user_id,
        displayName: displayName || "钳钳",
        identitySummary: identitySummary || "一只通过 API Key 接入的 OpenClaw。",
        claimedAt: new Date().toISOString(),
      });
      await bindApiKeyToOpenClaw(keyRow.id, lobsterId);
    }

    // Close existing connection for this lobster if any
    const existing = this.connections.get(lobsterId);
    if (existing) {
      existing.ws.close(4010, "Replaced by new connection");
    }

    this.connections.set(lobsterId, { ws, keyRow, lobsterId });
    await markOpenClawWsConnected(lobsterId);

    ws.send(JSON.stringify({
      type: "auth_ok",
      lobsterId,
      openClawId: lobsterId,
      schedulerMode: "ws_connected",
      tickIntervalMs: runtimeConfig.tickIntervalMs,
    }));

    onSuccess(lobsterId);
    this.emit("agent_connected", { lobsterId });
  }

  _handleTickResponse(msg) {
    const tickId = msg.tickId;
    const pending = this.pendingTicks.get(tickId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTicks.delete(tickId);
    pending.resolve(msg);
  }

  isConnected(lobsterId) {
    const conn = this.connections.get(lobsterId);
    return conn && conn.ws.readyState === conn.ws.OPEN;
  }

  async sendTickRequest(lobsterId, tickInput) {
    const conn = this.connections.get(lobsterId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      return null;
    }

    const tickId = randomUUID();
    const request = {
      type: "tick_request",
      tickId,
      context: {
        profile: tickInput.profile,
        runtimeState: tickInput.runtimeState,
        currentSpace: tickInput.currentSpace,
        nearbyOpenClaws: tickInput.nearbyOpenClaws,
        availableActivities: tickInput.availableActivities,
        recentEvents: tickInput.recentEvents,
        recentRelationships: tickInput.recentRelationships,
      },
      now: tickInput.now,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTicks.delete(tickId);
        reject(new Error(`Tick ${tickId} timed out after ${runtimeConfig.wsTickTimeoutMs}ms`));
      }, runtimeConfig.wsTickTimeoutMs);

      this.pendingTicks.set(tickId, { resolve, reject, timer });

      try {
        conn.ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pendingTicks.delete(tickId);
        reject(err);
      }
    });
  }

  sendMessage(lobsterId, content, metadata = {}) {
    const conn = this.connections.get(lobsterId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      return false;
    }

    conn.ws.send(JSON.stringify({
      type: "message",
      messageId: randomUUID(),
      content,
      metadata,
    }));
    return true;
  }

  disconnectByLobsterId(lobsterId, reason = "Disconnected by platform") {
    const conn = this.connections.get(lobsterId);
    if (conn) {
      conn.ws.close(4020, reason);
    }
  }

  getConnectedIds() {
    const ids = [];
    for (const [lobsterId, conn] of this.connections) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        ids.push(lobsterId);
      }
    }
    return ids;
  }

  // Simple event emitter (minimal, no dependency)
  _listeners = {};

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  emit(event, data) {
    for (const fn of this._listeners[event] || []) {
      try { fn(data); } catch (e) { console.warn(`[wsManager] listener error: ${e.message}`); }
    }
  }
}

module.exports = { WsManager };
