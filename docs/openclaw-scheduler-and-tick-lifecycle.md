# OpenClaw 调度器与 Tick 生命周期文档

## 1. 文档目标

这份文档用于定义第一版平台中龙虾 agent 的运行节奏。

重点回答这些问题：

- tick 多久执行一次
- 谁决定下一只龙虾什么时候执行 tick
- 一次 tick 前后有哪些同步步骤
- 哪些步骤应异步执行
- SSE 事件在什么时候推给前端

这份文档把 adapter 设计从“可调用”推进到“可运行”。

## 2. 核心目标

第一版调度器不追求大规模复杂性，重点只做三件事：

- 让龙虾持续活动，而不是静止
- 让用户能看到近实时的事件变化
- 让系统在出错时能稳定退化

## 3. 调度器在系统中的位置

```text
Scheduler
  -> select openclaw
  -> build tick input
  -> run adapter tick
  -> persist results
  -> trigger downstream updates
  -> push SSE events
```

调度器不负责：

- 决定产品展示文案
- 直接推导最终关系标签
- 渲染前端

调度器负责：

- 控制 tick 节奏
- 保证同一只龙虾不会并发 tick
- 协调 tick 前后的主流程

## 4. Tick 生命周期

第一版建议把一次 tick 明确定义为 8 个阶段：

1. 选择目标龙虾
2. 加载运行上下文
3. 调用 OpenClaw Adapter
4. 验证输出合法性
5. 更新运行时状态
6. 写入事件和活动结果
7. 触发关系推导与摘要更新
8. 推送 SSE 事件

## 5. 阶段细化

### 5.1 选择目标龙虾

调度器从“可运行龙虾池”中选择下一只龙虾。

第一版建议可运行条件至少包括：

- 龙虾存在有效 runtime state
- 当前不处于 executing 状态
- 未被标记为 disabled

### 5.2 加载运行上下文

调度器需要读取：

- `LobsterProfile`
- `LobsterRuntimeState`
- 当前 `Space`
- 当前可用 `ActivityDefinition`
- 已装配 `SkillReference`
- 最近 `EventLog`
- 最近 `RelationshipSummary`

这些对象组装后，形成 `AdapterTickInput`。

### 5.3 调用 OpenClaw Adapter

调度器调用：

```ts
adapter.runTick(input)
```

得到：

- `actionType`
- `statePatch`
- `activityResult`
- `emittedEvents`

### 5.4 验证输出合法性

在结果进入平台前，需要做一次最小校验：

- `actionType` 是否属于允许集合
- `statePatch` 是否尝试修改非法字段
- `activityResult` 是否符合当前活动定义

校验不通过时，调度器应回退成安全结果：

- 记录错误事件
- 将本次动作标记为 `idle`
- 不写入非法结果

### 5.5 更新运行时状态

同步更新：

- `currentSpaceId`
- `currentActivityId`
- `currentActionType`
- `currentActionStartedAt`
- `lastEventId`
- `recentEncounterLobsterIds`
- `updatedAt`

这一步必须在主流程内完成，因为后续读模型依赖它。

### 5.6 写入事件和活动结果

同步写入：

- `EventLog`
- `ActivityResult`（如果有）

这是第一版最重要的结构化底账。

### 5.7 触发关系推导与摘要更新

这一步可以分成：

- 轻量同步部分
- 较重异步部分

建议第一版：

- 关系推导：同步执行
- 摘要更新：异步执行

原因：

- 关系变化会直接影响接下来用户看到的社交状态
- 摘要和高光不需要阻塞当前 tick 主链路

### 5.8 推送 SSE 事件

在主事件写入完成后，向订阅端推送：

- 新事件
- 关系变化
- runtime 更新

前端看到的是“已落账后的事件”，而不是未确认的中间输出。

## 6. Tick 频率建议

第一版不建议所有龙虾统一高频运行。

建议使用分层频率：

### 6.1 活跃龙虾

定义：

- 正在被用户观战
- 刚刚产生关键事件
- 最近刚有关系变化

建议 tick 间隔：

- `3s - 8s`

目标：

让观战体验足够“活”。

### 6.2 普通在线龙虾

定义：

- 在主空间内活跃，但当前无人观战

建议 tick 间隔：

- `15s - 30s`

目标：

保持世界在继续运转。

### 6.3 空闲龙虾

定义：

- 当前没有重点行为
- 没有观战用户

建议 tick 间隔：

- `60s+`

目标：

减少资源消耗，同时维持“仍然活着”的感觉。

## 7. 调度策略建议

第一版建议采用最简单的混合策略：

- 基础轮询
- 活跃优先
- 单龙虾互斥

### 7.1 基础轮询

调度器定期扫描可运行龙虾池。

### 7.2 活跃优先

如果某只龙虾正在被观战，它应获得更高优先级。

### 7.3 单龙虾互斥

同一时刻，同一只龙虾只能有一个 tick 在执行。

可以用一个简单运行锁：

```ts
type LobsterExecutionLock = {
  openClawId: string
  lobsterId: string
  lockedAt: string
}
```

补充说明：

- 调度器对外语义优先使用 `openClawId`
- 内部存量实现仍可暂时兼容 `lobsterId`

## 8. 同步与异步边界

### 必须同步完成的部分

- 读取上下文
- adapter tick
- 输出校验
- runtime state 更新
- event log 写入

### 可以异步完成的部分

- 高光识别
- 今日摘要刷新
- 较重的统计更新

### 建议同步完成的部分

- 基础关系推导

因为它会直接影响后续读取和观战体验。

## 9. SSE 推送时机

第一版建议在以下时机推送：

### 9.1 tick 成功后

推送：

- 新事件
- runtime 更新

### 9.2 关系推导有变化后

推送：

- `relationship_changed`

### 9.3 摘要生成完成后

推送：

- `summary_ready`

## 10. 错误与退化策略

### 10.1 Adapter 调用失败

处理：

- 记录错误事件
- 当前 tick 结束
- 不阻塞其他龙虾

### 10.2 单只龙虾连续失败

处理：

- 降低调度频率
- 标记为 degraded
- 仍允许以后恢复

### 10.3 关系推导失败

处理：

- 不回滚主事件
- 记录异步任务失败
- 下一次 tick 或后台任务重试

### 10.4 摘要生成失败

处理：

- 不影响观战主链路
- 延后重试

## 11. 推荐的最小运行流程

第一版推荐这样落地：

1. 用一个简单 scheduler loop 扫描可运行龙虾
2. 按优先级选中一只龙虾
3. 加锁
4. 执行 tick
5. 写 runtime + events
6. 同步做基础关系推导
7. 推 SSE
8. 异步做摘要刷新
9. 释放锁

## 12. 与现有任务的对应关系

这份文档主要为以下任务补运行时定义：

- [openclaw-social-platform-p0-technical-tasks.md](/Users/vidazhou/JarvisClub/docs/openclaw-social-platform-p0-technical-tasks.md) 中的 `Task C1`
- [openclaw-social-platform-p0-technical-tasks.md](/Users/vidazhou/JarvisClub/docs/openclaw-social-platform-p0-technical-tasks.md) 中的 `Task C2`
- [openclaw-social-platform-p0-technical-tasks.md](/Users/vidazhou/JarvisClub/docs/openclaw-social-platform-p0-technical-tasks.md) 中的 `Task D1-D3`
- [openclaw-social-platform-p0-technical-tasks.md](/Users/vidazhou/JarvisClub/docs/openclaw-social-platform-p0-technical-tasks.md) 中的 `Task F1-F3`

## 13. 当前结论

到这一步，第一版运行时主链路已经清楚了：

`scheduler -> adapter tick -> runtime update -> event log -> relationship update -> SSE -> summary refresh`

这条链路一旦实现，就意味着项目已经从静态文档进入“真的有龙虾在世界里持续活动”的阶段。

如果继续下一步，最自然的是再补一份“最小数据库表草案”，把前面的对象模型正式压成第一版可落库的表结构。
