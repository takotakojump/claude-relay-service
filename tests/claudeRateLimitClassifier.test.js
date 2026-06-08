const {
  classifyClaude429,
  computeHeaderlessCooldownSeconds,
  getHeader
} = require('../src/utils/claudeRateLimitClassifier')

const RESET_TS = 1780000000 // 固定 Unix 秒，便于断言

describe('claudeRateLimitClassifier', () => {
  describe('classifyClaude429()', () => {
    it('headerless 429（无任何 quota header）→ short_cooldown', () => {
      const result = classifyClaude429({ statusCode: 429, headers: {} })
      expect(result.kind).toBe('headerless_429')
      expect(result.action).toBe('short_cooldown')
      expect(result.resetTimestamp).toBeNull()
      expect(result.hasQuotaHeaders).toBe(false)
    })

    it('带 unified-reset + 非 Opus → hard_rate_limit，resetTimestamp 正确', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: { 'anthropic-ratelimit-unified-reset': String(RESET_TS) },
        isOpusModelRequest: false
      })
      expect(result.kind).toBe('quota_limit')
      expect(result.action).toBe('hard_rate_limit')
      expect(result.resetTimestamp).toBe(RESET_TS)
      expect(result.hasQuotaHeaders).toBe(true)
      expect(result.observed.resetSource).toBe('unified-reset')
    })

    it('带 unified-reset + Opus → opus_rate_limit', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: { 'anthropic-ratelimit-unified-reset': String(RESET_TS) },
        isOpusModelRequest: true
      })
      expect(result.kind).toBe('opus_rate_limit')
      expect(result.action).toBe('opus_rate_limit')
      expect(result.resetTimestamp).toBe(RESET_TS)
    })

    it('isExtraUsage=true → skip（不限流）', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: {},
        isExtraUsage: true
      })
      expect(result.kind).toBe('extra_usage_required')
      expect(result.action).toBe('skip')
    })

    it('retry-after=300 + headerless → retryAfterSeconds=300，仍 short_cooldown', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: { 'retry-after': '300' }
      })
      expect(result.retryAfterSeconds).toBe(300)
      expect(result.action).toBe('short_cooldown')
      // retry-after 不是 quota header，不应被算作 hasQuotaHeaders
      expect(result.hasQuotaHeaders).toBe(false)
    })

    it('混合大小写 header 仍能解析', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: { 'Anthropic-RateLimit-Unified-Reset': String(RESET_TS) },
        isOpusModelRequest: false
      })
      expect(result.resetTimestamp).toBe(RESET_TS)
      expect(result.action).toBe('hard_rate_limit')
    })

    it('observe-only：有 representative-claim 但无 reset → 仍 headerless（claim 不驱动判定）', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: {
          'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
          'anthropic-ratelimit-unified-5h-reset': '2026-06-06T00:00:00Z'
        },
        isOpusModelRequest: true
      })
      // claim/5h-reset 只进 observed，不改变 action
      expect(result.action).toBe('short_cooldown')
      expect(result.kind).toBe('headerless_429')
      expect(result.resetTimestamp).toBeNull()
      expect(result.observed.representativeClaim).toBe('seven_day_opus')
      expect(result.observed.resetSource).toBe('5h-reset')
      // 出现 quota header（即便只观测）应反映在 hasQuotaHeaders
      expect(result.hasQuotaHeaders).toBe(true)
    })

    it('observe-only：有 representative-claim 且有 unified-reset → 仍按 reset 走 hard_rate_limit', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: {
          'anthropic-ratelimit-unified-representative-claim': 'seven_day',
          'anthropic-ratelimit-unified-reset': String(RESET_TS)
        },
        isOpusModelRequest: false
      })
      expect(result.action).toBe('hard_rate_limit')
      expect(result.observed.representativeClaim).toBe('seven_day')
    })

    it('非 429 → non_rate_limit_429 / skip', () => {
      const result = classifyClaude429({ statusCode: 500, headers: {} })
      expect(result.kind).toBe('non_rate_limit_429')
      expect(result.action).toBe('skip')
    })

    it('无效 reset（非数字）按 headerless 处理', () => {
      const result = classifyClaude429({
        statusCode: 429,
        headers: { 'anthropic-ratelimit-unified-reset': 'not-a-number' }
      })
      expect(result.resetTimestamp).toBeNull()
      expect(result.action).toBe('short_cooldown')
    })
  })

  describe('computeHeaderlessCooldownSeconds()', () => {
    const tiers = { baseSeconds: 300, factor: 3, maxSeconds: 14400 }

    it('阶梯递增：1→300, 2→900, 3→2700', () => {
      expect(computeHeaderlessCooldownSeconds(1, tiers)).toBe(300)
      expect(computeHeaderlessCooldownSeconds(2, tiers)).toBe(900)
      expect(computeHeaderlessCooldownSeconds(3, tiers)).toBe(2700)
    })

    it('超过上限时截断到 maxSeconds', () => {
      expect(computeHeaderlessCooldownSeconds(10, tiers)).toBe(14400)
    })

    it('非法输入回退到默认值', () => {
      expect(computeHeaderlessCooldownSeconds(0, tiers)).toBe(300)
      expect(computeHeaderlessCooldownSeconds(1, {})).toBe(300)
      expect(computeHeaderlessCooldownSeconds(undefined, {})).toBe(300)
    })
  })

  describe('getHeader()', () => {
    it('大小写不敏感读取', () => {
      expect(getHeader({ 'X-Foo': 'bar' }, 'x-foo')).toBe('bar')
      expect(getHeader({ 'x-foo': 'bar' }, 'X-FOO')).toBe('bar')
    })

    it('缺失或空 headers 返回 null', () => {
      expect(getHeader(null, 'x-foo')).toBeNull()
      expect(getHeader({}, 'x-foo')).toBeNull()
    })
  })
})
