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
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'

const execFileAsync = promisify(execFile)
const SETTLE_TIMEOUT_MS = 30_000
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
  return false
}

async function tryBackup(source, target) {
  if (!(await exists(source))) return false
  await copyFile(source, target)
  return true
}

async function registryKeyPresent() {
  return execFileAsync('reg.exe', ['query', UNINSTALL_REGISTRY_KEY]).then(() => true, () => false)
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
      await execFileAsync(resolve(installRoot, 'uninstall.exe'), ['/S'], { timeout: 10 * 60_000 })
        .catch(() => {})
      // 等待卸载**真正结束**：目录消失 **且** 卸载注册键被移除。
      // NSIS 卸载器会派生自身到临时目录继续执行，删除目录与删除注册表的顺序不稳定；
      // 若在卸载完成前恢复注册表，会被随后执行的卸载步骤再次删除（真机实测的竞态）。
      await waitFor(
        async () => !(await exists(installRoot)) && !(await registryKeyPresent()),
        SETTLE_TIMEOUT_MS,
      )
      // 注册表写入可能滞后于删除操作，留一小段余量再恢复。
      await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
      // NSIS 卸载器可能留下空目录外壳：清理它；若目录仍在，说明可能有文件残留，如实警告。
      await rm(installRoot, { recursive: true, force: true }).catch(() => {})
      if (await exists(installRoot)) {
        console.warn(`install 目录未完全清理（可能仍有文件残留）：${installRoot}`)
      }
    }
    if (!keepInstalled) {
      if (registryExported) {
        const restored = await execFileAsync('reg.exe', ['import', registryBackup])
          .then(() => true, () => false)
        // 恢复后必须读回确认：恢复失败意味着环境被破坏，不能静默略过。
        if (!restored || !(await registryKeyPresent())) {
          console.warn(`警告：注册表恢复失败，请手工导入 ${registryBackup}`)
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
