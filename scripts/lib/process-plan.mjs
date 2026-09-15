export function packageCommandPlan(command, args, platform = process.platform) {
  if (platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  }
  return { command, args }
}
