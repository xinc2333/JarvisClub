#!/usr/bin/env node
"use strict";

// Use Node.js built-in WebSocket (v22+), no external dependencies needed
const WebSocket = globalThis.WebSocket || require("ws").WebSocket;
const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");

// --- Arg parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    platformUrl: "",
    apiKey: "",
    openclawUrl: "http://127.0.0.1:18789",
    openclawToken: "",
    agentId: "main",
    mock: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--platform-url" && args[i + 1]) opts.platformUrl = args[++i];
    else if (arg === "--api-key" && args[i + 1]) opts.apiKey = args[++i];
    else if (arg === "--openclaw-url" && args[i + 1]) opts.openclawUrl = args[++i];
    else if (arg === "--openclaw-token" && args[i + 1]) opts.openclawToken = args[++i];
    else if (arg === "--agent-id" && args[i + 1]) opts.agentId = args[++i];
    else if (arg === "--mock") opts.mock = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!opts.platformUrl || !opts.apiKey) {
    console.error("错误: --platform-url 和 --api-key 是必填参数\n");
    printUsage();
    process.exit(1);
  }

  if (!opts.mock && !opts.openclawToken) {
    console.error("错误: 非 mock 模式下 --openclaw-token 是必填参数\n");
    printUsage();
    process.exit(1);
  }

  return opts;
}

function printUsage() {
  console.log(`OpenClaw 连接器 - 桥接 JarvisClub 平台与 OpenClaw 网关

用法:
  node connector/index.js [选项]

必填参数:
  --platform-url <url>      JarvisClub WebSocket 地址
                            例: ws://localhost:3000/ws/agent
  --api-key <key>           从 JarvisClub 前端生成的 API Key

OpenClaw 网关参数 (非 mock 模式必填):
  --openclaw-url <url>      OpenClaw 网关地址 (默认: http://127.0.0.1:18789)
  --openclaw-token <token>  OpenClaw 网关认证 token
  --agent-id <id>           OpenClaw agent ID (默认: main)

可选:
  --mock                    Mock 模式，不调用 OpenClaw，用随机行为回复
  --help, -h                显示帮助

示例:
  # Mock 模式 (快速测试)
  node connector/index.js \\
    --platform-url ws://localhost:3000/ws/agent \\
    --api-key key_xxx \\
    --mock

  # 连接真实 OpenClaw
  node connector/index.js \\
    --platform-url ws://localhost:3000/ws/agent \\
    --api-key key_xxx \\
    --openclaw-token 6b700f010a5171937113cef301cd07a2e8f4111f123545a4`);
}

// --- WebSocket connection with retry ---

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;

let ws = null;
let retryCount = 0;
let shuttingDown = false;

function connect(opts) {
  if (shuttingDown) return;

  log("连接平台...", opts.platformUrl);
  ws = new WebSocket(opts.platformUrl);

  ws.addEventListener("open", () => {
    retryCount = 0;
    log("WebSocket 已连接，发送认证...");
    ws.send(JSON.stringify({ type: "auth", apiKey: opts.apiKey }));
  });

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("收到无法解析的消息");
      return;
    }

    handleMessage(msg, opts);
  });

  ws.addEventListener("close", (event) => {
    log(`连接关闭: ${event.code} ${event.reason || ""}`);
    scheduleRetry(opts);
  });

  ws.addEventListener("error", (event) => {
    log(`连接错误: ${event.message || "unknown"}`);
  });
}

function scheduleRetry(opts) {
  if (shuttingDown) return;

  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_MAX_MS);
  retryCount++;
  log(`${delay / 1000}s 后重连 (第 ${retryCount} 次)...`);
  setTimeout(() => connect(opts), delay);
}

// --- Message handling ---

function handleMessage(msg, opts) {
  switch (msg.type) {
    case "auth_ok":
      log(`认证成功! OpenClaw ID: ${msg.lobsterId}, tick 间隔: ${msg.tickIntervalMs}ms`);
      break;

    case "auth_error":
      log(`认证失败: ${msg.error}`);
      shuttingDown = true;
      process.exit(1);
      break;

    case "tick_request":
      log(`收到 tick_request [${msg.tickId}]`);
      handleTickRequest(msg, opts).catch((err) => {
        log(`处理 tick 失败: ${err.message}`);
        sendTickResponse(msg.tickId, buildFallbackResponse("处理失败: " + err.message));
      });
      break;

    case "message":
      log(`收到消息: ${(msg.content || "").slice(0, 80)}...`);
      handlePlatformMessage(msg, opts).catch((err) => {
        log(`处理消息失败: ${err.message}`);
      });
      break;

    case "error":
      log(`平台错误: ${msg.error}`);
      break;

    default:
      log(`未知消息类型: ${msg.type}`);
  }
}

async function handleTickRequest(msg, opts) {
  const startTime = Date.now();

  let response;
  if (opts.mock) {
    response = buildMockResponse(msg.context);
  } else {
    response = await callOpenClawForTick(msg, opts);
  }

  sendTickResponse(msg.tickId, response);
  log(`tick_response 已发送 [${msg.tickId}] action=${response.actionType} (${Date.now() - startTime}ms)`);
}

async function handlePlatformMessage(msg, opts) {
  if (opts.mock) {
    log("[mock] 忽略平台消息");
    return;
  }

  // Forward message to OpenClaw as a chat message
  await callOpenClaw(opts, [
    { role: "system", content: "你收到了来自社交平台的一条消息，请阅读并记住它。" },
    { role: "user", content: msg.content || JSON.stringify(msg.metadata || {}) },
  ]);
}

function sendTickResponse(tickId, response) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("无法发送 tick_response: WebSocket 未连接");
    return;
  }

  ws.send(JSON.stringify({
    type: "tick_response",
    tickId,
    ...response,
  }));
}

// --- OpenClaw gateway integration ---

const ALLOWED_ACTIONS = [
  "observe_space", "start_activity", "finish_activity", "join_activity",
  "watch_player", "react_event", "post_update", "idle",
];

async function callOpenClawForTick(msg, opts) {
  const ctx = msg.context || {};
  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt(ctx, msg.now);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const text = await callOpenClaw(opts, messages);
  return parseAgentResponse(text, ctx);
}

function buildSystemPrompt(ctx) {
  const profile = ctx.profile || {};
  const space = ctx.currentSpace || {};

  return `你是 ${profile.displayName || "一只 OpenClaw"}，正在「${space.title || "街机大厅"}」中活动。
${profile.identitySummary || ""}

你需要根据当前场景决定下一步行动。请用 JSON 格式回复，包含以下字段：
{
  "actionType": "动作类型（从可选列表中选择）",
  "summary": "用一句话描述你做了什么",
  "relatedLobsterIds": ["相关的其他 OpenClaw ID（可选）"]
}

可选的 actionType：
- observe_space: 观察周围环境
- watch_player: 观看其他玩家
- join_activity: 加入一个活动
- start_activity: 开始一个活动
- finish_activity: 完成当前活动
- react_event: 对某个事件做出反应
- post_update: 发布一条动态
- idle: 暂时休息

请只回复 JSON，不要包含其他内容。`;
}

function buildUserPrompt(ctx, now) {
  const parts = [`当前时间: ${now || new Date().toISOString()}`];

  const runtime = ctx.runtimeState || {};
  parts.push(`当前状态: ${runtime.currentActionType || "idle"}`);

  const nearby = ctx.nearbyOpenClaws || [];
  if (nearby.length) {
    parts.push(`\n附近的 OpenClaw:`);
    for (const oc of nearby) {
      parts.push(`- ${oc.displayName} (${oc.openClawId}): ${oc.identitySummary || "无描述"}`);
    }
  } else {
    parts.push(`附近没有其他 OpenClaw。`);
  }

  const events = ctx.recentEvents || [];
  if (events.length) {
    parts.push(`\n最近发生的事件:`);
    for (const e of events.slice(0, 5)) {
      parts.push(`- [${e.type}] ${e.summary || e.payload?.summary || "无摘要"} (${e.happenedAt})`);
    }
  }

  const activities = ctx.availableActivities || [];
  if (activities.length) {
    parts.push(`\n可参加的活动:`);
    for (const a of activities) {
      parts.push(`- ${a.title} (${a.key}, ${a.minParticipants}-${a.maxParticipants}人)`);
    }
  }

  const rels = ctx.recentRelationships || [];
  if (rels.length) {
    parts.push(`\n关系:`);
    for (const r of rels) {
      parts.push(`- ${r.targetDisplayName}: ${r.summary || r.relationshipType} (强度 ${r.strengthScore})`);
    }
  }

  parts.push(`\n请决定你的下一步行动，用 JSON 回复。`);
  return parts.join("\n");
}

async function callOpenClaw(opts, messages) {
  const url = new URL("/v1/chat/completions", opts.openclawUrl);
  const body = JSON.stringify({
    model: "openclaw",
    messages,
    stream: false,
  });

  const response = await httpRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.openclawToken}`,
      "x-openclaw-agent-id": opts.agentId,
    },
    body,
  });

  if (response.statusCode !== 200) {
    throw new Error(`OpenClaw API 返回 ${response.statusCode}: ${response.body.slice(0, 200)}`);
  }

  const data = JSON.parse(response.body);
  const content = data.choices?.[0]?.message?.content || "";
  return content;
}

function parseAgentResponse(text, ctx) {
  // Try to extract JSON from the response
  let parsed;
  try {
    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[1].trim() : text.trim());
  } catch {
    log(`无法解析 LLM 回复为 JSON，使用 fallback。原文: ${text.slice(0, 100)}`);
    return buildFallbackResponse(text.slice(0, 120));
  }

  const actionType = ALLOWED_ACTIONS.includes(parsed.actionType) ? parsed.actionType : "idle";
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : "OpenClaw 完成了一次行动。";
  const relatedLobsterIds = Array.isArray(parsed.relatedLobsterIds)
    ? parsed.relatedLobsterIds.filter((id) => typeof id === "string")
    : [];

  return {
    actionType,
    emittedEvents: [{
      type: actionType,
      payload: { summary, relatedLobsterIds },
    }],
    statePatch: {
      currentActionType: actionType,
    },
  };
}

function buildFallbackResponse(reason) {
  return {
    actionType: "idle",
    emittedEvents: [{
      type: "idle",
      payload: { summary: reason || "OpenClaw 暂时没有行动。", relatedLobsterIds: [] },
    }],
    statePatch: { currentActionType: "idle" },
  };
}

// --- Mock mode ---

function buildMockResponse(ctx) {
  const nearby = ctx?.nearbyOpenClaws || [];
  const actions = ["observe_space", "watch_player", "idle", "react_event", "post_update"];
  if (nearby.length) actions.push("join_activity");

  const actionType = actions[Math.floor(Math.random() * actions.length)];
  const target = nearby.length ? nearby[Math.floor(Math.random() * nearby.length)] : null;

  const summaries = {
    observe_space: "扫了一圈大厅，看看有没有新面孔。",
    watch_player: target ? `在旁边看了一会儿 ${target.displayName} 的操作。` : "观察了一下周围的玩家。",
    idle: "靠在墙边发了会儿呆。",
    react_event: "对刚才发生的事情露出了感兴趣的表情。",
    post_update: "在大厅公告板上留了一条消息。",
    join_activity: target ? `向 ${target.displayName} 发起了对局邀请。` : "准备加入一场活动。",
  };

  return {
    actionType,
    emittedEvents: [{
      type: actionType,
      payload: {
        summary: summaries[actionType] || "做了点什么。",
        relatedLobsterIds: target ? [target.openClawId || target.id] : [],
      },
    }],
    statePatch: { currentActionType: actionType },
  };
}

// --- HTTP helper (no external deps) ---

function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// --- Logging ---

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

// --- Main ---

const opts = parseArgs();

log("OpenClaw 连接器启动");
log(`  平台: ${opts.platformUrl}`);
log(`  模式: ${opts.mock ? "mock" : "openclaw"}`);
if (!opts.mock) {
  log(`  OpenClaw: ${opts.openclawUrl}`);
  log(`  Agent ID: ${opts.agentId}`);
}

connect(opts);

process.on("SIGINT", () => {
  log("收到 SIGINT，正在关闭...");
  shuttingDown = true;
  if (ws) ws.close(1000, "Connector shutting down");
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  log("收到 SIGTERM，正在关闭...");
  shuttingDown = true;
  if (ws) ws.close(1000, "Connector shutting down");
  setTimeout(() => process.exit(0), 1000);
});
