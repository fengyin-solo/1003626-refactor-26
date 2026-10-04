import type { MaintenanceRecord, OccupancyRecord } from './equipment-types'

/**
 * 迁移前的旧账：上线前系统里同时存在两套互相矛盾的占用判断——
 * 一套按装备行「已领用」状态判占用，另一套按规格型号整批判占用，
 * 同一件装备被重复记成占用、回收后旧账也不核销。这里把旧账原样固化下来，
 * 迁移只从这里读取并核销，业务运行期不再产生 legacy 记录。
 *
 * 装备编号（EQUI-xxxx）在迁移全程保持不变，兼容分组只用于查找展示。
 */
export const LEGACY_OCCUPANCIES: OccupancyRecord[] = [
  {
    id: 'LEG-OCC-0001',
    equipmentId: 1,
    equipmentCode: 'EQUI-0001',
    teamCode: 'FIRE-0001',
    teamName: '扑火一队',
    specModel: 'XFC-8 风力灭火机',
    custodyForest: '青松林场',
    purpose: '9月巡护出库',
    outAt: '2026-09-05 08:10',
    returnedAt: '',
    active: true,
    legacy: true,
  },
  {
    id: 'LEG-OCC-0002',
    equipmentId: 1,
    equipmentCode: 'EQUI-0001',
    teamCode: 'FIRE-0002',
    teamName: '扑火二队',
    specModel: 'XFC-8 风力灭火机',
    custodyForest: '青松林场',
    purpose: '同规格二次出库（矛盾账）',
    outAt: '2026-09-06 09:30',
    returnedAt: '',
    active: true,
    legacy: true,
  },
  {
    id: 'LEG-OCC-0003',
    equipmentId: 2,
    equipmentCode: 'EQUI-0002',
    teamCode: 'FIRE-0001',
    teamName: '扑火一队',
    specModel: 'DPR-22 接力水泵',
    custodyForest: '白桦林场',
    purpose: '演练出库',
    outAt: '2026-08-20 14:00',
    returnedAt: '2026-08-25 17:40',
    active: true, // 回收后旧占用没有解除：账上仍挂着占用
    legacy: true,
  },
  {
    id: 'LEG-OCC-0004',
    equipmentId: 3,
    equipmentCode: 'EQUI-0003',
    teamCode: 'FIRE-0003',
    teamName: '扑火三队',
    specModel: 'XYD-3 油锯',
    custodyForest: '青松林场',
    purpose: '隔离带开设',
    outAt: '2026-08-10 07:50',
    returnedAt: '2026-08-12 16:20',
    active: true, // 装备已送检，旧占用同样没核销
    legacy: true,
  },
  {
    id: 'LEG-OCC-0005',
    equipmentId: 4,
    equipmentCode: 'EQUI-0004',
    teamCode: 'FIRE-0002',
    teamName: '扑火二队',
    specModel: '', // 旧规格为空：迁移按保管林场兼容
    custodyForest: '白桦林场',
    purpose: '老批次散装备出库',
    outAt: '2026-07-18 10:00',
    returnedAt: '',
    active: true,
    legacy: true,
  },
  {
    id: 'LEG-OCC-0006',
    equipmentId: 5,
    equipmentCode: 'EQUI-0005',
    teamCode: 'FIRE-0001',
    teamName: '扑火一队',
    specModel: '', // 同规格为空但保管林场不同，不能并成同一把锁
    custodyForest: '青松林场',
    purpose: '新批次散装备出库',
    outAt: '2026-09-02 11:00',
    returnedAt: '',
    active: true,
    legacy: true,
  },
  {
    id: 'LEG-OCC-0007',
    equipmentId: 999,
    equipmentCode: 'EQUI-9999', // 指向已不存在的装备：迁移断点失败，可后续从断点继续
    teamCode: 'FIRE-0003',
    teamName: '扑火三队',
    specModel: 'XFC-8 风力灭火机',
    custodyForest: '青松林场',
    purpose: '历史遗留悬挂占用',
    outAt: '2026-06-01 09:00',
    returnedAt: '',
    active: true,
    legacy: true,
  },
]

/**
 * 旧检修历史：含一条非法的「检修中 → 已领用」回退记录，迁移时按共用状态机校验丢弃，
 * 不再让历史把装备状态带回已领用。
 */
export const LEGACY_MAINTENANCE: MaintenanceRecord[] = [
  {
    id: 'LEG-MNT-0001',
    equipmentId: 3,
    equipmentCode: 'EQUI-0003',
    sentAt: '2026-07-02 09:00',
    returnedAt: '2026-07-05 16:00',
    note: '例行保养（旧账）',
  },
  {
    id: 'LEG-MNT-0002',
    equipmentId: 3,
    equipmentCode: 'EQUI-0003',
    sentAt: '2026-08-12 08:30',
    returnedAt: '',
    note: '链条异响送检，尚未取回（旧账在修）',
  },
  {
    id: 'LEG-MNT-0003',
    equipmentId: 3,
    equipmentCode: 'EQUI-0003',
    sentAt: '2026-08-13 09:00',
    returnedAt: '2026-08-13 15:00',
    note: '非法回退：检修中直接记成已领用出库（旧账脏数据，迁移丢弃）',
  },
]
