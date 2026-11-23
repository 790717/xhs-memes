// 表情包采集：去小红书搜「表情包 / 抽象表情包」，把搜到的图存进 QQ 表情库。
//
// 这里只放纯函数（能直接用 node:test 测）：搜什么词、从一篇笔记里挑几张图、
// md5 去重账本怎么读写。真正下载和收藏在 collect.mjs（下载走 lib/vision.mjs，
// 收藏走插件内置的 stickers 模块 addFromBuffer）。
//
// 去重是硬要求：同一张图（md5）只进一次库。账本记在 state.json 的 memes 数组里
// （只留最近 2000 个 md5），表情库自己还有一层 md5 去重，两道闸。

import { createHash } from 'node:crypto'

/** 默认搜这两个词（面板/聊天里都能改）。 */
export const MEME_KEYWORDS = ['表情包', '抽象表情包']

/** 账本最多记多少个 md5（多了从最旧的开始丢，反正表情库那层还认 md5）。 */
export const LEDGER_MAX = 2000

/** 每个词的搜索词清洗：多行 / 逗号分隔 / 数组都认，去空去重，最多 5 个。 */
export function memeWords(input, fallback = MEME_KEYWORDS) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\r\n,，、]+/)
  const out = []
  for (const x of raw) {
    const w = String(x ?? '').trim().slice(0, 20)
    if (w && !out.includes(w)) out.push(w)
  }
  return (out.length ? out : fallback).slice(0, 5)
}

/** 字节的 md5（去重主键）。 */
export const hashBuf = (buf) => createHash('md5').update(buf).digest('hex')

/** 读账本：state 里的 memes 字段，坏的当空。 */
export function ledgerOf(state) {
  const list = Array.isArray(state?.memes) ? state.memes : []
  return list.filter((x) => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x)).slice(-LEDGER_MAX)
}

/** 往账本里加一个 md5（已经在里面就不动），返回新数组。 */
export function ledgerAdd(state, md5) {
  const cur = ledgerOf(state)
  if (cur.includes(md5)) return cur
  return [...cur, md5].slice(-LEDGER_MAX)
}

/**
 * 一篇笔记里能当表情的图：先正文配图，再封面；去掉头像/图标那种；
 * 跳过视频（没图），最多 max 张（默认 99——小红书图集最长就这么多）。
 */
export function pickImageUrls(note, max = 99) {
  if (!note || note.isVideo) return []
  const out = []
  for (const u of [...(Array.isArray(note.images) ? note.images : []), note.cover]) {
    const url = String(u || '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (/avatar|emoji|icon|logo|sprite/i.test(url)) continue
    if (out.includes(url)) continue
    out.push(url)
    if (out.length >= max) break
  }
  return out
}

/**
 * 给表情起名：笔记标题优先，没有就用搜索词 + 序号，最多 12 个字（表情库注释上限）。
 * 一篇里取多张时带上序号（《标题》3），不然一堆同名分不清。
 */
export function memeName({ title, word, index, total = 1 } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').replace(/[#＃]/g, '').trim()
  const n = Number(index) || 1
  const tail = total > 1 ? String(n) : ''
  if (t) {
    const room = 12 - tail.length
    return [...t].slice(0, room).join('') + tail
  }
  const w = String(word || '表情').trim()
  return [...`${w}${n}`].slice(0, 12).join('')
}
