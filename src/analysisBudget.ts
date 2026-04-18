import { Chess } from 'chess.js'

/** عدد القطع على الرقعة من جزء الـ FEN فقط */
export function pieceCountFromFen(fen: string): number {
  const placement = fen.trim().split(/\s+/)[0] ?? ''
  let n = 0
  for (const ch of placement) {
    if (ch === '/') continue
    if (ch >= '1' && ch <= '8') continue
    if (/[prnbqkPRNBQK]/.test(ch)) n++
  }
  return n
}

/**
 * زمن Stockfish (ملّي ثانية) حسب مرحلة اللعبة:
 * - رقعة مزدحمة: وقت أقصر (NNUE يستخلص التقييم بسرعة، لا «يطيل» انتظارك).
 * - نهاية مع قطع قليلة: وقت أطول قليلاً (ضبط كش ملك، تبديلات، ثغرات دقيقة).
 * - مواقف بخيارات قليلة جداً: غالباً تكتيك صارخ — نعطي هامش إضافي صغير.
 */
export function movetimeMsForFen(fen: string): number {
  const pieces = pieceCountFromFen(fen)
  let ms: number
  if (pieces <= 7) ms = 7200
  else if (pieces <= 10) ms = 6200
  else if (pieces <= 14) ms = 5400
  else if (pieces <= 20) ms = 4600
  else if (pieces <= 26) ms = 3800
  else ms = 3400

  try {
    const g = new Chess(fen)
    const nMoves = g.moves().length
    if (nMoves <= 6) ms += 900
    else if (nMoves <= 12) ms += 450
    else if (nMoves >= 42) ms -= 350
  } catch {
    /* fen غير صالح — نترك ms كما هي */
  }

  return Math.min(9500, Math.max(2600, ms))
}

/** ميزانية التلميح المحلي (ملّي) — متناسقة مع تعقيد الموقف */
export function fastHintBudgetMsForFen(fen: string): number {
  const pieces = pieceCountFromFen(fen)
  if (pieces <= 9) return 40
  if (pieces >= 30) return 22
  return 30
}
