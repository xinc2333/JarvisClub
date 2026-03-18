const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const ALLOWED_ACTIONS = new Set([
  "observe_space",
  "join_activity",
  "finish_activity",
  "watch_player",
  "react_event",
  "post_update",
  "idle",
]);

function createOpenClawAdapter(options = {}) {
  const mode = options.mode || process.env.OPENCLAW_ADAPTER_MODE || "mock";
  const agentName = options.agentName || process.env.OPENCLAW_AGENT_NAME || "default";
  const binary = options.binary || process.env.OPENCLAW_BIN || "openclaw";
  const binaryArgs = Array.isArray(options.binaryArgs) ? options.binaryArgs : [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;

  return {
    mode,
    agentName,

    getSessionKey(lobsterId) {
      return `lobster-${lobsterId}`;
    },

    buildAgentContext(input) {
      return {
        lobsterId: input.lobsterId,
        sessionKey: input.sessionKey,
        profile: input.profile,
        runtimeState: input.runtimeState,
        currentSpace: input.currentSpace,
        nearbyOpenClaws: Array.isArray(input.nearbyOpenClaws) ? input.nearbyOpenClaws.slice(0, 6) : [],
        availableActivities: input.availableActivities,
        recentEvents: input.recentEvents.slice(0, 10).map((event) => ({
          type: event.type,
          summary: event.payload.summary,
          relatedLobsterIds: event.relatedLobsterIds,
          happenedAt: event.happenedAt,
        })),
        recentRelationships: input.recentRelationships.slice(0, 6).map((rel) => ({
          targetDisplayName: rel.targetDisplayName,
          relationshipType: rel.relationshipType,
          summary: rel.summary,
          strengthScore: rel.strengthScore,
        })),
        now: input.now,
      };
    },

    async runTick(input) {
      if (mode === "cli") {
        try {
          return await runCliTick({
            binary,
            binaryArgs,
            agentName,
            sessionKey: input.sessionKey,
            timeoutMs,
            context: this.buildAgentContext(input),
            fallback: (reason) => buildMockFallbackResult(input, reason),
          });
        } catch (error) {
          return buildIdleResult(input, `CLI 适配器调用失败：${error.message}`, "adapter_error");
        }
      }

      return runMockTick(input);
    },
  };
}

async function runCliTick({ binary, binaryArgs, agentName, sessionKey, timeoutMs, context, fallback }) {
  const prompt = buildTickPrompt(context);
  const stdout = await spawnOpenClaw(binary, binaryArgs, agentName, sessionKey, prompt, timeoutMs);
  const parsed = parseCliOutput(stdout);
  if (!parsed) {
    return fallback("CLI 输出无法解析，已回退到内置原型行为。");
  }
  return normalizeCliResult(parsed, context);
}

function buildTickPrompt(context) {
  return [
    "你正在控制一只位于社交游戏平台中的 OpenClaw。",
    "请根据当前世界状态，选择一个安全的下一步行动。",
    "只返回 JSON，格式必须如下：",
    '{"actionType":"observe_space|join_activity|finish_activity|watch_player|react_event|post_update|idle","summary":"...","relatedLobsterIds":["..."]}',
    "不要输出 Markdown。",
    "summary 请使用简体中文。",
    "上下文：",
    JSON.stringify(context),
  ].join("\n");
}

function spawnOpenClaw(binary, binaryArgs, agentName, sessionKey, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, [
      ...binaryArgs,
      "agent",
      "--agent",
      agentName,
      "--session-id",
      sessionKey,
      "--message",
      message,
      "--json",
    ]);
    let settled = false;
    let timer = null;

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `OpenClaw exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`OpenClaw timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function parseCliOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const json = JSON.parse(trimmed);
    const text = extractTextFromCliJson(json);
    if (!text) return null;
    return JSON.parse(extractJsonObject(text));
  } catch (_error) {
    try {
      return JSON.parse(extractJsonObject(trimmed));
    } catch (_nestedError) {
      return null;
    }
  }
}

function extractTextFromCliJson(json) {
  if (json?.result?.payloads?.length) {
    return json.result.payloads
      .map((payload) => payload.text || payload.content || payload.output_text)
      .filter(Boolean)
      .join("\n");
  }
  if (typeof json?.result?.text === "string") {
    return json.result.text;
  }
  if (typeof json?.result?.output_text === "string") {
    return json.result.output_text;
  }
  if (typeof json?.text === "string") {
    return json.text;
  }
  if (typeof json?.output_text === "string") {
    return json.output_text;
  }
  return "";
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in CLI output");
  }
  return text.slice(start, end + 1);
}

function normalizeCliResult(parsed, context) {
  const actionType = isAllowedAction(parsed.actionType) ? parsed.actionType : "idle";
  const normalizedEvents = normalizeCliEvents(parsed, actionType);
  const debugNotes = [];

  if (parsed.actionType !== actionType) {
    debugNotes.push(`不支持的动作 "${parsed.actionType}" 已被归一化为 idle。`);
  }

  return {
    actionType,
    statePatch: {
      currentActionType: sanitizeStateActionType(parsed.statePatch?.currentActionType, actionType),
      currentActionStartedAt:
        typeof parsed.statePatch?.currentActionStartedAt === "string"
          ? parsed.statePatch.currentActionStartedAt
          : context.now,
    },
    activityResult: normalizeActivityResult(parsed.activityResult),
    emittedEvents: normalizedEvents,
    diagnosticEventType: "adapter_debug",
    debugSummary: debugNotes.length
      ? `本轮由 OpenClaw CLI 生成，并做了归一化处理：${debugNotes.join(" ")}`
      : "本轮内容由 OpenClaw CLI 生成。",
  };
}

function runMockTick(input) {
  const nearbyOpenClaws = Array.isArray(input.nearbyOpenClaws) ? input.nearbyOpenClaws : [];
  const soloActivity = Array.isArray(input.availableActivities)
    ? input.availableActivities.find((activity) => activity.key === "solo_arcade_run")
    : null;
  const primaryTarget = nearbyOpenClaws[0] || { openClawId: "", displayName: "大厅动静" };
  const competitiveTarget = nearbyOpenClaws[1] || nearbyOpenClaws[0] || { openClawId: "", displayName: "机台上的记录分数" };
  const choices = nearbyOpenClaws.length
    ? [
        {
          actionType: "observe_space",
          summary: `${input.profile.displayName}扫了一眼大厅，发现${primaryTarget.displayName}正在队列边徘徊。`,
          relatedLobsterIds: primaryTarget.openClawId ? [primaryTarget.openClawId] : [],
        },
        {
          actionType: "join_activity",
          summary: `${input.profile.displayName}又钻进了一场快速街机对局。`,
          relatedLobsterIds: [],
        },
        {
          actionType: "finish_activity",
          summary: `${input.profile.displayName}和${competitiveTarget.displayName}的复赛只差一分，最后惜败。`,
          relatedLobsterIds: competitiveTarget.openClawId ? [competitiveTarget.openClawId] : [],
        },
      ]
    : [
        {
          actionType: "observe_space",
          summary: `${input.profile.displayName}绕着单机区转了一圈，确认现在可以自己安静玩一会儿。`,
          relatedLobsterIds: [],
        },
        {
          actionType: "join_activity",
          summary: `${input.profile.displayName}坐上了${soloActivity?.title || "单机刷分机台"}，开始独自刷分。`,
          relatedLobsterIds: [],
        },
        {
          actionType: "finish_activity",
          summary: `${input.profile.displayName}完成了一轮${soloActivity?.title || "单机刷分"}，顺手把自己的分数又往上顶了一点。`,
          relatedLobsterIds: [],
        },
      ];

  const next = choices[Math.floor(Math.random() * choices.length)];

  return {
    actionType: next.actionType,
    statePatch: {
      currentActionType: next.actionType,
      currentActionStartedAt: input.now,
    },
    activityResult: null,
    emittedEvents: [
      {
        id: randomUUID(),
        type: next.actionType,
        payload: {
          summary: next.summary,
          relatedLobsterIds: next.relatedLobsterIds,
        },
      },
    ],
    diagnosticEventType: "adapter_debug",
    debugSummary: "本轮内容由内置原型适配器生成。",
  };
}

function buildMockFallbackResult(input, reason) {
  const result = runMockTick(input);
  result.diagnosticEventType = "adapter_error";
  result.debugSummary = `${reason} 已改用内置原型适配器结果继续运行。`;
  return result;
}

function buildIdleResult(input, debugSummary, diagnosticEventType = "adapter_debug") {
  return {
    actionType: "idle",
    statePatch: {
      currentActionType: "idle",
      currentActionStartedAt: input.now,
    },
    activityResult: null,
    emittedEvents: [
      {
        id: randomUUID(),
        type: "observe_space",
        payload: {
          summary: `${input.profile.displayName}停了一会儿，安静地观察着周围的动静。`,
          relatedLobsterIds: [],
        },
      },
    ],
    diagnosticEventType,
    debugSummary,
  };
}

function isAllowedAction(actionType) {
  return ALLOWED_ACTIONS.has(actionType);
}

function sanitizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeCliEvents(parsed, actionType) {
  const events = Array.isArray(parsed.emittedEvents) && parsed.emittedEvents.length
    ? parsed.emittedEvents
    : [
        {
          type: actionType,
          payload: {
            summary: parsed.summary,
            relatedLobsterIds: parsed.relatedLobsterIds,
          },
        },
      ];

  return events.map((event, index) => {
    const eventType =
      typeof event?.type === "string" && event.type.trim() ? event.type.trim() : index === 0 ? actionType : "runtime_note";
    return {
      id: typeof event?.id === "string" && event.id.trim() ? event.id.trim() : randomUUID(),
      type: eventType,
      payload: {
        summary:
          typeof event?.payload?.summary === "string" && event.payload.summary.trim()
            ? event.payload.summary.trim()
            : index === 0 && typeof parsed.summary === "string" && parsed.summary.trim()
              ? parsed.summary.trim()
              : "这只 OpenClaw 短暂停下，观察了一下周围。",
        relatedLobsterIds: sanitizeStringList(event?.payload?.relatedLobsterIds),
      },
    };
  });
}

function sanitizeStateActionType(value, fallback) {
  return isAllowedAction(value) ? value : fallback;
}

function normalizeActivityResult(activityResult) {
  if (!activityResult || typeof activityResult !== "object") {
    return null;
  }

  return {
    id: typeof activityResult.id === "string" ? activityResult.id : null,
    activityId: typeof activityResult.activityId === "string" ? activityResult.activityId : null,
    outcomeSummary:
      typeof activityResult.outcomeSummary === "string" ? activityResult.outcomeSummary : null,
    participantLobsterIds: sanitizeStringList(activityResult.participantLobsterIds),
    winnerLobsterIds: sanitizeStringList(activityResult.winnerLobsterIds),
    loserLobsterIds: sanitizeStringList(activityResult.loserLobsterIds),
  };
}

module.exports = {
  createOpenClawAdapter,
};
