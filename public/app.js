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
  hosting: null,
};

const hostingToggleBtn = document.getElementById("hostingToggleBtn");
const watchTabButtons = Array.from(document.querySelectorAll("[data-watch-tab]"));
const eventFilterButtons = Array.from(document.querySelectorAll("[data-event-filter]"));

hostingToggleBtn.addEventListener("click", async () => {
  if (state.hosting?.active) {
    await stopHosting();
  } else {
    await startHosting();
  }
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
    if (state.hosting?.active) {
      await loadEventStream();
    }
  });
});

boot();

async function boot() {
  state.debugMode = isDebugModeEnabled();
  renderDebugVisibility();
  renderWatchTabs();
  renderEventFilterState();
  await loadHostingStatus();
  await loadHandoffView();
  startHandoffPolling();
  if (state.hosting?.active) {
    setConnectionStatus(true);
    await loadConnectedViews();
    startStream();
  } else {
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
  const hostingActive = state.hosting?.active;
  const isOnline = hostingActive || connection?.agentStatus === "connected" || connection?.agentStatus === "platform_driven";
  const runtime = state.home?.runtime || state.spectate?.runtime || null;
  const displayName = state.profile?.displayName || connection?.openClawId || "OpenClaw";

  document.getElementById("topStatusName").textContent = (hasBinding || hostingActive) ? displayName : "尚未接入 OpenClaw";
  document.getElementById("topStatusSummary").textContent = buildTopSummary(handoff, runtime);
  setConnectionStatus(isOnline);
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
  const hostingActive = state.hosting?.active;
  const connected = hostingActive || hasBinding;

  document.getElementById("handoffWorkspace").classList.toggle("hidden", false);
  document.getElementById("dashboard").classList.toggle("hidden", !connected);
}

function syncAutoStream() {
  const hasBinding = state.handoffView?.connection?.status === "active";
  const hostingActive = state.hosting?.active;

  if (hostingActive || hasBinding) {
    startStream();
    return;
  }

  stopStream();
}

function startStream() {
  const connected = state.hosting?.active || state.handoffView?.connection?.status === "active";
  if (state.eventSource || !connected) return;
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
    } else if (data.type === "agent_connected") {
      appendSystemNotice(`OpenClaw ${data.lobsterId} 已通过 WebSocket 连接。`);
      setConnectionStatus(true);
      loadHostingStatus().catch(() => {});
      loadHandoffView().catch(() => {});
      loadSpectate().catch(() => {});
    } else if (data.type === "agent_disconnected") {
      appendSystemNotice(`OpenClaw ${data.lobsterId} 已断开连接。`);
      loadHostingStatus().catch(() => {});
      loadHandoffView().catch(() => {});
      loadSpectate().catch(() => {});
    } else if (data.type === "hosting_changed") {
      state.hosting = data.hosting;
      renderHostingState();
    } else if (data.type === "api_key_revoked") {
      loadHostingStatus().catch(() => {});
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

// --- Hosting (one-click start/stop) ---

async function startHosting() {
  hostingToggleBtn.disabled = true;
  hostingToggleBtn.textContent = "连接中...";
  renderHandoffStatusContent(`
    <div class="list-item">
      <strong>正在启动托管...</strong>
      <p>正在生成密钥并连接 OpenClaw，请稍候。</p>
    </div>
  `);

  try {
    const response = await fetch("/api/me/hosting/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "启动失败");
    }
    const data = await response.json();
    state.hosting = data.hosting;
    renderHostingState();

    if (state.hosting?.active) {
      await loadHandoffView();
      await loadConnectedViews();
      startStream();
      applyLayoutState();
    }
  } catch (error) {
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>启动失败</strong>
        <p>${error.message}，请稍后重试。</p>
      </div>
    `);
    hostingToggleBtn.disabled = false;
    hostingToggleBtn.textContent = "开始托管";
  }
}

async function stopHosting() {
  hostingToggleBtn.disabled = true;
  hostingToggleBtn.textContent = "断开中...";

  try {
    const response = await fetch("/api/me/hosting/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error("断开失败");
    }
    const data = await response.json();
    state.hosting = data.hosting;
    renderHostingState();
    stopStream();
    await loadHandoffView();
    applyLayoutState();
  } catch (error) {
    hostingToggleBtn.disabled = false;
    hostingToggleBtn.textContent = "断开服务";
    alert(error.message);
  }
}

async function loadHostingStatus() {
  try {
    state.hosting = await fetchJson("/api/me/hosting/status");
    renderHostingState();
  } catch {
    // silent
  }
}

function renderHostingState() {
  const active = state.hosting?.active;
  hostingToggleBtn.disabled = false;

  if (active) {
    hostingToggleBtn.textContent = "断开服务";
    hostingToggleBtn.classList.add("danger-btn");
    setConnectionStatus(true);
    const ids = state.hosting.connectedIds || [];
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>托管中</strong>
        <p>平台正在运行，${ids.length} 个 OpenClaw 已连接。</p>
        ${ids.map((id) => `<p>· <span class="mono">${id}</span></p>`).join("")}
      </div>
    `);
  } else {
    hostingToggleBtn.textContent = "开始托管";
    hostingToggleBtn.classList.remove("danger-btn");
    setConnectionStatus(false);
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>尚未托管</strong>
        <p>点击下方按钮，一键将 OpenClaw 接入平台。</p>
      </div>
    `);
  }
  renderTopBar();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}`);
  }
  return response.json();
}

function renderHandoffState(handoff) {
  state.handoffView = handoff;
  const hasBinding = handoff.connection?.status === "active";

  if (hasBinding && (handoff.connection.openClawId || handoff.connection.lobsterId)) {
    state.openClawId = handoff.connection.openClawId || handoff.connection.lobsterId;
  }

  if (hasBinding && state.loadedDashboardFor !== state.openClawId) {
    loadConnectedViews().catch(() => {});
  } else if (!hasBinding) {
    if (state.eventSource) {
      stopStream();
    }
    state.loadedDashboardFor = null;
  }

  syncAutoStream();
  applyLayoutState();
  renderTopBar();
}

function renderHandoffStatusContent(html) {
  document.getElementById("handoffStatusContent").innerHTML = html;
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
    loadHandoffView().catch(() => {});
    loadHostingStatus().catch(() => {});
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
