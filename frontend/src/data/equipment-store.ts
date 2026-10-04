import type { EquipmentDomain } from './equipment-types'

// 装备域独立持久化：占用台账 / 检修历史 / 迁移断点 / 并发失败清单都在这一格里，
// 与业务行数据分开，重置某个模块不会把占用台账冲掉。
const STORE_KEY = 'forest-fire-patrol:equipment-domain'
const DOMAIN_VERSION = 2

function emptyDomain(): EquipmentDomain {
  return {
    version: DOMAIN_VERSION,
    occupancies: [],
    maintenance: [],
    migration: {
      version: DOMAIN_VERSION,
      startedAt: '',
      finishedAt: '',
      items: [],
    },
    versions: {},
    failedRequests: [],
  }
}

let cache: EquipmentDomain | null = null

export function loadDomain(): EquipmentDomain {
  if (cache) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyDomain()
    return cache
  }
  const raw = window.localStorage.getItem(STORE_KEY)
  if (!raw) {
    cache = emptyDomain()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EquipmentDomain>
    cache = {
      ...emptyDomain(),
      ...parsed,
      occupancies: parsed.occupancies ?? [],
      maintenance: parsed.maintenance ?? [],
      versions: parsed.versions ?? {},
      failedRequests: parsed.failedRequests ?? [],
      migration: {
        ...emptyDomain().migration,
        ...(parsed.migration ?? {}),
        items: parsed.migration?.items ?? [],
      },
    }
  } catch {
    cache = emptyDomain()
  }
  return cache
}

export function saveDomain(domain: EquipmentDomain): void {
  cache = domain
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(domain))
  }
}

export function resetDomain(): void {
  cache = emptyDomain()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORE_KEY)
  }
}

export function domainStoreKey(): string {
  return STORE_KEY
}

export function nextId(prefix: string, existing: { id: string }[]): string {
  let max = 0
  for (const item of existing) {
    const match = /(\d+)$/.exec(item.id)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}
