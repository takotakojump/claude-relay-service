/**
 * 账户重新授权辅助工具
 *
 * 重新授权 = 对已有账户原地替换 OAuth 凭证，账户 ID 不变，
 * 因此 API Key 专属绑定、分组、优先级、代理等配置全部保留。
 * 这里负责两件事：
 * 1. 身份校验：防止误用另一个上游账户授权，导致绑定的用户被悄悄切到别人的账户上
 * 2. 判断手动更新凭证后是否需要恢复账户的异常状态
 */

const IDENTITY_MISMATCH_CODE = 'ACCOUNT_IDENTITY_MISMATCH'

// 写入新凭证后，这些状态应视为可恢复（凭证失效 / 被封禁 / 刷新失败等）
const RECOVERABLE_STATUSES = new Set(['unauthorized', 'error', 'blocked', 'expired'])

class AccountIdentityMismatchError extends Error {
  constructor(mismatches = []) {
    super('Re-authorized identity does not match the existing account')
    this.name = 'AccountIdentityMismatchError'
    this.code = IDENTITY_MISMATCH_CODE
    this.statusCode = 409
    this.mismatches = mismatches
  }
}

// 授权数据不合法（缺 token、授权类型不匹配等），路由层映射为 400
class AccountReauthorizeError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'AccountReauthorizeError'
    this.statusCode = statusCode
  }
}

function normalizeIdentityValue(value, caseInsensitive = false) {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value).trim()
  return caseInsensitive ? text.toLowerCase() : text
}

function maskIdentityValue(type, value) {
  if (!value) {
    return ''
  }

  if (type === 'email') {
    const atIndex = value.indexOf('@')
    if (atIndex > 0) {
      const local = value.slice(0, atIndex)
      return `${local.slice(0, Math.min(2, local.length))}***${value.slice(atIndex)}`
    }
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

/**
 * 对比新旧身份字段。只有新旧两侧都有值的字段才参与比较。
 * @param {Array<{field: string, previous: *, next: *, type?: 'email'|'id'}>} checks
 * @returns {{status: 'match'|'mismatch'|'unverifiable', compared: string[], mismatches: Array}}
 */
function compareAccountIdentity(checks = []) {
  const compared = []
  const mismatches = []

  for (const check of checks) {
    if (!check || !check.field) {
      continue
    }
    const caseInsensitive = check.type === 'email'
    const previous = normalizeIdentityValue(check.previous, caseInsensitive)
    const next = normalizeIdentityValue(check.next, caseInsensitive)
    if (!previous || !next) {
      continue
    }

    compared.push(check.field)
    if (previous !== next) {
      mismatches.push({
        field: check.field,
        previous: maskIdentityValue(check.type, previous),
        next: maskIdentityValue(check.type, next)
      })
    }
  }

  let status = 'unverifiable'
  if (mismatches.length > 0) {
    status = 'mismatch'
  } else if (compared.length > 0) {
    status = 'match'
  }

  return { status, compared, mismatches }
}

/**
 * 身份不一致且未强制时抛出 AccountIdentityMismatchError
 * @returns {'match'|'unverifiable'|'forced'} 最终的身份校验结论
 */
function assertAccountIdentity(result, { force = false } = {}) {
  if (result.status === 'mismatch') {
    if (!force) {
      throw new AccountIdentityMismatchError(result.mismatches)
    }
    return 'forced'
  }
  return result.status
}

function isRecoverableStatus(status) {
  return RECOVERABLE_STATUSES.has(String(status || '').toLowerCase())
}

function hasNonEmptyCredential(value) {
  if (!value) {
    return false
  }
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  if (typeof value === 'object') {
    return Object.values(value).some((item) => typeof item === 'string' && item.trim().length > 0)
  }
  return true
}

/**
 * 管理员手动写入了新凭证，且账户此前处于异常状态时，应恢复账户状态
 * @param {string} previousStatus - 更新前的账户状态
 * @param {Object} updates - 本次更新内容
 * @param {string[]} credentialFields - 视为凭证的字段名
 */
function shouldRecoverAfterCredentialUpdate(previousStatus, updates, credentialFields = []) {
  if (!isRecoverableStatus(previousStatus) || !updates) {
    return false
  }
  return credentialFields.some((field) => hasNonEmptyCredential(updates[field]))
}

module.exports = {
  IDENTITY_MISMATCH_CODE,
  AccountIdentityMismatchError,
  AccountReauthorizeError,
  compareAccountIdentity,
  assertAccountIdentity,
  isRecoverableStatus,
  shouldRecoverAfterCredentialUpdate
}
