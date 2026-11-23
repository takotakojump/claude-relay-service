// Route wiring for in-place re-authorization: every OAuth platform exposes
// POST .../:id/reauthorize, maps identity mismatches to 409, and manual credential
// updates on a broken account trigger a status reset.

const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({ authenticateAdmin: (req, res, next) => next() }))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/utils/oauthHelper', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/utils/workosOAuthHelper', () => ({
  WorkOSDeviceAuthError: class extends Error {}
}))
jest.mock('../src/utils/grokHelper', () => ({}))
jest.mock('../src/utils/testPayloadHelper', () => ({}))
jest.mock('axios', () => ({}))
jest.mock('../src/services/accountUsageReserveService', () => ({}))
jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/accountTestSchedulerService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({
  removeAccountFromAllGroups: jest.fn(),
  setAccountGroups: jest.fn(),
  addAccountToGroup: jest.fn(),
  getAccountGroups: jest.fn(async () => [])
}))

const mockService = () => ({
  reauthorizeAccount: jest.fn(),
  resetAccountStatus: jest.fn(async () => ({ success: true })),
  getAccount: jest.fn(),
  updateAccount: jest.fn(async () => ({ success: true }))
})
jest.mock('../src/services/account/claudeAccountService', () => mockService())
jest.mock('../src/services/account/openaiAccountService', () => mockService())
jest.mock('../src/services/account/geminiAccountService', () => mockService())
jest.mock('../src/services/account/droidAccountService', () => mockService())
jest.mock('../src/services/account/grokAccountService', () => mockService())

const claudeAccountService = require('../src/services/account/claudeAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const geminiAccountService = require('../src/services/account/geminiAccountService')
const droidAccountService = require('../src/services/account/droidAccountService')
const grokAccountService = require('../src/services/account/grokAccountService')
const {
  AccountIdentityMismatchError,
  AccountReauthorizeError
} = require('../src/utils/accountReauthHelper')

// Mount exactly like src/routes/admin/index.js
const buildApp = () => {
  const app = express()
  app.use(express.json())
  const admin = express.Router()
  admin.use('/', require('../src/routes/admin/claudeAccounts'))
  admin.use('/', require('../src/routes/admin/droidAccounts'))
  admin.use('/', require('../src/routes/admin/grokAccounts'))
  admin.use('/gemini-accounts', require('../src/routes/admin/geminiAccounts'))
  admin.use('/openai-accounts', require('../src/routes/admin/openaiAccounts'))
  app.use('/admin', admin)
  return app
}

describe('account re-authorization routes', () => {
  let app

  beforeAll(() => {
    app = buildApp()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['claude', '/admin/claude-accounts/a1/reauthorize', () => claudeAccountService],
    ['openai', '/admin/openai-accounts/a1/reauthorize', () => openaiAccountService],
    ['gemini', '/admin/gemini-accounts/a1/reauthorize', () => geminiAccountService],
    ['droid', '/admin/droid-accounts/a1/reauthorize', () => droidAccountService],
    ['grok', '/admin/grok-accounts/a1/reauthorize', () => grokAccountService]
  ])('%s endpoint delegates to the service', async (_platform, url, getService) => {
    const service = getService()
    service.reauthorizeAccount.mockResolvedValue({ accountId: 'a1', identityCheck: 'match' })

    const res = await request(app)
      .post(url)
      .send({ tokens: { accessToken: 'at' }, force: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { accountId: 'a1', identityCheck: 'match' } })
    expect(service.reauthorizeAccount).toHaveBeenCalledTimes(1)
    expect(service.reauthorizeAccount.mock.calls[0][0]).toBe('a1')
  })

  it('passes force only when it is literally true', async () => {
    claudeAccountService.reauthorizeAccount.mockResolvedValue({ identityCheck: 'match' })

    await request(app)
      .post('/admin/claude-accounts/a1/reauthorize')
      .send({ claudeAiOauth: { accessToken: 'at' }, force: 'true' })

    expect(claudeAccountService.reauthorizeAccount).toHaveBeenCalledWith(
      'a1',
      { accessToken: 'at' },
      { force: false }
    )
  })

  it('maps an identity mismatch to 409 with the mismatched fields', async () => {
    const mismatches = [{ field: 'email', previous: 'al***@a.com', next: 'bo***@b.com' }]
    openaiAccountService.reauthorizeAccount.mockRejectedValue(
      new AccountIdentityMismatchError(mismatches)
    )

    const res = await request(app).post('/admin/openai-accounts/a1/reauthorize').send({})

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      success: false,
      code: 'ACCOUNT_IDENTITY_MISMATCH',
      mismatches
    })
  })

  it('maps validation errors to 400 and unknown accounts to 404', async () => {
    grokAccountService.reauthorizeAccount.mockRejectedValueOnce(
      new AccountReauthorizeError('授权结果缺少 Access Token')
    )
    const invalid = await request(app).post('/admin/grok-accounts/a1/reauthorize').send({})
    expect(invalid.status).toBe(400)
    expect(invalid.body.message).toBe('授权结果缺少 Access Token')

    droidAccountService.reauthorizeAccount.mockRejectedValueOnce(
      new Error('Droid account not found: a1')
    )
    const missing = await request(app).post('/admin/droid-accounts/a1/reauthorize').send({})
    expect(missing.status).toBe(404)
  })

  it('serves Droid reset-status under the droid-accounts prefix the frontend calls', async () => {
    const res = await request(app).post('/admin/droid-accounts/a1/reset-status').send()

    expect(res.status).toBe(200)
    expect(droidAccountService.resetAccountStatus).toHaveBeenCalledWith('a1')
  })

  describe('manual credential update on PUT', () => {
    it('resets a broken Claude account after new tokens are pasted', async () => {
      claudeAccountService.getAccount.mockResolvedValue({ id: 'a1', status: 'unauthorized' })

      const res = await request(app)
        .put('/admin/claude-accounts/a1')
        .send({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', scopes: [] } })

      expect(res.status).toBe(200)
      expect(claudeAccountService.resetAccountStatus).toHaveBeenCalledWith('a1')
    })

    it('leaves a healthy account alone and ignores non-credential edits', async () => {
      claudeAccountService.getAccount.mockResolvedValue({ id: 'a1', status: 'active' })
      await request(app)
        .put('/admin/claude-accounts/a1')
        .send({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', scopes: [] } })

      claudeAccountService.getAccount.mockResolvedValue({ id: 'a1', status: 'unauthorized' })
      await request(app).put('/admin/claude-accounts/a1').send({ name: 'renamed' })

      expect(claudeAccountService.resetAccountStatus).not.toHaveBeenCalled()
    })

    it('resets a broken Grok account after a new refresh token is pasted', async () => {
      grokAccountService.getAccount.mockResolvedValue({ id: 'g1', status: 'error' })

      const res = await request(app).put('/admin/grok-accounts/g1').send({ refreshToken: 'rt' })

      expect(res.status).toBe(200)
      expect(grokAccountService.resetAccountStatus).toHaveBeenCalledWith('g1')
    })
  })
})
