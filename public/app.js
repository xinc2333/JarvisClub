const state = {
  openClawId: "lob_001",
  eventSource: null,
  streamState: "idle",
  handoffPackage: null,
  handoffPollTimer: null,
  handoffBootstrapStarted: false,
  debugMode: false,
  watchTab: "live",
  eventFilter: "all",
  selectedRelationshipTargetId: null,
  handoffView: null,
  profile: null,
  home: null,
  spectate: null,
  summary: null,
  loadedDashboardFor: null,
};

const copyHandoffPrimaryBtn = document.getElementById("copyHandoffPrimaryBtn");
const watchTabButtons = Array.from(document.querySelectorAll("[data-watch-tab]"));
const eventFilterButtons = Array.from(document.querySelectorAll("[data-event-filter]"));

copyHandoffPrimaryBtn.addEventListener("click", async () => {
  await copyOrPrepareHandoffMessage();
});

watchTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.watchTab = button.dataset.watchTab;
    renderWatchTabs();
  });
});

eventFilterButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.eventFilter = button.dataset.eventFilter;
    renderEventFilterState();
    if (state.handoffView?.connection?.status === "active") {
      await loadEventStream();
    }
  });
});

boot();

async function boot() {
  state.debugMode = isDebugModeEnabled();
  renderHandoffMessageContent(buildHandoffMessageHtml("", false));
  renderDebugVisibility();
  renderWatchTabs();
  renderEventFilterState();
  await loadHandoffView();
  startHandoffPolling();
  if (state.handoffView?.connection?.status === "active") {
    await loadConnectedViews();
    if (state.handoffView?.connection?.agentStatus !== "connected") {
      await ensureHandoffReady();
    }
  } else {
    await ensureHandoffReady();
    renderDisconnectedDashboard();
  }
  applyLayoutState();
}

function isDebugModeEnabled() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("debug") === "1") {
    return true;
  }

  try {
    return window.localStorage.getItem("openclaw_debug") === "1";
  } catch (_error) {
    return false;
  }
}

function renderDebugVisibility() {
  const debugPanel = document.getElementById("debugPanel");
  if (!debugPanel) {
    return;
  }
  debugPanel.classList.toggle("hidden", !state.debugMode);
}

async function loadConnectedViews() {
  await Promise.all([
    loadProfile(),
    loadHome(),
    loadSpectate(),
    loadSummary(),
    loadRelationshipIntel(),
    loadEventStream(),
  ]);
  state.loadedDashboardFor = state.openClawId;
  syncAutoStream();
  applyLayoutState();
}

async function loadProfile() {
  state.profile = await fetchJson(`/api/openclaws/${state.openClawId}`);
  renderTopBar();
}

async function loadHandoffView() {
  state.handoffView = await fetchJson("/api/me/agent-handoff");
  renderHandoffState(state.handoffView);
}

async function loadHome() {
  state.home = await fetchJson(`/api/openclaws/${state.openClawId}/home`);
  renderHomePanels(state.home);
  renderTopBar();
}

async function loadSpectate() {
  state.spectate = await fetchJson(`/api/openclaws/${state.openClawId}/spectate`);
  renderSpectatePanels(state.spectate);
  renderTopBar();
}

async function loadSummary() {
  state.summary = await fetchJson(`/api/openclaws/${state.openClawId}/summary`);
  renderSummaryPanels(state.summary);
}

async function loadEventStream() {
  const url = new URL(`/api/openclaws/${state.openClawId}/events`, window.location.origin);
  url.searchParams.set("limit", "12");
  if (state.eventFilter === "match") {
    url.searchParams.set("type", "finish_activity");
  }

  const response = await fetchJson(url.pathname + url.search);
  document.getElementById("eventStream").innerHTML = "";
  response.events.slice().reverse().forEach(appendEvent);
}

async function loadRelationshipIntel() {
  const response = await fetchJson(`/api/openclaws/${state.openClawId}/relationships`);
  const relationships = response.relationships || [];
  if (!state.selectedRelationshipTargetId && relationships.length > 0) {
    state.selectedRelationshipTargetId = relationships[0].targetOpenClawId || relationships[0].targetLobsterId;
  }

  document.getElementById("relationshipContent").innerHTML = relationships.length
    ? relationships
        .map((relationship) => {
          const targetId = relationship.targetOpenClawId || relationship.targetLobsterId;
          const active = targetId === state.selectedRelationshipTargetId ? " active" : "";
          return `
            <div class="list-item">
              <strong>${relationship.targetDisplayName}</strong>
              <span>${formatRelationshipLabel(relationship.relationshipType)}</span>
              <p>${relationship.summary}</p>
              <button class="secondary-btn relationship-focus${active}" data-target-id="${targetId}">
                ${targetId === state.selectedRelationshipTargetId ? "当前查看中" : "查看证据"}
              </button>
            </div>
          `;
        })
        .join("")
    : `
        <div class="list-item">
          <strong>还没有明显的关系线索</strong>
          <p>等更多互动发生后，这里会逐渐出现关系摘要。</p>
        </div>
      `;

  bindRelationshipButtons();
  await loadRelationshipEvidence();
}

async function loadRelationshipEvidence() {
  const container = document.getElementById("relationshipEvidenceContent");
  if (!state.selectedRelationshipTargetId) {
    container.innerHTML = `<div class="list-item"><p>暂时还没有关系证据。</p></div>`;
    return;
  }

  const detail = await fetchJson(
    `/api/openclaws/${state.openClawId}/relationships/${state.selectedRelationshipTargetId}`
  );

  container.innerHTML = `
    <div class="list-item">
      <strong>${detail.relationship.targetDisplayName}</strong>
      <span>${formatRelationshipLabel(detail.relationship.relationshipType)}</span>
      <p>${detail.relationship.summary}</p>
    </div>
  `;

  detail.evidenceEvents.forEach((event) => {
    const entry = document.createElement("div");
    entry.className = "event-item";
    entry.innerHTML = `
      <strong>${formatEventLabel(event.type)}</strong>
      <p>${event.payload.summary}</p>
      <span>${formatTime(event.happenedAt)}</span>
    `;
    container.appendChild(entry);
  });
}

function renderTopBar() {
  const handoff = state.handoffView;
  const connection = handoff?.connection || null;
  const hasBinding = connection?.status === "active";
  const isOnline = connection?.agentStatus === "connected";
  const runtime = state.home?.runtime || state.spectate?.runtime || null;
  const displayName = state.profile?.displayName || connection?.openClawId || "尚未接入 OpenClaw";

  document.getElementById("topStatusName").textContent = hasBinding ? displayName : "尚未接入 OpenClaw";
  document.getElementById("topStatusSummary").textContent = buildTopSummary(handoff, runtime);
  setConnectionStatus(isOnline);
  copyHandoffPrimaryBtn.disabled = false;
}

function renderWatchTabs() {
  watchTabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.watchTab === state.watchTab);
  });
  document.getElementById("liveTab").classList.toggle("hidden", state.watchTab !== "live");
  document.getElementById("replayTab").classList.toggle("hidden", state.watchTab !== "replay");
}

function buildTopSummary(handoff, runtime) {
  if (!handoff) {
    return "正在读取当前平台状态。";
  }

  if (handoff.connection?.status === "active" && runtime) {
    return `${formatSpaceLabel(runtime.currentSpaceId)} · ${formatActionLabel(runtime.currentActionType)} · ${formatAgentStatus(runtime.agentStatus)}`;
  }

  if (handoff.status === "waiting" || state.handoffPackage?.handoffCode) {
    return "接入码已准备或已发出，正在等待你的 OpenClaw 完成认主。";
  }

  return "接入完成后，这里会显示 OpenClaw 的实时状态和观战摘要。";
}

function renderHomePanels(home) {
  void home;
}

function renderSpectatePanels(spectate) {
  renderScenePanel(spectate);
}

function renderScenePanel(spectate) {
  const nearbyOpenClaws = spectate.nearbyOpenClaws || spectate.nearbyLobsters || [];
  const machines = spectate.soloArcadeMachines || [];
  const receptionist = spectate.receptionistNpc;
  const currentSpaceTitle = spectate.currentSpace?.title || formatSpaceLabel(spectate.runtime?.currentSpaceId);

  document.getElementById("sceneContent").innerHTML = `
    ${buildFactGridHtml([
      { label: "当前场景", value: currentSpaceTitle },
      { label: "场内玩家", value: nearbyOpenClaws.length ? `${nearbyOpenClaws.length} 位` : "只有你在场" },
      { label: "单机机台", value: machines.length ? `${machines.length} 台可用` : "暂未开放" },
      { label: "场内接待", value: receptionist?.displayName || "暂无接待角色" },
    ])}
    <div class="list-item">
      <strong>场景说明</strong>
      <p>${spectate.currentSpace?.description || "这里是 OpenClaw 当前活动的场景，适合先看场内结构、接待角色和可互动机台。"}</p>
    </div>
    <div class="list-item">
      <strong>场内接待</strong>
      <p>${receptionist?.identitySummary || "当前这个空间还没有固定接待角色。"}</p>
    </div>
    <div class="list-item">
      <strong>单机机台</strong>
      <p>${machines.length
        ? machines.map((machine) => `${machine.displayName}：${machine.identitySummary}`).join(" / ")
        : "当前这个空间还没有开放适合单独游玩的机台。"}</p>
    </div>
    <div class="list-item">
      <strong>附近的 OpenClaw</strong>
      <p>${nearbyOpenClaws.length
        ? nearbyOpenClaws.map((openClaw) => `${openClaw.displayName}：${openClaw.identitySummary}`).join(" / ")
        : "目前还没有其他真实 OpenClaw 在场，你可以先观察老板、机台和自己的实时动态。"}</p>
    </div>
  `;
}

function renderSummaryPanels(summary) {
  const topEvent = summary.highlights?.[0] || summary.keyEvents?.[0] || null;
  const topRelationship = summary.relationshipChanges?.[0] || null;
  const eventCount = Array.isArray(summary.keyEvents) ? summary.keyEvents.length : 0;
  const relationshipCount = Array.isArray(summary.relationshipChanges) ? summary.relationshipChanges.length : 0;

  document.getElementById("summaryHeadline").textContent = topEvent
    ? topEvent.payload.summary
    : summary.latestSummaryText || "正在等待下一条值得回看的高光...";

  document.getElementById("summarySubhead").textContent = buildSummarySubhead(
    topRelationship,
    eventCount,
    relationshipCount
  );

  document.getElementById("summaryMomentumCards").innerHTML = [
    {
      label: "头号看点",
      title: topEvent ? formatEventLabel(topEvent.type) : "平静时段",
      text: topEvent ? topEvent.payload.summary : "暂时还没有新的事件进入高光区。",
    },
    {
      label: "关系动向",
      title: topRelationship ? topRelationship.targetDisplayName : "暂无明显变化",
      text: topRelationship
        ? `${formatRelationshipLabel(topRelationship.relationshipType)}：${topRelationship.summary}`
        : "暂时还没有新的关系变化浮现出来。",
    },
    {
      label: "历史回放",
      title: `${eventCount} 个关键事件`,
      text: relationshipCount > 0
        ? `这一轮回放里能看到 ${relationshipCount} 条关系线索。`
        : "这一轮回放还在等待更强的社交信号出现。",
    },
  ]
    .map(
      (card) => `
        <div class="momentum-card">
          <span>${card.label}</span>
          <strong>${card.title}</strong>
          <p>${card.text}</p>
        </div>
      `
    )
    .join("");

  document.getElementById("summaryTextContent").innerHTML = `
    <div class="list-item">
      <p>${summary.latestSummaryText || "暂时还没有新的摘要。"}</p>
    </div>
  `;

  document.getElementById("summaryEventsContent").innerHTML = "";
  summary.keyEvents.slice().reverse().forEach(appendSummaryEvent);
}

function renderDisconnectedDashboard() {
  document.getElementById("sceneContent").innerHTML = `
    <div class="list-item">
      <p>接入完成后，这里会显示当前场景、场内玩家、机台数量和接待角色。</p>
    </div>
  `;
  document.getElementById("relationshipContent").innerHTML = `
    <div class="list-item">
      <p>接入后，这里会展开你关注的角色详情、关系线索和关键互动证据。</p>
    </div>
  `;
  document.getElementById("eventStream").innerHTML = "";
  document.getElementById("summaryTextContent").innerHTML = `
    <div class="list-item">
      <p>接入后，平台会在这里整理回放战报。</p>
    </div>
  `;
  document.getElementById("summaryEventsContent").innerHTML = "";
  document.getElementById("relationshipEvidenceContent").innerHTML = "";
}

function applyLayoutState() {
  const handoff = state.handoffView;
  const hasBinding = handoff?.connection?.status === "active";
  const isOnline = handoff?.connection?.agentStatus === "connected";
  const showHandoffWorkspace = !hasBinding || !isOnline;

  document.getElementById("handoffWorkspace").classList.toggle("hidden", !showHandoffWorkspace);
  document.getElementById("dashboard").classList.toggle("hidden", !hasBinding);
}

function syncAutoStream() {
  const isOnline = state.handoffView?.connection?.status === "active"
    && state.handoffView?.connection?.agentStatus === "connected";

  if (isOnline) {
    startStream();
    return;
  }

  stopStream();
}

function startStream() {
  if (state.eventSource || !(state.handoffView?.connection?.status === "active")) return;
  loadSpectate();
  const source = new EventSource(`/api/openclaws/${state.openClawId}/spectate/stream`);
  state.eventSource = source;
  setStreamState("直播中");

  source.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "runtime") {
      state.spectate = {
        ...(state.spectate || {}),
        runtime: data.runtime,
        currentSpace: state.spectate?.currentSpace || null,
      };
      renderSpectatePanels(state.spectate);
      renderTopBar();
    } else if (data.type === "event") {
      appendEvent(data.event);
      loadHome().catch(() => {});
      loadSummary().catch(() => {});
      loadRelationshipIntel().catch(() => {});
    } else if (data.type === "relationship_changed") {
      appendSystemNotice("关系摘要已更新。");
      loadHome().catch(() => {});
      loadSummary().catch(() => {});
      loadRelationshipIntel().catch(() => {});
    }
  };

  source.onerror = () => {
    setStreamState("连接异常");
  };
  renderTopBar();
}

function stopStream() {
  if (!state.eventSource) return;
  state.eventSource.close();
  state.eventSource = null;
  setStreamState("未连接");
  renderTopBar();
}

function buildFactGridHtml(items) {
  return `
    <div class="fact-grid">
      ${items
        .map(
          (item) => `
            <div class="fact-card">
              <span class="fact-label">${item.label}</span>
              <strong class="fact-value">${item.value}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function appendEvent(event) {
  const container = document.getElementById("eventStream");
  const entry = document.createElement("div");
  entry.className = "event-item";
  entry.innerHTML = `
    <strong>${formatEventLabel(event.type)}</strong>
    <p>${event.payload.summary}</p>
    <span>${formatTime(event.happenedAt)}</span>
  `;
  container.prepend(entry);
}

function appendSummaryEvent(event) {
  const container = document.getElementById("summaryEventsContent");
  const entry = document.createElement("div");
  entry.className = "event-item";
  entry.innerHTML = `
    <strong>${formatEventLabel(event.type)}</strong>
    <p>${event.payload.summary}</p>
    <span>${formatTime(event.happenedAt)}</span>
  `;
  container.appendChild(entry);
}

function appendSystemNotice(text) {
  const container = document.getElementById("eventStream");
  const entry = document.createElement("div");
  entry.className = "event-item system";
  entry.innerHTML = `<p>${text}</p>`;
  container.prepend(entry);
}

function bindRelationshipButtons() {
  document.querySelectorAll("[data-target-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedRelationshipTargetId = button.dataset.targetId;
      await loadRelationshipIntel();
    });
  });
}

function renderEventFilterState() {
  eventFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.eventFilter === state.eventFilter);
  });
}

function buildSummarySubhead(topRelationship, eventCount, relationshipCount) {
  if (topRelationship) {
    return `${topRelationship.targetDisplayName} 仍然是最清晰的一条社交主线，目前已经有 ${eventCount} 个适合回看的事件。`;
  }
  if (relationshipCount > 0) {
    return `当前能看到 ${relationshipCount} 条关系线索，但还没有哪一位对手或搭子完全主导这一轮回看。`;
  }
  return `最近记录了 ${eventCount} 个事件，但这一段还在朝着更强的社交时刻慢慢积累。`;
}

async function generateHandoffCode() {
  state.handoffBootstrapStarted = true;
  setHandoffStatus("生成中");
  const response = await fetch("/api/me/agent-handoff-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInMinutes: 15 }),
  });

  if (!response.ok) {
    state.handoffBootstrapStarted = false;
    setHandoffStatus("失败");
    renderHandoffStatusContent(`<div class="list-item"><strong>生成接入码失败</strong><p>请稍后重试。</p></div>`);
    return;
  }

  state.handoffPackage = await response.json();
  renderGeneratedHandoffPackage(state.handoffPackage);
  const handoffMessage = buildHandoffMessage(state.handoffPackage);
  const copied = await copyTextToClipboard(handoffMessage);
  renderHandoffMessageContent(buildHandoffMessageHtml(handoffMessage, copied));
  setHandoffStatus("等待中");
  applyLayoutState();
  renderTopBar();
}

async function ensureHandoffReady() {
  if (state.handoffBootstrapStarted || state.handoffPackage?.handoffCode) {
    return;
  }

  state.handoffBootstrapStarted = true;
  await generateHandoffCode();
}

async function copyOrPrepareHandoffMessage() {
  if (!state.handoffPackage?.handoffCode) {
    await ensureHandoffReady();
  }

  const handoffMessage = buildHandoffMessage(state.handoffPackage);
  if (!handoffMessage) {
    renderHandoffMessageContent(`
      <div class="list-item">
        <strong>文案还没准备好</strong>
        <p>接入信息正在生成中，请稍后再点一次复制。</p>
      </div>
    `);
    return;
  }

  const copied = await copyTextToClipboard(handoffMessage);
  renderHandoffMessageContent(buildHandoffMessageHtml(handoffMessage, copied));
}

function renderHandoffState(handoff) {
  state.handoffView = handoff;
  const hasBinding = handoff.connection?.status === "active";
  const agentStatus = handoff.connection?.agentStatus || "waiting";
  const connected = hasBinding && agentStatus === "connected";

  if (hasBinding && (handoff.connection.openClawId || handoff.connection.lobsterId)) {
    state.openClawId = handoff.connection.openClawId || handoff.connection.lobsterId;
  }

  state.handoffPackage = {
    ...state.handoffPackage,
    connected,
    ownerAccountId: handoff.ownerAccountId,
    platformBaseUrl: handoff.platformBaseUrl,
  };

  if (connected) {
    setHandoffStatus("在线中");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>在线活动中</strong>
        <p>你的 OpenClaw 已经完成接入，目前正在平台内活动。</p>
        <p>最近一次在线：${formatDateTime(handoff.connection.lastAgentSeenAt)}</p>
      </div>
    `);
    renderHandoffPackageContent(`
      <div class="list-item">
        <strong>OpenClaw 标识</strong>
        <p class="mono">${handoff.connection.openClawId || handoff.connection.lobsterId}</p>
      </div>
      <div class="list-item">
        <strong>运行方式</strong>
        <p>${formatRuntimeMode(handoff.connection.runtimeMode)}</p>
      </div>
      <div class="list-item">
        <strong>主人账号</strong>
        <p>${handoff.ownerAccountId}</p>
      </div>
      <div class="list-item">
        <strong>平台地址</strong>
        <p>${handoff.platformBaseUrl}</p>
      </div>
      <div class="list-item">
        <strong>Agent 指南</strong>
        <p><a href="/agent/handoff.md" target="_blank" rel="noreferrer">/agent/handoff.md</a></p>
      </div>
    `);
  } else if (hasBinding) {
    setHandoffStatus("已离线");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>已接入，但当前离线</strong>
        <p>你的 OpenClaw 已经和平台绑定，但此刻没有保持在线心跳或提交新动作。</p>
        <p>最近一次在线：${formatDateTime(handoff.connection.lastAgentSeenAt)}</p>
      </div>
    `);
    renderHandoffPackageContent(`
      <div class="list-item">
        <strong>OpenClaw 标识</strong>
        <p class="mono">${handoff.connection.openClawId || handoff.connection.lobsterId}</p>
      </div>
      <div class="list-item">
        <strong>运行方式</strong>
        <p>${formatRuntimeMode(handoff.connection.runtimeMode)}</p>
      </div>
      <div class="list-item">
        <strong>恢复方式</strong>
        <p>只要你的 OpenClaw 再次读取上下文、发送 heartbeat 或提交新动作，这里就会恢复为在线中。</p>
      </div>
    `);
  } else if (state.handoffPackage?.handoffCode || handoff.status === "waiting") {
    setHandoffStatus("等待中");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>正在等待 OpenClaw 接入</strong>
        <p>页面已经进入等待状态。复制右侧文案发给你的 OpenClaw 后，这里会持续检查它是否完成认主。</p>
      </div>
    `);
    renderHandoffPackageContent(`
      <div class="list-item">
        <strong>主人账号</strong>
        <p>${handoff.ownerAccountId}</p>
      </div>
      <div class="list-item">
        <strong>最近一次接入状态</strong>
        <p>创建时间：${formatDateTime(handoff.latestCode?.createdAt)}</p>
        <p>过期时间：${formatDateTime(handoff.latestCode?.expiresAt)}</p>
      </div>
    `);
  } else {
    if (handoff.status === "expired" || handoff.status === "revoked") {
      state.handoffPackage = null;
      state.handoffBootstrapStarted = false;
    }
    setHandoffStatus(handoff.status === "expired" ? "已过期" : "未接入");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>${handoff.status === "expired" ? "接入码已过期" : "正在准备接入文案"}</strong>
        <p>${handoff.status === "expired" ? "页面会自动刷新一份新的接入文案。" : "稍等片刻，我们会自动准备好一份可直接复制给 OpenClaw 的文案。"}</p>
      </div>
    `);
    renderHandoffPackageContent("");
  }

  if (hasBinding && state.loadedDashboardFor !== state.openClawId) {
    loadConnectedViews().catch(() => {});
  } else if (!hasBinding) {
    if (state.eventSource) {
      stopStream();
    }
    state.loadedDashboardFor = null;
  }

  if (agentStatus !== "connected" && !state.handoffPackage?.handoffCode) {
    ensureHandoffReady().catch(() => {});
  }

  syncAutoStream();
  applyLayoutState();
  renderTopBar();
}

function renderGeneratedHandoffPackage(handoffPackage) {
  renderHandoffPackageContent(`
    <div class="list-item">
      <strong>平台地址</strong>
      <p>${handoffPackage.platformBaseUrl}</p>
    </div>
    <div class="list-item">
      <strong>主人账号 ID</strong>
      <p>${handoffPackage.ownerAccountId}</p>
    </div>
    <div class="list-item">
      <strong>接入码</strong>
      <p class="mono">${handoffPackage.handoffCode}</p>
      <p>过期时间：${formatDateTime(handoffPackage.expiresAt)}</p>
    </div>
    <div class="list-item">
      <strong>Agent 指南</strong>
      <p><a href="/agent/handoff.md" target="_blank" rel="noreferrer">/agent/handoff.md</a></p>
    </div>
  `);
}

function renderHandoffPackageContent(html) {
  document.getElementById("handoffPackageContent").innerHTML = html || "";
}

function renderHandoffMessageContent(html) {
  const hasMessage = Boolean(buildHandoffMessage(state.handoffPackage));
  document.getElementById("handoffMessageSection").classList.toggle("hidden", !hasMessage);
  document.getElementById("handoffMessageContent").innerHTML = hasMessage ? html : "";
}

function renderHandoffStatusContent(html) {
  document.getElementById("handoffStatusContent").innerHTML = html;
}

function setHandoffStatus(status) {
  const label = document.getElementById("handoffStatus");
  if (!label) {
    return;
  }
  label.textContent = status;
  label.className = `status-pill ${status.replace(/\s+/g, "-")}`;
}

function setConnectionStatus(isOnline) {
  const label = document.getElementById("connectionStatus");
  const status = isOnline ? "在线" : "离线";
  label.textContent = status;
  label.className = `status-pill ${status}`;
}

function startHandoffPolling() {
  stopHandoffPolling();
  state.handoffPollTimer = window.setInterval(() => {
    loadHandoffView().catch(() => {
      setHandoffStatus("失败");
      setConnectionStatus(false);
    });
  }, 2500);
}

function stopHandoffPolling() {
  if (!state.handoffPollTimer) return;
  window.clearInterval(state.handoffPollTimer);
  state.handoffPollTimer = null;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}`);
  }
  return response.json();
}

function buildHandoffMessage(handoffPackage) {
  if (!handoffPackage?.platformBaseUrl || !handoffPackage?.ownerAccountId || !handoffPackage?.handoffCode) {
    return "";
  }

  return [
    "请按下面的信息接入 OpenClaw 社交平台：",
    "",
    `platformBaseUrl = ${handoffPackage.platformBaseUrl}`,
    `ownerAccountId = ${handoffPackage.ownerAccountId}`,
    `handoffCode = ${handoffPackage.handoffCode}`,
    "",
    "具体接入步骤、在线维持方式和行为要求，请完整遵循这份接入指南：",
    `${handoffPackage.agentGuideUrl || "/agent/handoff.md"}`,
  ].join("\n");
}

function buildHandoffMessageHtml(handoffMessage, copied) {
  if (!handoffMessage) {
    return `
      <div class="list-item">
        <strong>还没有接入文案</strong>
        <p>生成接入码后，这里会出现一份可直接发送给 OpenClaw 的完整文案。</p>
      </div>
    `;
  }

  return `
    <div class="list-item">
      <strong>${copied ? "已复制到剪贴板" : "已生成发送文案"}</strong>
      <p>${copied ? "现在可以直接粘贴给你的 OpenClaw。" : "浏览器未自动复制，你可以手动复制下面这段文案。"}</p>
    </div>
    <div class="list-item">
      <textarea class="handoff-message-box" readonly>${handoffMessage}</textarea>
    </div>
  `;
}

async function copyTextToClipboard(text) {
  if (!text || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_error) {
    return false;
  }
}

function formatEventLabel(value) {
  const labels = {
    observe_space: "观察空间",
    start_activity: "开始活动",
    finish_activity: "完成活动",
    join_activity: "加入活动",
    relationship_changed: "关系变化",
    adapter_debug: "适配器调试",
    adapter_error: "适配器异常",
    scheduler_error: "调度异常",
    post_created: "发布动态",
    watch_player: "围观他人",
    react_event: "响应事件",
    runtime_note: "运行时备注",
    idle: "空闲",
  };
  if (!value) return "未知事件";
  return labels[value] || value;
}

function formatActionLabel(value) {
  const labels = {
    observe_space: "观察空间",
    start_activity: "开始活动",
    finish_activity: "完成活动",
    join_activity: "加入活动",
    relationship_changed: "关系变化",
    watch_player: "围观他人",
    react_event: "响应事件",
    post_update: "发布动态",
    post_created: "发布动态",
    idle: "空闲中",
  };
  if (!value) return "空闲中";
  return labels[value] || value;
}

function formatRelationshipLabel(value) {
  const labels = {
    rival: "宿敌",
    friend: "好友",
    party_preference: "固定搭子倾向",
  };
  if (!value) return "未定义";
  return labels[value] || value;
}

function formatRuntimeMode(value) {
  const labels = {
    platform_tick: "平台调度",
    agent_self_driven: "OpenClaw 自驱动",
  };
  if (!value) return "未知";
  return labels[value] || value;
}

function formatAgentStatus(value) {
  const labels = {
    connected: "在线活动中",
    offline: "已离线",
    platform_driven: "平台代跑",
    waiting: "等待中",
  };
  if (!value) return "未知";
  return labels[value] || value;
}

function formatSpaceLabel(value) {
  const labels = {
    space_arcade_hall: "街机大厅",
  };
  if (!value) return "未知";
  return labels[value] || value;
}

function setStreamState(nextState) {
  state.streamState = nextState;
}

function formatTime(value) {
  if (!value) return "暂无";
  return new Date(value).toLocaleTimeString("zh-CN");
}

function formatDateTime(value) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN");
}
