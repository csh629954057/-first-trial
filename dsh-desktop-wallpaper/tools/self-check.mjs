/**
 * dsh-desktop-wallpaper 的装机前自检。
 *
 * 1. 真的 import Host 半边，调 apply()，再用假的 req/res 打一次真实路由
 *    （会读到这台机器上真正的壁纸文件）；
 * 2. 真的 import Client 半边，用假的模块表跑 factory，再用假的 ctx 跑 apply，
 *    确认槽位注册、词典注册与主题叠加层都接得上。
 *
 * 用法：node tools/self-check.mjs [插件目录]
 *   不传参数时默认取本文件所在目录的上一级。
 */
import { EventEmitter } from 'node:events'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = (process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')).replace(/\\/g, '/')
const fail = []
const ok = (label) => console.log(`ok   ${label}`)
const bad = (label, error) => {
  fail.push(label)
  console.log(`FAIL ${label} :: ${error}`)
}

// ------------------------------------------------------------------ Host 半边

const host = await import(`file:///${pluginDir}/lib/index.js`).catch((error) => {
  bad('import lib/index.js', error)
  return undefined
})

if (host !== undefined) {
  if (host.name === 'ui-desktop-wallpaper') ok(`host name = ${host.name}`)
  else bad('host name', `expected ui-desktop-wallpaper, got ${host.name}`)
  if (Array.isArray(host.inject) && host.inject.includes('webServer')) ok('host inject = webServer')
  else bad('host inject', JSON.stringify(host.inject))

  /** 收集注册的路由，供下面直接调用。 */
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  try {
    host.apply(ctx)
    if (routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/desktop-wallpaper') {
      ok(`host registered ${routes[0].kind} ${routes[0].path}`)
    } else bad('host route registration', JSON.stringify(routes.map((r) => [r.kind, r.path])))
  } catch (error) {
    bad('host apply()', error)
  }

  /** 用假的 req/res 打一次路由，返回 { status, headers, body }。 */
  const call = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks) })
      }
      // 必须是个真的 Writable 替身：handler 用 createReadStream().pipe(res) 回图片。
      class FakeResponse extends EventEmitter {
        constructor() {
          super()
          this.status = 0
          this.headers = undefined
        }
        writeHead(status, headerSet) {
          this.status = status
          this.headers = headerSet
          return this
        }
        write(chunk) {
          chunks.push(Buffer.from(chunk))
          return true
        }
        end(payload) {
          if (payload !== undefined) chunks.push(Buffer.from(payload))
          settle()
          return this
        }
        destroy() {
          settle()
        }
      }
      const res = new FakeResponse()
      const req = {
        method: 'GET',
        url: path,
        headers: { host: '127.0.0.1:61022', ...headers },
        socket: { remoteAddress: '127.0.0.1' },
      }
      Promise.resolve(routes[0].handler(req, res)).catch(reject)
    })

  if (routes.length === 1) {
    // 守卫：跨站读取必须被拒。
    const crossSite = await call('/desktop-wallpaper/info', { 'sec-fetch-site': 'cross-site' })
    if (crossSite.status === 403) ok('guard rejects cross-site (403)')
    else bad('cross-site guard', `expected 403, got ${crossSite.status}`)

    const remote = await call('/desktop-wallpaper/info', {})
    if (remote.status === 200 || remote.status === 404 || remote.status === 415) ok(`loopback request allowed (${remote.status})`)
    else bad('loopback request', `unexpected ${remote.status} ${remote.body.toString('utf8').slice(0, 120)}`)

    const unknown = await call('/desktop-wallpaper/nope')
    if (unknown.status === 404) ok('unknown route 404')
    else bad('unknown route', `expected 404, got ${unknown.status}`)

    // 真实壁纸
    const info = await call('/desktop-wallpaper/info')
    console.log(`     info -> ${info.status} ${info.body.toString('utf8').slice(0, 400)}`)
    if (info.status === 200) {
      const parsed = JSON.parse(info.body.toString('utf8'))
      ok(`wallpaper found: ${parsed.fileName} (${parsed.contentType}, ${parsed.sizeBytes} B, source=${parsed.source})`)
      const bytes = await call('/desktop-wallpaper/current')
      if (bytes.status === 200 && bytes.body.length === parsed.sizeBytes && bytes.body.length > 0) {
        const magic = bytes.body.subarray(0, 4).toString('hex')
        ok(`image bytes served: ${bytes.body.length} B, magic ${magic}, content-type ${bytes.headers['content-type']}`)
      } else {
        bad('image bytes', `status ${bytes.status}, ${bytes.body.length} B vs declared ${parsed.sizeBytes}`)
      }
    } else {
      console.log('     (no wallpaper file resolvable on this machine — route behaviour still verified)')
    }
  }
}

// ---------------------------------------------------------------- Client 半边

let captured
globalThis.window = { __ModuleLoader__: { load: (definition) => (captured = definition) } }
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {}, append() {} }),
  head: { append() {} },
  querySelector: () => null,
}

const client = await import(`file:///${pluginDir}/lib/client.js`).catch((error) => {
  bad('import lib/client.js', error)
  return undefined
})

if (captured !== undefined) {
  if (captured.id === 'dsh-desktop-wallpaper') ok(`client module id = ${captured.id}`)
  else bad('client module id', captured.id ?? 'undefined')

  /** 只够跑通 factory 的 React 替身。 */
  const reactShim = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }

  let mod
  try {
    mod = captured.factory((specifier) => {
      if (specifier === 'react') return reactShim
      throw new Error(`unexpected require: ${specifier}`)
    })
    ok('factory ran and returned a module')
  } catch (error) {
    bad('factory', error)
  }

  if (mod !== undefined) {
    const registrations = []
    const layers = []
    const effects = []
    const localeForChildren = {
      register: (ns, localeOrDicts, dict) => {
        const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
        for (const [id, entries] of pairs) registrations.push(['dict', ns, id, Object.keys(entries).length])
        return () => {}
      },
      bind: () => (key) => key,
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    }
    const themeForChildren = {
      overrideTokens: (source, tokens) => {
        layers.push([source, tokens])
        return () => {}
      },
    }
    const ctx = {
      effect: (fn) => {
        const disposer = fn()
        effects.push(disposer)
        return () => {}
      },
      get: (service) => (service === 'locale' ? localeForChildren : service === 'theme' ? themeForChildren : undefined),
      slots: {
        inject: (slot, callback) => {
          registrations.push(['inject', slot])
          callback()
          return () => {}
        },
        register: (options, component) => {
          registrations.push(['register', options.name, options.id, options.order])
          registrations.push(['render', typeof component])
          return () => {}
        },
      },
    }
    try {
      mod.apply(ctx)
      ok(`client apply() registered: ${JSON.stringify(registrations)}`)
      const slotRow = registrations.find((row) => row[0] === 'register')
      if (slotRow !== undefined && slotRow[1] === 'conversation.composer.dock' && slotRow[2] === 'desktop-wallpaper') {
        ok('dock slot occupant registered')
      } else bad('dock slot occupant', JSON.stringify(slotRow))
      if (registrations.some((row) => row[0] === 'dict' && row[2] === 'zh')) ok('zh dictionary registered')
      else bad('zh dictionary', 'missing')
      if (registrations.some((row) => row[0] === 'dict' && row[2] === 'en')) ok('en dictionary registered')
      else bad('en dictionary', 'missing')
      if (Array.isArray(mod.inject) && mod.inject.includes('slots')) ok(`client inject = ${JSON.stringify(mod.inject)}`)
      else bad('client inject', JSON.stringify(mod.inject))
    } catch (error) {
      bad('client apply()', error)
    }
    // 每个 effect 的 disposer 都必须是函数，否则卸载路径是坏的。
    const badDisposer = effects.findIndex((disposer) => disposer !== undefined && typeof disposer !== 'function')
    if (badDisposer === -1) ok(`all ${effects.length} ctx.effect disposers are callable`)
    else bad('ctx.effect disposer', `index ${badDisposer} is not a function`)
  }
}

console.log(fail.length === 0 ? '\nALL CHECKS PASSED' : `\n${fail.length} CHECK(S) FAILED`)
process.exitCode = fail.length === 0 ? 0 : 1
