/**
 * 消防装备生命周期的共用写法。
 *
 * 状态迁移、占用核销、检修历史都不再由页面各写一套判断，而是统一落到同一份
 * 「只追加」事件流上：任何操作先追加事件，再由投影函数算出当前状态、有效
 * 占用和检修历史。历史记录因此不会被后来的操作改写或回退。
 */

/** 装备主状态：可用 → 已领用 →（回收）可用；可用/已领用 → 待检修 →（修竣）可用；任意在役 → 已报废。 */
export type EquipmentStatus = '可用' | '已领用' | '待检修' | '已报废'

/**
 * 生命周期事件。
 * - CHECKED_OUT   出库领用：产生一个有效占用
 * - RETURNED      回收入库：核销当前占用
 * - SENT_FOR_REPAIR 送检登记：占用随装备停用一并核销
 * - REPAIRED      修竣登记：装备回到可用
 * - SCRAPPED      报废装备：终态，占用一并核销
 * - WRITE_OFF     历史旧占用核销：只关占用，不改装备主状态（迁移补偿用）
 */
export type LifecycleEventType =
  | 'CHECKED_OUT'
  | 'RETURNED'
  | 'SENT_FOR_REPAIR'
  | 'REPAIRED'
  | 'SCRAPPED'
  | 'WRITE_OFF'

/** 占用来源：装备主表 / 其它模块的占用清单（如应急演练的使用装备）。 */
export type ClaimSource = 'equipment' | string

export type LifecycleEvent = {
  id: number
  type: LifecycleEventType
  /** 装备编号（业务编号，永不修改）。 */
  equipmentCode: string
  at: string
  teamName: string
  /** 来源说明，如「装备页出库」「历史迁移:应急演练#2」。 */
  origin: string
  /** 占用核销时指向要核销的占用来源记录，便于跨模块同步。 */
  claimRef?: string
}

/** 一条有效占用（一件装备在同一时刻最多一条）。 */
export type ActiveClaim = {
  equipmentCode: string
  teamName: string
  since: string
  origin: string
  claimRef?: string
}

/** 检修历史中的一条记录。 */
export type RepairRecord = {
  equipmentCode: string
  sentAt: string
  returnedAt?: string
  teamName: string
}

/** 单件装备的投影结果。 */
export type EquipmentLifecycle = {
  code: string
  status: EquipmentStatus
  activeClaim: ActiveClaim | null
  repairs: RepairRecord[]
  /** 该装备当前的事件版本（= 已应用到它身上的事件数），并发先到先得靠它比较。 */
  version: number
}

/** 失败的业务请求：持久化后可从断点重试，不会丢。 */
export type FailedRequest = {
  id: number
  kind: LifecycleEventType
  equipmentCode: string
  teamName: string
  origin: string
  /** 失败时装备的版本，重试用这个判断自己是不是迟到的那一个。 */
  baseVersion: number
  reason: string
  attempts: number
  createdAt: string
}

/** 历史迁移断点：按装备编号逐个推进，失败项可在数据修正后续跑。 */
export type MigrationState = {
  version: number
  status: 'idle' | 'running' | 'done'
  processedCodes: string[]
  failures: { equipmentRef: string; source: string; reason: string }[]
  migratedAt?: string
}

/** 持久化在 localStorage 里的完整生命周期状态。 */
export type EquipmentLifecycleState = {
  events: LifecycleEvent[]
  failed: FailedRequest[]
  migration: MigrationState
}

/** 其它模块里引用装备、需要同步核销的占用清单描述。 */
export type OccupationRegistryEntry = {
  /** 模块 key（对应 local-store 里的分表）。 */
  moduleKey: string
  label: string
  /** 填装备编号/规格型号的字段。 */
  equipmentField: string
  /** 占用队伍字段（可能为空）。 */
  teamField?: string
  /** 旧规格为空时的归属范围字段（保管林场）。 */
  scopeField?: string
  /** 这些状态说明占用已自然结束，不再参与迁移占用判定。 */
  terminalStatuses: string[]
}

/** 迁移时从各来源收集到的一条旧占用主张。 */
export type MigrationClaim = {
  /** 主张对应的装备编号；解析不出来时为空，进入失败清单。 */
  equipmentCode: string | null
  teamName: string
  claimedAt: string
  source: ClaimSource
  sourceLabel: string
  /** 跨模块来源时的模块 key 和行 id；装备主表来源 moduleKey 为 'equipment'。 */
  moduleKey: string
  rowId: number
  /** 原始引用文本（使用装备字段里填的内容）。 */
  rawRef: string
  /** 归属范围：旧规格为空时按保管林场兼容。 */
  scope: string
}
