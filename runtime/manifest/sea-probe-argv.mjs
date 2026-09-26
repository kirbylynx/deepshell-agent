// SEA argv 探针：自 spawn 分流验证用。把本进程的 argv 以 JSON 行写到 stdout，
// 由父进程断言脚本参数自 argv[2] 起（Node 约定）。覆盖两条自 spawn 路径：
//   1) pkg child_process 自 spawn（PKG_EXECPATH 注入）；
//   2) Windows 原生 CreateProcess 自 spawn（无 PKG_EXECPATH，如 windows-acl sandbox runner）。
process.stdout.write(`${JSON.stringify({ ok: true, argv: process.argv })}\n`)
