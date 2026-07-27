const SERVICE_LIMIT_SERVICES = Object.freeze([
  'claude',
  'gemini',
  'codex',
  'droid',
  'bedrock',
  'azure',
  'ccr'
])

const INTEGER_FIELDS = new Set(['windowMinutes', 'windowRequests'])
const NUMBER_FIELDS = new Set(['windowCost', 'dailyCostLimit', 'weeklyCostLimit'])
const ALLOWED_FIELDS = new Set([...INTEGER_FIELDS, ...NUMBER_FIELDS])

function getConfiguredNumber(limits, field) {
  const value = limits[field]
  if (value === undefined || value === null || value === '') {
    return 0
  }
  return Number(value)
}

function validateServiceLimits(serviceLimits) {
  if (serviceLimits === undefined || serviceLimits === null) {
    return null
  }
  if (typeof serviceLimits !== 'object' || Array.isArray(serviceLimits)) {
    return 'Service limits must be an object'
  }

  for (const [service, limits] of Object.entries(serviceLimits)) {
    if (!SERVICE_LIMIT_SERVICES.includes(service)) {
      return `Unsupported service "${service}"`
    }
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      return `Invalid limits for service "${service}": must be an object`
    }

    for (const field of Object.keys(limits)) {
      if (!ALLOWED_FIELDS.has(field)) {
        return `Unsupported limit field "${field}" for service "${service}"`
      }
    }

    for (const field of INTEGER_FIELDS) {
      const value = limits[field]
      if (value === undefined || value === null || value === '') {
        continue
      }
      const number = Number(value)
      if (!Number.isSafeInteger(number) || number < 0) {
        return `Invalid ${field} for service "${service}": must be a non-negative safe integer`
      }
    }

    for (const field of NUMBER_FIELDS) {
      const value = limits[field]
      if (value === undefined || value === null || value === '') {
        continue
      }
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) {
        return `Invalid ${field} for service "${service}": must be a non-negative number`
      }
    }

    const windowMinutes = getConfiguredNumber(limits, 'windowMinutes')
    const windowRequests = getConfiguredNumber(limits, 'windowRequests')
    const windowCost = getConfiguredNumber(limits, 'windowCost')
    const dailyCostLimit = getConfiguredNumber(limits, 'dailyCostLimit')
    const weeklyCostLimit = getConfiguredNumber(limits, 'weeklyCostLimit')
    const hasWindowLimit = windowRequests > 0 || windowCost > 0

    if (hasWindowLimit && windowMinutes <= 0) {
      return `windowMinutes must be positive when a window limit is set for service "${service}"`
    }
    if (!hasWindowLimit && windowMinutes > 0) {
      return `windowMinutes requires windowRequests or windowCost for service "${service}"`
    }
    if (!hasWindowLimit && dailyCostLimit <= 0 && weeklyCostLimit <= 0) {
      return `At least one positive limit is required for service "${service}"`
    }
  }

  return null
}

module.exports = {
  SERVICE_LIMIT_SERVICES,
  validateServiceLimits
}
