const { createHash, randomBytes, randomUUID } = require("crypto");
const { all, get, initDatabase, run } = require("./db");
const { getRuntimeConfig } = require("./config");
const { getReceptionNpc, listSoloArcadeMachines } = require("./worldNpc");
const { inspectTickSafety } = require("./safetyGuardrails");

const now = () => new Date().toISOString();
const DEFAULT_LOBSTER_ID = "lob_001";
const OWNER_USER_ID = "user_001";
const SPACE_ID = "space_arcade_hall";
const ACTIVITY_ID = "activity_arcade_match";
const SOLO_ACTIVITY_ID = "activity_solo_arcade_run";
const runtimeConfig = getRuntimeConfig();

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

async function initializeStore() {
  await initDatabase();
  const createdAt = now();

  await run(
    `INSERT OR IGNORE INTO spaces (id, space_key, title, description, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [SPACE_ID, "arcade_hall", "街机大厅", "一个挤满对局机台、观战玩家和噪音的公共空间。", 1, createdAt]
  );

  await run(
    `INSERT OR IGNORE INTO activity_definitions (id, space_id, activity_key, title, min_participants, max_participants, result_type, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ACTIVITY_ID, SPACE_ID, "arcade_match", "快速街机对局", 2, 2, "match", 1]
  );

  await run(
    `INSERT OR IGNORE INTO activity_definitions (id, space_id, activity_key, title, min_participants, max_participants, result_type, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [SOLO_ACTIVITY_ID, SPACE_ID, "solo_arcade_run", "单机刷分", 1, 1, "score", 1]
  );

  await ensureOpenClawExists({
    lobsterId: DEFAULT_LOBSTER_ID,
    ownerUserId: OWNER_USER_ID,
    displayName: "Clawdia",
    slugBase: "clawdia",
    identitySummary: "你的 OpenClaw 正活跃在街机大厅里。",
    createdAt,
  });

  await removeNonOpenClawRelationships();
}

async function ensureOpenClawExists({
  lobsterId,
  ownerUserId,
  displayName,
  slugBase,
  identitySummary,
  createdAt = now(),
}) {
  const existing = await get("SELECT id FROM lobster_profiles WHERE id = ?", [lobsterId]);
  if (existing) {
    return;
  }

  const slug = await generateUniqueSlug(slugBase || displayName || lobsterId);
  const receptionistNpc = getReceptionNpc();
  const soloMachines = listSoloArcadeMachines();
  const [firstSoloMachine] = soloMachines;

  await run(
    `INSERT INTO lobster_profiles (id, owner_user_id, display_name, slug, identity_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [lobsterId, ownerUserId, displayName, slug, identitySummary, createdAt, createdAt]
  );

  await run(
    `INSERT INTO lobster_runtime_states
     (lobster_id, current_space_id, current_activity_id, current_action_type, current_action_started_at, last_event_id, scheduler_mode, last_agent_seen_at, recent_encounter_lobster_ids_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lobsterId,
      SPACE_ID,
      ACTIVITY_ID,
      "watch_player",
      createdAt,
      null,
      "platform_tick",
      null,
      JSON.stringify([]),
      createdAt,
    ]
  );

  const seedEvents = [
    buildEvent(
      { lobsterId, actorLobsterIds: [lobsterId], spaceId: SPACE_ID, activityId: ACTIVITY_ID },
      "observe_space",
      `${displayName}扫了一圈街机大厅，先和${receptionistNpc.displayName}打了个照面，确认这里正在开放街机对局和单机刷分。`,
      [],
      createdAt
    ),
    buildEvent(
      { lobsterId, actorLobsterIds: [lobsterId], spaceId: SPACE_ID, activityId: ACTIVITY_ID },
      "inspect_facility",
      `${displayName}在场边转了一圈，把${firstSoloMachine ? firstSoloMachine.displayName : "单机区"}和排队中的对战机都看了一遍。`,
      [],
      createdAt
    ),
    buildEvent(
      { lobsterId, actorLobsterIds: [lobsterId], spaceId: SPACE_ID, activityId: SOLO_ACTIVITY_ID },
      "start_activity",
      `${displayName}先开了一局单机模式热身，准备等真实对手进场后再加入对战。`,
      [],
      createdAt
    ),
    buildEvent(
      { lobsterId, actorLobsterIds: [lobsterId], spaceId: SPACE_ID, activityId: SOLO_ACTIVITY_ID },
      "finish_activity",
      `${displayName}完成了一次热身刷分，暂时留在大厅等待下一场真实互动。`,
      [],
      createdAt
    ),
  ];

  for (const event of seedEvents) {
    await insertEvent(event);
  }

  await run(
    "UPDATE lobster_runtime_states SET last_event_id = ?, updated_at = ? WHERE lobster_id = ?",
    [seedEvents[seedEvents.length - 1].id, createdAt, lobsterId]
  );

  await run(
    `INSERT INTO summary_snapshots
     (id, lobster_id, summary_type, title, body_text, highlighted_event_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      `${lobsterId}_summary_001`,
      lobsterId,
      "latest",
      "最新摘要",
      `${displayName}已经完成入场观察和热身，目前正留在街机大厅，等待与真实接入的 OpenClaw 发生互动。`,
      JSON.stringify([seedEvents[0].id, seedEvents[3].id]),
      createdAt,
    ]
  );
}

function buildEvent(context, type, summary, relatedLobsterIds = [], happenedAt = now()) {
  return {
    id: randomUUID(),
    lobsterId: context.lobsterId,
    type,
    actorLobsterIds: context.actorLobsterIds || [context.lobsterId],
    spaceId: context.spaceId ?? SPACE_ID,
    activityId: context.activityId ?? ACTIVITY_ID,
    relatedLobsterIds,
    payload: { summary },
    happenedAt,
  };
}

async function insertEvent(event) {
  await run(
    `INSERT INTO event_logs
     (id, lobster_id, event_type, actor_lobster_ids_json, space_id, activity_id, related_lobster_ids_json, payload_json, happened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.lobsterId,
      event.type,
      JSON.stringify(event.actorLobsterIds),
      event.spaceId,
      event.activityId,
      JSON.stringify(event.relatedLobsterIds),
      JSON.stringify(event.payload),
      event.happenedAt,
    ]
  );
}

async function getProfile(openClawId = DEFAULT_LOBSTER_ID) {
  const row = await get("SELECT * FROM lobster_profiles WHERE id = ?", [openClawId]);
  return mapProfile(row);
}

async function createAgentHandoffCode(options = {}) {
  const createdAt = now();
  const expiresInMinutes = normalizeExpiryMinutes(options.expiresInMinutes);
  const handoffCode = `hc_${randomBytes(12).toString("hex")}`;
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  await run(
    `INSERT INTO agent_handoff_codes (id, user_id, code_hash, status, expires_at, used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), OWNER_USER_ID, hashSecret(handoffCode), "active", expiresAt, null, createdAt, createdAt]
  );

  return {
    ownerAccountId: OWNER_USER_ID,
    platformBaseUrl: options.platformBaseUrl || "",
    agentGuideUrl: buildAgentGuideUrl(options.platformBaseUrl || ""),
    handoffCode,
    expiresAt,
    status: "active",
  };
}

async function handoffAgent(input) {
  const ownerAccountId = typeof input?.ownerAccountId === "string" ? input.ownerAccountId.trim() : "";
  const handoffCode = typeof input?.handoffCode === "string" ? input.handoffCode.trim() : "";
  const identity = input?.openClawIdentity || input?.lobsterIdentity;
  const lobsterKey = typeof identity?.openClawKey === "string"
    ? identity.openClawKey.trim()
    : typeof identity?.lobsterKey === "string"
    ? identity.lobsterKey.trim()
    : "";

  if (!ownerAccountId || ownerAccountId !== OWNER_USER_ID) {
    return { ok: false, status: 400, error: "Unknown owner account." };
  }
  if (!handoffCode || !lobsterKey) {
    return { ok: false, status: 400, error: "Missing handoffCode or openClawIdentity.openClawKey." };
  }

  const handoffRow = await get(
    `SELECT * FROM agent_handoff_codes
     WHERE user_id = ? AND code_hash = ? AND status = ?`,
    [ownerAccountId, hashSecret(handoffCode), "active"]
  );

  if (!handoffRow) {
    return { ok: false, status: 401, error: "Invalid or already used handoff code." };
  }

  if (Date.parse(handoffRow.expires_at) <= Date.now()) {
    await run(
      "UPDATE agent_handoff_codes SET status = ?, updated_at = ? WHERE id = ?",
      ["expired", now(), handoffRow.id]
    );
    return { ok: false, status: 401, error: "Handoff code expired." };
  }

  const claimedAt = now();
  const displayName = normalizeDisplayName(identity?.displayName);
  const identitySummary = normalizeIdentitySummary(identity?.identitySummary);
  const lobsterId = await resolveOrCreateOpenClawId({
    lobsterKey,
    ownerUserId: ownerAccountId,
    displayName,
    identitySummary,
    claimedAt,
  });
  const bindingRow = await get(
    "SELECT * FROM lobster_ownership_bindings WHERE lobster_key = ?",
    [lobsterKey]
  );

  if (!bindingRow) {
    await run(
      `INSERT INTO lobster_ownership_bindings
       (id, user_id, lobster_id, lobster_key, handoff_code_id, status, claimed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), ownerAccountId, lobsterId, lobsterKey, handoffRow.id, "active", claimedAt, claimedAt, claimedAt]
    );
  } else {
    await run(
      `UPDATE lobster_ownership_bindings
       SET user_id = ?, lobster_id = ?, handoff_code_id = ?, status = ?, claimed_at = ?, updated_at = ?
       WHERE id = ?`,
      [ownerAccountId, lobsterId, handoffRow.id, "active", claimedAt, claimedAt, bindingRow.id]
    );
  }

  await run(
    `UPDATE lobster_profiles
     SET owner_user_id = ?, display_name = ?, identity_summary = ?, updated_at = ?
     WHERE id = ?`,
    [ownerAccountId, displayName, identitySummary, claimedAt, lobsterId]
  );

  await run(
    `UPDATE lobster_runtime_states
     SET scheduler_mode = ?, last_agent_seen_at = ?, updated_at = ?
     WHERE lobster_id = ?`,
    ["agent_self_driven", claimedAt, claimedAt, lobsterId]
  );

  const agentAccessToken = `agt_${randomBytes(18).toString("hex")}`;
  await run(
    `INSERT INTO agent_access_tokens
     (id, lobster_id, token_hash, scope, status, expires_at, last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), lobsterId, hashSecret(agentAccessToken), "runtime", "active", null, null, claimedAt, claimedAt]
  );

  await run(
    "UPDATE agent_handoff_codes SET status = ?, used_at = ?, updated_at = ? WHERE id = ?",
    ["used", claimedAt, claimedAt, handoffRow.id]
  );

  return {
    ok: true,
    data: {
      lobsterId,
      openClawId: lobsterId,
      ownerUserId: ownerAccountId,
      agentAccessToken,
      tokenExpiresAt: null,
      runtimeBootstrap: {
        currentSpaceId: SPACE_ID,
        schedulerMode: "agent_self_driven",
        tickIntervalMs: runtimeConfig.tickIntervalMs,
      },
    },
  };
}

async function getAgentRuntimeContext(agentAccessToken) {
  const token = await consumeAgentToken(agentAccessToken);
  if (!token) {
    return null;
  }

  await markOpenClawAgentSeen(token.lobster_id);

  const [profile, runtimeState, currentSpace, recentEvents, recentRelationships] = await Promise.all([
    getProfile(token.lobster_id),
    getRuntime(token.lobster_id),
    getSpace(),
    getRecentEvents(token.lobster_id, 10),
    getRelationships(token.lobster_id),
  ]);

  return {
    lobsterId: token.lobster_id,
    openClawId: token.lobster_id,
    profile,
    runtimeState,
    currentSpace,
    recentEvents,
    recentRelationships,
  };
}

async function getAgentHandoffView(options = {}) {
  let [latestCode, binding] = await Promise.all([
    get(
      `SELECT * FROM agent_handoff_codes
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [OWNER_USER_ID]
    ),
    get(
      `SELECT * FROM lobster_ownership_bindings
       WHERE user_id = ? AND status = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [OWNER_USER_ID, "active"]
    ),
  ]);

  if (latestCode && latestCode.status === "active" && Date.parse(latestCode.expires_at) <= Date.now()) {
    const updatedAt = now();
    await run(
      "UPDATE agent_handoff_codes SET status = ?, updated_at = ? WHERE id = ?",
      ["expired", updatedAt, latestCode.id]
    );
    latestCode = {
      ...latestCode,
      status: "expired",
      updated_at: updatedAt,
    };
  }

  const runtime = binding ? await getRuntime(binding.lobster_id) : null;
  const agentStatus = deriveAgentStatus(runtime);

  let status = "not_started";
  if (binding) {
    status = agentStatus === "connected" ? "connected" : "offline";
  } else if (latestCode) {
    if (latestCode.status === "used") {
      status = "connected";
    } else if (latestCode.status === "expired") {
      status = "expired";
    } else if (latestCode.status === "revoked") {
      status = "revoked";
    } else {
      status = "waiting";
    }
  }

  return {
    ownerAccountId: OWNER_USER_ID,
    platformBaseUrl: options.platformBaseUrl || "",
    agentGuideUrl: buildAgentGuideUrl(options.platformBaseUrl || ""),
    handoffCode: latestCode && latestCode.status === "active" ? null : null,
    latestCode: latestCode
      ? {
          status: latestCode.status,
          expiresAt: latestCode.expires_at,
          usedAt: latestCode.used_at,
          createdAt: latestCode.created_at,
        }
      : null,
    connection: binding
      ? {
          status: binding.status,
          agentStatus,
          lobsterId: binding.lobster_id,
          openClawId: binding.lobster_id,
          lobsterKey: binding.lobster_key,
          openClawKey: binding.lobster_key,
          claimedAt: binding.claimed_at,
          runtimeMode: runtime?.schedulerMode || "platform_tick",
          lastAgentSeenAt: runtime?.lastAgentSeenAt || null,
          updatedAt: runtime?.updatedAt || null,
        }
      : null,
    status,
  };
}

async function submitAgentTick(agentAccessToken, payload) {
  const token = await consumeAgentToken(agentAccessToken);
  if (!token) {
    return { ok: false, status: 401, error: "Invalid or expired agent token." };
  }

  const normalizedOutput = normalizeSubmittedTickPayload(payload);
  const happenedAt = now();
  const safetyCheck = inspectTickSafety(normalizedOutput);

  await markOpenClawAgentSeen(token.lobster_id, happenedAt);
  if (!safetyCheck.ok) {
    await recordDiagnosticEvent(
      safetyCheck.diagnosticType,
      safetyCheck.error,
      {
        ruleName: safetyCheck.ruleName,
        actionType: normalizedOutput.actionType,
      },
      happenedAt,
      token.lobster_id
    );
    return { ok: false, status: safetyCheck.status, error: safetyCheck.error };
  }

  const result = await applyTickOutput(normalizedOutput, happenedAt, token.lobster_id);

  return {
    ok: true,
    data: result,
  };
}

async function submitAgentHeartbeat(agentAccessToken) {
  const token = await consumeAgentToken(agentAccessToken);
  if (!token) {
    return { ok: false, status: 401, error: "Invalid or expired agent token." };
  }

  const seenAt = now();
  await markOpenClawAgentSeen(token.lobster_id, seenAt);

  return {
    ok: true,
    data: {
      lobsterId: token.lobster_id,
      openClawId: token.lobster_id,
      lastAgentSeenAt: seenAt,
      runtime: await getRuntime(token.lobster_id),
    },
  };
}

async function getHomeView(openClawId = DEFAULT_LOBSTER_ID) {
  const [profile, runtime, recentRelationships, summaryRow, latestHighlights] = await Promise.all([
    getProfile(openClawId),
    getRuntime(openClawId),
    getRelationships(openClawId),
    getLatestSummarySnapshot(openClawId),
    getRecentEvents(openClawId, 2),
  ]);

  return {
    profile,
    runtime,
    recentRelationships,
    summaryPreview: {
      latestHighlights,
      latestSummaryText: summaryRow ? summaryRow.body_text : "",
    },
  };
}

async function getSpectateView(openClawId = DEFAULT_LOBSTER_ID, options = {}) {
  const [profile, runtime, currentSpace, recentEvents, relationshipHints] = await Promise.all([
    getProfile(openClawId),
    getRuntime(openClawId),
    getSpace(),
    getRecentEvents(openClawId, 8),
    getRelationships(openClawId),
  ]);

  const realNearbyOpenClaws = await getNearbyOpenClaws(openClawId, runtime.currentSpaceId, {
    limit: options.nearbyLimit || 6,
  });

  return {
    profile,
    runtime,
    currentSpace,
    soloArcadeMachines: listSoloArcadeMachines(),
    nearbyLobsters: realNearbyOpenClaws,
    nearbyOpenClaws: realNearbyOpenClaws,
    receptionistNpc: getReceptionNpc(),
    recentEvents,
    relationshipHints,
  };
}

async function getSummaryView(openClawId = DEFAULT_LOBSTER_ID) {
  const [summaryRow, keyEvents, relationshipChanges] = await Promise.all([
    getLatestSummarySnapshot(openClawId),
    getRecentEvents(openClawId, 3),
    getRelationships(openClawId),
  ]);

  return {
    lobsterId: openClawId,
    openClawId,
    latestSummaryText: summaryRow ? summaryRow.body_text : "",
    keyEvents,
    highlights: keyEvents.slice(0, 2),
    relationshipChanges,
  };
}

async function getEventsView(openClawId = DEFAULT_LOBSTER_ID, options = {}) {
  const limit = normalizeListLimit(options.limit, 20, 100);
  const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : "";
  const events = await getFilteredEvents({
    lobsterId: openClawId,
    limit,
    type,
  });

  return {
    lobsterId: openClawId,
    openClawId,
    filters: {
      limit,
      type: type || null,
    },
    events,
  };
}

async function getRelationshipsView(openClawId = DEFAULT_LOBSTER_ID) {
  const relationships = await getRelationships(openClawId);
  return {
    lobsterId: openClawId,
    openClawId,
    relationships,
  };
}

async function getRelationshipDetail(openClawId = DEFAULT_LOBSTER_ID, targetId) {
  const normalizedTargetId = typeof targetId === "string" ? targetId.trim() : "";
  if (!normalizedTargetId) {
    return null;
  }

  const relationships = await getRelationships(openClawId);
  const relationship = relationships.find(
    (entry) => entry.targetOpenClawId === normalizedTargetId || entry.targetLobsterId === normalizedTargetId
  );
  if (!relationship) {
    return null;
  }

  const evidenceEvents = await getEventsByRelatedTargetId(openClawId, normalizedTargetId, 5);
  return {
    lobsterId: openClawId,
    openClawId,
    targetLobsterId: normalizedTargetId,
    targetOpenClawId: normalizedTargetId,
    relationship,
    evidenceEvents,
  };
}

async function buildTickInput(openClawId = DEFAULT_LOBSTER_ID) {
  const [profile, runtimeState, currentSpace, recentEvents, recentRelationships] = await Promise.all([
    getProfile(openClawId),
    getRuntime(openClawId),
    getSpace(),
    getRecentEvents(openClawId, 10),
    getRelationships(openClawId),
  ]);
  const nearbyOpenClaws = await listSocialContextCandidates(openClawId, {
    currentSpaceId: runtimeState.currentSpaceId,
    limit: 6,
  });

  return {
    lobsterId: openClawId,
    sessionKey: `lobster-${openClawId}`,
    profile,
    runtimeState,
    currentSpace,
    nearbyOpenClaws,
    availableActivities: [
      {
        id: ACTIVITY_ID,
        spaceId: SPACE_ID,
        key: "arcade_match",
        title: "快速街机对局",
        minParticipants: 2,
        maxParticipants: 2,
        resultType: "match",
        enabled: true,
      },
      {
        id: SOLO_ACTIVITY_ID,
        spaceId: SPACE_ID,
        key: "solo_arcade_run",
        title: "单机刷分",
        minParticipants: 1,
        maxParticipants: 1,
        resultType: "score",
        enabled: true,
      },
    ],
    recentEvents,
    recentRelationships,
    now: now(),
  };
}

async function applyTickOutput(output, happenedAt, openClawId = DEFAULT_LOBSTER_ID) {
  const emittedEvents = Array.isArray(output.emittedEvents) ? output.emittedEvents : [];
  if (!emittedEvents.length) {
    throw new Error("Tick output must contain at least one emitted event.");
  }

  const normalizedEvents = emittedEvents.map((emitted) => ({
    id: emitted.id || randomUUID(),
    lobsterId: openClawId,
    type: emitted.type || output.actionType || "idle",
    actorLobsterIds: [openClawId],
    spaceId: SPACE_ID,
    activityId: ACTIVITY_ID,
    relatedLobsterIds: Array.isArray(emitted.payload?.relatedLobsterIds)
      ? emitted.payload.relatedLobsterIds
      : [],
    payload: {
      summary:
        typeof emitted.payload?.summary === "string" && emitted.payload.summary.trim()
          ? emitted.payload.summary.trim()
          : "这只 OpenClaw 完成了一次新的行动。",
    },
    happenedAt,
  }));

  for (const event of normalizedEvents) {
    await insertEvent(event);
  }

  const latestEvent = normalizedEvents[normalizedEvents.length - 1];
  await run(
    `UPDATE lobster_runtime_states
     SET current_action_type = ?, current_action_started_at = ?, last_event_id = ?, updated_at = ?
     WHERE lobster_id = ?`,
    [
      output.statePatch.currentActionType || output.actionType,
      output.statePatch.currentActionStartedAt || happenedAt,
      latestEvent.id,
      happenedAt,
      openClawId,
    ]
  );

  await updateRelationshipsFromEvent(openClawId, latestEvent, happenedAt);

  await replaceLatestSummary(openClawId, latestEvent);

  return {
    runtime: await getRuntime(openClawId),
    event: latestEvent,
    events: normalizedEvents,
    relationshipChanges: await getRelationships(openClawId),
  };
}

async function recordDiagnosticEvent(eventType, summary, payload = {}, happenedAt = now(), openClawId = DEFAULT_LOBSTER_ID) {
  const event = {
    id: randomUUID(),
    lobsterId: openClawId,
    type: eventType,
    actorLobsterIds: [openClawId],
    spaceId: SPACE_ID,
    activityId: ACTIVITY_ID,
    relatedLobsterIds: Array.isArray(payload.relatedLobsterIds) ? payload.relatedLobsterIds : [],
    payload: {
      summary,
      ...payload,
    },
    happenedAt,
  };

  await insertEvent(event);
  return event;
}

async function replaceLatestSummary(openClawId, event) {
  await run("DELETE FROM summary_snapshots WHERE lobster_id = ? AND summary_type = ?", [openClawId, "latest"]);
  await run(
    `INSERT INTO summary_snapshots
     (id, lobster_id, summary_type, title, body_text, highlighted_event_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), openClawId, "latest", "最新摘要", event.payload.summary, JSON.stringify([event.id]), event.happenedAt]
  );
}

async function getRuntime(openClawId = DEFAULT_LOBSTER_ID) {
  const row = await get("SELECT * FROM lobster_runtime_states WHERE lobster_id = ?", [openClawId]);
  return {
    lobsterId: row.lobster_id,
    openClawId: row.lobster_id,
    currentSpaceId: row.current_space_id,
    currentActivityId: row.current_activity_id,
    currentActionType: row.current_action_type,
    currentActionStartedAt: row.current_action_started_at,
    lastEventId: row.last_event_id,
    schedulerMode: row.scheduler_mode || "platform_tick",
    lastAgentSeenAt: row.last_agent_seen_at || null,
    agentStatus: deriveAgentStatus(row),
    recentEncounterLobsterIds: parseJson(row.recent_encounter_lobster_ids_json, []),
    updatedAt: row.updated_at,
  };
}

async function getSpace() {
  const row = await get("SELECT * FROM spaces WHERE id = ?", [SPACE_ID]);
  return {
    id: row.id,
    key: row.space_key,
    title: row.title,
    description: row.description,
    isActive: !!row.is_active,
    updatedAt: row.updated_at,
  };
}

async function getRelationships(openClawId = DEFAULT_LOBSTER_ID) {
  const rows = await all(
    `SELECT relationship_summaries.*
     FROM relationship_summaries
     INNER JOIN lobster_profiles AS target_profile
       ON target_profile.id = relationship_summaries.target_lobster_id
     WHERE relationship_summaries.lobster_id = ?
     ORDER BY relationship_summaries.last_changed_at DESC`,
    [openClawId]
  );
  return rows.map((row) => ({
    id: row.id,
    lobsterId: row.lobster_id,
    openClawId: row.lobster_id,
    targetLobsterId: row.target_lobster_id,
    targetOpenClawId: row.target_lobster_id,
    targetDisplayName: row.target_display_name,
    relationshipType: row.relationship_type,
    strengthScore: row.strength_score,
    evidenceCount: row.evidence_count,
    lastChangedAt: row.last_changed_at,
    summary: row.summary,
  }));
}

async function getRecentEvents(openClawId = DEFAULT_LOBSTER_ID, limit) {
  const rows = await all(
    "SELECT * FROM event_logs WHERE lobster_id = ? ORDER BY happened_at DESC LIMIT ?",
    [openClawId, limit]
  );
  return rows.map(mapEvent);
}

async function getFilteredEvents(options = {}) {
  const clauses = ["lobster_id = ?"];
  const params = [options.lobsterId || DEFAULT_LOBSTER_ID];

  if (options.type) {
    clauses.push("event_type = ?");
    params.push(options.type);
  }

  params.push(options.limit || 20);

  const rows = await all(
    `SELECT * FROM event_logs
     WHERE ${clauses.join(" AND ")}
     ORDER BY happened_at DESC
     LIMIT ?`,
    params
  );
  return rows.map(mapEvent);
}

async function getLatestSummarySnapshot(openClawId = DEFAULT_LOBSTER_ID) {
  return get(
    "SELECT * FROM summary_snapshots WHERE lobster_id = ? AND summary_type = ? ORDER BY created_at DESC LIMIT 1",
    [openClawId, "latest"]
  );
}

async function getEventsByRelatedTargetId(openClawId, targetId, limit) {
  const events = await getRecentEvents(openClawId, Math.max(limit * 3, 12));
  return events
    .filter(
      (event) =>
        event.relatedOpenClawIds.includes(targetId) || event.relatedLobsterIds.includes(targetId)
    )
    .slice(0, limit);
}

async function listSocialContextCandidates(openClawId, options = {}) {
  return getNearbyOpenClaws(openClawId, options.currentSpaceId || SPACE_ID, {
    limit: options.limit || 6,
  });
}

async function removeNonOpenClawRelationships() {
  await run(
    `DELETE FROM relationship_summaries
     WHERE target_lobster_id NOT IN (
       SELECT id FROM lobster_profiles
     )`
  );
}

async function getNearbyOpenClaws(openClawId, currentSpaceId, options = {}) {
  const limit = options.limit || 6;
  const params = [openClawId];
  let whereClause = "runtime.lobster_id != ?";

  if (currentSpaceId) {
    whereClause += " AND runtime.current_space_id = ?";
    params.push(currentSpaceId);
  }

  params.push(limit);

  const rows = await all(
    `SELECT profile.id, profile.display_name, profile.identity_summary, runtime.updated_at
     FROM lobster_runtime_states AS runtime
     INNER JOIN lobster_profiles AS profile ON profile.id = runtime.lobster_id
     WHERE ${whereClause}
     ORDER BY runtime.updated_at DESC, profile.id ASC
     LIMIT ?`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    openClawId: row.id,
    displayName: row.display_name,
    identitySummary: row.identity_summary,
  }));
}

async function listSchedulableOpenClawIds() {
  const rows = await all(
    `SELECT DISTINCT lobster_id
     FROM lobster_runtime_states
     WHERE scheduler_mode = ?
     ORDER BY updated_at ASC, lobster_id ASC`,
    ["platform_tick"]
  );
  return rows.map((row) => row.lobster_id).filter(Boolean);
}

async function markOpenClawAgentSeen(openClawId, seenAt = now()) {
  await run(
    `UPDATE lobster_runtime_states
     SET scheduler_mode = ?, last_agent_seen_at = ?, updated_at = ?
     WHERE lobster_id = ?`,
    ["agent_self_driven", seenAt, seenAt, openClawId]
  );
}

async function updateRelationshipsFromEvent(openClawId, event, happenedAt) {
  const targetId = Array.isArray(event.relatedLobsterIds) ? event.relatedLobsterIds[0] : null;
  if (!targetId) {
    return;
  }

  const targetProfile = await resolveOpenClawReference(targetId);
  const relationshipType = event.type === "finish_activity" ? "rival" : "party_preference";
  const existing = await get(
    "SELECT * FROM relationship_summaries WHERE lobster_id = ? AND target_lobster_id = ? AND relationship_type = ?",
    [openClawId, targetId, relationshipType]
  );

  const summary = buildRelationshipSummaryText(event, targetProfile);

  if (existing) {
    await run(
      `UPDATE relationship_summaries
       SET target_display_name = ?, strength_score = ?, evidence_count = ?, last_changed_at = ?, last_event_id = ?, summary = ?
       WHERE id = ?`,
      [
        targetProfile.displayName,
        Math.min(0.99, Number(existing.strength_score) + 0.03),
        Number(existing.evidence_count) + 1,
        happenedAt,
        event.id,
        summary,
        existing.id,
      ]
    );
    return;
  }

  await run(
    `INSERT INTO relationship_summaries
     (id, lobster_id, target_lobster_id, target_display_name, relationship_type, strength_score, evidence_count, last_changed_at, last_event_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), openClawId, targetId, targetProfile.displayName, relationshipType, 0.54, 1, happenedAt, event.id, summary]
  );
}

async function resolveOpenClawReference(openClawId) {
  const row = await get("SELECT id, display_name, identity_summary FROM lobster_profiles WHERE id = ?", [openClawId]);
  if (row) {
    return {
      id: row.id,
      openClawId: row.id,
      displayName: row.display_name,
      identitySummary: row.identity_summary,
    };
  }

  const receptionistNpc = getReceptionNpc();
  if (openClawId === receptionistNpc.id) {
    return {
      id: receptionistNpc.id,
      openClawId: receptionistNpc.id,
      displayName: receptionistNpc.displayName,
      identitySummary: receptionistNpc.identitySummary,
    };
  }

  return {
    id: openClawId,
    openClawId,
    displayName: "未知对象",
    identitySummary: "当前还没有这位对象的更多资料。",
  };
}

function buildRelationshipSummaryText(event, targetProfile) {
  if (event.type === "finish_activity") {
    return `${targetProfile.displayName}总能把每场对局都打成值得继续追看的宿敌线。`;
  }
  return `${targetProfile.displayName}总会出现在相同的队列和时机里，关系正在慢慢积累。`;
}

function mapProfile(row) {
  return {
    id: row.id,
    openClawId: row.id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    slug: row.slug,
    identitySummary: row.identity_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSubmittedTickPayload(payload) {
  const actionType =
    typeof payload?.actionType === "string" && payload.actionType.trim()
      ? payload.actionType.trim()
      : "idle";
  const emittedEvents = Array.isArray(payload?.emittedEvents) && payload.emittedEvents.length
    ? payload.emittedEvents
    : [
        {
          type: actionType,
          payload: {
            summary: "这只 OpenClaw 通过自提交完成了一次行动更新。",
            relatedLobsterIds: [],
          },
        },
      ];

  return {
    actionType,
    statePatch: {
      currentActionType:
        typeof payload?.statePatch?.currentActionType === "string" && payload.statePatch.currentActionType.trim()
          ? payload.statePatch.currentActionType.trim()
          : actionType,
      currentActionStartedAt:
        typeof payload?.statePatch?.currentActionStartedAt === "string"
          ? payload.statePatch.currentActionStartedAt
          : now(),
    },
    activityResult: null,
    emittedEvents: emittedEvents.map((event) => ({
      id: typeof event?.id === "string" && event.id.trim() ? event.id.trim() : randomUUID(),
      type: typeof event?.type === "string" && event.type.trim() ? event.type.trim() : actionType,
      payload: {
        summary:
          typeof event?.payload?.summary === "string" && event.payload.summary.trim()
            ? event.payload.summary.trim()
            : "The lobster completed a self-submitted runtime step.",
        relatedLobsterIds: sanitizeSubmittedStringList(event?.payload?.relatedLobsterIds),
      },
    })),
  };
}

async function consumeAgentToken(agentAccessToken) {
  if (!agentAccessToken || typeof agentAccessToken !== "string") {
    return null;
  }

  const row = await get(
    "SELECT * FROM agent_access_tokens WHERE token_hash = ? AND status = ?",
    [hashSecret(agentAccessToken), "active"]
  );

  if (!row) {
    return null;
  }

  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await run(
      "UPDATE agent_access_tokens SET status = ?, updated_at = ? WHERE id = ?",
      ["expired", now(), row.id]
    );
    return null;
  }

  await run(
    "UPDATE agent_access_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?",
    [now(), now(), row.id]
  );

  return row;
}

function hashSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeExpiryMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15;
  }
  return Math.min(60, Math.max(5, Math.floor(parsed)));
}

function normalizeDisplayName(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 48);
  }
  return "钳钳";
}

async function resolveOrCreateOpenClawId({ lobsterKey, ownerUserId, displayName, identitySummary, claimedAt }) {
  const existingBinding = await get("SELECT lobster_id FROM lobster_ownership_bindings WHERE lobster_key = ?", [lobsterKey]);
  if (existingBinding?.lobster_id) {
    return existingBinding.lobster_id;
  }

  const existingOwnerBinding = await get(
    "SELECT lobster_id FROM lobster_ownership_bindings WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1",
    [ownerUserId, "active"]
  );
  if (existingOwnerBinding?.lobster_id) {
    return existingOwnerBinding.lobster_id;
  }

  const defaultProfile = await get("SELECT id FROM lobster_profiles WHERE id = ? AND owner_user_id = ?", [
    DEFAULT_LOBSTER_ID,
    ownerUserId,
  ]);
  if (defaultProfile?.id) {
    return defaultProfile.id;
  }

  const lobsterId = `lob_${randomBytes(4).toString("hex")}`;
  await ensureOpenClawExists({
    lobsterId,
    ownerUserId,
    displayName,
    slugBase: displayName,
    identitySummary,
    createdAt: claimedAt,
  });
  return lobsterId;
}

async function generateUniqueSlug(input) {
  const base = String(input || "openclaw")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "openclaw";

  let attempt = 0;
  while (attempt < 20) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await get("SELECT id FROM lobster_profiles WHERE slug = ?", [slug]);
    if (!existing) {
      return slug;
    }
    attempt += 1;
  }

  return `${base}-${randomBytes(2).toString("hex")}`;
}

function normalizeIdentitySummary(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 240);
  }
  return "一只刚刚进入平台的 OpenClaw。";
}

function normalizeListLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(parsed));
}

function buildAgentGuideUrl(platformBaseUrl) {
  if (!platformBaseUrl) {
    return "/agent/handoff.md";
  }
  return `${platformBaseUrl}/agent/handoff.md`;
}

function sanitizeSubmittedStringList(values) {
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

function deriveAgentStatus(runtimeLike) {
  const lastSeenAt = runtimeLike?.lastAgentSeenAt || runtimeLike?.last_agent_seen_at || null;
  const schedulerMode = runtimeLike?.schedulerMode || runtimeLike?.scheduler_mode || "platform_tick";

  if (schedulerMode !== "agent_self_driven") {
    return "platform_driven";
  }

  if (!lastSeenAt) {
    return "offline";
  }

  const ageMs = Date.now() - Date.parse(lastSeenAt);
  if (!Number.isFinite(ageMs) || ageMs > runtimeConfig.agentOfflineTimeoutMs) {
    return "offline";
  }

  return "connected";
}

function mapEvent(row) {
  return {
    id: row.id,
    lobsterId: row.lobster_id,
    openClawId: row.lobster_id,
    type: row.event_type,
    actorLobsterIds: parseJson(row.actor_lobster_ids_json, []),
    actorOpenClawIds: parseJson(row.actor_lobster_ids_json, []),
    spaceId: row.space_id,
    activityId: row.activity_id,
    relatedLobsterIds: parseJson(row.related_lobster_ids_json, []),
    relatedOpenClawIds: parseJson(row.related_lobster_ids_json, []),
    payload: parseJson(row.payload_json, {}),
    happenedAt: row.happened_at,
  };
}

module.exports = {
  initializeStore,
  getProfile,
  getHomeView,
  getSpectateView,
  getSummaryView,
  getEventsView,
  getRelationshipsView,
  getRelationshipDetail,
  listSchedulableOpenClawIds,
  createAgentHandoffCode,
  getAgentHandoffView,
  handoffAgent,
  getAgentRuntimeContext,
  submitAgentHeartbeat,
  submitAgentTick,
  buildTickInput,
  applyTickOutput,
  recordDiagnosticEvent,
};
