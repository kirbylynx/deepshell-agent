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
 *
 * **F-002 的修复——机器可读与人类可读分离**：`windowsStatus` 原先承载自由文本，却挂在
 * `schemaVersion: 1` 这个本应表示稳定契约的版本号下。现在拆为：
 *   - `windowsStatusCode`：**稳定枚举**，取值只能是 {@link WindowsStatusCode} 之一；
 *   - `windowsStatusSummary`：人类可读摘要，措辞可自由调整。
 * 这样文案变化不再改变机器契约，消费者可安全地按 code 分支。
 * 经查证该字段**没有任何消费者**（`release-manifest.json` 既未被 git 跟踪，也从未随任何
 * release 上传），故直接替换而未保留旧字段，避免留下两套说法。
 *
 * **F-003 的修复**：缺陷列表为空时不再渲染成 `…this version: .`，而是输出专门文案。
 */

/**
 * 机器可读的 Windows 验收状态码。**取值集合必须保持稳定**——新增状态只能追加，
 * 不得改写既有取值的含义，否则即构成对消费者的破坏性变更。
 *
 * @readonly
 * @enum {string}
 */
export const WindowsStatusCode = Object.freeze({
  /** 已在真机上完成端到端验收，且有验收记录文档。 */
  AcceptedOnDevice: 'accepted-on-device',
  /** 已在真机上完成主要矩阵，但仍存在明确的人工项或未运行子项。 */
  PartiallyAcceptedOnDevice: 'partially-accepted-on-device',
  /** 本版本没有真机验收记录——**不得**声称已验收。 */
  NotRecorded: 'not-recorded-for-this-version'
})

/** 全部合法状态码，供测试断言"取值未退化为自由文本"。 */
export const windowsStatusCodes = Object.freeze(Object.values(WindowsStatusCode))

/**
 * 已登记版本在 notes 中的说明措辞（人类可读，可自由调整）。
 * 状态码不在此渲染——notes 面向人，manifest 面向机器。
 */
const ACCEPTED_SUMMARY = 'accepted end-to-end on real Windows 11 hardware'
const PARTIAL_ACCEPTED_SUMMARY =
  'partially accepted on real Windows 11 hardware; some session/UI/upgrade checks remain manual or not run'

/** 未登记版本在 notes 中使用的说明（明确、可搜索、不含任何上一版本的说法）。 */
const UNRECORDED_NOTE =
  'no Windows on-device acceptance is recorded for this version; do not claim one'

/** 缺陷列表为空时使用的专门文案（F-003）。 */
const NO_UNFIXED_DEFECTS = 'none for this version'

/**
 * 各版本的 Windows x64 真机验收事实。键为应用版本号，与 `package.json` 的 `version` 对应。
 *
 * @type {Record<string, {
 *   record: string,
 *   statusCode?: string,
 *   summary?: string,
 *   scope: string,
 *   unfixed: { id: string, summary: string }[]
 * }>}
 */
export const windowsAcceptance = {
  '0.1.3': {
    record: 'docs/releases/v0.1.3.md',
    scope: 'S1-S13 end-to-end; S11 (uninstall) partially passed; 8 platform defects fixed; 4 new defects deferred',
    unfixed: [
      { id: 'REL-022', summary: 'per-platform runtime trimming' },
      { id: 'REL-024', summary: 'uninstall residue when an orphan Sidecar is present' },
      { id: 'REL-026', summary: 'drag-and-drop' },
      { id: 'REL-027', summary: 'dead client renderer' },
      { id: 'DESK-023', summary: 'Windows menu' }
    ]
  },
  '0.1.4': {
    record: 'docs/releases/v0.1.4.md',
    statusCode: WindowsStatusCode.PartiallyAcceptedOnDevice,
    summary: PARTIAL_ACCEPTED_SUMMARY,
    // 注意：这里只写**稳定的量级**。精确的 bytes/delta 记录在 release 文档与
    // manifest/package-report 中；若在此处写精确数字，而本文件属于构建输入 digest，
    // 就会出现"改数字 → digest 变化 → 重建后数字再变"的循环。
    scope:
      'Windows main packaging matrix measured on real Windows 11 x64: per-platform runtime trimming (installed tree reduced by about 196.6 MB and 4800 files; NSIS reduced by about 27.6 MB), portable ZIP distribution, native File/Help menu, exit-path hardening, and the pre-uninstall cleanup whose end-to-end matrix removes the install tree completely even with an orphan Sidecar; session creation, UI-level session reading, and representative old-session upgrade remain manual or not run items',
    unfixed: [
      { id: 'REL-025', summary: 'quarantined-record retirement on macOS (Windows side landed)' },
      { id: 'REL-026', summary: 'drag-and-drop' },
      { id: 'REL-027', summary: 'dead client renderer' }
    ]
  }
}

/**
 * 取指定版本的验收事实。
 *
 * @param {string} version 应用版本号
 * @returns {{ recorded: true, record: string, scope: string, unfixed: { id: string, summary: string }[] }
 *   | { recorded: false }} 登记时的完整事实；未登记时仅返回 `recorded: false`
 */
export function acceptanceFor(version) {
  const entry = windowsAcceptance[version]
  if (!entry) return { recorded: false }
  return { recorded: true, ...entry }
}

/**
 * 渲染 notes 中"Windows x64"那一行。notes 与 manifest 共用同一份事实，故两处说法不可能分叉。
 *
 * @param {string} version 应用版本号
 * @returns {string} 形如 `- Windows x64: …` 的行
 */
export function windowsNotesLine(version) {
  const acceptance = acceptanceFor(version)
  if (!acceptance.recorded) {
    return `- Windows x64: ${UNRECORDED_NOTE}.`
  }
  // F-003：空列表必须走专门文案，不能渲染成 "…this version: ."
  const unfixed =
    acceptance.unfixed.length === 0
      ? NO_UNFIXED_DEFECTS
      : acceptance.unfixed.map(item => `${item.id} (${item.summary})`).join(', ')
  const summary = acceptance.summary ?? ACCEPTED_SUMMARY
  return `- Windows x64: ${summary} for v${version} (see ${acceptance.record}). Known unfixed defects ship with this version: ${unfixed}.`
}

/**
 * 渲染 manifest 的 Windows 验收字段。机器可读字段为 {@link WindowsStatusCode} 的取值，
 * 人类可读措辞单独放在 summary 字段中（F-002）。
 *
 * @param {string} version 应用版本号
 * @returns {{
 *   windowsStatusCode: string,
 *   windowsStatusSummary: string,
 *   windowsAcceptanceRecord: string | null,
 *   windowsAcceptanceScope: string | null
 * }}
 */
export function windowsManifestFields(version) {
  const acceptance = acceptanceFor(version)
  if (!acceptance.recorded) {
    return {
      windowsStatusCode: WindowsStatusCode.NotRecorded,
      windowsStatusSummary: UNRECORDED_NOTE,
      windowsAcceptanceRecord: null,
      windowsAcceptanceScope: null
    }
  }
  return {
    windowsStatusCode: acceptance.statusCode ?? WindowsStatusCode.AcceptedOnDevice,
    windowsStatusSummary: acceptance.summary ?? ACCEPTED_SUMMARY,
    windowsAcceptanceRecord: acceptance.record,
    windowsAcceptanceScope: `v${version}: ${acceptance.scope}`
  }
}
