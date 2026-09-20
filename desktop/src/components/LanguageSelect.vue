<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import languageCatalog from '../../electron/translation-languages.json';

interface LanguageOption {
  code: string;
  name: string;
  english: string;
}

const props = withDefaults(defineProps<{
  modelValue: string;
  includeAuto?: boolean;
  autoLabel?: string;
}>(), {
  includeAuto: false,
  autoLabel: '自动检测',
});
const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref('');
const languages = languageCatalog as LanguageOption[];

const selectedLanguage = computed(() => languages.find((item) => item.code === props.modelValue));
const selectedLabel = computed(() => {
  if (props.includeAuto && props.modelValue === 'auto') return props.autoLabel;
  return selectedLanguage.value?.name || props.modelValue || '请选择语言';
});
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase());
const matchingLanguages = computed(() => {
  const search = normalizedQuery.value;
  if (!search) return languages;
  return languages.filter((item) => (
    item.name.toLocaleLowerCase().includes(search)
    || item.english.toLocaleLowerCase().includes(search)
    || item.code.toLocaleLowerCase().includes(search)
  ));
});

function showMenu() {
  open.value = true;
  query.value = '';
  void nextTick(() => searchInput.value?.focus());
}

function toggleMenu() {
  if (open.value) open.value = false;
  else showMenu();
}

function choose(value: string) {
  emit('update:modelValue', value);
  open.value = false;
  query.value = '';
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerDown));
</script>

<template>
  <div ref="root" class="language-select" :class="{ open }">
    <button
      class="language-select-trigger"
      type="button"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggleMenu"
      @keydown.down.prevent="showMenu"
    >
      <span>{{ selectedLabel }}</span>
      <i aria-hidden="true"></i>
    </button>

    <div v-if="open" class="language-select-menu" @keydown.esc.stop="open = false">
      <div class="language-search-wrap">
        <input ref="searchInput" v-model="query" type="search" placeholder="搜索中文名、英文名或代码" />
      </div>
      <div class="language-options" role="listbox">
        <button
          v-if="includeAuto && !normalizedQuery"
          class="language-option automatic"
          type="button"
          :class="{ selected: modelValue === 'auto' }"
          @click="choose('auto')"
        >
          <span><strong>{{ autoLabel }}</strong><small>根据当前客户会话确定</small></span>
          <code>AUTO</code>
        </button>

        <button
          v-for="language in matchingLanguages"
          :key="language.code"
          class="language-option"
          type="button"
          :class="{ selected: modelValue === language.code }"
          @click="choose(language.code)"
        >
          <span><strong>{{ language.name }}</strong><small>{{ language.english }}</small></span>
          <code>{{ language.code }}</code>
        </button>
        <div v-if="!matchingLanguages.length" class="language-empty">未找到匹配语言</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.language-select { position: relative; min-width: 0; }
.language-select-trigger {
  width: 100%; height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 10px; border: 1px solid #dbe4ed; border-radius: 6px; background: #fff; color: #526984;
  font: inherit; text-align: left; cursor: pointer;
}
.language-select-trigger:focus-visible, .language-select.open .language-select-trigger {
  border-color: #77bbb3; outline: 0; box-shadow: 0 0 0 3px rgba(18, 165, 148, .09);
}
.language-select-trigger i { width: 7px; height: 7px; border-right: 1.5px solid #6f8197; border-bottom: 1.5px solid #6f8197; transform: rotate(45deg) translateY(-2px); }
.language-select-menu {
  position: absolute; inset: calc(100% + 5px) 0 auto; z-index: 80; overflow: hidden;
  border: 1px solid #d7e3e8; border-radius: 8px; background: #fff; box-shadow: 0 12px 30px rgba(42, 77, 91, .16);
}
.language-search-wrap { padding: 8px; border-bottom: 1px solid #edf2f5; background: #fbfcfd; }
.language-search-wrap input { width: 100%; height: 30px; padding: 0 9px; border: 1px solid #d7e2e8; border-radius: 6px; outline: 0; color: #314b5c; font: inherit; }
.language-search-wrap input:focus { border-color: #77bbb3; box-shadow: 0 0 0 3px rgba(18, 165, 148, .08); }
.language-options { max-height: 250px; overflow: auto; padding: 4px; }
.language-group-label { padding: 7px 8px 4px; color: #8c9eaa; font-size: 9px; font-weight: 650; }
.language-option {
  width: 100%; min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: #425c6d; font: inherit; text-align: left; cursor: pointer;
}
.language-option:hover { background: #f2f8f7; }
.language-option:active { transform: translateY(1px); }
.language-option.selected { background: #eaf7f5; color: #087f73; }
.language-option span { min-width: 0; display: grid; gap: 1px; }
.language-option strong { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.language-option small { overflow: hidden; color: #8b9ca8; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.language-option code { color: #8b9ca8; font-size: 9px; text-transform: uppercase; }
.language-option.automatic small { color: #77a098; }
.language-empty { padding: 24px 12px; color: #94a3ad; text-align: center; }
</style>
