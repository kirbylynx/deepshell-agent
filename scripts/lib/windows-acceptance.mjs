/**
 * Windows 真机验收事实的**按版本登记表**。
 *
 * 存在的理由（F-001 的修复）：`release-staging.mjs` 是**版本参数化**的工具，可以用
 * `--version <任意版本>` 生成发布资料。此前该脚本把 v0.1.3 的验收结论、文档路径与缺陷清单
 * **写死在字面量里**，于是用 `--version 0.1.4` 生成时会得到"v0.1.4 的标题 + 声明 v0.1.3 验收"
 * 的自相矛盾产物，而当时的单测只断言 `Windows x64:` 前缀存在，**无法发现**。
 *
 * 设计约束：
 * 1. **未登记的版本必须如实输出"无验收记录"**，绝不回退到上一个版本的说法——错误地声明
 *    一个从未做过的验收，比缺失信息严重得多；
 * 2. notes 与 manifest 由**同一份渲染函数**产出，从结构上排除"两处说法不一致"；
 * 3. 新增版本验收后必须在此登记，否则产出会显式提示缺失。
 */

/**
 * 各版本的 Windows x64 真机验收事实。键为应用版本号，与 `package.json` 的 `version` 对应。
 *
 * @type {Record<string, {
 *   status: string,
 *   record: string,
 *   scope: string,
 *   unfixed: { id: string, summary: string }[]
 * }>}
 */
export const windowsAcceptance = {
  '0.1.3': {
    status: 'accepted end-to-end on real Windows 11 hardware',
    record: 'docs/releases/v0.1.3.md',
    scope: 'S1-S13 end-to-end; S11 (uninstall) partially passed; 8 platform defects fixed; 4 new defects deferred',
    unfixed: [
      { id: 'REL-022', summary: 'per-platform runtime trimming' },
      { id: 'REL-024', summary: 'uninstall residue when an orphan Sidecar is present' },
      { id: 'REL-026', summary: 'drag-and-drop' },
      { id: 'REL-027', summary: 'dead client renderer' },
      { id: 'DESK-023', summary: 'Windows menu' }
    ]
  }
}

/** 未登记版本在 notes 中使用的说明（明确、可搜索、不含任何上一版本的说法）。 */
const UNRECORDED_NOTE =
  'no Windows on-device acceptance is recorded for this version; do not claim one'
/** 未登记版本在 manifest 中使用的状态值。 */
const UNRECORDED_STATUS = 'no-acceptance-recorded-for-this-version'

/**
 * 取指定版本的验收事实。
 *
 * @param {string} version 应用版本号
 * @returns {{ recorded: true, status: string, record: string, scope: string, unfixed: { id: string, summary: string }[] }
 *   | { recorded: false, status: string }} 登记时的完整事实；未登记时仅返回 `recorded: false` 与状态值
 */
export function acceptanceFor(version) {
  const entry = windowsAcceptance[version]
  if (!entry) return { recorded: false, status: UNRECORDED_STATUS }
  return { recorded: true, ...entry }
}

/**
 * 渲染 notes 中"Windows x64"那一行。notes 与 manifest 共用它，故两处说法不可能分叉。
 *
 * @param {string} version 应用版本号
 * @returns {string} 形如 `- Windows x64: …` 的行
 */
export function windowsNotesLine(version) {
  const acceptance = acceptanceFor(version)
  if (!acceptance.recorded) {
    return `- Windows x64: ${UNRECORDED_NOTE}.`
  }
  const unfixed = acceptance.unfixed.map(item => `${item.id} (${item.summary})`).join(', ')
  return `- Windows x64: ${acceptance.status} for v${version} (see ${acceptance.record}). Known unfixed defects ship with this version: ${unfixed}.`
}

/**
 * 渲染 manifest 的 Windows 验收字段。
 *
 * @param {string} version 应用版本号
 * @returns {{ windowsStatus: string, windowsAcceptanceRecord: string | null, windowsAcceptanceScope: string | null }}
 */
export function windowsManifestFields(version) {
  const acceptance = acceptanceFor(version)
  if (!acceptance.recorded) {
    return {
      windowsStatus: acceptance.status,
      windowsAcceptanceRecord: null,
      windowsAcceptanceScope: null
    }
  }
  return {
    windowsStatus: acceptance.status,
    windowsAcceptanceRecord: acceptance.record,
    windowsAcceptanceScope: `v${version}: ${acceptance.scope}`
  }
}
