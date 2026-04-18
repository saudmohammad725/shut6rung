import { Chess } from 'chess.js'

export type PlayerColor = 'w' | 'b'

const KEY = 'shut6tung-park-chess'

export type PersistedStateV1 = {
  v: 1
  fen: string
  myColor: PlayerColor
  autoSuggestOnMyTurn: boolean
}

export function readPersisted(): PersistedStateV1 | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as PersistedStateV1
    if (data.v !== 1 || typeof data.fen !== 'string') return null
    new Chess(data.fen)
    if (data.myColor !== 'w' && data.myColor !== 'b') return null
    return data
  } catch {
    return null
  }
}

export function writePersisted(state: PersistedStateV1): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* وضع الخصوصية أو امتلاء التخزين */
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
