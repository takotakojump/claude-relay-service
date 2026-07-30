// Regression test: temp-unavailable is a *transient* cooldown. A weekly-scale
// upstream retry-after (observed: 443300s ≈ 5.1 days) must never sideline an account
// for days — that key is a separate TTL'd Redis key and the account hash looks clean,
// which made it nearly impossible to diagnose in production.

const mockSetex = jest.fn(async () => 'OK')
const mockDel = jest.fn(async () => 1)
const mockHgetall = jest.fn(async () => ({}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: () => ({
    setex: mockSetex,
    del: mockDel,
    hgetall: mockHgetall,
    zadd: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    zremrangebyrank: jest.fn(async () => 1)
  })
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
// config/config.js 被 .gitignore 忽略，干净 checkout 上并不存在，必须用 virtual mock
jest.mock('../config/config', () => ({ upstreamError: {} }), { virtual: true })

const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

const ACCOUNT = 'acct-1'
const TYPE = 'claude-official'
const ttlPassedToSetex = () => mockSetex.mock.calls[0][1]

describe('markTempUnavailable clamps upstream retry-after', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('clamps a weekly-scale retry-after (5.1 days) to the 30 minute cap', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 443300)
    expect(mockSetex).toHaveBeenCalledTimes(1)
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('clamps the other observed value (4.2 days) too', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('leaves a short, sane retry-after untouched', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 600)
    expect(ttlPassedToSetex()).toBe(600)
  })

  it('falls back to the per-error-type default when no retry-after is given', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, null)
    expect(ttlPassedToSetex()).toBe(300) // DEFAULT_TTL.rate_limit
  })
})
