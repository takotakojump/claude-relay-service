# Claude 转发识别风险审计与改进方案

日期：2026-06-29

## 1. 背景与范围

本文件基于对 `claude-relay-service` 项目代码和本地日志的审计，重点分析 Claude 请求转发链路中可能造成“身份指纹不一致、固定版本过时、非必要伪装、额外探测、日志泄露”的问题，并给出改进方案。

本次审计关注的主要路径：

- Claude 原生 Messages API：`/api/v1/messages`、`/claude/v1/messages`
- OpenAI 兼容 Claude 路径：`/api/v1/chat/completions`、`/openai/v1/chat/completions`、`/openai/claude/v1/chat/completions`
- Claude OAuth / Setup Token / Cookie OAuth 授权流程
- token refresh、profile、usage、count_tokens、scheduled account test 等可能触发上游请求的逻辑
- `metadata.user_id`、User-Agent、`x-stainless-*`、`anthropic-beta`、system prompt、headers/body 改写逻辑

审计目标不是规避平台检测，而是降低代理服务自身造成的异常指纹、不一致请求和敏感信息泄露风险，使转发行为更透明、稳定、可配置、可审计。

## 2. 总体结论

当前项目中没有发现默认固定周期向 Claude 发送 ping 或查询的证据；真正可能周期调用 Claude 的是可配置的账号测试调度器，但现有日志没有显示定时测试实际执行。

当前日志中的 Claude 请求主要走原生 `/api/v1/messages?beta=true` 路径，没有证据显示正在使用 OpenAI 兼容路径处理这些 Claude 请求。不过 OpenAI -> Claude 转换逻辑仍然存在，一旦客户端使用 OpenAI 兼容接口并选择 Claude 模型，就会启用该路径。

在不处理日志脱敏的前提下，最需要优先处理的问题是：

1. `useUnifiedClientId` 已在日志中大量触发；该功能本身有必要保留，但当前需要避免全局固定、信息不完整或跨账号混用。
2. 项目内存在多套硬编码 Claude CLI User-Agent 和 `x-stainless-*` 默认指纹，版本跨度大且可能过时。
3. 对非真实 Claude Code 或 OpenAI 兼容请求，会注入 Claude Code system prompt、synthetic messages、generated metadata，容易产生不自然请求形态。
4. `model_pricing.json` 读取路径疑似错误，导致 max_tokens 校验经常跳过。

## 3. 关键风险清单

| 编号 | 风险项 | 当前状态 | 风险等级 | 主要证据 |
| --- | --- | --- | --- | --- |
| R1 | 统一 `metadata.user_id` 改写策略过于固定或不完整 | 日志中大量触发 | 高 | `claudeRelayService._replaceClientId`、日志 `Replaced client ID with unified ID` |
| R2 | UA 版本硬编码且多处不一致 | 存在 | 高 | `1.0.56`、`1.0.57`、`1.0.110`、`1.0.119`、`2.0.53` 并存 |
| R3 | `x-stainless-*` 默认指纹固定 | 存在 | 中高 | 默认 Windows/node/v20.19.2/package 0.55.1 |
| R4 | `requestIdentityService` 使用 `SET NX`，指纹不更新 | 存在 | 中高 | 首次写入后不会覆盖旧指纹 |
| R5 | 非真实 Claude Code 请求注入 Claude Code system prompt | 存在 | 高 | `_processRequestBody`、`openaiToClaude.convertRequest` |
| R6 | OpenAI -> Claude 兼容路径仍存在 | 当前日志未触发 | 中 | `openaiClaudeRoutes`、`unified.js` |
| R7 | `anthropic-beta` 固定日期组合 | 存在 | 中 | `claude-code-20250219`、`oauth-2025-04-20` 等 |
| R8 | 强制 header 覆盖形成统一 relay 行为 | 存在 | 中 | `accept-encoding: identity`、固定 `host`、`connection` |
| R9 | 额外探测：profile / usage / count_tokens / scheduled test | profile/token refresh 有触发；其余无证据 | 中低 | 日志 profile 12 次、token refresh 11 次 |
| R10 | `model_pricing.json` 路径疑似错误，max_tokens 校验跳过 | 日志中反复出现 | 中 | `Model pricing file not found` |
| R11 | auth-detail 完整 token 落盘 | 存在 | 高 | `logger.authDetail` 完整写入认证响应 |
| R12 | request logger 记录完整请求体 | 存在 | 高 | `requestLogger` 写入 `meta.req = req.body` |

说明：R11/R12 属于本地安全风险，但用户已明确本轮不做日志脱敏，因此后续改进方案不把日志脱敏列为实施项或验收项。

## 4. 分项分析与定位

### 4.1 统一 Client ID 改写机制（保留但完善）

代码定位：

- `src/services/relay/claudeRelayService.js`：`_processRequestBody` 中检查 `account.useUnifiedClientId === 'true'`
- `src/services/relay/claudeRelayService.js`：`_replaceClientId` 只替换 `metadata.user_id` 中的 `device_id`
- `src/services/requestIdentityService.js`：后续还会按账号哈希 `session_id`，并尝试注入 `account_uuid`

日志现象：

- `Replaced client ID with unified ID` 在现有日志中出现大量记录。
- 示例中统一后的 `device_id` 是固定 64 位 hex。
- 示例中 `_replaceClientId` 阶段的 `account_uuid` 为空字符串。

风险说明：

- 统一改写客户端身份可能是必要功能，用于避免上游直接看到多个下游客户端的原始差异。
- 风险不在于“改写本身”，而在于所有账号或来源共享同一个全局固定 `device_id`，以及 `account_uuid` 为空或与 session/device 不一致。
- 如果真实 Claude Code、OpenAI 兼容客户端、browser fallback 都被改成同一类身份，但 headers、UA、stainless、body 形态不一致，反而会形成组合指纹。
- 如果统一 ID 长期不轮换、不可按账号隔离，也会让单点异常影响所有下游客户端。
改进建议：

- 保留 `useUnifiedClientId`，但将其定义为明确的身份改写策略，而不是简单替换字段。
- 默认建议使用 `unified_per_account` 或 `unified_per_account_and_api_key`，避免全局单一 `device_id`。
- 改写时同时保证 `device_id`、`session_id`、`account_uuid` 来源一致，避免固定 device + 空 account UUID。
- 增加策略开关，例如 `CLIENT_ID_REWRITE_MODE=off|preserve|unified_global|unified_per_account|unified_per_key`，便于按风险场景选择。
- 对真实 Claude Code 请求可以继续统一身份，但 headers、UA、stainless、body metadata 必须来自同一个 identity profile。
- 增加审计日志：记录是否改写、改写策略、账号维度、客户端类型，但不要记录完整 user_id。

### 4.2 User-Agent 与版本号不一致

硬编码位置包括：

- OAuth token/profile：`claude-cli/1.0.56`
- 默认 Claude Code headers：`claude-cli/1.0.57`
- browser fallback：`claude-cli/1.0.110`
- relay fallback：`claude-cli/1.0.119`
- OAuth usage：`claude-cli/2.0.53`

日志现象：

- 实际入口请求出现 `claude-cli/2.1.98 (external, cli)`。
- 也捕获过 `claude-cli/2.1.181 (external, sdk-cli)`。
- 服务端可能把入口 UA、缓存 UA、默认 UA 混用。

风险说明：

- 同一个账号或同一个会话中出现多套 Claude CLI 版本，会造成行为不一致。
- 新客户端 body + 旧 stainless package/runtime + 旧 UA 的组合很容易成为异常指纹。
- `useUnifiedUserAgent` 使用全局 Redis key `claude_code_user_agent:daily`，不是按账号隔离。

改进建议：

- 建立统一的 `clientIdentityProfile` 配置，集中管理 UA、stainless、beta、runtime 等字段。
- 按账号保存 UA 和 headers，不使用全局 UA 缓存。
- OAuth/profile/usage 的 UA 不应散落硬编码；至少统一读取同一个配置。
- 对真实 Claude Code 请求，优先保留客户端原始 UA。

### 4.3 `x-stainless-*` 指纹固定和过期

默认指纹：

- `x-stainless-package-version: 0.55.1`
- `x-stainless-os: Windows`
- `x-stainless-arch: x64`
- `x-stainless-runtime: node`
- `x-stainless-runtime-version: v20.19.2`

风险说明：

- 默认值过于具体，会暴露固定环境指纹。
- 如果真实客户端是 macOS/Linux 或不同 runtime，默认 Windows/node 组合会不一致。
- `requestIdentityService` 通过 `SET NX` 保存 stainless 指纹，首次写入后不更新，可能长期保留旧指纹。

改进建议：

- 真实 Claude Code 请求直接使用客户端传入的 `x-stainless-*`。
- 非真实客户端不要套 Claude Code stainless 默认值。
- 将 Redis `SET NX` 改为带版本比较/更新时间的 upsert。
- 指纹缓存应按账号维度、带 TTL、可手动清理。

### 4.4 非真实 Claude Code 请求的 system prompt 注入

当前逻辑：

- 非真实 Claude Code 请求会把 system 替换成 `You are Claude Code, Anthropic's official CLI for Claude.`
- 原 system prompt 被挪到 user message，前缀 `[System Instructions - follow these strictly]`。
- 同时注入 assistant ack：`Understood. I will follow these instructions.`
- 缺失 metadata 时生成固定 seed 的 device id。

OpenAI 兼容路径也会默认构造 Claude Code system prompt。

风险说明：

- 这不是透明代理，而是主动伪装成 Claude Code 请求。
- synthetic user/assistant 消息对非常固定，容易在请求内容中形成模式。
- 对 OpenAI 兼容客户端，忽略或重写用户 system prompt 也可能改变行为。

改进建议：

- OpenAI 兼容路径应透明转换为 Anthropic Messages API，不注入 Claude Code 身份。
- 非 Claude Code 客户端不要自动补 Claude Code system prompt 和 metadata。
- 如需兼容某些上游要求，应做成显式开关，并在管理端标注风险。

### 4.5 `anthropic-beta` 固定组合

当前固定 beta 包括：

- `claude-code-20250219`
- `oauth-2025-04-20`
- `interleaved-thinking-2025-05-14`
- `fine-grained-tool-streaming-2025-05-14`

风险说明：

- beta header 日期会过时。
- 当前逻辑会先添加服务端 base beta，再追加客户端 beta，不是原样保留。
- OpenAI 兼容 official relay 里传入的 `options.betaHeader` 实际没有被 `claudeRelayService` 使用，存在行为与代码意图不一致。

改进建议：

- 真实 Claude Code 请求优先保留客户端 `anthropic-beta`。
- 服务端默认 beta 应可配置，并与模型能力绑定。
- 清理 OpenAI 兼容路径中无效的 `options.betaHeader` 传参，避免误判配置已生效。

### 4.6 Header 强制覆盖

当前行为：

- header 白名单过滤。
- 强制 `host: api.anthropic.com`。
- 强制 `connection: keep-alive`。
- 强制 `content-type: application/json`。
- 强制 `accept-encoding: identity`。
- 重建 `User-Agent` 和 `Accept`。

风险说明：

- `accept-encoding: identity` 是为了解决压缩处理问题，但这是上游可见差异。
- 统一 header 组合会暴露代理服务固定行为。

改进建议：

- 对真实 Claude Code 请求尽量保留原始 header，只替换认证相关字段。
- 如果必须强制 `accept-encoding: identity`，应作为独立配置项并记录原因。
- 对非真实客户端的 header 改写应最小化，避免套用 Claude Code headers。

### 4.7 额外探测活动

当前结论：

- 没有发现默认固定周期 ping。
- 账号测试调度器会启动，但现有日志没有实际 scheduled test 执行记录。
- token refresh 和 profile fetch 是请求触发/刷新触发。
- usage 和 count_tokens 逻辑存在，但日志没有显示当前触发。

风险说明：

- 定时测试如果被开启，会定期向 Claude 发测试请求，应明确展示给管理员。
- profile/usage 使用固定 UA，容易与主请求 UA 不一致。

改进建议：

- 账号测试调度默认关闭，并在 UI 显示每个账号是否启用、cron、下次执行时间。
- profile/usage 请求使用统一身份配置或明确标注为管理端请求。
- 对所有非用户触发的上游请求打结构化审计日志。

### 4.8 OpenAI -> Claude 兼容路径

当前状态：

- 代码仍存在。
- 现有日志没有使用证据。
- 如果模型以 `claude-` 开头或模型为空，`unified.js` 默认路由到 Claude。

风险说明：

- OpenAI 兼容路径会做 OpenAI body -> Claude body 转换。
- 默认注入 Claude Code system prompt。
- route 阶段会先调度一次账号并取 headers，relay 阶段可能再次调度，存在账号/headers 不一致。

改进建议：

- 明确区分“OpenAI-compatible client”和“Claude Code client”。
- OpenAI 兼容路径不要使用 Claude Code headers。
- 避免重复调度：route 层选中的 accountId 应传入 relay 并强制使用，或由 relay 单点调度。

### 4.9 模型名和 max_tokens 校验

日志现象：

- `Model pricing file not found, skipping max_tokens validation` 频繁出现。

代码问题：

- `_validateAndLimitMaxTokens` 读取 `../../data/model_pricing.json`。
- 项目实际 pricing 文件位于项目根目录 `data/model_pricing.json`。
- 从 `src/services/relay` 相对路径推算，`../../data/model_pricing.json` 可能指向 `src/data/model_pricing.json`，与实际位置不一致。

风险说明：

- max_tokens 超限保护失效，异常请求可能直达上游。
- 模型名如果是内部别名或过时名称，也会直达上游。

改进建议：

- 修正 pricing 文件路径，改用项目根目录解析。
- 将模型名校验、别名映射、上游模型名转换集中到一个服务。
- 对不认识的模型名明确返回错误或使用可配置映射，不要盲传。

### 4.10 日志敏感信息泄露（本轮不实施）

说明：本节仅保留为风险备注；按当前要求，本轮不做日志脱敏、不调整 request logger、不清理历史日志。

高风险点：

- `logger.authDetail` 会完整写入认证响应，包括 access token、refresh token。
- `requestLogger` 会记录完整请求体，包括用户内容、tool_use、thinking signature 等。

风险说明：

- 这不是 Claude 上游识别风险，但属于严重本地安全风险。
- 如果日志被上传、备份或共享，会泄露账号凭证和用户隐私。

后续可选项（本轮不实施）：

- 默认关闭 auth-detail 完整日志。
- 对 token、authorization、cookie、sessionKey、metadata.user_id 做脱敏。
- request logger 默认只记录摘要：model、stream、message count、tool count、body size、request id。
- 提供短时 debug dump 开关，并自动过期。
- 历史 `claude-relay-auth-detail-*` 日志应清理；如日志曾外传，应轮换 token。

## 5. 改进方案

### 阶段 1：立即降低高风险指纹并恢复请求校验

目标：不移除客户端身份改写能力，先把改写从“全局固定替换”升级为“按策略、按账号分域、字段一致”的机制。

任务：

1. 保留 `useUnifiedClientId`，但新增明确的 `CLIENT_ID_REWRITE_MODE` 策略配置。
2. 默认策略从全局固定改为按账号或账号 + API Key 分域生成统一身份。
3. 改写 `metadata.user_id` 时同时处理 `device_id`、`session_id`、`account_uuid` 的一致性和非空校验。
4. 对真实 Claude Code 请求继续允许统一身份，但必须使用同一套 identity profile 生成 headers/body 相关字段。
5. 修复 `model_pricing.json` 路径，恢复 max_tokens 校验。

验收标准：

- `useUnifiedClientId` 仍可启用，但默认不再产生所有账号共享的全局固定 `device_id`。
- 改写后的 `metadata.user_id` 不出现空 `account_uuid` 或 session/device/account 维度不一致。
- 日志能看到使用了哪种 client id rewrite 策略，但不暴露完整 user_id。
- `Model pricing file not found` 不再出现。

### 阶段 2：统一客户端身份配置

目标：消除多套硬编码 UA/stainless/beta 的不一致。

任务：

1. 新建统一身份配置模块，例如 `clientIdentityProfileService`。
2. 将 UA、`x-stainless-*`、`anthropic-beta`、`anthropic-version` 从散落代码迁移到统一模块。
3. UA 和 headers 按账号缓存，不使用全局 `claude_code_user_agent:daily`。
4. `requestIdentityService` 的 `SET NX` 改为可更新 upsert，带版本比较和 TTL。
5. 管理端显示每个账号当前使用的 identity profile 摘要。

验收标准：

- 代码中不再散落多个 `claude-cli/x.y.z` 字符串。
- 同一账号上游请求的 UA 与 stainless 版本能保持一致。
- 新版本 Claude Code 请求成功后，账号指纹可更新。

### 阶段 3：拆分真实 Claude Code 与兼容客户端路径

目标：真实客户端最小改写，兼容客户端透明转换。

任务：

1. 明确请求分类：`real_claude_code`、`anthropic_api_client`、`openai_compatible_client`、`browser_fallback`。
2. `real_claude_code` 路径只做必要认证、账号调度、Authorization 替换和响应转发。
3. `openai_compatible_client` 不再注入 Claude Code system prompt，不使用 Claude Code headers。
4. 移除或强限制 browser fallback 的 Claude Code 伪装行为。
5. OpenAI 兼容路径避免重复调度，保证 headers 与最终账号一致。

验收标准：

- OpenAI 兼容请求体中不再出现 Claude Code 默认 system prompt，除非客户端原本传入。
- 真实 Claude Code 请求 body/header 差异有明确白名单说明。
- route 层和 relay 层不会为同一请求选择不同账号。

### 阶段 4：探测活动与后台请求透明化

目标：让所有非用户直接请求可见、可控、可关闭。

任务：

1. 账号测试调度默认关闭或显式 opt-in。
2. UI 显示每个账号的 test config、cron、下次执行时间、最近执行结果。
3. profile/usage/count_tokens 请求加结构化审计日志。
4. usage/profile 的 UA 使用统一 identity profile 或单独管理配置。

验收标准：

- 管理端能看到所有可能主动访问 Claude 的任务。
- 日志可以区分用户请求、token refresh、profile fetch、usage fetch、scheduled test。
- 未启用测试配置时没有 scheduled test 上游请求。

### 阶段 5：长期治理

目标：降低未来 Claude Code 更新造成的版本漂移和过时风险。

任务：

1. 建立 identity profile 自动老化机制，超过 TTL 未更新则降级为保留客户端原始值。
2. 加入单元测试覆盖真实 Claude Code 请求的“最小改写”行为。
3. 加入集成测试：OpenAI 兼容路径不得注入 Claude Code 身份。
4. 为模型映射和 beta header 增加配置版本说明和变更记录。

验收标准：

- 测试能发现 UA/stainless/beta 不一致的问题。
- 新增硬编码 `claude-cli/` 字符串会被 lint/test 拦截。

## 6. 建议改动优先级

第一优先级：

- 保留 `metadata.user_id` 统一改写，但改为按账号/API Key 分域并保证字段一致。
- 修复 pricing 文件路径。

第二优先级：

- 统一 UA / stainless / beta 配置。
- 改造 `requestIdentityService` 的 `SET NX`。
- 按账号缓存 identity profile。

第三优先级：

- 重构 OpenAI -> Claude 兼容路径，停止 Claude Code 身份注入。
- 消除 route 层和 relay 层重复调度。
- 管理端展示所有后台探测任务。

## 7. 回归检查命令建议

执行静态定位：

```bash
rg -n "claude-cli/|x-stainless|anthropic-beta|metadata\.user_id|Replaced client ID|System Instructions - follow these strictly" src config
```

可选安全自查：检查日志中是否仍有敏感项（本轮不作为改造验收）：

```bash
rg -n "sk-ant-oat|sk-ant-ort|access_token|refresh_token|thinking\":|signature\":" logs
```

检查是否仍有非预期 OpenAI -> Claude 使用：

```bash
rg -n "OpenAI-Claude|Received OpenAI format request|Processing OpenAI stream request|/v1/chat/completions" logs
```

检查是否仍有固定 client id 改写：

```bash
rg -n "Replaced client ID with unified ID" logs
```

## 8. 结束语

当前日志没有直接证明 Claude 因代理指纹问题拒绝请求；唯一明确上游错误是 organization disabled。真正需要处理的是代理自身制造的长期稳定指纹和不一致身份信息。按当前要求，客户端身份改写应保留，但需要从“简单固定替换”升级为“按账号/API Key 分域、字段完整一致、与 UA/stainless/beta 同源”的身份策略；日志问题仅保留为安全风险备注，不纳入本轮实施。
