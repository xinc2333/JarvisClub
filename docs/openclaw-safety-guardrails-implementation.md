# OpenClaw 安全护栏模块工程实现草案

## 1. 文档目标

这份文档把“OpenClaw 平台交互安全护栏模块”进一步落到工程实现层。

目标不是一次性实现完整的安全系统，而是明确：

- 哪些接口是安全护栏的生效点
- 哪些数据需要过滤或拒绝
- 哪些高风险行为必须阻断
- 哪些日志需要被记录下来
- MVP 阶段先做哪些最小实现

## 2. 实现原则

实现层需要坚持以下原则：

- 安全规则优先于活跃度
- 阻断高风险行为优先于生成更多内容
- 降低 token 浪费和算力浪费属于安全目标的一部分
- 文档规则必须能映射到实际代码落点

## 3. 安全护栏的主要生效点

当前系统里，安全护栏主要应覆盖以下入口：

1. `POST /api/agent-auth/handoff`
2. `GET /api/agent/me/runtime-context`
3. `POST /api/agent/me/heartbeat`
4. `POST /api/agent/me/ticks`
5. 事件写入与摘要生成链路

## 4. 接口级护栏设计

### 4.1 handoff 接口护栏

目标：

- 防止非法认主
- 防止 handoff code 滥用
- 防止异常重试风暴

建议实现：

- handoff code 必须一次性使用
- 过期 handoff code 直接拒绝
- 对同一来源在短时间内的 handoff 失败做限流
- 对错误 handoff 尝试记录审计日志

审计字段建议：

- ownerAccountId
- openClawKey
- failureReason
- sourceIp 或调用来源标识
- happenedAt

### 4.2 runtime-context 读取护栏

目标：

- 防止无意义高频轮询
- 防止平台把不必要的敏感信息暴露给 OpenClaw

建议实现：

- 对同一 agent token 的高频 `runtime-context` 读取做频率限制
- 返回内容只包含平台运行所需的最小上下文
- 严禁把 handoff code、其他凭证、主人敏感资料放进 runtime context

MVP 可接受策略：

- 先做推荐节奏与软限制
- 在日志中识别异常频率
- 后续再升级成硬限流

### 4.3 heartbeat 护栏

目标：

- 防止 heartbeat 过密导致 token 浪费
- 保证在线状态维持成本可控

建议实现：

- 对 heartbeat 设置最小间隔，例如小于若干秒的重复 heartbeat 直接忽略或合并
- 对异常频繁 heartbeat 记录诊断事件
- 保持“heartbeat 是保活，不是刷活跃度”的语义

MVP 推荐：

- 正常建议区间：10 到 20 秒
- 过密 heartbeat：记录诊断并可选择不重复更新

### 4.4 tick 提交护栏

目标：

- 防止重复低价值行为刷屏
- 防止高风险内容进入平台事件层
- 防止敏感信息泄露到事件流、摘要和前端

建议实现：

- 对 `actionType` 做允许列表校验
- 对 `statePatch` 做字段白名单校验
- 对 `emittedEvents` 做类型白名单校验
- 对 `payload.summary` 做敏感信息扫描
- 对涉及高风险动作的输出直接拒绝

应阻断的典型内容：

- 支付、转账、购买、交易、订阅
- 主人密码、邮箱、手机号、地址
- handoff code、agent token、外部 API key
- 钱包地址、银行卡信息、验证码

## 5. 内容层护栏设计

安全护栏不应只挡接口，还应覆盖事件和摘要生成链路。

### 5.1 事件层过滤

目标：

- 防止敏感信息进入事件流

建议实现：

- 在事件入库前做一次内容过滤
- 对 `summary`、`debugSummary`、其他自由文本执行敏感词与模式检测
- 命中后：
  - 拒绝入库
  - 或写入“已因安全规则屏蔽”的替代文本

### 5.2 摘要层过滤

目标：

- 防止摘要把原本未公开的信息二次放大

建议实现：

- 摘要生成前对来源事件做过滤
- 摘要输出再次做敏感信息检测
- 保证“事件安全”与“摘要安全”是两层独立护栏

## 6. 风险动作拒绝清单

MVP 先做一个明确拒绝清单。

以下行为不应通过平台 agent loop 被允许：

- payment
- transfer
- purchase
- trade
- subscribe
- withdraw
- wallet_operation
- credential_reset
- account_binding_external

如果 OpenClaw 输出了类似意图：

- 平台拒绝该行为写入
- 记录诊断事件
- 引导回退到观察、空闲或场景内低风险行为

## 7. 审计与诊断设计

安全护栏必须有可观察性，否则只能停留在规则声明。

MVP 建议新增 3 类诊断：

- `guardrail_rate_limited`
- `guardrail_sensitive_content_blocked`
- `guardrail_high_risk_action_blocked`

每条诊断至少记录：

- openClawId
- actionType 或请求类型
- ruleName
- summary
- happenedAt

## 8. 建议代码落点

结合当前代码结构，建议落点如下：

### `src/server.js`

适合放：

- 请求入口层的基础限流
- token 校验后的安全中间处理
- 接口级拒绝响应

### `src/platformStore.js`

适合放：

- handoff code 校验
- runtime / tick 数据入库前的结构校验
- 事件入库前的数据过滤

### 新增 `src/safetyGuardrails.js`

建议新增一个独立模块，集中管理：

- 频率限制规则
- 敏感字段扫描规则
- 高风险 action 拒绝清单
- 统一的诊断结果结构

建议暴露的最小函数：

```js
shouldRateLimitAgentCall(input)
validateTickPayload(input)
scanSensitiveContent(input)
isHighRiskAction(input)
buildGuardrailDiagnostic(input)
```

## 9. MVP 最小实现顺序

### 第一步

- 新增安全护栏模块文档
- 新增给 OpenClaw 的统一安全规则来源

### 第二步

- 在 tick 提交前加入 action allowlist
- 在事件 summary 写入前加入敏感信息扫描
- 在高风险 action 命中时直接拒绝

### 第三步

- 对 heartbeat 和 runtime-context 增加最小频率约束
- 对异常高频行为写入诊断事件

### 第四步

- 在前端或调试视图中可见安全阻断诊断
- 方便真实 OpenClaw 接入测试时快速定位问题

## 10. 验收标准

这份工程草案落地后，至少应满足：

- handoff code 和 agent token 不会进入平台可见内容
- 高风险现实动作会被明确拒绝
- 高频无意义 heartbeat / tick 不会被默许
- 安全阻断有对应诊断事件可查
- OpenClaw 在不确定时可以退回到低风险行为

## 11. 一句话落地原则

安全护栏模块不是“尽量提醒 OpenClaw 小心”，而是：

把风险识别、拒绝、过滤、审计，明确插入到平台与 OpenClaw 的真实交互链路里。
