DeepShell Agent 免安装版说明
============================

版本：0.1.4
平台：Windows x64

------------------------------------------------------------
1. 系统要求 / System requirements
------------------------------------------------------------

- Windows 11 x64（本版本便携版真机验收基线）。
- 必须已安装 Microsoft Edge WebView2 Runtime（Evergreen）。
  如系统缺少 WebView2，请先从微软官方页面安装后再启动：
  https://developer.microsoft.com/microsoft-edge/webview2/
  缺失 WebView2 时应用可能无法创建窗口；这不是 Agent Runtime 故障。

本免安装版不附带 WebView2 安装器，使用系统已有的 WebView2 Runtime。

- Windows 11 x64 (the acceptance baseline for this portable build).
- Microsoft Edge WebView2 Runtime (Evergreen) must already be present.
  Install it from the official page above if it is missing.
This portable build does not bundle any WebView2 installer.

------------------------------------------------------------
2. 启动 / Launch
------------------------------------------------------------

解压后进入 "DeepShell Agent" 目录，双击 "DeepShell Agent.exe" 即可运行。
无需安装，无需 Node.js、npm、pnpm 或 DSH。

Extract, enter the "DeepShell Agent" folder, and double-click
"DeepShell Agent.exe". No installation and no Node.js / npm / pnpm / DSH
installation is required.

------------------------------------------------------------
3. 用户数据位置 / Where user data lives
------------------------------------------------------------

用户数据（会话、模型与凭据引用、日志、备份）统一保存在：

    %APPDATA%\com.deepshell.agent

免安装版不会把用户数据写入解压目录，也不会写入任何卸载注册项，
不会创建桌面或开始菜单快捷方式。

User data lives in %APPDATA%\com.deepshell.agent. This portable build
never writes user data into the extracted folder, never writes uninstall
registry entries, and never creates desktop or start-menu shortcuts.

------------------------------------------------------------
4. 与安装版共存 / Coexistence with the installed build
------------------------------------------------------------

- 免安装版与安装版共用同一应用标识与同一数据目录。
- 两种形式同一时间只能运行一个实例；一个正在运行时，启动另一个
  会唤起现有实例，而不会产生第二个窗口或第二个 Sidecar。
- 可以交替使用：退出当前实例后即可启动另一种形式。

- The portable and installed builds share one application identity and
  one data directory.
- Only one instance may run at a time. Launching the other form while
  one is running focuses the existing instance instead of creating a
  second window or a second Sidecar.
- Close the running instance before switching to the other form.

------------------------------------------------------------
5. 升级 / Upgrading
------------------------------------------------------------

1) 退出应用；
2) 将新版本解压到一个新目录；
3) 确认新版本可正常启动后，删除旧版本目录。

重要：不支持把已被新版本使用过的数据目录回退给旧版本继续读取。
升级前建议备份会话数据。

Quit the app, extract the new version into a new folder, verify it
starts, then delete the old folder. Downgrading the data directory back
to an older version is not supported; back up session data first.

------------------------------------------------------------
6. 删除与数据清理 / Uninstalling and deleting data
------------------------------------------------------------

- 删除程序：直接删除整个 "DeepShell Agent" 解压目录即可。用户数据
  不会被删除。
- 删除用户数据：手动删除 %APPDATA%\com.deepshell.agent 目录。
  该操作不可恢复，请先确认会话与凭据不再需要。

- To remove the program, delete the extracted "DeepShell Agent" folder.
  Your user data is kept.
- To remove user data, delete %APPDATA%\com.deepshell.agent manually.
  This cannot be undone; make sure you no longer need the sessions and
  credentials before deleting.
