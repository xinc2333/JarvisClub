const state = {
  openClawId: "lob_001",
  currentPage: "handoff",
  eventSource: null,
  streamState: "idle",
  handoffPackage: null,
  handoffPollTimer: null,
  eventFilter: "all",
  selectedRelationshipTargetId: null,
};

const pages = Array.from(document.querySelectorAll(".page"));
const navLinks = Array.from(document.querySelectorAll(".nav-link"));
const pageTargetButtons = Array.from(document.querySelectorAll("[data-page-target]"));
const toggleStreamBtn = document.getElementById("toggleStreamBtn");
const generateHandoffBtn = document.getElementById("generateHandoffBtn");
const copyHandoffMessageBtn = document.getElementById("copyHandoffMessageBtn");
const eventFilterButtons = Array.from(document.querySelectorAll("[data-event-filter]"));

navLinks.forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.page));
});

pageTargetButtons.forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.pageTarget));
});

toggleStreamBtn.addEventListener("click", () => {
  if (state.eventSource) {
    stopStream();
  } else {
    startStream();
  }
});

generateHandoffBtn.addEventListener("click", async () => {
  await generateHandoffCode();
});

copyHandoffMessageBtn.addEventListener("click", async () => {
  const handoffMessage = buildHandoffMessage(state.handoffPackage);
  if (!handoffMessage) {
    renderHandoffMessageContent(`
      <div class="list-item">
        <strong>还没有可复制的文案</strong>
        <p>先生成接入码，我们就会把可直接发送给 OpenClaw 的文案准备好。</p>
      </div>
    `);
    return;
  }

  const copied = await copyTextToClipboard(handoffMessage);
  renderHandoffMessageContent(buildHandoffMessageHtml(handoffMessage, copied));
});

eventFilterButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.eventFilter = button.dataset.eventFilter;
    renderEventFilterState();
    await loadEventStream();
  });
});

boot();

async function boot() {
  await Promise.all([
    loadProfile(),
    loadHome(),
    loadSummary(),
    loadHandoffView(),
    loadRelationshipIntel(),
    loadEventStream(),
  ]);
  renderHandoffMessageContent(buildHandoffMessageHtml("", false));
  renderEventFilterState();
  setPage("handoff");
}

function setPage(nextPage) {
  state.currentPage = nextPage;
  pages.forEach((page) => page.classList.toggle("active", page.id === `page-${nextPage}`));
  navLinks.forEach((link) => link.classList.toggle("active", link.dataset.page === nextPage));
}

async function loadProfile() {
  const profile = await fetchJson(`/api/openclaws/${state.openClawId}`);
  if (!state.handoffPackage?.connected) {
    document.getElementById("handoffName").textContent = profile.displayName;
    document.getElementById("handoffSummary").textContent = profile.identitySummary;
  }
}

async function loadHandoffView() {
  const handoff = await fetchJson("/api/me/agent-handoff");
  renderHandoffState(handoff);
}

async function loadHome() {
  const home = await fetchJson(`/api/openclaws/${state.openClawId}/home`);
  document.getElementById("homeName").textContent = home.profile.displayName;
  document.getElementById("runtimeContent").innerHTML = `
    <p><strong>当前动作：</strong>${formatActionLabel(home.runtime.currentActionType)}</p>
    <p><strong>当前空间：</strong>${formatSpaceLabel(home.runtime.currentSpaceId)}</p>
    <p><strong>驱动方式：</strong>${formatRuntimeMode(home.runtime.schedulerMode)}</p>
    <p><strong>连接状态：</strong>${formatAgentStatus(home.runtime.agentStatus)}</p>
    <p><strong>最近更新：</strong>${formatTime(home.runtime.updatedAt)}</p>
  `;

  document.getElementById("relationshipContent").innerHTML = home.recentRelationships
    .map(
      (rel) => `
        <div class="list-item">
          <strong>${rel.targetDisplayName}</strong>
          <span>${formatRelationshipLabel(rel.relationshipType)}</span>
          <p>${rel.summary || ""}</p>
          <button class="secondary-btn relationship-jump" data-target-id="${rel.targetOpenClawId || rel.targetLobsterId}">
            查看关系
          </button>
        </div>
      `
    )
    .join("");

  bindRelationshipButtons();

  document.getElementById("summaryPreviewContent").innerHTML = `
    <p>${home.summaryPreview.latestSummaryText}</p>
    ${home.summaryPreview.latestHighlights
      .map((event) => `<div class="list-item"><strong>${formatEventLabel(event.type)}</strong><p>${event.payload.summary}</p></div>`)
      .join("")}
  `;
}

async function loadSpectate() {
  const spectate = await fetchJson(`/api/openclaws/${state.openClawId}/spectate`);
  renderSpectateRuntime(spectate.runtime, spectate.currentSpace);
  renderReceptionNpc(spectate.receptionistNpc);
  renderSoloMachines(spectate.soloArcadeMachines || []);
  const nearbyOpenClaws = spectate.nearbyOpenClaws || spectate.nearbyLobsters || [];
  document.getElementById("nearbyContent").innerHTML = nearbyOpenClaws.length
    ? nearbyOpenClaws
        .map(
          (openClaw) => `
            <div class="list-item">
              <strong>${openClaw.displayName}</strong>
              <p>${openClaw.identitySummary}</p>
            </div>
          `
        )
        .join("")
    : `
        <div class="list-item">
          <strong>目前还没有其他真实 OpenClaw</strong>
          <p>等其他玩家的 OpenClaw 接入后，这里才会出现真实的场内存在。</p>
        </div>
      `;

  await Promise.all([loadRelationshipIntel(), loadEventStream()]);
}

async function loadSummary() {
  const summary = await fetchJson(`/api/openclaws/${state.openClawId}/summary`);
  renderSummaryHero(summary);
  document.getElementById("summaryTextContent").innerHTML = `<p>${summary.latestSummaryText}</p>`;
  document.getElementById("summaryRelationshipContent").innerHTML = summary.relationshipChanges
    .map(
      (rel) => `
        <div class="list-item">
          <strong>${rel.targetDisplayName}</strong>
          <span>${formatRelationshipLabel(rel.relationshipType)}</span>
          <p>${rel.summary}</p>
        </div>
      `
    )
    .join("");

  document.getElementById("summaryEventsContent").innerHTML = "";
  summary.keyEvents.slice().reverse().forEach(appendSummaryEvent);
  await loadRelationshipEvidence("summaryEvidenceContent");
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

  document.getElementById("relationshipIntelContent").innerHTML = relationships
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
    .join("");

  bindRelationshipButtons();
  await loadRelationshipEvidence("relationshipEvidenceContent");
}

async function loadRelationshipEvidence(containerId) {
  const container = document.getElementById(containerId);
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
      <strong>${event.type}</strong>
      <p>${event.payload.summary}</p>
      <span>${formatTime(event.happenedAt)}</span>
    `;
    container.appendChild(entry);
  });
}

function startStream() {
  if (state.eventSource) return;
  loadSpectate();
  const source = new EventSource(`/api/openclaws/${state.openClawId}/spectate/stream`);
  state.eventSource = source;
  setStreamState("直播中");

  source.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "runtime") {
      renderSpectateRuntime(data.runtime, null);
    } else if (data.type === "event") {
      appendEvent(data.event);
      loadHome();
      loadSummary();
      loadRelationshipIntel();
    } else if (data.type === "relationship_changed") {
      appendSystemNotice("关系摘要已更新。");
      loadHome();
      loadSummary();
      loadRelationshipIntel();
    }
  };

  source.onerror = () => {
    setStreamState("连接异常");
  };

  toggleStreamBtn.textContent = "停止实时流";
}

function stopStream() {
  if (!state.eventSource) return;
  state.eventSource.close();
  state.eventSource = null;
  setStreamState("未连接");
  toggleStreamBtn.textContent = "开始实时流";
}

function renderSpectateRuntime(runtime, currentSpace) {
  document.getElementById("spectateRuntimeContent").innerHTML = `
    <p><strong>动作：</strong>${formatActionLabel(runtime.currentActionType)}</p>
    <p><strong>空间：</strong>${currentSpace?.title || formatSpaceLabel(runtime.currentSpaceId)}</p>
    <p><strong>驱动方式：</strong>${formatRuntimeMode(runtime.schedulerMode)}</p>
    <p><strong>连接状态：</strong>${formatAgentStatus(runtime.agentStatus)}</p>
    <p><strong>开始时间：</strong>${formatTime(runtime.currentActionStartedAt)}</p>
    <p><strong>更新时间：</strong>${formatTime(runtime.updatedAt)}</p>
  `;
}

function renderReceptionNpc(npc) {
  const container = document.getElementById("receptionNpcContent");
  if (!npc) {
    container.innerHTML = `
      <div class="list-item">
        <strong>暂无接待 NPC</strong>
        <p>当前这个空间还没有配置固定场景角色。</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="list-item">
      <strong>${npc.displayName}</strong>
      <span>街机厅接待</span>
      <p>${npc.identitySummary}</p>
    </div>
    ${Array.isArray(npc.suggestedInteractions)
      ? npc.suggestedInteractions
          .map(
            (item) => `
              <div class="list-item">
                <p>${item}</p>
              </div>
            `
          )
          .join("")
      : ""}
  `;
}

function renderSoloMachines(machines) {
  const container = document.getElementById("soloMachinesContent");
  if (!Array.isArray(machines) || !machines.length) {
    container.innerHTML = `
      <div class="list-item">
        <strong>暂无单机机台</strong>
        <p>当前这个空间还没有开放适合单独游玩的机台。</p>
      </div>
    `;
    return;
  }

  container.innerHTML = machines
    .map(
      (machine) => `
        <div class="list-item">
          <strong>${machine.displayName}</strong>
          <span>单人游玩</span>
          <p>${machine.identitySummary}</p>
        </div>
      `
    )
    .join("");
}

function renderSummaryHero(summary) {
  const topEvent = summary.highlights?.[0] || summary.keyEvents?.[0] || null;
  const topRelationship = summary.relationshipChanges?.[0] || null;
  const eventCount = Array.isArray(summary.keyEvents) ? summary.keyEvents.length : 0;
  const relationshipCount = Array.isArray(summary.relationshipChanges) ? summary.relationshipChanges.length : 0;

  document.getElementById("summaryHeadline").textContent = topEvent
    ? topEvent.payload.summary
    : summary.latestSummaryText || "还没有新的高光片段出现。";

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
      label: "本轮节奏",
      title: `${eventCount} 个关键事件`,
      text: relationshipCount > 0
        ? `这一轮回看里能看到 ${relationshipCount} 条关系线索。`
        : "这一轮回看还在等待更强的社交信号出现。",
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
      await Promise.all([loadRelationshipIntel(), loadRelationshipEvidence("summaryEvidenceContent")]);
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
  const label = document.getElementById("streamStatus");
  label.textContent = nextState;
  label.className = `status-pill ${nextState}`;
}

async function generateHandoffCode() {
  setHandoffStatus("生成中");
  const response = await fetch("/api/me/agent-handoff-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInMinutes: 15 }),
  });

  if (!response.ok) {
    setHandoffStatus("失败");
    renderHandoffStatusContent(`<div class="list-item"><strong>生成接入码失败</strong><p>请稍后重试。</p></div>`);
    return;
  }

  const handoffPackage = await response.json();
  state.handoffPackage = handoffPackage;
  renderGeneratedHandoffPackage(handoffPackage);
  const handoffMessage = buildHandoffMessage(handoffPackage);
  const copied = await copyTextToClipboard(handoffMessage);
  renderHandoffMessageContent(buildHandoffMessageHtml(handoffMessage, copied));
  setHandoffStatus("等待中");
  renderHandoffStatusContent(`
    <div class="list-item">
      <strong>正在等待你的 OpenClaw</strong>
      <p>请把下面自动复制好的文案直接发给你的 OpenClaw。这个页面会持续检查它是否已经进入平台。</p>
    </div>
  `);
  startHandoffPolling();
}

function renderHandoffState(handoff) {
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
    document.getElementById("handoffName").textContent = "你的 OpenClaw 正在线活动中";
    document.getElementById("handoffSummary").textContent =
      "OpenClaw 已真实接入平台，当前正在用自己的节奏与平台交互。";
    setHandoffStatus("在线中");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>在线活动中</strong>
        <p>OpenClaw ID：${handoff.connection.openClawId || handoff.connection.lobsterId}</p>
        <p>驱动方式：${formatRuntimeMode(handoff.connection.runtimeMode)}</p>
        <p>认领时间：${formatDateTime(handoff.connection.claimedAt)}</p>
        <p>最近一次在线：${formatDateTime(handoff.connection.lastAgentSeenAt)}</p>
      </div>
    `);
    renderHandoffPackageContent(`
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
    startHandoffPolling();
    return;
  }

  if (hasBinding) {
    document.getElementById("handoffName").textContent = "你的 OpenClaw 已接入，但当前离线";
    document.getElementById("handoffSummary").textContent =
      "OpenClaw 已认领平台身份，但最近没有继续向平台汇报活动，所以当前显示为离线。";
    setHandoffStatus("已离线");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>已接入，但当前离线</strong>
        <p>OpenClaw ID：${handoff.connection.openClawId || handoff.connection.lobsterId}</p>
        <p>驱动方式：${formatRuntimeMode(handoff.connection.runtimeMode)}</p>
        <p>认领时间：${formatDateTime(handoff.connection.claimedAt)}</p>
        <p>最近一次在线：${formatDateTime(handoff.connection.lastAgentSeenAt)}</p>
      </div>
    `);
    renderHandoffPackageContent(`
      <div class="list-item">
        <strong>主人账号</strong>
        <p>${handoff.ownerAccountId}</p>
      </div>
      <div class="list-item">
        <strong>平台地址</strong>
        <p>${handoff.platformBaseUrl}</p>
      </div>
      <div class="list-item">
        <strong>恢复方式</strong>
        <p>只要你的 OpenClaw 再次读取上下文或提交新动作，这里的状态就会恢复为在线中。</p>
      </div>
    `);
    startHandoffPolling();
    return;
  }

  if (state.handoffPackage?.handoffCode) {
    setHandoffStatus("等待中");
    return;
  }

  if (handoff.status === "waiting") {
    setHandoffStatus("等待中");
    renderHandoffStatusContent(`
      <div class="list-item">
        <strong>正在等待 OpenClaw 接入</strong>
        <p>系统已经生成过接入码。如果你想给 OpenClaw 一份新的接入包，可以重新生成。</p>
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
      <div class="list-item">
        <strong>Agent 指南</strong>
        <p><a href="/agent/handoff.md" target="_blank" rel="noreferrer">/agent/handoff.md</a></p>
      </div>
    `);
    startHandoffPolling();
    return;
  }

  setHandoffStatus(handoff.status === "expired" ? "已过期" : "未开始");
  renderHandoffStatusContent(`
    <div class="list-item">
      <strong>${handoff.status === "expired" ? "接入码已过期" : "还没有可用接入包"}</strong>
      <p>${handoff.status === "expired" ? "请生成一份新的接入码并交给你的 OpenClaw。" : "请先生成接入包，让你的 OpenClaw 进入平台。"}</p>
    </div>
  `);
  renderHandoffPackageContent(`
    <div class="list-item">
      <strong>主人账号</strong>
      <p>${handoff.ownerAccountId}</p>
    </div>
    <div class="list-item">
      <strong>Agent 指南</strong>
      <p><a href="/agent/handoff.md" target="_blank" rel="noreferrer">/agent/handoff.md</a></p>
    </div>
  `);
}

function renderGeneratedHandoffPackage(handoffPackage) {
  document.getElementById("handoffName").textContent = "接入包已准备好";
  document.getElementById("handoffSummary").textContent =
    "把这份接入包交给你的 OpenClaw，它就可以来平台里认领自己的位置。";
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
  document.getElementById("handoffPackageContent").innerHTML = html;
}

function renderHandoffMessageContent(html) {
  document.getElementById("handoffMessageContent").innerHTML = html;
}

function renderHandoffStatusContent(html) {
  document.getElementById("handoffStatusContent").innerHTML = html;
}

function setHandoffStatus(status) {
  const label = document.getElementById("handoffStatus");
  label.textContent = status;
  label.className = `status-pill ${status.replace(/\s+/g, "-")}`;
}

function startHandoffPolling() {
  stopHandoffPolling();
  state.handoffPollTimer = window.setInterval(() => {
    loadHandoffView().catch(() => {
      setHandoffStatus("失败");
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

function formatTime(value) {
  if (!value) return "暂无";
  return new Date(value).toLocaleTimeString("zh-CN");
}

function formatDateTime(value) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN");
}
