import { MODULE_BY_KEY } from './modules'
import { commitAll, listRows } from './local-store'
import { loadDomain, nextId, saveDomain } from './equipment-store'
import { checkTransition } from './transition'
import { EQUIPMENT_REF_SLOTS, revokeRefFromRow } from './equipment-refs'
import { LEGACY_MAINTENANCE, LEGACY_OCCUPANCIES } from './equipment-legacy'
import type {
  EquipmentActionInput,
  EquipmentActionResult,
  FailedRequest,
  MigrationItem,
  OccupancyRecord,
} from './equipment-types'
import type { EntryRow } from './types'

const MODULE_KEY = 'equipment'
const LAST_STATUS = '已报废'
const CODE_FIELD = '装备编号'
const SPEC_FIELD = '规格型号'
const CUSTODY_FIELD = '保管林场'
const LATEST_REPAIR_FIELD = '最近检修日'

/** 出库/回收是唯一参与并发抢占的动作；其余动作为业务校验失败，不入失败清单。 */
const CONTENTION_ACTIONS = new Set(['领用装备', '回收入库'])

function meta() {
  const item = MODULE_BY_KEY.get(MODULE_KEY)
  if (!item) {
    throw new Error('消防装备模块未登记')
  }
  return item
}

export function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`
}

function equipmentRows(): EntryRow[] {
  return listRows(MODULE_KEY)
}

function findRow(id: number): EntryRow | undefined {
  return equipmentRows().find((row) => Number(row.id) === id)
}

function rowVersion(id: number): number {
  const domain = loadDomain()
  return domain.versions[String(id)] ?? 0
}

/* -------------------------------- 共用查询 -------------------------------- */

/** 兼容分组：优先规格型号；旧规格为空时回退保管林场（不新增字段，也不改装备编号）。 */
export function compatibilityGroup(row: EntryRow): string {
  const spec = String(row[SPEC_FIELD] ?? '').trim()
  if (spec) {
    return spec
  }
  return String(row[CUSTODY_FIELD] ?? '').trim()
}

export function activeOccupancyOf(equipmentId: number): OccupancyRecord | undefined {
  return loadDomain().occupancies.find(
    (item) => item.equipmentId === equipmentId && item.active,
  )
}

export function occupancyHistory(equipmentId?: number): OccupancyRecord[] {
  const list = loadDomain().occupancies.filter(
    (item) => equipmentId === undefined || item.equipmentId === equipmentId,
  )
  return [...list].sort((a, b) => (a.outAt < b.outAt ? 1 : -1))
}

export function maintenanceHistory(equipmentId?: number) {
  const list = loadDomain().maintenance.filter(
    (item) => equipmentId === undefined || item.equipmentId === equipmentId,
  )
  return [...list].sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))
}

export function latestRepairDate(equipmentId: number): string {
  const list = maintenanceHistory(equipmentId)
  return list[0]?.sentAt.slice(0, 10) ?? ''
}

/** 同规格（旧规格为空时同保管林场）下当前可出库的装备。 */
export function availableEquipment(group?: string): EntryRow[] {
  return equipmentRows().filter((row) => {
    if (String(row.status) !== '可用' || activeOccupancyOf(Number(row.id))) {
      return false
    }
    return group === undefined || compatibilityGroup(row) === group
  })
}

/* ------------------------------ 动作：先到先得 ----------------------------- */

let queue: Promise<unknown> = Promise.resolve()

/** 所有出库/回收都挂到同一条串行队列上：先到先执行，后到看到的就是新版本号。 */
function enqueue<T>(task: () => T): Promise<T> {
  const result = queue.then(task)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** 并发出库/回收统一从这里排队：同一件装备只接受最先到达的请求。 */
export function submitEquipmentAction(input: EquipmentActionInput): Promise<EquipmentActionResult> {
  const baseVersion = rowVersion(input.equipmentId)
  return enqueue(() => executeAction(input, baseVersion))
}

function failure(
  input: EquipmentActionInput,
  baseVersion: number,
  reason: string,
  accepted: boolean,
): EquipmentActionResult {
  const row = findRow(input.equipmentId)
  if (CONTENTION_ACTIONS.has(input.action)) {
    const domain = loadDomain()
    const record: FailedRequest = {
      id: nextId('FAIL', domain.failedRequests),
      equipmentId: input.equipmentId,
      equipmentCode: row ? String(row[CODE_FIELD]) : `#${input.equipmentId}`,
      action: input.action,
      teamName: input.teamName,
      note: input.purpose,
      baseVersion,
      reason,
      arrivedAt: timestamp(),
      retries: 0,
      resolved: false,
    }
    domain.failedRequests = [...domain.failedRequests, record]
    saveDomain(domain)
  }
  return { ok: false, accepted, message: reason, equipmentId: input.equipmentId }
}

function executeAction(
  input: EquipmentActionInput,
  baseVersion: number,
): EquipmentActionResult {
  const domain = loadDomain()
  const row = findRow(input.equipmentId)
  if (!row) {
    return { ok: false, accepted: false, message: `没有找到编号为 ${input.equipmentId} 的消防装备` }
  }

  // 乐观锁：装备版本在请求排队期间被先到请求改过，本请求判负。
  const currentVersion = domain.versions[String(input.equipmentId)] ?? 0
  if (currentVersion !== baseVersion) {
    return failure(
      input,
      baseVersion,
      `「${input.action}」请求到达时，装备 ${String(row[CODE_FIELD])} 已有先到请求完成占用变更，后到请求不受理，可从失败清单续办`,
      false,
    )
  }

  const check = checkTransition(meta(), String(row.status), input.action)
  if (!check.ok) {
    return { ok: false, accepted: false, message: check.message }
  }

  const active = domain.occupancies.find(
    (item) => item.equipmentId === input.equipmentId && item.active,
  )

  if (input.action === '领用装备' && !input.teamName?.trim()) {
    return { ok: false, accepted: false, message: '领用装备必须指定领用队伍' }
  }
  if (input.action === '领用装备' && active) {
    return failure(
      input,
      baseVersion,
      `装备 ${String(row[CODE_FIELD])} 已被「${active.teamName}」占用，一件装备只保留一个有效占用`,
      false,
    )
  }
  if (input.action === '回收入库' && !active) {
    return { ok: false, accepted: false, message: `装备 ${String(row[CODE_FIELD])} 没有未归还的有效占用，无需回收` }
  }

  const now = timestamp()
  const nextDomain = {
    ...domain,
    occupancies: [...domain.occupancies],
    maintenance: [...domain.maintenance],
    versions: { ...domain.versions },
  }
  const target = check.target

  if (input.action === '领用装备') {
    nextDomain.occupancies.push({
      id: nextId('OCC', nextDomain.occupancies),
      equipmentId: input.equipmentId,
      equipmentCode: String(row[CODE_FIELD]),
      teamCode: input.teamCode?.trim() || '',
      teamName: input.teamName!.trim(),
      specModel: String(row[SPEC_FIELD] ?? '').trim(),
      custodyForest: String(row[CUSTODY_FIELD] ?? '').trim(),
      purpose: input.purpose?.trim() ?? '出库领用',
      outAt: now,
      returnedAt: '',
      active: true,
    })
  }

  if (input.action === '回收入库' && active) {
    const index = nextDomain.occupancies.findIndex((item) => item.id === active.id)
    nextDomain.occupancies[index] = { ...active, returnedAt: now, active: false }
  }

  if (input.action === '送检登记') {
    nextDomain.maintenance.push({
      id: nextId('MNT', nextDomain.maintenance),
      equipmentId: input.equipmentId,
      equipmentCode: String(row[CODE_FIELD]),
      sentAt: now,
      returnedAt: '',
      note: input.note?.trim() || '送检登记',
    })
  }

  if (input.action === '检修完成') {
    const open = [...nextDomain.maintenance]
      .reverse()
      .find((item) => item.equipmentId === input.equipmentId && !item.returnedAt)
    if (open) {
      const index = nextDomain.maintenance.findIndex((item) => item.id === open.id)
      nextDomain.maintenance[index] = { ...open, returnedAt: now }
    }
  }

  if (input.action === '报废装备') {
    if (active) {
      const index = nextDomain.occupancies.findIndex((item) => item.id === active.id)
      nextDomain.occupancies[index] = {
        ...active,
        active: false,
        returnedAt: now,
        closedReason: 'scrapped',
      }
    }
    const open = nextDomain.maintenance.find(
      (item) => item.equipmentId === input.equipmentId && !item.returnedAt,
    )
    if (open) {
      const index = nextDomain.maintenance.findIndex((item) => item.id === open.id)
      nextDomain.maintenance[index] = { ...open, returnedAt: now, note: `${open.note}（装备报废，检修终止）` }
    }
  }

  // 外部占用清单同步核销：回收只核销同一支队伍的引用，报废全局核销。
  const revokeTeam = input.action === '回收入库' && active ? active.teamName : undefined
  const revokeGlobally = input.action === '报废装备'
  const synced: string[] = []
  const code = String(row[CODE_FIELD])

  // 行状态与外部清单在同一次提交里落盘，失败整批不落。
  commitAll((draft) => {
    const equipmentList = draft[MODULE_KEY]
    const index = equipmentList.findIndex((item) => Number(item.id) === input.equipmentId)
    equipmentList[index] = {
      ...equipmentList[index],
      status: target,
      pending: target !== LAST_STATUS,
      abnormal: false,
    }
    if (input.action === '送检登记' || input.action === '检修完成') {
      equipmentList[index][LATEST_REPAIR_FIELD] = now.slice(0, 10)
    }
    if (revokeTeam || revokeGlobally) {
      for (const slot of EQUIPMENT_REF_SLOTS) {
        for (const external of draft[slot.moduleKey] ?? []) {
          if (revokeRefFromRow(external, slot, code, revokeTeam)) {
            synced.push(`${slot.moduleKey}:${external.id}`)
          }
        }
      }
    }
  })

  nextDomain.versions[String(input.equipmentId)] = currentVersion + 1
  saveDomain(nextDomain)

  const suffix = synced.length ? `；已同步核销外部占用清单 ${synced.length} 处` : ''
  return {
    ok: true,
    accepted: true,
    message: `装备 ${code} 已${input.action}，当前状态「${target}」${suffix}`,
    equipmentId: input.equipmentId,
  }
}

/* --------------------------- 失败请求：断点续办 --------------------------- */

export function unresolvedFailures(): FailedRequest[] {
  return loadDomain()
    .failedRequests.filter((item) => !item.resolved)
    .sort((a, b) => (a.arrivedAt < b.arrivedAt ? -1 : 1))
}

export function retryFailure(id: string): Promise<EquipmentActionResult> {
  const domain = loadDomain()
  const record = domain.failedRequests.find((item) => item.id === id)
  if (!record) {
    return Promise.resolve({ ok: false, accepted: false, message: '失败记录不存在' })
  }
  // 续办同样排队：用断点当下的最新版本号做基线，成功就把失败记录核销掉。
  return enqueue(() => {
    const result = executeAction(
      {
        action: record.action,
        equipmentId: record.equipmentId,
        teamName: record.teamName,
        purpose: record.note,
      },
      rowVersion(record.equipmentId),
    )
    const latest = loadDomain()
    const index = latest.failedRequests.findIndex((item) => item.id === id)
    if (index >= 0) {
      const updated = {
        ...latest.failedRequests[index],
        retries: latest.failedRequests[index].retries + 1,
        resolved: result.ok,
        lastError: result.ok ? undefined : result.message,
      }
      latest.failedRequests = [
        ...latest.failedRequests.slice(0, index),
        updated,
        ...latest.failedRequests.slice(index + 1),
      ]
      saveDomain(latest)
    }
    return result
  })
}

export function clearResolvedFailures(): void {
  const domain = loadDomain()
  domain.failedRequests = domain.failedRequests.filter((item) => !item.resolved)
  saveDomain(domain)
}

/* ------------------------------ 迁移：可续跑 ------------------------------ */

export type MigrationSummary = {
  total: number
  done: number
  failed: number
  finished: boolean
  startedAt: string
  finishedAt: string
}

export function migrationSummary(): MigrationSummary {
  const migration = loadDomain().migration
  const failed = migration.items.filter((item) => item.status === 'failed').length
  return {
    total: migration.items.length,
    done: migration.items.filter((item) => item.status === 'done').length,
    failed,
    finished: migration.finishedAt !== '' && failed === 0,
    startedAt: migration.startedAt,
    finishedAt: migration.finishedAt,
  }
}

function equipmentIdsToMigrate(): number[] {
  const ids = new Set<number>(equipmentRows().map((row) => Number(row.id)))
  for (const legacy of LEGACY_OCCUPANCIES) {
    ids.add(legacy.equipmentId)
  }
  return [...ids].sort((a, b) => a - b)
}

/** 首次进入装备页时执行；之后调用只补跑失败断点，已成功的装备按断点跳过。 */
export function ensureMigrationRan(): MigrationSummary {
  const migration = loadDomain().migration
  if (migration.startedAt === '') {
    runMigration()
  } else if (migration.items.some((item) => item.status === 'failed')) {
    runMigration()
  }
  return migrationSummary()
}

export function runMigration(): MigrationSummary {
  const domain = loadDomain()
  const migration = domain.migration
  if (!migration.startedAt) {
    migration.startedAt = timestamp()
  }

  for (const equipmentId of equipmentIdsToMigrate()) {
    const existing = migration.items.find((item) => item.equipmentId === equipmentId)
    if (existing?.status === 'done') {
      continue
    }
    migrateOne(domain, equipmentId, existing)
  }

  // 一件都没迁（没有装备也没有旧账）不算完成；还有失败断点时 finishedAt 保持空。
  migration.finishedAt =
    migration.items.length > 0 && migration.items.every((item) => item.status === 'done')
      ? timestamp()
      : ''
  saveDomain(domain)
  return migrationSummary()
}

/** 单件装备迁移：占用核销、状态对齐、检修历史归并、外部清单同步，全部落同一笔账。 */
function migrateOne(
  domain: ReturnType<typeof loadDomain>,
  equipmentId: number,
  existing?: MigrationItem,
): void {
  const migration = domain.migration
  const item: MigrationItem =
    existing ??
    migration.items.find((row) => row.equipmentId === equipmentId) ?? {
      equipmentId,
      equipmentCode:
        LEGACY_OCCUPANCIES.find((row) => row.equipmentId === equipmentId)?.equipmentCode ??
        `#${equipmentId}`,
      status: 'failed',
      closedOccupancyIds: [],
      syncedRefs: [],
      warnings: [],
      attempts: 0,
      updatedAt: '',
    }
  if (!existing && !migration.items.includes(item)) {
    migration.items.push(item)
  }
  item.attempts += 1
  item.updatedAt = timestamp()

  try {
    const row = findRow(equipmentId)
    if (!row) {
      throw new Error('旧占用指向的装备已不存在，需补登记或手工核销后再从断点继续')
    }
    item.equipmentCode = String(row[CODE_FIELD])

    const warnings: string[] = []
    const legacyList = LEGACY_OCCUPANCIES.filter(
      (legacy) => legacy.equipmentId === equipmentId,
    ).sort((a, b) => (a.outAt < b.outAt ? -1 : 1))

    let keptActive = false
    const importedOccupancies: OccupancyRecord[] = []
    const closedTeamNames: string[] = []
    const rowStatus = String(row.status)

    for (const legacy of legacyList) {
      if (item.closedOccupancyIds.includes(legacy.id)) {
        continue
      }
      const canKeep =
        rowStatus === '已领用' && !keptActive && legacy.active && !legacy.returnedAt
      if (canKeep) {
        importedOccupancies.push({ ...legacy })
        keptActive = true
        continue
      }
      const reason: OccupancyRecord['closedReason'] =
        rowStatus === '已报废'
          ? 'scrapped'
          : legacy.returnedAt
            ? 'stale-closed'
            : 'duplicate-closed'
      importedOccupancies.push({
        ...legacy,
        active: false,
        returnedAt: legacy.returnedAt || item.updatedAt,
        closedReason: reason,
      })
      item.closedOccupancyIds = [...item.closedOccupancyIds, legacy.id]
      closedTeamNames.push(legacy.teamName)
      warnings.push(
        reason === 'scrapped'
          ? `装备已报废，旧占用「${legacy.id}」随报废核销`
          : reason === 'stale-closed'
            ? `旧占用「${legacy.id}」在回收后未解除，补核销`
            : `同装备存在重复占用「${legacy.id}（${legacy.teamName}）」，按先到原则保留一笔，其余核销`,
      )
    }

    if (rowStatus === '已领用' && !keptActive) {
      warnings.push('状态为已领用但没有任何有效占用，按占用台账回置为可用')
    }

    // 检修历史归并：上一条在修记录未关闭时，后到的送检/回退记录一律丢弃。
    const maintenance = LEGACY_MAINTENANCE.filter((record) => record.equipmentId === equipmentId)
      .slice()
      .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1))
    const importedMaintenance = []
    let openUntil = ''
    for (const record of maintenance) {
      if (openUntil && record.sentAt < openUntil) {
        warnings.push(`检修历史「${record.id}」与在修记录重叠（回退脏数据），迁移丢弃`)
        continue
      }
      importedMaintenance.push({ ...record })
      openUntil = record.returnedAt || '9999'
    }

    const targetStatus =
      rowStatus === '已报废'
        ? '已报废'
        : rowStatus === '待检修'
          ? '待检修'
          : keptActive
            ? '已领用'
            : '可用'
    const latestDate = importedMaintenance[0]
      ? [...importedMaintenance].sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))[0].sentAt.slice(0, 10)
      : ''

    const syncedNow: string[] = []
    commitAll((draft) => {
      const list = draft[MODULE_KEY]
      const index = list.findIndex((entry) => Number(entry.id) === equipmentId)
      list[index] = {
        ...list[index],
        status: targetStatus,
        pending: targetStatus !== LAST_STATUS,
        abnormal: false,
      }
      if (latestDate) {
        list[index][LATEST_REPAIR_FIELD] = latestDate
      }
      // 被核销占用对应队伍在外部清单里的装备编号同步核销；报废则全局核销。
      for (const slot of EQUIPMENT_REF_SLOTS) {
        for (const external of draft[slot.moduleKey] ?? []) {
          const locator = `${slot.moduleKey}:${external.id}`
          if (item.syncedRefs.includes(locator)) {
            continue
          }
          let touched = false
          if (targetStatus === '已报废') {
            touched = revokeRefFromRow(external, slot, item.equipmentCode)
          } else {
            for (const name of closedTeamNames) {
              if (revokeRefFromRow(external, slot, item.equipmentCode, name)) {
                touched = true
              }
            }
          }
          if (touched) {
            syncedNow.push(locator)
          }
        }
      }
    })

    const knownOcc = new Set(domain.occupancies.map((entry) => entry.id))
    domain.occupancies = [
      ...domain.occupancies,
      ...importedOccupancies.filter((entry) => !knownOcc.has(entry.id)),
    ]
    const knownMaint = new Set(domain.maintenance.map((entry) => entry.id))
    domain.maintenance = [
      ...domain.maintenance,
      ...importedMaintenance.filter((entry) => !knownMaint.has(entry.id)),
    ]
    domain.versions[String(equipmentId)] = Math.max(
      domain.versions[String(equipmentId)] ?? 0,
      1,
    )
    item.syncedRefs = [...item.syncedRefs, ...syncedNow]
    item.warnings = [...new Set([...item.warnings, ...warnings])]
    item.status = 'done'
    delete item.error
  } catch (error) {
    item.status = 'failed'
    item.error = error instanceof Error ? error.message : '迁移失败'
  }
}

export function migrationItems() {
  return [...loadDomain().migration.items].sort((a, b) => a.equipmentId - b.equipmentId)
}
