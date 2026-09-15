<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Codex 诊断日志</h3>
        <p class="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
          临时排查用的独立记录，和服务器日志不是一回事。Codex 流式响应是裸管道转发，状态码恒为
          <code class="rounded bg-gray-100 px-1 dark:bg-gray-700">200</code>
          、访问日志的响应体恒为空，所以上游用「200 + 流内 error 帧」下发的失败（例如
          <code class="rounded bg-gray-100 px-1 dark:bg-gray-700"
            >Selected model is at capacity</code
          >
          ）在原有日志里完全看不到。这里专门摘一份出来。
        </p>
      </div>

      <div class="flex shrink-0 gap-2">
        <button
          class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          :disabled="loading"
          @click="load"
        >
          <i class="fas fa-rotate mr-1.5" :class="{ 'fa-spin': loading }" />
          刷新
        </button>
        <button
          class="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
          :disabled="loading || clearing || entries.length === 0"
          @click="clearAll"
        >
          <i class="fas fa-trash-can mr-1.5" />
          清空
        </button>
      </div>
    </div>

    <div
      class="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"
    >
      <i class="fas fa-circle-info mr-1.5" />
      最多保留 {{ maxEntries }} 条，超出后丢弃最旧的；{{ retentionDays }} 天后自动过期。 当前只记录
      Codex 流内 error 帧。
    </div>

    <div v-if="loading && entries.length === 0" class="py-12 text-center">
      <div class="loading-spinner mx-auto mb-3" />
      <p class="text-sm text-gray-500 dark:text-gray-400">正在加载…</p>
    </div>

    <div
      v-else-if="entries.length === 0"
      class="rounded-lg border border-dashed border-gray-300 py-12 text-center dark:border-gray-600"
    >
      <i class="fas fa-inbox mb-2 text-2xl text-gray-400" />
      <p class="text-sm text-gray-500 dark:text-gray-400">暂无记录</p>
      <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
        没有记录说明期间没有捕获到流内错误帧，不代表上游一定没出过问题。
      </p>
    </div>

    <div v-else class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-700/60">
          <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-300">
            <th class="whitespace-nowrap px-3 py-2 font-medium">时间</th>
            <th class="whitespace-nowrap px-3 py-2 font-medium">状态</th>
            <th class="whitespace-nowrap px-3 py-2 font-medium">账号</th>
            <th class="whitespace-nowrap px-3 py-2 font-medium">模型</th>
            <th class="px-3 py-2 font-medium">详情</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr
            v-for="(entry, index) in entries"
            :key="`${entry.ts}-${index}`"
            class="align-top hover:bg-gray-50 dark:hover:bg-gray-700/40"
          >
            <td
              class="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-600 dark:text-gray-300"
            >
              {{ formatTime(entry.ts) }}
            </td>
            <td class="whitespace-nowrap px-3 py-2">
              <span
                class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
                :class="stateClass(entry.state)"
              >
                {{ stateLabel(entry.state) }}
              </span>
            </td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-200">
              <div>{{ entry.accountName || '—' }}</div>
              <div class="font-mono text-[11px] text-gray-400">{{ entry.accountId || '—' }}</div>
            </td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-200">
              {{ entry.model || '—' }}
            </td>
            <td class="px-3 py-2 text-gray-600 dark:text-gray-300">
              <div class="break-words">{{ entry.detail || '—' }}</div>
              <div v-if="entry.requestId" class="mt-0.5 font-mono text-[11px] text-gray-400">
                req: {{ entry.requestId }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { getCodexDiagnosticsApi, clearCodexDiagnosticsApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const entries = ref([])
const loading = ref(false)
const clearing = ref(false)
const maxEntries = ref(500)
const retentionSeconds = ref(7 * 24 * 60 * 60)

const retentionDays = computed(() => Math.round(retentionSeconds.value / 86400))

// 与后端 CODEX_AVAILABILITY_STATES 对应
const STATE_LABELS = {
  server_overloaded: '模型容量暂时不足',
  quota_exhausted: '额度已用尽',
  model_not_available: '模型不可用',
  client_identity_rejected: '客户端身份被拒绝',
  unknown_upstream_error: '上游异常',
  ok: '正常'
}

const STATE_CLASSES = {
  server_overloaded: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  quota_exhausted: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-300',
  model_not_available: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  client_identity_rejected:
    'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300',
  unknown_upstream_error: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

const stateLabel = (state) => STATE_LABELS[state] || state || '未知'
const stateClass = (state) => STATE_CLASSES[state] || STATE_CLASSES.unknown_upstream_error

function formatTime(ts) {
  if (!ts) return '—'
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return ts

  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function load() {
  loading.value = true
  try {
    const data = await getCodexDiagnosticsApi()
    entries.value = data?.entries || []
    if (data?.maxEntries) maxEntries.value = data.maxEntries
    if (data?.retentionSeconds) retentionSeconds.value = data.retentionSeconds
  } catch (error) {
    showToast(error?.message || '加载诊断日志失败', 'error')
  } finally {
    loading.value = false
  }
}

async function clearAll() {
  clearing.value = true
  try {
    await clearCodexDiagnosticsApi()
    entries.value = []
    showToast('已清空', 'success')
  } catch (error) {
    showToast(error?.message || '清空失败', 'error')
  } finally {
    clearing.value = false
  }
}

onMounted(load)
</script>
