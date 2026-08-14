<template>
  <div>
    <!-- 当前生效的固定身份 -->
    <div
      class="mb-6 rounded-xl border border-gray-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-4 dark:border-gray-700 dark:from-emerald-900/20 dark:to-teal-900/20"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <div
            class="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
          >
            <i class="fas fa-id-badge text-xl" />
          </div>
          <div>
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">
              当前固定身份:
              <span class="font-bold text-emerald-600 dark:text-emerald-400">{{
                applied.userAgent || '-'
              }}</span>
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              originator: {{ applied.originator || '-' }} ·
              <template v-if="applied.appliedAt">
                {{ formatTime(applied.appliedAt) }} 由 {{ applied.appliedBy }} 应用
              </template>
              <template v-else>尚未应用过，使用内置兜底值</template>
            </p>
          </div>
        </div>
        <button
          class="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          :disabled="loading"
          @click="load"
        >
          <i :class="['fas', loading ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
          刷新
        </button>
      </div>
    </div>

    <!-- 说明 -->
    <div
      class="mb-4 rounded-lg border border-gray-200 bg-white/70 p-3 text-xs leading-relaxed text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-400"
    >
      <p>
        真实 Codex
        客户端会透传自身身份，出站自动跟上它的版本。上面这个固定身份只用于其余客户端（OpenAI
        兼容客户端、脚本等）兜底。
      </p>
      <p class="mt-1">
        下方列表是从入站请求中自动采样到的真实客户端身份。上游可能对旧版本设门槛，届时新模型会报
        <code>Selected model is at capacity</code>，回到这里挑一条更新的版本应用即可。
      </p>
      <p class="mt-1">
        建议参考「次数」和「最后出现」再决定 —— 偶尔冒出来一次的版本未必可靠。超过 30
        天没再出现的记录会被自动清理。
      </p>
      <p class="mt-1">
        如果部署里没有真 Codex CLI 打进来，列表会一直为空 —— 这时用下面的手工指定直接填写。
      </p>
    </div>

    <!-- 手工指定：观测表可能长期为空，必须留一个不依赖采样的入口 -->
    <div
      class="mb-4 rounded-lg border border-gray-200 bg-white/70 p-3 dark:border-gray-700 dark:bg-gray-800/40"
    >
      <p class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">手工指定固定身份</p>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          v-model="manualUserAgent"
          class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-emerald-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          placeholder="codex_cli_rs/0.152.0 (Ubuntu 24.04.0; x86_64) WindowsTerminal"
          @keyup.enter="applyManual"
        />
        <input
          v-model="manualOriginator"
          class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-emerald-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 sm:w-52"
          placeholder="originator（留空自动推断）"
          @keyup.enter="applyManual"
        />
        <button
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="applying || !manualUserAgent.trim()"
          @click="applyManual"
        >
          应用
        </button>
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-500">
        照真实客户端的 UA 形状填写（<code>codex --version</code> 可查版本）；originator 留空时按
        User-Agent 前缀自动推断。
      </p>
    </div>

    <!-- 观测列表 -->
    <div v-if="loading" class="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
      <i class="fas fa-spinner fa-spin mr-2" />加载中...
    </div>
    <div
      v-else-if="observed.length === 0"
      class="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400"
    >
      还没有采样到任何 Codex 客户端身份，先让 Codex CLI 发起一次请求
    </div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 text-left dark:border-gray-700">
            <th class="px-3 py-2 font-medium text-gray-600 dark:text-gray-400">User-Agent</th>
            <th class="px-3 py-2 font-medium text-gray-600 dark:text-gray-400">originator</th>
            <th class="px-3 py-2 font-medium text-gray-600 dark:text-gray-400">版本</th>
            <th class="px-3 py-2 font-medium text-gray-600 dark:text-gray-400">次数</th>
            <th class="px-3 py-2 font-medium text-gray-600 dark:text-gray-400">最后出现</th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in observed"
            :key="`${item.originator}|${item.userAgent}`"
            class="border-b border-gray-100 dark:border-gray-800"
          >
            <td class="px-3 py-2 text-gray-700 dark:text-gray-300">
              {{ item.userAgent }}
              <span
                v-if="isApplied(item)"
                class="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                >当前</span
              >
            </td>
            <td class="px-3 py-2 text-gray-600 dark:text-gray-400">{{ item.originator }}</td>
            <td class="px-3 py-2 text-gray-600 dark:text-gray-400">{{ item.version }}</td>
            <td class="px-3 py-2 text-gray-600 dark:text-gray-400">{{ item.count }}</td>
            <td class="px-3 py-2 text-gray-500 dark:text-gray-500">
              {{ formatTime(item.lastSeen) }}
            </td>
            <td class="px-3 py-2 text-right">
              <button
                v-if="!isApplied(item)"
                class="rounded-lg bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                :disabled="applying"
                @click="applyOne(item)"
              >
                应用
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getCodexClientIdentityApi, applyCodexClientIdentityApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

// UA 形态与后端 CODEX_UA_PATTERN 保持一致，仅用于从 UA 推断 originator
const CODEX_UA_PATTERN = /^(codex_vscode|codex_cli_rs|codex_exec)\//i

const loading = ref(false)
const applying = ref(false)
const applied = ref({})
const observed = ref([])
const manualUserAgent = ref('')
const manualOriginator = ref('')

function formatTime(value) {
  if (!value) {
    return '-'
  }
  return String(value).replace('T', ' ').slice(0, 19)
}

function isApplied(item) {
  return item.originator === applied.value.originator && item.userAgent === applied.value.userAgent
}

async function load() {
  loading.value = true
  try {
    const result = await getCodexClientIdentityApi()
    if (result.success) {
      applied.value = result.applied || {}
      observed.value = result.observed || []
    } else {
      showToast(result.message || '加载 Codex 客户端身份失败', 'error')
    }
  } catch (error) {
    showToast(error.message || '加载 Codex 客户端身份失败', 'error')
  } finally {
    loading.value = false
  }
}

async function submitApply(payload) {
  applying.value = true
  try {
    const result = await applyCodexClientIdentityApi(payload)
    if (result.success) {
      applied.value = result.applied
      showToast(`已应用 ${result.applied.userAgent}`, 'success')
      await load()
      return true
    }
    showToast(result.message || '应用失败', 'error')
    return false
  } catch (error) {
    showToast(error.message || '应用失败', 'error')
    return false
  } finally {
    applying.value = false
  }
}

function applyOne(item) {
  return submitApply({ originator: item.originator, userAgent: item.userAgent })
}

async function applyManual() {
  const userAgent = manualUserAgent.value.trim()
  if (!userAgent || applying.value) {
    return
  }

  const originator =
    manualOriginator.value.trim().toLowerCase() ||
    (userAgent.match(CODEX_UA_PATTERN)?.[1] || '').toLowerCase()

  if (!originator) {
    showToast('无法从 User-Agent 推断 originator，请手动填写', 'error')
    return
  }

  if (await submitApply({ originator, userAgent })) {
    manualUserAgent.value = ''
    manualOriginator.value = ''
  }
}

onMounted(load)
</script>
