// panel.js —— 小红书表情包面板。
// 目标：一眼看懂。上面一个开关 + 一个「现在收一轮」，中间一排数字看进度，
// 下面是刚收进来的图，想调东西才展开「设置」。
const { useState, useEffect } = React

const DEFAULTS = {
  enabled: false,
  autoEnabled: false,
  keywords: '表情包\n抽象表情包',
  source: 'mix',
  targetPerRun: 20,
  maxMinutes: 15,
  perNote: 9,
  maxRunsPerDay: 4,
  intervalHours: 6,
  dwellMin: 2,
  dwellMax: 6,
  newAccountDays: 3,
  maxSide: 480,
  square: false,
  browserPath: '',
}

const PRESETS = ['表情包', '抽象表情包', '沙雕表情包', '猫猫表情包', '熊猫头']

const pad2 = (n) => String(n).padStart(2, '0')

/** 时间戳 → 今天 07:30 / 明天 01:10 / 11/26 09:00。 */
function when(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  const today = new Date()
  const tmr = new Date(today.getTime() + 86400_000)
  if (d.toDateString() === today.toDateString()) return '今天 ' + hm
  if (d.toDateString() === tmr.toDateString()) return '明天 ' + hm
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hm
}

const HINT = {
  targetPerRun: '存够这么多张就自己停',
  maxMinutes: '跑太久就收手，别一直刷',
  perNote: '一篇笔记最多拿几张图',
  maxRunsPerDay: '一天最多收几轮',
  intervalHours: '两轮之间歇多久',
  maxSide: '成品图长边，太大存不进 QQ 收藏',
}

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('')
  const [st, setSt] = useState(null)
  const [items, setItems] = useState(null)
  const [qr, setQr] = useState('')
  const [link, setLink] = useState('')
  const [draft, setDraft] = useState(null)

  const d = { ...DEFAULTS, ...(settings || {}), ...(draft || {}) }
  const 改 = (patch) => setDraft({ ...(draft || {}), ...patch })
  const 改了没 = draft !== null
  const 开着 = d.enabled === true
  const 登录了 = st && st.account && st.account.loggedIn === true
  const 登录旧了 = 登录了 && st.account.live === false

  const run = async (name, fn) => {
    if (busy) return
    setBusy(name)
    try { return await fn() } catch (e) { toast('出错了：' + (e && e.message || e), 'err') }
    finally { setBusy('') }
  }
  const 刷 = () => Promise.all([
    call('/state').then(setSt).catch(() => {}),
    call('/recent').then((r) => setItems((r && r.items) || [])).catch(() => {}),
  ])
  useEffect(() => { 刷() }, [])

  // 开关类改动立刻落盘：save 会带回新的 settings，不用留在草稿里等「保存设置」
  const 立刻存 = (patch, okText) => run('save', async () => {
    await save(patch)
    if (okText) toast(okText, 'ok')
    await 刷()
  })

  const 收一轮 = (words) => run('run', async () => {
    if (!开着) return toast('先把上面的开关打开', 'err')
    const r = await call('/run', words ? { words } : {})
    toast(r.message || (r.ok === false ? '没收成' : '收完了'), r.ok === false ? 'err' : 'ok')
    await 刷()
  })

  const 收这篇 = () => run('link', async () => {
    const v = link.trim()
    if (!v) return toast('先把笔记链接贴进来', 'err')
    if (!开着) return toast('先把上面的开关打开', 'err')
    const r = await call('/run-link', { link: v })
    toast(r.message || (r.ok === false ? '没收成' : '收完了'), r.ok === false ? 'err' : 'ok')
    await 刷()
  })

  const 删 = (x) => run('rm', async () => {
    if (!confirm('删掉「' + (x.name || '这张') + '」？QQ 收藏里那张也一起删。')) return
    const r = await call('/remove', { md5: x.md5 })
    toast(r.message || (r.ok === false ? '没删成' : '删掉了'), r.ok === false ? 'err' : 'ok')
    await 刷()
  })

  const 扫码 = () => run('login', async () => {
    const r = await call('/login', {})
    if (r.loggedIn) { setQr(''); toast(r.message || '已经登录了', 'ok'); return 刷() }
    if (r.ok === false) return toast(r.message || '登录没成功', 'err')
    setQr(r.shot || '')
    toast(r.shot ? '二维码出来了，用小红书 App 扫一下' : '没拿到二维码，点「显示窗口」在窗口里扫')
  })

  const 扫好了 = () => run('poll', async () => {
    const r = await call('/login/status')
    if (r.loggedIn) { setQr(''); toast(r.message || '登录好了', 'ok'); return 刷() }
    if (r.shot) setQr(r.shot)
    toast(r.message || '还没扫上，再试试', r.ok === false ? 'err' : undefined)
  })

  // 只查一次登录态（不点「扫码登录」也能查）：感觉「明明登着却说没登」时点这个
  const 查登录 = () => run('check', async () => {
    const r = await call('/account', { refresh: true })
    if (r.loggedIn) { setQr(''); toast('查到了：已登录 ' + (r.nickname || r.userId || ''), 'ok') }
    else toast(r.message || '确实还没登录，扫码一下', 'err')
    await 刷()
  })

  const 开窗口 = () => run('win', async () => {
    const r = await call('/window', { visible: true })
    toast(r.message || (r.ok === false ? '没成功' : '窗口出来了'), r.ok === false ? 'err' : 'ok')
  })

  const 保存设置 = () => run('saveAll', async () => {
    await save(d)
    setDraft(null)
    toast('设置保存好了', 'ok')
    await 刷()
  })

  // ---- 小零件 ----
  const 数字行 = (label, key, min, max, step, unit) => h(ui.Row, { label, hint: HINT[key] },
    h(ui.Range, {
      min, max, step: step || 1, value: Number(d[key]) || min,
      onChange: (v) => 改({ [key]: v }), fmt: (v) => v + (unit || ''),
    }))

  const 开关行 = (label, key, hint) => h(ui.Row, { label, hint },
    h(ui.Switch, { on: d[key] === true, disabled: !!busy, title: label, onChange: () => 改({ [key]: d[key] !== true }) }))

  const 分组标题 = (text, top) => h('div', {
    key: 'g:' + text,
    className: 'ab-small ab-muted',
    style: { fontWeight: 600, margin: (top || 4) + 'px 0 4px' },
  }, text)

  const 数字块 = (值, 标题, 小字) => h('div', { key: 标题, style: { flex: '1 1 88px', minWidth: 88 } },
    h('div', { style: { fontSize: 21, fontWeight: 700, lineHeight: 1.25 } }, 值),
    h('div', { className: 'ab-small ab-muted' }, 标题),
    小字 ? h('div', { className: 'ab-small ab-muted', style: { opacity: .75 } }, 小字) : null)

  const 按钮 = (label, onClick, opts) => h(ui.Btn, {
    key: label,
    kind: opts && opts.primary ? 'primary' : undefined,
    small: !(opts && opts.primary),
    disabled: !!busy || !!(opts && opts.disabled),
    onClick,
  }, label)

  // ---- 三张卡片，攒好再拼，读起来顺 ----
  const 主卡 = h(ui.Card, {
    key: 'main',
    title: '收表情',
    right: h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
      h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 2,
          background: 开着 ? '#30a46c' : 'var(--ab-line-2)',
        },
      }),
      h('span', { className: 'ab-small ab-muted' }, 开着 ? '开着' : '关着'),
      h(ui.Switch, {
        on: 开着, disabled: !!busy, title: '总开关',
        onChange: () => 立刻存({ enabled: !开着 }, !开着 ? '打开了，可以收了' : '关掉了'),
      })),
  },
    h('div', { className: 'ab-flex', style: { gap: 14, flexWrap: 'wrap', marginBottom: 12 } },
      数字块(st ? st.saved : '—', '今天存了', st ? '库里有 ' + st.memes + ' 张' : ''),
      数字块(st ? st.runsLeft + '/' + st.maxRunsPerDay : '—', '今天还剩', st ? '每轮 ' + st.targetPerRun + ' 张' : ''),
      数字块(st ? when(st.nextDueAt) : '—', '下次自动收', d.autoEnabled ? '' : '自动收没开'),
      数字块(登录了 ? ((st.account && st.account.nickname) || '已登录') : '没登录', '小红书账号',
        登录了 ? (登录旧了 ? '上次查到的' : '实时查过') : '下面点「检查登录」')),

    st && st.pauseReason
      ? h('div', { key: 'pause', className: 'ab-note err', style: { marginBottom: 10 } }, '今天先停了：' + st.pauseReason)
      : null,

    h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
      h(ui.Btn, {
        kind: 'primary', disabled: !!busy || !开着,
        onClick: () => 收一轮(),
      }, busy === 'run' ? '正在收…' : '现在收一轮'),
      按钮('刷新', () => 刷()),
      st && st.lastMessage ? h('span', { className: 'ab-small ab-muted', style: { alignSelf: 'center' } }, '上次：' + st.lastMessage) : null),

    h('div', { key: 'h1', className: 'ab-small ab-muted', style: { marginBottom: 6 } }, '只想搜某个词：'),
    h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 14 } },
      PRESETS.map((w) => h(ui.Btn, {
        key: w, small: true, disabled: !!busy || !开着, onClick: () => 收一轮(w),
      }, w))),

    h('div', { key: 'h2', className: 'ab-small ab-muted', style: { marginBottom: 6 } }, '或者收某一篇（最多 99 张）：'),
    h('div', { className: 'ab-flex', style: { gap: 8 } },
      h('input', {
        className: 'ab-input', style: { flex: 1, minWidth: 170 }, value: link,
        placeholder: '笔记链接 / xhslink 短链 / 24 位 id',
        onChange: (e) => setLink(e.target.value),
      }),
      h(ui.Btn, { disabled: !!busy || !开着, onClick: 收这篇 }, busy === 'link' ? '正在收…' : '收这篇')))

  const 图库 = items === null
    ? h('div', { key: 'load', className: 'ab-small ab-muted' }, '加载中…')
    : items.length === 0
      ? h(ui.Empty, { key: 'empty', icon: '🖼️', text: '还没收过：点上面「现在收一轮」' })
      : h('div', {
        key: 'grid',
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8 },
      }, items.map((x) => h('div', {
        key: x.md5,
        style: { position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--ab-line)' },
      },
        x.src
          ? h('img', {
            src: x.src, alt: x.name || '',
            title: (x.name || '') + (x.title ? '\n来自《' + x.title + '》' : ''),
            style: { width: '100%', height: 88, objectFit: 'cover', display: 'block' },
          })
          : h('div', {
            className: 'ab-small ab-muted',
            style: { height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center' },
          }, '读不出来'),
        h('button', {
          type: 'button', title: '删掉这张', disabled: !!busy,
          style: {
            position: 'absolute', top: 3, right: 3, width: 20, height: 20, padding: 0, border: 0,
            borderRadius: 10, cursor: 'pointer', background: 'rgba(0,0,0,.5)', color: '#fff', fontSize: 13, lineHeight: '20px',
          },
          onClick: () => 删(x),
        }, '×'))))

  const 图卡 = h(ui.Card, {
    key: 'recent',
    title: '最近收的',
    desc: '点右上角的 × 删掉一张（QQ 收藏里那张一起删）。',
  }, 图库)

  const 登录区 = h('div', {
    key: 'login',
    className: 'ab-flex',
    style: { gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--ab-line)' },
  },
    h('div', { style: { flex: '1 1 190px', minWidth: 190 } },
      h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', marginBottom: 6 } },
        st && st.account && st.account.avatar
          ? h('img', {
            key: 'av', src: st.account.avatar, alt: '头像',
            style: { width: 26, height: 26, borderRadius: 13, border: '1px solid var(--ab-line)' },
          })
          : null,
        h('div', { className: 'ab-small', style: { fontWeight: 600 } },
          登录了
            ? '已登录：' + ((st.account && (st.account.nickname || st.account.userId)) || '')
            : '小红书还没登录')),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } },
        登录了
          ? (登录旧了 ? '上次查到的状态；点「检查登录」可以实时再确认一次。' : '扫码后先歇 5 分钟再收，不容易被风控。')
          : '先点「检查登录」确认一下；真没登再扫码。'),
      h('div', { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
        按钮('检查登录', 查登录),
        按钮(busy === 'login' ? '正在开…' : '扫码登录', 扫码),
        按钮('我扫完了', 扫好了),
        按钮('显示窗口', 开窗口))),
    qr ? h('img', {
      key: 'qr', src: qr, alt: '二维码',
      style: { width: 116, height: 116, borderRadius: 8, border: '1px solid var(--ab-line)' },
    }) : null)

  const 设置卡 = h(ui.Card, {
    key: 'settings',
    title: '设置',
    collapsible: true,
    defaultOpen: false,
    desc: '平时不用动。想改搜索词、每轮几张、一天几轮、成品图多大，才展开这里。',
  },
    分组标题('搜什么'),
    h(ui.Row, { key: 'kw', label: '搜索词', hint: '一行一个，轮着用' },
      h('textarea', {
        className: 'ab-textarea', style: { width: '100%', minHeight: 58 }, value: d.keywords || '',
        onChange: (e) => 改({ keywords: e.target.value }),
      })),
    h(ui.Row, { key: 'src', label: '帖子从哪来', hint: '推荐流和搜索轮着来' },
      h(ui.Seg, {
        value: d.source || 'mix',
        options: [{ label: '都要', value: 'mix' }, { label: '只刷推荐', value: 'feed' }, { label: '只搜关键词', value: 'search' }],
        onChange: (v) => 改({ source: v }),
      })),

    分组标题('一轮怎么停', 14),
    数字行('一轮最多存几张', 'targetPerRun', 5, 200, 5, ' 张'),
    数字行('一轮最长跑多久', 'maxMinutes', 2, 60, 1, ' 分钟'),
    数字行('一篇最多拿几张', 'perNote', 1, 99, 1, ' 张'),

    分组标题('多久收一次', 14),
    开关行('自动收', 'autoEnabled', '打开就按下面的节奏自己跑'),
    数字行('一天最多几轮', 'maxRunsPerDay', 1, 12, 1, ' 轮'),
    数字行('两轮隔多久', 'intervalHours', 1, 24, 1, ' 小时'),

    分组标题('存进去长什么样', 14),
    数字行('成品图长边', 'maxSide', 240, 520, 20, 'px'),
    开关行('一律裁成正方形', 'square', '关着=只把比例调合格，尽量少裁内容'),

    h('div', { key: 'save', className: 'ab-flex', style: { gap: 8, marginTop: 16 } },
      h(ui.Btn, { kind: 'primary', disabled: !!busy || !改了没, onClick: 保存设置 },
        busy === 'saveAll' ? '保存中…' : (改了没 ? '保存设置' : '还没有改动')),
      改了没 ? 按钮('撤销', () => setDraft(null)) : null),

    登录区)

  return h('div', null, 主卡, 图卡, 设置卡)
}
