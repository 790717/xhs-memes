// 把下载来的图处理成「适合当表情」的尺寸再存。
//
// 表情库的准入规则（src/chat/inbound.js 的 stickerSizeOk）：边长 ≤ maxSide（默认 520）、
// 宽高比 0.75~1.33、体积 > 0。小红书配图常见 3:4、9:16、超长截图，直接存会被拒。
//
// 所以这里不是无脑裁方：先读真实宽高，把比例「夹」进允许区间（本来就合格就一点都不裁），
// 只裁掉多出来那一头，然后等比缩到上限以内，不放大。裁得越少、内容留得越多越好。
// 想一律要正方形就把 square 打开（比例直接锁 1）。
//
// sharp 找得到就用（插件宿主里一般有），找不到返回 null，由上层决定按原图存。

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 表情库允许的宽高比区间（跟 stickerSizeOk 保持一致）。 */
export const RATIO_MIN = 0.75
export const RATIO_MAX = 1.33

/** 超出这个比例就基本是长截图 / 长条横幅，裁出来也不像表情，宁可跳过。 */
export const RATIO_HARD_MIN = 0.4
export const RATIO_HARD_MAX = 2.5

/** 找 sharp 失败后隔这么久才重试（不然一次失败会一直按没有处理）。 */
const NEGATIVE_TTL_MS = 60_000

let cached = null       // 命中的 sharp
let failedAt = 0        // 上次失败的时间

/** 找 sharp：先问插件自己的 core/img.js（它知道宿主 Electron 里那份在哪），再按普通 import 找。 */
export async function findSharp({ resourcesPath = process.resourcesPath, importer = (u) => import(u), dir } = {}) {
  if (typeof cached === 'function') return cached
  if (cached === false && Date.now() - failedAt < NEGATIVE_TTL_MS) return null
  // 插件宿主里已经有一份 sharp（工具结果缩图就用它），先借它——模块自己不带 sharp，装到别人机器上也能用
  try {
    const core = globalThis.aurabot?.lib?.('core/img.js')
    if (core?.findSharp) {
      const fn = await core.findSharp()
      if (typeof fn === 'function') { cached = fn; return fn }
    }
  } catch (error) {}
  try {
    const m = await importer('sharp')
    const fn = m?.default || m
    if (typeof fn === 'function') { cached = fn; return fn }
  } catch (error) {}
  const paths = []
  if (typeof dir === 'string' && dir) paths.push(join(dir, 'node_modules', 'sharp', 'dist', 'index.mjs'))
  if (resourcesPath) {
    paths.push(
      join(resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
      join(resourcesPath, 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
      join(resourcesPath, 'app', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    )
  }
  for (const file of paths) {
    if (!existsSync(file)) continue
    try {
      const m = await importer(pathToFileURL(file).href)
      const fn = m?.default || m
      if (typeof fn === 'function') { cached = fn; return fn }
    } catch (error) {}
  }
  cached = false
  failedAt = Date.now()
  return null
}

/** 测试用：忘掉缓存的 sharp。 */
export function resetSharpCache() { cached = null; failedAt = 0 }

/**
 * 算出「合适的成品尺寸」：比例夹进合格区间（或锁 1），长边不超过 maxSide。
 * 纯函数，好测。
 * @returns {{ tw: number, th: number, crop: boolean, ratio: number, keep: number } | null} 源尺寸无效时 null
 *   ratio = 原图比例，keep = 裁完保留的比例
 */
export function fitBox(width, height, { maxSide = 480, square = false, allowUpscale = false } = {}) {
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)
  if (!(w > 0) || !(h > 0)) return null
  const limit = Math.max(80, Math.min(4096, Math.round(Number(maxSide) || 480)))
  const ratio = w / h
  const lo = square ? 1 : RATIO_MIN
  const hi = square ? 1 : RATIO_MAX
  const keep = Math.min(hi, Math.max(lo, ratio))
  // 裁完保留的那块必须还在原图里：太宽就裁宽，太瘦就裁高
  let cw
  let ch
  if (ratio > keep) {          // 太宽：留住整条高，砍左右
    ch = h
    cw = Math.max(1, Math.min(w, Math.round(h * keep)))
  } else if (ratio < keep) {   // 太瘦：留住整条宽，砍上下
    cw = w
    ch = Math.max(1, Math.min(h, Math.round(w / keep)))
  } else {
    cw = w
    ch = h
  }
  // 等比缩到上限内（默认不放大：小图保持原样，反正过得了校验）
  const fit = allowUpscale ? limit / Math.max(cw, ch) : Math.min(1, limit / Math.max(cw, ch))
  const tw = Math.max(1, Math.round(cw * fit))
  const th = Math.max(1, Math.round(ch * fit))
  const crop = Math.abs(keep - ratio) > 0.005
  return { tw, th, crop, ratio, keep }
}

/**
 * 处理成适合存进表情库的 JPEG。
 * @param {Buffer} buf 原图
 * @param {{ maxSide?: number, quality?: number, square?: boolean, allowUpscale?: boolean, dir?: string }} opts
 * @returns {Promise<{ buf: Buffer, width: number, height: number, ratio: number, keep: number, cropped: boolean } | null>}
 *          sharp 不可用 / 图读不出来 → null
 */
export async function fitSticker(buf, { maxSide = 480, quality = 84, square = false, allowUpscale = false, dir } = {}) {
  const sharp = await findSharp({ dir })
  if (typeof sharp !== 'function' || !Buffer.isBuffer(buf) || !buf.length) return null
  try {
    const meta = await sharp(buf, { animated: false }).metadata()
    // 带 EXIF 旋转的图：.rotate() 之后宽高是对调的，算框子前先换过来
    const turned = Number(meta.orientation) >= 5
    const sw = turned ? meta.height : meta.width
    const sh = turned ? meta.width : meta.height
    const box = fitBox(sw, sh, { maxSide, square, allowUpscale })
    if (!box) return null
    const render = (q) => sharp(buf, { animated: false })
      .rotate()
      .resize({ width: box.tw, height: box.th, fit: 'cover', position: 'centre' })
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer()
    let jpeg = await render(quality)
    // 体积太大就降质再来一次（QQ 收藏表情别太重）
    if (jpeg.length > 900 * 1024) jpeg = await render(64)
    if (!Buffer.isBuffer(jpeg) || !jpeg.length) return null
    if (jpeg.length > 2 * 1024 * 1024) return null
    return { buf: jpeg, width: box.tw, height: box.th, ratio: box.ratio, keep: box.keep, cropped: box.crop }
  } catch (error) {
    return null
  }
}

/** 老接口：一律居中裁正方形。留个兼容，主流程走 fitSticker。 */
export async function squareJpeg(buf, { side = 512, quality = 84, dir } = {}) {
  const made = await fitSticker(buf, { maxSide: side, quality, square: true, allowUpscale: true, dir })
  return made ? made.buf : null
}
