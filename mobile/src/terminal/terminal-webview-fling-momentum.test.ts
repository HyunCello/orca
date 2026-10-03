// @vitest-environment happy-dom
// A fling must coast on both ways a touch can end.
//
// Android reports a gesture the platform claimed — a parent scrollable, a system edge swipe, a
// second finger arriving — as `touchcancel` rather than `touchend`. While momentum was launched
// from `touchend` alone, the same swipe coasted or stopped dead depending on which event arrived,
// which is the inconsistency this pins. Like `tap-routing` and `wheel-scroll`, this drives the
// real bundle the WebView loads, with the engine and the frame clock stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_DOCUMENT_SCRIPT } from './terminal-webview-document-script.generated'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html'

const CELL_HEIGHT = 15
const CELL_WIDTH = 8
/** Where a swipe starts and how far each step travels; four steps is a fling, not a tap. */
const SWIPE_START_Y = 100
const SWIPE_STEP_PX = 40
const SWIPE_STEPS = 4

type BufferState = { baseY: number; type: 'alternate' | 'normal'; viewportY: number }

function makeTerminal(buffer: BufferState, scrollLines: (lines: number) => void) {
  const terminal = {
    cols: 40,
    rows: 24,
    options: { fontSize: 13 },
    modes: { mouseTrackingMode: 'none' as string },
    element: null as HTMLElement | null,
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: CELL_WIDTH, height: CELL_HEIGHT } } }
      }
    },
    buffer: {
      active: {
        get baseY() {
          return buffer.baseY
        },
        get type() {
          return buffer.type
        },
        get viewportY() {
          return buffer.viewportY
        },
        cursorY: 0,
        length: 1,
        getLine: () => null
      }
    },
    write(_data: string, callback?: () => void) {
      callback?.()
    },
    open(surface: HTMLElement) {
      terminal.element = surface
    },
    loadAddon() {},
    resize() {},
    clear() {},
    reset() {},
    refresh() {},
    selectAll() {},
    clearSelection() {},
    select() {},
    scrollLines,
    scrollToBottom() {},
    scrollToLine() {},
    attachCustomKeyEventHandler() {},
    getSelection: () => '',
    onData: () => ({ dispose() {} }),
    onLineFeed: () => ({ dispose() {} }),
    onScroll: () => ({ dispose() {} }),
    onWriteParsed: () => ({ dispose() {} }),
    dispose() {}
  }
  return terminal
}

describe('terminal WebView fling momentum', () => {
  let animationFrames: Array<(time: number) => void>
  let buffer: BufferState
  let now: number
  let scrollLines: ReturnType<typeof vi.fn>
  let surface: HTMLElement

  function drainFrames(count: number, stepMs = 16): void {
    for (let i = 0; i < count; i++) {
      now += stepMs
      const pending = animationFrames.length
      for (let frame = 0; frame < pending; frame++) {
        animationFrames.shift()?.(now)
      }
    }
  }

  function fireTouch(type: string, y: number): void {
    const event = new Event(type, { bubbles: true, cancelable: true })
    // Why: happy-dom has no TouchEvent, so the touch list the handlers read is defined on a
    // plain Event, as `tap-routing` does for the same reason.
    Object.defineProperty(event, 'touches', {
      value:
        type === 'touchend' || type === 'touchcancel'
          ? []
          : [{ identifier: 0, clientX: 40, clientY: y, target: surface }]
    })
    Object.defineProperty(event, 'target', { value: surface })
    surface.dispatchEvent(event)
    drainFrames(1)
  }

  /**
   * One fling whose only variable is how it ends: `direction` +1 drags the finger down the screen,
   * which scrolls up into the scrollback.
   */
  function fling(endEvent: 'touchend' | 'touchcancel', direction: 1 | -1): number {
    buffer = { baseY: 500, type: 'normal', viewportY: 300 }
    fireTouch('touchstart', SWIPE_START_Y)
    for (let step = 1; step <= SWIPE_STEPS; step++) {
      now += 8
      fireTouch('touchmove', SWIPE_START_Y + direction * step * SWIPE_STEP_PX)
    }
    drainFrames(2)
    const afterDrag = buffer.viewportY
    now += 8
    fireTouch(endEvent, 0)
    drainFrames(120)
    return afterDrag - buffer.viewportY
  }

  beforeEach(() => {
    animationFrames = []
    now = 1_000_000
    buffer = { baseY: 500, type: 'normal', viewportY: 300 }
    scrollLines = vi.fn((lines: number) => {
      buffer.viewportY = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines))
    })
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      animationFrames[id - 1] = () => {}
    })
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true })

    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const webWindow = window as unknown as {
      Terminal: new () => unknown
      ReactNativeWebView: { postMessage: (data: string) => void }
    }
    webWindow.Terminal = function () {
      return makeTerminal(buffer, scrollLines)
    } as unknown as new () => unknown
    webWindow.ReactNativeWebView = { postMessage: vi.fn() }
    new Function(TERMINAL_DOCUMENT_SCRIPT)()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'init', cols: 40, rows: 24, initialData: '' })
      })
    )
    drainFrames(10)
    surface = document.getElementById('terminal-surface') as HTMLElement
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('coasts after the platform reports the finger leaving as touchend', () => {
    expect(fling('touchend', 1)).toBeGreaterThan(0)
  })

  it('coasts the same way when the platform reports it as touchcancel', () => {
    expect(fling('touchcancel', 1)).toBeGreaterThan(0)
  })

  it('carries a cancelled fling as far as a released one, in either direction', () => {
    // Why: the two events are the same end of the same gesture, so the distance travelled is the
    // assertion that matters — a cancel that abandoned the velocity would coast zero.
    expect(fling('touchcancel', 1)).toBe(fling('touchend', 1))
    expect(fling('touchcancel', -1)).toBe(fling('touchend', -1))
  })

  it('starts no momentum when a cancelled touch never moved', () => {
    buffer = { baseY: 500, type: 'normal', viewportY: 300 }
    fireTouch('touchstart', SWIPE_START_Y)
    fireTouch('touchcancel', 0)
    drainFrames(120)
    expect(buffer.viewportY).toBe(300)
    expect(scrollLines).not.toHaveBeenCalled()
  })
})
