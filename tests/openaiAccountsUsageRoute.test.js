/**
 * GET /admin/openai-accounts/usage is the one path that DOES reach upstream.
 *
 * These tests pin down how often it is allowed to do so: at most once per account per cooldown
 * window, regardless of how hard the endpoint is polled and regardless of business traffic
 * rewriting the snapshot in between.
 */

jest.useFakeTimers()

const mockFetchCodexUsage = jest.fn()
const mockUpdateSnapshot = jest.fn()
const mockLockState = new Set()

let mockAccounts = []
let mockOverviews = {}

const mockAcquireLock = jest.fn(async (accountId) => {
  if (mockLockState.has(accountId)) {
    return false
  }
  mockLockState.add(accountId)
  return true
})

const mockExtendCooldown = jest.fn(async (accountId) => {
  mockLockState.add(accountId)
})

jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })
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
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next(),
  authenticateApiKey: (req, res, next) => next()
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn(async () => mockAccounts),
  getAccountOverview: jest.fn(async (id) => mockOverviews[id] || null),
  fetchCodexUsage: mockFetchCodexUsage,
  updateCodexUsageSnapshot: mockUpdateSnapshot,
  acquireCodexUsageFetchLock: mockAcquireLock,
  extendCodexUsageFetchCooldown: mockExtendCooldown
}))
jest.mock('../src/services/accountGroupService', () => ({
  getAccountGroups: jest.fn(async () => [])
}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getClientSafe: () => ({}),
  setOAuthSession: jest.fn(),
  getOAuthSession: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: (account) => account,
  mapExpiryField: (value) => value
}))

const express = require('express')
const request = require('supertest')
const openaiAccountsRoutes = require('../src/routes/admin/openaiAccounts')

const app = express()
app.use(express.json())
app.use('/admin/openai-accounts', openaiAccountsRoutes)

const snapshot = ({ source, whamFetchedAt, usedPercent = 5 }) => ({
  updatedAt: new Date().toISOString(),
  source,
  whamFetchedAt,
  isStale: false,
  limits: [
    {
      limitId: 'codex',
      primary: { usedPercent, windowMinutes: 10080, resetAt: '2026-08-12T00:00:00.000Z' }
    }
  ]
})

const makeAccount = (id, codexUsage) => ({
  id,
  name: id,
  platform: 'openai',
  isActive: true,
  status: 'active',
  codexUsage
})

const poll = () => request(app).get('/admin/openai-accounts/usage')

describe('GET /admin/openai-accounts/usage cooldown', () => {
  beforeEach(() => {
    mockLockState.clear()
    mockAccounts = []
    mockOverviews = {}
    mockFetchCodexUsage.mockReset()
    mockUpdateSnapshot.mockReset()
    mockAcquireLock.mockClear()
    mockExtendCooldown.mockClear()
    mockFetchCodexUsage.mockResolvedValue({ limits: [] })
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('does not reach upstream when the last authoritative fetch is recent', async () => {
    mockAccounts = [
      makeAccount('a1', snapshot({ source: 'wham', whamFetchedAt: new Date().toISOString() }))
    ]

    const res = await poll()

    expect(res.status).toBe(200)
    expect(mockFetchCodexUsage).not.toHaveBeenCalled()
  })

  it('keeps the cooldown even after business traffic rewrote the snapshot from headers', async () => {
    // The regression this exists for: header writes move `updatedAt` and flip `source` to
    // 'headers'. Keying freshness off either would refetch upstream on every poll for any
    // account that is actually being used.
    mockAccounts = [
      makeAccount(
        'busy',
        snapshot({ source: 'headers', whamFetchedAt: new Date().toISOString(), usedPercent: 42 })
      )
    ]

    await poll()
    await poll()
    await poll()

    expect(mockFetchCodexUsage).not.toHaveBeenCalled()
    expect(mockAcquireLock).not.toHaveBeenCalled()
  })

  it('fetches once when the snapshot has never been reconciled by wham', async () => {
    mockAccounts = [makeAccount('fresh', snapshot({ source: 'headers', whamFetchedAt: null }))]
    mockOverviews.fresh = {
      codexUsage: snapshot({ source: 'wham', whamFetchedAt: new Date().toISOString() })
    }

    await poll()

    expect(mockFetchCodexUsage).toHaveBeenCalledTimes(1)
    expect(mockUpdateSnapshot).toHaveBeenCalledWith('fresh', expect.anything(), { source: 'wham' })
  })

  it('polling in a tight loop still produces exactly one upstream request per account', async () => {
    mockAccounts = [
      makeAccount('a1', snapshot({ source: 'headers', whamFetchedAt: null })),
      makeAccount('a2', snapshot({ source: 'headers', whamFetchedAt: null }))
    ]

    for (let i = 0; i < 25; i++) {
      await poll()
    }

    // The cooldown gate is what bounds this — the stubbed accounts never get a fresher
    // whamFetchedAt, so only the lock stands between a polling script and 50 upstream calls.
    expect(mockFetchCodexUsage).toHaveBeenCalledTimes(2)
    const fetched = mockFetchCodexUsage.mock.calls.map(([id]) => id).sort()
    expect(fetched).toEqual(['a1', 'a2'])
  })

  it('does not retry a failing account on the next poll', async () => {
    mockAccounts = [makeAccount('broken', snapshot({ source: 'headers', whamFetchedAt: null }))]
    mockFetchCodexUsage.mockRejectedValue(new Error('proxy down'))

    const first = await poll()
    const second = await poll()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // A broken account must not turn every poll into an upstream request.
    expect(mockFetchCodexUsage).toHaveBeenCalledTimes(1)
    // And the previous snapshot survives rather than being blanked.
    expect(second.body.data.broken.limits[0].primary.usedPercent).toBe(5)
  })

  it('backs off further when a fetch reaches no verdict', async () => {
    // A 403 account never records whamFetchedAt, so the normal cooldown alone would let it fire
    // one doomed request every window, forever. The longer backoff is what stops that.
    mockAccounts = [
      makeAccount('unsupported', snapshot({ source: 'headers', whamFetchedAt: null }))
    ]
    mockFetchCodexUsage.mockResolvedValue(null)

    await poll()

    expect(mockFetchCodexUsage).toHaveBeenCalledTimes(1)
    expect(mockUpdateSnapshot).not.toHaveBeenCalled()
    expect(mockExtendCooldown).toHaveBeenCalledWith('unsupported', 1800)
  })

  it('backs off further when a fetch throws', async () => {
    mockAccounts = [makeAccount('broken', snapshot({ source: 'headers', whamFetchedAt: null }))]
    mockFetchCodexUsage.mockRejectedValue(new Error('proxy down'))

    await poll()

    expect(mockExtendCooldown).toHaveBeenCalledWith('broken', 1800)
  })

  it('does not extend the cooldown after a successful fetch', async () => {
    mockAccounts = [makeAccount('ok', snapshot({ source: 'headers', whamFetchedAt: null }))]
    mockOverviews.ok = snapshot({ source: 'wham', whamFetchedAt: new Date().toISOString() })
    mockOverviews.ok = { codexUsage: mockOverviews.ok }

    await poll()

    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1)
    expect(mockExtendCooldown).not.toHaveBeenCalled()
  })

  it('skips inactive accounts entirely', async () => {
    mockAccounts = [
      {
        ...makeAccount('off', snapshot({ source: 'headers', whamFetchedAt: null })),
        isActive: false
      }
    ]

    await poll()

    expect(mockFetchCodexUsage).not.toHaveBeenCalled()
  })
})
