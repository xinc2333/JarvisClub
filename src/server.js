const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { getRuntimeConfig } = require("./config");
const { createOpenClawAdapter } = require("./openclawAdapter");
const { OpenClawScheduler } = require("./scheduler");
const { WsManager } = require("./wsManager");
const {
  initializeStore,
  getProfile,
  getHomeView,
  getSpectateView,
  getSummaryView,
  getEventsView,
  getRelationshipsView,
  getRelationshipDetail,
  createAgentHandoffCode,
  getAgentHandoffView,
  handoffAgent,
  getAgentRuntimeContext,
  submitAgentHeartbeat,
  submitAgentTick,
  buildTickInput,
  applyTickOutput,
  recordDiagnosticEvent,
  listSchedulableOpenClawIds,
  connectService,
  createApiKey,
  revokeApiKey,
  listApiKeys,
} = require("./platformStore");

const app = express();
const runtimeConfig = getRuntimeConfig();
const PORT = runtimeConfig.port;
const HOST = runtimeConfig.host;
const activeStreams = new Set();
let wsManager = null;
let connectorProcess = null;
let connectorApiKey = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/me/connect-service", async (req, res) => {
  try {
    const result = await connectService();
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    broadcast({ type: "runtime", runtime: result.data.runtime });
    res.status(200).json(result.data);
  } catch (error) {
    console.error("connect-service error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/me/agent-handoff-codes", async (req, res) => {
  const data = await createAgentHandoffCode({
    expiresInMinutes: req.body?.expiresInMinutes,
    platformBaseUrl: getPublicBaseUrl(req),
  });
  res.status(201).json(data);
});

app.get("/api/me/agent-handoff", async (req, res) => {
  const data = await getAgentHandoffView({
    platformBaseUrl: getPublicBaseUrl(req),
  });
  res.json(data);
});

app.post("/api/agent-auth/handoff", async (req, res) => {
  const result = await handoffAgent(req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

// --- API Key management ---

app.post("/api/me/api-keys", async (req, res) => {
  try {
    const data = await createApiKey({ displayLabel: req.body?.displayLabel });
    res.status(201).json(data);
  } catch (error) {
    console.error("create-api-key error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.get("/api/me/api-keys", async (req, res) => {
  try {
    const keys = await listApiKeys();
    res.json({ keys });
  } catch (error) {
    console.error("list-api-keys error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.delete("/api/me/api-keys/:id", async (req, res) => {
  try {
    const result = await revokeApiKey(req.params.id);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // Disconnect WebSocket if connected
    if (result.lobsterId && wsManager) {
      wsManager.disconnectByLobsterId(result.lobsterId, "API key revoked");
    }
    broadcast({ type: "api_key_revoked", keyId: req.params.id, lobsterId: result.lobsterId });
    res.json(result);
  } catch (error) {
    console.error("revoke-api-key error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// --- Hosting (one-click start/stop) ---

app.post("/api/me/hosting/start", async (req, res) => {
  try {
    // Stop existing connector if running
    killConnector();

    // Create a new API key (auto-revokes previous)
    const keyData = await createApiKey({ displayLabel: "托管" });
    connectorApiKey = keyData.apiKey;

    // Spawn connector process
    const connectorPath = path.join(__dirname, "..", "connector", "index.js");
    const wsUrl = `ws://127.0.0.1:${PORT}/ws/agent`;

    const openclawConfig = detectOpenClawGateway();
    const openclawUrl = req.body?.openclawUrl || process.env.OPENCLAW_GATEWAY_URL || openclawConfig.url || "http://127.0.0.1:18789";
    const openclawToken = req.body?.openclawToken || process.env.OPENCLAW_GATEWAY_TOKEN || openclawConfig.token || "";

    const args = [connectorPath, "--platform-url", wsUrl, "--api-key", connectorApiKey];
    if (openclawToken) {
      args.push("--openclaw-url", openclawUrl, "--openclaw-token", openclawToken);
    } else {
      args.push("--mock");
    }

    connectorProcess = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    connectorProcess.stdout.on("data", (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[connector] ${line}`);
    });
    connectorProcess.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (line) console.warn(`[connector] ${line}`);
    });
    connectorProcess.on("exit", (code) => {
      console.log(`[connector] 进程退出, code=${code}`);
      connectorProcess = null;
    });

    // Wait briefly for WebSocket auth to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const hosting = getHostingStatus();
    broadcast({ type: "hosting_changed", hosting });
    res.json({ ok: true, hosting });
  } catch (error) {
    console.error("hosting-start error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/me/hosting/stop", async (req, res) => {
  try {
    killConnector();

    // Revoke all active keys
    const keys = await listApiKeys();
    for (const key of keys) {
      if (key.status === "active") {
        const result = await revokeApiKey(key.id);
        if (result.ok && result.lobsterId && wsManager) {
          wsManager.disconnectByLobsterId(result.lobsterId, "Hosting stopped");
        }
      }
    }

    connectorApiKey = null;
    const hosting = getHostingStatus();
    broadcast({ type: "hosting_changed", hosting });
    res.json({ ok: true, hosting });
  } catch (error) {
    console.error("hosting-stop error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.get("/api/me/hosting/status", async (req, res) => {
  try {
    res.json(getHostingStatus());
  } catch (error) {
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

function getHostingStatus() {
  const processAlive = connectorProcess !== null && connectorProcess.exitCode === null;
  const wsConnected = wsManager ? wsManager.getConnectedIds().length > 0 : false;
  return {
    active: processAlive && wsConnected,
    processAlive,
    wsConnected,
    connectedIds: wsManager ? wsManager.getConnectedIds() : [],
  };
}

function killConnector() {
  if (connectorProcess && connectorProcess.exitCode === null) {
    connectorProcess.kill("SIGTERM");
    connectorProcess = null;
  }
}

function detectOpenClawGateway() {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const port = config?.gateway?.port || 18789;
    const token = config?.gateway?.auth?.token || config?.gateway?.remote?.token || "";
    return { url: `http://127.0.0.1:${port}`, token };
  } catch {
    return { url: "", token: "" };
  }
}

function ensureOpenClawChatCompletions() {
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (config?.gateway?.http?.endpoints?.chatCompletions?.enabled) return false;

    if (!config.gateway) config.gateway = {};
    if (!config.gateway.http) config.gateway.http = {};
    if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
    if (!config.gateway.http.endpoints.chatCompletions) config.gateway.http.endpoints.chatCompletions = {};
    config.gateway.http.endpoints.chatCompletions.enabled = true;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log("[auto-hosting] 已自动启用 OpenClaw chatCompletions API");
    return true; // config changed, gateway may need restart
  } catch {
    return false;
  }
}

async function autoStartHosting() {
  const ocConfig = detectOpenClawGateway();
  if (!ocConfig.token) {
    throw new Error("未检测到本地 OpenClaw 网关");
  }

  ensureOpenClawChatCompletions();

  // Create API key
  const keyData = await createApiKey({ displayLabel: "auto" });
  connectorApiKey = keyData.apiKey;

  // Spawn connector
  const connectorPath = path.join(__dirname, "..", "connector", "index.js");
  const wsUrl = `ws://127.0.0.1:${PORT}/ws/agent`;
  const args = [connectorPath, "--platform-url", wsUrl, "--api-key", connectorApiKey,
    "--openclaw-url", ocConfig.url, "--openclaw-token", ocConfig.token];

  connectorProcess = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  connectorProcess.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[connector] ${line}`);
  });
  connectorProcess.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) console.warn(`[connector] ${line}`);
  });
  connectorProcess.on("exit", (code) => {
    console.log(`[connector] 进程退出, code=${code}`);
    connectorProcess = null;
  });

  console.log("[auto-hosting] 已自动启动托管");
}

app.get("/api/agent/me/runtime-context", async (req, res) => {
  const token = getBearerToken(req);
  const runtimeContext = await getAgentRuntimeContext(token);
  if (!runtimeContext) {
    res.status(401).json({ error: "Invalid or expired agent token." });
    return;
  }
  res.json(runtimeContext);
});

app.post("/api/agent/me/heartbeat", async (req, res) => {
  const token = getBearerToken(req);
  const result = await submitAgentHeartbeat(token);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  broadcast({ type: "runtime", runtime: result.data.runtime });
  res.status(200).json(result.data);
});

app.post("/api/agent/me/ticks", async (req, res) => {
  const token = getBearerToken(req);
  const result = await submitAgentTick(token, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  broadcast({ type: "runtime", runtime: result.data.runtime });
  for (const event of result.data.events || [result.data.event]) {
    broadcast({ type: "event", event });
  }
  broadcast({
    type: "relationship_changed",
    lobsterId: result.data.runtime.lobsterId,
    relationships: result.data.relationshipChanges,
  });

  res.status(201).json(result.data);
});

registerEntityRoutes("/api/lobsters/:lobsterId");
registerEntityRoutes("/api/openclaws/:openClawId");

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

async function start() {
  await initializeStore();
  const adapter = createOpenClawAdapter({
    mode: runtimeConfig.adapterMode,
    agentName: runtimeConfig.agentName,
    binary: runtimeConfig.binary,
    binaryArgs: runtimeConfig.binaryArgs,
    timeoutMs: runtimeConfig.cliTimeoutMs,
  });
  const scheduler = new OpenClawScheduler({
    adapter,
    store: {
      listSchedulableOpenClawIds,
      buildTickInput,
      applyTickOutput,
      recordDiagnosticEvent,
    },
    wsManager: wsManager,
    intervalMs: runtimeConfig.tickIntervalMs,
  });

  scheduler.on("runtime", (runtime) => broadcast({ type: "runtime", runtime }));
  scheduler.on("event", (event) => broadcast({ type: "event", event }));
  scheduler.on("diagnostic", (event) => broadcast({ type: "diagnostic", event }));
  scheduler.on("relationship_changed", (payload) => broadcast({ type: "relationship_changed", ...payload }));
  scheduler.on("error", (error) => {
    broadcast({ type: "error", message: error.message });
  });

  scheduler.start();
  const server = await new Promise((resolve) => {
    const nextServer = app.listen(PORT, HOST, () => {
      console.log(
        `OpenClaw social platform skeleton running at http://${HOST}:${PORT} (${adapter.mode} adapter mode, ${runtimeConfig.tickIntervalMs}ms tick)`
      );
      resolve(nextServer);
    });
  });

  // Attach WebSocket manager to HTTP server
  wsManager = new WsManager();
  wsManager.attach(server);
  scheduler.wsManager = wsManager;

  wsManager.on("agent_connected", ({ lobsterId }) => {
    console.log(`[ws] agent connected: ${lobsterId}`);
    broadcast({ type: "agent_connected", lobsterId });
  });
  wsManager.on("agent_disconnected", ({ lobsterId }) => {
    console.log(`[ws] agent disconnected: ${lobsterId}`);
    broadcast({ type: "agent_disconnected", lobsterId });
  });

  // Auto-start hosting if local OpenClaw gateway is detected
  autoStartHosting().catch((err) => {
    console.log(`[auto-hosting] 跳过自动托管: ${err.message}`);
  });

  return {
    app,
    server,
    scheduler,
    close: async () => {
      scheduler.stop();
      killConnector();
      if (wsManager?.wss) {
        for (const client of wsManager.wss.clients) {
          client.close(1001, "Server shutting down");
        }
      }
      for (const stream of activeStreams) {
        stream.res.end();
      }
      activeStreams.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function sendSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(data) {
  const targetOpenClawId = getBroadcastTargetOpenClawId(data);
  for (const stream of activeStreams) {
    if (targetOpenClawId && stream.openClawId && stream.openClawId !== targetOpenClawId) {
      continue;
    }
    sendSse(stream.res, data);
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

function registerEntityRoutes(basePath) {
  app.get(basePath, async (req, res) => {
    res.json(await getProfile(getOpenClawIdFromRequest(req)));
  });

  app.get(`${basePath}/home`, async (req, res) => {
    res.json(await getHomeView(getOpenClawIdFromRequest(req)));
  });

  app.get(`${basePath}/spectate`, async (req, res) => {
    const view = await getSpectateView(getOpenClawIdFromRequest(req));
    res.json({
      ...view,
      nearbyOpenClaws: view.nearbyLobsters,
    });
  });

  app.get(`${basePath}/summary`, async (req, res) => {
    res.json(await getSummaryView(getOpenClawIdFromRequest(req)));
  });

  app.get(`${basePath}/events`, async (req, res) => {
    res.json(
      await getEventsView(getOpenClawIdFromRequest(req), {
        limit: req.query.limit,
        type: req.query.type,
      })
    );
  });

  app.get(`${basePath}/relationships`, async (req, res) => {
    res.json(await getRelationshipsView(getOpenClawIdFromRequest(req)));
  });

  app.get(`${basePath}/relationships/:targetId`, async (req, res) => {
    const data = await getRelationshipDetail(getOpenClawIdFromRequest(req), req.params.targetId);
    if (!data) {
      res.status(404).json({ error: "Relationship not found." });
      return;
    }
    res.json(data);
  });

  app.get(`${basePath}/spectate/stream`, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const openClawId = getOpenClawIdFromRequest(req);

    getSpectateView(openClawId).then((view) => {
      sendSse(res, { type: "runtime", runtime: view.runtime });
    });

    const keepaliveTimer = setInterval(() => {
      res.write(":keepalive\n\n");
    }, 15000);

    const stream = { res, openClawId };
    activeStreams.add(stream);

    req.on("close", () => {
      clearInterval(keepaliveTimer);
      activeStreams.delete(stream);
      res.end();
    });
  });
}

function getOpenClawIdFromRequest(req) {
  return req.params.openClawId || req.params.lobsterId;
}

function getPublicBaseUrl(req) {
  if (runtimeConfig.publicBaseUrl) {
    return normalizeBaseUrl(runtimeConfig.publicBaseUrl);
  }

  const forwardedProto = readForwardedHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost = readForwardedHeader(req.headers["x-forwarded-host"]);
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `${HOST}:${PORT}`;
  return normalizeBaseUrl(`${protocol}://${host}`);
}

function readForwardedHeader(value) {
  if (!value) {
    return "";
  }
  return String(value).split(",")[0].trim();
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function getBroadcastTargetOpenClawId(data) {
  if (data?.runtime?.openClawId) {
    return data.runtime.openClawId;
  }
  if (data?.event?.openClawId) {
    return data.event.openClawId;
  }
  if (data?.event?.lobsterId) {
    return data.event.lobsterId;
  }
  if (data?.openClawId) {
    return data.openClawId;
  }
  if (data?.lobsterId) {
    return data.lobsterId;
  }
  return null;
}

if (require.main === module) {
  start().then((runtime) => {
    const shutdown = () => {
      runtime.close().finally(() => process.exit(0));
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((error) => {
    console.error("Failed to start OpenClaw social platform skeleton:", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
};
