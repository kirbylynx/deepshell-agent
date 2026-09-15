import { describe, expect, it } from 'vitest'
import { verifyReducedFile, verifyReducedTree } from '../../scripts/lib/package-size.mjs'

describe('包体积门禁', () => {
  const baseline = { status: 'canonical', bytes: 100, files: 10 }

  it('tree 的 bytes 必须严格下降且 files 不得上升', () => {
    expect(verifyReducedTree({ status: 'present', bytes: 90, files: 10 }, baseline, 'app')).toEqual({
      deltaBytes: -10,
      deltaFiles: 0,
    })
    expect(() => verifyReducedTree({ status: 'present', bytes: 90, files: 11 }, baseline, 'app')).toThrow('files 上升')
    expect(() => verifyReducedTree({ status: 'present', bytes: 100, files: 9 }, baseline, 'app')).toThrow('bytes 未严格下降')
  })

  it('file 本体只比较 bytes', () => {
    expect(verifyReducedFile({ status: 'present', bytes: 99 }, baseline, 'DMG')).toEqual({ deltaBytes: -1 })
  })

  it('pending baseline 必须失败关闭', () => {
    expect(() => verifyReducedTree({ status: 'present', bytes: 1, files: 1 }, { status: 'pending' }, 'Windows')).toThrow('尚未就绪')
  })
})
