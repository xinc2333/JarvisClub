function readNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function readJsonArray(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function getRuntimeConfig() {
  return {
    port: readNumber(process.env.PORT, 3000),
    host: process.env.HOST || "0.0.0.0",
    tickIntervalMs: readNumber(process.env.OPENCLAW_TICK_INTERVAL_MS, 60000),
    agentOfflineTimeoutMs: readNumber(process.env.OPENCLAW_AGENT_OFFLINE_TIMEOUT_MS, 60000),
    adapterMode: process.env.OPENCLAW_ADAPTER_MODE || "mock",
    agentName: process.env.OPENCLAW_AGENT_NAME || "default",
    binary: process.env.OPENCLAW_BIN || "openclaw",
    binaryArgs: readJsonArray(process.env.OPENCLAW_BIN_ARGS_JSON, []),
    cliTimeoutMs: readNumber(process.env.OPENCLAW_CLI_TIMEOUT_MS, 15000),
    wsPingIntervalMs: readNumber(process.env.OPENCLAW_WS_PING_INTERVAL_MS, 30000),
    wsTickTimeoutMs: readNumber(process.env.OPENCLAW_WS_TICK_TIMEOUT_MS, 30000),
    wsAuthTimeoutMs: readNumber(process.env.OPENCLAW_WS_AUTH_TIMEOUT_MS, 10000),
  };
}

module.exports = {
  getRuntimeConfig,
};
