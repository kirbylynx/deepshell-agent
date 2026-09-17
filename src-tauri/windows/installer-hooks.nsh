; DeepShell Agent 的 NSIS 安装器扩展。
;
; PREUNINSTALL：只调用主程序的受限维护命令（--maintenance cleanup-owned-runtime）。
; - 维护命令只终止"可执行路径与身份都能确认属于当前安装目录"的受管 Sidecar；
; - 应用仍在运行、无法证明无占用或清理失败时返回专用非零退出码；
; - 此时**中止卸载**并提示用户：绝不强杀主程序，也绝不按进程名批量终止。
;
; 退出码契约（与 src-tauri/src/maintenance.rs 中的常量一致）：
;   0  = 清洁 / 已清理
;  10  = 用法错误
;  11  = install root 无效（非绝对、受保护目录、含 symlink/junction/reparse point）
;  12  = 维护二进制不在传入的 install root 内
;  13  = 主程序仍在运行（提示用户先关闭）
;  14  = 无法证明当前安装目录未被受管进程占用
;  15  = 清理失败（含超时）

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "DeepShell Agent: checking for leftover runtime processes..."
  ExecWait '"$INSTDIR\deepshell-agent.exe" --maintenance cleanup-owned-runtime --install-root "$INSTDIR"' $R0
  IntCmp $R0 0 deepshell_cleanup_ok deepshell_cleanup_failed deepshell_cleanup_failed

  deepshell_cleanup_failed:
    DetailPrint "DeepShell Agent: runtime cleanup failed (exit code $R0). Uninstall aborted."
    ; 静默卸载（/S）用于自动化场景，不能弹出阻塞式对话框等待人工点击。
    IfSilent deepshell_cleanup_abort
    MessageBox MB_ICONSTOP|MB_OK "DeepShell Agent could not verify that its runtime processes are gone (exit code $R0).$\r$\nIf DeepShell Agent is still running, close it and run the uninstaller again.$\r$\nUninstall was aborted; no files were removed."
  deepshell_cleanup_abort:
    Abort "DeepShell Agent uninstall aborted: runtime cleanup failed ($R0)"

  deepshell_cleanup_ok:
    DetailPrint "DeepShell Agent: runtime cleanup verified."
    ; 给系统一点时间释放被终止进程持有的文件句柄，再进入删除阶段。
    Sleep 500
!macroend
