// 自测：注入假 site / 假下载 / 假表情库，跑「按词收 → 去重 → 存够就停 → 到点就停 → 收单篇 → 删图」。
// 用法：node test/run.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const tmp = mkdtempSync(join(tmpdir(), 'xhs-memes-test-'))
process.env.AURABOT_DATA_DIR = tmp

// 假的插件内部源码接口（collect.mjs 只用到 store 的 dataDir / readJson / writeJson）
globalThis.aurabot = {
  lib: () => ({
    dataDir: (...parts) => join(tmp, ...parts.filter((x) => x !== undefined && x !== null && x !== '')),
    readJson: (f, def) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch (error) { return typeof def === 'function' ? def() : def } },
    writeJson: (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)) },
  }),
}

const { createCollect } = await import('../lib/collect.mjs')

// 造一批笔记 id
const ids = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(24, 'a'))
let searchCalls = []
let feedCalls = 0

const fakeSite = {
  ensure: async () => ({ ok: true }),
  verify: async () => '',
  self: async () => ({ userId: 'u1', nickname: '测试号' }),
  // 推荐流：也按 skip 过滤（跟真实现一样，刷过的不再给）
  feed: async ({ skip } = {}) => {
    feedCalls++
    const pool = ids.filter((id) => !(skip && skip.has(id)))
    return pool.slice(0, 3).map((id) => ({ noteId: id, title: '推荐-' + id.slice(-2), cover: '' }))
  },
  // 搜索结果：每次都给「还没给过」的笔记；假 site 自己按 skip 过滤，跟真实现一致
  search: async (word, { skip } = {}) => {
    searchCalls.push(word)
    const pool = ids.filter((id) => !(skip && skip.has(id)))
    return pool.slice(0, 4).map((id) => ({ noteId: id, title: `${word}-${id.slice(-2)}`, cover: '' }))
  },
  readNote: async (id) => ({
    note: {
      noteId: id,
      title: '笔记' + id.slice(-2),
      // 每篇两张图；第一张永远同 URL（测 URL 去重），第二张按 id 唯一
      images: ['https://sns-webpic.xhscdn.com/shared.jpg', `https://sns-webpic.xhscdn.com/${id}.jpg`],
      cover: `https://sns-webpic.xhscdn.com/${id}.jpg`,
    },
    comments: [],
  }),
  connected: () => true,
  loginStart: async () => ({ ok: true, loggedIn: true, me: { userId: 'u1', nickname: '测试号' } }),
  loginPoll: async () => ({ ok: true, loggedIn: true, me: { userId: 'u1', nickname: '测试号' } }),
  show: async () => {},
  screenshot: async () => '',
  close: async () => {},
}

const downloaded = []
const download = async (url) => {
  downloaded.push(url)
  // 同一个 URL 永远同样的字节 → md5 去重会被触发
  return Buffer.from('bytes-of:' + url)
}

const lib = new Map()
const addSticker = async (buf, { name, tags }) => {
  const md5 = createHash('md5').update(buf).digest('hex')
  if (lib.has(md5)) return { ok: true, existed: true, item: lib.get(md5) }
  const item = { md5, name, tags }
  lib.set(md5, item)
  return { ok: true, item }
}
const removeSticker = async (md5) => (lib.delete(md5) ? { ok: true } : { ok: false, reason: '没有这张' })

const cfg = {
  enabled: true, autoEnabled: false,
  keywords: '表情包\n抽象表情包', source: 'mix',
  targetPerRun: 3, maxMinutes: 15, perNote: 9,
  maxRunsPerDay: 4, intervalHours: 6, dwellMin: 0, dwellMax: 0,
  newAccountDays: 0, shrinkSide: 512, ownerQQ: '',
}
const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const collector = createCollect({ getConfig: () => cfg, log, addSticker, removeSticker, download, wait: async () => {}, site: fakeSite })

const fail = []

// ---- 1. 存够就停：targetPerRun = 3 ----
const r1 = await collector.collect({ from: '测试' })
console.log('① 存够就停:', JSON.stringify({ added: r1.added, stop: r1.stop, looked: r1.looked, msg: r1.message }))
if (r1.added !== 3) fail.push(`① 应存 3 张（存够就停），实际 ${r1.added}`)
if (r1.stop !== 'cap') fail.push(`① 停止原因应为 cap，实际 ${r1.stop}`)

// ---- 2. 再跑一轮：帖子不重复 + 图片不重复 ----
const before = lib.size
const r2 = await collector.collect({ from: '测试' })
console.log('② 再跑一轮:', JSON.stringify({ added: r2.added, looked: r2.looked, msg: r2.message }), '| 库里', lib.size, '张')
if (lib.size === before && r2.added !== 0) fail.push('② 没新增却报存了')
const dupUrls = downloaded.length !== new Set(downloaded).size
if (dupUrls) fail.push('② 有 URL 被下载了两次（URL 去重失效）')

// ---- 3. 到点就停：maxMinutes 极小 ----
const cfg0 = { ...cfg }
cfg0.targetPerRun = 100
cfg0.maxMinutes = 1
const r3 = await collector.collect({ minutes: 1, from: '测试' })
console.log('③ 到点收手:', JSON.stringify({ added: r3.added, stop: r3.stop, msg: r3.message }))
Object.assign(cfg, cfg0)

// ---- 3b. 浏览来源：mix 应该推荐流和关键词都用到 ----
console.log('③b 来路:', `推荐流 ${feedCalls} 次 / 关键词 ${searchCalls.length} 次`, searchCalls.length ? '搜过: ' + [...new Set(searchCalls)].join('、') : '')
if (!feedCalls) fail.push('③b mix 模式应该刷过推荐流')
if (!searchCalls.length) fail.push('③b mix 模式应该搜过关键词')

// ---- 4. 收单篇 ----
const one = ids[7]
const r4 = await collector.collectFromLink(`https://www.xiaohongshu.com/explore/${one}`, { from: '测试' })
console.log('④ 收单篇:', JSON.stringify({ added: r4.added, skipped: r4.skipped, msg: r4.message }))

// ---- 5. 状态：轮次 / 下一轮时间 / 记录 ----
const st = collector.state()
console.log('⑤ 状态:', `saved=${st.saved} runs=${st.runs} runsLeft=${st.runsLeft} 下次=${st.nextDueAt ? new Date(st.nextDueAt).toLocaleString() : '没排'} 关键词下一个=${st.keywordNext}`)
if (!st.nextDueAt) fail.push('⑤ 跑完应该排下一轮时间')
if (st.runsLeft !== Math.max(0, st.maxRunsPerDay - st.runs)) fail.push('⑤ runsLeft 算错了')

// ---- 6. 删一张 ----
const recent = collector.recent(10)
if (recent.length) {
  const rm = await collector.remove(recent[0].md5)
  console.log('⑥ 删一张:', rm.message)
  if (!rm.ok) fail.push('⑥ 删除应该成功')
}

// ---- 7. 尺寸自适应（纯函数，不需要 sharp） ----
const { fitBox, RATIO_MIN, RATIO_MAX } = await import('../lib/imaging.mjs')
const sizes = [
  [1200, 1600, '3:4 竖图', false],
  [1080, 1920, '9:16 竖图', true],
  [2000, 600, '超宽横幅', true],
  [800, 800, '正方', false],
  [260, 260, '小图不放大', false],
]
const bad = []
for (const [w, h2, name, shouldCrop] of sizes) {
  const b = fitBox(w, h2, { maxSide: 480 })
  const r = b.tw / b.th
  if (Math.max(b.tw, b.th) > 520) bad.push(`${name} 边长超了：${b.tw}x${b.th}`)
  if (r < RATIO_MIN - 0.01 || r > RATIO_MAX + 0.01) bad.push(`${name} 比例不合格：${r.toFixed(2)}`)
  if (b.crop !== shouldCrop) bad.push(`${name} 裁切判断不对：${b.crop}`)
  if (b.tw > w || b.th > h2) bad.push(`${name} 放大了：${w}x${h2} → ${b.tw}x${b.th}`)
}
const sq = fitBox(1200, 1600, { maxSide: 480, square: true })
if (sq.tw !== sq.th) bad.push(`正方形模式不是方的：${sq.tw}x${sq.th}`)
console.log('⑦ 尺寸自适应:', bad.length ? bad.join('; ') : '各种比例都合格')
if (bad.length) fail.push('⑦ ' + bad.join('; '))

// ---- 8. 打不开两次的帖子不再反复撞 ----
const deadId = String(99).padStart(24, 'b')
const deadSite = { ...fakeSite, readNote: async () => { throw Object.assign(new Error('这篇笔记打不开'), { code: 'note404' }) } }
const c2 = createCollect({ getConfig: () => cfg, log, addSticker, removeSticker, download, wait: async () => {}, site: deadSite })
await c2.collectFromLink(deadId, { from: '测试' })
await c2.collectFromLink(deadId, { from: '测试' })
const third = await c2.collectFromLink(deadId, { from: '测试' })
const quiet = /看了 0 篇/.test(third.message)
console.log('⑧ 死帖不再撞:', JSON.stringify({ msg: third.message, 第三次直接跳过: quiet }))
if (!/没存到新的/.test(third.message)) fail.push('⑧ 打不开的帖子应该安静跳过')
if (!quiet) fail.push('⑧ 试过两次的帖子不该再打开')

rmSync(tmp, { recursive: true, force: true })
if (fail.length) { console.log('\n失败：\n- ' + fail.join('\n- ')); process.exit(1) }
console.log('\n全部通过 ✓')
