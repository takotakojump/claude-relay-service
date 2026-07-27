function getClaudeAccountScopes(accountData) {
  if (Array.isArray(accountData?.scopes)) {
    return accountData.scopes.filter(Boolean)
  }

  return String(accountData?.scopes || '')
    .split(/\s+/)
    .filter(Boolean)
}

function isClaudeOAuthAccount(accountData) {
  const scopes = getClaudeAccountScopes(accountData)

  // Legacy OAuth records can lack persisted scopes, but still have a refresh token.
  return (
    (scopes.includes('user:profile') && scopes.includes('user:inference')) ||
    Boolean(accountData?.refreshToken)
  )
}

module.exports = {
  getClaudeAccountScopes,
  isClaudeOAuthAccount
}
