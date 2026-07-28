// Verifies that recordServiceCost accumulates per-family daily/weekly cost only when
// the key has serviceLimits configured, regardless of which upstream handled the request.

jest.mock('../config/config', () => ({ security: { apiKeyPrefix: 'cr_' } }), { virtual: true })

const mockIncrementServiceDailyCost = jest.fn(async () => {})
const mockIncrementServiceWeeklyCost = jest.fn(async () => {})
const mockIncrementServiceWindowCost = jest.fn(async () => {})
const mockGetApiKey = jest.fn(async () => ({}))

jest.mock('../src/models/redis', () => ({
  incrementServiceDailyCost: mockIncrementServiceDailyCost,
  incrementServiceWeeklyCost: mockIncrementServiceWeeklyCost,
  incrementServiceWindowCost: mockIncrementServiceWindowCost,
  getApiKey: mockGetApiKey
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

jest.mock('../src/services/requestDetailService', () => ({
  captureRequestDetail: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')

beforeEach(() => {
  jest.clearAllMocks()
})

describe('recordServiceCost', () => {
  it('accumulates daily and weekly per-service cost when serviceLimits is configured', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ claude: { dailyCostLimit: 10 } }),
      weeklyResetDay: '3',
      weeklyResetHour: '5'
    })

    await apiKeyService.recordServiceCost('key-1', 1.25, 1.0, 'claude-opus-4-8')

    expect(mockIncrementServiceDailyCost).toHaveBeenCalledWith('key-1', 'claude', 1.25)
    expect(mockIncrementServiceWeeklyCost).toHaveBeenCalledWith('key-1', 'claude', 1.25, 1.0, 3, 5)
  })

  it('classifies the service by model (gpt -> codex)', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ codex: { dailyCostLimit: 10 } })
    })

    await apiKeyService.recordServiceCost('key-1', 2, 2, 'gpt-5')

    expect(mockIncrementServiceDailyCost).toHaveBeenCalledWith('key-1', 'codex', 2)
  })

  it('classifies embedding models as Codex instead of Claude', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ codex: { dailyCostLimit: 10 } })
    })

    await apiKeyService.recordServiceCost('key-1', 2, 2, 'text-embedding-3-small')

    expect(mockIncrementServiceDailyCost).toHaveBeenCalledWith('key-1', 'codex', 2)
  })

  it('does not move Claude usage into the CCR bucket when CCR handled the request', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ claude: { dailyCostLimit: 10 } })
    })

    await apiKeyService.recordServiceCost('key-1', 2, 2, 'claude-opus-4-8', 'ccr')

    expect(mockIncrementServiceDailyCost).toHaveBeenCalledWith('key-1', 'claude', 2)
  })

  it('increments the active service window cost when configured', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ codex: { windowMinutes: 5, windowCost: 10 } })
    })

    const requestMeta = {
      serviceLimitReservations: { codex: { windowStart: 1774800000000 } }
    }
    await apiKeyService.recordServiceCost('key-1', 2, 2, 'gpt-5', 'azure-openai', requestMeta)

    expect(mockIncrementServiceWindowCost).toHaveBeenCalledWith('key-1', 'codex', 1774800000000, 2)
  })

  it('does not put a late cost into a different window without a reservation', async () => {
    mockGetApiKey.mockResolvedValue({
      serviceLimits: JSON.stringify({ codex: { windowMinutes: 5, windowCost: 10 } })
    })

    await apiKeyService.recordServiceCost('key-1', 2, 2, 'gpt-5')

    expect(mockIncrementServiceWindowCost).not.toHaveBeenCalled()
  })

  it('skips all Redis writes when the key has no serviceLimits', async () => {
    mockGetApiKey.mockResolvedValue({ serviceLimits: '{}' })

    await apiKeyService.recordServiceCost('key-1', 5, 5, 'claude-opus-4-8')

    expect(mockIncrementServiceDailyCost).not.toHaveBeenCalled()
    expect(mockIncrementServiceWeeklyCost).not.toHaveBeenCalled()
  })

  it('skips when cost is zero', async () => {
    await apiKeyService.recordServiceCost('key-1', 0, 0, 'claude-opus-4-8')

    expect(mockGetApiKey).not.toHaveBeenCalled()
    expect(mockIncrementServiceDailyCost).not.toHaveBeenCalled()
  })
})
