/* eslint-disable no-console */
// 装备域迁移/占用/并发的逻辑校验：esbuild 打包后在 node 里跑，手工 shim localStorage。
import {
  activeOccupancyOf,
  ensureMigrationRan,
  listEntries,
  listRows,
  maintenanceHistory,
  migrationItems,
  migrationSummary,
  occupancyHistory,
  resetRows,
  retryFailure,
  runMigration,
  saveRows,
  submitEquipmentAction,
  unresolvedFailures,
} from '../src/api/local-service'
import { resetDomain } from '../src/data/equipment-store'

function assert(condition: unknown, message: string) {
  if (!condition) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${message}`)
  }
}

async function main() {
  // 1. 迁移
  const summary = ensureMigrationRan()
  console.log('迁移摘要:', JSON.stringify(summary))
  const equipment = listRows('equipment')
  const byCode = new Map(equipment.map((row) => [String(row['装备编号']), row]))

  assert(summary.total === 7, `迁移覆盖 7 件装备（含悬挂账），实际 ${summary.total}`)
  assert(summary.done === 6, `6 件成功，实际 ${summary.done}`)
  assert(summary.failed === 1, `1 件悬挂失败，实际 ${summary.failed}`)

  // EQUI-0001：两笔重复旧占用只留一笔（先到的一队），二队核销
  const occ1 = occupancyHistory(1)
  const active1 = occ1.filter((o) => o.active)
  assert(active1.length === 1, `EQUI-0001 只保留 1 个有效占用，实际 ${active1.length}`)
  assert(active1[0]?.teamName === '扑火一队', 'EQUI-0001 保留先到的扑火一队')
  assert(
    occ1.some((o) => !o.active && o.teamName === '扑火二队' && o.closedReason === 'duplicate-closed'),
    'EQUI-0001 后到的扑火二队按重复占用核销',
  )
  assert(String(byCode.get('EQUI-0001')?.status) === '已领用', 'EQUI-0001 状态保持已领用')

  // EQUI-0002：回收后旧占用解除，状态回置可用
  assert(!activeOccupancyOf(2), 'EQUI-0002 回收后旧占用已解除')
  assert(String(byCode.get('EQUI-0002')?.status) === '可用', 'EQUI-0002 回置为可用')

  // EQUI-0003：送检装备旧占用核销，状态保持待检修，回退历史被丢弃
  assert(!activeOccupancyOf(3), 'EQUI-0003 旧占用随送检核销')
  assert(String(byCode.get('EQUI-0003')?.status) === '待检修', 'EQUI-0003 保持待检修')
  const mnt3 = maintenanceHistory(3)
  assert(mnt3.length === 2, `EQUI-0003 检修历史 2 条（回退脏数据丢弃），实际 ${mnt3.length}`)
  assert(String(byCode.get('EQUI-0003')?.['最近检修日']) === '2026-08-12', '最近检修日投影为最新送检日')

  // EQUI-0004/0005：规格为空按保管林场兼容，各自占用独立保留
  assert(activeOccupancyOf(4)?.teamName === '扑火二队', 'EQUI-0004（白桦林场）占用保留')
  assert(activeOccupancyOf(5)?.teamName === '扑火一队', 'EQUI-0005（青松林场）占用保留')

  // 外部清单同步核销
  const drill = listRows('drill')
  const drillUsage = new Map(drill.map((row) => [row.id, String(row['使用装备'])]))
  assert(drillUsage.get(1) === '', `DRIL-0001 一队占用 EQUI-0002 与 EQUI-0006（报废）均被核销，实际「${drillUsage.get(1)}」`)
  assert(drillUsage.get(2) === '', `DRIL-0002 二队重复占用引用被核销，实际「${drillUsage.get(2)}」`)
  assert(drillUsage.get(3) === '', `DRIL-0003 三队旧占用引用被核销，实际「${drillUsage.get(3)}」`)

  // 断点：悬挂占用失败并可反复尝试（此处没有补登记，保持失败）
  const failed = migrationItems().find((i) => i.equipmentId === 999)
  assert(failed?.status === 'failed' && failed.attempts === 1, '悬挂占用在断点处标记失败')
  runMigration()
  assert(migrationItems().find((i) => i.equipmentId === 999)?.attempts === 2, '断点续跑只重试失败项，成功项不重复处理')
  const stillSix = migrationSummary().done
  assert(stillSix === 6, `成功项保持 6 件不重复迁移，实际 ${stillSix}`)

  // 断点恢复路径：悬挂账的 equipmentId=999 指向不存在的行；补登记同 id 装备后续跑应全部完成
  runMigration()
  assert(migrationSummary().failed === 1, '补录行 id 不匹配时悬挂账仍失败，符合断点语义')
  const rowsNow = listRows('equipment')
  saveRows('equipment', [
    ...rowsNow,
    {
      id: 999,
      status: '已领用',
      pending: true,
      abnormal: false,
      装备编号: 'EQUI-9999',
      装备名称: '补登记装备',
      装备类型: '扑救机具',
      规格型号: 'XFC-8 风力灭火机',
      保管林场: '青松林场',
      购入日期: '2026-01-01',
      最近检修日: '',
      装备状态: '良好',
    },
  ])
  const afterFill = runMigration()
  assert(afterFill.failed === 0 && afterFill.done === 7, '补齐装备后从断点继续，7 件全部迁移完成')

  // 2. 运行期：同一件装备并发领用只接受先到
  const e2 = equipment.find((row) => String(row['装备编号']) === 'EQUI-0002')!
  const [r1, r2] = await Promise.all([
    submitEquipmentAction({ action: '领用装备', equipmentId: Number(e2.id), teamName: '扑火一队' }),
    submitEquipmentAction({ action: '领用装备', equipmentId: Number(e2.id), teamName: '扑火二队' }),
  ])
  assert(r1.accepted && r1.ok, '并发领用：先到请求受理')
  assert(!r2.accepted && !r2.ok, '并发领用：后到请求拒绝')
  assert(activeOccupancyOf(Number(e2.id))?.teamName === '扑火一队', '只有先到队伍占用成功')
  const failuresList = unresolvedFailures()
  assert(failuresList.length === 1, `失败清单 1 条，实际 ${failuresList.length}`)

  // 回收期间并发：先到回收成功，后到领用（版本过期）拒绝
  const [ret, issue] = await Promise.all([
    submitEquipmentAction({ action: '回收入库', equipmentId: Number(e2.id) }),
    submitEquipmentAction({ action: '领用装备', equipmentId: Number(e2.id), teamName: '扑火二队' }),
  ])
  assert(ret.ok, '并发回收：先到回收成功')
  assert(!issue.accepted, '并发回收：后到领用因版本过期拒绝')
  assert(!activeOccupancyOf(Number(e2.id)), '回收后占用核销')
  assert(unresolvedFailures().length === 2, '两条后到请求都在失败清单，可续办')

  // 回收同步核销外部清单：给演练重新挂上一队对 0002 的占用，领用后回收
  await submitEquipmentAction({ action: '领用装备', equipmentId: Number(e2.id), teamName: '扑火一队' })
  const drillRows = listRows('drill')
  drillRows[0]['使用装备'] = 'EQUI-0002、EQUI-0006'
  saveRows('drill', drillRows)
  const ret2 = await submitEquipmentAction({ action: '回收入库', equipmentId: Number(e2.id) })
  assert(ret2.ok, '再次回收成功')
  assert(String(listRows('drill')[0]['使用装备']) === 'EQUI-0006', '回收同步核销演练清单中同队装备引用')

  // 失败记录从断点续办：此时装备可用，续办二队领用应成功
  const target = unresolvedFailures().find((f) => f.teamName === '扑火二队')
  assert(!!target, '找到二队的失败领用记录')
  if (target) {
    const retryResult = await retryFailure(target.id)
    assert(retryResult.ok, '从断点续办二队领用成功')
    assert(activeOccupancyOf(Number(e2.id))?.teamName === '扑火二队', '续办后二队成为唯一占用方')
  }

  // 3. 状态机：历史不能回退到已领用（待检修不可直接领用，已领用不能再送检）
  const bad1 = await submitEquipmentAction({ action: '送检登记', equipmentId: Number(e2.id) })
  assert(!bad1.ok && bad1.message.includes('不能'), '已领用不能直接送检（拦截回退式迁移）')
  const e3 = equipment.find((row) => String(row['装备编号']) === 'EQUI-0003')!
  const bad2 = await submitEquipmentAction({ action: '领用装备', equipmentId: Number(e3.id), teamName: 'X' })
  assert(!bad2.ok, '待检修不能直接领用')

  // 检修闭环：完成送检后可重新领用
  const finish = await submitEquipmentAction({ action: '检修完成', equipmentId: Number(e3.id) })
  assert(finish.ok && String(listRows('equipment').find((r) => r.id === e3.id)?.status) === '可用', '检修完成回到可用')

  // 报废：核销占用 + 全局清理外部引用（用一件可用装备演示运行期报废）
  const drillBeforeScrap = listRows('drill')
  drillBeforeScrap[0]['使用装备'] = 'EQUI-0002'
  saveRows('drill', drillBeforeScrap)
  const e2Now = listRows('equipment').find((row) => String(row['装备编号']) === 'EQUI-0002')!
  // 此时 EQUI-0002 被二队占用（断点续办），报废应同时核销占用与外部全局引用
  const scrap = await submitEquipmentAction({ action: '报废装备', equipmentId: Number(e2Now.id) })
  assert(scrap.ok, '已领用装备报废成功')
  assert(!activeOccupancyOf(Number(e2Now.id)), '报废同时核销有效占用')
  assert(!listRows('drill').some((row) => String(row['使用装备']).includes('EQUI-0002')), '报废全局核销外部装备引用')

  // 列表服务仍然可用
  const page = listEntries('equipment', {})
  assert(page.total >= 6, `列表返回装备数据 ${page.total} 条`)

  console.log('\n全部断言完成')
}

resetDomain()
resetRows('equipment')
resetRows('drill')

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
