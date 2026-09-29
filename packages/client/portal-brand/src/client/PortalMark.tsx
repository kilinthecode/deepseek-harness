import type { BrandArtworkProps } from './props.ts'

/**
 * Coordinate frame of the mark. The tesseract spans 217.6–806.4 across and
 * 172–852 down, cropped here to that figure plus the room its strokes need.
 */
const PORTAL_MARK_VIEWBOX = '160 160 704 704'

/** Center both cells project from, and the origin of their spokes. */
const CENTER = 512

/** Outer cell vertices, in drawing order. */
const OUTER_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [512, 172],
  [806.4, 342],
  [806.4, 682],
  [512, 852],
  [217.6, 682],
  [217.6, 342],
]

/** Inner cell vertices: the same cube projected one dimension inward. */
const INNER_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [512, 369.2],
  [635.6, 440.6],
  [635.6, 583.4],
  [512, 654.8],
  [388.4, 583.4],
  [388.4, 440.6],
]

/** Edges joining each outer vertex to its inner counterpart. */
const LIFT_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
  [512, 172, 512, 369.2],
  [806.4, 342, 635.6, 440.6],
  [806.4, 682, 635.6, 583.4],
  [512, 852, 512, 654.8],
  [217.6, 682, 388.4, 583.4],
  [217.6, 342, 388.4, 440.6],
]

/** Tier weights one cell draws at: screen-space widths, so any mark size stays crisp. */
interface CellProps {
  /** Cell corners, connected in order. */
  vertices: ReadonlyArray<readonly [number, number]>
  /** Stroke width in px, held against the viewport rather than the 704-unit frame. */
  width: number
  /** Tier opacity, matching the depth ordering of the icon artwork. */
  opacity: number
}

/** Render one tesseract cell: its hexagon and the spokes reaching the center. */
function Cell({ vertices, width, opacity }: CellProps) {
  return (
    <g opacity={opacity}>
      <polygon
        points={vertices.map(([x, y]) => `${x},${y}`).join(' ')}
        strokeWidth={width}
        vectorEffect="non-scaling-stroke"
      />
      {vertices.map(([x, y]) => (
        <line
          key={`${x},${y}`}
          x1={CENTER}
          y1={CENTER}
          x2={x}
          y2={y}
          strokeWidth={width}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  )
}

/**
 * Render the Portal tesseract mark.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement; color rides currentColor.
 * @returns the mark svg (aria-hidden; pair it with the product name for accessibility).
 */
export function PortalMark({ size = 24, className }: BrandArtworkProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={PORTAL_MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g opacity={0.7}>
        {LIFT_EDGES.map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1},${y1}-${x2},${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      <Cell vertices={INNER_VERTICES} width={1} opacity={0.9} />
      <Cell vertices={OUTER_VERTICES} width={1.25} opacity={1} />
    </svg>
  )
}
