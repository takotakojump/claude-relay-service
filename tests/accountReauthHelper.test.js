const {
  IDENTITY_MISMATCH_CODE,
  AccountIdentityMismatchError,
  compareAccountIdentity,
  assertAccountIdentity,
  shouldRecoverAfterCredentialUpdate
} = require('../src/utils/accountReauthHelper')

describe('accountReauthHelper', () => {
  describe('compareAccountIdentity', () => {
    it('matches when every comparable field is equal (emails case-insensitively)', () => {
      const result = compareAccountIdentity([
        { field: 'userId', previous: 'user-1', next: 'user-1' },
        { field: 'email', type: 'email', previous: 'Alice@Example.com', next: 'alice@example.com' }
      ])

      expect(result.status).toBe('match')
      expect(result.compared).toEqual(['userId', 'email'])
      expect(result.mismatches).toEqual([])
    })

    it('reports masked values for mismatched fields', () => {
      const result = compareAccountIdentity([
        { field: 'email', type: 'email', previous: 'alice@example.com', next: 'bob@example.com' },
        {
          field: 'accountUuid',
          previous: '11111111-2222-3333-4444-555555555555',
          next: '99999999-2222-3333-4444-555555555555'
        }
      ])

      expect(result.status).toBe('mismatch')
      expect(result.mismatches).toEqual([
        { field: 'email', previous: 'al***@example.com', next: 'bo***@example.com' },
        { field: 'accountUuid', previous: '111111...5555', next: '999999...5555' }
      ])
    })

    it('skips fields that are missing on either side', () => {
      const result = compareAccountIdentity([
        { field: 'userId', previous: '', next: 'user-2' },
        { field: 'email', type: 'email', previous: 'alice@example.com', next: null }
      ])

      expect(result.status).toBe('unverifiable')
      expect(result.compared).toEqual([])
    })
  })

  describe('assertAccountIdentity', () => {
    it('throws a typed error on mismatch unless forced', () => {
      const mismatch = compareAccountIdentity([{ field: 'userId', previous: 'a1', next: 'b2' }])

      expect(() => assertAccountIdentity(mismatch)).toThrow(AccountIdentityMismatchError)
      try {
        assertAccountIdentity(mismatch)
      } catch (error) {
        expect(error.code).toBe(IDENTITY_MISMATCH_CODE)
        expect(error.mismatches).toHaveLength(1)
      }

      expect(assertAccountIdentity(mismatch, { force: true })).toBe('forced')
    })

    it('passes through match and unverifiable results', () => {
      expect(assertAccountIdentity({ status: 'match' })).toBe('match')
      expect(assertAccountIdentity({ status: 'unverifiable' })).toBe('unverifiable')
    })
  })

  describe('shouldRecoverAfterCredentialUpdate', () => {
    const fields = ['claudeAiOauth', 'refreshToken']

    it('recovers broken accounts when new credentials are written', () => {
      expect(
        shouldRecoverAfterCredentialUpdate('unauthorized', { refreshToken: 'new' }, fields)
      ).toBe(true)
      expect(
        shouldRecoverAfterCredentialUpdate(
          'error',
          { claudeAiOauth: { accessToken: 'at', refreshToken: '' } },
          fields
        )
      ).toBe(true)
    })

    it('ignores healthy accounts and updates without credentials', () => {
      expect(shouldRecoverAfterCredentialUpdate('active', { refreshToken: 'new' }, fields)).toBe(
        false
      )
      expect(shouldRecoverAfterCredentialUpdate('unauthorized', { name: 'renamed' }, fields)).toBe(
        false
      )
      expect(
        shouldRecoverAfterCredentialUpdate(
          'unauthorized',
          { claudeAiOauth: { accessToken: '', refreshToken: '  ' } },
          fields
        )
      ).toBe(false)
    })
  })
})
