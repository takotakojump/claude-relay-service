// Tracks every Redis command the route issues. The point of this suite is that querying your own
// usage is purely observational — if it ever starts writing, it would consume the quota it reports.
const WRITE_COMMANDS = [
  'set',
  'setex',
  'psetex',
  'incr',
  'incrby',
  'incrbyfloat',
  'decr',
  'hset',
  'hdel',
  'del',
  'expire',
  'pexpire',
  'eval',
  'evalsha',
  'pipeline',
  'multi'
]

const commandLog = []

const track = (name, impl) =>
  jest.fn(async (...args) => {
    commandLog.push(name)
    return impl ? impl(...args) : null
  })

let mockRedisStore = {}

const mockClient = {
  get: track('get', async (key) => (key in mockRedisStore ? mockRedisStore[key] : null))
}

const mockRedis = {
  getClientSafe: () => mockClient,
  getApiKey: track('getApiKey', async () => mockStoredApiKey),
  getCostStats: track('getCostStats', async () => ({ total: 12.5 })),
  getDailyCost: track('getDailyCost', async () => 3.25),
  getServiceDailyCost: track('getServiceDailyCost', async () => 4),
  getServiceWeeklyCost: track('getServiceWeeklyCost', async () => 9),
  getWeeklyOpusCost: track('getWeeklyOpusCost', async () => 1),
  getUsageStats: track('getUsageStats', async () => ({})),
  getNextDailyResetTime: () => new Date('2026-08-06T00:00:00.000Z'),
  getNextResetTime: () => new Date('2026-08-10T00:00:00.000Z'),
  peekServiceWindow: undefined
}

// Anything not explicitly mocked must blow up rather than silently no-op.
for (const command of WRITE_COMMANDS) {
  mockClient[command] = track(command, async () => {
    throw new Error(`unexpected write command: ${command}`)
  })
}

let mockStoredApiKey = {}
let mockValidationResult = { valid: true }
let mockOpenaiOverview = null

jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })
jest.mock('../src/models/redis', () => mockRedis)
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
jest.mock('../src/services/apiKeyService', () => ({
  validateApiKeyForStats: jest.fn(async () => mockValidationResult),
  hasPermission: jest.fn(() => true)
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccountOverview: jest.fn(async () => mockOpenaiOverview)
}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccountOverview: jest.fn(async () => null)
}))
jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({ calculateCost: jest.fn() }))
jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  extractErrorMessage: jest.fn(),
  sanitizeErrorMsg: jest.fn()
}))
jest.mock('../config/models', () => ({}), { virtual: true })
jest.mock('../src/utils/errorSanitizer', () => ({ getSafeMessage: jest.fn() }))

// peekServiceWindow lives on the real redis model; reimplement the read-only contract here so the
// route is exercised against something that behaves like it.
mockRedis.peekServiceWindow = track('peekServiceWindow', async (keyId, service, windowMinutes) => {
  const startRaw = mockRedisStore[`rate_limit:window_start:${keyId}:${service}`]
  if (!startRaw) {
    return { currentRequests: 0, currentCost: 0, windowStart: null, resetAt: null }
  }
  const windowStart = Number(startRaw)
  return {
    currentRequests:
      Number(mockRedisStore[`rate_limit:requests:${keyId}:${service}:${startRaw}`]) || 0,
    currentCost: Number(mockRedisStore[`rate_limit:cost:${keyId}:${service}:${startRaw}`]) || 0,
    windowStart,
    resetAt: new Date(windowStart + windowMinutes * 60000).toISOString()
  }
})

const express = require('express')
const request = require('supertest')
const apiStatsRoutes = require('../src/routes/apiStats')

const app = express()
app.use(express.json())
app.use('/apiStats', apiStatsRoutes)

const VALID_KEY = 'cr_test_key_1234567890'

const baseValidation = () => ({
  valid: true,
  keyData: {
    id: 'key-1',
    name: 'test key',
    description: 'desc',
    createdAt: '2026-07-01T00:00:00.000Z',
    expiresAt: null,
    permissions: 'all',
    tokenLimit: 1000,
    concurrencyLimit: 5,
    rateLimitWindow: 60,
    rateLimitRequests: 100,
    rateLimitCost: 10,
    dailyCostLimit: 20,
    totalCostLimit: 200,
    weeklyOpusCostLimit: 50,
    weeklyOpusCost: 1,
    enableModelRestriction: false,
    restrictedModels: [],
    enableClientRestriction: false,
    allowedClients: [],
    openaiAccountId: 'openai-1',
    usage: { total: { requests: 10, allTokens: 100 } }
  }
})

const get = () =>
  request(app).get('/apiStats/api/key-usage').set('Authorization', `Bearer ${VALID_KEY}`)

describe('GET /apiStats/api/key-usage', () => {
  beforeEach(() => {
    commandLog.length = 0
    mockRedisStore = {}
    mockStoredApiKey = { id: 'key-1', serviceLimits: {}, weeklyResetDay: 1, weeklyResetHour: 0 }
    mockValidationResult = baseValidation()
    mockOpenaiOverview = null
    jest.clearAllMocks()
  })

  it('rejects a request without an Authorization header', async () => {
    const res = await request(app).get('/apiStats/api/key-usage')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Missing API key')
  })

  it('rejects a malformed key', async () => {
    const res = await request(app)
      .get('/apiStats/api/key-usage')
      .set('Authorization', 'Bearer short')
    expect(res.status).toBe(400)
  })

  it('returns 401 for an unknown key', async () => {
    mockValidationResult = { valid: false, error: 'API key not found' }
    const res = await get()
    expect(res.status).toBe(401)
  })

  it('returns 403 for a disabled or expired key', async () => {
    mockValidationResult = { valid: false, error: 'API Key "x" 已过期' }
    const res = await get()
    expect(res.status).toBe(403)
  })

  it('never issues a write command', async () => {
    mockStoredApiKey.serviceLimits = {
      opus: { dailyCostLimit: 10, weeklyCostLimit: 40, windowMinutes: 60, windowRequests: 100 }
    }
    mockRedisStore['rate_limit:window_start:key-1:opus'] = String(Date.now())

    const res = await get()

    expect(res.status).toBe(200)
    // The whole point: reading usage must not consume it.
    for (const command of WRITE_COMMANDS) {
      expect(commandLog).not.toContain(command)
    }
  })

  it('reports key limits together with current usage', async () => {
    const windowStart = Date.now() - 10 * 60 * 1000
    mockRedisStore['rate_limit:window_start:key-1'] = String(windowStart)
    mockRedisStore['rate_limit:requests:key-1'] = '7'
    mockRedisStore['rate_limit:tokens:key-1'] = '700'
    mockRedisStore['rate_limit:cost:key-1'] = '1.5'

    const res = await get()

    expect(res.status).toBe(200)
    expect(res.body.data.limits.rateLimitRequests).toBe(100)
    expect(res.body.data.usage.window.requests).toBe(7)
    expect(res.body.data.usage.window.tokens).toBe(700)
    expect(res.body.data.usage.window.cost).toBe(1.5)
    expect(res.body.data.usage.window.remainingSeconds).toBeGreaterThan(0)
    expect(res.body.data.usage.total.cost).toBe(12.5)
    expect(res.body.data.usage.daily.cost).toBe(3.25)
  })

  it('zeroes an elapsed rate limit window instead of reporting stale counters', async () => {
    mockRedisStore['rate_limit:window_start:key-1'] = String(Date.now() - 120 * 60 * 1000)
    mockRedisStore['rate_limit:requests:key-1'] = '99'

    const res = await get()

    expect(res.body.data.usage.window.requests).toBe(0)
    expect(res.body.data.usage.window.remainingSeconds).toBe(0)
    expect(res.body.data.usage.window.startAt).toBeNull()
  })

  it('reports per-service limits with their own usage', async () => {
    mockStoredApiKey.serviceLimits = {
      opus: { dailyCostLimit: 10, weeklyCostLimit: 40, windowMinutes: 60, windowRequests: 100 }
    }
    const windowStart = Date.now() - 5 * 60 * 1000
    mockRedisStore['rate_limit:window_start:key-1:opus'] = String(windowStart)
    mockRedisStore[`rate_limit:requests:key-1:opus:${windowStart}`] = '12'

    const res = await get()

    expect(res.body.data.serviceLimits).toHaveLength(1)
    const opus = res.body.data.serviceLimits[0]
    expect(opus.service).toBe('opus')
    expect(opus.dailyCostLimit).toBe(10)
    expect(opus.currentDailyCost).toBe(4)
    expect(opus.currentWeeklyCost).toBe(9)
    expect(opus.currentWindowRequests).toBe(12)
    expect(opus.exceeded).toBe(false)
  })

  it('marks a service as exceeded once a configured limit is reached', async () => {
    mockStoredApiKey.serviceLimits = { opus: { dailyCostLimit: 4 } }
    const res = await get()
    expect(res.body.data.serviceLimits[0].exceeded).toBe(true)
  })

  it('returns the cached codex snapshot for a dedicated account without hitting upstream', async () => {
    mockOpenaiOverview = {
      id: 'openai-1',
      accountType: 'dedicated',
      platform: 'openai',
      codexUsage: {
        updatedAt: '2026-08-05T00:00:00.000Z',
        source: 'wham',
        isStale: true,
        limits: [
          {
            limitId: 'codex',
            primary: { usedPercent: 5, windowMinutes: 10080, resetAt: '2026-08-09T00:00:00.000Z' }
          }
        ]
      }
    }

    const res = await get()

    expect(res.body.data.accounts.openai.codexUsage.isStale).toBe(true)
    expect(res.body.data.accounts.openai.codexUsage.limits[0].primary.windowMinutes).toBe(10080)
  })

  it('withholds quota for a shared account', async () => {
    mockOpenaiOverview = { id: 'openai-1', accountType: 'shared', codexUsage: { limits: [] } }

    const res = await get()

    expect(res.body.data.accounts.openai.codexUsage).toBeNull()
    expect(res.body.data.accounts.openai.reason).toBe('shared_account_quota_not_exposed')
  })
})
