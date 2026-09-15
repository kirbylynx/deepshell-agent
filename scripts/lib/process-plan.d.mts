export function packageCommandPlan(
  command: string,
  args: string[],
  platform?: NodeJS.Platform,
): { command: string; args: string[] }
