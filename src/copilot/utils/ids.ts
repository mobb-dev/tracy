export function makeStableId(id: string): string {
  return id.replace(/__vscode-\d+$/, '')
}

export function makeSafe(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Convenience: trim VS Code suffix and sanitize for filenames/keys */
export function normalizeToolId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined
  }
  return makeSafe(makeStableId(id))
}
