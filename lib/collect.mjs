// 采集：搜小红书表情包 → 打开笔记 → 下图片 → 存进 QQ 表情库。
//
// 刷的机制照搬「刷小红书」（xhs）模块的 duty：
//   ready() 先开浏览器、查登录、查验证码（没登录就停，跟 xhs 一样）；
//   关键词轮转（keywordIdx，一个词一个词轮着搜）；一篇篇 readNote 打开、停一会儿（dwell）；
//   到了「要存几张」或「本轮时长」就收手，记进 history。
// 唯一不同的是：它点赞评论，我们只存图。
//
// 去重：刷过的帖子（seenNotes）、下过的图（seenUrls）、存过的图（md5 账本）三层，
// 最后表情库自己还认 md5。

import { AsyncLocalStorage } from 'node:async_hooks'
import { createBrowser } from './browser.mjs'
import { createSite, findNoteId, resolveShort } from './site.mjs'
import { downloadImage } from './vision.mjs'
import { memeWords, pickImageUrls, memeName, hashBuf, ledgerOf, ledgerAdd, MEME_KEYWORDS } from './memes.mjs'

const __lib = globalThis.aurabot.lib
const { dataDir, readJson, writeJson } = __lib('core/store.js')

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const clip = (t, max) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')
const between = (lo, hi) => { const a = Math.max(0, Number(lo) || 0); const b = Math.max(a, Number(hi) || a); return Math.floor(a + Math.random() * (b - a + 1)) }
const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms))

const emptyDay = () => ({ day: '', saved: 0, skipped: 0, runs: 0, watched: 0 })
const emptyState = () => ({
  ...emptyDay(),
  lastRun: 0, nextDueAt: 0, lastMessage: '', lastSkipReason: '',
  account: null, loginAt: 0, pauseDay: '', pauseReason: '', notifiedDay: '',
  keywordIdx: 0,          // 关键词轮到第几个
  turns: 0,               // 取过几趟帖子（推荐流 / 关键词交替用）
  seenNotes: [],          // 刷过的笔记 id
  missed: {},             // 打不开的笔记 id → 失败次数（两次就不再试，省得每轮都撞同一篇）
  seenUrls: [],           // 下过的图片地址
  memes: [],              // 已入库图片的 md5
  items: [],              // 最近存进来的 [{ md5, srcMd5, url, name, at, title }]
  history: [],            // 最近 30 条
})

// 刚扫码/登录后的几分钟算「登录中」：这时候不自动开刷，免得小红book把首登当异常
const LOGIN_GRACE_MS = 5 * 60_000
// 这些字眼说明今天别再动手了（跟 xhs 模块同一条口径）
const STOP_RE = /验证|频繁|稍后再试|异常|限制|风控/

export function createCollect({ getConfig, log, addSticker, removeSticker, sendOwnerQQ, sendImageToOwner, download = downloadImage, now = Date.now, wait, site: injected, browser: injectedBrowser } = {}) {
  const cfg = () => getConfig()
  const sleep = wait || sleep0
  const source = new AsyncLocalStorage()
  const browser = injectedBrowser || (injected ? null : createBrowser({ profileDir: dataDir('xhs-memes', 'edge-profile'), browserPath: () => cfg().browserPath, log, now }))
  const site = injected || createSite({
    browser: {
      ...browser,
      open: () => {
        const from = source.getStore() || '主人要求'
        return browser.open(from, () => from === '登录' || cfg().enabled)
      },
    },
    log,
  })

  let loginBusy = 0
  let loginActionAt = null
  const loginRecent = () => loginActionAt !== null && now() - loginActionAt < LOGIN_GRACE_MS
  async function loginAction(fn) {
    loginBusy++
    loginActionAt = now()
    try { return await fn() } finally { loginActionAt = now(); loginBusy-- }
  }

  // 状态放自己模块的目录下（modules-data/xhs-memes/），不占插件根目录的共用文件名。
  // 早期版本写在根 store.json 里，第一次读时自动搬过来，之后只认新路径。
  const file = () => dataDir('modules-data', 'xhs-memes', 'state.json')
  const legacyFile = () => dataDir('store.json')
  const load = () => {
    let raw = readJson(file(), null)
    if (!raw || typeof raw !== 'object') {
      const old = readJson(legacyFile(), null)
      // 根 store.json 里的键和本模块的完全一致才认，别把别人的数据当自己的
      if (old && typeof old === 'object' && Array.isArray(old.items)) {
        raw = old
        try { writeJson(file(), old) } catch (error) { log?.debug?.('搬旧状态失败：', error?.message || error) }
      }
    }
    const s = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) }
    if (s.day !== dayKey(new Date(now()))) Object.assign(s, emptyDay(), { day: dayKey(new Date(now())) })
    return s
  }
  const save = (s) => writeJson(file(), s)
  const record = (s, item) => { s.history.unshift({ at: now(), ...item }); s.history = s.history.slice(0, 30) }
  const paused = (s) => s.pauseDay === dayKey(new Date(now())) && Boolean(s.pauseReason)
  // 打不开的帖子记两笔就够，别把 map 养大（只留最近 300 个）
  const pruneMissed = (missed) => {
    const keys = Object.keys(missed || {})
    if (keys.length <= 300) return missed
    const keep = keys.slice(-300)
    const out = {}
    for (const k of keep) out[k] = missed[k]
    return out
  }
  // 刚登录的号前几天算新号：一轮张数减半（跟 xhs 的 newAccountDays 一个口径）
  const isNew = (s) => {
    const days = Number(cfg().newAccountDays) || 0
    return Boolean(days && s.loginAt && now() - s.loginAt < days * 86400_000)
  }

  let busy = false

  /** 今天不再动（看还能看）；当天第一次停时在 QQ 上跟主人说一声，并把当前页面截图发过去。 */
  function pauseAll(s, why) {
    s.pauseDay = dayKey(new Date(now()))
    s.pauseReason = clip(why, 60) || '被风控了'
    log.warn(`今天先不收表情了：${s.pauseReason}`)
    const qq = cfg().ownerQQ
    if (qq && s.notifiedDay !== s.pauseDay) {
      s.notifiedDay = s.pauseDay
      const itemId = `xhs-memes:pause:${s.pauseDay}`
      const note = `小红书那边要验证 / 被限制了，今天先不收表情包了：${s.pauseReason}。请在手机小红书检查账号安全；也可以在面板里点「显示窗口」看看。`
      try { Promise.resolve(sendOwnerQQ?.(note, itemId, '小红书表情包暂停汇报')).catch(() => {}) } catch (error) { log.warn('暂停汇报没发出去：', error.message) }
      Promise.resolve().then(() => site.screenshot?.()).then(async (shot) => {
        const b64 = String(shot || '').replace(/^data:image\/png;base64,/, '')
        if (!b64) return
        if (typeof sendImageToOwner === 'function') {
          await Promise.resolve(sendImageToOwner(b64, '小红书要验证，页面截图', itemId)).catch(() => false)
        } else {
          log.info('验证页面截图已截（未接图片通道），可在面板里点「显示窗口」查看')
        }
      }).catch(() => {})
    }
  }

  /** 跟 xhs 一样：开浏览器 + 必须登录 + 没验证码。自动跑时，刚登录 5 分钟内不开刷。 */
  async function ready(s, from = '主人要求') {
    const up = await source.run(from, () => site.ensure())
    if (!up.ok) return up
    const acc = await account(true, s)
    if (acc.error) return { ok: false, message: '查不了小红书登录状态：' + acc.error }
    if (!acc.loggedIn) return { ok: false, message: '小红书还没登录，先在面板「设置」里扫码登录' }
    const why = await site.verify()
    if (why) {
      pauseAll(s, why)
      save(s)
      return { ok: false, message: '小红书要验证：' + why + '（面板里点「显示窗口」手动过一下）' }
    }
    return { ok: true }
  }

  /**
   * 登录态：以浏览器里的 web_session cookie 为准（照 xhs 的口径）。
   * 浏览器开着就实时查；关着就用上次存下的，别凭空说「没登录」。
   * force=true 会先把浏览器拉起来再查（查状态不该依赖浏览器已经开着）。
   */
  async function account(force = false, state = null) {
    const s = state || load()
    if (!site.connected()) {
      if (!force) {
        const old = s.account && typeof s.account === 'object' ? s.account : { loggedIn: false }
        return { ...old, live: false }
      }
      const up = await source.run('登录', () => site.ensure())
      if (!up.ok) return { ...(s.account || { loggedIn: false }), live: false, ok: false, message: up.message || '专用浏览器没起来' }
    }
    // 面板会反复拉 /state：15 秒内查过就直接复用，别每次都戳 CDP
    const old = s.account
    if (!force && old && old.at && now() - old.at < 15_000) return { ...old, live: true }
    const me = await site.self({ withNickname: !(s.account && s.account.nickname) })
      .catch((error) => ({ error: error.message }))
    const acc = me && !me.error
      ? {
        at: now(), loggedIn: Boolean(me.userId), nickname: me.nickname || '', userId: me.userId || '',
        avatar: me.avatar || '', error: '', live: true,
      }
      : { at: now(), loggedIn: false, nickname: '', userId: '', error: me?.error || '', live: true }
    s.account = acc
    if (acc.loggedIn) {
      if (!s.loginAt) s.loginAt = now()
      // 之前因为「没登录」暂停的，登录好就自动解除，不用等第二天
      if (paused(s) && /登录/.test(s.pauseReason || '')) { s.pauseDay = ''; s.pauseReason = '' }
    }
    save(s)
    return acc
  }

  /** 存一张：裁方 + 交给表情库。 */
  async function put(buf, meta) {
    if (typeof addSticker !== 'function') return { ok: false, reason: '表情包模块没在跑（面板「已安装」里打开「表情包」）' }
    return addSticker(buf, meta)
  }

  /**
   * 一篇篇看、一篇篇收。notes: [{ noteId, title, cover }]
   * cap = 这轮还要存几张；deadline = 到点收手（0 = 不限）
   */
  async function harvest(s, notes, { word = '', cap = 10, perNote = 9, dwellMin = 2, dwellMax = 6, deadline = 0 } = {}) {
    let added = 0, skipped = 0, looked = 0, stop = ''
    const names = []
    const seenNotes = new Set(s.seenNotes || [])
    const seenUrls = new Set(s.seenUrls || [])
    const missed = { ...(s.missed && typeof s.missed === 'object' ? s.missed : {}) }
    const outOfTime = () => Boolean(deadline) && now() >= deadline
    for (const n of notes) {
      if (added >= cap) { stop = 'cap'; break }
      if (outOfTime()) { stop = 'time'; break }
      if (seenNotes.has(n.noteId)) { skipped++; continue }
      // 连续两次打不开的帖子别再试了：多半是删了 / 私密，每轮都撞一次纯浪费额度
      if ((missed[n.noteId] || 0) >= 2) { skipped++; continue }
      looked++
      let note = null
      try { note = (await site.readNote(n.noteId)).note } catch (error) {
        log.debug(`读 ${n.noteId} 失败：`, error.message)
        // 单篇 404（没令牌 / 被限流）只是这篇不行，换下一篇，别把一整天的额度耗掉；
        // 也不记进 seenNotes（下次还可能打得开），只记一笔「这次没成」。
        if (error.code === 'verify') {
          pauseAll(s, error.message)
          stop = 'verify'
          break
        }
        if (error.code !== 'note404' && STOP_RE.test(error.message || '')) {
          pauseAll(s, error.message)
          stop = 'verify'
          break
        }
        missed[n.noteId] = (missed[n.noteId] || 0) + 1
        s.missed = pruneMissed(missed)
        continue
      }
      if (missed[n.noteId]) { delete missed[n.noteId]; s.missed = missed }
      // 真的读到了才算「刷过这篇」，读失败的不占名额
      seenNotes.add(n.noteId)
      // 像真人一样在这篇上停一会儿（xhs 的 dwell 口径，这里默认短一些）
      await sleep(between(dwellMin, dwellMax) * 1000)
      const urls = pickImageUrls({ ...note, cover: note?.cover || n.cover }, Math.max(1, Math.min(99, perNote)))
      const title = clip(note?.title || n.title || '', 40)
      let picked = 0
      for (const url of urls) {
        if (added >= cap) { stop = 'cap'; break }
        if (outOfTime()) { stop = 'time'; break }
        if (seenUrls.has(url)) { skipped++; continue }
        const buf = await download(url, fetch, { timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 }).catch(() => null)
        seenUrls.add(url)
        s.seenUrls = [...seenUrls].slice(-1500)
        if (!buf) { skipped++; continue }
        const md5 = hashBuf(buf)
        if (ledgerOf(s).includes(md5)) { skipped++; continue }
        const name = memeName({ title: note?.title || n.title, word, index: picked + 1, total: urls.length })
        const made = await put(buf, { name, tags: word ? [word] : [] })
        if (!made?.ok) { log.debug('存表情没成：', made?.reason || made?.message || '未知原因'); skipped++; continue }
        s.memes = ledgerAdd(s, md5) // 账本记原图 md5：同一个原图不会再下一次
        if (made.existed) { skipped++; continue } // 表情库里本来就有 → 不算新存，但也不重复收藏
        added++
        picked++
        names.push(name)
        // 入库的 md5 用表情库返回的那个（我们裁过尺寸，md5 跟原图不一样），不然删不掉
        const stored = String(made.item?.md5 || md5)
        s.items = [{ md5: stored, srcMd5: md5, url, name, at: now(), title }, ...(s.items || [])].slice(0, 60)
        record(s, { kind: 'save', title, name })
      }
      s.watched++
      s.seenNotes = [...seenNotes].slice(-1500)
      save(s)
      await sleep(500 + Math.floor(Math.random() * 700))
    }
    s.seenNotes = [...seenNotes].slice(-1500)
    return { added, skipped, looked, names, stop }
  }

  /** 收尾：记统计、排下一轮、出话术。 */
  function finish(s, { added, skipped, looked, names, stop }, label, startedAt) {
    const c = cfg()
    s.runs++
    s.saved += added
    s.skipped += skipped
    s.lastRun = now()
    const gap = Math.max(0.2, Number(c.intervalHours) || 6) * 3600_000
    s.nextDueAt = now() + gap
    const why = stop === 'cap' ? '存够了' : stop === 'time' ? '到时间了' : stop === 'verify' ? '要验证，停了' : ''
    s.lastMessage = added ? `存了 ${added} 张${why ? '（' + why + '）' : ''}` : `没存到新的${why ? '（' + why + '）' : ''}`
    record(s, { kind: 'run', title: label, count: added, ms: now() - startedAt })
    save(s)
    log.info(`小红书表情包：看了 ${looked} 篇，存了 ${added} 张，跳过 ${skipped} 张${why ? '，' + why : ''}`)
    return {
      ok: true, added, skipped, looked, names, stop,
      message: added
        ? `存了 ${added} 张表情：${names.slice(0, 6).join('、')}${names.length > 6 ? ' 等' : ''}${why ? '（' + why + '）' : ''}`
        : `没存到新的（看了 ${looked} 篇）${why ? '，' + why : ''}`,
    }
  }

  /**
   * 这一趟去哪找帖子。跟 xhs 的 roundList 一个口径：
   *   - 关键词为空 → 只刷推荐流
   *   - 有关键词 → 推荐流和关键词轮着来（turns 偶数刷推荐、奇数搜关键词），
   *     关键词自己再用 keywordIdx 一个个轮。
   * words 传了就用它（快捷按钮/聊天里临时指定的词）。
   * 返回 { notes, via }：via 是这趟的来路（'' = 推荐流，否则是关键词）。
   */
  async function roundNotes(s, { want, words } = {}) {
    const c = cfg()
    const list = memeWords(words || c.keywords, [])
    // 已经刷过的 + 打不开两次的，一并交给页面去跳过，省得滚上来一堆重复卡片
    const skip = new Set(s.seenNotes || [])
    const missed = s.missed && typeof s.missed === 'object' ? s.missed : {}
    for (const id of Object.keys(missed)) if ((missed[id] || 0) >= 2) skip.add(id)
    const mode = String(c.source || 'mix')
    const useSearch = list.length > 0 && mode !== 'feed' && (mode === 'search' || (s.turns || 0) % 2 === 1)
    const word = list[(s.keywordIdx || 0) % Math.max(1, list.length)] || ''
    const cards = useSearch
      ? await site.search(word, { skip, want }).catch((error) => { log.warn(`搜「${word}」没成：`, error.message); return [] })
      : await site.feed({ skip, want }).catch((error) => { log.warn('刷推荐流没成：', error.message); return [] })
    if (useSearch) s.keywordIdx = (s.keywordIdx || 0) + 1
    s.turns = (s.turns || 0) + 1
    const notes = []
    const seen = new Set()
    for (const x of Array.isArray(cards) ? cards : []) {
      const id = String(x?.noteId || '')
      if (!/^[0-9a-f]{24}$/.test(id) || seen.has(id) || skip.has(id)) continue
      if ((missed[id] || 0) >= 2) continue // 试过两次都打不开，别再拿它占名额
      seen.add(id)
      notes.push({ noteId: id, title: x.title || '', cover: x.cover || '' })
    }
    return { notes, via: useSearch ? word : '' }
  }

  /** 按关键词轮着搜着收。主要入口。 */
  async function collect({ words, limit, minutes, from = '主人要求' } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '上一轮还在跑，等它跑完' }
    if (!c.enabled) return { ok: false, message: '模块没打开（面板里打开总开关）' }
    busy = true
    const startedAt = now()
    const s = load()
    // 新号前几天一轮张数减半（照 xhs 的新号保护）
    const base = Math.max(1, Math.min(300, Number(limit) || Number(c.targetPerRun) || 20))
    const cap = isNew(s) ? Math.max(1, Math.floor(base / 2)) : base
    const perNote = Math.max(1, Math.min(99, Number(c.perNote) || 9))
    const budget = Math.max(1, Math.min(120, Number(minutes) || Number(c.maxMinutes) || 15)) * 60_000
    const deadline = startedAt + budget
    const wantNotes = Math.min(60, Math.max(10, cap * 2))
    try {
      const r = await ready(s, from)
      if (!r.ok) { s.lastMessage = r.message || '没准备好'; save(s); return r }
      let total = { added: 0, skipped: 0, looked: 0, names: [], stop: '' }
      const viaList = []
      // 一趟一趟来：先按 xhs 的轮次规则取一批帖子，看完再取一批（最多三趟，防空转）
      for (let round = 0; round < 3; round++) {
        if (total.added >= cap) { total.stop = 'cap'; break }
        if (now() >= deadline) { total.stop = 'time'; break }
        const { notes, via } = await roundNotes(s, { want: wantNotes, words })
        if (via) viaList.push(via)
        save(s) // keywordIdx / turns 变了就落盘，下一轮接着下一个词
        if (!notes.length) continue // 这趟没新帖子：换下一趟（关键词会轮到下一个词）
        const one = await harvest(s, notes, {
          word: via, cap: cap - total.added, perNote,
          dwellMin: Number(c.dwellMin) || 2, dwellMax: Number(c.dwellMax) || 6, deadline,
        })
        total = {
          added: total.added + one.added, skipped: total.skipped + one.skipped,
          looked: total.looked + one.looked, names: [...total.names, ...one.names],
          stop: one.stop || total.stop,
        }
        save(s)
        if (one.stop === 'verify' || one.stop === 'time' || one.stop === 'cap') break
      }
      const label = viaList.length ? [...new Set(viaList)].join(' / ') : '推荐流'
      return finish(s, total, label, startedAt)
    } catch (error) {
      s.lastMessage = '出错了：' + error.message
      save(s)
      return { ok: false, message: s.lastMessage }
    } finally {
      busy = false
    }
  }

  /** 给一篇笔记的链接 / 短链 / 笔记 id，只扒这一篇。 */
  async function collectFromLink(link, { limit, from = '主人要求' } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '上一轮还在跑，等它跑完' }
    if (!c.enabled) return { ok: false, message: '模块没打开（面板里打开总开关）' }
    const found = findNoteId(String(link || ''))
    if (!found) return { ok: false, message: '没认出小红书链接或笔记 id' }
    const id = found.noteId || await resolveShort(found.short).catch(() => '')
    if (!id) return { ok: false, message: '短链跳不过去，换完整链接试试' }
    busy = true
    const startedAt = now()
    const s = load()
    try {
      const r = await ready(s, from)
      if (!r.ok) { s.lastMessage = r.message || '没准备好'; save(s); return r }
      const cap = Math.max(1, Math.min(99, Number(limit) || Number(c.perNote) || 99))
      const one = await harvest(s, [{ noteId: id, title: '', cover: '' }], {
        word: '', cap, perNote: cap,
        dwellMin: Number(c.dwellMin) || 2, dwellMax: Number(c.dwellMax) || 6,
        deadline: startedAt + Math.max(1, Math.min(120, Number(c.maxMinutes) || 15)) * 60_000,
      })
      return finish(s, one, '这一篇', startedAt)
    } catch (error) {
      s.lastMessage = '出错了：' + error.message
      save(s)
      return { ok: false, message: s.lastMessage }
    } finally {
      busy = false
    }
  }

  /** 定时入口：一天最多几轮 + 每轮隔多久，都从设置里读。 */
  async function tick() {
    const c = cfg()
    if (!c.enabled || !c.autoEnabled || busy) return { ok: false, message: '这次不用跑' }
    const s = load()
    if (paused(s)) return { ok: false, message: '今天停了：' + s.pauseReason }
    // 刚扫码登录的 5 分钟里不自己动（xhs 同一条：首登立刻开刷最容易被判异常）
    if (loginRecent()) return { ok: false, message: '刚登录，等一会儿再动' }
    const maxRuns = Math.max(1, Number(c.maxRunsPerDay) || 4)
    if (s.runs >= maxRuns) return { ok: false, message: `今天已经跑了 ${s.runs} 轮（上限 ${maxRuns}）` }
    if (s.nextDueAt && now() < s.nextDueAt) return { ok: false, message: '还没到点' }
    return collect({ from: '定时' })
  }

  function recent(limit = 24) {
    const s = load()
    return (s.items || []).slice(0, Math.max(1, Math.min(60, Number(limit) || 24)))
  }

  async function remove(md5) {
    if (typeof removeSticker !== 'function') return { ok: false, message: '表情包模块没在跑' }
    const s = load()
    const it = (s.items || []).find((x) => x.md5 === md5)
    const r = await removeSticker(md5)
    if (!r?.ok) return { ok: false, message: r?.reason || '没删成' }
    s.items = (s.items || []).filter((x) => x.md5 !== md5)
    save(s)
    return { ok: true, message: `删掉「${it?.name || '这张'}」了` }
  }

  function state() {
    const s = load()
    const c = cfg()
    const maxRuns = Math.max(1, Number(c.maxRunsPerDay) || 4)
    const acc = s.account && typeof s.account === 'object' ? s.account : { loggedIn: false }
    return {
      enabled: c.enabled === true,
      saved: s.saved, skipped: s.skipped, runs: s.runs, watched: s.watched,
      memes: ledgerOf(s).length, seenNotes: (s.seenNotes || []).length,
      recentCount: (s.items || []).length,
      lastRun: s.lastRun, nextDueAt: s.nextDueAt, lastMessage: s.lastMessage,
      pauseReason: paused(s) ? s.pauseReason : '',
      // 登录态：浏览器开着就是实时查出来的，关着就是上次存下的（live=false 说明是旧结果）
      account: { ...acc, live: site.connected() },
      busy, browserOpen: site.connected(),
      keywords: memeWords(c.keywords, MEME_KEYWORDS),
      keywordNext: (() => { const l = memeWords(c.keywords, MEME_KEYWORDS); return l[(s.keywordIdx || 0) % Math.max(1, l.length)] })(),
      source: String(c.source || 'mix'),
      turns: s.turns || 0,
      targetPerRun: Number(c.targetPerRun) || 20,
      perNote: Number(c.perNote) || 9,
      maxMinutes: Number(c.maxMinutes) || 15,
      maxRunsPerDay: maxRuns, runsLeft: Math.max(0, maxRuns - s.runs),
      intervalHours: Number(c.intervalHours) || 6,
      maxSide: Number(c.maxSide) || 480,
      square: c.square === true,
      missed: Object.keys(s.missed || {}).length,
      history: s.history.slice(0, 20),
    }
  }

  /** 开始扫码登录：已经登录就直接告诉「已登录」；没登录才开登录弹窗、出二维码截图。 */
  async function login() {
    return loginAction(async () => {
      try {
        const up = await source.run('登录', () => site.ensure())
        if (!up.ok) return { ok: false, loggedIn: false, message: up.message || '专用浏览器没起来' }
        // 先看是不是本来就登着（最常见的情况：主人已经登了，面板还显示没登录）
        const me = await site.self().catch((error) => ({ error: error.message }))
        if (me?.userId) {
          const s = load()
          s.account = { at: now(), loggedIn: true, nickname: me.nickname || '', userId: me.userId, error: '', live: true }
          s.loginAt = s.loginAt || now()
          if (paused(s) && /登录/.test(s.pauseReason || '')) { s.pauseDay = ''; s.pauseReason = '' }
          save(s)
          return { ok: true, loggedIn: true, me, message: `已登录：${me.nickname || me.userId}` }
        }
        const r = await source.run('登录', () => site.loginStart())
        if (!r.ok) return r
        if (r.loggedIn) {
          const s = load()
          s.account = { at: now(), loggedIn: true, nickname: r.me?.nickname || '', userId: r.me?.userId || '', error: '', live: true }
          s.loginAt = s.loginAt || now()
          save(s)
          return { ok: true, loggedIn: true, me: r.me, message: `已登录：${r.me?.nickname || r.me?.userId || ''}` }
        }
        return { ok: true, loggedIn: false, shot: r.shot, message: '用小红书 App 扫码；扫完要验证的话点「显示窗口」在窗口里完成' }
      } catch (error) { return { ok: false, loggedIn: false, message: error.message } }
    })
  }

  /** 扫码中途看一眼：登上了就存下来；浏览器没开也先拉起来再查（查状态不该依赖它开着）。 */
  async function loginPoll() {
    return loginAction(async () => {
      try {
        if (!site.connected()) {
          const up = await source.run('登录', () => site.ensure())
          if (!up.ok) return { ok: false, loggedIn: false, message: up.message || '专用浏览器没起来' }
        }
        const why = await site.verify()
        const me = await site.self().catch((error) => ({ error: error.message }))
        if (me?.userId) {
          const s = load()
          s.account = { at: now(), loggedIn: true, nickname: me.nickname || '', userId: me.userId, error: '', live: true }
          s.loginAt = s.loginAt || now()
          if (paused(s) && /登录/.test(s.pauseReason || '')) { s.pauseDay = ''; s.pauseReason = '' }
          save(s)
          // 登上了就把窗口收回去，别一直弹在屏幕上
          Promise.resolve().then(() => site.show(false)).catch(() => {})
          return { ok: true, loggedIn: true, me, message: `已登录：${me.nickname || me.userId}` }
        }
        if (me?.error) return { ok: false, loggedIn: false, message: '查不了登录状态：' + me.error }
        return {
          ok: true, loggedIn: false, shot: await site.loginShot().catch(() => ''),
          message: why ? '要先过验证：点「显示窗口」在窗口里完成' : '还没扫上，再试一次',
        }
      } catch (error) { return { ok: false, loggedIn: false, message: error.message } }
    })
  }

  async function showWindow(visible) {
    const r = await site.ensure().catch((error) => ({ ok: false, message: error.message }))
    if (r?.ok === false) return r
    await site.show(Boolean(visible))
    return { ok: true, message: visible ? '浏览器窗口挪到屏幕上了' : '窗口收起来了' }
  }

  function dispose() {
    try { Promise.resolve((browser || site).close?.()).catch(() => {}) } catch (error) {}
  }

  return { collect, collectFromLink, tick, recent, remove, state, account, login, loginPoll, showWindow, dispose }
}
