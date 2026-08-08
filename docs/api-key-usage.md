# API Key 用量与限制查询接口

给自定义工具用的自查接口：拿一个 API Key，返回它自己的使用量、限制配置，以及绑定账户的上游配额快照。

**这个接口完全在本地处理，不会向上游（ChatGPT / Anthropic）发起任何请求。** 返回的上游配额是缓存快照，附带 `updatedAt` 和 `isStale`，由调用方自行判断新鲜度。断网时它依然能正常返回。

## 端点

```
GET /apiStats/api/key-usage
Authorization: Bearer cr_xxxxxxxxxxxx
```

- Key 只能从 `Authorization` 头传入，**不支持 query string** —— 避免 Key 进入访问日志、浏览器历史和反向代理日志。
- Key 用于验证自身身份，只能查到自己的数据。
- 查询**不会**激活一个尚未激活的 Key，也**不会**消耗任何配额计数。

### curl

```bash
curl -H "Authorization: Bearer cr_xxxxxxxxxxxx" \
  https://your-relay.example.com/apiStats/api/key-usage
```

## 响应

```jsonc
{
  "success": true,
  "generatedAt": "2026-08-05T12:00:00.000Z",
  "data": {
    "key": {
      "id": "6b1f...",
      "name": "my-key",
      "description": "",
      "isActive": true,
      "createdAt": "2026-07-01T00:00:00.000Z",
      "expiresAt": null,
      "expirationMode": "fixed",
      "isActivated": true,
      "permissions": "all"
    },

    "usage": {
      "total": {
        "requests": 1024,
        "tokens": 500000,
        "allTokens": 820000,
        "inputTokens": 300000,
        "outputTokens": 200000,
        "cacheCreateTokens": 120000,
        "cacheReadTokens": 200000,
        "cost": 12.5
      },
      "daily": {
        "cost": 3.25,
        "resetAt": "2026-08-06T00:00:00.000Z"
      },
      "window": {
        "windowMinutes": 60,
        "startAt": "2026-08-05T11:50:00.000Z",
        "endAt": "2026-08-05T12:50:00.000Z",
        "remainingSeconds": 3000,
        "requests": 7,
        "tokens": 700,
        "cost": 1.5
      }
    },

    "limits": {
      "tokenLimit": 1000000,
      "concurrencyLimit": 5,
      "rateLimitWindow": 60,
      "rateLimitRequests": 100,
      "rateLimitCost": 10,
      "dailyCostLimit": 20,
      "totalCostLimit": 200,
      "weeklyOpusCostLimit": 50,
      "weeklyOpusCost": 1.2,
      "weeklyResetDay": 1,
      "weeklyResetHour": 0
    },

    "serviceLimits": [
      {
        "service": "opus",
        "dailyCostLimit": 10,
        "currentDailyCost": 4,
        "dailyResetAt": "2026-08-06T00:00:00.000Z",
        "weeklyCostLimit": 40,
        "currentWeeklyCost": 9,
        "weeklyResetAt": "2026-08-10T00:00:00.000Z",
        "windowMinutes": 60,
        "windowRequests": 100,
        "currentWindowRequests": 12,
        "windowCost": 0,
        "currentWindowCost": 0,
        "windowResetAt": "2026-08-05T12:50:00.000Z",
        "exceeded": false
      }
    ],

    "restrictions": {
      "enableModelRestriction": false,
      "restrictedModels": [],
      "enableClientRestriction": false,
      "allowedClients": []
    },

    "accounts": {
      "openai": {
        "id": "acc-1",
        "accountType": "dedicated",
        "platform": "openai",
        "isActive": true,
        "schedulable": true,
        "rateLimitStatus": { "status": "normal", "isRateLimited": false },
        "codexUsage": {
          "updatedAt": "2026-08-05T11:58:00.000Z",
          "source": "wham",
          "rateLimitReachedType": null,
          "isStale": false,
          "limits": [
            {
              "limitId": "codex",
              "limitName": "Codex",
              "meteredFeature": null,
              "capturedAt": "2026-08-05T11:58:00.000Z",
              "primary": {
                "usedPercent": 5,
                "windowMinutes": 10080,
                "resetAt": "2026-08-09T21:00:00.000Z",
                "remainingSeconds": 421200
              },
              "secondary": null,
              "primaryOverSecondaryPercent": null
            }
          ]
        },
        "codexAvailability": {
          "updatedAt": "2026-08-05T11:58:00.000Z",
          "account": { "state": "ok", "detail": null, "observedAt": "2026-08-05T11:58:00.000Z" },
          "models": {}
        }
      }
    }
  }
}
```

## 字段说明

### 单位约定

| 类型 | 单位 |
| --- | --- |
| `cost` / `*CostLimit` | 美元 |
| `tokens` / `*Tokens` | token 个数 |
| `*At`（时间点） | ISO 8601 字符串（UTC） |
| `*Seconds` | 秒 |
| `windowMinutes` | 分钟 |
| `usedPercent` | 0–100 的百分比数值 |

### usage

| 字段 | 含义 |
| --- | --- |
| `total` | 该 Key 累计用量与累计费用 |
| `daily.cost` / `daily.resetAt` | 当日费用与下一次日重置时间 |
| `window` | Key 级速率限制窗口的当前状态 |

`window` 在未配置 `rateLimitWindow` 时各项为 0 / null。窗口已经走完时，`requests` / `tokens` / `cost` 报 0、`remainingSeconds` 为 0、`startAt` 为 null —— 因为下一次请求会开一个新窗口。

### serviceLimits

按模型族（service）拆分的限制，只列出该 Key **配置了限制**的模型族。每项同时给出限制值与当前用量。

`exceeded` 为 true 表示这一项里至少有一个已配置的限制已经达到。取值为 `0` 的限制表示未配置，不参与判断。

### accounts

绑定账户的上游配额快照。

**只有专属（`dedicated`）账户才返回配额。** 共享账户的额度由多个 Key 共用，暴露给任一持有者等于泄露跨租户信息，因此返回：

```jsonc
{
  "accountId": "acc-1",
  "accountType": "shared",
  "codexUsage": null,
  "claudeUsage": null,
  "reason": "shared_account_quota_not_exposed"
}
```

没有绑定任何专属账户时，`accounts` 为 `null`。

#### codexUsage

| 字段 | 含义 |
| --- | --- |
| `updatedAt` | 这份快照最后一次被任意来源写入的时间 |
| `source` | 最后一次写入的来源：`wham`（上游完整快照）/ `headers`（业务响应头补充）/ `legacy`（旧格式迁移） |
| `whamFetchedAt` | 上游权威接口最后一次成功应答的时间，可能为 null（从未成功拉取过）。**不会被响应头写入重置** |
| `isStale` | `updatedAt` 超过新鲜度阈值（15 分钟）为 true |
| `rateLimitReachedType` | 上游报告的「触发了哪个限制」，仅完整快照提供 |
| `limits[]` | 按 `limitId` 分组的限额桶 |

`updatedAt` 和 `whamFetchedAt` 是两件事：前者回答「这些数字有多新」，后者回答「上游权威数据有多久没校正过」。活跃账户的 `updatedAt` 会被业务流量频繁刷新，但 `whamFetchedAt` 只在真正调用过上游接口时才前进。

`limits[]` 每项：

| 字段 | 含义 |
| --- | --- |
| `limitId` | 限额桶标识。`codex` 是默认共享桶，其余是分模型族的附加桶 |
| `limitName` | 人类可读名称，如 `GPT-5.6 Sol` |
| `meteredFeature` | 上游的计量特性标识（可能为 null） |
| `primary` / `secondary` | 两个窗口槽位，**没有该窗口时为 null** |

**重要：`primary` / `secondary` 只是槽位，不代表窗口长度。** 窗口的真实含义由 `windowMinutes` 决定：

| windowMinutes | 含义 |
| --- | --- |
| 300 | 5 小时 |
| 1440 | 日 |
| 10080 | 周 |
| 43200 | 月 |
| 525600 | 年 |

周限完全可能单独出现在 `primary`。请按 `windowMinutes` 生成标签，不要按槽位名假设。

窗口对象：

| 字段 | 含义 |
| --- | --- |
| `usedPercent` | 已使用百分比。剩余 = `100 - usedPercent` |
| `windowMinutes` | 窗口长度 |
| `resetAt` | **绝对**重置时间，倒计时请以它为准 |
| `remainingSeconds` | 服务端在响应生成时算好的剩余秒数，仅作便利字段 |

上游只提供百分比，**不提供可以稳定换算的「剩余 token 数」**。Codex 的消耗受模型、上下文大小、任务复杂度和运行方式影响，百分比无法可靠折算成 token。

#### codexAvailability

最近一次观察到的上游可用性，用于区分「额度用完」和「模型暂时没容量」。

| state | 含义 | 是否代表额度耗尽 |
| --- | --- | --- |
| `ok` | 正常 | 否 |
| `quota_exhausted` | 额度达到限制 | 是 |
| `server_overloaded` | 模型容量暂时不足（`Selected model is at capacity`） | **否** |
| `model_not_available` | 账户无该模型权限或模型不存在 | 否 |
| `client_identity_rejected` | 客户端身份或版本不被接受 | 否 |
| `unknown_upstream_error` | 其他上游错误 | 否 |

`account` 是账户级状态，`models` 按模型名分别记录。展示时请把 `server_overloaded` 单独呈现，**不要画成 100% 用量**。

## 数据新鲜度

上游配额来自两条本地缓存路径，本接口都不会主动触发：

1. **业务请求响应头** —— 每次有客户端经本服务发 Codex 请求时，从响应头抓取并写入。只更新本次响应中出现的限额桶，**不推进 `whamFetchedAt`**。
2. **管理端刷新** —— 打开管理后台账户页时触发 `/admin/openai-accounts/usage`，调上游完整快照接口。

因此：一个长期闲置、且没人打开过管理页的账户，`isStale` 会是 true。此时数值仍然是最后一次真实观测的结果，只是不再代表当下。工具端应当据此提示用户，而不是把陈旧数据当实时值展示。

### 轮询这个接口是安全的

`GET /apiStats/api/key-usage` 全程只读 Redis，**不会向上游发起任何请求，也不写任何计数器**。定时脚本按任意频率轮询它，上游收到的请求数都是 0。`tests/keyUsageNoUpstream.test.js` 用真实服务 + 抛异常的 axios 桩守住了这个契约。

需要注意的是另一个接口：`GET /admin/openai-accounts/usage`（管理后台用）**会**打上游。它受两道闸门约束：

- 冷却时钟按 `whamFetchedAt` 计算（不是 `updatedAt`），所以业务流量不会让活跃账户在每次轮询时重新拉取；
- 一个 Redis `SET NX` 冷却锁，使「每账户每 5 分钟最多一次上游请求」成为硬保证，而不是靠时间戳比较——多个管理端同时打开也不会重复拉取；
- 拉取未得出结论时（403、代理故障、token 刷新失败）退避窗口延长到 30 分钟，避免一个不支持该接口的账户变成对上游的永久固定心跳。

如果你要写监控脚本，请用 `key-usage` 而不是管理端那个接口。

## 错误码

| 状态码 | error | 场景 |
| --- | --- | --- |
| 400 | `Missing API key` | 没有 `Authorization: Bearer` 头 |
| 400 | `Invalid API key format` | Key 长度不合法 |
| 401 | `Invalid API key` | Key 不存在或校验失败 |
| 403 | `API key unavailable` | Key 已被禁用或已过期 |
| 500 | `Internal server error` | 服务端异常 |

## 消费示例

### JavaScript

```javascript
async function fetchKeyUsage(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl}/apiStats/api/key-usage`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `HTTP ${res.status}`)
  }

  const { data } = await res.json()

  // 按 windowMinutes 生成标签，不要按槽位名假设
  const label = (minutes) =>
    ({ 300: '5h', 1440: '日限', 10080: '周限', 43200: '月限', 525600: '年限' })[minutes] ||
    `${minutes}分钟`

  const codex = data.accounts?.openai?.codexUsage
  if (codex) {
    if (codex.isStale) {
      console.warn(`额度数据已过期（${codex.updatedAt}）`)
    }

    for (const limit of codex.limits) {
      for (const slot of ['primary', 'secondary']) {
        const w = limit[slot]
        if (!w) continue // 该窗口不存在，不要渲染
        const name = limit.limitId === 'codex' ? '' : `${limit.limitName} - `
        console.log(
          `${name}${label(w.windowMinutes)}: 已用 ${w.usedPercent}% / 剩 ${100 - w.usedPercent}%，` +
            `重置于 ${w.resetAt}`
        )
      }
    }
  }

  return data
}
```

### Python

```python
import requests

WINDOW_LABELS = {300: "5h", 1440: "日限", 10080: "周限", 43200: "月限", 525600: "年限"}


def fetch_key_usage(base_url: str, api_key: str) -> dict:
    res = requests.get(
        f"{base_url}/apiStats/api/key-usage",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=10,
    )
    res.raise_for_status()
    data = res.json()["data"]

    codex = (data.get("accounts") or {}).get("openai", {}).get("codexUsage")
    if codex:
        if codex["isStale"]:
            print(f"额度数据已过期（{codex['updatedAt']}）")

        for limit in codex["limits"]:
            for slot in ("primary", "secondary"):
                window = limit.get(slot)
                if not window:  # 该窗口不存在，不要渲染
                    continue
                minutes = window["windowMinutes"]
                label = WINDOW_LABELS.get(minutes, f"{minutes}分钟")
                prefix = "" if limit["limitId"] == "codex" else f"{limit['limitName']} - "
                print(
                    f"{prefix}{label}: 已用 {window['usedPercent']}% / "
                    f"剩 {100 - window['usedPercent']}%，重置于 {window['resetAt']}"
                )

    return data
```

## 与 `/apiStats/api/user-stats` 的区别

`POST /apiStats/api/user-stats` 是管理页在用的接口，同样只读本地，但：

- 用 POST + body 传 Key
- 不返回分模型族的 `serviceLimits` 用量
- 不返回快照新鲜度标记

两个接口共用同一份窗口读取逻辑（`src/utils/apiKeyUsageHelper.js`），不会出现数据不一致。新工具建议用 `key-usage`。
