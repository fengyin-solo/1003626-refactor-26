import type { EntryRow } from './types'

/**
 * 别的模块里引用装备的「占用清单」槽位。装备回收/报废核销占用时，
 * 这些槽位里对应的装备编号要同步核销，不能装备回来了演练还挂着占用。
 *
 * 槽位值可能是「EQUI-0001、EQUI-0002」这样的多值文本，统一按分隔符拆词核销。
 */
export type EquipmentRefSlot = {
  moduleKey: string
  field: string
  /** 槽位所在行里用于辨别「哪支队伍占的」字段；为空表示不区分队伍。 */
  teamField?: string
}

export const EQUIPMENT_REF_SLOTS: EquipmentRefSlot[] = [
  { moduleKey: 'drill', field: '使用装备', teamField: '参演队伍' },
]

const REF_SPLITTERS = /[、,，;；\s/|]+/

export function splitRefs(value: unknown): string[] {
  return String(value ?? '')
    .split(REF_SPLITTERS)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function joinRefs(codes: string[]): string {
  return codes.join('、')
}

/**
 * 从一行外部清单里核销指定装备编号：
 * - teamName 为空：全局核销该编号（装备报废等场景）；
 * - teamName 不为空：只有这一行的队伍槽位也指向同一支队伍时才核销（回收场景）。
 * 返回 true 表示这一行被改动过。
 */
export function revokeRefFromRow(
  row: EntryRow,
  slot: EquipmentRefSlot,
  code: string,
  teamName?: string,
): boolean {
  const codes = splitRefs(row[slot.field])
  if (!codes.includes(code)) {
    return false
  }
  if (teamName && slot.teamField) {
    const owner = String(row[slot.teamField] ?? '')
    if (owner.trim() !== teamName.trim()) {
      return false
    }
  }
  const next = codes.filter((item) => item !== code)
  row[slot.field] = next.length ? joinRefs(next) : ''
  return true
}
