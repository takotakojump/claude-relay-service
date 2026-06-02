# CRS-HQ Fork 使用说明

> 本仓库是 [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) 的个人 fork
> （`takotakojump/claude-relay-service`），在原版基础上增加了若干功能。
> 后台版本号自动带 **`-HQ`** 后缀（如 `1.1.306-HQ`）以区分原版。
> 安装、基础配置、环境变量等请参见原版 [README](./README.md)，本文件只说明 **本 fork 的差异与更新方式**。

---

## 一、相比原版新增的功能

### 1. API Key 可绑定 CCR 账号（无前缀直连，对客户端无感）
原版的 CCR（CRS 链式中转）账号只能靠客户端把模型写成 `model="ccr,..."` 前缀来触发。
本 fork 支持把 **API Key 绑定到指定 CCR 账号**，绑定后该 Key 的 Claude 请求**无需任何前缀、客户端无感**地直连 CCR。

- **配置**：后台 → 编辑 API Key → 「专属账号绑定」区 → **「CCR 专属账号」** 下拉选择。
- **优先级**：`claude → claude-console → bedrock → ccr`。同时绑定 Claude 专属账号和 CCR 时，**Claude 优先、CCR 不生效**（通常二选一）。
- **不影响 codex**：codex / OpenAI 走独立的 OpenAI 调度链路，不读 CCR 绑定。
- 典型用法：部分 Key 绑 Claude 账号、部分 Key 绑 CCR 账号，实现「按 Key 分流」。

### 2. CCR fallback 开关
Edit 弹窗的 CCR 下拉下方有勾选框 **「CCR 账号不可用时回退共享账号池」**：
- **勾选（默认）**：绑定的 CCR 账号停用/不可调度/模型不支持时，回退共享池（由 Claude 账号兜底）。
- **取消勾选**：CCR 不可用时直接返回 **503**，强隔离，绝不使用其它账号。
- 账号被限流（429）：始终报错（不受此开关影响）。
- 老 Key 没有该字段时默认按「勾选」处理，行为与原版一致。

### 3. 版本号 `-HQ` 标识 + 仍跟踪作者更新
- 后台显示的版本号自动附加 `-HQ`（VERSION 文件本身保持与上游一致、无需手动改）。
- 「检查更新」仍查 **作者仓库** 的最新 release，作者发新版时后台照常提示——既能区分改版，又不漏掉上游更新。

### 4. 更新机制改为本地构建前端
- `scripts/manage.sh` 的 `update` 改为**本地构建前端**（不再从作者的 `web-dist` 分支下载预构建文件），使 `crs update` 能正确应用本 fork 的前端改动。
- 新增 `scripts/mac-update.sh`，供 macOS（launchDaemon）部署机一键更新。

---

## 二、部署机更新方式

> 前端 `web/admin-spa/dist` 不在仓库里，更新时**必须本地 `npm run build:web`**。
> `git reset --hard` 只动被 git 跟踪的文件，`.env` / `config/config.js` / `data/` 为 gitignore，**配置和数据不受影响**。

### Linux（manage.sh / crs 命令）
```bash
crs update          # 自动：拉 fork main → npm install → 本地 build → 重启
```

### macOS（launchDaemon）
```bash
./scripts/mac-update.sh [launchDaemon-Label]
# 不传 Label 会自动探测名字含 claude/relay 的服务
# 仓库属 root 时： sudo env "PATH=$PATH" ./scripts/mac-update.sh <Label>
```

### 部署机首次切到本 fork
```bash
git remote set-url origin https://github.com/takotakojump/claude-relay-service.git
git fetch origin && git checkout main && git reset --hard origin/main
npm install && npm run build:web
# 重启： Linux: crs restart ；macOS: sudo launchctl kickstart -k system/<Label>
```

> 建议在部署机禁 push（只读消费端）：`git remote set-url --push origin no-push`

---

## 三、与上游（作者）同步更新

在**开发机**操作（部署机只单向拉取，不在部署机合并）：

```bash
# 首次配置 upstream
git remote add upstream https://github.com/Wei-Shaw/claude-relay-service.git
git remote set-url --push upstream no-push   # 防误推作者库

# 同步作者更新
git fetch upstream
git merge upstream/main      # 若与本 fork 改动冲突，手动解决（多在 CCR 相关文件）
git push origin main
```

VERSION 文件**无需手动改**（显示时自动加 `-HQ`，版本号随上游自动跟进）。

---

## 四、本 fork 改动涉及的主要文件

| 文件 | 改动 |
|---|---|
| `src/services/apiKeyService.js` | API Key 新增 `ccrAccountId`、`ccrFallbackToPool` 字段 |
| `src/services/scheduler/unifiedClaudeScheduler.js` | CCR 账号绑定调度 + fallback 开关 |
| `src/routes/api.js` | CCR 限流(403) / 不可用(503) 错误处理 |
| `src/routes/admin/system.js` | 版本号自动附加 `-HQ`、比较时剥离后缀 |
| `web/admin-spa/src/components/common/AccountSelector.vue` | 账号选择器支持 `ccr` 平台 |
| `web/admin-spa/src/components/apikeys/EditApiKeyModal.vue` | CCR 绑定下拉 + fallback 勾选 |
| `web/admin-spa/src/views/ApiKeysView.vue` | 预取 CCR 账号列表 |
| `scripts/manage.sh` | `update` 改为本地构建前端 |
| `scripts/mac-update.sh` | 新增：macOS launchDaemon 更新脚本 |
