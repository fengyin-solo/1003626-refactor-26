import type { ActionResult } from './types'

/**
 * 消防装备域的共用模型：状态迁移、占用核销、检修历史三套写法收拢到这里，
 * 页面与 local-service 都只读本文件，不再各判各的。
 */

/** 装备在占用台账里的归属键：就是装备行 id（不允许改装备编号，更不允许换身份）。 */
export type EquipmentKey = number

/** 一条占用记录：一件装备同一时刻只允许一条 active。 */
export type OccupancyRecord = {
  id: string
  equipmentId: EquipmentKey
  equipmentCode: string
  teamCode: string
  teamName: string
  /** 旧规格为空时回填的兼容分组：保管林场（购入批次字段在现有数据里不存在，见 README）。 */
  specModel: string
  custodyForest: string
  purpose: string
  outAt: string
  /** 回收/核销时间；active 时为空字符串。 */
  returnedAt: string
  active: boolean
  /** 迁移从旧账里带出来的占用标记，便于追踪。 */
  legacy?: boolean
  /** 同一装备存在多笔旧占用时，被核销的那几笔带上原因。 */
  closedReason?: 'duplicate-closed' | 'stale-closed' | 'scrapped'
}

/** 检修历史：只追加，不覆盖；「最近检修日」是它的投影。 */
export type MaintenanceRecord = {
  id: string
  equipmentId: EquipmentKey
  equipmentCode: string
  sentAt: string
  returnedAt: string
  note: string
}

/** 迁移断点：每件装备一条，失败可按装备粒度从断点继续。 */
export type MigrationItem = {
  equipmentId: EquipmentKey
  equipmentCode: string
  status: 'done' | 'failed'
  /** 已成功核销的旧占用 id，重跑时跳过。 */
  closedOccupancyIds: string[]
  /** 已同步核销过的外部清单定位（模块:行id），重跑不重复删。 */
  syncedRefs: string[]
  /** 迁移中发现并修掉的脏数据说明（比如丢弃的回退历史）。 */
  warnings: string[]
  error?: string
  attempts: number
  updatedAt: string
}

export type MigrationState = {
  version: number
  startedAt: string
  finishedAt: string
  items: MigrationItem[]
}

/** 并发出库/回收的失败留痕：先到的赢，后到的在这儿排队等「从断点继续」。 */
export type FailedRequest = {
  id: string
  equipmentId: EquipmentKey
  equipmentCode: string
  action: string
  teamName?: string
  note?: string
  /** 入队时的装备版本；执行时版本对不上说明已有先到请求落盘，本请求判负。 */
  baseVersion: number
  reason: string
  arrivedAt: string
  retries: number
  lastError?: string
  resolved: boolean
}

export type EquipmentDomain = {
  version: number
  occupancies: OccupancyRecord[]
  maintenance: MaintenanceRecord[]
  migration: MigrationState
  /** 每件装备的乐观锁版本号，先到先得的判据。 */
  versions: Record<string, number>
  failedRequests: FailedRequest[]
}

export type EquipmentActionInput = {
  action: string
  equipmentId: EquipmentKey
  teamCode?: string
  teamName?: string
  purpose?: string
  note?: string
}

export type EquipmentActionResult = ActionResult & {
  /** 并发判负时为 false，请求会被写进失败清单，可断点续跑。 */
  accepted: boolean
  equipmentId?: EquipmentKey
}
