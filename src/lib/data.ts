// Data access for the map. map.ts calls query() or dataFile() and never
// touches fetch, the token, or the endpoint itself. Both are thin wrappers
// over the helpers the platform injects into every artifact page.

export type Row = Record<string, unknown>

declare global {
  interface Window {
    artifactQuery(sql: string): Promise<Row[]>
    artifactData(fileName: string): Promise<unknown>
  }
}

export function query(sql: string): Promise<Row[]> {
  return window.artifactQuery(sql)
}

export function dataFile<T = Row[]>(fileName: string): Promise<T> {
  return window.artifactData(fileName) as Promise<T>
}
