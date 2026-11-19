/**
 * Texture del gioco (.xnb di XNA, come Content/Images/Tiles_1.xnb di Terraria) → pixel RGBA.
 *
 * Formato XNB: "XNB" · piattaforma ("w") · versione (5) · flag (0x80 = compresso LZX) · u32 dimensione del file ·
 * [u32 dimensione decompressa] · dati. Compressi: una serie di pezzi, ognuno con la dimensione compressa (u16 BE,
 * preceduta da 0xFF e dalla dimensione decompressa se non è 32 KB), decompressi da un unico flusso LZX con finestra
 * da 64 KB (lo stato passa da un pezzo all'altro, i bit ripartono allineati a ogni pezzo).
 * Dati: lettori dei tipi (nome, versione), risorse condivise, poi l'oggetto: per Texture2D formato (0 = Color,
 * RGBA a 8 bit, alfa premoltiplicato), larghezza, altezza, mipmap e pixel.
 */

export class XnbError extends Error {}

// --- LZX ---------------------------------------------------------------------------------------------

const WINDOW_BITS = 16
const POSITION_SLOTS = 32 // per una finestra da 2^16
const MAIN_ELEMENTS = 256 + POSITION_SLOTS * 8
const LENGTH_ELEMENTS = 249
const PRETREE_ELEMENTS = 20
const ALIGNED_ELEMENTS = 8
const MAX_BITS = 16

const EXTRA_BITS: number[] = []
const POSITION_BASE: number[] = []
for (let i = 0, j = 0; i < 52; i += 2) {
  EXTRA_BITS[i] = EXTRA_BITS[i + 1] = j
  if (i !== 0 && j < 17) j++
}
for (let i = 0, j = 0; i < 52; i++) {
  POSITION_BASE[i] = j
  j += 1 << EXTRA_BITS[i]
}

/** Bit del flusso LZX: parole da 16 bit little endian, lette dal bit più alto. */
class Bits {
  private buffer = 0
  private left = 0
  constructor(
    private readonly data: Uint8Array,
    public pos: number,
    private readonly end: number,
  ) {}

  private fill(n: number) {
    while (this.left < n) {
      const word = this.pos + 1 < this.end ? this.data[this.pos] | (this.data[this.pos + 1] << 8) : 0
      this.pos += 2
      this.buffer = (this.buffer | (word << (16 - this.left))) >>> 0
      this.left += 16
    }
  }
  peek16() {
    this.fill(16)
    return this.buffer >>> 16
  }
  remove(n: number) {
    this.buffer = (this.buffer << n) >>> 0
    this.left -= n
  }
  read(n: number): number {
    if (n === 0) return 0
    if (n > 16) return (this.read(16) << (n - 16)) | this.read(n - 16)
    this.fill(n)
    const v = this.buffer >>> (32 - n)
    this.remove(n)
    return v
  }
  /** Riparte da un byte (dopo i dati di un blocco non compresso). */
  restart() {
    this.buffer = 0
    this.left = 0
  }
  /** Per i blocchi non compressi: si buttano i bit rimasti della parola corrente. */
  align() {
    this.fill(16)
    if (this.left > 16) this.pos -= 2
    this.buffer = 0
    this.left = 0
  }
}

/** Codici di Huffman canonici (bit più alto per primo) → tabella da 2^16: simbolo << 5 | lunghezza. */
function buildTable(lengths: Uint8Array, count: number): Int32Array {
  const table = new Int32Array(1 << MAX_BITS).fill(-1)
  const perLength = new Array<number>(MAX_BITS + 1).fill(0)
  for (let s = 0; s < count; s++) perLength[lengths[s]]++
  perLength[0] = 0
  const next = new Array<number>(MAX_BITS + 2).fill(0)
  for (let len = 1, code = 0; len <= MAX_BITS; len++) {
    code = (code + perLength[len - 1]) << 1
    next[len] = code
  }
  for (let s = 0; s < count; s++) {
    const len = lengths[s]
    if (!len) continue
    const code = next[len]++
    const from = code << (MAX_BITS - len)
    const to = (code + 1) << (MAX_BITS - len)
    if (to > table.length) throw new XnbError('Albero di Huffman non valido')
    table.fill((s << 5) | len, from, to)
  }
  return table
}

function decode(bits: Bits, table: Int32Array): number {
  const entry = table[bits.peek16()]
  if (entry < 0) throw new XnbError('Codice di Huffman non valido')
  bits.remove(entry & 31)
  return entry >> 5
}

class Lzx {
  private readonly mainLengths = new Uint8Array(MAIN_ELEMENTS)
  private readonly lengthLengths = new Uint8Array(LENGTH_ELEMENTS)
  private readonly alignedLengths = new Uint8Array(ALIGNED_ELEMENTS)
  private mainTable: Int32Array | null = null
  private lengthTable: Int32Array | null = null
  private alignedTable: Int32Array | null = null
  private r0 = 1
  private r1 = 1
  private r2 = 1
  private started = false
  private blockType = 0
  private blockRemaining = 0
  private blockLength = 0

  constructor(private readonly out: Uint8Array) {}

  /** Lunghezze dei codici, come differenze rispetto al blocco precedente, codificate con il pre-albero. */
  private readLengths(bits: Bits, lengths: Uint8Array, first: number, last: number) {
    const pre = new Uint8Array(PRETREE_ELEMENTS)
    for (let i = 0; i < PRETREE_ELEMENTS; i++) pre[i] = bits.read(4)
    const table = buildTable(pre, PRETREE_ELEMENTS)
    for (let x = first; x < last; ) {
      const z = decode(bits, table)
      if (z === 17) {
        for (let y = bits.read(4) + 4; y > 0 && x < last; y--) lengths[x++] = 0
      } else if (z === 18) {
        for (let y = bits.read(5) + 20; y > 0 && x < last; y--) lengths[x++] = 0
      } else if (z === 19) {
        let y = bits.read(1) + 4
        let v = lengths[x] - decode(bits, table)
        if (v < 0) v += 17
        for (; y > 0 && x < last; y--) lengths[x++] = v
      } else {
        let v = lengths[x] - z
        if (v < 0) v += 17
        lengths[x++] = v
      }
    }
  }

  /** Decomprime un pezzo (`data[pos..end)`) scrivendo `size` byte a partire da `at`. Restituisce la fine. */
  chunk(data: Uint8Array, pos: number, end: number, at: number, size: number): number {
    const out = this.out
    const bits = new Bits(data, pos, end)
    if (!this.started) {
      // Traduzione E8 (eseguibili x86): nelle texture non c'è
      if (bits.read(1)) throw new XnbError('LZX con traduzione E8: non supportato')
      this.started = true
    }
    let o = at
    const target = at + size
    if (target > out.length) throw new XnbError('Dati decompressi oltre la dimensione dichiarata')

    while (o < target) {
      if (this.blockRemaining === 0) {
        if (this.blockType === 3) {
          // Dopo un blocco non compresso di lunghezza dispari c'è un byte di riempimento
          if (this.blockLength & 1) bits.pos++
          bits.restart()
        }
        this.blockType = bits.read(3)
        const hi = bits.read(16)
        const lo = bits.read(8)
        this.blockRemaining = this.blockLength = (hi << 8) | lo
        if (this.blockType === 2) {
          for (let i = 0; i < ALIGNED_ELEMENTS; i++) this.alignedLengths[i] = bits.read(3)
          this.alignedTable = buildTable(this.alignedLengths, ALIGNED_ELEMENTS)
        }
        if (this.blockType === 1 || this.blockType === 2) {
          this.readLengths(bits, this.mainLengths, 0, 256)
          this.readLengths(bits, this.mainLengths, 256, MAIN_ELEMENTS)
          this.mainTable = buildTable(this.mainLengths, MAIN_ELEMENTS)
          this.readLengths(bits, this.lengthLengths, 0, LENGTH_ELEMENTS)
          this.lengthTable = buildTable(this.lengthLengths, LENGTH_ELEMENTS)
        } else if (this.blockType === 3) {
          bits.align()
          if (bits.pos + 12 > end) throw new XnbError('Blocco LZX troncato')
          const view = new DataView(data.buffer, data.byteOffset + bits.pos, 12)
          this.r0 = view.getUint32(0, true)
          this.r1 = view.getUint32(4, true)
          this.r2 = view.getUint32(8, true)
          bits.pos += 12
        } else {
          throw new XnbError(`Tipo di blocco LZX non valido (${this.blockType})`)
        }
      }

      let run = Math.min(this.blockRemaining, target - o)
      this.blockRemaining -= run
      if (this.blockType === 3) {
        if (bits.pos + run > end) throw new XnbError('Blocco LZX troncato')
        out.set(data.subarray(bits.pos, bits.pos + run), o)
        bits.pos += run
        o += run
        continue
      }

      const aligned = this.blockType === 2
      while (run > 0) {
        const main = decode(bits, this.mainTable!)
        if (main < 256) {
          out[o++] = main
          run--
          continue
        }
        const element = main - 256
        let length = element & 7
        if (length === 7) length += decode(bits, this.lengthTable!)
        length += 2
        let offset = element >> 3
        if (offset > 2) {
          const extra = EXTRA_BITS[offset]
          if (!aligned) {
            offset = offset !== 3 ? POSITION_BASE[offset] - 2 + bits.read(extra) : 1
          } else {
            let value = POSITION_BASE[offset] - 2
            if (extra > 3) value += (bits.read(extra - 3) << 3) + decode(bits, this.alignedTable!)
            else if (extra === 3) value += decode(bits, this.alignedTable!)
            else if (extra > 0) value += bits.read(extra)
            else value = 1
            offset = value
          }
          this.r2 = this.r1
          this.r1 = this.r0
          this.r0 = offset
        } else if (offset === 0) {
          offset = this.r0
        } else if (offset === 1) {
          offset = this.r1
          this.r1 = this.r0
          this.r0 = offset
        } else {
          offset = this.r2
          this.r2 = this.r0
          this.r0 = offset
        }
        if (offset > o || offset > 1 << WINDOW_BITS) throw new XnbError('Distanza LZX oltre l\'inizio dei dati')
        if (o + length > out.length) throw new XnbError('Dati decompressi oltre la dimensione dichiarata')
        for (let k = 0; k < length; k++, o++) out[o] = out[o - offset]
        run -= length
      }
      // Una copia può superare la fine del pezzo: quei byte li toglie al blocco
      if (run < 0) {
        if (-run > this.blockRemaining) throw new XnbError('Copia LZX oltre la fine del blocco')
        this.blockRemaining += run
      }
    }
    return o
  }
}

/** Decomprime i dati di un .xnb compresso (dall'offset 14) in `size` byte. */
function inflateXnb(file: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size)
  const lzx = new Lzx(out)
  let pos = 14
  let o = 0
  while (pos < file.length && o < size) {
    let hi = file[pos]
    let lo = file[pos + 1]
    pos += 2
    let block = (hi << 8) | lo
    let frame = 0x8000
    if (hi === 0xff) {
      frame = (lo << 8) | file[pos]
      hi = file[pos + 1]
      lo = file[pos + 2]
      pos += 3
      block = (hi << 8) | lo
    }
    if (block === 0 || frame === 0) break
    if (pos + block > file.length) throw new XnbError('File .xnb troncato')
    o = lzx.chunk(file, pos, pos + block, o, Math.min(frame, size - o))
    pos += block
  }
  if (o !== size) throw new XnbError('Dati del .xnb incompleti')
  return out
}

// --- XNB ---------------------------------------------------------------------------------------------

class Reader {
  private readonly view: DataView
  constructor(
    private readonly data: Uint8Array,
    public pos = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  u8() {
    if (this.pos >= this.data.length) throw new XnbError('Dati del .xnb troncati')
    return this.data[this.pos++]
  }
  i32() {
    if (this.pos + 4 > this.data.length) throw new XnbError('Dati del .xnb troncati')
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  varint() {
    let v = 0
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8()
      v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v
    }
    throw new XnbError('Intero non valido nel .xnb')
  }
  string() {
    const length = this.varint()
    if (this.pos + length > this.data.length) throw new XnbError('Dati del .xnb troncati')
    const s = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + length))
    this.pos += length
    return s
  }
  bytes(n: number) {
    if (n < 0 || this.pos + n > this.data.length) throw new XnbError('Dati del .xnb troncati')
    const v = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
}

export type Texture = { width: number; height: number; rgba: Buffer }

/** Texture2D di un .xnb (formato Color), con l'alfa non premoltiplicato (come nei PNG). */
export function readXnbTexture(file: Uint8Array): Texture {
  if (file.length < 10 || file[0] !== 0x58 || file[1] !== 0x4e || file[2] !== 0x42) throw new XnbError('Non è un file .xnb')
  const flags = file[5]
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  let data: Uint8Array
  if (flags & 0x80) data = inflateXnb(file, view.getUint32(10, true))
  else if (flags & 0x40) throw new XnbError('.xnb compresso LZ4: non supportato')
  else data = file.subarray(10)

  const r = new Reader(data)
  const readers: string[] = []
  for (let i = r.varint(); i > 0; i--) {
    readers.push(r.string())
    r.i32() // versione del lettore
  }
  r.varint() // risorse condivise
  const index = r.varint()
  if (!readers[index - 1]?.startsWith('Microsoft.Xna.Framework.Content.Texture2DReader')) throw new XnbError('Il .xnb non contiene una texture')
  const format = r.i32()
  if (format !== 0) throw new XnbError(`Formato della texture non supportato (${format})`)
  const width = r.i32()
  const height = r.i32()
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new XnbError('Dimensioni della texture non valide')
  r.i32() // mipmap: serve solo la prima
  const size = r.i32()
  if (size !== width * height * 4) throw new XnbError('Dimensione dei pixel della texture non valida')
  const rgba = Buffer.from(r.bytes(size))
  // XNA salva i colori moltiplicati per l'alfa: si riportano come nei PNG
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 0 || a === 255) continue
    rgba[i] = Math.min(255, Math.round((rgba[i] * 255) / a))
    rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / a))
    rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / a))
  }
  return { width, height, rgba }
}
