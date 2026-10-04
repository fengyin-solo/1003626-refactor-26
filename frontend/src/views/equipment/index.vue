<template>
  <section class="page" data-module="equipment">
    <header class="page-head">
      <div>
        <h2>消防装备管理</h2>
        <p class="page-desc">出库、回收、送检、修竣、报废统一走生命周期事件流；一件装备同一时刻只有一个有效占用。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="continueMigration">续跑历史迁移</button>
        <button class="btn" type="button" @click="exportRows">导出消防装备清单</button>
      </div>
    </header>

    <div v-if="migrationBanner" class="migration-banner">
      <span>{{ migrationBanner }}</span>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>当前占用队伍</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ claimOf(String(row[codeField])).teamName || '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(String(row.status))"
              :key="action.label"
              class="link"
              type="button"
              :disabled="busy"
              @click="runAction(action, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无消防装备数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="teamPicker.open" class="modal-mask" @click.self="closePicker">
      <div class="modal-card">
        <h3>出库领用：{{ teamPicker.code }}</h3>
        <p class="page-desc">{{ teamPicker.name }}（{{ teamPicker.spec }}）</p>
        <label class="filter-item">
          <span>领用队伍</span>
          <input v-model="teamPicker.teamName" list="fireteam-options" placeholder="选择或填写队伍" />
        </label>
        <datalist id="fireteam-options">
          <option v-for="team in teamOptions" :key="team" :value="team" />
        </datalist>
        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="busy" @click="confirmCheckout">确认出库</button>
          <button class="btn ghost" type="button" @click="closePicker">取消</button>
        </div>
      </div>
    </div>

    <section class="lifecycle-panel">
      <h3>有效占用清单</h3>
      <table class="data-table">
        <thead>
          <tr><th>装备编号</th><th>占用队伍</th><th>占用开始</th><th>来源</th></tr>
        </thead>
        <tbody>
          <tr v-for="claim in claims" :key="claim.equipmentCode + claim.teamName">
            <td>{{ claim.equipmentCode }}</td>
            <td>{{ claim.teamName }}</td>
            <td>{{ formatTime(claim.since) }}</td>
            <td>{{ claim.origin }}</td>
          </tr>
          <tr v-if="!claims.length">
            <td colspan="4" class="empty-state">当前没有未核销的占用</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="lifecycle-panel">
      <h3>检修历史</h3>
      <table class="data-table">
        <thead>
          <tr><th>装备编号</th><th>送检时间</th><th>修竣时间</th><th>相关队伍</th></tr>
        </thead>
        <tbody>
          <tr v-for="(repair, index) in repairs" :key="repair.equipmentCode + repair.sentAt + index">
            <td>{{ repair.equipmentCode }}</td>
            <td>{{ formatTime(repair.sentAt) }}</td>
            <td>{{ repair.returnedAt ? formatTime(repair.returnedAt) : '检修中' }}</td>
            <td>{{ repair.teamName || '—' }}</td>
          </tr>
          <tr v-if="!repairs.length">
            <td colspan="4" class="empty-state">暂无检修记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="failed.length" class="lifecycle-panel">
      <h3>失败请求（可从断点续跑）</h3>
      <table class="data-table">
        <thead>
          <tr><th>#</th><th>装备编号</th><th>动作</th><th>原因</th><th>尝试次数</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in failed" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.equipmentCode }}</td>
            <td>{{ actionLabelText(item.kind) }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.attempts }}</td>
            <td class="row-actions">
              <button class="link" type="button" :disabled="busy" @click="retryOne(item.id)">续跑</button>
              <button class="link danger" type="button" @click="dropOne(item.id)">放弃</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防装备记录；迁移断点已处理 {{ migrationProcessed }} 件装备</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import {
  actionLabel,
  activeClaims,
  dismissFailed,
  failedRequests,
  getLifecycle,
  migrationState,
  repairHistory,
  retryFailed,
  runMigration,
  submitMutation,
} from '@/data/equipment/service'
import type { EntryRow } from '@/data/types'
import type { LifecycleEventType, MigrationState } from '@/data/equipment/types'

const meta = moduleMeta('equipment')
const columns = ['装备编号', '装备名称', '装备类型', '规格型号', '保管林场', '购入日期', '最近检修日', '装备状态']
const codeField = '装备编号'
const statuses = ['可用', '已领用', '待检修', '已报废']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const busy = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const claims = ref<ReturnType<typeof activeClaims>>([])
const repairs = ref<ReturnType<typeof repairHistory>>([])
const failed = ref<ReturnType<typeof failedRequests>>([])
const migration = ref<MigrationState>(migrationState())
const lastMigrationRan = ref(false)
const teamPicker = reactive({
  open: false,
  code: '',
  name: '',
  spec: '',
  teamName: '',
})

type RowAction = { label: string; kind: LifecycleEventType }

function actionsFor(status: string): RowAction[] {
  switch (status) {
    case '可用':
      return [
        { label: '领用装备', kind: 'CHECKED_OUT' },
        { label: '送检登记', kind: 'SENT_FOR_REPAIR' },
        { label: '报废装备', kind: 'SCRAPPED' },
      ]
    case '已领用':
      return [
        { label: '回收装备', kind: 'RETURNED' },
        { label: '送检登记', kind: 'SENT_FOR_REPAIR' },
        { label: '报废装备', kind: 'SCRAPPED' },
      ]
    case '待检修':
      return [
        { label: '修竣登记', kind: 'REPAIRED' },
        { label: '报废装备', kind: 'SCRAPPED' },
      ]
    default:
      return []
  }
}

const stats = computed(() => [
  { label: '装备总数', value: rows.value.length },
  { label: '可用装备', value: rows.value.filter((row) => String(row.status) === '可用').length },
  { label: '待检修数', value: rows.value.filter((row) => String(row.status) === '待检修').length },
  { label: '占用中', value: claims.value.length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const migrationProcessed = computed(() => migration.value.processedCodes.length)

const migrationBanner = computed(() => {
  const failures = migration.value.failures
  if (failures.length) {
    return `历史迁移有 ${failures.length} 条占用引用无法唯一匹配，已留在断点清单，补全装备编号或规格型号后可续跑。`
  }
  if (lastMigrationRan.value) {
    return '历史占用、检修记录已收拢到统一生命周期，重复占用已核销。'
  }
  return ''
})

const teamOptions = computed(() => {
  const names = listRows('fireteam')
    .map((row) => String(row['队伍名称'] ?? '').trim())
    .filter(Boolean)
  return [...new Set(names)]
})

function claimOf(code: string) {
  return getLifecycle(code)?.activeClaim ?? { teamName: '' }
}

function formatTime(value: string): string {
  if (!value) {
    return '历史记录（时间未登记）'
  }
  return value.replace('T', ' ').slice(0, 16)
}

function actionLabelText(kind: LifecycleEventType): string {
  return actionLabel(kind)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openPicker(row: EntryRow) {
  teamPicker.open = true
  teamPicker.code = String(row[codeField])
  teamPicker.name = String(row['装备名称'] ?? '')
  teamPicker.spec = String(row['规格型号'] ?? '')
  teamPicker.teamName = ''
}

function closePicker() {
  teamPicker.open = false
}

async function confirmCheckout() {
  const team = teamPicker.teamName.trim()
  if (!team) {
    errorMessage.value = '请选择或填写领用队伍'
    return
  }
  const code = teamPicker.code
  closePicker()
  await mutate({
    code,
    type: 'CHECKED_OUT',
    teamName: team,
    origin: '装备页出库',
  })
}

async function runAction(action: RowAction, row: EntryRow) {
  errorMessage.value = ''
  const code = String(row[codeField])
  if (action.kind === 'CHECKED_OUT') {
    openPicker(row)
    return
  }
  await mutate({ code, type: action.kind, origin: `装备页${action.label}` })
}

async function mutate(input: { code: string; type: LifecycleEventType; teamName?: string; origin: string }) {
  busy.value = true
  try {
    const result = await submitMutation(input)
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    busy.value = false
  }
}

async function retryOne(id: number) {
  busy.value = true
  try {
    const result = await retryFailed(id)
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    busy.value = false
  }
}

function dropOne(id: number) {
  dismissFailed(id)
  reload()
}

function continueMigration() {
  const report = runMigration()
  lastMigrationRan.value = report.ran
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    claims.value = activeClaims()
    repairs.value = repairHistory()
    failed.value = failedRequests()
    migration.value = migrationState()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防装备列表读取失败'
  }
}

onMounted(() => {
  // 首次进入自动迁移；已迁移后计划幂等，不会重复追加。
  const report = runMigration()
  lastMigrationRan.value = report.ran
  reload()
})
</script>

<style scoped>
.migration-banner {
  background: #fff7ed;
  border: 1px solid #fdba74;
  color: #9a3412;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 12px;
}
.lifecycle-panel {
  margin-top: 18px;
}
.lifecycle-panel h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 8px;
  padding: 18px 20px;
  width: 360px;
}
.modal-card h3 {
  margin: 0 0 6px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}
.link.danger {
  color: #b42318;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
