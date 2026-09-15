// Codex 诊断日志：写入不得抛出、条数封顶、坏数据不影响读取

const store = { list: [], ttl: null }

const mockClient = {
  lpush: jest.fn(async (_key, value) => store.list.unshift(value)),
  ltrim: jest.fn(async (_key, start, stop) => {
    store.list = store.list.slice(start, stop + 1)
    return 'OK'
  }),
  expire: jest.fn(async (_key, seconds) => {
    store.ttl = seconds
    return 1
  }),
  lrange: jest.fn(async (_key, start, stop) => store.list.slice(start, stop + 1)),
  del: jest.fn(async () => {
    store.list = []
    return 1
  })
}

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockClient)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const service = require('../src/services/codexDiagnosticLogService')

describe('codexDiagnosticLogService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    store.list = []
    store.ttl = null
    redis.getClientSafe.mockReturnValue(mockClient)
  })

  describe('record', () => {
    it('stores an entry with a timestamp and the given fields', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, {
        accountId: 'acct-1',
        accountName: '格物致知柯德克',
        model: 'gpt-5.6-sol',
        state: 'server_overloaded',
        detail: 'Selected model is at capacity. Please try a different model.',
        requestId: 'req-1',
        apiKeyId: 'key-1'
      })

      const [entry] = await service.list()
      expect(entry).toMatchObject({
        eventType: 'codex_stream_error',
        accountId: 'acct-1',
        accountName: '格物致知柯德克',
        model: 'gpt-5.6-sol',
        state: 'server_overloaded',
        requestId: 'req-1',
        apiKeyId: 'key-1'
      })
      expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
    })

    it('never throws when Redis is unavailable', async () => {
      // 它挂在转发热路径上：一次 Redis 抖动不能变成用户侧的 500
      redis.getClientSafe.mockImplementation(() => {
        throw new Error('Redis client is not connected')
      })

      await expect(
        service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'acct-1' })
      ).resolves.toBeUndefined()
    })

    it('caps the list so this temporary log cannot grow without bound', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'acct-1' })

      expect(mockClient.ltrim).toHaveBeenCalledWith(
        service.DIAGNOSTIC_LOG_KEY,
        0,
        service.MAX_ENTRIES - 1
      )
      expect(store.ttl).toBe(service.RETENTION_SECONDS)
    })

    it('truncates an oversized detail instead of storing it whole', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { detail: 'x'.repeat(2000) })

      const [entry] = await service.list()
      expect(entry.detail.length).toBeLessThan(600)
      expect(entry.detail.endsWith('…')).toBe(true)
    })

    it('ignores a call with no event type', async () => {
      await service.record(null, { accountId: 'acct-1' })
      expect(mockClient.lpush).not.toHaveBeenCalled()
    })

    it('normalizes empty fields to null rather than empty strings', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: '  ', model: undefined })

      const [entry] = await service.list()
      expect(entry.accountId).toBeNull()
      expect(entry.model).toBeNull()
    })
  })

  describe('list', () => {
    it('returns the newest entry first', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'first' })
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'second' })

      const entries = await service.list()
      expect(entries.map((e) => e.accountId)).toEqual(['second', 'first'])
    })

    it('skips a corrupted record instead of failing the whole read', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'good' })
      store.list.push('{not json')

      const entries = await service.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].accountId).toBe('good')
    })

    it('clamps an absurd limit to the cap', async () => {
      await service.list({ limit: 999999 })
      expect(mockClient.lrange).toHaveBeenCalledWith(
        service.DIAGNOSTIC_LOG_KEY,
        0,
        service.MAX_ENTRIES - 1
      )
    })
  })

  describe('clear', () => {
    it('drops every stored entry', async () => {
      await service.record(service.EVENT_TYPES.STREAM_ERROR, { accountId: 'acct-1' })
      await service.clear()

      expect(await service.list()).toEqual([])
    })
  })
})
