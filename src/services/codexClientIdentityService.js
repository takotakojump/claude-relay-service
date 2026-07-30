/**
 * Codex 客户端身份服务
 *
 * 上游按客户端身份（originator + user-agent）判定模型可用性，缺任一个头新模型会返回
 * "Selected model is at capacity"。出站请求统一使用一个固定身份，避免多用户共用同一
 * 上游账号时客户端版本在请求间来回漂移。
 *
 * 记录与应用分离：入站请求持续自动记录真实客户端身份（免费、无副作用），固定值只在
 * 人工触发时才提升。上游抬高版本门槛时，观测表里已经有更新的版本可供一键应用。
 */

const redis = require('../models/redis')
const logger = require('../utils/logger')
const CodexCliValidator = require('../validators/clients/codexCliValidator')

const APPLIED_KEY = 'codex_client_identity'
const OBSERVED_KEY = 'codex_client_identity:observed'

// 单条观测记录的保留期：超过这个时间没再出现的客户端会在下次列举时被清理。
// key 级 TTL 只是兜底（整个部署长期无流量时自动消失），真正的清理靠按条淘汰，
// 否则 hash 会一直被新记录续命、陈旧版本永远留在列表里。
const OBSERVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const OBSERVED_TTL_SECONDS = 60 * 24 * 60 * 60 // 60 天，长于保留期
const OBSERVED_MAX_ENTRIES = 50

// 兜底身份：观测表为空且从未应用过时使用
const DEFAULT_IDENTITY = {
  originator: 'codex_cli_rs',
  userAgent: 'codex_cli_rs/0.146.0',
  version: '0.146.0'
}

// Codex 客户端 UA 形态：<client>/<version> [附加信息]
const CODEX_UA_PATTERN = /^(codex_vscode|codex_cli_rs|codex_exec)\/(\d[\d.]*)/i

// 内存缓存：getApplied 在请求热路径上，不能每次都打 Redis
let appliedCache = null
let appliedCacheTime = 0
const APPLIED_CACHE_TTL = 60000 // 1 分钟

function parseUserAgent(userAgent) {
  if (typeof userAgent !== 'string') {
    return null
  }
  const match = userAgent.trim().match(CODEX_UA_PATTERN)
  if (!match) {
    return null
  }
  return { clientType: match[1].toLowerCase(), version: match[2] }
}

function buildField(originator, userAgent) {
  return `${originator}|${userAgent}`
}

function parseField(field) {
  const index = field.indexOf('|')
  if (index < 0) {
    return null
  }
  return {
    originator: field.slice(0, index),
    userAgent: field.slice(index + 1)
  }
}

/**
 * 观测样本排序：版本高的在前；版本相同时优先 codex_cli_rs，
 * 再相同则取最近出现过的。
 */
function compareObserved(a, b) {
  const byVersion = CodexCliValidator.compareVersions(b.version, a.version)
  if (byVersion !== 0) {
    return byVersion
  }

  const aPreferred = a.originator === 'codex_cli_rs' ? 0 : 1
  const bPreferred = b.originator === 'codex_cli_rs' ? 0 : 1
  if (aPreferred !== bPreferred) {
    return aPreferred - bPreferred
  }

  return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''))
}

class CodexClientIdentityService {
  /**
   * 读取当前生效的固定身份（带内存缓存）
   * @returns {Promise<Object>} { originator, userAgent, version, appliedAt, appliedBy }
   */
  async getApplied() {
    if (appliedCache && Date.now() - appliedCacheTime < APPLIED_CACHE_TTL) {
      return appliedCache
    }

    try {
      const client = redis.getClient()
      if (!client) {
        logger.warn('⚠️ Redis not connected, using default Codex client identity')
        return { ...DEFAULT_IDENTITY }
      }

      const data = await client.get(APPLIED_KEY)
      appliedCache = data ? { ...DEFAULT_IDENTITY, ...JSON.parse(data) } : { ...DEFAULT_IDENTITY }
      appliedCacheTime = Date.now()
      return appliedCache
    } catch (error) {
      logger.error('❌ Failed to get Codex client identity:', error)
      return { ...DEFAULT_IDENTITY }
    }
  }

  /**
   * 记录一次观测到的入站客户端身份。
   * 由请求路径 fire-and-forget 调用，任何异常都不应影响转发。
   */
  async recordObserved(originator, userAgent) {
    const parsed = parseUserAgent(userAgent)
    if (!parsed || !originator || typeof originator !== 'string') {
      return
    }

    // originator 必须与 UA 中的客户端类型一致，否则不是可信样本
    if (originator.trim().toLowerCase() !== parsed.clientType) {
      return
    }

    try {
      const client = redis.getClientSafe()
      const field = buildField(originator.trim().toLowerCase(), userAgent.trim())
      const now = new Date().toISOString()

      const existingRaw = await client.hget(OBSERVED_KEY, field)
      let existing = null
      if (existingRaw) {
        try {
          existing = JSON.parse(existingRaw)
        } catch {
          existing = null
        }
      }

      const entry = {
        version: parsed.version,
        count: (existing?.count || 0) + 1,
        firstSeen: existing?.firstSeen || now,
        lastSeen: now
      }

      await client.hset(OBSERVED_KEY, field, JSON.stringify(entry))
      await client.expire(OBSERVED_KEY, OBSERVED_TTL_SECONDS)
    } catch (error) {
      logger.warn(`⚠️ Failed to record Codex client identity: ${error.message}`)
    }
  }

  /**
   * 列出观测到的客户端身份，版本降序。
   * 顺带清理超过保留期、解析失败的记录，以及超出条数上限的最旧记录。
   * @returns {Promise<Array>}
   */
  async listObserved() {
    try {
      const client = redis.getClient()
      if (!client) {
        return []
      }

      const all = await client.hgetall(OBSERVED_KEY)
      if (!all || Object.keys(all).length === 0) {
        return []
      }

      const cutoff = Date.now() - OBSERVED_RETENTION_MS
      const items = []
      const staleFields = []

      for (const [field, raw] of Object.entries(all)) {
        const identity = parseField(field)
        if (!identity) {
          staleFields.push(field)
          continue
        }

        let entry = null
        try {
          entry = JSON.parse(raw)
        } catch {
          staleFields.push(field)
          continue
        }

        const lastSeenMs = entry.lastSeen ? Date.parse(entry.lastSeen) : NaN
        if (!Number.isFinite(lastSeenMs) || lastSeenMs < cutoff) {
          staleFields.push(field)
          continue
        }

        const parsed = parseUserAgent(identity.userAgent)
        items.push({
          field,
          originator: identity.originator,
          userAgent: identity.userAgent,
          version: entry.version || parsed?.version || '0',
          count: entry.count || 0,
          firstSeen: entry.firstSeen || null,
          lastSeen: entry.lastSeen,
          lastSeenMs
        })
      }

      items.sort(compareObserved)

      // 条数上限：保留最近出现的若干条，其余淘汰
      if (items.length > OBSERVED_MAX_ENTRIES) {
        const byRecency = [...items].sort((a, b) => b.lastSeenMs - a.lastSeenMs)
        const keep = new Set(byRecency.slice(0, OBSERVED_MAX_ENTRIES).map((item) => item.field))
        for (const item of items) {
          if (!keep.has(item.field)) {
            staleFields.push(item.field)
          }
        }
      }

      if (staleFields.length > 0) {
        await client.hdel(OBSERVED_KEY, ...staleFields).catch(() => {})
        logger.info(`🧹 Pruned ${staleFields.length} stale Codex client identity record(s)`)
      }

      const pruned = new Set(staleFields)
      return items
        .filter((item) => !pruned.has(item.field))
        .map(({ field: _field, lastSeenMs: _lastSeenMs, ...rest }) => rest)
    } catch (error) {
      logger.error('❌ Failed to list observed Codex client identities:', error)
      return []
    }
  }

  /**
   * 应用一个指定的身份为固定值
   */
  async apply(identity, appliedBy = 'unknown') {
    const parsed = parseUserAgent(identity?.userAgent)
    if (!parsed) {
      throw new Error('Invalid Codex user-agent')
    }
    if (!identity.originator || identity.originator.trim().toLowerCase() !== parsed.clientType) {
      throw new Error('originator must match the client type in user-agent')
    }

    const applied = {
      originator: identity.originator.trim().toLowerCase(),
      userAgent: identity.userAgent.trim(),
      version: parsed.version,
      appliedAt: new Date().toISOString(),
      appliedBy
    }

    const client = redis.getClientSafe()
    await client.set(APPLIED_KEY, JSON.stringify(applied))

    appliedCache = applied
    appliedCacheTime = Date.now()

    logger.info(
      `✅ Codex client identity applied by ${appliedBy}: ${applied.originator} / ${applied.userAgent}`
    )
    return applied
  }

  /**
   * 清空缓存（测试用）
   */
  clearCache() {
    appliedCache = null
    appliedCacheTime = 0
  }
}

module.exports = new CodexClientIdentityService()
module.exports.DEFAULT_IDENTITY = DEFAULT_IDENTITY
