/**
 * Stockfish (UCI) في Web Worker — ملفات المحرك في public/stockfish/
 * عند الفشل يُستخدم محرك بسيط محلي (بدون WASM).
 */

import { movetimeMsForFen } from './analysisBudget'

export { movetimeMsForFen } from './analysisBudget'
import { getFallbackBestUci, getSmartHintUci } from './fastEngine'

export type AnalysisResult = {
  bestUci: string
  ponder?: string
  scoreText: string
  lines: string[]
}

function workerScriptUrl(): string {
  let base = import.meta.env.BASE_URL || '/'
  if (!base.endsWith('/')) base += '/'
  return new URL(`${base}stockfish/stockfish.js#,worker`, window.location.href).href
}

let worker: Worker | null = null
let readyPromise: Promise<void> | null = null
let queue: Promise<unknown> = Promise.resolve()
let engineOptionsSent = false

/**
 * Stockfish NNUE في المتصفح = مستوى «فوق البطولة العالمية» إذا أعطيته وقتاً كافياً.
 * المهلات الخارجية تُشتق من movetime حتى لا يُقطع البحث العميق.
 */
function analysisOuterTimeoutMs(movetime: number): number {
  return Math.max(35000, movetime + 22000)
}

export type AnalyzeOptions = {
  /** @deprecated يُتجاهل — البحث يعتمد على movetime فقط */
  depth?: number
  movetime?: number
  /** يُستدعى فورًا بتلميح سريع من محرك البحث المحلي قبل اكتمال Stockfish */
  onFastHint?: (uci: string) => void
}

function getWorker(): Worker {
  if (!worker) {
    const url = workerScriptUrl()
    worker = new Worker(url)
    worker.addEventListener('error', (e) => {
      console.error('Stockfish worker:', e)
    })
  }
  return worker
}

function waitForMessage(w: Worker, predicate: (data: string) => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      w.removeEventListener('message', onMsg)
      reject(new Error('انتهت مهلة الاتصال بالمحرك'))
    }, ms)

    function onMsg(e: MessageEvent) {
      const text = String(e.data ?? '')
      if (predicate(text)) {
        clearTimeout(t)
        w.removeEventListener('message', onMsg)
        resolve()
      }
    }

    w.addEventListener('message', onMsg)
  })
}

function ensureReady(w: Worker): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    w.postMessage('uci')
    await waitForMessage(w, (t) => t.includes('uciok'), 45000)
    if (!engineOptionsSent) {
      engineOptionsSent = true
      /* أقصى قوى عملية للنسخة المضمّنة: ذاكرة بحث + خيوط (إن دعمها الـ WASM) */
      w.postMessage('setoption name Hash value 512')
      w.postMessage('setoption name Threads value 4')
      w.postMessage('setoption name UCI_LimitStrength value false')
      w.postMessage('setoption name MultiPV value 1')
      w.postMessage('setoption name Contempt value 0')
    }
    w.postMessage('isready')
    await waitForMessage(w, (t) => t.includes('readyok'), 45000)
  })().catch((e) => {
    readyPromise = null
    throw e
  })
  return readyPromise
}

function parseScoreFromLines(lines: string[]): { scoreText: string } {
  let cp: number | undefined
  let mate: number | undefined

  for (const line of lines) {
    if (!line.startsWith('info ') || !line.includes(' score ')) continue
    const mateM = line.match(/\bscore mate (-?\d+)/)
    const cpM = line.match(/\bscore cp (-?\d+)/)
    if (mateM) mate = parseInt(mateM[1], 10)
    else if (cpM) cp = parseInt(cpM[1], 10)
  }

  if (mate !== undefined) {
    return {
      scoreText: mate > 0 ? `كش ملك في ${mate}` : `كش ملك عليك في ${-mate}`,
    }
  }
  if (cp !== undefined) {
    const pawns = (cp / 100).toFixed(2)
    const sign = cp > 0 ? '+' : ''
    return { scoreText: `تقييم تقريبي: ${sign}${pawns} (${cp} سنتي-بيدق)` }
  }
  return { scoreText: '' }
}

function runAnalyze(w: Worker, fen: string, movetime: number): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const collected: string[] = []

    function onMsg(e: MessageEvent) {
      const text = String(e.data ?? '')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        collected.push(line)
        if (line.startsWith('bestmove')) {
          clearTimeout(timeout)
          w.removeEventListener('message', onMsg)
          const parts = line.trim().split(/\s+/)
          const best = parts[1]
          const ponder = parts[3]
          if (!best || best === '(none)') {
            reject(new Error('لا توجد حركة قانونية'))
            return
          }
          const { scoreText } = parseScoreFromLines(collected)
          resolve({
            bestUci: best,
            ponder: ponder && ponder !== '(none)' ? ponder : undefined,
            scoreText,
            lines: collected,
          })
          return
        }
      }
    }

    /* يجب أن يتجاوز movetime بحدّ كافٍ حتى لا يُرفض bestmove بعد بحث طويل */
    const waitMs = Math.min(240000, movetime + 12000)
    const timeout = window.setTimeout(() => {
      w.removeEventListener('message', onMsg)
      reject(new Error('انتهت مهلة التحليل'))
    }, waitMs)

    w.addEventListener('message', onMsg)
    w.postMessage('ucinewgame')
    w.postMessage(`position fen ${fen}`)
    w.postMessage(`go movetime ${movetime}`)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function runStockfishOnce(fen: string, movetime: number): Promise<AnalysisResult> {
  const w = getWorker()
  return ensureReady(w).then(() => runAnalyze(w, fen, movetime))
}

/** وسيط زمني تقريبي (وسط مراحل اللعبة) — للعرض أو تجاوز يدوي */
export const DEFAULT_MOVETIME_MS = 5000

export async function analyzePosition(fen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const movetime = opts.movetime ?? movetimeMsForFen(fen)

  /* إطار رسم واحد ثم تلميح خفيف — يمنع إحساس التجميد من البحث الثقيل على الخيط الرئيسي */
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  const fast = getSmartHintUci(fen)
  if (fast && opts.onFastHint) {
    try {
      opts.onFastHint(fast)
    } catch {
      /* ignore */
    }
  }

  const task = (async () => {
    try {
      return await withTimeout(runStockfishOnce(fen, movetime), analysisOuterTimeoutMs(movetime))
    } catch {
      resetEngine()
      const uci = fast ?? getFallbackBestUci(fen)
      if (!uci) throw new Error('لا توجد حركة قانونية')
      return {
        bestUci: uci,
        scoreText: 'مقترح احتياطي (المتصفح ما شغّل Stockfish)',
        lines: [],
      }
    }
  })()

  queue = queue.then(() => task).catch(() => {})
  return task
}

export function resetEngine() {
  if (worker) {
    try {
      worker.postMessage('quit')
    } catch {
      /* ignore */
    }
    worker.terminate()
    worker = null
    readyPromise = null
    engineOptionsSent = false
    queue = Promise.resolve()
  }
}
