export interface TreeManifestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface TreeManifest {
  algorithm: string
  bytes: number
  files: number
  contentSha256: string
  entries: TreeManifestEntry[]
}

export const TREE_MANIFEST_ALGORITHM: string
export function normalizedTreeManifest(directory: string): Promise<TreeManifest>
export function assertEquivalentTrees(
  source: string,
  target: string,
  label?: string,
): Promise<{ source: TreeManifest; target: TreeManifest }>
