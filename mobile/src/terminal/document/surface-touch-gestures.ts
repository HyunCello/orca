import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import { touchesInRoot } from './document-host-seams'
import { clampPan, getCellHeight } from './fit-scale'
import { notify } from './host-notify'
import { attachSurfaceMouseClickDragHandler } from './mouse-click-drag'
import { routeScrollLines, shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import {
  applyNormalBufferScrollDelta,
  enqueueNormalBufferScrollDelta,
  resetSmoothScrollOffset
} from './normal-buffer-smooth-scroll'
import { dispatcherShouldBlockSurface } from './tap-dispatch'
import {
  applyTextScale,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  snapToTextScalePreset
} from './text-scaling'
import { getTotalScale, updateTransform } from './viewport-transform'
import { viewportPoint } from './viewport-cell'
import { attachSurfaceWheelHandler } from './wheel-scroll'

/** A surface that has already been wired, so a re-mount does not stack handlers. */
type TerminalGestureSurface = HTMLElement & { __orcaSurfaceHandlersAttached?: boolean }

/** The live touch gesture: the last point, the velocity, and the pinch it may be in. */
export type TerminalTouchState = {
  lastX: number
  lastY: number
  lastTime: number
  velY: number
  accumDelta: number
  momentumId: number | null
  isPinching: boolean
  pinchDist: number
  pinchScale: number
  pinchSurfX: number
  pinchSurfY: number
}

export function updateTouchVelocity(scope: TerminalDocumentScope, deltaY: number, dt: number) {
  if (dt <= 0) {
    return
  }
  const instantVelocity = deltaY / dt
  if (!Number.isFinite(instantVelocity)) {
    return
  }
  // Why: touchmove cadence is uneven in WebView. Blend recent samples so
  // momentum launch doesn't inherit a one-frame spike or stall.
  scope.touchGesture.velY =
    scope.touchGesture.velY === 0
      ? instantVelocity
      : scope.touchGesture.velY * 0.55 + instantVelocity * 0.45
}

export function getDistance(a: Touch, b: Touch) {
  const dx = a.clientX - b.clientX,
    dy = a.clientY - b.clientY
  return Math.sqrt(dx * dx + dy * dy)
}

/** The pinch's anchor, in the grid's frame: the point between the two fingers. */
function pinchMidpoint(scope: TerminalDocumentScope, a: Touch, b: Touch) {
  return viewportPoint(scope, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
}

/**
 * Ends a live pinch: snap to the nearest text-scale preset and, when a finger is
 * still down, re-seed the touch sample so the remaining finger keeps scrolling.
 *
 * Both the platform's own end (`touchend`) and its cancellation run this — a pinch the
 * system takes over must still commit its size, or the terminal stays at a scale nobody chose.
 */
function finishSurfacePinch(scope: TerminalDocumentScope, touches: ArrayLike<Touch>) {
  scope.touchGesture.isPinching = false
  // Why: a finished pinch snaps to the nearest preset and becomes the new
  // font size (reflowing the grid), so pinch-to-zoom IS the in-terminal way
  // to set the text size. The CSS pinch zoom (userScale) is reset; the real
  // size change reflows columns and RN persists + resizes the PTY to match.
  const target = snapToTextScalePreset(scope.currentTextScale * scope.userScale)
  const changed = target !== scope.currentTextScale
  scope.userScale = 1
  scope.panX = 0
  scope.panY = 0
  applyTextScale(scope, target)
  updateTransform(scope)
  notify(scope, { type: 'font-scale-changed', fontScale: target })
  if (changed) {
    notify(scope, { type: 'haptic', kind: 'selection' })
  }
  if (touches.length === 1) {
    scope.touchGesture.lastX = touches[0].clientX
    scope.touchGesture.lastY = touches[0].clientY
    scope.touchGesture.lastTime = Date.now()
    scope.touchGesture.velY = 0
    scope.touchGesture.accumDelta = 0
  }
}

/**
 * The momentum loop, launched when the last finger leaves the surface.
 *
 * Ruling 21: it self-reschedules until friction takes the velocity under the floor, and it reads
 * the gesture out of the scope, so a terminal that replaced this one never inherits it.
 */
function launchSurfaceMomentum(scope: TerminalDocumentScope) {
  let vel = scope.touchGesture.velY
  const FRICTION = 0.972
  const MIN_VEL = 0.012
  let lastMomentumTime = performance.now()
  function momentumStep(frameTime: number) {
    const elapsed = Math.max(1, Math.min(50, frameTime - lastMomentumTime))
    lastMomentumTime = frameTime
    vel *= FRICTION ** (elapsed / 16)
    if (Math.abs(vel) < MIN_VEL) {
      scope.touchGesture.momentumId = null
      return
    }
    const delta = vel * elapsed
    if (shouldRouteScrollToTerminalInput(scope)) {
      resetSmoothScrollOffset(scope)
      const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
      scope.touchGesture.accumDelta += delta
      const lines = Math.trunc(scope.touchGesture.accumDelta / effectiveCellH)
      if (lines !== 0) {
        scope.touchGesture.accumDelta -= lines * effectiveCellH
        routeScrollLines(scope, lines, scope.touchGesture.lastX, scope.touchGesture.lastY)
      }
    } else {
      if (!applyNormalBufferScrollDelta(scope, delta)) {
        scope.touchGesture.momentumId = null
        return
      }
    }
    scope.touchGesture.momentumId = scheduleDocumentFrame(scope, momentumStep)
  }
  if (Math.abs(vel) > MIN_VEL) {
    scope.touchGesture.momentumId = scheduleDocumentFrame(scope, momentumStep)
  }
}

/**
 * The end of a surface gesture, as `touchend` reports it.
 *
 * The engine's touch list is only trusted here: `touchend` carries the touches that are still down,
 * so a one-finger lift after a pinch leaves the list with the finger that stayed.
 */
function endSurfaceGesture(scope: TerminalDocumentScope, touches: ArrayLike<Touch>) {
  if (scope.touchGesture.isPinching && touches.length < 2) {
    finishSurfacePinch(scope, touches)
    return
  }
  if (touches.length === 0) {
    launchSurfaceMomentum(scope)
  }
}

/**
 * The end of a surface gesture, as the platform cancels it.
 *
 * Why both events: Android cancels a touch when a parent scrollable or a system edge gesture
 * claims it, and reports the finger leaving that way rather than as `touchend`. Launching momentum
 * only from `touchend` is what made a fling coast on one swipe and stop dead on the next.
 *
 * A cancel owes no later `touchmove`, so the fling coasts from the velocity already measured
 * instead of waiting for a list the cancelling platform is free to hand over empty. A pinch the
 * platform cancelled has no committed scale, and the size it was left at is the size it keeps.
 */
function cancelSurfaceGesture(scope: TerminalDocumentScope) {
  scope.touchGesture.isPinching = false
  launchSurfaceMomentum(scope)
}

export function attachSurfaceEventHandlers(
  scope: TerminalDocumentScope,
  targetSurface: TerminalGestureSurface
) {
  if (!targetSurface || targetSurface.__orcaSurfaceHandlersAttached) {
    return
  }
  targetSurface.__orcaSurfaceHandlersAttached = true
  // Why: init() swaps in a new hidden surface to avoid flicker; each
  // replacement needs gesture handlers or tab-switch replays stop scrolling.
  targetSurface.addEventListener(
    'mousedown',
    function (e) {
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )
  targetSurface.addEventListener(
    'click',
    function (e) {
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )

  attachSurfaceWheelHandler(scope, targetSurface)
  attachSurfaceMouseClickDragHandler(scope, targetSurface)

  targetSurface.addEventListener(
    'touchstart',
    function (e) {
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (scope.touchGesture.momentumId) {
        cancelAnimationFrame(scope.touchGesture.momentumId)
        scope.touchGesture.momentumId = null
      }
      const touches = touchesInRoot(scope.root, e.touches)
      if (touches.length === 2) {
        scope.touchGesture.isPinching = true
        scope.smoothScrollOffsetY = 0
        scope.touchGesture.pinchDist = getDistance(touches[0], touches[1])
        scope.touchGesture.pinchScale = scope.userScale
        const mid = pinchMidpoint(scope, touches[0], touches[1])
        const total = getTotalScale(scope)
        scope.touchGesture.pinchSurfX = (mid.x - scope.panX) / total
        scope.touchGesture.pinchSurfY = (mid.y - scope.panY) / total
      } else if (touches.length === 1) {
        scope.touchGesture.isPinching = false
        scope.touchGesture.lastX = touches[0].clientX
        scope.touchGesture.lastY = touches[0].clientY
        scope.touchGesture.lastTime = Date.now()
        scope.touchGesture.velY = 0
        scope.touchGesture.accumDelta = 0
      }
    },
    { capture: true, passive: true }
  )

  targetSurface.addEventListener(
    'touchmove',
    function (e) {
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term) {
        return
      }
      e.preventDefault()
      e.stopPropagation()

      const touches = touchesInRoot(scope.root, e.touches)
      if (touches.length === 2) {
        scope.touchGesture.isPinching = true
        const dist = getDistance(touches[0], touches[1])
        const mid = pinchMidpoint(scope, touches[0], touches[1])

        const ratio = dist / scope.touchGesture.pinchDist
        // Why: userScale is a CSS multiplier on the current font size; bound it so
        // the resulting apparent size (currentTextScale × userScale) stays within
        // the preset range, since release snaps to one of those presets.
        const loScale = MIN_TEXT_SCALE / scope.currentTextScale
        const hiScale = MAX_TEXT_SCALE / scope.currentTextScale
        scope.userScale = Math.max(
          loScale,
          Math.min(hiScale, scope.touchGesture.pinchScale * ratio)
        )
        const total = getTotalScale(scope)
        scope.panX = mid.x - scope.touchGesture.pinchSurfX * total
        scope.panY = mid.y - scope.touchGesture.pinchSurfY * total
        clampPan(scope)
        updateTransform(scope)
      } else if (touches.length === 1 && !scope.touchGesture.isPinching) {
        const x = touches[0].clientX,
          y = touches[0].clientY
        const now = Date.now(),
          dt = now - scope.touchGesture.lastTime

        // Why: pan horizontally only when content overflows the viewport (larger
        // than fit) — same check clampPan() uses. Vertical always drives buffer
        // scroll so scrollback stays reachable at any text size; calling the
        // never-defined contentWiderThanViewport() here threw and killed all
        // single-finger scrolling, scrollback included.
        if (
          scope.term.element &&
          scope.term.element.scrollWidth * getTotalScale(scope) > scope.viewportRect().width + 1
        ) {
          scope.panX += x - scope.touchGesture.lastX
          clampPan(scope)
          updateTransform(scope)
        }

        const deltaY = scope.touchGesture.lastY - y
        scope.touchGesture.lastTime = now
        if (shouldRouteScrollToTerminalInput(scope)) {
          updateTouchVelocity(scope, deltaY, dt)
          resetSmoothScrollOffset(scope)
          const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
          scope.touchGesture.accumDelta += deltaY
          const lines = Math.trunc(scope.touchGesture.accumDelta / effectiveCellH)
          if (lines !== 0) {
            scope.touchGesture.accumDelta -= lines * effectiveCellH
            routeScrollLines(scope, lines, x, y)
          }
        } else {
          if (enqueueNormalBufferScrollDelta(scope, deltaY)) {
            updateTouchVelocity(scope, deltaY, dt)
          } else {
            scope.touchGesture.velY = 0
          }
        }
        scope.touchGesture.lastX = x
        scope.touchGesture.lastY = y
      }
    },
    { capture: true, passive: false }
  )

  targetSurface.addEventListener(
    'touchend',
    function (e) {
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term) {
        return
      }
      endSurfaceGesture(scope, touchesInRoot(scope.root, e.touches))
    },
    { capture: true, passive: true }
  )

  // Why: Android reports a gesture the platform claimed — a parent scrollable, a system edge
  // swipe, a second finger arriving — as touchcancel rather than touchend. Launching momentum
  // only from touchend is what made a fling coast on one swipe and stop dead on the next.
  targetSurface.addEventListener(
    'touchcancel',
    function () {
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term) {
        return
      }
      cancelSurfaceGesture(scope)
    },
    { capture: true, passive: true }
  )
}

export function startSurfaceTouchGestures(scope: TerminalDocumentScope) {
  attachSurfaceEventHandlers(scope, scope.surface!)
}

/** Ruling 21: the momentum loop, which would keep scrolling into the terminal that replaced it. */
export function stopSurfaceTouchGestures(scope: TerminalDocumentScope) {
  if (scope.touchGesture.momentumId !== null) {
    cancelAnimationFrame(scope.touchGesture.momentumId)
    scope.touchGesture.momentumId = null
  }
}
