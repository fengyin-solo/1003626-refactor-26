<template>
  <section class="page" data-module="equipment">
    <header class="page-head">
      <div>
        <h2>消防装备管理</h2>
        <p class="page-desc">装备出库到回收统一走占用台账：一件装备只保留一个有效占用，回收同步核销旧占用与外部清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记消防装备</button>
        <button class="btn" type="button" @click="exportRows">导出消防装备清单</button>
      </div>
    </header>

    <div v-if="migration && (migration.total === 0 || migration.failed > 0)" class="migration-banner">
      <template v-if="migration.total === 0">
        <span>旧数据迁移尚未执行：占用台账、检修历史还没收拢。</span>
        <button class="btn" type="button" @click="resumeMigration">立即迁移</button>
      </template>
      <template v-else>
        <span>迁移断点有 {{ migration.failed }} 件装备未完成（可从断点继续，已完成的不会重复处理）。</span>
        <button class="btn" type="button" @click="resumeMigration">从断点继续</button>
      </template>
    </div>
    <div v-else-if="migration" class="migration-banner ok">
      旧数据迁移已完成：重复占用已核销、回收旧账已解除、检修历史已归并。
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="failures.length" class="failure-panel">
      <div class="failure-head">
        <strong>并发出库/回收失败清单（只接受先到请求）</strong>
        <button class="btn ghost" type="button" @click="clearResolved">清理已续办</button>
      </div>
      <table class="data-table inner">
        <thead>
          <tr><th>装备编号</th><th>动作</th><th>队伍</th><th>到达时间</th><th>判负原因</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in failures" :key="item.id">
            <td>{{ item.equipmentCode }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.teamName || '—' }}</td>
            <td>{{ item.arrivedAt }}</td>
            <td>{{ item.reason }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="resumeFailure(item.id)">从断点续办</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>占用队伍</th>
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>记录</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr>
            <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
            <td>{{ occupancyName(row) }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in allowedActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleHistory(Number(row.id))">
                {{ expandedId === Number(row.id) ? '收起记录' : '占用/检修' }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === Number(row.id)" class="history-row">
            <td :colspan="columns.length + 3">
              <div class="history-grid">
                <div>
                  <strong>占用记录</strong>
                  <ul class="history-list">
                    <li v-for="occ in occupancyHistory(Number(row.id))" :key="occ.id">
              {{ occ.outAt }} 出库 · {{ occ.teamName }}
              <span v-if="occ.active" class="tag active">占用中</span>
              <span v-else class="tag closed">{{ occ.returnedAt }} 已核销<template v-if="occ.closedReason">（{{ reasonText(occ.closedReason) }}）</template></span>
                      <em v-if="occ.legacy" class="legacy-mark">旧账迁入</em>
                    </li>
                    <li v-if="!occupancyHistory(Number(row.id)).length" class="muted">暂无占用记录</li>
                  </ul>
                </div>
                <div>
                  <strong>检修历史</strong>
                  <ul class="history-list">
                    <li v-for="mnt in maintenanceHistory(Number(row.id))" :key="mnt.id">
                      {{ mnt.sentAt }} 送检 · {{ mnt.note }}
                      <span v-if="mnt.returnedAt" class="tag closed">{{ mnt.returnedAt }} 完成</span>
                      <span v-else class="tag active">检修中</span>
                    </li>
                    <li v-if="!maintenanceHistory(Number(row.id)).length" class="muted">暂无检修记录</li>
                  </ul>
                </div>
              </div>
              <ul v-for="mit in migrationNotes(Number(row.id))" :key="mit" class="migration-note">
                <li>{{ mit }}</li>
              </ul>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无消防装备数据，可先登记消防装备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防装备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>

    <div v-if="actionPrompt.visible" class="modal-mask" @click.self="closePrompt">
      <div class="modal-card">
        <h3>{{ actionPrompt.action }} · {{ actionPrompt.code }}</h3>
        <label v-if="actionPrompt.action === '领用装备'" class="prompt-field">
          <span>领用队伍</span>
          <input v-model="promptTeam" list="fireteam-options" placeholder="选择或填写扑火队伍" />
          <datalist id="fireteam-options">
            <option v-for="team in teamOptions" :key="team" :value="team" />
          </datalist>
        </label>
        <label v-if="actionPrompt.action === '领用装备'" class="prompt-field">
          <span>出库事由</span>
          <input v-model="promptPurpose" placeholder="如：火情扑救 / 演练" />
        </label>
        <label v-if="actionPrompt.action === '送检登记'" class="prompt-field">
          <span>送检说明</span>
          <input v-model="promptNote" placeholder="如：发动机异响" />
        </label>
        <div class="prompt-actions">
          <button class="btn" type="button" @click="closePrompt">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="confirmAction">
            {{ busy ? '处理中…' : '确认' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  activeOccupancyOf,
  clearResolvedFailures,
  downloadEntries,
  ensureMigrationRan,
  listEntries,
  maintenanceHistory,
  migrationItems,
  migrationSummary,
  moduleMeta,
  occupancyHistory,
  retryFailure,
  runMigration,
  submitEquipmentAction,
  unresolvedFailures,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type {
  EquipmentActionResult,
  MigrationItem,
  OccupancyRecord,
} from '@/data/equipment-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('equipment')
const columns = ['装备编号', '装备名称', '装备类型', '规格型号', '保管林场', '购入日期', '最近检修日', '装备状态']
const statuses = ['可用', '已领用', '待检修', '已报废']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const expandedId = ref<number | null>(null)
const busy = ref(false)
const failures = ref<ReturnType<typeof unresolvedFailures>>([])
const migrationNotesMap = ref<MigrationItem[]>([])

const stats = computed(() => [
  { label: '装备总数', value: rows.value.length },
  { label: '可用装备', value: rows.value.filter((row) => String(row.status) === '可用').length },
  { label: '已领用', value: rows.value.filter((row) => String(row.status) === '已领用').length },
  { label: '待检修数', value: rows.value.filter((row) => String(row.status) === '待检修').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const migration = ref(migrationSummary())

const teamOptions = computed(() =>
  listRows('fireteam')
    .map((row) => String(row['队伍名称'] ?? ''))
    .filter(Boolean),
)

const actionPrompt = ref<{ visible: boolean; action: string; code: string; id: number }>({
  visible: false,
  action: '',
  code: '',
  id: 0,
})
const promptTeam = ref('')
const promptPurpose = ref('')
const promptNote = ref('')

/** 状态机投影到页面：每行只给当前状态允许的动作，逆向迁移在 UI 上就点不出来。 */
function allowedActions(row: EntryRow): string[] {
  const map: Record<string, string[]> = {
    可用: ['领用装备', '送检登记', '报废装备'],
    已领用: ['回收入库', '报废装备'],
    待检修: ['检修完成'],
    已报废: [],
  }
  return map[String(row.status)] ?? []
}

function occupancyName(row: EntryRow): string {
  const occ = activeOccupancyOf(Number(row.id))
  return occ ? occ.teamName : '—'
}

function reasonText(reason: OccupancyRecord['closedReason']): string {
  return reason === 'duplicate-closed'
    ? '重复占用核销'
    : reason === 'stale-closed'
      ? '回收旧账核销'
      : '报废核销'
}

function migrationNotes(id: number): string[] {
  return migrationNotesMap.value.find((item) => item.equipmentId === id)?.warnings ?? []
}

function toggleHistory(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '消防装备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '领用装备' || action === '送检登记') {
    actionPrompt.value = { visible: true, action, code: String(row['装备编号']), id: Number(row.id) }
    promptTeam.value = ''
    promptPurpose.value = ''
    promptNote.value = ''
    return
  }
  void dispatch(action, Number(row.id))
}

function closePrompt() {
  actionPrompt.value.visible = false
}

async function confirmAction() {
  const { action, id } = actionPrompt.value
  if (action === '领用装备' && !promptTeam.value.trim()) {
    errorMessage.value = '请先选择或填写领用队伍'
    return
  }
  closePrompt()
  await dispatch(action, id)
}

async function dispatch(action: string, id: number) {
  busy.value = true
  let result: EquipmentActionResult
  try {
    result = await submitEquipmentAction({
      action,
      equipmentId: id,
      teamName: promptTeam.value.trim() || undefined,
      purpose: promptPurpose.value.trim() || undefined,
      note: promptNote.value.trim() || undefined,
    })
  } catch (error) {
    result = {
      ok: false,
      accepted: false,
      message: error instanceof Error ? error.message : '装备动作执行失败',
    }
  } finally {
    busy.value = false
  }
  promptTeam.value = ''
  promptPurpose.value = ''
  promptNote.value = ''
  if (result.ok) {
    infoMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
}

async function resumeFailure(id: string) {
  busy.value = true
  try {
    const result = await retryFailure(id)
    if (result.ok) {
      infoMessage.value = result.message
    } else {
      errorMessage.value = result.message
    }
  } finally {
    busy.value = false
    reload()
  }
}

function clearResolved() {
  clearResolvedFailures()
  reload()
}

function resumeMigration() {
  const summary = runMigration()
  migration.value = summary
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    failures.value = unresolvedFailures()
    migrationNotesMap.value = migrationItems()
    migration.value = migrationSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防装备列表读取失败'
  }
}

onMounted(() => {
  // 进入页面即收拢旧账：失败断点存在时自动从断点继续。
  migration.value = ensureMigrationRan()
  reload()
})
</script>
