/**
 * 桌面壁纸 · Host 半边。
 *
 * 读取 Windows 当前桌面壁纸，并以同源受控的方式把字节交给浏览器半边：
 *   GET /desktop-wallpaper/info     → 元数据 JSON
 *   GET /desktop-wallpaper/current  → 壁纸图片原始字节
 *
 * 壁纸是用户的私人文件，所以路由只服务回环对端，并拒绝跨站读取
 * （drive-by read / DNS rebinding）：宿主 webServer 自身不带鉴权和
 * Origin 校验，插件的 API 必须自守。
 *
 * @module dsh-desktop-wallpaper
 */
import { execFile } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** 稳定的 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'ui-desktop-wallpaper'

/** 硬依赖：承载本插件资源路由的 HTTP 服务。 */
export const inject = ['webServer']

/** 本插件占用的 URL 前缀。 */
const ROUTE_PREFIX = '/desktop-wallpaper'

/** Windows 自己保存主题资源的位置。 */
const THEMES_DIR = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Themes',
)

/** Windows 为当前壁纸重新编码的一份副本（没有扩展名的 JPEG）。 */
const TRANSCODED = join(THEMES_DIR, 'TranscodedWallpaper')

/** 按幻灯片/多显示器轮换时留下的历史壁纸帧。 */
const CACHED_DIR = join(THEMES_DIR, 'CachedFiles')

/** 扩展名 → MIME。作为内容嗅探不可用时的兜底。 */
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/**
 * 从文件头字节嗅探图片 MIME。
 *
 * TranscodedWallpaper 这类副本没有扩展名，内容本身是唯一可靠的判据；
 * 客户端也会据此决定能不能画进 canvas 提色。
 *
 * @param {Buffer} head - 文件起始字节。
 * @returns {string | undefined} MIME 类型；无法识别时 undefined。
 */
function sniffMime(head) {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png'
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg'
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return 'image/bmp'
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (head.length >= 6 && head.toString('latin1', 0, 3) === 'GIF') {
    return 'image/gif'
  }
  return undefined
}

/**
 * 判定一个文件的图片类型：先看内容，再退回扩展名。
 *
 * @param {string} file - 绝对路径。
 * @returns {Promise<string | undefined>} MIME 类型；不是已知图片时 undefined。
 */
async function readMime(file) {
  const fromExt = MIME_BY_EXT[extname(file).toLowerCase()]
  try {
    const handle = await fs.open(file, 'r')
    try {
      const head = Buffer.alloc(16)
      const { bytesRead } = await handle.read(head, 0, 16, 0)
      return sniffMime(head.subarray(0, bytesRead)) ?? fromExt
    } finally {
      await handle.close()
    }
  } catch {
    return fromExt
  }
}

/**
 * 向注册表询问壁纸的原始路径。
 *
 * 这是拿到用户「真正那份文件」（含文件名和扩展名）的唯一途径；
 * 失败时静默返回 undefined，由调用方退回 Windows 的副本。
 *
 * @returns {Promise<string | undefined>} 注册表记录的壁纸路径。
 */
function queryRegistryWallpaper() {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
      { windowsHide: true, timeout: 4000 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve(undefined)
        const matched = /WallPaper\s+REG_SZ\s+(.+)/i.exec(stdout)
        resolve(matched ? matched[1].trim() : undefined)
      },
    )
  })
}

/**
 * 把一个候选路径校验成可用的壁纸文件。
 *
 * 动态壁纸工具（Wallpaper Engine 之类）经常让注册表指向一个已经不存在
 * 的文件，所以「注册表里有值」不等于「能读到图」。
 *
 * @param {string | undefined} file - 候选绝对路径。
 * @param {string} source - 来源标记，回传给客户端用于说明。
 * @param {boolean} original - 是否为用户自己的原始壁纸文件。
 * @returns {Promise<object | undefined>} 候选描述；不可用时 undefined。
 */
async function asWallpaperFile(file, source, original) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size === 0) return undefined
    return {
      path: file,
      source,
      original,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    }
  } catch {
    return undefined
  }
}

/**
 * 取 CachedFiles 里最新的一帧壁纸。
 *
 * @returns {Promise<object | undefined>} 候选描述；目录为空或不可读时 undefined。
 */
async function newestCachedWallpaper() {
  try {
    const names = await fs.readdir(CACHED_DIR)
    const candidates = []
    for (const entry of names) {
      if (MIME_BY_EXT[extname(entry).toLowerCase()] === undefined) continue
      const full = join(CACHED_DIR, entry)
      const stat = await fs.stat(full).catch(() => undefined)
      if (stat === undefined || !stat.isFile() || stat.size === 0) continue
      candidates.push({
        path: full,
        source: 'cache',
        original: false,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        at: stat.mtimeMs,
      })
    }
    candidates.sort((a, b) => b.at - a.at)
    const best = candidates[0]
    if (best === undefined) return undefined
    delete best.at
    return best
  } catch {
    return undefined
  }
}

/**
 * 解析当前生效的壁纸：优先用户原始文件，其次 Windows 自己的副本。
 *
 * @returns {Promise<object | undefined>} 壁纸描述；一个都没找到时 undefined。
 */
async function resolveWallpaper() {
  const fromRegistry = await asWallpaperFile(await queryRegistryWallpaper(), 'registry', true)
  if (fromRegistry !== undefined) return fromRegistry
  const transcoded = await asWallpaperFile(TRANSCODED, 'transcoded', false)
  if (transcoded !== undefined) return transcoded
  return newestCachedWallpaper()
}

/**
 * TCP 对端是否为回环地址。
 *
 * 只信 socket 的远端地址，不信可以伪造的 Host 头。
 *
 * @param {string | undefined} address - socket.remoteAddress。
 * @returns {boolean} 是否回环。
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase().split('%')[0]
  return (
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('0:0:0:0:0:0:0:ffff:127.')
  )
}

/**
 * Host 是否为回环名或 IP 字面量。
 *
 * DNS 名字可以被重新解析到 127.0.0.1（DNS rebinding），此时 origin 文本与
 * host 文本一致、sec-fetch-site 也是 same-origin，只有「必须是 IP 字面量或
 * localhost」这一条能拦住。
 *
 * @param {string | undefined} host - Host 头。
 * @returns {boolean} 是否可接受。
 */
function isLoopbackOrLiteralHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (bare === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true
  return bare.includes(':') && /^[0-9a-f:]+$/i.test(bare)
}

/**
 * 本插件 API 的同源守卫。
 *
 * 1. TCP 对端必须回环；
 * 2. Fetch Metadata 标记 cross-site / same-site 一律拒绝（同站也是跨端口跨源）；
 * 3. Host 必须是回环名或 IP 字面量；
 * 4. 带 Origin 时必须与 Host 同 host。
 *
 * 非浏览器客户端（Electron IPC 桥、curl）没有 Origin / Fetch Metadata 头，
 * Host 为回环或 IP 字面量即放行。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否放行。
 */
function isAllowed(req) {
  const headers = req?.headers ?? {}
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const site = headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return false
  const host = headers.host
  if (!isLoopbackOrLiteralHost(host)) return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 回一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} body - JSON 可序列化的响应体。
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * 回一个纯文本响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {string} text - 响应正文。
 */
function sendText(res, status, text) {
  const payload = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * 流式回壁纸字节。
 *
 * `no-store`：用户随时可能换壁纸，缓存只会让「刷新」看起来没生效。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {object} found - resolveWallpaper 的结果。
 * @param {string} mime - 已判定的 MIME 类型。
 */
function sendWallpaper(res, found, mime) {
  res.writeHead(200, {
    'content-type': mime,
    'content-length': found.sizeBytes,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(found.path)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/**
 * Host 入口：在 web server 上占住本插件的路由。
 *
 * `ctx.effect` 负责注销，插件卸载即释放路径。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isAllowed(req)) {
          sendText(res, 403, 'desktop-wallpaper: forbidden')
          return
        }
        if (req.method !== 'GET') {
          sendText(res, 405, 'desktop-wallpaper: method not allowed')
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const route = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
        if (route !== '/' && route !== '/info' && route !== '/current') {
          sendText(res, 404, 'desktop-wallpaper: unknown route')
          return
        }

        const found = await resolveWallpaper()
        if (found === undefined) {
          sendJson(res, 404, {
            ok: false,
            reason: 'not-found',
            message: '找不到当前桌面壁纸文件（可能是动态壁纸，或壁纸尚未设置）',
          })
          return
        }

        const mime = await readMime(found.path)
        if (mime === undefined) {
          sendJson(res, 415, {
            ok: false,
            reason: 'unsupported',
            message: '壁纸文件的格式无法识别',
            path: found.path,
          })
          return
        }

        if (route === '/current') {
          sendWallpaper(res, found, mime)
          return
        }

        sendJson(res, 200, {
          ok: true,
          fileName: basename(found.path),
          path: found.path,
          source: found.source,
          original: found.original,
          sizeBytes: found.sizeBytes,
          modifiedAt: found.modifiedAt,
          contentType: mime,
        })
      },
    }),
  )
}
