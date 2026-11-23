<template>
  <Teleport to="body">
    <div class="modal fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        class="modal-content custom-scrollbar mx-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6 md:p-8"
      >
        <!-- 标题 -->
        <div class="mb-4 flex items-center justify-between sm:mb-6">
          <div class="flex items-center gap-2 sm:gap-3">
            <div
              class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 sm:h-10 sm:w-10 sm:rounded-xl"
            >
              <i class="fas fa-key text-sm text-white sm:text-base" />
            </div>
            <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100 sm:text-xl">
              重新授权账户
            </h3>
          </div>
          <button
            class="p-1 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            :disabled="submitting"
            @click="$emit('close')"
          >
            <i class="fas fa-times text-lg sm:text-xl" />
          </button>
        </div>

        <div class="space-y-4">
          <!-- 账户概况 -->
          <div
            class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-gray-900 dark:text-gray-100">{{ account.name }}</span>
              <span
                class="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              >
                {{ platformLabel }}
              </span>
              <span :class="['rounded px-2 py-0.5 text-xs', statusBadgeClass]">
                {{ statusLabel }}
              </span>
            </div>
            <p
              v-if="account.errorMessage"
              class="mt-2 break-all text-xs text-red-600 dark:text-red-400"
            >
              <i class="fas fa-exclamation-circle mr-1" />{{ account.errorMessage }}
            </p>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              <i class="fas fa-network-wired mr-1" />授权将使用账户当前代理：{{ proxyLabel }}
            </p>
          </div>

          <!-- 说明 -->
          <div
            class="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          >
            <p class="mb-1 font-semibold">只替换登录凭证，其余一切保持不变：</p>
            <ul class="list-inside list-disc space-y-0.5 text-xs">
              <li>账户 ID 不变，API Key 的专属绑定、分组、优先级、代理等配置全部保留</li>
              <li>授权成功后自动清除异常状态并恢复调度</li>
              <li>请使用<strong>原账户</strong>登录授权，系统会校验账户身份</li>
            </ul>
          </div>

          <div
            v-if="isIdentityUnverifiable"
            class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
          >
            <i class="fas fa-exclamation-triangle mr-1" />
            Gemini 授权结果不包含账户身份信息，系统无法校验是否为同一个 Google
            账户，请务必使用原账户登录。
          </div>

          <!-- Claude 授权类型 -->
          <div v-if="account.platform === 'claude' && !pendingMismatch">
            <label class="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-300">
              授权方式
            </label>
            <div class="flex gap-4">
              <label class="flex cursor-pointer items-center">
                <input
                  v-model="claudeAuthType"
                  class="mr-2 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                  :disabled="submitting"
                  type="radio"
                  value="oauth"
                />
                <span class="text-sm text-gray-700 dark:text-gray-300">OAuth</span>
              </label>
              <label class="flex cursor-pointer items-center">
                <input
                  v-model="claudeAuthType"
                  class="mr-2 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                  :disabled="submitting"
                  type="radio"
                  value="setup-token"
                />
                <span class="text-sm text-gray-700 dark:text-gray-300">Setup Token</span>
              </label>
            </div>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              默认与账户原有方式一致（当前：{{
                account.authType === 'setup-token' ? 'Setup Token' : 'OAuth'
              }}）
            </p>
          </div>

          <!-- 正在写入 -->
          <div
            v-if="submitting"
            class="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          >
            <div class="loading-spinner" />
            正在写入新凭证并恢复账户状态...
          </div>

          <!-- 身份不一致 -->
          <div
            v-if="pendingMismatch"
            class="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/30"
          >
            <h5 class="mb-1 font-semibold text-red-800 dark:text-red-300">
              <i class="fas fa-user-times mr-1" />授权的账户与原账户不一致
            </h5>
            <p class="mb-3 text-xs text-red-700 dark:text-red-300">
              继续替换后，所有绑定在这个账户上的 API Key 都会改用新账户的额度。
              如果是误用了其他账户登录，请重新授权。
            </p>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="text-red-800 dark:text-red-300">
                    <th class="py-1 pr-3 font-semibold">字段</th>
                    <th class="py-1 pr-3 font-semibold">原账户</th>
                    <th class="py-1 font-semibold">本次授权</th>
                  </tr>
                </thead>
                <tbody class="font-mono text-gray-700 dark:text-gray-200">
                  <tr v-for="item in pendingMismatch.mismatches" :key="item.field">
                    <td class="py-1 pr-3 font-sans">{{ getIdentityFieldLabel(item.field) }}</td>
                    <td class="break-all py-1 pr-3">{{ item.previous }}</td>
                    <td class="break-all py-1">{{ item.next }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="mt-4 flex gap-3">
              <button
                class="flex-1 rounded-xl bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                :disabled="submitting"
                type="button"
                @click="restartFlow"
              >
                重新授权
              </button>
              <button
                class="flex-1 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-60"
                :disabled="submitting"
                type="button"
                @click="confirmForceReplace"
              >
                仍然替换
              </button>
            </div>
          </div>

          <!-- 授权流程 -->
          <OAuthFlow
            v-show="!pendingMismatch"
            :key="flowKey"
            ref="oauthFlowRef"
            back-text="取消"
            :claude-auth-type="claudeAuthType"
            :force-consent="account.platform === 'gemini'"
            :platform="flowPlatform"
            :proxy="proxyState"
            single-account
            @back="$emit('close')"
            @success="handleAuthSuccess"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'
import { showToast } from '@/utils/tools'
import * as httpApis from '@/utils/http_apis'
import OAuthFlow from './OAuthFlow.vue'

const props = defineProps({
  account: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'success'])

const REAUTH_ENDPOINTS = {
  claude: (id) => `/admin/claude-accounts/${id}/reauthorize`,
  gemini: (id) => `/admin/gemini-accounts/${id}/reauthorize`,
  openai: (id) => `/admin/openai-accounts/${id}/reauthorize`,
  droid: (id) => `/admin/droid-accounts/${id}/reauthorize`,
  grok: (id) => `/admin/grok-accounts/${id}/reauthorize`
}

const IDENTITY_FIELD_LABELS = {
  accountUuid: 'Claude 账户 UUID',
  organizationUuid: '组织 UUID',
  email: '邮箱',
  chatgptUserId: 'ChatGPT 用户 ID',
  chatgptAccountId: 'ChatGPT 工作区 ID',
  userId: '用户 ID'
}

const STATUS_LABELS = {
  active: '正常',
  created: '未激活',
  unauthorized: '授权失效',
  error: '异常',
  blocked: '已封禁',
  expired: '已过期',
  temp_error: '临时异常',
  rate_limited: '限流中'
}

const oauthFlowRef = ref(null)
const flowKey = ref(0)
const submitting = ref(false)
// 身份不一致时暂存已换到的令牌：授权码只能用一次，确认后直接带 force 重发
const pendingMismatch = ref(null)
const claudeAuthType = ref(props.account.authType === 'setup-token' ? 'setup-token' : 'oauth')

const flowPlatform = computed(() => {
  if (props.account.platform === 'gemini' && props.account.oauthProvider === 'antigravity') {
    return 'gemini-antigravity'
  }
  return props.account.platform
})

const platformLabel = computed(() => {
  const labels = {
    claude: 'Claude',
    gemini: props.account.oauthProvider === 'antigravity' ? 'Antigravity' : 'Gemini',
    openai: 'OpenAI',
    droid: 'Droid',
    grok: 'Grok'
  }
  return labels[props.account.platform] || props.account.platform
})

const statusLabel = computed(() => {
  const status = props.account.status || 'unknown'
  return STATUS_LABELS[status] || status
})

const statusBadgeClass = computed(() => {
  const status = props.account.status
  if (status === 'active') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  }
  if (['unauthorized', 'error', 'blocked', 'expired'].includes(status)) {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  }
  return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
})

const isIdentityUnverifiable = computed(() => props.account.platform === 'gemini')

// 账户列表里的代理是 { type, host, port, ... } 或其 JSON 字符串，转成 OAuthFlow 需要的表单格式
const proxyState = computed(() => {
  let raw = props.account.proxy
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (error) {
      raw = null
    }
  }
  if (raw && raw.host && raw.port) {
    return {
      enabled: true,
      type: raw.type || 'socks5',
      host: raw.host,
      port: raw.port,
      username: raw.username || '',
      password: raw.password || ''
    }
  }
  return { enabled: false }
})

const proxyLabel = computed(() => {
  const proxy = proxyState.value
  return proxy.enabled ? `${proxy.type}://${proxy.host}:${proxy.port}` : '未配置（直连）'
})

const getIdentityFieldLabel = (field) => IDENTITY_FIELD_LABELS[field] || field

const buildPayload = (tokenInfo) => {
  switch (props.account.platform) {
    case 'claude':
      return { claudeAiOauth: tokenInfo.claudeAiOauth || tokenInfo }
    case 'gemini':
      return {
        tokens: tokenInfo.tokens || tokenInfo,
        oauthProvider: tokenInfo.oauthProvider || props.account.oauthProvider
      }
    case 'openai':
    case 'grok':
      return { tokens: tokenInfo.tokens, accountInfo: tokenInfo.accountInfo }
    case 'droid':
      return { tokens: tokenInfo.tokens || tokenInfo }
    default:
      return null
  }
}

const getSuccessMessage = (identityCheck) => {
  if (identityCheck === 'match') return '重新授权成功，已确认为同一账户'
  if (identityCheck === 'forced') return '重新授权成功，账户已替换为新授权的身份'
  return '重新授权成功'
}

const submit = async (tokenInfo, force = false) => {
  const endpointBuilder = REAUTH_ENDPOINTS[props.account.platform]
  const payload = tokenInfo ? buildPayload(tokenInfo) : null
  if (!endpointBuilder || !payload) {
    showToast('该账户类型不支持重新授权', 'error')
    return
  }

  submitting.value = true
  try {
    const res = await httpApis.reauthorizeAccountByEndpointApi(endpointBuilder(props.account.id), {
      ...payload,
      force
    })

    if (res.success) {
      pendingMismatch.value = null
      showToast(getSuccessMessage(res.data?.identityCheck), 'success')
      if (res.data?.warnings?.includes('refresh_token_missing')) {
        showToast(
          '上游没有返回新的 Refresh Token，已沿用旧值；若很快再次失效，请先在上游撤销授权后重试',
          'warning'
        )
      }
      emit('success', res.data)
      return
    }

    if (res.code === 'ACCOUNT_IDENTITY_MISMATCH') {
      pendingMismatch.value = { tokenInfo, mismatches: res.mismatches || [] }
      return
    }

    showToast(res.message || '重新授权失败', 'error')
  } finally {
    submitting.value = false
    oauthFlowRef.value?.stopCookieLoading?.()
  }
}

const handleAuthSuccess = (tokenInfoOrList) => {
  const tokenInfo = Array.isArray(tokenInfoOrList) ? tokenInfoOrList[0] : tokenInfoOrList
  submit(tokenInfo, false)
}

const confirmForceReplace = () => {
  if (!pendingMismatch.value) return
  submit(pendingMismatch.value.tokenInfo, true)
}

// 放弃本次授权结果，重新走一遍授权流程
const restartFlow = () => {
  pendingMismatch.value = null
  flowKey.value++
}
</script>
