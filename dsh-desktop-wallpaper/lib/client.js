/**
 * 桌面壁纸 · Client 半边。
 *
 * 三件事：
 *   1. 在输入框下方（conversation.composer.dock）画一条「壁纸条」，
 *      缩略图就是当前 Windows 桌面壁纸本身；
 *   2. 在浏览器里把壁纸画进 canvas 提色，得到平均色、主色调和一小排色卡，
 *      不依赖任何图像库；
 *   3. 「用壁纸配色」把整个界面的强调色换成壁纸主色调 —— 走
 *      theme.overrideTokens 叠加层，不动用户选定的主题本身。
 *
 * 工厂函数保持零副作用：所有注册都发生在 apply 里，资源都用 ctx.effect
 * 托管，插件卸载即回收。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-wallpaper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 半边注册的 URL 前缀。 */
    const ROUTE = '/desktop-wallpaper'
    /** 文案命名空间。 */
    const NS = 'desktop-wallpaper'
    /** 主题叠加层的身份：一个 source 一个层。 */
    const THEME_SOURCE = 'dsh-desktop-wallpaper'
    /** 色卡数量。 */
    const SWATCH_COUNT = 5

    const CSS = `
.dwp-strip{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;padding:6px 8px 6px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.35}
.dwp-thumb{flex:none;width:40px;height:40px;border-radius:9px;background-color:var(--dsw-alias-bg-layer-1);background-position:center;background-size:cover;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.dwp-meta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.dwp-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwp-sub{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwp-swatches{flex:none;display:flex;gap:4px}
.dwp-swatch{width:14px;height:14px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.dwp-actions{flex:none;display:flex;gap:6px}
.dwp-button{appearance:none;cursor:pointer;font:inherit;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dwp-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dwp-button:disabled{cursor:default;opacity:.45}
.dwp-button-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
`

    /** 中文文案。 */
    const ZH = {
      title: '桌面壁纸',
      loading: '正在读取桌面壁纸…',
      refresh: '刷新',
      tint: '用壁纸配色',
      tinted: '恢复原配色',
      tintHint: '把界面强调色换成壁纸的主色调',
      copy: 'Windows 副本',
      missing: '没有找到桌面壁纸文件（可能是动态壁纸）',
      unreachable: '读不到壁纸：宿主路由没有响应',
      unknown: '壁纸信息不可用',
    }

    /** 英文文案（也是缺失键的兜底）。 */
    const EN = {
      title: 'Desktop wallpaper',
      loading: 'Reading the desktop wallpaper…',
      refresh: 'Refresh',
      tint: 'Use wallpaper accent',
      tinted: 'Restore accent',
      tintHint: 'Recolour the interface accent with the wallpaper palette',
      copy: 'Windows copy',
      missing: 'No desktop wallpaper file found (live wallpaper?)',
      unreachable: 'Wallpaper unavailable: the host route did not respond',
      unknown: 'Wallpaper details unavailable',
    }

    // ---------------------------------------------------------------- 颜色工具

    /**
     * 把 0-255 的分量拼成 `#rrggbb`。
     *
     * @param {number} r - 红。
     * @param {number} g - 绿。
     * @param {number} b - 蓝。
     * @returns {string} 十六进制颜色。
     */
    function toHex(r, g, b) {
      const part = (value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')
      return `#${part(r)}${part(g)}${part(b)}`
    }

    /**
     * RGB(0-255) → HSL（h 为 0-360，s/l 为 0-1）。
     *
     * @param {number} r - 红。
     * @param {number} g - 绿。
     * @param {number} b - 蓝。
     * @returns {{h: number, s: number, l: number}} HSL。
     */
    function toHsl(r, g, b) {
      const rn = r / 255
      const gn = g / 255
      const bn = b / 255
      const max = Math.max(rn, gn, bn)
      const min = Math.min(rn, gn, bn)
      const l = (max + min) / 2
      const delta = max - min
      if (delta === 0) return { h: 0, s: 0, l }
      const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
      let hue
      if (max === rn) hue = ((gn - bn) / delta) % 6
      else if (max === gn) hue = (bn - rn) / delta + 2
      else hue = (rn - gn) / delta + 4
      return { h: (hue * 60 + 360) % 360, s, l }
    }

    /**
     * HSL → `#rrggbb`。
     *
     * @param {number} hue - 色相 0-360。
     * @param {number} s - 饱和度 0-1。
     * @param {number} l - 明度 0-1。
     * @returns {string} 十六进制颜色。
     */
    function fromHsl(hue, s, l) {
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
      const m = l - c / 2
      const segment = Math.floor((((hue % 360) + 360) % 360) / 60)
      const rgb = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
      ][segment]
      return toHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255)
    }

    /**
     * 感知亮度（0-1）。
     *
     * @param {number} r - 红。
     * @param {number} g - 绿。
     * @param {number} b - 蓝。
     * @returns {number} 亮度。
     */
    function luminance(r, g, b) {
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    }

    // ---------------------------------------------------------------- 提色

    /**
     * 把壁纸缩到 48×48 画进 canvas，做 4bit/通道的粗聚类。
     *
     * 返回平均色和按「可用度」排序的色桶：既不能太灰，也不能太暗或太亮，
     * 否则当作强调色会糊在背景里。
     *
     * @param {HTMLImageElement} image - 已加载完成的壁纸。
     * @returns {{average: object, ranked: object[], total: number} | undefined} 调色板。
     */
    function extractPalette(image) {
      const size = 48
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const surface = canvas.getContext('2d', { willReadFrequently: true })
      if (surface === null) return undefined
      surface.drawImage(image, 0, 0, size, size)
      const { data } = surface.getImageData(0, 0, size, size)

      const buckets = new Map()
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let counted = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        rSum += r
        gSum += g
        bSum += b
        counted += 1
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const bucket = buckets.get(key)
        if (bucket === undefined) buckets.set(key, { n: 1, r, g, b })
        else {
          bucket.n += 1
          bucket.r += r
          bucket.g += g
          bucket.b += b
        }
      }
      if (counted === 0) return undefined

      const ranked = [...buckets.values()]
        .map((bucket) => {
          const r = bucket.r / bucket.n
          const g = bucket.g / bucket.n
          const b = bucket.b / bucket.n
          const hsl = toHsl(r, g, b)
          const lum = luminance(r, g, b)
          return {
            hex: toHex(r, g, b),
            r,
            g,
            b,
            hsl,
            // 出现得多、够鲜艳、亮度适中 → 更适合当强调色。
            score: bucket.n * (0.12 + hsl.s) * (1 - Math.abs(lum - 0.55) * 0.85),
          }
        })
        .sort((a, b) => b.score - a.score)

      return {
        average: { r: rSum / counted, g: gSum / counted, b: bSum / counted },
        ranked,
        total: counted,
      }
    }

    /**
     * 用一个颜色推出浅色/深色两套强调色。
     *
     * 浅色主题下强调色要压暗才在白色背景上有对比度，深色主题下要提亮；
     * 饱和度也抬一个下限，否则近灰的壁纸会让按钮看不出是强调色。
     *
     * @param {{r: number, g: number, b: number}} colour - 壁纸主色。
     * @returns {{light: string, dark: string}} 主题 token 的两种取值。
     */
    function brandTokens(colour) {
      const hsl = toHsl(colour.r, colour.g, colour.b)
      const saturation = Math.min(Math.max(hsl.s, 0.42), 0.92)
      return {
        light: fromHsl(hsl.h, saturation, 0.4),
        dark: fromHsl(hsl.h, saturation, 0.7),
      }
    }

    /**
     * 人类可读的文件体积。
     *
     * @param {number | undefined} bytes - 字节数。
     * @returns {string | undefined} 展示文本。
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /**
     * 加载一张图片。
     *
     * @param {string} src - 图片 URL。
     * @returns {Promise<HTMLImageElement>} 加载完成的图片。
     */
    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('wallpaper image failed to load'))
        image.src = src
      })
    }

    // ---------------------------------------------------------------- React

    /**
     * 语言切换（或词典迟到）时重渲染。
     *
     * @param {object | undefined} locale - ctx.locale。
     * @returns {number} 当前词典 revision。
     */
    function useLocaleRevision(locale) {
      const [revision, setRevision] = React.useState(() =>
        locale === undefined ? 0 : locale.getSnapshot().revision,
      )
      React.useEffect(() => {
        if (locale === undefined) return undefined
        return locale.subscribe(() => setRevision(locale.getSnapshot().revision))
      }, [locale])
      return revision
    }

    /**
     * 输入框下方的壁纸条。
     *
     * @param {{controller: object, t: (key: string) => string}} props - 由 apply 注入。
     * @returns {object} React 元素。
     */
    function WallpaperStrip(props) {
      const { controller, t } = props
      useLocaleRevision(controller.locale)
      const [stamp, setStamp] = React.useState(0)
      const [state, setState] = React.useState({ phase: 'loading' })
      const [tinted, setTinted] = React.useState(() => controller.isTinted())

      // 重新挂载（换会话）时从 controller 恢复选中态，本地 state 只在一次挂载内生效。
      React.useEffect(() => {
        let cancelled = false
        setState({ phase: 'loading' })
        const run = async () => {
          let info
          try {
            const response = await fetch(`${ROUTE}/info`, { headers: { accept: 'application/json' } })
            info = await response.json().catch(() => undefined)
            if (cancelled) return
            if (!response.ok || info === undefined || info.ok !== true) {
              setState({ phase: 'empty', reason: info?.reason ?? 'not-found' })
              return
            }
          } catch {
            if (!cancelled) setState({ phase: 'empty', reason: 'unreachable' })
            return
          }
          const url = `${ROUTE}/current?v=${encodeURIComponent(info.modifiedAt ?? '')}&n=${stamp}`
          try {
            const image = await loadImage(url)
            if (cancelled) return
            let palette
            try {
              palette = extractPalette(image)
            } catch {
              // 提色失败（例如 canvas 被污染）不影响缩略图本身。
              palette = undefined
            }
            setState({
              phase: 'ready',
              info,
              url,
              width: image.naturalWidth,
              height: image.naturalHeight,
              palette,
            })
          } catch {
            if (!cancelled) setState({ phase: 'empty', reason: 'unreachable' })
          }
        }
        void run()
        return () => {
          cancelled = true
        }
      }, [stamp])

      /**
       * 切换「用壁纸配色」。
       */
      const toggleTint = React.useCallback(() => {
        if (tinted) {
          controller.clearTint()
          setTinted(false)
          return
        }
        const accent = state.palette?.ranked?.[0] ?? state.palette?.average
        if (accent === undefined) return
        controller.applyTint(accent)
        setTinted(true)
      }, [controller, state, tinted])

      const info = state.info
      const name = info === undefined ? t('title') : info.fileName
      const detail =
        state.phase === 'loading'
          ? t('loading')
          : state.phase === 'empty'
            ? state.reason === 'unreachable'
              ? t('unreachable')
              : state.reason === 'unsupported'
                ? t('unknown')
                : t('missing')
            : [
                formatBytes(info?.sizeBytes),
                state.width > 0 ? `${state.width} × ${state.height}` : undefined,
                info?.original === false ? t('copy') : undefined,
              ]
                .filter((part) => typeof part === 'string' && part.length > 0)
                .join(' · ')

      const swatches = state.palette?.ranked?.slice(0, SWATCH_COUNT) ?? []

      return h(
        'div',
        { className: 'dwp-strip' },
        h('div', {
          className: 'dwp-thumb',
          'aria-hidden': true,
          style: state.url === undefined ? undefined : { backgroundImage: `url("${state.url}")` },
        }),
        h(
          'div',
          { className: 'dwp-meta' },
          h('div', { className: 'dwp-name', title: info?.path ?? '' }, name),
          h('div', { className: 'dwp-sub', title: info?.path ?? '' }, detail),
        ),
        swatches.length === 0
          ? null
          : h(
              'div',
              { className: 'dwp-swatches', 'aria-hidden': true },
              swatches.map((swatch, index) =>
                h('span', { key: index, className: 'dwp-swatch', style: { backgroundColor: swatch.hex } }),
              ),
            ),
        h(
          'div',
          { className: 'dwp-actions' },
          h(
            'button',
            { type: 'button', className: 'dwp-button', onClick: () => setStamp((value) => value + 1) },
            t('refresh'),
          ),
          controller.canTint
            ? h(
                'button',
                {
                  type: 'button',
                  className: tinted ? 'dwp-button dwp-button-active' : 'dwp-button',
                  disabled: state.phase !== 'ready',
                  title: t('tintHint'),
                  onClick: toggleTint,
                },
                tinted ? t('tinted') : t('tint'),
              )
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------- 装配

    /**
     * 插件级控制器：持有主题叠加层，让「用壁纸配色」在换会话重新挂载后依然成立。
     *
     * @param {object} ctx - client 根上下文。
     * @param {object | undefined} theme - ctx.theme（缺失时禁用配色按钮）。
     * @returns {object} 控制器。
     */
    function createController(ctx, theme) {
      let tintDisposer
      return {
        locale: ctx.get('locale'),
        canTint: theme !== undefined,
        /** @returns {boolean} 当前是否已叠加壁纸配色。 */
        isTinted() {
          return tintDisposer !== undefined
        },
        /**
         * 用壁纸主色覆盖强调色。
         *
         * @param {{r: number, g: number, b: number}} accent - 壁纸主色。
         */
        applyTint(accent) {
          if (theme === undefined) return
          tintDisposer?.()
          tintDisposer = theme.overrideTokens(THEME_SOURCE, {
            '--dsw-alias-brand-primary': brandTokens(accent),
          })
        },
        /** 移除本插件叠加的那一层，恢复用户原主题。 */
        clearTint() {
          tintDisposer?.()
          tintDisposer = undefined
        },
        /** 卸载时回收。 */
        dispose() {
          this.clearTint()
        },
      }
    }

    /**
     * 构造翻译函数：优先走 locale 服务，缺失的键退回英文。
     *
     * @param {object | undefined} locale - ctx.locale。
     * @returns {(key: string) => string} 翻译函数。
     */
    function makeTranslate(locale) {
      if (locale === undefined) return (key) => EN[key] ?? key
      const bound = locale.bind(NS)
      return (key) => {
        const value = bound(key)
        if (typeof value === 'string' && value.length > 0 && value !== key) return value
        return EN[key] ?? key
      }
    }

    /** Client 半边需要的服务。 */
    const inject = ['slots']

    /**
     * Client 入口。
     *
     * @param {object} ctx - client 根上下文。
     */
    function apply(ctx) {
      // 样式表：id 幂等，卸载时移除。
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-desktop-wallpaper'
        tag.textContent = CSS
        document.head.append(tag)
        return () => tag.remove()
      })

      // 词典：内置 locale id 就是 zh / en（不是 zh-CN / en-US），注册键会被
      // 小写化后与 snapshot.active 比对；写成 zh-CN 会永远落到英文兜底。
      const locale = ctx.get('locale')
      if (locale !== undefined) {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }))
      }

      const t = makeTranslate(locale)
      const controller = createController(ctx, ctx.get('theme'))
      ctx.effect(() => () => controller.dispose())

      ctx.effect(() =>
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'desktop-wallpaper',
              order: 5,
              label: () => t('title'),
            },
            () => h(WallpaperStrip, { controller, t }),
          ),
        ),
      )
    }

    return { inject, apply }
  },
})
