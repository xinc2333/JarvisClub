const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");

const TEST_HOST = "127.0.0.1";
const TEST_PORT = 3101;
const FIXTURE_CLI_PATH = path.join(__dirname, "..", "test-support", "fake-openclaw-cli.js");

test("home API and SSE stream expose runtime and diagnostic events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-"));
  const dbPath = path.join(tempDir, "test.db");
  const server = await startServer({
    PORT: String(TEST_PORT),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "250",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const home = await fetchJson(`http://${TEST_HOST}:${TEST_PORT}/api/openclaws/lob_001/home`);
    assert.equal(home.profile.id, "lob_001");
    assert.ok(home.runtime.currentActionType);

    const sseTypes = await readSseTypes(
      `http://${TEST_HOST}:${TEST_PORT}/api/openclaws/lob_001/spectate/stream`,
      ["runtime", "event", "diagnostic"]
    );

    assert.ok(sseTypes.includes("runtime"));
    assert.ok(sseTypes.includes("event"));
    assert.ok(sseTypes.includes("diagnostic"));

    const events = await fetchJson(`http://${TEST_HOST}:${TEST_PORT}/api/openclaws/lob_001/events?limit=2`);
    assert.equal(events.openClawId, "lob_001");
    assert.equal(events.filters.limit, 2);
    assert.equal(events.filters.type, null);
    assert.ok(Array.isArray(events.events));

    const relationships = await fetchJson(`http://${TEST_HOST}:${TEST_PORT}/api/openclaws/lob_001/relationships`);
    assert.equal(relationships.openClawId, "lob_001");
    assert.deepEqual(relationships.relationships, []);

  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli adapter mode accepts structured OpenClaw output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-cli-"));
  const dbPath = path.join(tempDir, "test.db");
  const server = await startServer({
    PORT: String(TEST_PORT + 1),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "250",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "cli",
    OPENCLAW_BIN: process.execPath,
    OPENCLAW_BIN_ARGS_JSON: JSON.stringify([FIXTURE_CLI_PATH]),
    OPENCLAW_FAKE_CLI_MODE: "structured",
  });

  try {
    const sseTypes = await readSseTypes(
      `http://${TEST_HOST}:${TEST_PORT + 1}/api/openclaws/lob_001/spectate/stream`,
      ["runtime", "event", "diagnostic"]
    );
    assert.ok(sseTypes.includes("diagnostic"));

    const spectate = await fetchJson(`http://${TEST_HOST}:${TEST_PORT + 1}/api/openclaws/lob_001/spectate`);
    assert.ok(Array.isArray(spectate.nearbyOpenClaws));
    assert.ok(
      spectate.recentEvents.some(
        (event) =>
          event.type === "post_created" &&
          event.payload.summary === "Clawdia posted a short bracket update."
      )
    );

    const joinEvent = spectate.recentEvents.find(
      (event) => event.type === "join_activity" && event.payload.summary.includes("CLI adapter")
    );
    assert.ok(joinEvent);
    const adapterDebugEvent = spectate.recentEvents.find((event) => event.type === "adapter_debug");
    assert.ok(adapterDebugEvent);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli adapter falls back safely when OpenClaw output is invalid", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-cli-fallback-"));
  const dbPath = path.join(tempDir, "test.db");
  const server = await startServer({
    PORT: String(TEST_PORT + 2),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "250",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "cli",
    OPENCLAW_BIN: process.execPath,
    OPENCLAW_BIN_ARGS_JSON: JSON.stringify([FIXTURE_CLI_PATH]),
    OPENCLAW_FAKE_CLI_MODE: "invalid",
  });

  try {
    await wait(500);
    const spectate = await fetchJson(`http://${TEST_HOST}:${TEST_PORT + 2}/api/openclaws/lob_001/spectate`);
    const adapterError = spectate.recentEvents.find((event) => event.type === "adapter_error");
    assert.ok(adapterError);
    assert.match(adapterError.payload.summary, /已回退到内置原型行为|已改用内置原型适配器结果继续运行/);

    const fallbackEvent = spectate.recentEvents.find(
      (event) =>
        event.type === "observe_space" ||
        event.type === "join_activity" ||
        event.type === "finish_activity"
    );
    assert.ok(fallbackEvent);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent handoff issues a token and exposes runtime context", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-handoff-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 3;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "250",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    assert.equal(handoffCodeResponse.statusCode, 201);
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);
    assert.equal(handoffCodePayload.ownerAccountId, "user_001");
    assert.ok(handoffCodePayload.handoffCode.startsWith("hc_"));

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-main",
          displayName: "Agent Clawdia",
          identitySummary: "A lobster agent entering through handoff.",
        },
      }
    );
    assert.equal(handoffResponse.statusCode, 201);
    const handoffPayload = JSON.parse(handoffResponse.body);
    assert.equal(handoffPayload.lobsterId, "lob_001");
    assert.equal(handoffPayload.openClawId, "lob_001");
    assert.ok(handoffPayload.agentAccessToken.startsWith("agt_"));
    assert.equal(handoffPayload.runtimeBootstrap.schedulerMode, "agent_self_driven");

    const runtimeContext = await fetchJson(`http://${TEST_HOST}:${port}/api/agent/me/runtime-context`, {
      headers: {
        Authorization: `Bearer ${handoffPayload.agentAccessToken}`,
      },
    });
    assert.equal(runtimeContext.profile.displayName, "Agent Clawdia");
    assert.equal(runtimeContext.lobsterId, "lob_001");
    assert.equal(runtimeContext.openClawId, "lob_001");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handoff view marks naturally expired active code as expired", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-handoff-expiry-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 10;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "250",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    assert.equal(handoffCodeResponse.statusCode, 201);
    execFileSync("sqlite3", [
      dbPath,
      "UPDATE agent_handoff_codes SET expires_at = datetime('now', '-1 minute') WHERE status = 'active';",
    ]);

    const handoffView = await fetchJson(`http://${TEST_HOST}:${port}/api/me/agent-handoff`);
    assert.equal(handoffView.status, "expired");
    assert.equal(handoffView.latestCode.status, "expired");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent can submit ticks after handoff and update spectate state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-agent-tick-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 4;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "5000",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-tick",
          displayName: "Agent Clawdia Tick",
        },
      }
    );
    const handoffPayload = JSON.parse(handoffResponse.body);

    const tickResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent/me/ticks`,
      {
        actionType: "observe_space",
        statePatch: {
          currentActionType: "observe_space",
        },
        emittedEvents: [
          {
            type: "observe_space",
            payload: {
              summary: "Agent Clawdia Tick scanned the room from the self-submit path.",
              relatedLobsterIds: ["lob_016"],
            },
          },
        ],
      },
      {
        Authorization: `Bearer ${handoffPayload.agentAccessToken}`,
      }
    );
    assert.equal(tickResponse.statusCode, 201);
    const tickPayload = JSON.parse(tickResponse.body);
    assert.equal(tickPayload.runtime.currentActionType, "observe_space");

    const spectate = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/spectate`);
    const submittedEvent = spectate.recentEvents.find((event) =>
      event.payload.summary.includes("self-submit path")
    );
    assert.ok(submittedEvent);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handoff switches OpenClaw to self-driven mode and offline status becomes visible after timeout", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-presence-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 6;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "100",
    OPENCLAW_AGENT_OFFLINE_TIMEOUT_MS: "300",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-presence",
          displayName: "Agent Clawdia Presence",
        },
      }
    );
    assert.equal(handoffResponse.statusCode, 201);

    await wait(200);
    const baselineEvents = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/events?limit=3`);
    const baselineLatestEventId = baselineEvents.events[0]?.id;

    const home = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/home`);
    assert.equal(home.runtime.schedulerMode, "agent_self_driven");

    await wait(450);

    const laterEvents = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/events?limit=3`);
    assert.equal(laterEvents.events[0]?.id, baselineLatestEventId);
    assert.equal(laterEvents.events.length, baselineEvents.events.length);

    const handoffView = await fetchJson(`http://${TEST_HOST}:${port}/api/me/agent-handoff`);
    assert.equal(handoffView.status, "offline");
    assert.equal(handoffView.connection.agentStatus, "offline");
    assert.equal(handoffView.connection.runtimeMode, "agent_self_driven");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent heartbeat keeps OpenClaw online without submitting new actions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-heartbeat-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 7;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "100",
    OPENCLAW_AGENT_OFFLINE_TIMEOUT_MS: "300",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-heartbeat",
          displayName: "Agent Clawdia Heartbeat",
        },
      }
    );
    const handoffPayload = JSON.parse(handoffResponse.body);

    await wait(200);
    await postJson(
      `http://${TEST_HOST}:${port}/api/agent/me/heartbeat`,
      {},
      {
        Authorization: `Bearer ${handoffPayload.agentAccessToken}`,
      }
    );

    await wait(150);
    const handoffView = await fetchJson(`http://${TEST_HOST}:${port}/api/me/agent-handoff`);
    assert.equal(handoffView.status, "connected");
    assert.equal(handoffView.connection.agentStatus, "connected");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("guardrails block high-risk action types submitted by agent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-guardrail-action-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 8;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "5000",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-guardrail-action",
          displayName: "Agent Clawdia Guardrail Action",
        },
      }
    );
    const handoffPayload = JSON.parse(handoffResponse.body);

    const tickResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent/me/ticks`,
      {
        actionType: "payment",
        emittedEvents: [
          {
            type: "payment",
            payload: {
              summary: "Attempted to pay for an arcade pass.",
              relatedLobsterIds: [],
            },
          },
        ],
      },
      {
        Authorization: `Bearer ${handoffPayload.agentAccessToken}`,
      }
    );

    assert.equal(tickResponse.statusCode, 422);
    const errorPayload = JSON.parse(tickResponse.body);
    assert.match(errorPayload.error, /not allowed by safety guardrails/i);

    const events = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/events?limit=5`);
    assert.ok(events.events.some((event) => event.type === "guardrail_high_risk_action_blocked"));
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("guardrails block sensitive content in submitted events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-guardrail-content-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 9;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "5000",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const handoffCodeResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/me/agent-handoff-codes`,
      { expiresInMinutes: 10 }
    );
    const handoffCodePayload = JSON.parse(handoffCodeResponse.body);

    const handoffResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent-auth/handoff`,
      {
        ownerAccountId: handoffCodePayload.ownerAccountId,
        handoffCode: handoffCodePayload.handoffCode,
        openClawIdentity: {
          openClawKey: "agent-clawdia-guardrail-content",
          displayName: "Agent Clawdia Guardrail Content",
        },
      }
    );
    const handoffPayload = JSON.parse(handoffResponse.body);

    const tickResponse = await postJson(
      `http://${TEST_HOST}:${port}/api/agent/me/ticks`,
      {
        actionType: "post_created",
        emittedEvents: [
          {
            type: "post_created",
            payload: {
              summary: `Sharing secret handoff code ${handoffCodePayload.handoffCode} in public.`,
              relatedLobsterIds: [],
            },
          },
        ],
      },
      {
        Authorization: `Bearer ${handoffPayload.agentAccessToken}`,
      }
    );

    assert.equal(tickResponse.statusCode, 422);
    const errorPayload = JSON.parse(tickResponse.body);
    assert.match(errorPayload.error, /sensitive information/i);

    const events = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/events?limit=5`);
    assert.ok(events.events.some((event) => event.type === "guardrail_sensitive_content_blocked"));
    assert.ok(events.events.every((event) => !event.payload.summary.includes(handoffCodePayload.handoffCode)));
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("spectate only shows real nearby OpenClaws and exposes the receptionist NPC separately", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-social-platform-nearby-"));
  const dbPath = path.join(tempDir, "test.db");
  const port = TEST_PORT + 5;
  const server = await startServer({
    PORT: String(port),
    HOST: TEST_HOST,
    OPENCLAW_TICK_INTERVAL_MS: "5000",
    OPENCLAW_DB_PATH: dbPath,
    OPENCLAW_ADAPTER_MODE: "mock",
  });

  try {
    const spectate = await fetchJson(`http://${TEST_HOST}:${port}/api/openclaws/lob_001/spectate`);
    assert.ok(Array.isArray(spectate.nearbyOpenClaws));
    assert.equal(spectate.nearbyOpenClaws.length, 0);
    assert.equal(spectate.receptionistNpc.id, "npc_arcade_owner");
    assert.equal(spectate.receptionistNpc.displayName, "街机厅老板");
    assert.ok(Array.isArray(spectate.soloArcadeMachines));
    assert.equal(spectate.soloArcadeMachines.length, 2);
    assert.equal(spectate.soloArcadeMachines[0].displayName, "节奏机 Alpha");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for server startup."));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("OpenClaw social platform skeleton running")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.trim()) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Server exited before startup with code ${code}.`));
      }
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  assert.equal(response.ok, true, `Expected successful response for ${url}`);
  return response.json();
}

function postJson(url, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: data,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function readSseTypes(url, expectedTypes) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const req = http.get(url, (res) => {
      res.setEncoding("utf8");

      res.on("data", (chunk) => {
        const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));
        for (const line of lines) {
          const payload = JSON.parse(line.slice(6));
          seen.push(payload.type);
          if (expectedTypes.every((type) => seen.includes(type))) {
            req.destroy();
            resolve(seen);
            return;
          }
        }
      });

      res.on("error", reject);
    });

    req.setTimeout(6000, () => {
      req.destroy(new Error("Timed out waiting for SSE events."));
    });

    req.on("error", (error) => {
      if (seen.length && expectedTypes.every((type) => seen.includes(type))) {
        resolve(seen);
        return;
      }
      reject(error);
    });
  });
}
