import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'

const lock = await readLock()
const output = resolve(root, 'docs/plans/POC/evidence/manifest.json')
const manualAcceptance = await readFile(resolve(root, 'docs/plans/POC/manual-acceptance.md'), 'utf8')
const passedManualTests = [...manualAcceptance.matchAll(/^\| (MT-\d{3}) \|.*\| Pass \|/gm)]
  .map(match => match[1])
const totalManualTests = [...manualAcceptance.matchAll(/^\| MT-\d{3} \|/gm)].length
const evidenceRoot = resolve(root, 'docs/plans/POC/evidence')
const automatedSummaryPath = resolve(evidenceRoot, 'automated/AT-summary.json')
let automatedAcceptance = null
try {
  automatedAcceptance = JSON.parse(await readFile(automatedSummaryPath, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
let gates = []
try {
  const gateDirectory = resolve(evidenceRoot, 'gates')
  const gateFiles = (await readdir(gateDirectory))
    .filter(file => /^GATE-\d{2}-.+\.md$/.test(file))
    .sort()
  gates = await Promise.all(gateFiles.map(async file => {
    const body = await readFile(resolve(gateDirectory, file), 'utf8')
    const id = file.match(/^(GATE-\d{2})/)?.[1] ?? file.replace(/\.md$/, '')
    const status = body.match(/^Status:\s*(Pass|Fail|Blocked|in-progress|provisional)$/m)?.[1] ?? 'unknown'
    return { id, status, file: `docs/plans/POC/evidence/gates/${file}` }
  }))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const allManualPassed = totalManualTests > 0 && passedManualTests.length === totalManualTests
const atItems = automatedAcceptance?.items ?? []
const allAutomatedPassed = automatedAcceptance?.status === 'Pass' &&
  atItems.length === 39 &&
  atItems.every(item => item.status === 'Pass')
const allGatesPassed = gates.length === 7 && gates.every(gate => gate.status === 'Pass')
const pocStatus = allManualPassed && allAutomatedPassed && allGatesPassed ? 'Pass' : 'in-progress'
await mkdir(resolve(output, '..'), { recursive: true })
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  applicationVersion: lock.applicationVersion,
  compatibility: { node: lock.node.version, dsh: lock.dsh.version },
  status: pocStatus,
  manualAcceptance: {
    passed: passedManualTests,
    passedCount: passedManualTests.length,
    totalCount: totalManualTests,
    remainingCount: totalManualTests - passedManualTests.length,
    evidenceQualification: 'manual tests are accepted by user confirmation; screenshots and redacted evidence paths are optional'
  },
  automatedAcceptance: automatedAcceptance ? {
    status: automatedAcceptance.status,
    passedCount: atItems.filter(item => item.status === 'Pass').length,
    totalCount: atItems.length,
    manualAssisted: automatedAcceptance.manualAssistedEvidence?.map(item => item.id) ?? [],
    file: 'docs/plans/POC/evidence/automated/AT-summary.json'
  } : null,
  gates,
  report: {
    file: 'docs/plans/POC/evidence/POC-report.md',
    status: pocStatus
  },
  note: pocStatus === 'Pass'
    ? 'POC closeout complete: required MT, AT, Gate, and final report are recorded.'
    : '不得把 in-progress 当作 POC Pass；强制 AT、MT、Gate 和最终结论完成后更新。'
}
const serialized = JSON.stringify(evidence, null, 2) + '\n'
if (/(token=|cookie|api[_-]?key|sk-[a-z0-9])/i.test(serialized)) throw new Error('证据包含疑似 Secret')
await writeFile(output, serialized)
console.log(output)
