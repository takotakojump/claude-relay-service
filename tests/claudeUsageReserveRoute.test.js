const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({ authenticateAdmin: (req, res, next) => next() }))
jest.mock('../src/services/account/claudeAccountService', () => ({
  buildClaudeUsageSnapshot: jest.fn(),
  fetchOAuthUsage: jest.fn(),
  updateClaudeUsageSnapshot: jest.fn(),
  clearClaudeUsageSnapshot: jest.fn(),
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/accountUsageReserveService', () => ({
  getState: jest.fn(),
  setTemporaryScheduling: jest.fn()
}))
jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/accountTestSchedulerService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getAllClaudeAccounts: jest.fn(),
  getClaudeAccount: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/utils/oauthHelper', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: (account) => account,
  mapExpiryField: (updates) => updates
}))

const redis = require('../src/models/redis')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const accountUsageReserveService = require('../src/services/accountUsageReserveService')
const claudeAccountsRouter = require('../src/routes/admin/claudeAccounts')

test('the Claude usage response includes reserve state from the refreshed snapshot', async () => {
  const before = { id: 'oauth-1', isActive: 'true', status: 'active', accessToken: 'token' }
  const after = { ...before, claudeFiveHourUtilization: '98' }
  redis.getAllClaudeAccounts.mockResolvedValue([before])
  redis.getClaudeAccount.mockResolvedValue(after)
  claudeAccountService.buildClaudeUsageSnapshot.mockImplementation((account) => ({
    utilization: account.claudeFiveHourUtilization || null
  }))
  claudeAccountService.fetchOAuthUsage.mockResolvedValue({ five_hour: { utilization: 0.98 } })
  claudeAccountService.updateClaudeUsageSnapshot.mockResolvedValue()
  accountUsageReserveService.getState.mockImplementation(async (account) => ({
    paused: account.claudeFiveHourUtilization === '98'
  }))

  const app = express()
  app.use('/admin', claudeAccountsRouter)
  const response = await request(app).get('/admin/claude-accounts/usage')

  expect(response.status).toBe(200)
  expect(response.body.data['oauth-1']).toEqual({ utilization: '98' })
  expect(response.body.usageReserve['oauth-1']).toEqual({ paused: true })
  expect(accountUsageReserveService.getState).toHaveBeenCalledWith(after, 'claude-official')
})

test('the account reserve endpoint returns the current scheduling state', async () => {
  const account = { id: 'oauth-2', claudeFiveHourUtilization: '98' }
  redis.getClaudeAccount.mockResolvedValue(account)
  accountUsageReserveService.getState.mockResolvedValue({ paused: true, version: 'v2' })

  const app = express()
  app.use('/admin', claudeAccountsRouter)
  const response = await request(app).get('/admin/claude-accounts/oauth-2/usage-reserve')

  expect(response.status).toBe(200)
  expect(response.body.usageReserve).toEqual({ paused: true, version: 'v2' })
  expect(accountUsageReserveService.getState).toHaveBeenCalledWith(account, 'claude-official')
})

test('a stale request to enable temporary scheduling returns the current state', async () => {
  claudeAccountService.getAllAccounts.mockResolvedValue([{ id: 'oauth-3' }])
  accountUsageReserveService.setTemporaryScheduling.mockRejectedValue(
    Object.assign(new Error('窗口已变化'), {
      code: 'USAGE_RESERVE_STATE_CHANGED',
      state: { paused: true, version: 'new-version' }
    })
  )

  const app = express()
  app.use(express.json())
  app.use('/admin', claudeAccountsRouter)
  const response = await request(app)
    .put('/admin/claude-accounts/oauth-3/toggle-usage-reserve')
    .send({ temporaryScheduling: true, expectedVersion: 'old-version' })

  expect(response.status).toBe(409)
  expect(response.body.usageReserve).toEqual({ paused: true, version: 'new-version' })
})
