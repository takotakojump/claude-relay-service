const redisClient = require('../../models/redis')
const { v4: uuidv4 } = require('uuid')
const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
// const { maskToken } = require('../../utils/tokenMask')
const {
  logRefreshStart,
  logRefreshSuccess,
  logRefreshError,
  logTokenUsage,
  logRefreshSkipped
} = require('../../utils/tokenRefreshLogger')
const tokenRefreshService = require('../tokenRefreshService')
const codexClientIdentityService = require('../codexClientIdentityService')
const { createEncryptor } = require('../../utils/commonHelper')
const { resolveResetAt, normalizeLimitId } = require('../../utils/codexRateLimitHeaders')

// 使用 commonHelper 的加密器
const encryptor = createEncryptor('openai-account-salt')
const { encrypt, decrypt } = encryptor

// OpenAI 账户键前缀
const OPENAI_ACCOUNT_KEY_PREFIX = 'openai:account:'
const SHARED_OPENAI_ACCOUNTS_KEY = 'shared_openai_accounts'
const ACCOUNT_SESSION_MAPPING_PREFIX = 'openai_session_account_mapping:'

// Codex quota is stored as one JSON blob keyed by limitId. Overwriting the whole document is what
// gives us delete semantics: a window or bucket that upstream stopped reporting simply stops
// existing, instead of lingering forever as a ghost card.
const CODEX_USAGE_SNAPSHOT_FIELD = 'codexUsageSnapshot'
const CODEX_AVAILABILITY_FIELD = 'codexAvailability'

// Cooldown gate keeping /wham/usage to at most one request per account per window
const CODEX_USAGE_FETCH_LOCK_PREFIX = 'openai:account:codex_usage_fetch:'

/**
 * Compare-and-set on a single hash field.
 *
 * Both Codex writers are read-merge-write, and concurrent responses for the same account would
 * otherwise clobber each other — a bucket updated by one response could silently revert. This
 * carries no domain logic on purpose: the merge stays in JS, Lua only guards the swap.
 *
 * Returns 1 when the write landed, 0 when the field moved underneath us.
 */
const CAS_HSET_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current == false then current = '' end
if current == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0
`

const CAS_MAX_ATTEMPTS = 3

// Pre-rewrite flat fields. Read for migration, deleted on the first write of the new shape.
const LEGACY_CODEX_USAGE_FIELDS = [
  'codexPrimaryUsedPercent',
  'codexPrimaryResetAfterSeconds',
  'codexPrimaryWindowMinutes',
  'codexSecondaryUsedPercent',
  'codexSecondaryResetAfterSeconds',
  'codexSecondaryWindowMinutes',
  'codexPrimaryOverSecondaryLimitPercent',
  'codexUsageUpdatedAt'
]

// Beyond this age a snapshot is flagged stale. Deliberately longer than the admin refresh TTL so
// normal page loads do not paint everything as stale between refreshes.
const CODEX_USAGE_STALE_AFTER_MS = 15 * 60 * 1000

// Authoritative quota source. Business response headers are a real-time supplement on top of it.
const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_USAGE_REQUEST_TIMEOUT_MS = 15000

// The documented /wham/usage schema has not been verified against a live account; log the first
// successful payload once so the tolerant parsing can be tightened against reality later.
let whamShapeLogged = false

// 🧹 定期清理缓存（每10分钟）
setInterval(
  () => {
    encryptor.clearCache()
    logger.info('🧹 OpenAI decrypt cache cleanup completed', encryptor.getStats())
  },
  10 * 60 * 1000
)

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function parseJsonOrNull(raw) {
  if (!raw || typeof raw !== 'string') {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

/**
 * Read a hash field, let the caller merge it, then write back only if nobody else moved it.
 *
 * `merge` receives the raw stored string (null when absent) and returns the string to store, or
 * null to skip the write entirely. Retries a bounded number of times on contention, then falls
 * back to an unconditional write — losing a concurrent update is bad, dropping the observation
 * entirely is worse.
 */
async function casUpdateField(client, key, field, merge) {
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const currentRaw = await client.hget(key, field)
    const nextRaw = await merge(currentRaw)

    if (nextRaw === null || nextRaw === undefined) {
      return false
    }

    const swapped = await client.eval(
      CAS_HSET_SCRIPT,
      1,
      key,
      field,
      currentRaw === null || currentRaw === undefined ? '' : currentRaw,
      nextRaw
    )

    if (Number(swapped) === 1) {
      return true
    }
  }

  const finalRaw = await merge(await client.hget(key, field))
  if (finalRaw === null || finalRaw === undefined) {
    return false
  }

  logger.debug(`⚠️ CAS contention on ${key}#${field}, falling back to unconditional write`)
  await client.hset(key, field, finalRaw)
  return true
}

function parseStoredCodexSnapshot(raw) {
  const parsed = parseJsonOrNull(raw)
  if (!parsed || !Array.isArray(parsed.limits)) {
    return null
  }
  return parsed
}

// Attach a live countdown derived from the absolute reset time. The countdown is never stored —
// deriving it from a stored relative offset is what made old windows drift forward forever.
function decorateCodexWindow(window, nowMs) {
  if (!window) {
    return null
  }

  const resetMs = window.resetAt ? Date.parse(window.resetAt) : NaN

  return {
    usedPercent: toNumberOrNull(window.usedPercent),
    windowMinutes: toNumberOrNull(window.windowMinutes),
    resetAt: window.resetAt || null,
    remainingSeconds: Number.isFinite(resetMs)
      ? Math.max(0, Math.round((resetMs - nowMs) / 1000))
      : null
  }
}

// Migration path for accounts written before the snapshot rewrite. The old schema stored relative
// reset offsets, so convert them against the timestamp they were captured with — once.
function buildLegacyCodexSnapshot(accountData) {
  const updatedAt = accountData.codexUsageUpdatedAt || null
  const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN

  const buildWindow = (usedPercentRaw, resetAfterSecondsRaw, windowMinutesRaw) => {
    const usedPercent = toNumberOrNull(usedPercentRaw)
    const resetAfterSeconds = toNumberOrNull(resetAfterSecondsRaw)
    const windowMinutes = toNumberOrNull(windowMinutesRaw)

    if (usedPercent === null && resetAfterSeconds === null && windowMinutes === null) {
      return null
    }

    const resetAt =
      resetAfterSeconds !== null && Number.isFinite(updatedMs)
        ? new Date(updatedMs + resetAfterSeconds * 1000).toISOString()
        : null

    return { usedPercent, windowMinutes, resetAt }
  }

  const primary = buildWindow(
    accountData.codexPrimaryUsedPercent,
    accountData.codexPrimaryResetAfterSeconds,
    accountData.codexPrimaryWindowMinutes
  )
  const secondary = buildWindow(
    accountData.codexSecondaryUsedPercent,
    accountData.codexSecondaryResetAfterSeconds,
    accountData.codexSecondaryWindowMinutes
  )

  if (!primary && !secondary) {
    return null
  }

  return {
    updatedAt,
    source: 'legacy',
    rateLimitReachedType: null,
    limits: [
      {
        limitId: 'codex',
        limitName: 'Codex',
        meteredFeature: null,
        capturedAt: updatedAt,
        primary,
        secondary,
        primaryOverSecondaryPercent: toNumberOrNull(
          accountData.codexPrimaryOverSecondaryLimitPercent
        )
      }
    ]
  }
}

function buildCodexUsageSnapshot(accountData) {
  if (!accountData || typeof accountData !== 'object') {
    return null
  }

  const stored =
    parseStoredCodexSnapshot(accountData[CODEX_USAGE_SNAPSHOT_FIELD]) ||
    buildLegacyCodexSnapshot(accountData)

  if (!stored) {
    return null
  }

  const now = Date.now()
  const updatedMs = stored.updatedAt ? Date.parse(stored.updatedAt) : NaN

  return {
    updatedAt: stored.updatedAt || null,
    source: stored.source || 'headers',
    // Drives the upstream refresh cooldown. Survives header writes on purpose — see
    // updateCodexUsageSnapshot.
    whamFetchedAt: stored.whamFetchedAt || null,
    rateLimitReachedType: stored.rateLimitReachedType || null,
    // Surfaced so the UI can say "this is old" instead of presenting a frozen snapshot as live.
    isStale: !Number.isFinite(updatedMs) || now - updatedMs > CODEX_USAGE_STALE_AFTER_MS,
    limits: stored.limits.map((limit) => ({
      limitId: limit.limitId,
      limitName: limit.limitName || null,
      meteredFeature: limit.meteredFeature || null,
      capturedAt: limit.capturedAt || stored.updatedAt || null,
      primary: decorateCodexWindow(limit.primary, now),
      secondary: decorateCodexWindow(limit.secondary, now),
      primaryOverSecondaryPercent: toNumberOrNull(limit.primaryOverSecondaryPercent)
    }))
  }
}

function buildCodexAvailability(accountData) {
  if (!accountData || typeof accountData !== 'object') {
    return null
  }
  return parseJsonOrNull(accountData[CODEX_AVAILABILITY_FIELD])
}

// 刷新访问令牌
async function refreshAccessToken(refreshToken, proxy = null) {
  try {
    // Codex CLI 的官方 CLIENT_ID
    const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

    // 准备请求数据
    const requestData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: 'openid profile email'
    }).toString()

    // 配置请求选项
    const requestOptions = {
      method: 'POST',
      url: 'https://auth.openai.com/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': requestData.length
      },
      data: requestData,
      timeout: config.requestTimeout || 600000 // 使用统一的请求超时配置
    }

    // 配置代理（如果有）
    const proxyAgent = ProxyHelper.createProxyAgent(proxy)
    if (proxyAgent) {
      requestOptions.httpAgent = proxyAgent
      requestOptions.httpsAgent = proxyAgent
      requestOptions.proxy = false
      logger.info(
        `🌐 Using proxy for OpenAI token refresh: ${ProxyHelper.getProxyDescription(proxy)}`
      )
    } else {
      logger.debug('🌐 No proxy configured for OpenAI token refresh')
    }

    // 发送请求
    logger.info('🔍 发送 token 刷新请求，使用代理:', !!requestOptions.httpsAgent)
    const response = await axios(requestOptions)

    if (response.status === 200 && response.data) {
      const result = response.data

      logger.info('✅ Successfully refreshed OpenAI token')

      // 返回新的 token 信息
      return {
        access_token: result.access_token,
        id_token: result.id_token,
        refresh_token: result.refresh_token || refreshToken, // 如果没有返回新的，保留原来的
        expires_in: result.expires_in || 3600,
        expiry_date: Date.now() + (result.expires_in || 3600) * 1000 // 计算过期时间
      }
    } else {
      throw new Error(`Failed to refresh token: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    if (error.response) {
      // 服务器响应了错误状态码
      const errorData = error.response.data || {}
      logger.error('OpenAI token refresh failed:', {
        status: error.response.status,
        data: errorData,
        headers: error.response.headers
      })

      // 构建详细的错误信息
      let errorMessage = `OpenAI 服务器返回错误 (${error.response.status})`

      if (error.response.status === 400) {
        if (errorData.error === 'invalid_grant') {
          errorMessage = 'Refresh Token 无效或已过期，请重新授权'
        } else if (errorData.error === 'invalid_request') {
          errorMessage = `请求参数错误：${errorData.error_description || errorData.error}`
        } else {
          errorMessage = `请求错误：${errorData.error_description || errorData.error || '未知错误'}`
        }
      } else if (error.response.status === 401) {
        errorMessage = '认证失败：Refresh Token 无效'
      } else if (error.response.status === 403) {
        errorMessage = '访问被拒绝：可能是 IP 被封或账户被禁用'
      } else if (error.response.status === 429) {
        errorMessage = '请求过于频繁，请稍后重试'
      } else if (error.response.status >= 500) {
        errorMessage = 'OpenAI 服务器内部错误，请稍后重试'
      } else if (errorData.error_description) {
        errorMessage = errorData.error_description
      } else if (errorData.error) {
        errorMessage = errorData.error
      } else if (errorData.message) {
        errorMessage = errorData.message
      }

      const fullError = new Error(errorMessage)
      fullError.status = error.response.status
      fullError.details = errorData
      throw fullError
    } else if (error.request) {
      // 请求已发出但没有收到响应
      logger.error('OpenAI token refresh no response:', error.message)

      let errorMessage = '无法连接到 OpenAI 服务器'
      if (proxy) {
        errorMessage += `（代理: ${ProxyHelper.getProxyDescription(proxy)}）`
      }
      if (error.code === 'ECONNREFUSED') {
        errorMessage += ' - 连接被拒绝'
      } else if (error.code === 'ETIMEDOUT') {
        errorMessage += ' - 连接超时'
      } else if (error.code === 'ENOTFOUND') {
        errorMessage += ' - 无法解析域名'
      } else if (error.code === 'EPROTO') {
        errorMessage += ' - 协议错误（可能是代理配置问题）'
      } else if (error.message) {
        errorMessage += ` - ${error.message}`
      }

      const fullError = new Error(errorMessage)
      fullError.code = error.code
      throw fullError
    } else {
      // 设置请求时发生错误
      logger.error('OpenAI token refresh error:', error.message)
      const fullError = new Error(`请求设置错误: ${error.message}`)
      fullError.originalError = error
      throw fullError
    }
  }
}

// 检查 token 是否过期
function isTokenExpired(account) {
  if (!account.expiresAt) {
    return false
  }
  return new Date(account.expiresAt) <= new Date()
}

/**
 * 检查账户订阅是否过期
 * @param {Object} account - 账户对象
 * @returns {boolean} - true: 已过期, false: 未过期
 */
function isSubscriptionExpired(account) {
  if (!account.subscriptionExpiresAt) {
    return false // 未设置视为永不过期
  }
  const expiryDate = new Date(account.subscriptionExpiresAt)
  return expiryDate <= new Date()
}

// 刷新账户的 access token（带分布式锁）
async function refreshAccountToken(accountId) {
  let lockAcquired = false
  let account = null
  let accountName = accountId

  try {
    account = await getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    accountName = account.name || accountId

    // 检查是否有 refresh token
    // account.refreshToken 在 getAccount 中已经被解密了，直接使用即可
    const refreshToken = account.refreshToken || null

    if (!refreshToken) {
      logRefreshSkipped(accountId, accountName, 'openai', 'No refresh token available')
      throw new Error('No refresh token available')
    }

    // 尝试获取分布式锁
    lockAcquired = await tokenRefreshService.acquireRefreshLock(accountId, 'openai')

    if (!lockAcquired) {
      // 如果无法获取锁，说明另一个进程正在刷新
      logger.info(
        `🔒 Token refresh already in progress for OpenAI account: ${accountName} (${accountId})`
      )
      logRefreshSkipped(accountId, accountName, 'openai', 'already_locked')

      // 等待一段时间后返回，期望其他进程已完成刷新
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // 重新获取账户数据（可能已被其他进程刷新）
      const updatedAccount = await getAccount(accountId)
      if (updatedAccount && !isTokenExpired(updatedAccount)) {
        return {
          access_token: decrypt(updatedAccount.accessToken),
          id_token: updatedAccount.idToken,
          refresh_token: updatedAccount.refreshToken,
          expires_in: 3600,
          expiry_date: new Date(updatedAccount.expiresAt).getTime()
        }
      }

      throw new Error('Token refresh in progress by another process')
    }

    // 获取锁成功，开始刷新
    logRefreshStart(accountId, accountName, 'openai')
    logger.info(`🔄 Starting token refresh for OpenAI account: ${accountName} (${accountId})`)

    // 获取代理配置
    let proxy = null
    if (account.proxy) {
      try {
        proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
      } catch (e) {
        logger.warn(`Failed to parse proxy config for account ${accountId}:`, e)
      }
    }

    const newTokens = await refreshAccessToken(refreshToken, proxy)
    if (!newTokens) {
      throw new Error('Failed to refresh token')
    }

    // 准备更新数据 - 不要在这里加密，让 updateAccount 统一处理
    const updates = {
      accessToken: newTokens.access_token, // 不加密，让 updateAccount 处理
      expiresAt: new Date(newTokens.expiry_date).toISOString()
    }

    // 如果有新的 ID token，也更新它（这对于首次未提供 ID Token 的账户特别重要）
    if (newTokens.id_token) {
      updates.idToken = newTokens.id_token // 不加密，让 updateAccount 处理

      // 如果之前没有 ID Token，尝试解析并更新用户信息
      if (!account.idToken || account.idToken === '') {
        try {
          const idTokenParts = newTokens.id_token.split('.')
          if (idTokenParts.length === 3) {
            const payload = JSON.parse(Buffer.from(idTokenParts[1], 'base64').toString())
            const authClaims = payload['https://api.openai.com/auth'] || {}

            // 更新账户信息 - 使用正确的字段名
            // OpenAI ID Token中用户ID在chatgpt_account_id、chatgpt_user_id和user_id字段
            if (authClaims.chatgpt_account_id) {
              updates.accountId = authClaims.chatgpt_account_id
            }
            if (authClaims.chatgpt_user_id) {
              updates.chatgptUserId = authClaims.chatgpt_user_id
            } else if (authClaims.user_id) {
              // 有些情况下可能只有user_id字段
              updates.chatgptUserId = authClaims.user_id
            }
            if (authClaims.organizations?.[0]?.id) {
              updates.organizationId = authClaims.organizations[0].id
            }
            if (authClaims.organizations?.[0]?.role) {
              updates.organizationRole = authClaims.organizations[0].role
            }
            if (authClaims.organizations?.[0]?.title) {
              updates.organizationTitle = authClaims.organizations[0].title
            }
            if (payload.email) {
              updates.email = payload.email // 不加密，让 updateAccount 处理
            }
            if (payload.email_verified !== undefined) {
              updates.emailVerified = payload.email_verified
            }

            logger.info(`Updated user info from ID Token for account ${accountId}`)
          }
        } catch (e) {
          logger.warn(`Failed to parse ID Token for account ${accountId}:`, e)
        }
      }
    }

    // 如果返回了新的 refresh token，更新它
    if (newTokens.refresh_token && newTokens.refresh_token !== refreshToken) {
      updates.refreshToken = newTokens.refresh_token // 不加密，让 updateAccount 处理
      logger.info(`Updated refresh token for account ${accountId}`)
    }

    // 更新账户信息
    await updateAccount(accountId, updates)

    logRefreshSuccess(accountId, accountName, 'openai', newTokens) // 传入完整的 newTokens 对象
    return newTokens
  } catch (error) {
    logRefreshError(accountId, account?.name || accountName, 'openai', error.message)

    // 发送 Webhook 通知（如果启用）
    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account?.name || accountName,
        platform: 'openai',
        status: 'error',
        errorCode: 'OPENAI_TOKEN_REFRESH_FAILED',
        reason: `Token refresh failed: ${error.message}`,
        timestamp: new Date().toISOString()
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI account ${account?.name || accountName} refresh failure`
      )
    } catch (webhookError) {
      logger.error('Failed to send webhook notification:', webhookError)
    }

    throw error
  } finally {
    // 确保释放锁
    if (lockAcquired) {
      await tokenRefreshService.releaseRefreshLock(accountId, 'openai')
      logger.debug(`🔓 Released refresh lock for OpenAI account ${accountId}`)
    }
  }
}

// 创建账户
async function createAccount(accountData) {
  const accountId = uuidv4()
  const now = new Date().toISOString()

  // 处理OAuth数据
  let oauthData = {}
  if (accountData.openaiOauth) {
    oauthData =
      typeof accountData.openaiOauth === 'string'
        ? JSON.parse(accountData.openaiOauth)
        : accountData.openaiOauth
  }

  // 处理账户信息
  const accountInfo = accountData.accountInfo || {}

  // 检查邮箱是否已经是加密格式（包含冒号分隔的32位十六进制字符）
  const isEmailEncrypted =
    accountInfo.email && accountInfo.email.length >= 33 && accountInfo.email.charAt(32) === ':'

  const account = {
    id: accountId,
    name: accountData.name,
    description: accountData.description || '',
    accountType: accountData.accountType || 'shared',
    groupId: accountData.groupId || null,
    priority: accountData.priority || 50,
    rateLimitDuration:
      accountData.rateLimitDuration !== undefined && accountData.rateLimitDuration !== null
        ? accountData.rateLimitDuration
        : 60,
    // OAuth相关字段（加密存储）
    // ID Token 现在是可选的，如果没有提供会在首次刷新时自动获取
    idToken: oauthData.idToken && oauthData.idToken.trim() ? encrypt(oauthData.idToken) : '',
    accessToken:
      oauthData.accessToken && oauthData.accessToken.trim() ? encrypt(oauthData.accessToken) : '',
    refreshToken:
      oauthData.refreshToken && oauthData.refreshToken.trim()
        ? encrypt(oauthData.refreshToken)
        : '',
    openaiOauth: encrypt(JSON.stringify(oauthData)),
    // 账户信息字段 - 确保所有字段都被保存，即使是空字符串
    accountId: accountInfo.accountId || '',
    chatgptUserId: accountInfo.chatgptUserId || '',
    organizationId: accountInfo.organizationId || '',
    organizationRole: accountInfo.organizationRole || '',
    organizationTitle: accountInfo.organizationTitle || '',
    planType: accountInfo.planType || '',
    // 邮箱字段：检查是否已经加密，避免双重加密
    email: isEmailEncrypted ? accountInfo.email : encrypt(accountInfo.email || ''),
    emailVerified: accountInfo.emailVerified === true ? 'true' : 'false',
    // 过期时间
    expiresAt: oauthData.expires_in
      ? new Date(Date.now() + oauthData.expires_in * 1000).toISOString()
      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // OAuth Token 过期时间（技术字段）

    // ✅ 新增：账户订阅到期时间（业务字段，手动管理）
    subscriptionExpiresAt: accountData.subscriptionExpiresAt || null,

    // 状态字段
    isActive: accountData.isActive !== false ? 'true' : 'false',
    status: 'active',
    schedulable: accountData.schedulable !== false ? 'true' : 'false',
    // 自动防护开关
    disableAutoProtection:
      accountData.disableAutoProtection === true || accountData.disableAutoProtection === 'true'
        ? 'true'
        : 'false',
    lastRefresh: now,
    createdAt: now,
    updatedAt: now
  }

  // 代理配置
  if (accountData.proxy) {
    account.proxy =
      typeof accountData.proxy === 'string' ? accountData.proxy : JSON.stringify(accountData.proxy)
  }

  const client = redisClient.getClientSafe()
  await client.hset(`${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`, account)
  await redisClient.addToIndex('openai:account:index', accountId)

  // 如果是共享账户，添加到共享账户集合
  if (account.accountType === 'shared') {
    await client.sadd(SHARED_OPENAI_ACCOUNTS_KEY, accountId)
  }

  logger.info(`Created OpenAI account: ${accountId}`)
  return account
}

// 获取账户
async function getAccount(accountId) {
  const client = redisClient.getClientSafe()
  const accountData = await client.hgetall(`${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`)

  if (!accountData || Object.keys(accountData).length === 0) {
    return null
  }

  // 解密敏感数据（仅用于内部处理，不返回给前端）
  if (accountData.idToken) {
    accountData.idToken = decrypt(accountData.idToken)
  }
  // 注意：accessToken 在 openaiRoutes.js 中会被单独解密，这里不解密
  // if (accountData.accessToken) {
  //   accountData.accessToken = decrypt(accountData.accessToken)
  // }
  if (accountData.refreshToken) {
    accountData.refreshToken = decrypt(accountData.refreshToken)
  }
  if (accountData.email) {
    accountData.email = decrypt(accountData.email)
  }
  if (accountData.openaiOauth) {
    try {
      accountData.openaiOauth = JSON.parse(decrypt(accountData.openaiOauth))
    } catch (e) {
      accountData.openaiOauth = null
    }
  }

  // 解析代理配置
  if (accountData.proxy && typeof accountData.proxy === 'string') {
    try {
      accountData.proxy = JSON.parse(accountData.proxy)
    } catch (e) {
      accountData.proxy = null
    }
  }

  return accountData
}

// 更新账户
async function updateAccount(accountId, updates) {
  const existingAccount = await getAccount(accountId)
  if (!existingAccount) {
    throw new Error('Account not found')
  }

  updates.updatedAt = new Date().toISOString()

  // 加密敏感数据
  if (updates.openaiOauth) {
    const oauthData =
      typeof updates.openaiOauth === 'string'
        ? updates.openaiOauth
        : JSON.stringify(updates.openaiOauth)
    updates.openaiOauth = encrypt(oauthData)
  }
  if (updates.idToken) {
    updates.idToken = encrypt(updates.idToken)
  }
  if (updates.accessToken) {
    updates.accessToken = encrypt(updates.accessToken)
  }
  if (updates.refreshToken && updates.refreshToken.trim()) {
    updates.refreshToken = encrypt(updates.refreshToken)
  }
  if (updates.email) {
    updates.email = encrypt(updates.email)
  }

  // 处理代理配置
  if (updates.proxy) {
    updates.proxy =
      typeof updates.proxy === 'string' ? updates.proxy : JSON.stringify(updates.proxy)
  }

  // ✅ 如果通过路由映射更新了 subscriptionExpiresAt，直接保存
  // subscriptionExpiresAt 是业务字段，与 token 刷新独立
  if (updates.subscriptionExpiresAt !== undefined) {
    // 直接保存，不做任何调整
  }

  // 处理 disableAutoProtection 布尔值转字符串
  if (updates.disableAutoProtection !== undefined) {
    updates.disableAutoProtection =
      updates.disableAutoProtection === true || updates.disableAutoProtection === 'true'
        ? 'true'
        : 'false'
  }

  // 更新账户类型时处理共享账户集合
  const client = redisClient.getClientSafe()
  if (updates.accountType && updates.accountType !== existingAccount.accountType) {
    if (updates.accountType === 'shared') {
      await client.sadd(SHARED_OPENAI_ACCOUNTS_KEY, accountId)
    } else {
      await client.srem(SHARED_OPENAI_ACCOUNTS_KEY, accountId)
    }
  }

  await client.hset(`${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`, updates)

  logger.info(`Updated OpenAI account: ${accountId}`)

  // 合并更新后的账户数据
  const updatedAccount = { ...existingAccount, ...updates }

  // 返回时解析代理配置
  if (updatedAccount.proxy && typeof updatedAccount.proxy === 'string') {
    try {
      updatedAccount.proxy = JSON.parse(updatedAccount.proxy)
    } catch (e) {
      updatedAccount.proxy = null
    }
  }

  return updatedAccount
}

// 删除账户
async function deleteAccount(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  // 从 Redis 删除
  const client = redisClient.getClientSafe()
  await client.del(`${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`)
  await redisClient.removeFromIndex('openai:account:index', accountId)

  // 从共享账户集合中移除
  if (account.accountType === 'shared') {
    await client.srem(SHARED_OPENAI_ACCOUNTS_KEY, accountId)
  }

  // 清理会话映射（使用反向索引）
  const sessionHashes = await client.smembers(`openai_account_sessions:${accountId}`)
  if (sessionHashes.length > 0) {
    const pipeline = client.pipeline()
    sessionHashes.forEach((hash) => pipeline.del(`${ACCOUNT_SESSION_MAPPING_PREFIX}${hash}`))
    pipeline.del(`openai_account_sessions:${accountId}`)
    await pipeline.exec()
  }

  logger.info(`Deleted OpenAI account: ${accountId}`)
  return true
}

// 获取所有账户
async function getAllAccounts() {
  const _client = redisClient.getClientSafe()
  const accountIds = await redisClient.getAllIdsByIndex(
    'openai:account:index',
    `${OPENAI_ACCOUNT_KEY_PREFIX}*`,
    /^openai:account:(.+)$/
  )
  const keys = accountIds.map((id) => `${OPENAI_ACCOUNT_KEY_PREFIX}${id}`)
  const accounts = []
  const dataList = await redisClient.batchHgetallChunked(keys)

  for (let i = 0; i < keys.length; i++) {
    const accountData = dataList[i]
    if (accountData && Object.keys(accountData).length > 0) {
      const codexUsage = buildCodexUsageSnapshot(accountData)
      const codexAvailability = buildCodexAvailability(accountData)

      // 解密敏感数据（但不返回给前端）
      if (accountData.email) {
        accountData.email = decrypt(accountData.email)
      }

      // 先保存 refreshToken 是否存在的标记
      const hasRefreshTokenFlag = !!accountData.refreshToken
      const maskedAccessToken = accountData.accessToken ? '[ENCRYPTED]' : ''
      const maskedRefreshToken = accountData.refreshToken ? '[ENCRYPTED]' : ''
      const maskedOauth = accountData.openaiOauth ? '[ENCRYPTED]' : ''

      // 屏蔽敏感信息（token等不应该返回给前端）
      delete accountData.idToken
      delete accountData.accessToken
      delete accountData.refreshToken
      delete accountData.openaiOauth
      // 原始额度字段改由 codexUsage / codexAvailability 暴露
      delete accountData[CODEX_USAGE_SNAPSHOT_FIELD]
      delete accountData[CODEX_AVAILABILITY_FIELD]
      for (const legacyField of LEGACY_CODEX_USAGE_FIELDS) {
        delete accountData[legacyField]
      }

      // 获取限流状态信息
      const rateLimitInfo = await getAccountRateLimitInfo(accountData.id)

      // 解析代理配置
      if (accountData.proxy) {
        try {
          accountData.proxy = JSON.parse(accountData.proxy)
        } catch (e) {
          // 如果解析失败，设置为null
          accountData.proxy = null
        }
      }

      const tokenExpiresAt = accountData.expiresAt || null
      const subscriptionExpiresAt =
        accountData.subscriptionExpiresAt && accountData.subscriptionExpiresAt !== ''
          ? accountData.subscriptionExpiresAt
          : null

      // 不解密敏感字段，只返回基本信息
      accounts.push({
        ...accountData,
        isActive: accountData.isActive === 'true',
        schedulable: accountData.schedulable !== 'false',
        openaiOauth: maskedOauth,
        accessToken: maskedAccessToken,
        refreshToken: maskedRefreshToken,

        // ✅ 前端显示订阅过期时间（业务字段）
        tokenExpiresAt,
        subscriptionExpiresAt,
        expiresAt: subscriptionExpiresAt,

        // 添加 scopes 字段用于判断认证方式
        // 处理空字符串的情况
        scopes:
          accountData.scopes && accountData.scopes.trim() ? accountData.scopes.split(' ') : [],
        // 添加 hasRefreshToken 标记
        hasRefreshToken: hasRefreshTokenFlag,
        // 添加限流状态信息（统一格式）
        rateLimitStatus: rateLimitInfo
          ? {
              status: rateLimitInfo.status,
              isRateLimited: rateLimitInfo.isRateLimited,
              rateLimitedAt: rateLimitInfo.rateLimitedAt,
              rateLimitResetAt: rateLimitInfo.rateLimitResetAt,
              minutesRemaining: rateLimitInfo.minutesRemaining
            }
          : {
              status: 'normal',
              isRateLimited: false,
              rateLimitedAt: null,
              rateLimitResetAt: null,
              minutesRemaining: 0
            },
        codexUsage,
        codexAvailability
      })
    }
  }

  return accounts
}

// 获取单个账户的概要信息（用于外部展示基本状态）
async function getAccountOverview(accountId) {
  const client = redisClient.getClientSafe()
  const accountData = await client.hgetall(`${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`)

  if (!accountData || Object.keys(accountData).length === 0) {
    return null
  }

  const codexUsage = buildCodexUsageSnapshot(accountData)
  const codexAvailability = buildCodexAvailability(accountData)
  const rateLimitInfo = await getAccountRateLimitInfo(accountId)

  if (accountData.proxy) {
    try {
      accountData.proxy = JSON.parse(accountData.proxy)
    } catch (error) {
      accountData.proxy = null
    }
  }

  const scopes =
    accountData.scopes && accountData.scopes.trim() ? accountData.scopes.split(' ') : []

  return {
    id: accountData.id,
    accountType: accountData.accountType || 'shared',
    platform: accountData.platform || 'openai',
    isActive: accountData.isActive === 'true',
    schedulable: accountData.schedulable !== 'false',
    rateLimitStatus: rateLimitInfo || {
      status: 'normal',
      isRateLimited: false,
      rateLimitedAt: null,
      rateLimitResetAt: null,
      minutesRemaining: 0
    },
    codexUsage,
    codexAvailability,
    scopes
  }
}

// 选择可用账户（支持专属和共享账户）
async function selectAvailableAccount(apiKeyId, sessionHash = null) {
  // 首先检查是否有粘性会话
  const client = redisClient.getClientSafe()
  if (sessionHash) {
    const mappedAccountId = await client.get(`${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (mappedAccountId) {
      const account = await getAccount(mappedAccountId)
      if (account && account.isActive === 'true' && !isTokenExpired(account)) {
        logger.debug(`Using sticky session account: ${mappedAccountId}`)
        return account
      }
    }
  }

  // 获取 API Key 信息
  const apiKeyData = await client.hgetall(`api_key:${apiKeyId}`)

  // 检查是否绑定了 OpenAI 账户
  if (apiKeyData.openaiAccountId) {
    const account = await getAccount(apiKeyData.openaiAccountId)
    if (account && account.isActive === 'true') {
      // 检查 token 是否过期
      const isExpired = isTokenExpired(account)

      // 记录token使用情况
      logTokenUsage(account.id, account.name, 'openai', account.expiresAt, isExpired)

      if (isExpired) {
        await refreshAccountToken(account.id)
        return await getAccount(account.id)
      }

      // 创建粘性会话映射
      if (sessionHash) {
        await client.setex(
          `${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`,
          3600, // 1小时过期
          account.id
        )
        // 反向索引：accountId -> sessionHash（用于删除账户时快速清理）
        await client.sadd(`openai_account_sessions:${account.id}`, sessionHash)
        await client.expire(`openai_account_sessions:${account.id}`, 3600)
      }

      return account
    }
  }

  // 从共享账户池选择
  const sharedAccountIds = await client.smembers(SHARED_OPENAI_ACCOUNTS_KEY)
  const availableAccounts = []

  for (const accountId of sharedAccountIds) {
    const account = await getAccount(accountId)
    if (
      account &&
      account.isActive === 'true' &&
      !isRateLimited(account) &&
      !isSubscriptionExpired(account)
    ) {
      availableAccounts.push(account)
    } else if (account && isSubscriptionExpired(account)) {
      logger.debug(
        `⏰ Skipping expired OpenAI account: ${account.name}, expired at ${account.subscriptionExpiresAt}`
      )
    }
  }

  if (availableAccounts.length === 0) {
    throw new Error('No available OpenAI accounts')
  }

  // 选择使用最少的账户
  const selectedAccount = availableAccounts.reduce((prev, curr) => {
    const prevUsage = parseInt(prev.totalUsage || 0)
    const currUsage = parseInt(curr.totalUsage || 0)
    return prevUsage <= currUsage ? prev : curr
  })

  // 检查 token 是否过期
  if (isTokenExpired(selectedAccount)) {
    await refreshAccountToken(selectedAccount.id)
    return await getAccount(selectedAccount.id)
  }

  // 创建粘性会话映射
  if (sessionHash) {
    await client.setex(
      `${ACCOUNT_SESSION_MAPPING_PREFIX}${sessionHash}`,
      3600, // 1小时过期
      selectedAccount.id
    )
    await client.sadd(`openai_account_sessions:${selectedAccount.id}`, sessionHash)
    await client.expire(`openai_account_sessions:${selectedAccount.id}`, 3600)
  }

  return selectedAccount
}

// 检查账户是否被限流
function isRateLimited(account) {
  if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
    const limitedAt = new Date(account.rateLimitedAt).getTime()
    const now = Date.now()
    const limitDuration = 60 * 60 * 1000 // 1小时

    return now < limitedAt + limitDuration
  }
  return false
}

// 设置账户限流状态
async function setAccountRateLimited(accountId, isLimited, resetsInSeconds = null) {
  // disableAutoProtection 检查（仅在设置限流时）
  if (isLimited) {
    const account = await getAccount(accountId)
    if (
      account &&
      (account.disableAutoProtection === true || account.disableAutoProtection === 'true')
    ) {
      logger.info(
        `🛡️ Account ${accountId} has auto-protection disabled, skipping setAccountRateLimited`
      )
      upstreamErrorHelper.recordErrorHistory(accountId, 'openai', 429, 'rate_limit').catch(() => {})
      return
    }
  }

  const updates = {
    rateLimitStatus: isLimited ? 'limited' : 'normal',
    rateLimitedAt: isLimited ? new Date().toISOString() : null,
    // 限流时停止调度，解除限流时恢复调度
    schedulable: isLimited ? 'false' : 'true'
  }

  // 如果提供了重置时间（秒数），计算重置时间戳
  if (isLimited && resetsInSeconds !== null && resetsInSeconds > 0) {
    const resetTime = new Date(Date.now() + resetsInSeconds * 1000).toISOString()
    updates.rateLimitResetAt = resetTime
    logger.info(
      `🕐 Account ${accountId} will be reset at ${resetTime} (in ${resetsInSeconds} seconds / ${Math.ceil(resetsInSeconds / 60)} minutes)`
    )
  } else if (isLimited) {
    // 如果没有提供重置时间，使用默认的60分钟
    const defaultResetSeconds = 60 * 60 // 1小时
    const resetTime = new Date(Date.now() + defaultResetSeconds * 1000).toISOString()
    updates.rateLimitResetAt = resetTime
    logger.warn(
      `⚠️ No reset time provided for account ${accountId}, using default 60 minutes. Reset at ${resetTime}`
    )
  } else if (!isLimited) {
    updates.rateLimitResetAt = null
  }

  await updateAccount(accountId, updates)
  logger.info(
    `Set rate limit status for OpenAI account ${accountId}: ${updates.rateLimitStatus}, schedulable: ${updates.schedulable}`
  )

  // 如果被限流，发送 Webhook 通知
  if (isLimited) {
    try {
      const account = await getAccount(accountId)
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai',
        status: 'blocked',
        errorCode: 'OPENAI_RATE_LIMITED',
        reason: resetsInSeconds
          ? `Account rate limited (429 error). Reset in ${Math.ceil(resetsInSeconds / 60)} minutes`
          : 'Account rate limited (429 error). Estimated reset in 1 hour',
        timestamp: new Date().toISOString()
      })
      logger.info(`📢 Webhook notification sent for OpenAI account ${account.name} rate limit`)
    } catch (webhookError) {
      logger.error('Failed to send rate limit webhook notification:', webhookError)
    }
  }
}

// 🚫 标记账户为未授权状态（401错误）
async function markAccountUnauthorized(accountId, reason = 'OpenAI账号认证失败（401错误）') {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  // disableAutoProtection 检查
  if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
    logger.info(
      `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountUnauthorized`
    )
    upstreamErrorHelper.recordErrorHistory(accountId, 'openai', 401, 'auth_error').catch(() => {})
    return
  }

  const now = new Date().toISOString()
  const currentCount = parseInt(account.unauthorizedCount || '0', 10)
  const unauthorizedCount = Number.isFinite(currentCount) ? currentCount + 1 : 1

  const updates = {
    status: 'unauthorized',
    schedulable: 'false',
    errorMessage: reason,
    unauthorizedAt: now,
    unauthorizedCount: unauthorizedCount.toString()
  }

  await updateAccount(accountId, updates)
  logger.warn(
    `🚫 Marked OpenAI account ${account.name || accountId} as unauthorized due to 401 error`
  )

  try {
    const webhookNotifier = require('../../utils/webhookNotifier')
    await webhookNotifier.sendAccountAnomalyNotification({
      accountId,
      accountName: account.name || accountId,
      platform: 'openai',
      status: 'unauthorized',
      errorCode: 'OPENAI_UNAUTHORIZED',
      reason,
      timestamp: now
    })
    logger.info(
      `📢 Webhook notification sent for OpenAI account ${account.name} unauthorized state`
    )
  } catch (webhookError) {
    logger.error('Failed to send unauthorized webhook notification:', webhookError)
  }
}

// 🔄 重置账户所有异常状态
async function resetAccountStatus(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  const updates = {
    // 根据是否有有效的 accessToken 来设置 status
    status: account.accessToken ? 'active' : 'created',
    // 恢复可调度状态
    schedulable: 'true',
    // 清除错误相关字段
    errorMessage: null,
    rateLimitedAt: null,
    rateLimitStatus: 'normal',
    rateLimitResetAt: null
  }

  await updateAccount(accountId, updates)
  logger.info(`✅ Reset all error status for OpenAI account ${accountId}`)

  // 清除临时不可用状态
  await upstreamErrorHelper.clearTempUnavailable(accountId, 'openai').catch(() => {})

  // 发送 Webhook 通知
  try {
    const webhookNotifier = require('../../utils/webhookNotifier')
    await webhookNotifier.sendAccountAnomalyNotification({
      accountId,
      accountName: account.name || accountId,
      platform: 'openai',
      status: 'recovered',
      errorCode: 'STATUS_RESET',
      reason: 'Account status manually reset',
      timestamp: new Date().toISOString()
    })
    logger.info(`📢 Webhook notification sent for OpenAI account ${account.name} status reset`)
  } catch (webhookError) {
    logger.error('Failed to send status reset webhook notification:', webhookError)
  }

  return { success: true, message: 'Account status reset successfully' }
}

// 切换账户调度状态
async function toggleSchedulable(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  // 切换调度状态
  const newSchedulable = account.schedulable === 'false' ? 'true' : 'false'

  await updateAccount(accountId, {
    schedulable: newSchedulable
  })

  logger.info(`Toggled schedulable status for OpenAI account ${accountId}: ${newSchedulable}`)

  return {
    success: true,
    schedulable: newSchedulable === 'true'
  }
}

// 获取账户限流信息
async function getAccountRateLimitInfo(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    return null
  }

  const status = account.rateLimitStatus || 'normal'
  const rateLimitedAt = account.rateLimitedAt || null
  const rateLimitResetAt = account.rateLimitResetAt || null

  if (status === 'limited') {
    const now = Date.now()
    let remainingTime = 0

    if (rateLimitResetAt) {
      const resetAt = new Date(rateLimitResetAt).getTime()
      remainingTime = Math.max(0, resetAt - now)
    } else if (rateLimitedAt) {
      const limitedAt = new Date(rateLimitedAt).getTime()
      const limitDuration = 60 * 60 * 1000 // 默认1小时
      remainingTime = Math.max(0, limitedAt + limitDuration - now)
    }

    const minutesRemaining = remainingTime > 0 ? Math.ceil(remainingTime / (60 * 1000)) : 0

    return {
      status,
      isRateLimited: minutesRemaining > 0,
      rateLimitedAt,
      rateLimitResetAt,
      minutesRemaining
    }
  }

  return {
    status,
    isRateLimited: false,
    rateLimitedAt,
    rateLimitResetAt,
    minutesRemaining: 0
  }
}

// 更新账户使用统计（tokens参数可选，默认为0，仅更新最后使用时间）
async function updateAccountUsage(accountId, tokens = 0) {
  const account = await getAccount(accountId)
  if (!account) {
    return
  }

  const updates = {
    lastUsedAt: new Date().toISOString()
  }

  // 如果有 tokens 参数且大于0，同时更新使用统计
  if (tokens > 0) {
    const totalUsage = parseInt(account.totalUsage || 0) + tokens
    updates.totalUsage = totalUsage.toString()
  }

  await updateAccount(accountId, updates)
}

// 为了兼容性，保留recordUsage作为updateAccountUsage的别名
const recordUsage = updateAccountUsage

function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') {
    return null
  }

  for (const key of keys) {
    const value = toNumberOrNull(source[key])
    if (value !== null) {
      return value
    }
  }

  return null
}

function pickFirst(source, keys) {
  if (!source || typeof source !== 'object') {
    return undefined
  }

  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key]
    }
  }

  return undefined
}

// The exact /wham/usage schema is documented but not verified against a live account, so every
// field is read tolerantly across the plausible spellings rather than assumed.
function normalizeWhamWindow(window, nowMs) {
  if (!window || typeof window !== 'object') {
    return null
  }

  const usedPercent = pickNumber(window, ['used_percent', 'usedPercent', 'utilization'])
  const windowMinutes = pickNumber(window, [
    'window_minutes',
    'windowMinutes',
    'window_size_minutes',
    'windowSizeMinutes'
  ])
  const resetAt = resolveResetAt(
    pickFirst(window, ['resets_at', 'reset_at', 'resetsAt', 'resetAt']),
    pickFirst(window, [
      'resets_in_seconds',
      'reset_after_seconds',
      'resetsInSeconds',
      'resetAfterSeconds'
    ]),
    nowMs
  )

  if (usedPercent === null && windowMinutes === null && resetAt === null) {
    return null
  }

  return { usedPercent, windowMinutes, resetAt }
}

/**
 * Convert a /wham/usage payload into the canonical snapshot shape.
 *
 * The default bucket is pinned to `codex` so it lines up with the `x-codex-*` headers. Additional
 * per-model buckets are keyed off `metered_feature` first — it is a machine identifier and is the
 * likelier match for the header prefix — falling back to the human-readable `limit_name`.
 */
function normalizeWhamUsage(payload, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const capturedAt = new Date(now).toISOString()
  const limits = []

  const pushLimit = (limitId, limitName, meteredFeature, rateLimit) => {
    const primary = normalizeWhamWindow(
      pickFirst(rateLimit, ['primary_window', 'primaryWindow']),
      now
    )
    const secondary = normalizeWhamWindow(
      pickFirst(rateLimit, ['secondary_window', 'secondaryWindow']),
      now
    )

    if (!primary && !secondary) {
      return
    }

    limits.push({
      limitId,
      limitName: limitName || null,
      meteredFeature: meteredFeature || null,
      capturedAt,
      primary,
      secondary,
      primaryOverSecondaryPercent: null
    })
  }

  pushLimit('codex', 'Codex', null, pickFirst(payload, ['rate_limit', 'rateLimit']))

  const additional = pickFirst(payload, ['additional_rate_limits', 'additionalRateLimits'])
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (!entry || typeof entry !== 'object') {
        continue
      }

      const limitName = pickFirst(entry, ['limit_name', 'limitName']) || null
      const meteredFeature = pickFirst(entry, ['metered_feature', 'meteredFeature']) || null
      const limitId = normalizeLimitId(meteredFeature || limitName)
      if (!limitId || limitId === 'codex') {
        continue
      }

      pushLimit(
        limitId,
        limitName,
        meteredFeature,
        pickFirst(entry, ['rate_limit', 'rateLimit']) || entry
      )
    }
  }

  return {
    capturedAt,
    rateLimitReachedType:
      pickFirst(payload, ['rate_limit_reached_type', 'rateLimitReachedType']) || null,
    limits
  }
}

/**
 * Pull the authoritative quota snapshot from ChatGPT.
 *
 * Returns a normalized snapshot on success, or `null` when we reached no verdict — the caller must
 * keep whatever it already has in that case. Only a 200 response is allowed to rewrite stored
 * quota; treating a proxy outage or an expired token as "this account reports no usage" would
 * blank the panel on a transient failure.
 */
async function fetchCodexUsage(accountId) {
  let account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  if (!account.accessToken) {
    logger.debug(`📊 Skipping Codex usage fetch for ${accountId}: no access token`)
    return null
  }

  if (isTokenExpired(account)) {
    if (!account.refreshToken) {
      logger.debug(
        `📊 Skipping Codex usage fetch for ${accountId}: token expired, no refresh token`
      )
      return null
    }
    await refreshAccountToken(accountId)
    account = await getAccount(accountId)
    if (!account || !account.accessToken) {
      return null
    }
  }

  const accessToken = decrypt(account.accessToken)
  if (!accessToken) {
    logger.warn(`⚠️ Failed to decrypt access token for OpenAI account ${accountId}`)
    return null
  }

  // Upstream gates model and quota visibility on client identity, so the usage call must present
  // the same identity the relay uses for business traffic.
  const identity = await codexClientIdentityService.getApplied()

  const axiosConfig = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': account.accountId || account.chatgptUserId || accountId,
      accept: 'application/json',
      originator: identity.originator,
      'user-agent': identity.userAgent,
      version: identity.version
    },
    timeout: CODEX_USAGE_REQUEST_TIMEOUT_MS
  }

  const agent = ProxyHelper.createProxyAgent(account.proxy)
  if (agent) {
    axiosConfig.httpAgent = agent
    axiosConfig.httpsAgent = agent
    axiosConfig.proxy = false
  }

  try {
    const response = await axios.get(CODEX_USAGE_ENDPOINT, axiosConfig)

    if (response.status === 200 && response.data) {
      if (!whamShapeLogged) {
        whamShapeLogged = true
        logger.debug(
          `📊 First /wham/usage payload shape: ${JSON.stringify(response.data).slice(0, 2000)}`
        )
      }

      const normalized = normalizeWhamUsage(response.data)

      // A non-empty payload that yields no buckets means our field names did not match, not that
      // upstream reports no limits. The documented schema is unverified, so we must not hand an
      // empty "authoritative" snapshot to the writer — that would wipe every bucket, including the
      // good data collected from business response headers. Treat it as no verdict instead.
      if (!normalized || normalized.limits.length === 0) {
        logger.warn(
          `⚠️ /wham/usage returned a payload with no recognizable rate limit buckets for account ${accountId}; keeping the previous snapshot`
        )
        return null
      }

      return normalized
    }

    logger.warn(`⚠️ Unexpected /wham/usage status ${response.status} for account ${accountId}`)
    return null
  } catch (error) {
    const status = error.response?.status

    // The account simply cannot answer this question; keep the header-derived data we do have.
    if (status === 403 || status === 404) {
      logger.debug(`📊 /wham/usage unavailable (${status}) for account ${accountId}`)
      return null
    }

    logger.error(
      `❌ Failed to fetch Codex usage for account ${accountId}:`,
      error.response?.data || error.message
    )
    throw error
  }
}

/**
 * Persist a Codex quota snapshot.
 *
 * Two sources feed this, with different authority:
 *
 * - `wham`   — a complete snapshot from /backend-api/wham/usage. Buckets and windows missing from
 *              it no longer exist upstream, so `limits` is replaced wholesale.
 * - `headers`— a sparse supplement scraped off a business response. Only the buckets this response
 *              actually reported are replaced; buckets it did not mention are left alone for the
 *              next full snapshot to reconcile. Within a reported bucket the window set *is*
 *              replaced, which is what finally clears a secondary window upstream stopped sending.
 *
 * A response carrying no quota headers at all must not reach this function — that is "no
 * information", not "everything disappeared".
 */
async function updateCodexUsageSnapshot(accountId, usageSnapshot, options = {}) {
  const source = options.source === 'wham' ? 'wham' : 'headers'

  if (!usageSnapshot || typeof usageSnapshot !== 'object') {
    return
  }

  const incomingLimits = Array.isArray(usageSnapshot.limits) ? usageSnapshot.limits : []
  if (incomingLimits.length === 0 && source !== 'wham') {
    return
  }

  const client = redisClient.getClientSafe()
  const accountKey = `${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`

  // Tracks whether the account still carried the pre-rewrite flat fields, so the cleanup only runs
  // on the first write after migration instead of on every single response forever.
  let migratedFromLegacy = false

  await casUpdateField(client, accountKey, CODEX_USAGE_SNAPSHOT_FIELD, async (currentRaw) => {
    const now = new Date().toISOString()
    const existingStored = parseStoredCodexSnapshot(currentRaw)

    let existing = existingStored
    if (!existing) {
      existing = buildLegacyCodexSnapshot(await client.hgetall(accountKey))
      migratedFromLegacy = true
    }

    let limits = incomingLimits
    let whamFetchedAt = now

    if (source === 'headers') {
      const incomingById = new Map(incomingLimits.map((limit) => [limit.limitId, limit]))
      const merged = (existing?.limits || []).map(
        (limit) => incomingById.get(limit.limitId) || limit
      )
      const seen = new Set(merged.map((limit) => limit.limitId))

      for (const limit of incomingLimits) {
        if (!seen.has(limit.limitId)) {
          merged.push(limit)
        }
      }

      limits = merged

      // Header writes must NOT reset the /wham/usage cooldown clock. `updatedAt` moves on every
      // write, so keying the refresh TTL off it would defeat the cache for any actively used
      // account: business traffic would keep marking the snapshot "not fetched via wham", and
      // every admin poll would fire a fresh upstream request.
      whamFetchedAt = existing?.whamFetchedAt || null
    }

    return JSON.stringify({
      updatedAt: now,
      source,
      // When the authoritative endpoint last answered, independent of `updatedAt`.
      whamFetchedAt,
      // Only a full snapshot can assert which limit was reached. A successful business response
      // means we are not rate limited right now, so headers clear the flag rather than inherit it.
      rateLimitReachedType: source === 'wham' ? usageSnapshot.rateLimitReachedType || null : null,
      limits
    })
  })

  if (migratedFromLegacy) {
    await client.hdel(accountKey, ...LEGACY_CODEX_USAGE_FIELDS)
  }
}

/**
 * Atomic cooldown gate for /wham/usage.
 *
 * Timestamp comparison alone is not enough: several admin clients (or a polling script racing the
 * admin page) can all read a stale snapshot in the same instant and each decide to fetch. SET NX
 * makes "at most one upstream request per account per cooldown window" a hard guarantee rather
 * than a best effort.
 *
 * The gate is deliberately NOT released on failure. A failing account should not be retried on
 * every poll — that is exactly the periodic upstream traffic this is meant to prevent. The stored
 * snapshot stays and simply ages into `isStale`.
 *
 * @returns {Promise<boolean>} true when the caller owns the right to fetch
 */
async function acquireCodexUsageFetchLock(accountId, ttlSeconds = 300) {
  const client = redisClient.getClientSafe()
  const result = await client.set(
    `${CODEX_USAGE_FETCH_LOCK_PREFIX}${accountId}`,
    new Date().toISOString(),
    'EX',
    Math.max(1, Math.floor(ttlSeconds)),
    'NX'
  )

  return result === 'OK'
}

/**
 * Extend an account's fetch cooldown past the normal window.
 *
 * Used when a fetch reached no verdict — a 403 (the account cannot answer this call at all), a
 * proxy outage, a failed token refresh. Without this, such an account never records a
 * `whamFetchedAt`, so every cooldown expiry would fire another doomed upstream request: a
 * permanent fixed-interval beat against ChatGPT for an account that will never answer.
 */
async function extendCodexUsageFetchCooldown(accountId, ttlSeconds) {
  const client = redisClient.getClientSafe()
  await client.set(
    `${CODEX_USAGE_FETCH_LOCK_PREFIX}${accountId}`,
    new Date().toISOString(),
    'EX',
    Math.max(1, Math.floor(ttlSeconds))
  )
}

/**
 * Record the last observed upstream availability for an account, optionally scoped to one model.
 *
 * Kept separate from the quota snapshot on purpose: a quota refresh must not wipe a known capacity
 * problem, and a capacity error must not be written as 100% usage.
 */
async function recordCodexAvailability(accountId, { model = null, state, detail = null } = {}) {
  if (!state) {
    return
  }

  const client = redisClient.getClientSafe()
  const accountKey = `${OPENAI_ACCOUNT_KEY_PREFIX}${accountId}`
  const normalizedDetail = detail || null

  await casUpdateField(client, accountKey, CODEX_AVAILABILITY_FIELD, (currentRaw) => {
    const existing = parseJsonOrNull(currentRaw) || {}
    const current = model ? existing.models?.[model] : existing.account

    // Steady state is the same verdict over and over — every successful request re-reports "ok".
    // Rewriting an unchanged entry would put a Redis write on the hot path of every single
    // request for no information gain, so only transitions are persisted.
    if (current && current.state === state && (current.detail || null) === normalizedDetail) {
      return null
    }

    const observedAt = new Date().toISOString()
    const entry = { state, detail: normalizedDetail, observedAt }

    const next = {
      updatedAt: observedAt,
      account: model ? existing.account || null : entry,
      models: { ...(existing.models || {}) }
    }

    if (model) {
      next.models[model] = entry
    }

    return JSON.stringify(next)
  })
}

module.exports = {
  createAccount,
  getAccount,
  getAccountOverview,
  updateAccount,
  deleteAccount,
  getAllAccounts,
  selectAvailableAccount,
  refreshAccountToken,
  isTokenExpired,
  setAccountRateLimited,
  markAccountUnauthorized,
  resetAccountStatus,
  toggleSchedulable,
  getAccountRateLimitInfo,
  updateAccountUsage,
  recordUsage, // 别名，指向updateAccountUsage
  updateCodexUsageSnapshot,
  buildCodexUsageSnapshot,
  buildCodexAvailability,
  recordCodexAvailability,
  fetchCodexUsage,
  normalizeWhamUsage,
  acquireCodexUsageFetchLock,
  extendCodexUsageFetchCooldown,
  CODEX_USAGE_STALE_AFTER_MS,
  encrypt,
  decrypt,
  encryptor // 暴露加密器以便测试和监控
}
