import type { Point } from './morph'

const kappa = 0.5522847498

const format = (point: Point) => `${point.x.toFixed(4)} ${point.y.toFixed(4)}`

/** A circle as four cubic curves, each of its points passed through `project` so it can be deformed. */
export function circlePath(x: number, y: number, radius: number, project: (point: Point) => Point = (point) => point): string {
  const k = radius * kappa
  const points = [
    { x: x + radius, y },
    { x: x + radius, y: y + k }, { x: x + k, y: y + radius }, { x, y: y + radius },
    { x: x - k, y: y + radius }, { x: x - radius, y: y + k }, { x: x - radius, y },
    { x: x - radius, y: y - k }, { x: x - k, y: y - radius }, { x, y: y - radius },
    { x: x + k, y: y - radius }, { x: x + radius, y: y - k }, { x: x + radius, y },
  ].map(project)
  return `M${format(points[0])}` + [1, 4, 7, 10].map((index) => `C${format(points[index])} ${format(points[index + 1])} ${format(points[index + 2])}`).join('') + 'Z'
}
