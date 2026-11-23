// 小红书表情包（xhs-memes）：去小红书搜「表情包 / 抽象表情包」，把图存进 QQ 收藏表情库。
//
// 做法：专用浏览器 + 扫码登录 + 关键词轮转 + 一篇篇打开停一会儿，
// 每天几轮 / 每轮隔多久 / 一轮多少张 / 一轮最长多久，全在面板里自己调。
// 只做「存表情」这一件事：图裁成方形后交给内置的表情包模块收进 QQ 收藏。

import { createCollect } from './lib/collect.mjs'
import { fitSticker, RATIO_HARD_MIN, RATIO_HARD_MAX } from './lib/imaging.mjs'

const __lib = globalThis.aurabot.lib
const { str, int } = __lib('tools/tools.js')

export default {
  id: 'xhs-memes',
  name: '大肥鱼自动保存表情包',
  version: '0.4.1',
  api: 1,
  description: '自动刷小红书、按关键词搜表情包，把图裁到合适尺寸后直接上传到大肥鱼的表情包里（QQ 收藏表情）；存够就停，同一张图和同一个帖子都不会重复。',
  panel: 'panel.js',
  defaults: {
    enabled: false,                 // 总开关，默认关（面板里打开）
    autoEnabled: false,             // 定时自动收，默认关
    keywords: '表情包\n抽象表情包',  // 搜索词，每行一个，一轮轮着用
    source: 'mix',                  // 帖子从哪来：mix=推荐流和关键词轮着｜feed=只刷推荐流｜search=只搜关键词
    targetPerRun: 20,               // 一轮最多存几张，存够就停
    maxMinutes: 15,                 // 一轮最长跑多久（分钟），到点收手
    perNote: 9,                     // 一篇笔记最多取几张图（图集最长 99 张）
    maxRunsPerDay: 4,               // 一天最多跑几轮
    intervalHours: 6,               // 两轮之间隔多久
    dwellMin: 2,                    // 每篇停留秒数下限（像真人看完）
    dwellMax: 6,                    // 每篇停留秒数上限
    newAccountDays: 3,              // 刚登录前几天算新号，一轮张数减半
    maxSide: 480,                   // 成品长边上限（表情库默认只收 ≤520 的）
    square: false,                  // 开=一律裁正方形；关=只把比例夹进合格范围，少裁内容
    browserPath: '',                // Edge/Chrome 路径，空 = 自动找
  },
  // 表单全交给 panel.js（留空 settings，面板上不会压第二份表单）
  settings: [],

  setup(api) {
    const { hub, http } = api.core
    const cfgAll = () => api.settings()
    const stickers = api.lazy('stickers') // 表情包模块；关掉时属性都是 undefined

    /**
     * 自动裁到合格尺寸再存进表情库（边长 ≤520、宽高比 0.75~1.33 才收）。
     * 长截图那种比例太极端的裁出来也不像表情，直接跳过，别占库位。
     * sharp 不可用时原样存，表情库那层还会按尺寸再拒一次，原因会说清。
     */
    const addSticker = async (buf, { name, tags }) => {
      if (!stickers.addFromBuffer) return { ok: false, reason: '表情包模块没在跑（面板「已安装」里打开「表情包」）' }
      const c = cfgAll()
      const maxSide = Math.max(120, Math.min(520, Number(c.maxSide) || 480))
      const made = await fitSticker(buf, {
        maxSide,
        square: c.square === true,
        dir: api.dir,
      }).catch(() => null)
      if (!made) return stickers.addFromBuffer(buf, { name, tags, from: 'tool' })
      if (made.ratio < RATIO_HARD_MIN || made.ratio > RATIO_HARD_MAX) {
        return { ok: false, reason: `比例太极端（${made.ratio.toFixed(2)}），裁出来不像表情` }
      }
      return stickers.addFromBuffer(made.buf, { name, tags, from: 'tool' })
    }
    const removeSticker = async (md5) => {
      if (!stickers.remove) return { ok: false, message: '表情包模块没在跑' }
      return stickers.remove(String(md5 || ''))
    }

    // 暂停汇报：先问出站治理面（api.proactive），不支持就 hub.sendText 直发
    const sendOwnerQQ = async (text, itemId, logTag) => {
      const to = `private:${api.config().ownerQQ}`
      if (api.proactive?.submit) {
        try {
          const r = await api.proactive.submit({ itemId, to, channel: 'qq', text })
          if (r && r.deliveryId !== null && r.deliveryId !== undefined && r.state !== 'unsupported') {
            return ['sent', 'sending', 'pending'].includes(String(r.state || ''))
          }
        } catch (error) { api.log.warn(`${logTag}经 api.proactive 提交失败，回退直发：`, error?.message) }
      }
      try { return Boolean(await hub.sendText?.(to, text)) } catch (error) { api.log.warn(`${logTag}直发失败：`, error?.message); return false }
    }
    const sendImageToOwner = async (b64png, caption, itemId) => {
      const to = `private:${api.config().ownerQQ}`
      if (!b64png) return false
      try {
        return Boolean(await hub.sendSegments?.(to, [{ type: 'image', data: { file: 'base64://' + b64png } }], caption || '[xhs-memes]'))
      } catch (error) { api.log.warn('图片直发失败：', error?.message); return false }
    }

    const collector = createCollect({ getConfig: cfgAll, log: api.log, addSticker, removeSticker, sendOwnerQQ, sendImageToOwner })
    api.onDispose(() => collector.dispose())

    // 定时：每 5 分钟醒一次，tick 自己判「今天还剩几轮 / 到点没有 / 是不是刚登录」
    api.every(5 * 60_000, () => collector.tick(), '小红书表情包')

    // ---- 她的工具 ----
    api.tool(({ chat, sessionId }) => {
      const c = cfgAll()
      if (!c.enabled || chat?.kind === 'system') return []
      const ownerOnly = () => hub.turnSendersAllOwner?.(sessionId) !== false
      return [
        api.defineTool({
          name: 'xhs_collect_memes',
          description: '去小红书搜表情包，把图存进自己的 QQ 表情库（同一张图、同一个帖子都不会重复）。有人让你「去小红书找点表情包」「收点抽象表情」时用。要跑几分钟，开始后告诉对方在收，别说已经到手了。',
          properties: {
            words: str('搜索词，逗号分隔；不填就用面板里设的（默认「表情包、抽象表情包」）'),
            limit: int('这轮最多存几张；不填用面板里设的数'),
          },
          required: [],
          execute: async ({ words, limit }) => {
            if (!ownerOnly()) return { ok: false, message: '这个只听主人的' }
            const r = await collector.collect({ words, limit, from: '主人要求' })
            return { ok: r.ok !== false, message: r.message }
          },
        }),
        api.defineTool({
          name: 'xhs_collect_from_link',
          description: '别人发来一篇小红书笔记（链接 / xhslink 短链 / 24 位笔记 id），把这篇里的表情图存进表情库时用。',
          properties: { link: str('小红书笔记链接、短链或 24 位笔记 id') },
          required: ['link'],
          execute: async ({ link }) => {
            if (!ownerOnly()) return { ok: false, message: '这个只听主人的' }
            const r = await collector.collectFromLink(String(link || ''), { from: '主人要求' })
            return { ok: r.ok !== false, message: r.message }
          },
        }),
        api.defineTool({
          name: 'xhs_meme_status',
          description: '查小红书表情包采集的状态：一共存了多少张、今天还剩几轮、下次什么时候收。',
          properties: {},
          required: [],
          execute: async () => {
            const s = collector.state()
            const last = s.lastRun ? new Date(s.lastRun).toLocaleString() : '还没收过'
            const next = s.nextDueAt ? new Date(s.nextDueAt).toLocaleString() : '没排'
            return {
              ok: true,
              message: `一共存了 ${s.saved} 张（跳过重复 ${s.skipped} 张）；今天还剩 ${s.runsLeft} 轮，上次：${last}，下次：${next}${s.pauseReason ? '；今天停了：' + s.pauseReason : ''}`,
              state: s,
            }
          },
        }),
      ]
    })

    // ---- 面板路由 ----
    api.route('/state', async () => {
      // 浏览器开着就顺手核对一次登录态（15 秒内查过会复用，不会反复戳）
      const acc = await collector.account().catch(() => null)
      const st = collector.state()
      return { ok: true, ...st, account: acc || st.account }
    })
    api.route('/recent', async () => {
      const list = collector.recent(24)
      // 一次把库读出来做索引：原来每张都调一遍 library() 等于把 index.json 读 24 遍
      let byMd5 = new Map()
      try {
        const lib = stickers.library?.()
        byMd5 = new Map((lib?.items || []).map((i) => [i.md5, i]))
      } catch (error) { byMd5 = new Map() }
      const items = list.map((x) => {
        let src = ''
        try {
          const item = byMd5.get(x.md5)
          const seg = item ? stickers.segmentFor?.(item) : null
          const b64 = seg?.data?.file || ''
          src = b64.startsWith('base64://') ? 'data:image/jpeg;base64,' + b64.slice(9) : ''
        } catch (error) { src = '' }
        return { ...x, src }
      })
      return { ok: true, items }
    })
    api.route('/run', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return collector.collect({ words: b?.words, limit: b?.limit, minutes: b?.minutes, from: '面板' })
    })
    api.route('/run-link', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return collector.collectFromLink(String(b?.link || ''), { from: '面板' })
    })
    api.route('/remove', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return collector.remove(String(b?.md5 || ''))
    })
    api.route('/login', async () => collector.login())
    api.route('/login/status', async () => collector.loginPoll())
    // 实时查一次登录态（浏览器没开就顺手拉起来），面板「检查登录」用
    api.route('/account', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const acc = await collector.account(b?.refresh !== false)
      return { ok: acc.ok !== false, ...acc }
    })
    api.route('/window', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return collector.showWindow(Boolean(b?.visible))
    })
    return { collect: collector.collect, collectFromLink: collector.collectFromLink, state: collector.state }
  },
}
