jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 }, redis: {} }), {
  virtual: true
})

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

const redis = require('../src/models/redis')

describe('Redis service window operations', () => {
  let originalClient

  beforeEach(() => {
    originalClient = redis.client
  })

  afterEach(() => {
    redis.client = originalClient
    jest.restoreAllMocks()
  })

  it('uses one Lua evaluation to check and increment the request window', async () => {
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now)
    const evalMock = jest.fn(async () => [
      1,
      '',
      String(now),
      '1',
      '0',
      `rate_limit:requests:key-1:ccr:${now}`,
      `rate_limit:cost:key-1:ccr:${now}`
    ])
    redis.client = { eval: evalMock }

    const result = await redis.checkAndIncrementServiceWindow('key-1', 'ccr', 5, 2, 3)

    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        currentRequests: 1,
        currentCost: 0,
        resetAt: new Date(now + 5 * 60 * 1000)
      })
    )
    expect(evalMock).toHaveBeenCalledTimes(1)
    const [script, keyCount, ...args] = evalMock.mock.calls[0]
    expect(script).toContain("redis.call('INCR', requestCountKey)")
    expect(keyCount).toBe(3)
    expect(args.slice(0, 3)).toEqual([
      'rate_limit:window_start:key-1:ccr',
      'rate_limit:requests:key-1:ccr',
      'rate_limit:cost:key-1:ccr'
    ])
  })

  it('parses a rejected request window without issuing a second command', async () => {
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now)
    const evalMock = jest.fn(async () => [
      0,
      'requests',
      String(now),
      '2',
      '1.5',
      `rate_limit:requests:key-1:claude:${now}`,
      `rate_limit:cost:key-1:claude:${now}`
    ])
    redis.client = { eval: evalMock }

    const result = await redis.checkAndIncrementServiceWindow('key-1', 'claude', 5, 2, 0)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('requests')
    expect(result.currentRequests).toBe(2)
    expect(result.currentCost).toBe(1.5)
    expect(evalMock).toHaveBeenCalledTimes(1)
  })

  it('only increments window cost when an active window exists', async () => {
    const evalMock = jest.fn(async () => '2.5')
    redis.client = { eval: evalMock }

    const windowStart = 1774800000000
    await redis.incrementServiceWindowCost('key-1', 'azure', windowStart, 2.5)

    const [script, keyCount, key, amount] = evalMock.mock.calls[0]
    expect(script).toContain("redis.call('EXISTS', KEYS[1])")
    expect(keyCount).toBe(1)
    expect(key).toBe(`rate_limit:cost:key-1:azure:${windowStart}`)
    expect(amount).toBe(2.5)
  })
})
