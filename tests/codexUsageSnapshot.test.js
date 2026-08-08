// openaiAccountService installs a module-level cache-cleanup interval on require; fake timers keep
// it from holding the event loop open after the suite finishes.
jest.useFakeTimers()

const { parseCodexRateLimitHeaders } = require('../src/utils/codexRateLimitHeaders')

// One in-memory hash standing in for the account's Redis hash.
let storedAccount = {}
const commandLog = []

const mockClient = {
  hset: jest.fn(async (_key, fieldOrMap, value) => {
    commandLog.push('hset')
    if (typeof fieldOrMap === 'object') {
      Object.assign(storedAccount, fieldOrMap)
    } else {
      storedAccount[fieldOrMap] = value
    }
  }),
  hdel: jest.fn(async (_key, ...fields) => {
    commandLog.push('hdel')
    for (const field of fields) {
      delete storedAccount[field]
    }
  }),
  hget: jest.fn(async (_key, field) => {
    commandLog.push('hget')
    return storedAccount[field] === undefined ? null : storedAccount[field]
  }),
  hgetall: jest.fn(async () => {
    commandLog.push('hgetall')
    return { ...storedAccount }
  })
}

jest.mock('../config/config', () => ({ openai: {}, system: { timezoneOffset: 8 } }), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({
  getClientSafe: () => mockClient
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
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')

const { updateCodexUsageSnapshot, buildCodexUsageSnapshot, recordCodexAvailability } =
  openaiAccountService

const ACCOUNT_ID = 'account-1'

const findLimit = (snapshot, limitId) =>
  snapshot.limits.find((limit) => limit.limitId === limitId) || null

const writeHeaders = async (headers, now) =>
  updateCodexUsageSnapshot(ACCOUNT_ID, parseCodexRateLimitHeaders(headers, { now }), {
    source: 'headers'
  })

describe('Codex usage snapshots', () => {
  beforeEach(() => {
    storedAccount = { id: ACCOUNT_ID, name: 'test-account' }
    commandLog.length = 0
    jest.clearAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('keeps window meaning on windowMinutes, not on the slot name', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '5',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '424800'
    })

    const snapshot = buildCodexUsageSnapshot(storedAccount)
    const codex = findLimit(snapshot, 'codex')

    // A weekly window living in the primary slot must stay identifiable as weekly.
    expect(codex.primary.windowMinutes).toBe(10080)
    expect(codex.secondary).toBeNull()
  })

  it('renders both windows when upstream reports both', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '40',
      'x-codex-secondary-window-minutes': '10080'
    })

    const codex = findLimit(buildCodexUsageSnapshot(storedAccount), 'codex')
    expect(codex.primary.windowMinutes).toBe(300)
    expect(codex.secondary.windowMinutes).toBe(10080)
  })

  it('drops a window the response stopped reporting for a bucket it did report', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '40',
      'x-codex-secondary-window-minutes': '10080'
    })

    await writeHeaders({
      'x-codex-primary-used-percent': '13',
      'x-codex-primary-window-minutes': '300'
    })

    const codex = findLimit(buildCodexUsageSnapshot(storedAccount), 'codex')
    expect(codex.primary.usedPercent).toBe(13)
    // The ghost weekly card is the bug this asserts against.
    expect(codex.secondary).toBeNull()
  })

  it('clears every bucket missing from an authoritative wham snapshot', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300',
      'x-codex-sol-primary-used-percent': '90',
      'x-codex-sol-primary-window-minutes': '10080'
    })

    expect(buildCodexUsageSnapshot(storedAccount).limits).toHaveLength(2)

    await updateCodexUsageSnapshot(
      ACCOUNT_ID,
      {
        limits: [
          {
            limitId: 'codex',
            limitName: 'Codex',
            primary: { usedPercent: 15, windowMinutes: 300, resetAt: '2026-08-05T05:00:00.000Z' },
            secondary: null
          }
        ]
      },
      { source: 'wham' }
    )

    const snapshot = buildCodexUsageSnapshot(storedAccount)
    expect(snapshot.limits).toHaveLength(1)
    expect(findLimit(snapshot, 'codex_sol')).toBeNull()
    expect(snapshot.source).toBe('wham')
  })

  it('leaves buckets a sparse header response did not mention', async () => {
    await updateCodexUsageSnapshot(
      ACCOUNT_ID,
      {
        limits: [
          {
            limitId: 'codex',
            primary: { usedPercent: 10, windowMinutes: 300, resetAt: '2026-08-05T05:00:00.000Z' },
            secondary: null
          },
          {
            limitId: 'codex_sol',
            limitName: 'GPT-5.6 Sol',
            primary: {
              usedPercent: 100,
              windowMinutes: 10080,
              resetAt: '2026-08-09T00:00:00.000Z'
            },
            secondary: null
          }
        ]
      },
      { source: 'wham' }
    )

    await writeHeaders({
      'x-codex-primary-used-percent': '11',
      'x-codex-primary-window-minutes': '300'
    })

    const snapshot = buildCodexUsageSnapshot(storedAccount)
    expect(findLimit(snapshot, 'codex').primary.usedPercent).toBe(11)
    // Sol was not in this response's headers, so it must survive until wham reconciles it.
    expect(findLimit(snapshot, 'codex_sol').primary.usedPercent).toBe(100)
  })

  it('tracks per-model buckets independently of the shared codex bucket', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '20',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-sol-primary-used-percent': '100',
      'x-codex-sol-primary-window-minutes': '10080',
      'x-codex-sol-limit-name': 'GPT-5.6 Sol'
    })

    const snapshot = buildCodexUsageSnapshot(storedAccount)
    expect(findLimit(snapshot, 'codex').primary.usedPercent).toBe(20)

    const sol = findLimit(snapshot, 'codex_sol')
    expect(sol.limitName).toBe('GPT-5.6 Sol')
    expect(sol.primary.usedPercent).toBe(100)
  })

  it('does not slide reset times forward when an unrelated refresh arrives', async () => {
    const firstCapture = Date.parse('2026-08-05T00:00:00.000Z')
    await writeHeaders(
      {
        'x-codex-primary-used-percent': '12',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '3600',
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-after-seconds': '86400'
      },
      firstCapture
    )

    const secondaryResetAfterFirstWrite = findLimit(buildCodexUsageSnapshot(storedAccount), 'codex')
      .secondary.resetAt

    // An hour later a new response arrives still reporting both windows with fresh relative
    // offsets for primary only; secondary keeps its original absolute reset point.
    await writeHeaders(
      {
        'x-codex-primary-used-percent': '18',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '1800',
        'x-codex-secondary-used-percent': '41',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': secondaryResetAfterFirstWrite
      },
      firstCapture + 3600 * 1000
    )

    const codex = findLimit(buildCodexUsageSnapshot(storedAccount), 'codex')
    expect(codex.secondary.resetAt).toBe(secondaryResetAfterFirstWrite)
    expect(codex.primary.resetAt).toBe('2026-08-05T01:30:00.000Z')
  })

  it('ignores a response that carries no quota headers at all', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300'
    })

    const before = JSON.stringify(buildCodexUsageSnapshot(storedAccount).limits)

    // parseCodexRateLimitHeaders returns null here; the route skips the write entirely.
    expect(parseCodexRateLimitHeaders({ 'content-type': 'application/json' })).toBeNull()
    await updateCodexUsageSnapshot(ACCOUNT_ID, null, { source: 'headers' })

    expect(JSON.stringify(buildCodexUsageSnapshot(storedAccount).limits)).toBe(before)
  })

  it('migrates pre-rewrite flat fields and deletes them on first write', async () => {
    storedAccount = {
      id: ACCOUNT_ID,
      codexUsageUpdatedAt: '2026-08-05T00:00:00.000Z',
      codexPrimaryUsedPercent: '7',
      codexPrimaryWindowMinutes: '10080',
      codexPrimaryResetAfterSeconds: '3600'
    }

    const migrated = buildCodexUsageSnapshot(storedAccount)
    expect(migrated.source).toBe('legacy')
    expect(findLimit(migrated, 'codex').primary).toMatchObject({
      usedPercent: 7,
      windowMinutes: 10080,
      resetAt: '2026-08-05T01:00:00.000Z'
    })

    await writeHeaders({
      'x-codex-primary-used-percent': '8',
      'x-codex-primary-window-minutes': '10080'
    })

    expect(storedAccount.codexPrimaryUsedPercent).toBeUndefined()
    expect(storedAccount.codexUsageUpdatedAt).toBeUndefined()
    expect(storedAccount.codexUsageSnapshot).toBeDefined()
  })

  it('flags a snapshot as stale once it ages past the threshold', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300'
    })

    expect(buildCodexUsageSnapshot(storedAccount).isStale).toBe(false)

    const stored = JSON.parse(storedAccount.codexUsageSnapshot)
    stored.updatedAt = new Date(
      Date.now() - openaiAccountService.CODEX_USAGE_STALE_AFTER_MS - 1000
    ).toISOString()
    storedAccount.codexUsageSnapshot = JSON.stringify(stored)

    const snapshot = buildCodexUsageSnapshot(storedAccount)
    expect(snapshot.isStale).toBe(true)
    // Stale data is still returned — the panel says "outdated", it does not zero everything out.
    expect(findLimit(snapshot, 'codex').primary.usedPercent).toBe(12)
  })

  it('returns null when the account has never reported quota', () => {
    expect(buildCodexUsageSnapshot({ id: ACCOUNT_ID })).toBeNull()
  })

  it('keeps whamFetchedAt across header writes so the refresh cooldown survives traffic', async () => {
    await updateCodexUsageSnapshot(
      ACCOUNT_ID,
      {
        limits: [
          {
            limitId: 'codex',
            primary: { usedPercent: 10, windowMinutes: 300, resetAt: '2026-08-05T05:00:00.000Z' }
          }
        ]
      },
      { source: 'wham' }
    )

    const afterWham = buildCodexUsageSnapshot(storedAccount)
    expect(afterWham.whamFetchedAt).toBeTruthy()

    // Business traffic writes header snapshots constantly. If those reset the cooldown clock, an
    // actively used account would refetch /wham/usage on every single admin poll.
    for (let i = 0; i < 5; i++) {
      await writeHeaders({
        'x-codex-primary-used-percent': String(11 + i),
        'x-codex-primary-window-minutes': '300'
      })
    }

    const afterHeaders = buildCodexUsageSnapshot(storedAccount)
    expect(afterHeaders.source).toBe('headers')
    expect(afterHeaders.whamFetchedAt).toBe(afterWham.whamFetchedAt)
    expect(findLimit(afterHeaders, 'codex').primary.usedPercent).toBe(15)
  })

  it('leaves whamFetchedAt null until an authoritative fetch happens', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300'
    })

    expect(buildCodexUsageSnapshot(storedAccount).whamFetchedAt).toBeNull()
  })

  it('records model availability without touching the quota snapshot', async () => {
    await writeHeaders({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': '300'
    })

    await recordCodexAvailability(ACCOUNT_ID, {
      model: 'gpt-5.6-sol',
      state: 'server_overloaded',
      detail: 'Selected model is at capacity. Please try a different model.'
    })

    const availability = openaiAccountService.buildCodexAvailability(storedAccount)
    expect(availability.models['gpt-5.6-sol'].state).toBe('server_overloaded')

    const codex = findLimit(buildCodexUsageSnapshot(storedAccount), 'codex')
    // A capacity error must never be painted as exhausted quota.
    expect(codex.primary.usedPercent).toBe(12)
  })
})
