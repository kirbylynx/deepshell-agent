export function verifyReducedTree(current, baseline, label) {
  if (baseline?.status !== 'canonical') throw new Error(`${label} baseline 尚未就绪`)
  if (current?.status !== 'present') throw new Error(`${label} 当前指标缺失`)
  if (!(current.bytes < baseline.bytes)) {
    throw new Error(`${label} bytes 未严格下降：${current.bytes} >= ${baseline.bytes}`)
  }
  if (!(current.files <= baseline.files)) {
    throw new Error(`${label} files 上升：${current.files} > ${baseline.files}`)
  }
  return { deltaBytes: current.bytes - baseline.bytes, deltaFiles: current.files - baseline.files }
}

export function verifyReducedFile(current, baseline, label) {
  if (baseline?.status !== 'canonical') throw new Error(`${label} baseline 尚未就绪`)
  if (current?.status !== 'present') throw new Error(`${label} 当前指标缺失`)
  if (!(current.bytes < baseline.bytes)) {
    throw new Error(`${label} bytes 未严格下降：${current.bytes} >= ${baseline.bytes}`)
  }
  return { deltaBytes: current.bytes - baseline.bytes }
}
