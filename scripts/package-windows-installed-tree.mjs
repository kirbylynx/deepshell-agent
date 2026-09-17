// Windows installed-tree 捕获编排：安装 → 捕获精确清单 → 卸载 → 恢复环境。
//
// 用法：
//   node scripts/package-windows-installed-tree.mjs [--install-root <path>] [--keep]
//
// 背景（设计 §12 的 Windows 流水线）：size gate 依赖"真实安装树"的精确清单，
// 而捕获必须先静默安装构建产物。为避免每次手工做注册表/快捷方式备份与恢复，
// 该编排把整套步骤固化为一条可重复命令。
//
// 步骤：
// 1. 备份 HKCU 卸载注册项与开始菜单/桌面快捷方式到 runtime/staging/installed-tree-evidence/；
// 2. 静默安装 NSIS 产物到专用测试根（默认 runtime/staging/install-tree-v<version>）；
// 3. 运行 capture-package-manifest.mjs release windows-installed-tree --installed-tree <root>；
// 4. 默认静默卸载并**恢复**注册表与快捷方式（--keep 保留安装，此时不恢复，便于人工检查）。
//
// 该脚本会短暂改写 HKCU 的卸载注册项与两个快捷方式，但默认路径会在 finally 中恢复；
// 运行前请确认没有正在运行的 DeepShell 实例与正在使用的安装。
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'

const execFileAsync = promisify(execFile)
// 真机实测：340 MB / 2.7 万文件的安装树在杀软扫描波动下，卸载器完成"目录+注册键移除"
// 可能超过 30 秒（一次实测约 30–40 秒导致假失败：卸载其实成功，脚本却判定未确认）。
// 这里给足余量；超时后仍会做最后一次确认，避免刚好错过。
const SETTLE_TIMEOUT_MS = 90_000
// 真机实测：NSIS 卸载器在"文件删除与主要注册表清理"完成之后，仍有**延迟的清理步骤**
// 会在数十秒内再次删除卸载注册键（实测在脚本结束后 0–30 秒窗口内发生）。恢复注册表
// 必须等该窗口结束，并在恢复后做复验重试，否则恢复的键会被再次删除。
const UNINSTALL_QUIET_WINDOW_MS = 45_000
const RESTORE_VERIFY_WINDOW_MS = 6_000
const RESTORE_ATTEMPTS = 4
const UNINSTALL_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeepShell Agent'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  // 超时后做最后一次确认：卸载可能恰好在此刻完成（避免"刚好错过"的假失败）。
  return predicate()
}

async function tryBackup(source, target) {
  if (!(await exists(source))) return false
  await copyFile(source, target)
  return true
}

async function registryKeyPresent() {
  return execFileAsync('reg.exe', ['query', UNINSTALL_REGISTRY_KEY]).then(() => true, () => false)
}

// 安装测试根的防呆校验（导出供单测直接验证）：只允许位于 runtime/staging 下、
// 以 install-tree-v<version> 结尾的专用目录——该目录稍后会被递归删除，绝不能接受
// 任意路径（误传 --install-root 不得造成工作区、用户目录被删除）。
export function assertSafeInstallRoot(installRoot, packageRoot = root) {
  const normalized = resolve(installRoot)
  const protectedPaths = [
    resolve(packageRoot),
    resolve(packageRoot, 'runtime/staging'),
    resolve(process.env.USERPROFILE ?? packageRoot),
    resolve(process.env.APPDATA ?? packageRoot),
  ]
  if (protectedPaths.some(protectedPath => normalized === protectedPath)) {
    throw new Error(`拒绝把安装测试根指向受保护目录：${normalized}`)
  }
  const stagingRoot = resolve(packageRoot, 'runtime/staging') + sep
  if (!normalized.startsWith(stagingRoot)) {
    throw new Error(`安装测试根必须位于运行时 staging 目录内：${normalized}`)
  }
  if (!/(^|[\\/])install-tree-v[^\\/]+$/.test(normalized)) {
    throw new Error(`安装测试根必须以 install-tree-v<version> 结尾：${normalized}`)
  }
}

export async function packageWindowsInstalledTree() {
  if (process.platform !== 'win32') {
    throw new Error('installed-tree 捕获编排仅支持 Windows')
  }
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = pkg.version
  const installRoot = resolve(
    argValue('--install-root') ?? resolve(root, 'runtime/staging', `install-tree-v${version}`),
  )
  assertSafeInstallRoot(installRoot, root)
  const keepInstalled = process.argv.includes('--keep')

  const setup = resolve(
    root,
    'src-tauri/target/release/bundle/nsis',
    `DeepShell Agent_${version}_x64-setup.exe`,
  )
  await access(setup).catch(() => {
    throw new Error(`找不到 NSIS 产物：${setup}（请先运行 pnpm package:mvp）`)
  })

  const evidence = resolve(root, 'runtime/staging/installed-tree-evidence')
  await mkdir(evidence, { recursive: true })
  const registryBackup = resolve(evidence, 'uninstall-key.reg')
  const startMenu = resolve(
    process.env.APPDATA ?? '',
    'Microsoft/Windows/Start Menu/Programs/DeepShell Agent.lnk',
  )
  const desktop = resolve(process.env.USERPROFILE ?? '', 'Desktop/DeepShell Agent.lnk')
  const startMenuBackup = resolve(evidence, 'startmenu-DeepShell Agent.lnk')
  const desktopBackup = resolve(evidence, 'desktop-DeepShell Agent.lnk')

  // 先删除旧备份，确保 export 结果一定是本次运行的：
  // 此前对 export 失败静默处理（catch → false），旧备份文件又掩盖了失败，
  // 于是"卸载删除注册键后无法恢复"——真机实测暴露。
  await rm(registryBackup, { force: true }).catch(() => {})
  const registryExported = await execFileAsync('reg.exe', [
    'export',
    UNINSTALL_REGISTRY_KEY,
    registryBackup,
    '/y',
  ]).then(() => true, () => false)
  if (!registryExported && (await exists(registryBackup))) {
    // 有备份文件但命令失败：状态异常，失败关闭（此时尚未改动任何环境）。
    throw new Error(`注册表备份失败但目标文件已存在：${registryBackup}`)
  }
  const startMenuExisted = await tryBackup(startMenu, startMenuBackup)
  const desktopExisted = await tryBackup(desktop, desktopBackup)

  let installed = false
  try {
    await rm(installRoot, { recursive: true, force: true })
    await mkdir(installRoot, { recursive: true })
    await execFileAsync(setup, ['/S', `/D=${installRoot}`], { timeout: 10 * 60_000 })
    installed = true

    await execFileAsync(
      process.execPath,
      ['scripts/capture-package-manifest.mjs', 'release', 'windows-installed-tree', '--installed-tree', installRoot],
      { cwd: root, stdio: 'inherit', timeout: 30 * 60_000 },
    )
    console.log(JSON.stringify({ ok: true, installRoot, kept: keepInstalled }))
  } finally {
    if (installed && !keepInstalled) {
      const uninstallerExitedCleanly = await execFileAsync(
        resolve(installRoot, 'uninstall.exe'),
        ['/S'],
        { timeout: 10 * 60_000 },
      ).then(() => true, () => false)
      // 等待卸载**真正结束**：目录消失 **且** 卸载注册键被移除。
      const settled = await waitFor(
        async () => !(await exists(installRoot)) && !(await registryKeyPresent()),
        SETTLE_TIMEOUT_MS,
      )
      if (!settled) {
        // 卸载未确认完成（例如 hook 因应用仍在运行而 Abort，或卸载器挂起）：
        // **不得**删除安装目录、**不得**恢复注册表——否则会把"卸载失败"伪装成
        // "环境已恢复"（rm 掉半安装目录 + 旧注册表覆盖回去），且脚本仍报成功。
        // 注意：这是失败关闭，不等同于"卸载必然失败"——若复查发现目录与注册键
        // 其实都已消失（卸载只是更慢），直接重跑本脚本即可。
        throw new Error(
          `卸载未确认完成（安装目录或卸载注册键仍存在）；已保持现状、未删除目录、未恢复注册表。` +
            `请确认没有 DeepShell 实例在运行后重试；若复查发现目录与注册键均已消失，直接重跑本脚本。` +
            `安装目录：${installRoot}`,
        )
      }
      if (!uninstallerExitedCleanly) {
        console.warn('卸载器退出码非 0，但安装目录与卸载注册键均已移除；按卸载完成处理')
      }
      // 再等一段静默窗：卸载器的延迟清理会在这段时间内完成（见文件头常量说明）。
      await new Promise(resolveWait => setTimeout(resolveWait, UNINSTALL_QUIET_WINDOW_MS))
      // NSIS 卸载器可能留下空目录外壳：清理它；若目录仍在，说明可能有文件残留，如实警告。
      await rm(installRoot, { recursive: true, force: true }).catch(() => {})
      if (await exists(installRoot)) {
        console.warn(`install 目录未完全清理（可能仍有文件残留）：${installRoot}`)
      }
    }
    if (!keepInstalled) {
      if (registryExported) {
        // 恢复 + 复验重试：恢复后留一个验证窗；若延迟清理再次删除该键则重试，
        // 直到键稳定保持或重试耗尽（耗尽时给出可执行的人工恢复指引）。
        let stable = false
        for (let attempt = 1; attempt <= RESTORE_ATTEMPTS && !stable; attempt += 1) {
          const restored = await execFileAsync('reg.exe', ['import', registryBackup])
            .then(() => true, () => false)
          if (!restored) continue
          await new Promise(resolveWait => setTimeout(resolveWait, RESTORE_VERIFY_WINDOW_MS))
          stable = await registryKeyPresent()
        }
        if (!stable) {
          console.warn(`警告：注册表恢复未能稳定保持，请手工导入 ${registryBackup}`)
        }
      }
      if (startMenuExisted) {
        await copyFile(startMenuBackup, startMenu)
          .catch(() => console.warn(`警告：开始菜单快捷方式恢复失败：${startMenu}`))
      }
      if (desktopExisted) {
        await copyFile(desktopBackup, desktop)
          .catch(() => console.warn(`警告：桌面快捷方式恢复失败：${desktop}`))
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageWindowsInstalledTree()
}
