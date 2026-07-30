/**
 * Codex 客户端身份 API 路由
 * 查看观测到的客户端身份，并把其中一条应用为出站固定值
 */

const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const codexClientIdentityService = require('../../services/codexClientIdentityService')
const logger = require('../../utils/logger')

const router = express.Router()

/**
 * GET /admin/codex-client-identity
 * 返回当前生效的固定身份和观测列表
 */
router.get('/codex-client-identity', authenticateAdmin, async (req, res) => {
  try {
    const [applied, observed] = await Promise.all([
      codexClientIdentityService.getApplied(),
      codexClientIdentityService.listObserved()
    ])

    return res.json({
      success: true,
      applied,
      observed
    })
  } catch (error) {
    logger.error('❌ Failed to get Codex client identity:', error)
    return res.status(500).json({
      error: 'Failed to get Codex client identity',
      message: error.message
    })
  }
})

/**
 * POST /admin/codex-client-identity/apply
 * 应用指定的一条身份为固定值。必须显式指定，不提供「自动取最新」的快捷方式 ——
 * 偶发的异常版本不该在无人确认的情况下变成全局出站身份。
 */
router.post('/codex-client-identity/apply', authenticateAdmin, async (req, res) => {
  try {
    const appliedBy = req.admin?.username || 'unknown'
    const { originator, userAgent } = req.body || {}

    if (!originator || !userAgent) {
      return res.status(400).json({
        error: 'originator and userAgent are required'
      })
    }

    const applied = await codexClientIdentityService.apply({ originator, userAgent }, appliedBy)
    return res.json({ success: true, applied })
  } catch (error) {
    logger.error('❌ Failed to apply Codex client identity:', error)
    return res.status(400).json({
      error: 'Failed to apply Codex client identity',
      message: error.message
    })
  }
})

module.exports = router
