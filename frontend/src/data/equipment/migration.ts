import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { OCCUPATION_REGISTRY, resolveEquipmentRef, toCandidates } from './references'
import type {
  LifecycleEvent,
  MigrationClaim,
  OccupationRegistryEntry,
} from './types'

/** 迁移结构版本：以后迁移规则再演进时靠它决定是否重跑。 */
export const MIGRATION_VERSION = 1

/** 跨模块清单里需要打上核销标记的行。 */
export type DismissalMark = { moduleKey: string; rowId: number }

export type MigrationPlan = {
  /** 按追加顺序排列的新事件（同装备的核销事件在出库事件之前）。 */
  events: LifecycleEvent[]
  failures: { equipmentRef: string; source: string; reason: string }[]
  dismissals: DismissalMark[]
  codes: string[]
}

function rowId(row: EntryRow): number {
  return Number(row.id)
}

function isTerminal(row: EntryRow, registry: OccupationRegistryEntry): boolean {
  return registry.terminalStatuses.includes(String(row.status ?? ''))
}

/**
 * 收集所有旧占用主张。
 * 判定口径统一为：装备真正出库只看装备主表是否「已领用」；其它模块清单里的
 * 非终态引用都是占用主张，需要与主表对齐，解决两套互相矛盾的判断。
 */
export function collectClaims(
  equipmentRows: EntryRow[],
  registryRows: { registry: OccupationRegistryEntry; rows: EntryRow[] }[],
): { claims: MigrationClaim[]; failures: MigrationPlan['failures'] } {
  const claims: MigrationClaim[] = []
  const failures: MigrationPlan['failures'] = []
  const candidates = toCandidates(equipmentRows.filter((row) => String(row['装备编号'] ?? '').trim() !== ''))

  for (const row of equipmentRows) {
    if (String(row.status) !== '已领用') {
      continue
    }
    claims.push({
      equipmentCode: String(row['装备编号'] ?? ''),
      teamName: '',
      claimedAt: '',
      source: 'equipment',
      sourceLabel: `装备主表#${rowId(row)}`,
      moduleKey: 'equipment',
      rowId: rowId(row),
      rawRef: String(row['装备编号'] ?? ''),
      scope: String(row['保管林场'] ?? ''),
    })
  }

  for (const { registry, rows } of registryRows) {
    for (const row of rows) {
      if (isTerminal(row, registry)) {
        continue
      }
      const rawRef = String(row[registry.equipmentField] ?? '').trim()
      if (!rawRef) {
        continue
      }
      const scope = registry.scopeField ? String(row[registry.scopeField] ?? '') : ''
      const resolved = resolveEquipmentRef(rawRef, scope, candidates)
      const sourceLabel = `${registry.label}#${rowId(row)}`
      if (resolved.ambiguous) {
        failures.push({
          equipmentRef: rawRef,
          source: sourceLabel,
          reason: `引用在 ${resolved.candidates.join('、')} 之间存在多义，请补全装备编号或规格型号`,
        })
        continue
      }
      if (!resolved.code) {
        failures.push({
          equipmentRef: rawRef,
          source: sourceLabel,
          reason: '引用匹配不到任何在册装备（编号不一致、规格不唯一且无保管林场归属）',
        })
        continue
      }
      claims.push({
        equipmentCode: resolved.code,
        teamName: registry.teamField ? String(row[registry.teamField] ?? '').trim() : '',
        claimedAt: '',
        source: registry.moduleKey,
        sourceLabel,
        moduleKey: registry.moduleKey,
        rowId: rowId(row),
        rawRef,
        scope,
      })
    }
  }

  return { claims, failures }
}

/**
 * 生成迁移计划。
 * 同一装备编号的占用主张只保留一个：
 *   - 装备主表「已领用」为主张胜出（装备生命周期是占用真相）；
 *     队伍缺失时，取该装备最早一条跨模块主张的队伍补齐（先到先得）；
 *   - 主表不在「已领用」的，所有跨模块主张一律视为回收后未解除的旧占用，定向核销；
 *   - 胜出主张之外的跨模块主张生成 WRITE_OFF 并回写核销标记。
 * 装备编号全程不改；规格为空时的兼容匹配在 resolveEquipmentRef 内完成。
 */
export function planMigration(
  equipmentRows: EntryRow[],
  registryRows: { registry: OccupationRegistryEntry; rows: EntryRow[] }[],
  now: string,
  nextEventId: () => number,
): MigrationPlan {
  const { claims, failures } = collectClaims(equipmentRows, registryRows)
  const dismissals: DismissalMark[] = []
  const events: LifecycleEvent[] = []
  const codes = new Set<string>()

  const grouped = new Map<string, { master?: MigrationClaim; others: MigrationClaim[] }>()
  for (const claim of claims) {
    codes.add(claim.equipmentCode ?? '')
    const bucket = grouped.get(claim.equipmentCode ?? '') ?? { others: [] }
    if (claim.source === 'equipment') {
      // 同一装备编号在主表出现多行属于历史脏数据，只认最早一行，迁移后投影只留一个占用。
      if (!bucket.master) {
        bucket.master = claim
      }
    } else {
      bucket.others.push(claim)
    }
    grouped.set(claim.equipmentCode ?? '', bucket)
  }
  // 跨模块主张按来源登记顺序、行号排列，保证「最早一条」可复现。
  const registryOrder = new Map(OCCUPATION_REGISTRY.map((entry, index) => [entry.moduleKey, index]))
  const sortOthers = (list: MigrationClaim[]) =>
    list.sort((a, b) => {
      const rankA = registryOrder.get(a.source) ?? 99
      const rankB = registryOrder.get(b.source) ?? 99
      if (rankA !== rankB) return rankA - rankB
      if (a.rowId !== b.rowId) return a.rowId - b.rowId
      return a.teamName < b.teamName ? -1 : 1
    })

  const makeEvent = (
    type: LifecycleEvent['type'],
    claim: MigrationClaim,
    claimRef: string,
  ): LifecycleEvent => ({
    id: nextEventId(),
    type,
    equipmentCode: claim.equipmentCode ?? '',
    at: type === 'CHECKED_OUT' ? '' : now,
    teamName: claim.teamName || '历史领用队伍（未登记）',
    origin: `历史迁移:${claim.sourceLabel}`,
    claimRef,
  })

  for (const [code, bucket] of [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!code) {
      continue
    }
    const others = sortOthers(bucket.others)

    if (bucket.master) {
      // 与胜出占用同一条的跨模块主张（队伍一致且最早）视为同一占用的两处登记，保留不核销。
      let aligned: MigrationClaim | null = null
      if (bucket.master.teamName) {
        aligned = others.find((claim) => claim.teamName === bucket.master!.teamName) ?? null
      } else if (others.length > 0) {
        aligned = others[0]
        bucket.master = { ...bucket.master, teamName: aligned.teamName || bucket.master.teamName }
      }
      for (const loser of others) {
        if (loser === aligned) {
          continue
        }
        events.push(makeEvent('WRITE_OFF', loser, loser.sourceLabel))
        if (loser.moduleKey !== 'equipment') {
          dismissals.push({ moduleKey: loser.moduleKey, rowId: loser.rowId })
        }
      }
      events.push({
        id: nextEventId(),
        type: 'CHECKED_OUT',
        equipmentCode: code,
        at: '',
        teamName: bucket.master.teamName || '历史领用队伍（未登记）',
        origin: `历史迁移:${bucket.master.sourceLabel}`,
        claimRef: bucket.master.sourceLabel,
      })
    } else {
      // 装备并不在领用态：跨模块清单里的占用全是回收/停用后没解除的旧账。
      for (const stale of others) {
        events.push(makeEvent('WRITE_OFF', stale, stale.sourceLabel))
        if (stale.moduleKey !== 'equipment') {
          dismissals.push({ moduleKey: stale.moduleKey, rowId: stale.rowId })
        }
      }
    }
  }

  // 主表初态里的待检修/已报废也要进入统一事件流，检修历史与终态才完整。
  // 占用裁决按装备编号收敛：若该编号已有胜出领用占用（可能来自重复编号行），
  // 以占用真相为准，不再追加会把状态改成待检修/报废的初态事件。
  for (const row of equipmentRows) {
    const code = String(row['装备编号'] ?? '')
    if (!code) {
      continue
    }
    codes.add(code)
    const status = String(row.status)
    if ((status === '待检修' || status === '已报废') && grouped.get(code)?.master) {
      continue
    }
    const ref = `装备主表#${rowId(row)}`
    if (status === '待检修') {
      events.push({
        id: nextEventId(),
        type: 'SENT_FOR_REPAIR',
        equipmentCode: code,
        at: '',
        teamName: '',
        origin: `历史迁移:${ref}(待检修初态)`,
        claimRef: `${ref}:送检`,
      })
    } else if (status === '已报废') {
      events.push({
        id: nextEventId(),
        type: 'SCRAPPED',
        equipmentCode: code,
        at: '',
        teamName: '',
        origin: `历史迁移:${ref}(已报废初态)`,
        claimRef: `${ref}:报废`,
      })
    }
  }

  // 统一排序：同装备编号下先建立胜出占用，再追加旧占用核销与初态停用事件，
  // 保证重复编号行等脏数据也不会把胜出占用核销掉。
  const eventRank: Record<LifecycleEvent['type'], number> = {
    CHECKED_OUT: 0,
    WRITE_OFF: 1,
    SENT_FOR_REPAIR: 2,
    RETURNED: 2,
    SCRAPPED: 3,
    REPAIRED: 4,
  }
  events.sort((a, b) => {
    if (a.equipmentCode !== b.equipmentCode) {
      return a.equipmentCode < b.equipmentCode ? -1 : 1
    }
    if (eventRank[a.type] !== eventRank[b.type]) {
      return eventRank[a.type] - eventRank[b.type]
    }
    return a.id - b.id
  })

  // 重复编号行可能为同一装备生成 claimRef 相同的初态事件，迁移计划自身先去重，
  // 保证「跑一遍」与「重跑一遍」追加的事件集合一致（幂等）。
  const seenRefs = new Set<string>()
  const deduped = events.filter((event) => {
    if (!event.claimRef || !seenRefs.has(event.claimRef)) {
      if (event.claimRef) {
        seenRefs.add(event.claimRef)
      }
      return true
    }
    return false
  })

  return { events: deduped, failures, dismissals, codes: [...codes].filter(Boolean).sort() }
}

/** 便于服务层读取其它模块清单。 */
export function loadRegistryRows(): { registry: OccupationRegistryEntry; rows: EntryRow[] }[] {
  return OCCUPATION_REGISTRY.map((registry) => ({ registry, rows: listRows(registry.moduleKey) }))
}
