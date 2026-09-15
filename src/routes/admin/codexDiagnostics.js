/**
 * Codex 诊断日志 API 路由
 *
 * 一份临时排查用的独立记录，与服务器日志无关。当前只收 Codex 流内 error 帧
 * —— 那类失败在访问日志里完全不可见（流式是裸管道转发，状态码恒为 200、响应体恒为空）。
 */

const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const codexDiagnosticLogService = require('../../services/codexDiagnosticLogService')
const logger = require('../../utils/logger')

const router = express.Router()

/**
 * GET /admin/codex-diagnostics
 * 返回最近的诊断记录，最新的在前
 */
router.get('/codex-diagnostics', authenticateAdmin, async (req, res) => {
  try {
    const entries = await codexDiagnosticLogService.list({ limit: req.query.limit })

    return res.json({
      success: true,
      entries,
      maxEntries: codexDiagnosticLogService.MAX_ENTRIES,
      retentionSeconds: codexDiagnosticLogService.RETENTION_SECONDS
    })
  } catch (error) {
    logger.error('❌ Failed to list Codex diagnostics:', error)
    return res.status(500).json({
      error: 'Failed to list Codex diagnostics',
      message: error.message
    })
  }
})

/**
 * DELETE /admin/codex-diagnostics
 * 清空记录。这份数据是临时排查用的，允许直接丢弃。
 */
router.delete('/codex-diagnostics', authenticateAdmin, async (req, res) => {
  try {
    await codexDiagnosticLogService.clear()
    logger.info('🧹 Codex diagnostic log cleared')

    return res.json({ success: true })
  } catch (error) {
    logger.error('❌ Failed to clear Codex diagnostics:', error)
    return res.status(500).json({
      error: 'Failed to clear Codex diagnostics',
      message: error.message
    })
  }
})

module.exports = router
