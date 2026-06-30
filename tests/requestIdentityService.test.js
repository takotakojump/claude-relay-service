jest.mock('../config/config', () => ({ system: { timezoneOffset: 8 } }), { virtual: true })

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({
    set: jest.fn()
  }))
}))

const requestIdentityService = require('../src/services/requestIdentityService')

const { rewriteUserId, formatUuidFromSeed, extractAccountUuid } = requestIdentityService._internal

const DEVICE_A = 'a'.repeat(64)
const DEVICE_B = 'b'.repeat(64)
const UNIFIED_DEVICE = 'c'.repeat(64)
const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_UUID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

function makeJsonUserId(deviceId = DEVICE_A, accountUuid = '', sessionId = SESSION_A) {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId
  })
}

function makeBody(deviceId = DEVICE_A, sessionId = SESSION_A) {
  return {
    metadata: {
      user_id: makeJsonUserId(deviceId, '', sessionId)
    }
  }
}

function parseUserId(result) {
  return JSON.parse(result.nextBody.metadata.user_id)
}

function makeAccount(id, overrides = {}) {
  return {
    id,
    useUnifiedClientId: 'true',
    unifiedClientId: UNIFIED_DEVICE,
    extInfo: JSON.stringify({ account_uuid: ACCOUNT_UUID }),
    ...overrides
  }
}

describe('requestIdentityService client id rewrite strategy', () => {
  const originalMode = process.env.CLIENT_ID_REWRITE_MODE
  const originalGenerate = process.env.CLIENT_ID_GENERATE_WHEN_MISSING

  beforeEach(() => {
    process.env.CLIENT_ID_REWRITE_MODE = 'unified_per_account'
    process.env.CLIENT_ID_GENERATE_WHEN_MISSING = 'true'
  })

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.CLIENT_ID_REWRITE_MODE
    } else {
      process.env.CLIENT_ID_REWRITE_MODE = originalMode
    }

    if (originalGenerate === undefined) {
      delete process.env.CLIENT_ID_GENERATE_WHEN_MISSING
    } else {
      process.env.CLIENT_ID_GENERATE_WHEN_MISSING = originalGenerate
    }
  })

  it('uses one stable device_id for different downstream clients on the same Claude account', () => {
    const account = makeAccount('claude-account-1')
    const accountUuid = extractAccountUuid(account)

    const first = rewriteUserId(makeBody(DEVICE_A, SESSION_A), 'claude-account-1', accountUuid, {
      account
    })
    const second = rewriteUserId(makeBody(DEVICE_B, SESSION_B), 'claude-account-1', accountUuid, {
      account
    })

    const firstUserId = parseUserId(first)
    const secondUserId = parseUserId(second)

    expect(firstUserId.device_id).toBe(secondUserId.device_id)
    expect(firstUserId.device_id).not.toBe(DEVICE_A)
    expect(secondUserId.device_id).not.toBe(DEVICE_B)
    expect(firstUserId.account_uuid).toBe(ACCOUNT_UUID)
    expect(secondUserId.account_uuid).toBe(ACCOUNT_UUID)
  })

  it('does not share generated device_id across different Claude accounts', () => {
    const accountA = makeAccount('claude-account-1')
    const accountB = makeAccount('claude-account-2')

    const first = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(accountA),
      {
        account: accountA
      }
    )
    const second = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-2',
      extractAccountUuid(accountB),
      {
        account: accountB
      }
    )

    expect(parseUserId(first).device_id).not.toBe(parseUserId(second).device_id)
  })

  it('preserve mode keeps original device_id while still normalizing session/account_uuid', () => {
    process.env.CLIENT_ID_REWRITE_MODE = 'preserve'
    const account = makeAccount('claude-account-1')

    const result = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )
    const userId = parseUserId(result)

    expect(userId.device_id).toBe(DEVICE_A)
    expect(userId.account_uuid).toBe(ACCOUNT_UUID)
    expect(userId.session_id).toBe(formatUuidFromSeed(`claude-account-1::${SESSION_A}`))
  })

  it('legacy_global mode keeps the old direct unifiedClientId replacement behavior', () => {
    process.env.CLIENT_ID_REWRITE_MODE = 'legacy_global'
    const account = makeAccount('claude-account-1')

    const result = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )

    expect(parseUserId(result).device_id).toBe(UNIFIED_DEVICE)
  })

  it('unified_per_api_key isolates device_id by API Key when explicitly enabled', () => {
    process.env.CLIENT_ID_REWRITE_MODE = 'unified_per_api_key'
    const account = makeAccount('claude-account-1')
    const accountUuid = extractAccountUuid(account)

    const first = rewriteUserId(makeBody(DEVICE_A), 'claude-account-1', accountUuid, {
      account,
      apiKeyData: { id: 'api-key-1' }
    })
    const second = rewriteUserId(makeBody(DEVICE_B), 'claude-account-1', accountUuid, {
      account,
      apiKeyData: { id: 'api-key-2' }
    })
    const third = rewriteUserId(makeBody(DEVICE_B), 'claude-account-1', accountUuid, {
      account,
      apiKeyData: { id: 'api-key-1' }
    })

    expect(parseUserId(first).device_id).not.toBe(parseUserId(second).device_id)
    expect(parseUserId(first).device_id).toBe(parseUserId(third).device_id)
  })

  it('generates a stable account-scoped device_id when unifiedClientId is missing', () => {
    const account = makeAccount('claude-account-1', { unifiedClientId: '' })

    const first = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )
    const second = rewriteUserId(
      makeBody(DEVICE_B),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )

    expect(parseUserId(first).device_id).toBe(parseUserId(second).device_id)
    expect(parseUserId(first).device_id).not.toBe(DEVICE_A)
  })

  it('preserves original device_id when generated ids are disabled and unifiedClientId is missing', () => {
    process.env.CLIENT_ID_GENERATE_WHEN_MISSING = 'false'
    const account = makeAccount('claude-account-1', { unifiedClientId: '' })

    const result = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )

    expect(parseUserId(result).device_id).toBe(DEVICE_A)
  })

  it('does not rewrite device_id when account useUnifiedClientId is disabled', () => {
    const account = makeAccount('claude-account-1', { useUnifiedClientId: 'false' })

    const result = rewriteUserId(
      makeBody(DEVICE_A),
      'claude-account-1',
      extractAccountUuid(account),
      {
        account
      }
    )

    expect(parseUserId(result).device_id).toBe(DEVICE_A)
  })
})
