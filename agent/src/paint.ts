/** Colori delle vernici di Terraria (WorldGen.paintColor), per numero: 1–12 normali, 13–24 intense, poi le speciali. */
export const PAINT_COLORS: readonly (readonly [number, number, number])[] = [
  [255, 255, 255], [255, 0, 0], [255, 127, 0], [255, 255, 0], [127, 255, 0], [0, 255, 0], [0, 255, 127], [0, 255, 255],
  [0, 127, 255], [0, 0, 255], [127, 0, 255], [255, 0, 255], [255, 0, 127], [255, 0, 0], [255, 127, 0], [255, 255, 0],
  [127, 255, 0], [0, 255, 0], [0, 255, 127], [0, 255, 255], [0, 127, 255], [0, 0, 255], [127, 0, 255], [255, 0, 255],
  [255, 0, 127], [75, 75, 75], [255, 255, 255], [175, 175, 175], [255, 178, 125], [25, 25, 25], [200, 200, 200], [255, 255, 255],
]
const SHADOW = 29
const NEGATIVE = 30
/** Mattoni arcobaleno: sulla minimappa la vernice non conta (MapHelper.GetTileType). */
export const RAINBOW_BRICK = 160

/**
 * Colore della minimappa di un blocco o muro verniciato (0xRRGGBB), come MapHelper.MapColor: il colore della vernice
 * per la luminosità del blocco (il canale più chiaro); l'ombra lo scurisce, la negativa lo inverte (a metà per i muri).
 */
export function mapPaint(color: number, paint: number, wall: boolean): number {
  if (paint <= 0 || paint >= PAINT_COLORS.length) return color
  const [pr, pg, pb] = PAINT_COLORS[paint]
  const cr = (color >> 16) & 255
  const cg = (color >> 8) & 255
  const cb = color & 255
  if (paint === NEGATIVE) {
    const k = wall ? 0.5 : 1
    return (Math.trunc((255 - cr) * k) << 16) | (Math.trunc((255 - cg) * k) << 8) | Math.trunc((255 - cb) * k)
  }
  // Come nel gioco: r diventa il canale più chiaro, e b quello che resta dopo gli scambi
  let r = cr / 255
  let g = cg / 255
  let b = cb / 255
  if (g > r) [r, g] = [g, r]
  if (b > r) [r, b] = [b, r]
  const k = paint === SHADOW ? b * 0.3 : r
  return (Math.trunc(pr * k) << 16) | (Math.trunc(pg * k) << 8) | Math.trunc(pb * k)
}
