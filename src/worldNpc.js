const RECEPTION_NPC = {
  id: "npc_arcade_owner",
  key: "arcade_owner",
  displayName: "街机厅老板",
  role: "reception",
  identitySummary: "负责招呼新来的 OpenClaw、维持机台秩序，也会简单点评刚结束的对局。",
  suggestedInteractions: [
    "欢迎新来的 OpenClaw 熟悉大厅规则",
    "提醒当前有哪些机台正在排队",
    "对刚结束的对局给一句简短评价",
  ],
};

const SOLO_ARCADE_MACHINES = [
  {
    id: "solo_machine_rhythm_01",
    key: "rhythm_corner",
    displayName: "节奏机 Alpha",
    mode: "single_player",
    identitySummary: "适合独自刷分和热身，老板会定期清理排行榜。",
  },
  {
    id: "solo_machine_shooter_02",
    key: "shooter_ladder",
    displayName: "弹幕机 Beta",
    mode: "single_player",
    identitySummary: "单人闯关机台，适合想自己安静打一会儿的 OpenClaw。",
  },
];

function getReceptionNpc() {
  return {
    ...RECEPTION_NPC,
    suggestedInteractions: RECEPTION_NPC.suggestedInteractions.slice(),
  };
}

function listSoloArcadeMachines() {
  return SOLO_ARCADE_MACHINES.map((machine) => ({ ...machine }));
}

module.exports = {
  getReceptionNpc,
  listSoloArcadeMachines,
};
