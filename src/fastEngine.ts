/**
 * محرك بحث محلي سريع — ألفا-بيتا + إنهاء هادئ (التقاطات فقط).
 * يُستخدم كتلميح فوري ثم يأتي Stockfish (NNUE) للنتيجة النهائية.
 */
import { Chess } from 'chess.js'
import type { Color, Move, PieceSymbol, Square } from 'chess.js'
import { fastHintBudgetMsForFen } from './analysisBudget'

const VAL: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
}

function valOf(t: PieceSymbol): number {
  return VAL[t]
}

const FILES = 'abcdefgh'

function fileRank(sq: Square): { file: number; rank: number } {
  return { file: FILES.indexOf(sq[0]), rank: parseInt(sq[1], 10) }
}

/** منظور اللاعب: الصفوف «للأمام» للبيادق وغيرها */
function rankFromOwnSide(color: Color, sq: Square): number {
  const { rank } = fileRank(sq)
  return color === 'w' ? rank - 1 : 8 - rank
}

/** جداول مربعات خفيفة — ترفع جودة التقييم السطحي بلا بحث عميق */
function pstBonus(piece: PieceSymbol, color: Color, sq: Square): number {
  const { file, rank } = fileRank(sq)
  const rf = rankFromOwnSide(color, sq)

  if (piece === 'p') {
    const idx = Math.min(7, Math.max(0, rf))
    let b = [0, 0, 6, 12, 18, 28, 38, 0][idx] ?? 0
    if (file === 3 || file === 4) b += 10
    else if (file === 2 || file === 5) b += 4
    return b
  }
  if (piece === 'n' || piece === 'b') {
    const cr = Math.min(file, 7 - file)
    const rr = Math.min(rank - 1, 8 - rank)
    const edge = cr + rr
    if (edge >= 5) return piece === 'n' ? 22 : 18
    if (edge >= 4) return piece === 'n' ? 14 : 12
    return piece === 'n' ? 6 : 5
  }
  if (piece === 'r') {
    const cr = Math.min(file, 7 - file)
    const rr = Math.min(rank - 1, 8 - rank)
    return cr <= 1 || rr <= 1 ? 12 : 4
  }
  if (piece === 'q') {
    const cr = Math.min(file, 7 - file)
    const rr = Math.min(rank - 1, 8 - rank)
    return cr <= 2 && rr <= 2 ? 8 : 2
  }
  if (piece === 'k') {
    const mid = Math.abs(3.5 - file) + Math.abs(4.5 - rank)
    return mid <= 2 ? -6 : mid <= 3.5 ? -2 : 4
  }
  return 0
}

/** تقييم من منظور الأبيض: موجب = أفضل للأبيض */
function evalWhiteMinusBlack(c: Chess): number {
  const b = c.board()
  let s = 0
  for (let ri = 0; ri < 8; ri++) {
    for (let fi = 0; fi < 8; fi++) {
      const cell = b[ri][fi]
      if (!cell) continue
      const rank = 8 - ri
      const sq = `${FILES[fi]}${rank}` as Square
      const v = VAL[cell.type] + pstBonus(cell.type, cell.color, sq)
      s += cell.color === 'w' ? v : -v
    }
  }
  return s
}

/** قيمة للطرف صاحب الدور: موجب = جيد له */
function evalStm(c: Chess): number {
  const w = evalWhiteMinusBlack(c)
  return c.turn() === 'w' ? w : -w
}

function capturesFirst(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => {
    const sa = a.captured ? valOf(a.captured) * 10 - valOf(a.piece) : -1
    const sb = b.captured ? valOf(b.captured) * 10 - valOf(b.piece) : -1
    return sb - sa
  })
}

/** كش أولاً، ثم التقاطات، ثم هادئة — يحسّن ألفا-بيتا في الجذر */
function orderRootMoves(chess: Chess, moves: Move[]): Move[] {
  const checks: Move[] = []
  const caps: Move[] = []
  const quiet: Move[] = []
  for (const m of moves) {
    chess.move(m)
    const ch = chess.inCheck()
    chess.undo()
    if (ch) checks.push(m)
    else if (m.captured) caps.push(m)
    else quiet.push(m)
  }
  return [...checks, ...capturesFirst(caps), ...quiet]
}

function quiescence(c: Chess, alpha: number, beta: number, qd: number): number {
  const stand = evalStm(c)
  if (qd <= 0) return stand
  let a = Math.max(alpha, stand)
  if (a >= beta) return a

  const caps = capturesFirst(c.moves({ verbose: true }).filter((m) => m.captured))
  for (const m of caps) {
    c.move(m)
    const sc = -quiescence(c, -beta, -a, qd - 1)
    c.undo()
    if (sc >= beta) return sc
    a = Math.max(a, sc)
  }
  return a
}

function negamax(c: Chess, depth: number, alpha: number, beta: number): number {
  if (depth === 0) return quiescence(c, alpha, beta, 3)

  const moves = c.moves({ verbose: true })
  if (!moves.length) {
    if (c.isCheckmate()) return -1e6
    return 0
  }

  const ordered = capturesFirst(moves)
  let best = -Infinity
  for (const m of ordered) {
    c.move(m)
    const s = -negamax(c, depth - 1, -beta, -alpha)
    c.undo()
    best = Math.max(best, s)
    alpha = Math.max(alpha, s)
    if (alpha >= beta) break
  }
  return best
}

function moveToUci(m: Move): string {
  return m.from + m.to + (m.promotion ?? '')
}

/**
 * نقلة واحدة بتقييم محسّن — احتياطي عندما لا يُسمح ببحث أعمق.
 */
export function getQuickHintUci(fen: string): string | null {
  const chess = new Chess(fen)
  const moves = chess.moves({ verbose: true })
  if (!moves.length) return null
  const ordered = orderRootMoves(chess, moves)
  let bestM = ordered[0]
  let bestS = -Infinity
  for (const m of ordered) {
    chess.move(m)
    const s = -evalStm(chess)
    chess.undo()
    if (s > bestS) {
      bestS = s
      bestM = m
    }
  }
  return moveToUci(bestM)
}

export function getFastBestUci(
  fen: string,
  maxDepth = 4,
  budgetMs: number | undefined = undefined,
): string | null {
  const chess = new Chess(fen)
  const moves = chess.moves({ verbose: true })
  if (!moves.length) return null

  const ordered = orderRootMoves(chess, moves)
  let bestM = ordered[0]
  const start = typeof performance !== 'undefined' ? performance.now() : 0
  const budget = budgetMs ?? 48

  for (let d = 2; d <= maxDepth; d++) {
    let bestS = -Infinity
    let localBest = ordered[0]
    for (const m of ordered) {
      chess.move(m)
      const s = -negamax(chess, d - 1, -Infinity, Infinity)
      chess.undo()
      if (s > bestS) {
        bestS = s
        localBest = m
      }
    }
    bestM = localBest
    if (typeof performance !== 'undefined' && performance.now() - start > budget) break
  }

  return moveToUci(bestM)
}

/**
 * تلميح قبل Stockfish: أذكى من نقلة واحدة، مع سقف زمني يحمي سلاسة الواجهة.
 */
export function getSmartHintUci(fen: string): string | null {
  return getFastBestUci(fen, 3, fastHintBudgetMsForFen(fen))
}

export function getFallbackBestUci(fen: string, maxDepth = 5): string | null {
  return getFastBestUci(fen, maxDepth, 100)
}
