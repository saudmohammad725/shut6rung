import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import { Chessboard, defaultArrowOptions, fenStringToPositionObject } from 'react-chessboard'
import type { Arrow, PieceDropHandlerArgs, PositionDataType, SquareRenderer } from 'react-chessboard'
import { checkFen, positionToFen } from './boardSetup'
import { analyzePosition } from './stockfish'
import { readPersisted, writePersisted, type PlayerColor } from './persist'
import './App.css'

const boot = readPersisted()

function initialGame(): Chess {
  if (!boot) return new Chess()
  try {
    return new Chess(boot.fen)
  } catch {
    return new Chess()
  }
}

function uciToArrow(uci: string): Arrow {
  const from = uci.slice(0, 2)
  const to = uci.slice(2, 4)
  return { startSquare: from, endSquare: to, color: '#fbbf24' }
}

const hintArrowOptions = {
  ...defaultArrowOptions,
  arrowWidthDenominator: 3,
  opacity: 0.98,
  activeOpacity: 0.98,
  arrowLengthReducerDenominator: 10,
}

/** الزمن يُحدَّد تلقائياً حسب مرحلة اللعبة — انظر movetimeMsForFen */
const ENGINE_OPTS = {} as const

const PIECE_BANK = [
  'wP',
  'wN',
  'wB',
  'wR',
  'wQ',
  'wK',
  'bP',
  'bN',
  'bB',
  'bR',
  'bQ',
  'bK',
] as const

function uciToSan(fen: string, uci: string): string {
  const from = uci.slice(0, 2) as Square
  const to = uci.slice(2, 4) as Square
  if (uci.length >= 5) {
    const g = new Chess(fen)
    const m = g.move({ from, to, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' })
    if (m) return m.san
  }
  const plain = new Chess(fen)
  const m0 = plain.move({ from, to })
  if (m0) return m0.san
  for (const promotion of ['q', 'r', 'b', 'n'] as const) {
    const g = new Chess(fen)
    const m = g.move({ from, to, promotion })
    if (m) return m.san
  }
  return uci
}

function tryMoveOnCopy(fen: string, from: Square, to: Square): Chess | null {
  const plain = new Chess(fen)
  if (plain.move({ from, to })) return plain
  for (const promotion of ['q', 'r', 'b', 'n'] as const) {
    const g = new Chess(fen)
    if (g.move({ from, to, promotion })) return g
  }
  return null
}

function applyUciToGame(g: Chess, uci: string): Chess | null {
  const from = uci.slice(0, 2) as Square
  const to = uci.slice(2, 4) as Square
  if (uci.length >= 5) {
    const next = new Chess(g.fen())
    if (next.move({ from, to, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' })) return next
  }
  return tryMoveOnCopy(g.fen(), from, to)
}

export default function App() {
  const [game, setGame] = useState(() => initialGame())
  const [myColor, setMyColor] = useState<PlayerColor>(() => boot?.myColor ?? 'w')
  const [hintArrows, setHintArrows] = useState<Arrow[]>([])
  const [hintFrom, setHintFrom] = useState<string | null>(null)
  const [hintTo, setHintTo] = useState<string | null>(null)
  const [hintText, setHintText] = useState('')
  const [hintSan, setHintSan] = useState('')
  const [suggestedUci, setSuggestedUci] = useState<string | null>(null)
  const [autoSuggestOnMyTurn, setAutoSuggestOnMyTurn] = useState(
    () => boot?.autoSuggestOnMyTurn ?? true,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const analyzedForFenRef = useRef<string | null>(null)

  const [setupMode, setSetupMode] = useState(false)
  const [setupPosition, setSetupPosition] = useState<PositionDataType>({})
  const [setupTurn, setSetupTurn] = useState<PlayerColor>('w')
  const [pendingPiece, setPendingPiece] = useState<string | null>(null)

  const fen = game.fen()
  const turn = game.turn()
  const myTurn = turn === myColor

  /** دائمًا لونك أسفل الرقعة (أبيض من جهة rank1، أسود من جهة rank8) */
  const boardOrientation = myColor === 'w' ? 'white' : 'black'

  const gameOver = game.isGameOver()

  useEffect(() => {
    if (setupMode) return
    writePersisted({
      v: 1,
      fen,
      myColor,
      autoSuggestOnMyTurn,
    })
  }, [fen, myColor, autoSuggestOnMyTurn, setupMode])

  const clearHints = useCallback(() => {
    setHintArrows([])
    setHintFrom(null)
    setHintTo(null)
    setHintText('')
    setHintSan('')
    setSuggestedUci(null)
    analyzedForFenRef.current = null
  }, [])

  const applyAnalysis = useCallback(
    (currentFen: string, result: Awaited<ReturnType<typeof analyzePosition>>) => {
      setSuggestedUci(result.bestUci)
      setHintArrows([uciToArrow(result.bestUci)])
      const from = result.bestUci.slice(0, 2)
      const to = result.bestUci.slice(2, 4)
      setHintFrom(from)
      setHintTo(to)
      const san = uciToSan(currentFen, result.bestUci)
      setHintSan(san)
      const score = result.scoreText ? ` ${result.scoreText}` : ''
      setHintText(
        `${from.toUpperCase()} → ${to.toUpperCase()} · ${san} — طابقها في المنتزه ثم سجّلها هنا.${score}`,
      )
    },
    [],
  )

  const applyFastHint = useCallback((currentFen: string, uci: string) => {
    setSuggestedUci(uci)
    setHintArrows([uciToArrow(uci)])
    setHintFrom(uci.slice(0, 2))
    setHintTo(uci.slice(2, 4))
    setHintSan(uciToSan(currentFen, uci))
    setHintText('تلميح سريع — يُحدَّث التقييم فورًا…')
  }, [])

  const runAnalysis = useCallback(
    async (currentFen: string) => {
      setError('')
      setLoading(true)
      try {
        const result = await analyzePosition(currentFen, {
          ...ENGINE_OPTS,
          onFastHint: (uci) => applyFastHint(currentFen, uci),
        })
        applyAnalysis(currentFen, result)
        analyzedForFenRef.current = currentFen
      } catch (e) {
        analyzedForFenRef.current = null
        setError(e instanceof Error ? e.message : 'تعذّر تشغيل المحرك.')
      } finally {
        setLoading(false)
      }
    },
    [applyAnalysis, applyFastHint],
  )

  /** عند دورك: اقتراح تلقائي (مناسب للمنتزه) — مرة لكل وضعية */
  useEffect(() => {
    if (setupMode) return
    if (gameOver || !myTurn) {
      if (!myTurn) clearHints()
      return
    }
    if (!autoSuggestOnMyTurn) return
    if (analyzedForFenRef.current === fen) return

    let cancelled = false
    setError('')
    setLoading(true)
    analyzePosition(fen, {
      ...ENGINE_OPTS,
      onFastHint: (uci) => applyFastHint(fen, uci),
    })
      .then((result) => {
        if (cancelled) return
        analyzedForFenRef.current = fen
        applyAnalysis(fen, result)
      })
      .catch((e) => {
        if (!cancelled) {
          analyzedForFenRef.current = null
          setError(e instanceof Error ? e.message : 'تعذّر تشغيل المحرك.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      setLoading(false)
    }
  }, [fen, myTurn, autoSuggestOnMyTurn, gameOver, applyAnalysis, applyFastHint, clearHints, setupMode])

  const statusLine = useMemo(() => {
    if (game.isCheckmate()) return 'كش ملك — انتهت الجولة.'
    if (game.isDraw()) return 'تعادل.'
    if (game.isCheck()) return 'كش!'
    return ''
  }, [game])

  const renderHintSquare: SquareRenderer = useCallback(
    ({ square, children }) => (
      <div className="sq-wrap">
        {children}
        {hintFrom === square ? <div className="hint-ring hint-ring-from" aria-hidden /> : null}
        {hintTo === square ? <div className="hint-ring hint-ring-to" aria-hidden /> : null}
      </div>
    ),
    [hintFrom, hintTo],
  )

  const requestBestMove = useCallback(async () => {
    if (setupMode) return
    if (!myTurn) {
      setError('سجّل حركة الخصم أولًا.')
      return
    }
    analyzedForFenRef.current = null
    await runAnalysis(game.fen())
  }, [game, myTurn, runAnalysis, setupMode])

  const applySuggestionOnBoard = useCallback(() => {
    if (!myTurn || !suggestedUci) return
    const next = applyUciToGame(game, suggestedUci)
    if (!next) {
      setError('تعذّر تطبيق النقلة.')
      return
    }
    setError('')
    setGame(next)
    clearHints()
  }, [game, myTurn, suggestedUci, clearHints])

  const resetBoard = useCallback(() => {
    setGame(new Chess())
    clearHints()
    setError('')
    setSetupMode(false)
    setPendingPiece(null)
  }, [clearHints])

  const startPlaceSetup = useCallback(() => {
    clearHints()
    setError('')
    setPendingPiece(null)
    setSetupPosition(fenStringToPositionObject(game.fen(), 8, 8))
    setSetupTurn(game.turn())
    setSetupMode(true)
  }, [game, clearHints])

  const cancelPlaceSetup = useCallback(() => {
    setSetupMode(false)
    setPendingPiece(null)
    setError('')
  }, [])

  const applyPlaceSetup = useCallback(() => {
    const built = positionToFen(setupPosition, setupTurn)
    const chk = checkFen(built)
    if (!chk.ok) {
      setError(chk.error || 'وضع غير صالح — تعدّل القطع أو الملوك.')
      return
    }
    try {
      const g = new Chess(built)
      setGame(g)
      setSetupMode(false)
      setPendingPiece(null)
      setError('')
      analyzedForFenRef.current = null
    } catch {
      setError('تعذّر تطبيق الوضع.')
    }
  }, [setupPosition, setupTurn])

  const onSetupPieceDrop = useCallback((args: PieceDropHandlerArgs) => {
    const { piece, sourceSquare, targetSquare } = args
    setSetupPosition((prev) => {
      const next: PositionDataType = { ...prev }
      if (piece.isSparePiece) {
        if (targetSquare) next[targetSquare] = { pieceType: piece.pieceType }
        return next
      }
      const moving = next[sourceSquare]
      if (!moving) return prev
      if (!targetSquare) {
        delete next[sourceSquare]
        return next
      }
      delete next[sourceSquare]
      next[targetSquare] = moving
      return next
    })
    return true
  }, [])

  const onPieceDrop = useCallback(
    (args: PieceDropHandlerArgs) => {
      if (setupMode) return onSetupPieceDrop(args)
      const { sourceSquare, targetSquare } = args
      if (!targetSquare) return false
      setError('')
      clearHints()
      const from = sourceSquare as Square
      const to = targetSquare as Square
      const currentFen = game.fen()
      const next = tryMoveOnCopy(currentFen, from, to)
      if (!next) return false
      setGame(next)
      return true
    },
    [setupMode, onSetupPieceDrop, game, clearHints],
  )

  const boardPosition: string | PositionDataType = setupMode ? setupPosition : fen

  return (
    <div className="app">
      <header className="header">
        <h1>شطرنج المنتزه</h1>
        <p className="lede">سجّل حركات الخصم هنا، ثم اتبع الاقتراح على لوحتك.</p>
      </header>

      {!gameOver && (
        <div className="turn-now-bar" role="status">
          {setupMode ? (
            <>
              <span className="tn-label">بعد «تم» الدور لـ</span>
              <strong className="tn-value">{setupTurn === 'w' ? 'أبيض' : 'أسود'}</strong>
              <span className="tn-sep" aria-hidden>
                ·
              </span>
              <span className="tn-sub">كان محفوظًا:</span>
              <span>{game.turn() === 'w' ? 'أبيض' : 'أسود'}</span>
            </>
          ) : (
            <>
              <span className="tn-label">دور</span>
              <strong className="tn-value">{turn === 'w' ? 'أبيض' : 'أسود'}</strong>
              <span className="tn-sep" aria-hidden>
                ·
              </span>
              <span className="tn-label">أنت</span>
              <strong>{myColor === 'w' ? 'أبيض' : 'أسود'}</strong>
              {!myTurn && <span className="tn-hint"> — سجّل الخصم</span>}
              {myTurn && <span className="tn-hint"> — دورك</span>}
            </>
          )}
        </div>
      )}

      {setupMode && (
        <div className="setup-panel" role="region" aria-label="ترتيب القطع">
          <p className="setup-lead">
            اسحب القطع بلا قواعد لعب. يمين على مربع = مسح. من البنك ثم مربع = إضافة.
          </p>
          <p className="setup-turn-line">
            بعد «تم» يلعب <strong>{setupTurn === 'w' ? 'الأبيض' : 'الأسود'}</strong> — كالوضع الحقيقي.
          </p>
          <div className="row">
            <span className="label">دور بعد «تم»</span>
            <button
              type="button"
              className={setupTurn === 'w' ? 'active' : ''}
              onClick={() => setSetupTurn('w')}
            >
              الأبيض
            </button>
            <button
              type="button"
              className={setupTurn === 'b' ? 'active' : ''}
              onClick={() => setSetupTurn('b')}
            >
              الأسود
            </button>
          </div>
          <div className="piece-bank" dir="ltr">
            {PIECE_BANK.map((pt) => (
              <button
                key={pt}
                type="button"
                className={`bank-piece ${pendingPiece === pt ? 'active' : ''}`}
                onClick={() => setPendingPiece((p) => (p === pt ? null : pt))}
              >
                {pt}
              </button>
            ))}
            <button type="button" className="bank-clear-pick" onClick={() => setPendingPiece(null)}>
              إلغاء اختيار
            </button>
          </div>
          <div className="row actions setup-actions">
            <button type="button" className="primary" onClick={applyPlaceSetup}>
              تم
            </button>
            <button type="button" onClick={() => setSetupPosition({})}>
              مسح
            </button>
            <button type="button" onClick={cancelPlaceSetup}>
              إلغاء
            </button>
          </div>
        </div>
      )}

      {!gameOver && !setupMode && (
        <div className={`phase-banner ${myTurn ? 'phase-me' : 'phase-opp'}`}>
          {myTurn ? (
            <p className="phase-one">
              <strong>دورك</strong> — اتبع السهم على لوحتك ثم سجّل النقلة هنا.
            </p>
          ) : (
            <p className="phase-one">
              <strong>دور الخصم</strong> — طابق حركته على الشاشة أولًا.
            </p>
          )}
        </div>
      )}

      {statusLine && <p className="status">{statusLine}</p>}

      {!gameOver && !setupMode && !myTurn && (
        <p className="helper-opp">سجّل حركة الخصم أولًا؛ ثم يظهر لك الاقتراح.</p>
      )}

      {myTurn && !gameOver && !setupMode && (
        <div className="move-callout" role="status">
          {loading && !hintSan ? (
            <p className="callout-loading">جاري…</p>
          ) : hintFrom && hintTo ? (
            <div className="callout-grid" dir="ltr">
              <span className="callout-label">من</span>
              <span className="callout-from">{hintFrom.toUpperCase()}</span>
              <span className="callout-arrow" aria-hidden>
                →
              </span>
              <span className="callout-label">إلى</span>
              <span className="callout-to">{hintTo.toUpperCase()}</span>
              {hintSan ? <span className="callout-san">({hintSan})</span> : null}
              {loading && hintSan ? (
                <span className="callout-refine" aria-live="polite">
                  يحدّث التقييم…
                </span>
              ) : null}
            </div>
          ) : !autoSuggestOnMyTurn ? (
            <p className="callout-loading">اضغط «اقتراح».</p>
          ) : null}
        </div>
      )}

      <div className="board-wrap" dir="ltr">
        <Chessboard
          key={myColor}
          options={{
            id: 'park-board',
            position: boardPosition,
            boardOrientation,
            onPieceDrop,
            onSquareClick: setupMode
              ? ({ square }) => {
                  if (!pendingPiece) return
                  setSetupPosition((p) => ({ ...p, [square]: { pieceType: pendingPiece } }))
                  setPendingPiece(null)
                }
              : undefined,
            onSquareRightClick: setupMode
              ? ({ square }) => {
                  setSetupPosition((p) => {
                    const n = { ...p }
                    delete n[square]
                    return n
                  })
                }
              : undefined,
            canDragPiece: setupMode ? () => true : undefined,
            allowDragOffBoard: setupMode,
            arrows: setupMode ? [] : hintArrows,
            arrowOptions: hintArrowOptions,
            squareRenderer: setupMode ? undefined : renderHintSquare,
            allowDrawingArrows: false,
            clearArrowsOnClick: false,
            clearArrowsOnPositionChange: false,
          }}
        />
      </div>

      <section className="controls controls-under-board" aria-label="إعدادات اللعب">
        <div className="row row-color">
          <span className="label">لونك (أسفل الرقعة)</span>
          <button
            type="button"
            className={myColor === 'w' ? 'active' : ''}
            onClick={() => setMyColor('w')}
          >
            أبيض
          </button>
          <button
            type="button"
            className={myColor === 'b' ? 'active' : ''}
            onClick={() => setMyColor('b')}
          >
            أسود
          </button>
        </div>
        <div className="row toggle-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoSuggestOnMyTurn}
              onChange={(e) => {
                setAutoSuggestOnMyTurn(e.target.checked)
                analyzedForFenRef.current = null
              }}
            />
            <span>اقتراح تلقائي عند دوري</span>
          </label>
        </div>
        <div className="row actions">
          <button type="button" onClick={startPlaceSetup} className={setupMode ? 'active' : ''}>
            ترتيب
          </button>
          <button
            type="button"
            className="primary"
            onClick={requestBestMove}
            disabled={loading || !myTurn || setupMode}
          >
            {loading ? (suggestedUci ? 'يحدّث…' : '…') : 'اقتراح'}
          </button>
          <button
            type="button"
            onClick={applySuggestionOnBoard}
            disabled={!myTurn || !suggestedUci || setupMode}
            title="يطبّق النقلة المقترحة على الرقعة بعد تنفيذها في المنتزه"
          >
            تطبيق
          </button>
          <button type="button" onClick={resetBoard}>
            جديد
          </button>
        </div>
      </section>

      {(hintText || hintSan) && (
        <div className="hint-panel" role="status">
          {hintSan && (
            <p className="hint-main">
              <span className="san">{hintSan}</span>
            </p>
          )}
          {hintText && <p className="hint-detail">{hintText}</p>}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="footer">
        <p>
          Stockfish (NNUE) — زمن التحليل يتكيّف مع مرحلة اللعبة (أسرع في الافتتاح، أدقّ في النهاية). يُحفظ
          تلقائيًا على هذا الجهاز.
        </p>
      </footer>
    </div>
  )
}
