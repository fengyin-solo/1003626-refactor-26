import type { EntryRow } from '@/data/types'
import type { OccupationRegistryEntry } from './types'

/**
 * 其它模块里引用消防装备的占用清单。
 *
 * 目前只有应急演练的「使用装备」字段；以后再接模块只需在这里登记一行，
 * 出库/回收的同步核销和历史迁移都会自动覆盖它。
 */
export const OCCUPATION_REGISTRY: OccupationRegistryEntry[] = [
  {
    moduleKey: 'drill',
    label: '应急演练',
    equipmentField: '使用装备',
    teamField: '参演队伍',
    scopeField: undefined,
    terminalStatuses: ['已实施', '已总结', '已归档'],
  },
]

/** 跨模块清单里写入的核销标记字段（不改动它们原本的状态机）。 */
export const CLAIM_DISMISS_FIELD = '占用核销'
export const CLAIM_DISMISSED_MARK = '已随装备回收核销'

export type ResolveResult =
  | { code: string; ambiguous: false }
  | { code: null; ambiguous: true; candidates: string[] }
  | { code: null; ambiguous: false }

export type EquipmentCandidate = {
  code: string
  spec: string
  scope: string
}

/**
 * 把其它模块里填的装备引用解析到唯一一件装备。
 * 解析顺序（修复「按规格型号把同型号发给两支队伍」的老问题）：
 *   1. 引用文本就是装备编号（精确）；
 *   2. 规格型号非空且全库唯一（兼容老数据）；
 *   3. 旧规格为空：按保管林场归属范围兼容，范围内唯一才成立。
 * 任何一步出现多义都返回 ambiguous，进失败清单，等数据补齐后可从断点继续。
 * 装备编号本身在整个流程里从不被修改。
 */
export function resolveEquipmentRef(
  refText: string,
  scope: string,
  equipment: EquipmentCandidate[],
): ResolveResult {
  const ref = refText.trim()
  if (!ref) {
    return { code: null, ambiguous: false }
  }

  const byCode = equipment.filter((item) => item.code === ref)
  if (byCode.length === 1) {
    return { code: byCode[0].code, ambiguous: false }
  }

  const bySpec = equipment.filter((item) => item.spec.trim() !== '' && item.spec === ref)
  if (bySpec.length === 1) {
    return { code: bySpec[0].code, ambiguous: false }
  }
  if (bySpec.length > 1) {
    return { code: null, ambiguous: true, candidates: bySpec.map((item) => item.code) }
  }

  // 旧规格为空：由本系统统一按保管林场兼容（不按购入批次——归属林场是装备页现成字段，
  // 也是其它模块清单唯一能对上的范围信息）。
  // 引用文本尾部括号里的「XX林场」是台账常见写法，作为归属范围的兜底来源。
  const parenScope = ref.match(/[（(]([^（）()]*林场)[）)]\s*$/)
  const effectiveScope = scope.trim() || (parenScope ? parenScope[1] : '')
  if (effectiveScope) {
    const inScope = equipment.filter((item) => item.scope === effectiveScope)
    if (inScope.length === 1) {
      return { code: inScope[0].code, ambiguous: false }
    }
    if (inScope.length > 1) {
      return { code: null, ambiguous: true, candidates: inScope.map((item) => item.code) }
    }
  }

  return { code: null, ambiguous: false }
}

/** 从装备主表行构造解析用候选：规格为空时只剩编号和保管林场两列可用。 */
export function toCandidates(rows: EntryRow[]): EquipmentCandidate[] {
  return rows.map((row) => ({
    code: String(row['装备编号'] ?? ''),
    spec: String(row['规格型号'] ?? ''),
    scope: String(row['保管林场'] ?? ''),
  }))
}
