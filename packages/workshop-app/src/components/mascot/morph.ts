export type Point = { x: number; y: number }
export type Pose = Point & { rotation: number; scale: number }

/** Points spaced evenly along a path. Needs a DOM to measure it. */
export function samplePath(d: string, count = 96): Point[] {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  const length = path.getTotalLength()
  return Array.from({ length: count }, (_, index) => {
    const point = path.getPointAtLength(length * index / count)
    return { x: point.x, y: point.y }
  })
}

/** Cut the actual sparkle outline rather than approximating it with two icons. */
export function splitOutline(points: Point[], left: boolean): Point[] {
  const result: Point[] = []
  // Join opposite inner corners, leaving two adjacent arms on each side: Ls.
  const side = (point: Point) => (point.y - 32.7) * 9.1 - (point.x - 43.5) * 7.56
  const inside = (point: Point) => left ? side(point) >= 0 : side(point) <= 0
  for (let index = 0; index < points.length; index++) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    if (inside(a)) result.push(a)
    if (inside(a) !== inside(b)) {
      const progress = side(a) / (side(a) - side(b))
      result.push({ x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress })
    }
  }
  return samplePath(pointsToPath(result))
}

export function orderHalves(halves: Point[][]): Point[][] {
  const centerX = (points: Point[]) => points.reduce((sum, point) => sum + point.x, 0) / points.length
  return halves.toSorted((a, b) => centerX(a) - centerX(b))
}

export function transformPoints(points: Point[], pose: Pose): Point[] {
  const angle = pose.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return points.map((point) => {
    const x = (point.x - 43.5) * pose.scale
    const y = (point.y - 32.7) * pose.scale
    return { x: pose.x + x * cos - y * sin, y: pose.y + x * sin + y * cos }
  })
}

export function inverseTransformPoints(points: Point[], pose: Pose): Point[] {
  const angle = -pose.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return points.map((point) => {
    const x = point.x - pose.x
    const y = point.y - pose.y
    return { x: 43.5 + (x * cos - y * sin) / pose.scale, y: 32.7 + (x * sin + y * cos) / pose.scale }
  })
}

/** Match winding and starting points so the contours don't twist mid-morph. */
export function alignPoints(from: Point[], to: Point[]): Point[] {
  const center = (points: Point[]) => points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 })
  const a = center(from)
  const b = center(to)
  let best = to
  let bestCost = Infinity
  for (const direction of [1, -1]) {
    for (let offset = 0; offset < to.length; offset++) {
      const candidate = to.map((_, index) => to[(offset + index * direction + to.length) % to.length])
      const cost = candidate.reduce((sum, point, index) => sum + (point.x - b.x - from[index].x + a.x) ** 2 + (point.y - b.y - from[index].y + a.y) ** 2, 0)
      if (cost < bestCost) { bestCost = cost; best = candidate }
    }
  }
  return best
}

const format = (x: number, y: number) => `${x.toFixed(4)} ${y.toFixed(4)}`

function pointsToPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(4)} ${point.y.toFixed(4)}`).join(' ') + 'Z'
}

/**
 * Smooth the cut ends, then render a closed C2-continuous spline. Unlike a
 * polygon, every join stays rounded even while its control points morph.
 */
export function roundedPointsToPath(points: Point[], softness = 0.65): string {
  const radius = Math.ceil(softness * 3)
  const smoothed = points.map((_, index) => {
    let x = 0
    let y = 0
    let total = 0
    for (let offset = -radius; offset <= radius; offset++) {
      const weight = Math.exp(-(offset ** 2) / (2 * softness ** 2))
      const point = points[(index + offset + points.length) % points.length]
      x += point.x * weight
      y += point.y * weight
      total += weight
    }
    return { x: x / total, y: y / total }
  })
  const at = (index: number) => smoothed[(index + smoothed.length) % smoothed.length]
  const start = { x: (at(-1).x + 4 * at(0).x + at(1).x) / 6, y: (at(-1).y + 4 * at(0).y + at(1).y) / 6 }
  let path = `M${format(start.x, start.y)}`
  for (let index = 0; index < smoothed.length; index++) {
    const a = at(index)
    const b = at(index + 1)
    const c = at(index + 2)
    path += `C${format((4 * a.x + 2 * b.x) / 6, (4 * a.y + 2 * b.y) / 6)} ${format((2 * a.x + 4 * b.x) / 6, (2 * a.y + 4 * b.y) / 6)} ${format((a.x + 4 * b.x + c.x) / 6, (a.y + 4 * b.y + c.y) / 6)}`
  }
  return path + 'Z'
}
