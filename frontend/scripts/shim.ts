// node 运行前置：最小 localStorage/window shim，必须在任何数据模块之前导入。
const memory = new Map<string, string>()

const localStorageShim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, String(value))
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
  clear: () => memory.clear(),
}

;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }
;(globalThis as Record<string, unknown>).localStorage = localStorageShim
