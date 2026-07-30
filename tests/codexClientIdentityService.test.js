// Codex 客户端身份服务：记录 / 列举 / 清理 / 应用

const store = {
  applied: null,
  observed: {}
}

const mockClient = {
  get: jest.fn(async (key) => (key === 'codex_client_identity' ? store.applied : null)),
  set: jest.fn(async (key, value) => {
    if (key === 'codex_client_identity') {
      store.applied = value
    }
    return 'OK'
  }),
  hget: jest.fn(async (_key, field) => store.observed[field] || null),
  hset: jest.fn(async (_key, field, value) => {
    store.observed[field] = value
    return 1
  }),
  hgetall: jest.fn(async () => ({ ...store.observed })),
  hdel: jest.fn(async (_key, ...fields) => {
    for (const field of fields) {
      delete store.observed[field]
    }
    return fields.length
  }),
  expire: jest.fn(async () => 1)
}

// hdel 在实现里带 .catch()，需要返回真正的 Promise
mockClient.hdel = jest.fn((_key, ...fields) =>
  Promise.resolve(
    fields.reduce((n, field) => {
      delete store.observed[field]
      return n + 1
    }, 0)
  )
)

jest.mock('../src/models/redis', () => ({
  getClient: () => mockClient,
  getClientSafe: () => mockClient
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

const service = require('../src/services/codexClientIdentityService')

const DAY_MS = 24 * 60 * 60 * 1000

function seedObserved(originator, userAgent, { count = 1, lastSeenDaysAgo = 0, version }) {
  const lastSeen = new Date(Date.now() - lastSeenDaysAgo * DAY_MS).toISOString()
  store.observed[`${originator}|${userAgent}`] = JSON.stringify({
    version: version || userAgent.split('/')[1],
    count,
    firstSeen: lastSeen,
    lastSeen
  })
}

describe('codexClientIdentityService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    store.applied = null
    store.observed = {}
    service.clearCache()
  })

  describe('getApplied', () => {
    it('falls back to the built-in identity when nothing was applied', async () => {
      const applied = await service.getApplied()
      expect(applied.originator).toBe('codex_cli_rs')
      expect(applied.userAgent).toBe('codex_cli_rs/0.146.0')
      expect(applied.version).toBe('0.146.0')
    })

    it('returns the applied identity once set', async () => {
      await service.apply(
        { originator: 'codex_cli_rs', userAgent: 'codex_cli_rs/0.150.0 (linux)' },
        'tester'
      )
      service.clearCache()

      const applied = await service.getApplied()
      expect(applied.userAgent).toBe('codex_cli_rs/0.150.0 (linux)')
      expect(applied.version).toBe('0.150.0')
      expect(applied.appliedBy).toBe('tester')
    })
  })

  describe('recordObserved', () => {
    it('records a Codex client and increments on repeat', async () => {
      await service.recordObserved('codex_cli_rs', 'codex_cli_rs/0.146.0 (linux)')
      await service.recordObserved('codex_cli_rs', 'codex_cli_rs/0.146.0 (linux)')

      const observed = await service.listObserved()
      expect(observed).toHaveLength(1)
      expect(observed[0].count).toBe(2)
      expect(observed[0].version).toBe('0.146.0')
    })

    it('ignores non-Codex user agents', async () => {
      await service.recordObserved('whatever', 'python-requests/2.31.0')
      expect(await service.listObserved()).toHaveLength(0)
    })

    it('ignores samples whose originator contradicts the user-agent', async () => {
      await service.recordObserved('codex_vscode', 'codex_cli_rs/0.146.0')
      expect(await service.listObserved()).toHaveLength(0)
    })
  })

  describe('listObserved', () => {
    it('sorts by version descending', async () => {
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.144.5', {})
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.150.0', {})
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.146.0', {})

      const observed = await service.listObserved()
      expect(observed.map((item) => item.version)).toEqual(['0.150.0', '0.146.0', '0.144.5'])
    })

    it('prefers codex_cli_rs when versions tie', async () => {
      seedObserved('codex_vscode', 'codex_vscode/0.150.0', {})
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.150.0', {})

      const observed = await service.listObserved()
      expect(observed[0].originator).toBe('codex_cli_rs')
    })

    it('prunes records not seen within the retention window', async () => {
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.150.0', { lastSeenDaysAgo: 1 })
      seedObserved('codex_cli_rs', 'codex_cli_rs/0.120.0', { lastSeenDaysAgo: 45 })

      const observed = await service.listObserved()
      expect(observed.map((item) => item.version)).toEqual(['0.150.0'])
      // 陈旧记录同时从 Redis 里删掉，而不只是从结果里过滤
      expect(store.observed['codex_cli_rs|codex_cli_rs/0.120.0']).toBeUndefined()
    })

    it('drops entries that cannot be parsed', async () => {
      store.observed['codex_cli_rs|codex_cli_rs/0.150.0'] = 'not json'

      expect(await service.listObserved()).toHaveLength(0)
      expect(store.observed['codex_cli_rs|codex_cli_rs/0.150.0']).toBeUndefined()
    })
  })

  describe('apply', () => {
    it('rejects a user-agent that is not a Codex client', async () => {
      await expect(
        service.apply({ originator: 'codex_cli_rs', userAgent: 'curl/8.0' }, 'tester')
      ).rejects.toThrow('Invalid Codex user-agent')
    })

    it('rejects an originator that contradicts the user-agent', async () => {
      await expect(
        service.apply({ originator: 'codex_exec', userAgent: 'codex_cli_rs/0.150.0' }, 'tester')
      ).rejects.toThrow('originator must match')
    })
  })
})
