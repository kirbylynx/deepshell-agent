export function uniqueMatchingArtifact(
  names: string[],
  predicate: (name: string) => boolean,
  label: string,
): string | null
