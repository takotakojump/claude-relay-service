export const SERVICE_LIMIT_SERVICES = Object.freeze([
  { key: 'claude', label: 'Claude' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'codex', label: 'Codex' },
  { key: 'droid', label: 'Droid' },
  { key: 'bedrock', label: 'Bedrock' },
  { key: 'azure', label: 'Azure' },
  { key: 'ccr', label: 'CCR' }
])

export const SERVICE_LIMIT_COLUMNS = Object.freeze([
  { field: 'windowMinutes', label: '窗口(分钟)', step: '1' },
  { field: 'windowRequests', label: '窗口请求数', step: '1' },
  { field: 'windowCost', label: '窗口费用($)', step: '0.1' },
  { field: 'dailyCostLimit', label: '每日费用($)', step: '0.1' },
  { field: 'weeklyCostLimit', label: '周费用($)', step: '0.1' }
])

function toPositiveNumber(value) {
  if (value === '' || value === null || value === undefined) {
    return 0
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

// 接口可能返回已解析的对象，也可能返回原始 JSON 字符串（取决于列表/详情走的解析路径）。
// 直接展开字符串会得到字符下标对象，导致表单显示为空并在下次保存时清空配置。
export function parseServiceLimits(raw) {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...raw }
  }
  return {}
}

export function ensureServiceLimitsShape(serviceLimits) {
  for (const service of SERVICE_LIMIT_SERVICES) {
    const existing = serviceLimits[service.key] || {}
    serviceLimits[service.key] = Object.fromEntries(
      SERVICE_LIMIT_COLUMNS.map(({ field }) => [
        field,
        existing[field] === undefined || existing[field] === null ? '' : existing[field]
      ])
    )
  }
}

export function validateServiceLimitsInput(serviceLimits, enabled) {
  if (!enabled) {
    return null
  }

  for (const service of SERVICE_LIMIT_SERVICES) {
    const row = serviceLimits[service.key] || {}
    for (const { field, label } of SERVICE_LIMIT_COLUMNS) {
      const raw = row[field]
      if (raw === '' || raw === null || raw === undefined) {
        continue
      }
      const number = Number(raw)
      if (!Number.isFinite(number) || number < 0) {
        return `${service.label} 的${label}必须是非负数`
      }
      if ((field === 'windowMinutes' || field === 'windowRequests') && !Number.isInteger(number)) {
        return `${service.label} 的${label}必须是整数`
      }
    }

    const windowMinutes = toPositiveNumber(row.windowMinutes)
    const windowRequests = toPositiveNumber(row.windowRequests)
    const windowCost = toPositiveNumber(row.windowCost)
    const hasWindowLimit = windowRequests > 0 || windowCost > 0
    if (hasWindowLimit && windowMinutes <= 0) {
      return `${service.label} 设置窗口请求数或费用时，必须填写窗口分钟数`
    }
    if (!hasWindowLimit && windowMinutes > 0) {
      return `${service.label} 填写窗口分钟数后，还需填写窗口请求数或费用`
    }
  }

  return null
}

export function buildServiceLimitsPayload(serviceLimits, enabled) {
  if (!enabled) {
    return {}
  }

  const result = {}
  for (const service of SERVICE_LIMIT_SERVICES) {
    const row = serviceLimits[service.key] || {}
    const entry = {}
    for (const { field } of SERVICE_LIMIT_COLUMNS) {
      const number = toPositiveNumber(row[field])
      if (number > 0) {
        entry[field] = number
      }
    }
    if (Object.keys(entry).length > 0) {
      result[service.key] = entry
    }
  }
  return result
}

export function hasWeeklyServiceCostLimit(serviceLimits, enabled = true) {
  if (!enabled || !serviceLimits || typeof serviceLimits !== 'object') {
    return false
  }
  return SERVICE_LIMIT_SERVICES.some(
    ({ key }) => toPositiveNumber(serviceLimits[key]?.weeklyCostLimit) > 0
  )
}
