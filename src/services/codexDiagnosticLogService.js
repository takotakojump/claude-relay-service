/**
 * Codex 诊断日志。
 *
 * 这是一份**临时排查用**的独立记录，和服务器日志不是一回事：服务器日志按文件轮转、混着全平台
 * 流量，而这里只收极少量、明确指定的事件，供管理端直接查看。
 *
 * 存在的理由：Codex 流式响应是 res.write 裸管道转发，从不调用 res.json()，所以访问日志里
 * 响应体永远为空、状态码永远是 200。上游用「HTTP 200 + 流内 error 帧」下发的失败
 * （例如 "Selected model is at capacity"）在原有日志体系里完全不可见。
 *
 * 当前只记录一类事件：codex_stream_error。
 *
 * 设计约束：
 * - 所有写入都不得抛出。它挂在转发热路径上，一次 Redis 抖动不能变成用户侧的 500。
 * - 条数封顶 + TTL 兜底，避免这份"临时"记录长成一个没人清理的无限增长的 key。
 */

const redis = require('../models/redis')
const logger = require('../utils/logger')

const DIAGNOSTIC_LOG_KEY = 'codex:diagnostic_log'

// 只做人工排查，几百条足够翻。超出即丢最旧的。
const MAX_ENTRIES = 500

// 兜底过期：即使没人清理，这份临时数据也不会永久占用 Redis。
const RETENTION_SECONDS = 7 * 24 * 60 * 60

// 单字段长度上限，防止上游把一大段内容塞进 message 撑爆这个 key。
const MAX_FIELD_LENGTH = 500

const EVENT_TYPES = {
  STREAM_ERROR: 'codex_stream_error'
}

function truncate(value) {
  if (value === undefined || value === null) {
    return null
  }

  const text = typeof value === 'string' ? value : String(value)
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  return trimmed.length > MAX_FIELD_LENGTH ? `${trimmed.slice(0, MAX_FIELD_LENGTH)}…` : trimmed
}

/**
 * 追加一条诊断记录。
 *
 * 刻意吞掉所有异常并且不 await 到请求结果上 —— 诊断记录失败绝不能影响转发本身。
 */
async function record(eventType, payload = {}) {
  if (!eventType) {
    return
  }

  try {
    const entry = {
      ts: new Date().toISOString(),
      eventType,
      accountId: truncate(payload.accountId),
      accountName: truncate(payload.accountName),
      model: truncate(payload.model),
      state: truncate(payload.state),
      detail: truncate(payload.detail),
      requestId: truncate(payload.requestId),
      apiKeyId: truncate(payload.apiKeyId)
    }

    const client = redis.getClientSafe()
    await client.lpush(DIAGNOSTIC_LOG_KEY, JSON.stringify(entry))
    await client.ltrim(DIAGNOSTIC_LOG_KEY, 0, MAX_ENTRIES - 1)
    await client.expire(DIAGNOSTIC_LOG_KEY, RETENTION_SECONDS)
  } catch (error) {
    // debug 而非 error：这条记录本身就是排查辅助，它失败不值得再污染一次错误日志
    logger.debug(`Failed to record Codex diagnostic entry: ${error.message}`)
  }
}

/**
 * 读取最近的记录，最新的在前。
 * 单条损坏（手工改过、旧格式）不应让整个列表读不出来，逐条解析、跳过坏的。
 */
async function list({ limit = MAX_ENTRIES } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || MAX_ENTRIES))

  try {
    const client = redis.getClientSafe()
    const raw = await client.lrange(DIAGNOSTIC_LOG_KEY, 0, safeLimit - 1)

    const entries = []
    for (const item of raw || []) {
      try {
        entries.push(JSON.parse(item))
      } catch (parseError) {
        // 跳过这一条，不要让一条坏数据吞掉整份记录
      }
    }

    return entries
  } catch (error) {
    logger.error('❌ Failed to read Codex diagnostic log:', error)
    throw error
  }
}

async function clear() {
  const client = redis.getClientSafe()
  await client.del(DIAGNOSTIC_LOG_KEY)
}

module.exports = {
  record,
  list,
  clear,
  EVENT_TYPES,
  MAX_ENTRIES,
  RETENTION_SECONDS,
  DIAGNOSTIC_LOG_KEY
}
