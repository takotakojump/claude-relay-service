const {
  classifyCodexUpstreamError,
  isQuotaExhausted,
  CODEX_AVAILABILITY_STATES
} = require('../src/utils/codexErrorClassifier')

describe('classifyCodexUpstreamError', () => {
  it('treats a capacity message as overload, not exhausted quota', () => {
    const result = classifyCodexUpstreamError(400, {
      error: { message: 'Selected model is at capacity. Please try a different model.' }
    })

    expect(result.state).toBe(CODEX_AVAILABILITY_STATES.SERVER_OVERLOADED)
    expect(isQuotaExhausted(result.state)).toBe(false)
    expect(result.detail).toContain('at capacity')
  })

  it('still reports overload when the capacity error arrives on a 429', () => {
    // This is the case that would otherwise burn a cooldown on a transient capacity blip.
    const result = classifyCodexUpstreamError(429, {
      error: { message: 'Selected model is at capacity. Please try a different model.' }
    })

    expect(result.state).toBe(CODEX_AVAILABILITY_STATES.SERVER_OVERLOADED)
    expect(isQuotaExhausted(result.state)).toBe(false)
  })

  it('classifies a real usage limit as exhausted quota', () => {
    const result = classifyCodexUpstreamError(429, {
      error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' }
    })

    expect(result.state).toBe(CODEX_AVAILABILITY_STATES.QUOTA_EXHAUSTED)
    expect(isQuotaExhausted(result.state)).toBe(true)
  })

  it('classifies a bare 429 with no body as exhausted quota', () => {
    expect(classifyCodexUpstreamError(429, null).state).toBe(
      CODEX_AVAILABILITY_STATES.QUOTA_EXHAUSTED
    )
  })

  it('classifies missing or unpermitted models', () => {
    expect(
      classifyCodexUpstreamError(404, {
        error: { code: 'model_not_found', message: 'The model does not exist' }
      }).state
    ).toBe(CODEX_AVAILABILITY_STATES.MODEL_NOT_AVAILABLE)

    expect(
      classifyCodexUpstreamError(403, {
        error: { message: 'You do not have access to this model' }
      }).state
    ).toBe(CODEX_AVAILABILITY_STATES.MODEL_NOT_AVAILABLE)
  })

  it('classifies client identity rejections', () => {
    expect(
      classifyCodexUpstreamError(403, {
        error: { message: 'Unsupported client version, please update' }
      }).state
    ).toBe(CODEX_AVAILABILITY_STATES.CLIENT_IDENTITY_REJECTED)

    expect(classifyCodexUpstreamError(426, { error: { message: 'Upgrade required' } }).state).toBe(
      CODEX_AVAILABILITY_STATES.CLIENT_IDENTITY_REJECTED
    )
  })

  it('falls back to unknown for unrecognised failures', () => {
    expect(classifyCodexUpstreamError(500, { error: { message: 'internal error' } }).state).toBe(
      CODEX_AVAILABILITY_STATES.UNKNOWN_UPSTREAM_ERROR
    )
    expect(classifyCodexUpstreamError(502, null).state).toBe(
      CODEX_AVAILABILITY_STATES.UNKNOWN_UPSTREAM_ERROR
    )
  })

  it('reports ok for successful statuses', () => {
    expect(classifyCodexUpstreamError(200, null).state).toBe(CODEX_AVAILABILITY_STATES.OK)
    expect(classifyCodexUpstreamError(201, { anything: true }).state).toBe(
      CODEX_AVAILABILITY_STATES.OK
    )
  })

  it('parses JSON string and raw text bodies', () => {
    expect(
      classifyCodexUpstreamError(
        400,
        JSON.stringify({ error: { message: 'Selected model is at capacity.' } })
      ).state
    ).toBe(CODEX_AVAILABILITY_STATES.SERVER_OVERLOADED)

    expect(classifyCodexUpstreamError(503, 'upstream is overloaded').state).toBe(
      CODEX_AVAILABILITY_STATES.SERVER_OVERLOADED
    )
  })

  it('truncates long details instead of storing whole bodies', () => {
    const long = `at capacity ${'x'.repeat(500)}`
    const result = classifyCodexUpstreamError(400, { error: { message: long } })

    expect(result.detail.length).toBeLessThanOrEqual(301)
    expect(result.detail.endsWith('…')).toBe(true)
  })
})
