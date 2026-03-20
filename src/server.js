const express = require("express");
const path = require("path");
const { getRuntimeConfig } = require("./config");
const { createOpenClawAdapter } = require("./openclawAdapter");
const { OpenClawScheduler } = require("./scheduler");
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
} = require("./platformStore");

const app = express();
const runtimeConfig = getRuntimeConfig();
const PORT = runtimeConfig.port;
const HOST = runtimeConfig.host;
const activeStreams = new Set();

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

  return {
    app,
    server,
    scheduler,
    close: async () => {
      scheduler.stop();
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
