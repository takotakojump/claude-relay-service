const { getClaudeAccountScopes, isClaudeOAuthAccount } = require('../src/utils/claudeAccountAuth')

describe('Claude account authentication detection', () => {
  it('recognizes an OAuth account from its scopes', () => {
    expect(isClaudeOAuthAccount({ scopes: 'user:profile user:inference user:file_upload' })).toBe(
      true
    )
  })

  it('recognizes a legacy OAuth account from its refresh token', () => {
    expect(isClaudeOAuthAccount({ scopes: '', refreshToken: 'encrypted-refresh-token' })).toBe(true)
  })

  it('keeps inference-only Setup Token accounts distinct', () => {
    expect(isClaudeOAuthAccount({ scopes: 'user:inference', refreshToken: '' })).toBe(false)
  })

  it('normalizes array and whitespace-delimited scopes', () => {
    expect(getClaudeAccountScopes({ scopes: ['user:profile', 'user:inference'] })).toEqual([
      'user:profile',
      'user:inference'
    ])
    expect(getClaudeAccountScopes({ scopes: '  user:profile\nuser:inference  ' })).toEqual([
      'user:profile',
      'user:inference'
    ])
  })
})
