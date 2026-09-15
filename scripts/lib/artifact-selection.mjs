export function uniqueMatchingArtifact(names, predicate, label) {
  const matches = names.filter(predicate).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (matches.length > 1) throw new Error(`${label} 存在多个候选，必须显式指定：${matches.join(', ')}`)
  return matches[0] ?? null
}
