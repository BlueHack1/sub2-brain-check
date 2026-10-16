import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tests = readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`)
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { cwd: root, stdio: 'inherit' })
process.exitCode = result.status ?? 1
