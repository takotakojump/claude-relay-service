jest.mock('../config/config', () => ({ security: { apiKeyPrefix: 'cr_' } }), { virtual: true })

const mockCheckAndIncrementServiceWindow = jest.fn()
const mockGetServiceDailyCost = jest.fn(async () => 0)
const mockGetServiceWeeklyCost = jest.fn(async () => 0)
jest.mock('../src/models/redis', () => ({
  getServiceDailyCost: mockGetServiceDailyCost,
  getServiceWeeklyCost: mockGetServiceWeeklyCost,
  getNextDailyResetTime: () => new Date('2026-07-28T00:00:00.000Z'),
  getNextResetTime: () => new Date('2026-08-03T00:00:00.000Z'),
  checkAndIncrementServiceWindow: mockCheckAndIncrementServiceWindow
}))

jest.mock('../src/utils/logger', () => {
  const noop = jest.fn()
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    api: noop,
    database: noop,
    security: noop
  }
})

const serviceLimitService = require('../src/services/serviceLimitService')

const KEY_ID = 'key-1'

function makeReq(serviceLimits, model = 'claude-opus-4-8') {
  return {
    body: { model },
    params: {},
    apiKey: {
      id: KEY_ID,
      name: 'test-key',
      weeklyResetDay: 1,
      weeklyResetHour: 0,
      serviceLimits
    }
  }
}

function makeRes() {
  const res = {}
  res.statusCode = 200
  res.body = null
  res.status = jest.fn((code) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn((body) => {
    res.body = body
    return res
  })
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetServiceDailyCost.mockResolvedValue(0)
  mockGetServiceWeeklyCost.mockResolvedValue(0)
  mockCheckAndIncrementServiceWindow.mockResolvedValue({
    allowed: true,
    reason: null,
    currentRequests: 1,
    currentCost: 0,
    windowStart: Date.now(),
    resetAt: new Date(Date.now() + 5 * 60 * 1000),
    tokenCountKey: `rate_limit:tokens:${KEY_ID}:claude`,
    costCountKey: `rate_limit:cost:${KEY_ID}:claude`
  })
})

describe('per-service usage limit enforcement', () => {
  it('blocks with 402 when the requested model family daily cost limit is reached', async () => {
    mockGetServiceDailyCost.mockResolvedValue(10)
    const req = makeReq({ claude: { dailyCostLimit: 5 } })
    const res = makeRes()

    const allowed = await serviceLimitService.enforceForRequest(req, res, 'claude-opus-4-8')

    expect(allowed).toBe(false)
    expect(res.status).toHaveBeenCalledWith(402)
    expect(res.body.error.code).toBe('service_daily_cost_limit_exceeded')
    expect(res.body.service).toBe('claude')
    expect(mockGetServiceDailyCost).toHaveBeenCalledWith(KEY_ID, 'claude')
  })

  it('blocks with 402 when the requested model family weekly cost limit is reached', async () => {
    mockGetServiceWeeklyCost.mockResolvedValue(7)
    const req = makeReq({ bedrock: { weeklyCostLimit: 5 } })
    const res = makeRes()

    const allowed = await serviceLimitService.enforceForRequest(req, res, 'amazon-titan-text')

    expect(allowed).toBe(false)
    expect(res.status).toHaveBeenCalledWith(402)
    expect(res.body.error.code).toBe('service_weekly_cost_limit_exceeded')
    expect(res.body.service).toBe('bedrock')
  })

  it('uses URL model parameters when the request body has no model', async () => {
    const req = makeReq({ gemini: { dailyCostLimit: 5 } }, '')
    req.body = {}
    req.params.modelName = 'gemini-2.5-pro'
    const res = makeRes()

    const allowed = await serviceLimitService.enforceForRequest(req, res)

    expect(allowed).toBe(true)
    expect(mockGetServiceDailyCost).toHaveBeenCalledWith(KEY_ID, 'gemini')
  })

  it('classifies Azure embedding models as Codex', async () => {
    const req = makeReq({ codex: { dailyCostLimit: 5 } }, 'text-embedding-3-large')

    expect(await serviceLimitService.enforceForRequest(req, makeRes())).toBe(true)
    expect(mockGetServiceDailyCost).toHaveBeenCalledWith(KEY_ID, 'codex')
  })

  it('buckets by the upstream channel even when the model belongs to another family', async () => {
    const req = makeReq({ ccr: { dailyCostLimit: 5 } }, 'claude-opus-4-8')

    expect(await serviceLimitService.enforceForRequest(req, makeRes(), '', 'ccr')).toBe(true)
    expect(mockGetServiceDailyCost).toHaveBeenCalledWith(KEY_ID, 'ccr')
  })

  it('falls back to the model family when the account type is unmapped', async () => {
    const req = makeReq({ claude: { dailyCostLimit: 5 } }, 'claude-opus-4-8')

    expect(await serviceLimitService.enforceForRequest(req, makeRes(), '', 'something-new')).toBe(
      true
    )
    expect(mockGetServiceDailyCost).toHaveBeenCalledWith(KEY_ID, 'claude')
  })

  it('fails open when neither the account type nor the model can be classified', async () => {
    const req = makeReq({ claude: { dailyCostLimit: 5 } }, 'vendor-model-v1')
    const res = makeRes()

    expect(await serviceLimitService.enforceForRequest(req, res)).toBe(true)
    expect(res.status).not.toHaveBeenCalled()
    expect(mockGetServiceDailyCost).not.toHaveBeenCalled()
  })

  it('returns 429 when the atomic service window rejects the request', async () => {
    mockCheckAndIncrementServiceWindow.mockResolvedValue({
      allowed: false,
      reason: 'requests',
      currentRequests: 2,
      currentCost: 0,
      resetAt: new Date(Date.now() + 5 * 60 * 1000)
    })
    const req = makeReq({ claude: { windowMinutes: 5, windowRequests: 2 } })
    const res = makeRes()

    const allowed = await serviceLimitService.enforceForRequest(req, res, 'claude-opus-4-8')

    expect(allowed).toBe(false)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.body.service).toBe('claude')
  })

  it('reserves the selected service window atomically', async () => {
    const req = makeReq({ claude: { windowMinutes: 5, windowRequests: 5 } })
    const res = makeRes()

    const allowed = await serviceLimitService.enforceForRequest(req, res, 'claude-opus-4-8')

    expect(allowed).toBe(true)
    expect(mockCheckAndIncrementServiceWindow).toHaveBeenCalledWith(KEY_ID, 'claude', 5, 5, 0, true)
    expect(req._serviceLimitReservations.claude.windowStart).toEqual(expect.any(Number))
  })

  it('does not touch the window request counter for count_tokens-style calls', async () => {
    const req = makeReq({ claude: { windowMinutes: 5, windowRequests: 5 } })

    // 只配了请求数限制时，不计数的调用无需查询窗口
    expect(
      await serviceLimitService.enforceForRequest(req, makeRes(), 'claude-opus-4-8', null, {
        countsAsRequest: false
      })
    ).toBe(true)
    expect(mockCheckAndIncrementServiceWindow).not.toHaveBeenCalled()
  })

  it('still applies the window cost limit to count_tokens-style calls', async () => {
    const req = makeReq({ claude: { windowMinutes: 5, windowCost: 10 } })

    expect(
      await serviceLimitService.enforceForRequest(req, makeRes(), 'claude-opus-4-8', null, {
        countsAsRequest: false
      })
    ).toBe(true)
    expect(mockCheckAndIncrementServiceWindow).toHaveBeenCalledWith(
      KEY_ID,
      'claude',
      5,
      0,
      10,
      false
    )
  })

  it('reuses the request reservation during internal retries', async () => {
    const req = makeReq({ claude: { windowMinutes: 5, windowRequests: 5 } })
    const res = makeRes()

    expect(await serviceLimitService.enforceForRequest(req, res)).toBe(true)
    expect(await serviceLimitService.enforceForRequest(req, res)).toBe(true)
    expect(mockCheckAndIncrementServiceWindow).toHaveBeenCalledTimes(1)
  })

  it('short-circuits without Redis calls when serviceLimits is empty', async () => {
    const allowed = await serviceLimitService.enforceForRequest(makeReq({}), makeRes())

    expect(allowed).toBe(true)
    expect(mockGetServiceDailyCost).not.toHaveBeenCalled()
    expect(mockGetServiceWeeklyCost).not.toHaveBeenCalled()
    expect(mockCheckAndIncrementServiceWindow).not.toHaveBeenCalled()
  })
})
