import { listRows, saveRows } from '@/data/local-store'

import { loadRegistryRows, MIGRATION_VERSION, planMigration } from './migration'
import { CLAIM_DISMISS_FIELD, CLAIM_DISMISSED_MARK } from './references'
import { canTransit, projectAll, projectLifecycle } from './state'
import type {
  ActiveClaim,
  EquipmentLifecycle,
  EquipmentLifecycleState,
  EquipmentStatus,
  FailedRequest,
  LifecycleEvent,
  LifecycleEventType,
  MigrationState,
  RepairRecord,
} from './types'

const KNOWN_STATUSES: EquipmentStatus[] = ['可用', '已领用', '待检修', '已报废']

function asEquipmentStatus(value: string): EquipmentStatus {
  return KNOWN_STATUSES.includes(value as EquipmentStatus) ? (value as EquipmentStatus) : '可用'
}

const STORAGE_KEY = 'forest-fire-patrol:equipment-lifecycle'

const TERMINAL_PENDING_STATUS = '已报废'
const CLAIM_CLOSING: LifecycleEventType[] = ['RETURNED', 'SENT_FOR_REPAIR', 'SCRAPPED', 'WRITE_OFF']

function timestamp(): string {
  return new Date().toISOString()
}

function emptyMigration(): MigrationState {
  return { version: MIGRATION_VERSION, status: 'idle', processedCodes: [], failures: [] }
}

function readState(): EquipmentLifecycleState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { events: [], failed: [], migration: emptyMigration() }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return { events: [], failed: [], migration: emptyMigration() }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EquipmentLifecycleState>
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
      migration: parsed.migration ?? emptyMigration(),
    }
  } catch {
    return { events: [], failed: [], migration: emptyMigration() }
  }
}

let cache: EquipmentLifecycleState | null = null

function state(): EquipmentLifecycleState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state()))
  }
}

function nextEventId(): number {
  return state().events.reduce((max, event) => Math.max(max, event.id), 0) + 1
}

function nextFailureId(): number {
  return state().failed.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function lifecycleOf(code: string): EquipmentLifecycle | null {
  const events = state().events.filter((event) => event.equipmentCode === code)
  return events.length ? projectLifecycle(code, events) : null
}

// ---------------------------------------------------------------------------
// 跨模块同步核销
// ---------------------------------------------------------------------------

function equipmentCodesInField(value: string): Set<string> {
  // 装备字段可能是单个编号，也可能是逗号/顿号分隔的一串。
  return new Set(
    value
      .split(/[,，、\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

/**
 * 装备占用被核销（回收/送检/报废）后，其它模块清单里指向同一装备编号的非终态
 * 占用行同步打上核销标记。只追加标记，不动这些模块自己的状态机。
 */
function syncCrossModuleDismissals(code: string): void {
  for (const { registry, rows } of loadRegistryRows()) {
    let changed = false
    const next = rows.map((row) => {
      if (registry.terminalStatuses.includes(String(row.status ?? ''))) {
        return row
      }
      if (row[CLAIM_DISMISS_FIELD] === CLAIM_DISMISSED_MARK) {
        return row
      }
      const codes = equipmentCodesInField(String(row[registry.equipmentField] ?? ''))
      if (!codes.has(code)) {
        return row
      }
      changed = true
      return { ...row, [CLAIM_DISMISS_FIELD]: CLAIM_DISMISSED_MARK }
    })
    if (changed) {
      saveRows(registry.moduleKey, next)
    }
  }
}

/**
 * 把事件流投影回装备主表：状态、pending、最近检修日。
 * 装备编号以及其它登记字段一律不动；历史事件没有可靠日期时不改最近检修日。
 */
function reconcileEquipmentRows(events: LifecycleEvent[]): void {
  const projected = projectAll(events)
  const rows = listRows('equipment')
  let changed = false
  const next = rows.map((row) => {
    const code = String(row['装备编号'] ?? '')
    const lifecycle = projected.get(code)
    if (!lifecycle) {
      return row
    }
    const latestRepair = lifecycle.repairs[0]
    const repairDate = (latestRepair?.returnedAt ?? latestRepair?.sentAt ?? '').slice(0, 10)
    const patch: Record<string, string | boolean> = {
      status: lifecycle.status,
      pending: lifecycle.status !== TERMINAL_PENDING_STATUS,
      abnormal: false,
    }
    if (repairDate) {
      patch['最近检修日'] = repairDate
    }
    const same =
      row.status === patch.status &&
      row.pending === patch.pending &&
      row.abnormal === patch.abnormal &&
      (!repairDate || row['最近检修日'] === repairDate)
    if (same) {
      return row
    }
    changed = true
    return { ...row, ...patch }
  })
  if (changed) {
    saveRows('equipment', next)
  }
}

// ---------------------------------------------------------------------------
// 历史迁移（可从断点继续）
// ---------------------------------------------------------------------------

export type MigrationReport = {
  ran: boolean
  status: MigrationState['status']
  processed: number
  failures: MigrationState['failures']
  appendedEvents: number
  dismissals: number
}

/**
 * 执行/续跑历史迁移：
 * - processedCodes 记录断点，页面关闭后再开继续往后跑；
 * - 计划幂等：claimRef 相同的事件已存在就跳过，可安全反复调用；
 * - 旧规格为空的兼容按保管林场归属（见 references.resolveEquipmentRef），装备编号不改；
 * - 迁移后同一装备编号只剩一个有效占用，其它模块清单同步打核销标记。
 */
export function runMigration(): MigrationReport {
  const snap = state()
  snap.migration.version = MIGRATION_VERSION

  const plan = planMigration(listRows('equipment'), loadRegistryRows(), timestamp(), nextEventId)

  const existingRefs = new Set(
    snap.events
      .map((event) => event.claimRef)
      .filter((ref): ref is string => ref !== undefined),
  )
  // 幂等过滤后全部追加：先前因多义没解析出来的引用，在数据补齐后续跑也能补上。
  const newEvents = plan.events.filter(
    (event) => !event.claimRef || !existingRefs.has(event.claimRef),
  )
  snap.events.push(...newEvents)
  for (const code of plan.codes) {
    if (!snap.migration.processedCodes.includes(code)) {
      snap.migration.processedCodes.push(code)
    }
  }

  let dismissed = 0
  for (const mark of plan.dismissals) {
    // 每条核销都从最新存储读取：saveRows 会重建分表对象，不能依赖循环外的旧快照。
    const rows = listRows(mark.moduleKey)
    if (!rows.length) {
      continue
    }
    const target = rows.find((row) => Number(row.id) === mark.rowId)
    if (!target || target[CLAIM_DISMISS_FIELD] === CLAIM_DISMISSED_MARK) {
      continue
    }
    saveRows(
      mark.moduleKey,
      rows.map((row) =>
        Number(row.id) === mark.rowId
          ? { ...row, [CLAIM_DISMISS_FIELD]: CLAIM_DISMISSED_MARK }
          : row,
      ),
    )
    dismissed += 1
  }

  reconcileEquipmentRows(snap.events)

  snap.migration.failures = plan.failures
  snap.migration.status = 'done'
  snap.migration.migratedAt = snap.migration.migratedAt ?? timestamp()
  persist()

  return {
    ran: newEvents.length > 0 || dismissed > 0,
    status: snap.migration.status,
    processed: snap.migration.processedCodes.length,
    failures: plan.failures,
    appendedEvents: newEvents.length,
    dismissals: dismissed,
  }
}

export function migrationState(): MigrationState {
  return state().migration
}

// ---------------------------------------------------------------------------
// 读出：统一视图（状态、占用、检修历史全部来自同一事件流投影）
// ---------------------------------------------------------------------------

export function getLifecycle(code: string): EquipmentLifecycle | null {
  return lifecycleOf(code)
}

export function activeClaims(): ActiveClaim[] {
  return [...projectAll(state().events).values()]
    .flatMap((item) => (item.activeClaim ? [item.activeClaim] : []))
    .sort((a, b) => (a.since < b.since ? -1 : 1))
}

export function repairHistory(code?: string): RepairRecord[] {
  const records: RepairRecord[] = []
  for (const lifecycle of projectAll(state().events).values()) {
    if (code && lifecycle.code !== code) {
      continue
    }
    records.push(...lifecycle.repairs)
  }
  return records.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))
}

export function failedRequests(): FailedRequest[] {
  return state().failed
}

// ---------------------------------------------------------------------------
// 写入：FIFO 串行队列 + 装备级版本比较，并发出库/回收只接受先到请求
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

function enqueue<R>(job: () => R): Promise<R> {
  const run = chain.then(() => job())
  // 单个任务失败不能拖垮整条队列。
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export type MutationResult = { ok: boolean; message: string }

type MutationInput = {
  code: string
  type: LifecycleEventType
  teamName?: string
  origin: string
}

export function actionLabel(type: LifecycleEventType): string {
  switch (type) {
    case 'CHECKED_OUT':
      return '出库领用'
    case 'RETURNED':
      return '回收入库'
    case 'SENT_FOR_REPAIR':
      return '送检登记'
    case 'REPAIRED':
      return '修竣登记'
    case 'SCRAPPED':
      return '报废'
    case 'WRITE_OFF':
      return '占用核销'
  }
}

function validate(input: MutationInput): { ok: true; lifecycle: EquipmentLifecycle | null } | { ok: false; message: string } {
  const row = listRows('equipment').find((item) => String(item['装备编号'] ?? '') === input.code)
  if (!row) {
    return { ok: false, message: `没有找到装备编号为 ${input.code} 的消防装备` }
  }
  const lifecycle = lifecycleOf(input.code)
  const status: EquipmentStatus = lifecycle?.status ?? asEquipmentStatus(String(row.status))
  if (!canTransit(status, input.type)) {
    return {
      ok: false,
      message: `装备 ${input.code} 当前为「${status}」，不允许${actionLabel(input.type)}`,
    }
  }
  if (input.type === 'CHECKED_OUT' && lifecycle?.activeClaim) {
    return {
      ok: false,
      message: `装备 ${input.code} 已被「${lifecycle.activeClaim.teamName}」占用，同一装备只能有一个有效占用`,
    }
  }
  if (input.type === 'RETURNED' && !lifecycle?.activeClaim) {
    return { ok: false, message: `装备 ${input.code} 当前没有有效占用，无需回收` }
  }
  return { ok: true, lifecycle }
}

function recordFailure(input: MutationInput, baseVersion: number, reason: string): FailedRequest {
  const item: FailedRequest = {
    id: nextFailureId(),
    kind: input.type,
    equipmentCode: input.code,
    teamName: input.teamName ?? '',
    origin: input.origin,
    baseVersion,
    reason,
    attempts: 1,
    createdAt: timestamp(),
  }
  state().failed.push(item)
  persist()
  return item
}

function appendMutation(input: MutationInput, failureId?: number): MutationResult {
  const lifecycle = lifecycleOf(input.code)
  const activeClaim = lifecycle?.activeClaim ?? null
  const event: LifecycleEvent = {
    id: nextEventId(),
    type: input.type,
    equipmentCode: input.code,
    at: timestamp(),
    teamName: input.teamName ?? activeClaim?.teamName ?? '',
    origin: failureId === undefined ? input.origin : `${input.origin}:重试#${failureId}`,
    claimRef:
      input.type === 'CHECKED_OUT'
        ? `runtime:${input.code}:${Date.now()}:${eventIdSalt()}`
        : activeClaim?.claimRef,
  }
  state().events.push(event)
  if (failureId !== undefined) {
    state().failed = state().failed.filter((item) => item.id !== failureId)
  }
  persist()

  if (CLAIM_CLOSING.includes(input.type)) {
    syncCrossModuleDismissals(input.code)
  }
  reconcileEquipmentRows(state().events)
  return { ok: true, message: `装备 ${input.code} 已${actionLabel(input.type)}` }
}

let salt = 0
function eventIdSalt(): number {
  salt += 1
  return salt
}

/**
 * 提交一条生命周期操作。
 * 并发出库与回收只接受先到请求：所有写入按 FIFO 入队串行执行，后到请求在队列里
 * 看到的已是先到请求生效后的状态（有占用/无占用），直接失败并入失败台账。
 */
export function submitMutation(input: MutationInput): Promise<MutationResult> {
  return enqueue(() => {
    const checked = validate(input)
    const baseVersion = checked.ok ? checked.lifecycle?.version ?? 0 : lifecycleOf(input.code)?.version ?? 0
    if (!checked.ok) {
      const item = recordFailure(input, baseVersion, checked.message)
      return { ok: false, message: `${checked.message}（已记入失败清单 #${item.id}，可从断点续跑）` }
    }
    return appendMutation(input)
  })
}

/**
 * 从失败台账重试：拿当前状态重新校验一遍。
 * 迟到的出库若占用仍在就继续失败（先到请求的结果不被翻案）；数据已补齐或装备
 * 已回收后，请求可在原断点续跑成功。
 */
export function retryFailed(failureId: number): Promise<MutationResult> {
  return enqueue(() => {
    const target = state().failed.find((item) => item.id === failureId)
    if (!target) {
      return { ok: false, message: `失败记录 #${failureId} 不存在或已处理` }
    }
    const input: MutationInput = {
      code: target.equipmentCode,
      type: target.kind,
      teamName: target.teamName,
      origin: target.origin,
    }
    const checked = validate(input)
    if (!checked.ok) {
      target.attempts += 1
      target.reason = checked.message
      persist()
      return { ok: false, message: `重试仍失败：${checked.message}` }
    }
    const result = appendMutation(input, failureId)
    return result.ok
      ? { ok: true, message: `失败记录 #${failureId} 已续跑成功：${result.message}` }
      : result
  })
}

/** 放弃一条失败记录（人工确认无需继续）。 */
export function dismissFailed(failureId: number): void {
  state().failed = state().failed.filter((item) => item.id !== failureId)
  persist()
}

/** 仅供测试/重置：清空生命周期状态。 */
export function _resetLifecycleForTest(): void {
  cache = { events: [], failed: [], migration: emptyMigration() }
  persist()
}
