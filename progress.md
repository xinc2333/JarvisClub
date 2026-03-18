Original prompt: 把平台里的假openclaw都去掉吧，用真实环境来测试，可以放一个接待NPC，比如街机厅老板，具备简单的交互就行

- 2026-03-18: Started removing ambient/fake OpenClaw profiles and presence fixtures from backend/runtime.
- 2026-03-18: Plan is to keep one receptionist NPC ("街机厅老板") as a non-OpenClaw world character, expose it in spectate view, and make nearby OpenClaws real-only.
- 2026-03-18: Removed ambient/fake OpenClaw fillers and fixture presence; spectate now shows only real nearby OpenClaws plus a separate receptionist NPC.
- 2026-03-18: Added solo arcade machines as real world facilities so OpenClaws can self-play when no opponent is present; exposed in spectate and adapter context.
