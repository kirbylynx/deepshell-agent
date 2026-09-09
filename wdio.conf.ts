import { browser } from '@wdio/globals'

export const config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./tests/e2e/**/*.spec.ts'],
  maxInstances: 1,
  logLevel: 'warn',
  reporters: ['spec'],
  services: [['@wdio/tauri-service', {
    driverProvider: 'embedded',
    captureBackendLogs: false,
    startTimeout: 120_000,
  }]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': {
      application: './src-tauri/target/release/bundle/macos/DeepShell Agent.app/Contents/MacOS/deepshell-agent',
    },
  }],
  mochaOpts: { timeout: 120_000 },
  after: async () => {
    try {
      await browser.closeWindow()
    } catch {
      // 原生窗口关闭会结束 WebDriver 会话，属于预期行为。
    }
  },
}
