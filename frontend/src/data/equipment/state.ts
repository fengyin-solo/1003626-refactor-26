import type {
  ActiveClaim,
  EquipmentLifecycle,
  EquipmentStatus,
  LifecycleEvent,
  LifecycleEventType,
  RepairRecord,
} from './types'

/**
 * 唯一的状态迁移表：出库/回收/送检/修竣/报废都走这里，页面和迁移脚本都不允许
 * 再各自直接改 status。键为「当前状态 + 事件」，值为迁移后的状态。
 */
const TRANSITIONS: Record<LifecycleEventType, Partial<Record<EquipmentStatus, EquipmentStatus>>> = {
  CHECKED_OUT: { 可用: '已领用' },
  RETURNED: { 已领用: '可用' },
  SENT_FOR_REPAIR: { 可用: '待检修', 已领用: '待检修' },
  REPAIRED: { 待检修: '可用' },
  SCRAPPED: { 可用: '已报废', 已领用: '已报废', 待检修: '已报废' },
  // 旧占用核销不改装备主状态，只关占用。
  WRITE_OFF: {},
}

/** 回收、送检、报废都会让占用失效；出库才会建立占用。 */
const CLAIM_CLOSING_EVENTS: LifecycleEventType[] = ['RETURNED', 'SENT_FOR_REPAIR', 'SCRAPPED', 'WRITE_OFF']

/** 同一状态+事件是否允许迁移。WRITE_OFF 是定向旧占用核销，任何主状态下都允许落账。 */
export function canTransit(status: EquipmentStatus, type: LifecycleEventType): boolean {
  if (type === 'WRITE_OFF') {
    return true
  }
  return TRANSITIONS[type][status] !== undefined
}

/** 返回迁移后的状态；非法迁移返回 null。 */
export function nextStatus(status: EquipmentStatus, type: LifecycleEventType): EquipmentStatus | null {
  if (type === 'WRITE_OFF') {
    return status
  }
  return TRANSITIONS[type][status] ?? null
}

/** 占用是否被该事件核销：关占用事件无条件关；出库由投影层保证先关后开。 */
export function closesClaim(type: LifecycleEventType): boolean {
  return CLAIM_CLOSING_EVENTS.includes(type)
}

/**
 * 把某件装备的事件按追加顺序投影成当前快照。
 * 不变量：任何时刻 activeClaim 至多一条——出库事件先核销旧占用再建立新占用。
 */
export function projectLifecycle(code: string, events: LifecycleEvent[]): EquipmentLifecycle {
  let status: EquipmentStatus = '可用'
  let activeClaim: ActiveClaim | null = null
  // 未闭合的送检记录按顺序入栈，修竣事件闭合最近一条；多次送检也能各自闭环。
  const openRepairs: RepairRecord[] = []
  const finishedRepairs: RepairRecord[] = []

  for (const event of events) {
    switch (event.type) {
      case 'CHECKED_OUT': {
        // 定向建立占用：只有「同一条占用主张的重复出库」才替换当前占用（迁移重跑幂等）；
        // 不同 claimRef 的出库不允许在这里抢占用——服务层会拒绝，这里保留原占用，
        // 从投影层兜底「一件装备一个有效占用」。
        const sameClaim =
          event.claimRef !== undefined &&
          activeClaim?.claimRef !== undefined &&
          event.claimRef === activeClaim.claimRef
        if (activeClaim && !sameClaim) {
          break
        }
        activeClaim = {
          equipmentCode: code,
          teamName: event.teamName,
          since: event.at,
          origin: event.origin,
          claimRef: event.claimRef,
        }
        status = '已领用'
        break
      }
      case 'RETURNED':
      case 'SCRAPPED': {
        activeClaim = null
        status = event.type === 'SCRAPPED' ? '已报废' : '可用'
        break
      }
      case 'WRITE_OFF': {
        // 定向核销：只关与自己指向同一条旧占用（claimRef 相同）的占用；
        // 无 claimRef 的老核销记录按队伍名匹配，避免误关后来胜出的占用。
        if (!activeClaim) {
          break
        }
        const sameRef =
          event.claimRef !== undefined &&
          activeClaim.claimRef !== undefined &&
          event.claimRef === activeClaim.claimRef
        const sameTeam = event.claimRef === undefined && activeClaim.teamName === event.teamName
        if (sameRef || sameTeam) {
          activeClaim = null
        }
        break
      }
      case 'SENT_FOR_REPAIR': {
        activeClaim = null
        status = '待检修'
        // 迁移初态没有可靠送检日期时不进检修历史（避免空白记录），但仍参与状态迁移；
        // 后续修竣事件只闭合有日期的记录。
        if (event.at) {
          openRepairs.push({
            equipmentCode: code,
            sentAt: event.at,
            teamName: event.teamName,
          })
        }
        break
      }
      case 'REPAIRED': {
        const open = openRepairs.pop()
        if (open) {
          finishedRepairs.push({ ...open, returnedAt: event.at })
        }
        status = '可用'
        break
      }
    }
  }

  const repairs = [...finishedRepairs, ...openRepairs].sort((a, b) =>
    a.sentAt < b.sentAt ? 1 : -1,
  )

  return { code, status, activeClaim, repairs, version: events.length }
}

/** 投影全部事件，返回按装备编号索引的快照表（只包含至少有一条事件的装备）。 */
export function projectAll(events: LifecycleEvent[]): Map<string, EquipmentLifecycle> {
  const grouped = new Map<string, LifecycleEvent[]>()
  for (const event of events) {
    const list = grouped.get(event.equipmentCode)
    if (list) {
      list.push(event)
    } else {
      grouped.set(event.equipmentCode, [event])
    }
  }
  const result = new Map<string, EquipmentLifecycle>()
  for (const [code, list] of grouped) {
    result.set(code, projectLifecycle(code, list))
  }
  return result
}
