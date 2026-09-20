<script setup lang="ts">
import { onMounted } from 'vue';
import { localSettings, balanceRows, balanceSummary, balanceError, balanceLoading, balanceUpdatedAt, balanceAvailable, refreshBalance } from '../services/localClient';
defineEmits<{ configure: [] }>();
onMounted(() => { void refreshBalance(); });
</script>

<template>
  <section class="page account-page">
    <div class="page-heading"><h1>余额</h1><button class="secondary-button" :disabled="!localSettings.hasKey || balanceLoading" @click="refreshBalance">{{ balanceLoading ? '查询中…' : '刷新余额' }}</button></div>
    <section class="local-balance-card">
      <span>DeepSeek 余额</span>
      <template v-if="localSettings.hasKey && !balanceError && balanceRows.length">
        <strong v-for="row in balanceRows" :key="row.currency">{{ row.currency === 'CNY' ? '¥' : '$' }}{{ row.total_balance }} <small>{{ row.currency }}</small></strong>
      </template>
      <strong v-else>{{ balanceSummary }}</strong>
      <p v-if="balanceError" role="alert">{{ balanceError }}</p>
      <p v-else-if="!localSettings.hasKey">先填写自己的 API Key，即可查询实际余额。</p>
      <p v-else-if="balanceAvailable === false">DeepSeek 当前账户余额不可用于 API 调用，请到官方平台检查。</p>
      <small v-if="balanceUpdatedAt && !balanceError">最近查询：{{ balanceUpdatedAt }}</small>
      <button v-if="!localSettings.hasKey" class="secondary-button" @click="$emit('configure')">配置 API Key</button>
    </section>
    <p class="local-note">余额直接查询 DeepSeek 官方账户，软件不出售套餐，不另行收取字符或 AI 次数费用。</p>
  </section>
</template>
