import type { ModuleMeta } from './types'

/**
 * 共用状态迁移写法：所有模块的状态流转都从这里过。
 * - 动作必须登记在 actionTargets 里；
 * - 当前状态已经是目标态 -> 幂等拒绝（不重复操作）；
 * - 登记了 actionFrom 白名单的模块，源状态不在白名单里一律拒绝，
 *   从根上拦住「回收后旧占用没解除、历史回退到已领用」这种往回跳的迁移。
 */
export type TransitionCheck =
  | { ok: true; target: string }
  | { ok: false; message: string }

export function checkTransition(
  meta: ModuleMeta,
  currentStatus: string,
  action: string,
): TransitionCheck {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const allowedFrom = meta.actionFrom?.[action]
  if (allowedFrom && !allowedFrom.includes(currentStatus)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${currentStatus}」，不能从这里${action}（仅允许：${allowedFrom.join('、')} → ${target}）`,
    }
  }
  return { ok: true, target }
}
