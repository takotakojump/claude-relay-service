const { validateServiceLimits } = require('../src/utils/serviceLimitConfig')

describe('validateServiceLimits', () => {
  it('accepts independent daily and weekly limits', () => {
    expect(
      validateServiceLimits({
        claude: { dailyCostLimit: 10 },
        ccr: { weeklyCostLimit: 50 }
      })
    ).toBeNull()
  })

  it('accepts a complete request or cost window', () => {
    expect(
      validateServiceLimits({
        codex: { windowMinutes: 5, windowRequests: 10, windowCost: 2.5 }
      })
    ).toBeNull()
  })

  it('rejects a window limit without windowMinutes', () => {
    expect(validateServiceLimits({ codex: { windowCost: 10 } })).toMatch(/windowMinutes/)
  })

  it('rejects windowMinutes without a request or cost limit', () => {
    expect(validateServiceLimits({ codex: { windowMinutes: 5 } })).toMatch(/windowRequests/)
  })

  it('rejects unsupported services and fields', () => {
    expect(validateServiceLimits({ unknown: { dailyCostLimit: 1 } })).toMatch(/Unsupported service/)
    expect(validateServiceLimits({ claude: { tokenLimit: 1 } })).toMatch(/Unsupported limit field/)
  })

  it('accepts an empty object to clear all limits', () => {
    expect(validateServiceLimits({})).toBeNull()
  })
})
