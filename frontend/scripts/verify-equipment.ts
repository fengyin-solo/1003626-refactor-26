// 临时验证脚本：覆盖状态迁移、占用核销、检修历史、迁移断点、并发先到、跨模块核销。
import assert from 'node:assert'

// --- 浏览器环境垫片 ---
const memory = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

// --- 构造故障现场：装备按规格型号被分给两支队伍 + 回收后旧占用没解除 + 历史回退隐患 ---
import { saveRows, resetRows, storageKey } from '../src/data/local-store'

resetRows('equipment')
resetRows('drill')
resetRows('fireteam')

// 装备：A 可用；B 主表已领用；C 主表可用（演练清单里却挂着占用=回收后未解除）；D 待检修
saveRows('equipment', [
  { id: 1, status: '可用', pending: true, abnormal: false, '装备编号': 'EQ-A', '装备名称': '风力灭火机', '装备类型': '机具', '规格型号': 'SP-X', '保管林场': '青松林场', '购入日期': '2026-01-01', '最近检修日': '', '装备状态': '' },
  { id: 2, status: '已领用', pending: true, abnormal: false, '装备编号': 'EQ-B', '装备名称': '水泵', '装备类型': '机具', '规格型号': 'SP-Y', '保管林场': '青松林场', '购入日期': '2026-01-02', '最近检修日': '', '装备状态': '' },
  { id: 3, status: '可用', pending: true, abnormal: false, '装备编号': 'EQ-C', '装备名称': '油锯', '装备类型': '机具', '规格型号': '', '保管林场': '白桦林场', '购入日期': '2026-01-03', '最近检修日': '', '装备状态': '' },
  { id: 4, status: '待检修', pending: true, abnormal: false, '装备编号': 'EQ-D', '装备名称': '水枪', '装备类型': '机具', '规格型号': 'SP-Z', '保管林场': '青松林场', '购入日期': '2026-01-04', '最近检修日': '', '装备状态': '' },
])

// 演练清单：#10 用 EQ-B（一队，与主表一致）；#11 也用 EQ-B（二队=同装备双占用矛盾）；
// #12 用 EQ-C，而 EQ-C 主表已可用=回收后旧占用没解除；
// #13 规格为空，只能按保管林场兼容白桦林场=>EQ-C（同范围多义场景另测）。
saveRows('drill', [
  { id: 10, status: '筹备中', pending: true, abnormal: false, '演练编号': 'D10', '演练主题': 't', '参演队伍': '一队', '演练日期': '2026-09-10', '参演人数': '10', '使用装备': 'EQ-B', '演练评价': '', '演练状态': '' },
  { id: 11, status: '筹备中', pending: true, abnormal: false, '演练编号': 'D11', '演练主题': 't', '参演队伍': '二队', '演练日期': '2026-09-11', '参演人数': '10', '使用装备': 'EQ-B', '演练评价': '', '演练状态': '' },
  { id: 12, status: '待筹备', pending: true, abnormal: false, '演练编号': 'D12', '演练主题': 't', '参演队伍': '三队', '演练日期': '2026-09-12', '参演人数': '10', '使用装备': 'EQ-C', '演练评价': '', '演练状态': '' },
  { id: 13, status: '待筹备', pending: true, abnormal: false, '演练编号': 'D13', '演练主题': 't', '参演队伍': '三队', '演练日期': '2026-09-13', '参演人数': '10', '使用装备': '油锯（白桦林场）', '演练评价': '', '演练状态': '' },
])
saveRows('fireteam', [
  { id: 1, status: '在营待命', pending: true, abnormal: false, '队伍编号': 'T1', '队伍名称': '一队', '所属林场': '青松林场', '队长姓名': '', '队员人数': '9', '集结半径': '', '值班状态': '', '出动状态': '' },
  { id: 2, status: '在营待命', pending: true, abnormal: false, '队伍编号': 'T2', '队伍名称': '二队', '所属林场': '青松林场', '队长姓名': '', '队员人数': '9', '集结半径': '', '值班状态': '', '出动状态': '' },
])

// --- 1. 迁移 ---
const service = await import('../src/data/equipment/service')
const { _resetLifecycleForTest, runMigration } = service
_resetLifecycleForTest()
// 让「油锯（白桦林场）」这条引用先解析失败（白桦林场有两件空规格装备制造多义），验证断点失败清单
// 临时再加一件白桦林场空规格装备
import { listRows } from '../src/data/local-store'
{
  const eq = listRows('equipment')
  saveRows('equipment', [...eq, { id: 5, status: '可用', pending: true, abnormal: false, '装备编号': 'EQ-E', '装备名称': '备份油锯', '装备类型': '机具', '规格型号': '', '保管林场': '白桦林场', '购入日期': '2026-01-05', '最近检修日': '', '装备状态': '' }])
}
let report = runMigration()
console.log('迁移报告(有多义):', { ...report, failures: report.failures.map(f => f.source + ':' + f.equipmentRef) })
assert(report.status === 'done')
assert(report.failures.length >= 1, '多义引用应进失败清单')
const ambiguous = report.failures.find(f => f.equipmentRef.includes('白桦林场'))
assert(ambiguous, '按保管林场兼容出现多义时应记录失败')

// 修复数据：删掉多余的白桦林场装备，续跑应成功
{
  const eq = listRows('equipment').filter(r => r.id !== 5)
  saveRows('equipment', eq)
}
report = runMigration()
console.log('迁移报告(修复后续跑):', { appended: report.appendedEvents, failures: report.failures.length, dismissed: report.dismissals })
assert(report.failures.length === 0, '数据补齐后续跑不应再有失败')
assert(report.appendedEvents >= 1, '断点续跑应补追加之前缺失的事件')

// 幂等：再跑一遍，不应追加任何事件
const report3 = runMigration()
assert(report3.appendedEvents === 0 && report3.dismissals === 0, '迁移必须幂等')

// --- 2. 迁移后占用断言：一件装备至多一个有效占用 ---
const claimsAfterMigration = service.activeClaims().map(c => `${c.equipmentCode}:${c.teamName}`)
console.log('迁移后有效占用:', claimsAfterMigration)
assert(claimsAfterMigration.includes('EQ-B:一队'), 'EQ-B 应保留主表胜出占用(一队)')
assert(!claimsAfterMigration.some(c => c.startsWith('EQ-B:二队')), 'EQ-B 的二队重复占用必须被核销')
assert(!claimsAfterMigration.some(c => c.startsWith('EQ-C:')), 'EQ-C 主表已可用，演练旧占用必须全部核销')
const bClaimCount = claimsAfterMigration.filter(c => c.startsWith('EQ-B:')).length
assert(bClaimCount === 1, 'EQ-B 只能有一个有效占用')

// 其它模块清单同步核销
{
  const drill = listRows('drill')
  const d11 = drill.find(r => r.id === 11)
  const d12 = drill.find(r => r.id === 12)
  assert(d11!['占用核销'] === '已随装备回收核销', '演练#11 重复占用应被同步核销')
  assert(d12!['占用核销'] === '已随装备回收核销', '演练#12 回收后未解除的旧占用应被同步核销')
  const d10 = drill.find(r => r.id === 10)
  assert(d10!['占用核销'] === undefined, '演练#10 是胜出占用同一主张，不应核销')
}
// 装备主表状态来自投影
{
  const eq = listRows('equipment')
  assert(eq.find(r => r.id === 2)!.status === '已领用')
  assert(eq.find(r => r.id === 4)!.status === '待检修')
}
// 装备编号从未被改动
{
  const codes = listRows('equipment').map(r => r['装备编号'])
  assert.deepEqual(codes, ['EQ-A', 'EQ-B', 'EQ-C', 'EQ-D'])
}

// --- 3. 状态迁移合法性 + 历史不可回退 ---
await service.submitMutation({ code: 'EQ-A', type: 'CHECKED_OUT', teamName: '一队', origin: '测试出库' })
assert(service.getLifecycle('EQ-A')!.status === '已领用')

// 走一遍完整检修闭环：EQ-B 已领用 → 送检（占用随之核销）→ 修竣（可用，检修历史闭环）
const sendB = await service.submitMutation({ code: 'EQ-B', type: 'SENT_FOR_REPAIR', origin: '测试送检' })
assert(sendB.ok && service.getLifecycle('EQ-B')!.status === '待检修')
assert(service.getLifecycle('EQ-B')!.activeClaim === null, '送检后占用必须解除')
// 待检修装备不能直接回收（非法迁移拒绝），也不会回退到已领用
const bad = await service.submitMutation({ code: 'EQ-B', type: 'RETURNED', origin: '测试非法回收' })
assert(!bad.ok, '待检修状态回收必须被拒绝')
assert(service.getLifecycle('EQ-B')!.status === '待检修', '失败操作不得改变状态（历史不会回退到已领用）')
// 已领用装备不能直接修竣
const bad2 = await service.submitMutation({ code: 'EQ-A', type: 'REPAIRED', origin: '测试非法修竣' })
assert(!bad2.ok, '非待检修状态不允许修竣')
// EQ-B 修竣
const repaired = await service.submitMutation({ code: 'EQ-B', type: 'REPAIRED', origin: '测试修竣' })
assert(repaired.ok && service.getLifecycle('EQ-B')!.status === '可用')
const historyB = service.repairHistory('EQ-B')
assert(historyB.length === 1, 'EQ-B 送检+修竣应形成 1 条闭环检修记录')
assert(historyB[0].returnedAt, '检修记录应有修竣时间')

// --- 4. 回收解除占用 + 跨模块同步 ---
await service.submitMutation({ code: 'EQ-A', type: 'RETURNED', origin: '测试回收' })
assert(service.getLifecycle('EQ-A')!.status === '可用')
assert(service.getLifecycle('EQ-A')!.activeClaim === null, '回收后占用必须解除')

// --- 5. 并发出库与回收：只接受先到请求 ---
_resetLifecycleForTest()
// 用干净装备 EQ-A 做并发：两个出库同时排队
const [r1, r2] = await Promise.all([
  service.submitMutation({ code: 'EQ-A', type: 'CHECKED_OUT', teamName: '先发队', origin: '并发1' }),
  service.submitMutation({ code: 'EQ-A', type: 'CHECKED_OUT', teamName: '后发队', origin: '并发2' }),
])
console.log('并发出库:', r1.ok ? '先到成功' : '先到失败?!', '/', r2.ok ? '后到也成功?!' : r2.message)
assert(r1.ok && !r2.ok, '并发出库只接受先到请求')
assert(service.getLifecycle('EQ-A')!.activeClaim!.teamName === '先发队')
// 失败记录可从断点继续：此时仍被占用，重试继续失败；回收后续跑成功
const failedBefore = service.failedRequests()
assert(failedBefore.length === 1, '失败请求必须入台账')
const fid = failedBefore[0].id
const retryFail = await service.retryFailed(fid)
assert(!retryFail.ok, '占用仍在时迟到出库重试仍失败（先到结果不翻案）')
await service.submitMutation({ code: 'EQ-A', type: 'RETURNED', origin: '先到方回收' })
const retryOk = await service.retryFailed(fid)
assert(retryOk.ok, '装备回收后失败记录可从断点续跑成功')
assert(service.getLifecycle('EQ-A')!.activeClaim!.teamName === '后发队')
assert(service.failedRequests().length === 0)

// --- 6. 出库与回收交叉并发：FIFO 下先到先处理，状态按序迁移，不丢不重 ---
{
  _resetLifecycleForTest()
  const [c, r] = await Promise.all([
    service.submitMutation({ code: 'EQ-C', type: 'CHECKED_OUT', teamName: 'X队', origin: '交叉出库' }),
    service.submitMutation({ code: 'EQ-C', type: 'RETURNED', origin: '交叉回收' }),
  ])
  assert(c.ok, '先到的出库应成功')
  assert(r.ok, '排在出库之后的回收看到占用，应按序成功')
  assert(service.getLifecycle('EQ-C')!.status === '可用', '最终状态为回收后的可用')
  assert(service.getLifecycle('EQ-C')!.activeClaim === null, '最终无有效占用')
  // 反过来：先回收（无占用）失败，其后出库成功
  const [r2, c2] = await Promise.all([
    service.submitMutation({ code: 'EQ-C', type: 'RETURNED', origin: '抢先回收' }),
    service.submitMutation({ code: 'EQ-C', type: 'CHECKED_OUT', teamName: 'Y队', origin: '其后出库' }),
  ])
  assert(!r2.ok && c2.ok, '无占用的回收失败，排在其后的出库成功')
  assert(service.getLifecycle('EQ-C')!.activeClaim!.teamName === 'Y队')
  // 失败台账里回收记录仍可追溯
  assert(service.failedRequests().some(f => f.equipmentCode === 'EQ-C' && f.kind === 'RETURNED'))
}

// 引用解析器单测：旧规格为空按保管林场兼容
const { resolveEquipmentRef } = await import('../src/data/equipment/references')
{
  const cands = [
    { code: 'X1', spec: '', scope: '林一' },
    { code: 'X2', spec: '', scope: '林二' },
  ]
  assert(resolveEquipmentRef('随便一段文本', '林一', cands).code === 'X1', '空规格按保管林场唯一兼容')
  const ambiguousRes = resolveEquipmentRef('文本', '林一', [...cands, { code: 'X3', spec: '', scope: '林一' }])
  assert(ambiguousRes.ambiguous, '同林场多件时空规格兼容必须判多义')
  const byCode = resolveEquipmentRef('X2', '林一', cands)
  assert(byCode.code === 'X2', '装备编号精确匹配优先')
  const bySpec = resolveEquipmentRef('S-唯一', '林一', [
    { code: 'X1', spec: 'S-唯一', scope: '林一' },
    { code: 'X2', spec: 'S-其它', scope: '林二' },
  ])
  assert(bySpec.code === 'X1', '非空规格唯一时按规格兼容')
}

// 状态机：已报废是终态，任何迁移都拒绝
{
  await service.submitMutation({ code: 'EQ-A', type: 'SCRAPPED', origin: '测试报废' })
  const after = await service.submitMutation({ code: 'EQ-A', type: 'CHECKED_OUT', teamName: '谁', origin: '报废后出库' })
  assert(!after.ok, '已报废装备不允许再出库')
}

// --- 7. 重复编号脏数据：同编号一行已领用一行待检修，迁移后只保留一个占用且幂等 ---
{
  const { listRows: lr, saveRows: sr } = await import('../src/data/local-store')
  const eq = lr('equipment')
  sr('equipment', [
    ...eq,
    { id: 91, status: '已领用', pending: true, abnormal: false, '装备编号': 'EQ-DUP', '装备名称': '同编号机具', '装备类型': '机具', '规格型号': 'DUP', '保管林场': '青松林场', '购入日期': '', '最近检修日': '', '装备状态': '' },
    { id: 92, status: '待检修', pending: true, abnormal: false, '装备编号': 'EQ-DUP', '装备名称': '同编号机具', '装备类型': '机具', '规格型号': 'DUP', '保管林场': '青松林场', '购入日期': '', '最近检修日': '', '装备状态': '' },
  ])
  const rep1 = service.runMigration()
  const rep2 = service.runMigration()
  assert(rep2.appendedEvents === 0 && rep2.dismissals === 0, '重复编号迁移也必须幂等')
  const lc = service.getLifecycle('EQ-DUP')
  assert(lc!.status === '已领用', '同编号已领用与待检修冲突时，占用真相（已领用）胜出')
  assert(lc!.activeClaim !== null, 'EQ-DUP 应保留唯一有效占用')
}

console.log('\n全部断言通过 ✅')
process.exit(0)
