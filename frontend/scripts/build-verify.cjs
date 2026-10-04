// 用 esbuild 的 JS API 打包校验脚本，避免跨平台二进制软链问题（CI 上同样可跑）。
const { buildSync } = require('esbuild')

buildSync({
  entryPoints: ['scripts/run-verify.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'scripts/run-verify.mjs',
  logLevel: 'info',
})
