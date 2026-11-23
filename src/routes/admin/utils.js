/**
 * Admin Routes - 共享工具函数
 * 供各个子路由模块导入使用
 */

const logger = require('../../utils/logger')
const { IDENTITY_MISMATCH_CODE } = require('../../utils/accountReauthHelper')

/**
 * 处理可为空的时间字段
 * @param {*} value - 输入值
 * @returns {string|null} 规范化后的值
 */
function normalizeNullableDate(value) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return value
}

/**
 * 映射前端的 expiresAt 字段到后端的 subscriptionExpiresAt 字段
 * @param {Object} updates - 更新对象
 * @param {string} accountType - 账户类型 (如 'Claude', 'OpenAI' 等)
 * @param {string} accountId - 账户 ID
 * @returns {Object} 映射后的更新对象
 */
function mapExpiryField(updates, accountType, accountId) {
  const mappedUpdates = { ...updates }
  if ('expiresAt' in mappedUpdates) {
    mappedUpdates.subscriptionExpiresAt = mappedUpdates.expiresAt
    delete mappedUpdates.expiresAt
    logger.info(
      `Mapping expiresAt to subscriptionExpiresAt for ${accountType} account ${accountId}`
    )
  }
  return mappedUpdates
}

/**
 * 格式化账户数据，确保前端获取正确的过期时间字段
 * 将 subscriptionExpiresAt（订阅过期时间）映射到 expiresAt 供前端使用
 * 保留原始的 tokenExpiresAt（OAuth token过期时间）供内部使用
 * @param {Object} account - 账户对象
 * @returns {Object} 格式化后的账户对象
 */
function formatAccountExpiry(account) {
  if (!account || typeof account !== 'object') {
    return account
  }

  const rawSubscription = Object.prototype.hasOwnProperty.call(account, 'subscriptionExpiresAt')
    ? account.subscriptionExpiresAt
    : null

  const rawToken = Object.prototype.hasOwnProperty.call(account, 'tokenExpiresAt')
    ? account.tokenExpiresAt
    : account.expiresAt

  const subscriptionExpiresAt = normalizeNullableDate(rawSubscription)
  const tokenExpiresAt = normalizeNullableDate(rawToken)

  return {
    ...account,
    subscriptionExpiresAt,
    tokenExpiresAt,
    expiresAt: subscriptionExpiresAt
  }
}

/**
 * 统一处理"重新授权"接口的错误响应
 * - 身份不一致 → 409，附带不一致字段，前端据此二次确认后带 force 重试
 * - 授权数据不合法 → 400
 * - 账户不存在 → 404
 * @param {Object} res - Express response
 * @param {Error} error - 捕获的错误
 * @param {string} platformLabel - 平台名称，仅用于日志
 */
function sendReauthorizeError(res, error, platformLabel) {
  if (error && error.code === IDENTITY_MISMATCH_CODE) {
    logger.warn(`⚠️ ${platformLabel} re-authorization rejected: identity mismatch`, {
      mismatches: error.mismatches
    })
    return res.status(409).json({
      success: false,
      code: IDENTITY_MISMATCH_CODE,
      message: '授权的账户与原账户身份不一致',
      mismatches: error.mismatches || []
    })
  }

  if (error && /not found/i.test(error.message || '')) {
    return res.status(404).json({ success: false, message: '账户不存在' })
  }

  if (error && error.statusCode === 400) {
    return res.status(400).json({ success: false, message: error.message })
  }

  logger.error(`❌ Failed to re-authorize ${platformLabel} account:`, error)
  return res.status(500).json({
    success: false,
    message: '重新授权失败',
    error: error ? error.message : 'Unknown error'
  })
}

module.exports = {
  normalizeNullableDate,
  mapExpiryField,
  formatAccountExpiry,
  sendReauthorizeError
}
