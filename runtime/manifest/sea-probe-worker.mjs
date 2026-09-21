import { parentPort } from 'node:worker_threads'

import('node-addon-require-builtin').then(module => {
  const loader = module.requireBuiltin('internal/modules/esm/loader')
  parentPort?.postMessage({
    ok: typeof loader.getOrInitializeCascadedLoader === 'function',
    packaged: Boolean(process.pkg),
    nativeAddon: 'node-addon-require-builtin',
    execPath: process.execPath,
  })
}).catch(error => {
  setImmediate(() => { throw error })
})
