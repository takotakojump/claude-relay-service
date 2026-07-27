const redis = require('../models/redis')
const logger = require('../utils/logger')
const serviceRatesService = require('./serviceRatesService')

function toPositiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function getRequestModel(req, fallbackModel = '') {
  return fallbackModel || req?.body?.model || req?.params?.modelName || req?.params?.model || ''
}

class ServiceLimitService {
  resolveModelFamily(model, accountType = null) {
    return serviceRatesService.getServiceLimitFamily(model, accountType)
  }

  async enforceForRequest(req, res, fallbackModel = '', fallbackAccountType = null) {
    const serviceLimits = req?.apiKey?.serviceLimits || {}
    if (!serviceLimits || Object.keys(serviceLimits).length === 0) {
      return true
    }

    const model = getRequestModel(req, fallbackModel)
    const service = this.resolveModelFamily(model, fallbackAccountType)
    if (!service) {
      logger.warn(
        `Unable to resolve service-limit family for key ${req.apiKey.id}, model=${model || 'empty'}, accountType=${fallbackAccountType || 'empty'}`
      )
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_model_family',
          message: `Unable to determine a quota family for model "${model || 'unknown'}"`
        }
      })
      return false
    }

    const limits = serviceLimits[service]
    if (!limits) {
      return true
    }

    const existingReservation = req._serviceLimitReservations?.[service]
    if (existingReservation) {
      return true
    }

    const keyId = req.apiKey.id
    const keyName = req.apiKey.name || keyId
    const dailyCostLimit = toPositiveNumber(limits.dailyCostLimit)
    if (dailyCostLimit > 0) {
      const currentCost = await redis.getServiceDailyCost(keyId, service)
      if (currentCost >= dailyCostLimit) {
        logger.security(
          `Service daily cost limit exceeded for key ${keyId} (${keyName}), service=${service}, cost=${currentCost}/${dailyCostLimit}`
        )
        return this._sendCostLimitResponse(res, {
          service,
          currentCost,
          costLimit: dailyCostLimit,
          resetAt: redis.getNextDailyResetTime(),
          period: 'daily'
        })
      }
    }

    const weeklyCostLimit = toPositiveNumber(limits.weeklyCostLimit)
    if (weeklyCostLimit > 0) {
      const resetDay = Number(req.apiKey.weeklyResetDay) || 1
      const resetHour = Number(req.apiKey.weeklyResetHour) || 0
      const currentCost = await redis.getServiceWeeklyCost(keyId, service, resetDay, resetHour)
      if (currentCost >= weeklyCostLimit) {
        logger.security(
          `Service weekly cost limit exceeded for key ${keyId} (${keyName}), service=${service}, cost=${currentCost}/${weeklyCostLimit}`
        )
        return this._sendCostLimitResponse(res, {
          service,
          currentCost,
          costLimit: weeklyCostLimit,
          resetAt: redis.getNextResetTime(resetDay, resetHour),
          period: 'weekly'
        })
      }
    }

    const windowMinutes = toPositiveNumber(limits.windowMinutes)
    const requestLimit = toPositiveNumber(limits.windowRequests)
    const costLimit = toPositiveNumber(limits.windowCost)
    if (windowMinutes <= 0 || (requestLimit <= 0 && costLimit <= 0)) {
      return true
    }

    const windowResult = await redis.checkAndIncrementServiceWindow(
      keyId,
      service,
      windowMinutes,
      requestLimit,
      costLimit
    )

    if (!windowResult.allowed) {
      const remainingMinutes = Math.max(
        1,
        Math.ceil((windowResult.resetAt.getTime() - Date.now()) / 60000)
      )
      const isRequestLimit = windowResult.reason === 'requests'
      logger.security(
        `Service window limit exceeded for key ${keyId} (${keyName}), service=${service}, reason=${windowResult.reason}`
      )
      res.status(429).json({
        error: 'Rate limit exceeded',
        message: isRequestLimit
          ? `已达到 ${service} 服务请求次数限制 (${requestLimit} 次)，将在 ${remainingMinutes} 分钟后重置`
          : `已达到 ${service} 服务费用限制 ($${costLimit})，将在 ${remainingMinutes} 分钟后重置`,
        service,
        currentRequests: windowResult.currentRequests,
        requestLimit,
        currentCost: windowResult.currentCost,
        costLimit,
        resetAt: windowResult.resetAt.toISOString(),
        remainingMinutes
      })
      return false
    }

    if (!req._serviceLimitReservations) {
      req._serviceLimitReservations = {}
    }
    req._serviceLimitReservations[service] = {
      service,
      windowStart: windowResult.windowStart,
      resetAt: windowResult.resetAt.toISOString()
    }

    return true
  }

  _sendCostLimitResponse(res, { service, currentCost, costLimit, resetAt, period }) {
    const isDaily = period === 'daily'
    res.status(402).json({
      error: {
        type: 'insufficient_quota',
        message: `已达到 ${service} 服务${isDaily ? '每日' : '周'}费用限制 ($${costLimit})`,
        code: `service_${period}_cost_limit_exceeded`
      },
      service,
      currentCost,
      costLimit,
      resetAt: resetAt.toISOString()
    })
    return false
  }
}

module.exports = new ServiceLimitService()
