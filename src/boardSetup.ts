import { validateFen } from 'chess.js'
import type { PositionDataType } from 'react-chessboard'

function pieceTypeToFenChar(pt: string): string {
  const color = pt[0]
  const type = pt[1].toLowerCase()
  return color === 'w' ? type.toUpperCase() : type
}

function guessCastling(pos: PositionDataType): string {
  let r = ''
  if (pos.e1?.pieceType === 'wK' && pos.h1?.pieceType === 'wR') r += 'K'
  if (pos.e1?.pieceType === 'wK' && pos.a1?.pieceType === 'wR') r += 'Q'
  if (pos.e8?.pieceType === 'bK' && pos.h8?.pieceType === 'bR') r += 'k'
  if (pos.e8?.pieceType === 'bK' && pos.a8?.pieceType === 'bR') r += 'q'
  return r || '-'
}

/** يبني FEN من ترتيب حر على الرقعة (بدون en passant؛ مناسب للمطابقة مع لوحة حقيقية) */
export function positionToFen(pos: PositionDataType, turn: 'w' | 'b'): string {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1] as const
  const rows: string[] = []
  for (const rank of ranks) {
    let empty = 0
    let row = ''
    for (const f of files) {
      const sq = `${f}${rank}`
      const cell = pos[sq]
      if (!cell) {
        empty++
      } else {
        if (empty) {
          row += empty
          empty = 0
        }
        row += pieceTypeToFenChar(cell.pieceType)
      }
    }
    if (empty) row += empty
    rows.push(row)
  }
  const board = rows.join('/')
  const castle = guessCastling(pos)
  return `${board} ${turn} ${castle} - 0 1`
}

export function checkFen(fen: string): { ok: true } | { ok: false; error: string } {
  const v = validateFen(fen)
  if (!v.ok) return { ok: false, error: v.error ?? 'وضع غير صالح' }
  return { ok: true }
}
