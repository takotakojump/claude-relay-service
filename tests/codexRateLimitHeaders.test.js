const {
  parseCodexRateLimitHeaders,
  normalizeLimitId,
  resolveResetAt
} = require('../src/utils/codexRateLimitHeaders')

const NOW = Date.parse('2026-08-05T00:00:00.000Z')

describe('parseCodexRateLimitHeaders', () => {
  it('returns null when the response carries no quota headers', () => {
    expect(parseCodexRateLimitHeaders({})).toBeNull()
    expect(parseCodexRateLimitHeaders(null)).toBeNull()
    expect(parseCodexRateLimitHeaders({ 'content-type': 'application/json' })).toBeNull()
  })

  it('parses the default codex bucket with both windows', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'x-codex-primary-used-percent': '12.5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '600',
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-after-seconds': '86400',
        'x-codex-primary-over-secondary-limit-percent': '31'
      },
      { now: NOW }
    )

    expect(result.limits).toHaveLength(1)
    const codex = result.limits[0]
    expect(codex.limitId).toBe('codex')
    expect(codex.primary).toEqual({
      usedPercent: 12.5,
      windowMinutes: 300,
      resetAt: '2026-08-05T00:10:00.000Z'
    })
    expect(codex.secondary).toEqual({
      usedPercent: 40,
      windowMinutes: 10080,
      resetAt: '2026-08-06T00:00:00.000Z'
    })
    expect(codex.primaryOverSecondaryPercent).toBe(31)
  })

  it('leaves secondary null when upstream only reports one window', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-after-seconds': '424800'
      },
      { now: NOW }
    )

    expect(result.limits).toHaveLength(1)
    expect(result.limits[0].secondary).toBeNull()
    // A weekly window sitting in the primary slot must survive as windowMinutes=10080 so the
    // display layer can label it correctly instead of assuming primary means 5h.
    expect(result.limits[0].primary.windowMinutes).toBe(10080)
  })

  it('discovers additional per-model buckets alongside the default one', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-sol-primary-used-percent': '100',
        'x-codex-sol-primary-window-minutes': '10080',
        'x-codex-sol-limit-name': 'GPT-5.6 Sol'
      },
      { now: NOW }
    )

    const ids = result.limits.map((limit) => limit.limitId)
    expect(ids).toEqual(expect.arrayContaining(['codex', 'codex_sol']))
    expect(ids).toHaveLength(2)

    const sol = result.limits.find((limit) => limit.limitId === 'codex_sol')
    expect(sol.limitName).toBe('GPT-5.6 Sol')
    expect(sol.primary.usedPercent).toBe(100)
  })

  it('prefers absolute reset-at over the legacy relative header', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-reset-at': '1786000000',
        'x-codex-primary-reset-after-seconds': '60'
      },
      { now: NOW }
    )

    expect(result.limits[0].primary.resetAt).toBe(new Date(1786000000 * 1000).toISOString())
  })

  it('accepts an ISO reset-at value', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-reset-at': '2026-08-09T21:00:00.000Z'
      },
      { now: NOW }
    )

    expect(result.limits[0].primary.resetAt).toBe('2026-08-09T21:00:00.000Z')
  })

  it('is case insensitive and tolerates array header values', () => {
    const result = parseCodexRateLimitHeaders(
      {
        'X-Codex-Primary-Used-Percent': ['7'],
        'X-CODEX-PRIMARY-WINDOW-MINUTES': '300'
      },
      { now: NOW }
    )

    expect(result.limits[0].primary.usedPercent).toBe(7)
    expect(result.limits[0].primary.windowMinutes).toBe(300)
  })

  it('ignores the over-secondary header on its own without a used-percent anchor', () => {
    const result = parseCodexRateLimitHeaders(
      { 'x-codex-primary-over-secondary-limit-percent': '31' },
      { now: NOW }
    )

    expect(result).toBeNull()
  })
})

describe('normalizeLimitId', () => {
  it('collapses separators so header spelling does not fork the id', () => {
    expect(normalizeLimitId('codex')).toBe('codex')
    expect(normalizeLimitId('codex-sol')).toBe('codex_sol')
    expect(normalizeLimitId('codex_sol')).toBe('codex_sol')
    expect(normalizeLimitId('GPT-5.6-Sol')).toBe('gpt_5_6_sol')
  })

  it('returns null for unusable input', () => {
    expect(normalizeLimitId('')).toBeNull()
    expect(normalizeLimitId('---')).toBeNull()
    expect(normalizeLimitId(null)).toBeNull()
  })
})

describe('resolveResetAt', () => {
  it('treats large numbers as epoch milliseconds', () => {
    expect(resolveResetAt('1786000000000', null, NOW)).toBe(new Date(1786000000000).toISOString())
  })

  it('converts relative seconds against the capture time', () => {
    expect(resolveResetAt(null, '3600', NOW)).toBe('2026-08-05T01:00:00.000Z')
  })

  it('returns null when neither form is usable', () => {
    expect(resolveResetAt(null, null, NOW)).toBeNull()
    expect(resolveResetAt('not-a-date', null, NOW)).toBeNull()
  })
})
