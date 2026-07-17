/**
 * CF-Workers-GitHub-Proxy
 * 基于 Cloudflare Workers 的 GitHub 全功能镜像站
 *
 * 核心技术：
 * - cloudflare:sockets connect() API 绕过 Worker fetch() 对 github.com 的 SSL 525 错误
 * - fetch() 处理不受 525 影响的域名（*.githubusercontent.com 等）
 * - 混合传输：自动根据目标域名选择 socket 或 fetch，跟随重定向时自动切换
 *
 * 支持功能：
 * - GitHub 页面访问、Release 下载、Archive 下载
 * - Git clone / push（通过 http.extraHeader 认证）
 * - API 访问（api.github.com）
 * - Raw 文件、Gist、Codeload
 * - 大文件流式传输（githubusercontent.com 走 fetch）
 *
 * 部署方式：
 * 1. wrangler: npx wrangler deploy workers.js --name gh
 * 2. Cloudflare Dashboard: 粘贴本文件代码（ES Module 格式）
 */

import { connect } from 'cloudflare:sockets'

// =====================================================================
// 配置
// =====================================================================

/** 静态资源地址（404 页面、sw.js、conf.js） */
const ASSET_URL = 'https://geekertao.github.io/gh-proxy/'
/** 前缀，如自定义路由为 example.com/gh/*，改为 '/gh/' */
const PREFIX = '/'
/** jsDelivr 镜像开关，1=开启（blob 文件走 jsDelivr），0=关闭 */
const Config = { jsdelivr: 0 }
/** 白名单，路径中包含指定字符才通过，如 ['/username/'] */
const whiteList = []

// =====================================================================
// 域名分类
// =====================================================================

/**
 * 受 SSL 525 影响的域名（必须用 connect() socket）
 * Worker fetch() 对这些域名存在 TLS 兼容性问题
 */
const SOCKET_DOMAINS = new Set([
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'gist.github.com',
])

/**
 * 不受 525 影响的域名后缀（可以用 fetch()，支持流式传输）
 */
const FETCH_OK_SUFFIXES = [
    '.githubusercontent.com',
    '.githubassets.com',
    '.github.io',
]

// =====================================================================
// URL 匹配正则
// =====================================================================

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i
const exp8 = /^(?:https?:\/\/)?objects\.githubusercontent\.com\/.*$/i
const exp9 = /^(?:https?:\/\/)?codeload\.github\.com\/.*$/i

// =====================================================================
// 工具函数
// =====================================================================

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}

/**
 * 创建响应
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, {status, headers})
}

/**
 * 安全创建 URL
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}

/**
 * 检查 URL 是否匹配支持的 GitHub 模式
 * @param {string} u
 */
function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8, exp9]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * 判断域名是否需要使用 socket（受 525 影响）
 * @param {string} hostname
 */
function needsSocket(hostname) {
    return SOCKET_DOMAINS.has(hostname)
}

/**
 * 判断域名是否可以用 fetch()（不受 525 影响）
 * @param {string} hostname
 */
function canUseFetch(hostname) {
    return FETCH_OK_SUFFIXES.some(suffix => hostname.endsWith(suffix))
}

// =====================================================================
// ES Module 入口
// =====================================================================

export default {
    async fetch(request, env, ctx) {
        try {
            return await fetchHandler(request)
        } catch (err) {
            return makeRes('cfworker error:\n' + err.stack, 502)
        }
    }
}

// =====================================================================
// 主请求处理
// =====================================================================

/**
 * @param {Request} req
 */
async function fetchHandler(req) {
    const urlStr = req.url
    const urlObj = new URL(urlStr)

    // q 参数重定向
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }

    // 诊断端点
    if (urlObj.pathname === '/__diag__') {
        return diagnosticsHandler()
    }

    // Socket 测试端点
    if (urlObj.pathname === '/__socket_test__') {
        return socketTest()
    }

    // cfworker 会把路径中的 // 合并成 /
    path = urlObj.href.substr(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')

    // 路由匹配
    if (path.search(exp7) === 0) {
        // api.github.com → 混合传输
        return httpHandler(req, path)
    } else if (path.search(exp1) === 0 || path.search(exp5) === 0 ||
               path.search(exp6) === 0 || path.search(exp3) === 0 ||
               path.search(exp4) === 0 || path.search(exp9) === 0) {
        // github.com releases/archive/info/git-refs/raw/gist/tags/codeload → 混合传输
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        // github.com blob/raw → 转换为 raw 路径走混合传输
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path)
        }
    } else {
        // 静态资源
        return fetch(ASSET_URL + path)
    }
}

/**
 * HTTP 请求处理：根据目标域名选择 socket 或 fetch
 * @param {Request} req
 * @param {string} pathname
 */
async function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    // CORS 预检
    if (req.method === 'OPTIONS' && reqHdrRaw.has('access-control-request-headers')) {
        return new Response(null, PREFLIGHT_INIT)
    }

    let urlStr = pathname

    // 白名单检查
    let flag = !Boolean(whiteList.length)
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", {status: 403})
    }

    // 确保 URL 有协议前缀
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }

    const urlObj = newUrl(urlStr)
    if (!urlObj) {
        return makeRes('Invalid URL', 400)
    }

    // 使用混合传输（socket + fetch）
    return fetchViaHybrid(urlObj, req)
}

// =====================================================================
// 混合传输：sockets + fetch
// =====================================================================

/**
 * 混合方式发送请求
 * - 525 受影响域名 → connect() socket
 * - 不受影响域名 → fetch()（支持流式传输大文件）
 * - 自动跟随重定向，跨域名时自动切换传输方式
 * @param {URL} targetUrl - 目标 URL
 * @param {Request} request - 原始请求
 * @param {number} maxRedirects - 最大重定向次数
 * @returns {Response}
 */
async function fetchViaHybrid(targetUrl, request, maxRedirects = 10) {
    let currentUrl = targetUrl
    let currentMethod = request.method
    let requestBody = null

    // 读取 POST/PUT/PATCH 请求体（只读一次，重定向后清空）
    if (['POST', 'PUT', 'PATCH'].includes(currentMethod)) {
        requestBody = await request.arrayBuffer()
    }

    for (let i = 0; i < maxRedirects; i++) {
        let response

        if (canUseFetch(currentUrl.hostname)) {
            // 不受 525 影响的域名 → 使用 fetch()（支持流式传输大文件）
            response = await fetchViaFetch(currentUrl, currentMethod, request, requestBody)
        } else {
            // 受 525 影响的域名 → 使用 connect() socket
            response = await fetchViaSocket(currentUrl, currentMethod, request, requestBody)
        }

        // 处理重定向
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
            currentUrl = new URL(location, currentUrl.href)
            currentMethod = 'GET' // 重定向始终降级为 GET
            requestBody = null
            continue
        }

        return response
    }

    return new Response('Too many redirects', {
        status: 502,
        headers: { 'access-control-allow-origin': '*' },
    })
}

// =====================================================================
// fetch() 方式（用于不受 525 影响的域名，支持流式传输）
// =====================================================================

/**
 * 使用 fetch() 发送请求
 * @param {URL} targetUrl
 * @param {string} method
 * @param {Request} originalRequest
 * @param {ArrayBuffer|null} body
 * @returns {Response}
 */
async function fetchViaFetch(targetUrl, method, originalRequest, body) {
    const headers = buildRequestHeaders(originalRequest, targetUrl, body)
    const fetchHeaders = new Headers()
    for (const [key, val] of Object.entries(headers)) {
        fetchHeaders.set(key, val)
    }

    const response = await fetch(targetUrl.href, {
        method: method,
        headers: fetchHeaders,
        body: body && body.byteLength > 0 ? body : undefined,
        redirect: 'manual',
    })

    const resHeaders = new Headers(response.headers)
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.set('access-control-expose-headers', '*')
    resHeaders.delete('content-security-policy')
    resHeaders.delete('content-security-policy-report-only')

    return new Response(response.body, {
        status: response.status,
        headers: resHeaders,
    })
}

// =====================================================================
// socket 方式（用于受 525 影响的域名）
// =====================================================================

/**
 * 使用 connect() API 通过 TLS socket 发送 HTTP 请求
 * @param {URL} targetUrl
 * @param {string} method
 * @param {Request} originalRequest
 * @param {ArrayBuffer|null} body
 * @returns {Response}
 */
async function fetchViaSocket(targetUrl, method, originalRequest, body) {
    // socket 请求强制 Accept-Encoding: identity，避免 gzip 解压问题
    const headers = buildSocketRequestHeaders(originalRequest, targetUrl, body)
    const result = await rawHttpRequest(targetUrl, method, headers, body)
    return buildSocketResponse(result)
}

/**
 * 构建 socket 响应的 Response 对象
 * @param {Object} result - { status, headers, body }
 * @returns {Response}
 */
function buildSocketResponse(result) {
    const resHeaders = new Headers()
    for (const [key, val] of Object.entries(result.headers)) {
        // 跳过 transfer-encoding（已手动处理 chunked）
        if (key.toLowerCase() === 'transfer-encoding') continue
        resHeaders.set(key, val)
    }
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.set('access-control-expose-headers', '*')

    return new Response(result.body, {
        status: result.status,
        headers: resHeaders,
    })
}

// =====================================================================
// 请求头构建
// =====================================================================

/**
 * 构建通用请求头（用于 fetch 和 socket）
 * @param {Request} request - 原始请求
 * @param {URL} targetUrl - 目标 URL
 * @param {ArrayBuffer|null} body - 请求体
 * @returns {Object} 请求头键值对
 */
function buildRequestHeaders(request, targetUrl, body) {
    const headers = {
        'Host': targetUrl.hostname,
        'User-Agent': request.headers.get('user-agent') || 'git/2.39.0',
        'Accept': request.headers.get('accept') || '*/*',
        'Connection': 'close',
    }

    // Content-Type（git 协议 POST 需要）
    const contentType = request.headers.get('content-type')
    if (contentType) headers['Content-Type'] = contentType

    // Authorization（git push 认证）
    const auth = request.headers.get('authorization')
    if (auth) headers['Authorization'] = auth

    // Git-Protocol（git smart HTTP 协议版本）
    const gitProtocol = request.headers.get('git-protocol')
    if (gitProtocol) headers['Git-Protocol'] = gitProtocol

    // Range（断点续传）
    const range = request.headers.get('range')
    if (range) headers['Range'] = range

    // Accept-Encoding
    const acceptEncoding = request.headers.get('accept-encoding')
    if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding

    // Accept-Language
    const acceptLang = request.headers.get('accept-language')
    if (acceptLang) headers['Accept-Language'] = acceptLang

    // 缓存协商
    const ifModSince = request.headers.get('if-modified-since')
    if (ifModSince) headers['If-Modified-Since'] = ifModSince
    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch

    // POST body 大小
    if (body && body.byteLength > 0) {
        headers['Content-Length'] = body.byteLength.toString()
    }

    return headers
}

/**
 * 构建 socket 专用请求头
 * 强制 Accept-Encoding: identity（避免 gzip 解压问题）
 */
function buildSocketRequestHeaders(request, targetUrl, body) {
    const headers = buildRequestHeaders(request, targetUrl, body)
    headers['Accept-Encoding'] = 'identity'
    return headers
}

// =====================================================================
// HTTP/1.1 over TLS socket 实现
// =====================================================================

/**
 * 通过 connect() API 发送原始 HTTP/1.1 请求
 * @param {URL} targetUrl - 目标 URL
 * @param {string} method - HTTP 方法
 * @param {Object} headers - 请求头键值对
 * @param {ArrayBuffer|null} body - 请求体
 * @returns {Object} { status, headers, body }
 */
async function rawHttpRequest(targetUrl, method, headers, body) {
    const hostname = targetUrl.hostname
    const port = targetUrl.port || 443
    const path = targetUrl.pathname + targetUrl.search

    // 建立 TLS 连接
    const socket = connect(`${hostname}:${port}`, {
        secureTransport: 'on',
        allowHalfOpen: false,
    })

    const writer = socket.writable.getWriter()
    const reader = socket.readable.getReader()

    try {
        // 构建 HTTP/1.1 请求
        let reqStr = `${method} ${path} HTTP/1.1\r\n`
        for (const [key, val] of Object.entries(headers)) {
            reqStr += `${key}: ${val}\r\n`
        }
        reqStr += '\r\n'

        // 写入请求头
        await writer.write(new TextEncoder().encode(reqStr))

        // 写入请求体
        if (body && body.byteLength > 0) {
            await writer.write(new Uint8Array(body))
        }

        // 读取完整响应
        const allBytes = await readAll(reader)
        return parseHttpResponse(allBytes)
    } finally {
        try { writer.close() } catch (e) { /* 忽略关闭错误 */ }
    }
}

/**
 * 从 socket reader 读取所有数据直到连接关闭
 * @param {ReadableStreamDefaultReader} reader
 * @returns {Uint8Array}
 */
async function readAll(reader) {
    const chunks = []
    let totalLen = 0

    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        totalLen += value.length
    }

    const allBytes = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) {
        allBytes.set(c, offset)
        offset += c.length
    }
    return allBytes
}

// =====================================================================
// HTTP 响应解析
// =====================================================================

/**
 * 解析 HTTP/1.1 响应
 * @param {Uint8Array} allBytes - 原始响应字节
 * @returns {Object} { status, headers, body }
 */
function parseHttpResponse(allBytes) {
    const headerEnd = findHeaderEnd(allBytes)
    if (headerEnd === -1) {
        throw new Error('Invalid HTTP response: no header delimiter found')
    }

    const headerBytes = allBytes.slice(0, headerEnd)
    const bodyBytes = allBytes.slice(headerEnd + 4)

    const headerText = new TextDecoder().decode(headerBytes)
    const lines = headerText.split('\r\n')

    // 解析状态行
    const statusLine = lines[0]
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/)
    const status = statusMatch ? parseInt(statusMatch[1]) : 0

    // 解析响应头
    const responseHeaders = {}
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':')
        if (idx > 0) {
            const key = lines[i].substring(0, idx).trim().toLowerCase()
            const val = lines[i].substring(idx + 1).trim()
            responseHeaders[key] = val
        }
    }

    // 处理 chunked 编码
    let finalBody = bodyBytes
    if (responseHeaders['transfer-encoding'] === 'chunked') {
        finalBody = parseChunkedBody(bodyBytes)
    }

    return { status, headers: responseHeaders, body: finalBody }
}

/**
 * 查找 HTTP 响应头结束位置（\r\n\r\n）
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function findHeaderEnd(bytes) {
    for (let i = 0; i < bytes.length - 3; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10 &&
            bytes[i + 2] === 13 && bytes[i + 3] === 10) {
            return i
        }
    }
    return -1
}

/**
 * 解析 chunked transfer encoding 的响应体
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function parseChunkedBody(bytes) {
    const result = []
    let pos = 0

    while (pos < bytes.length) {
        let lineEnd = -1
        for (let i = pos; i < bytes.length - 1; i++) {
            if (bytes[i] === 13 && bytes[i + 1] === 10) {
                lineEnd = i
                break
            }
        }
        if (lineEnd === -1) break

        const sizeStr = new TextDecoder().decode(bytes.slice(pos, lineEnd))
        const chunkSize = parseInt(sizeStr.split(';')[0], 16)
        if (isNaN(chunkSize) || chunkSize === 0) break

        pos = lineEnd + 2
        result.push(bytes.slice(pos, pos + chunkSize))
        pos += chunkSize + 2
    }

    let totalLen = result.reduce((s, c) => s + c.length, 0)
    const output = new Uint8Array(totalLen)
    let offset = 0
    for (const c of result) {
        output.set(c, offset)
        offset += c.length
    }
    return output
}

// =====================================================================
// 诊断
// =====================================================================

/**
 * 诊断函数：测试各 GitHub 域名的连通性
 */
async function diagnosticsHandler() {
    const results = []

    // 测试 fetch()
    const fetchTestUrls = [
        'https://raw.githubusercontent.com',
        'https://objects.githubusercontent.com',
    ]
    for (const url of fetchTestUrls) {
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'user-agent': 'Mozilla/5.0' },
                redirect: 'manual',
            })
            results.push({ url, method: 'fetch', status: res.status, ok: res.ok })
        } catch (err) {
            results.push({ url, method: 'fetch', status: 'error', error: err.message })
        }
    }

    // 测试 socket (connect())
    const socketTestHosts = ['github.com', 'api.github.com', 'codeload.github.com']
    for (const host of socketTestHosts) {
        try {
            const target = new URL(`https://${host}/`)
            const response = await rawHttpRequest(target, 'GET', {
                'Host': host,
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'close',
            }, null)
            results.push({
                url: `https://${host}/`,
                method: 'socket',
                status: response.status,
                ok: response.status > 0,
            })
        } catch (err) {
            results.push({
                url: `https://${host}/`,
                method: 'socket',
                status: 'error',
                error: err.message,
            })
        }
    }

    return new Response(JSON.stringify(results, null, 2), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
        },
    })
}

/**
 * Socket 连通性测试
 */
async function socketTest() {
    const testHosts = ['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com']
    const results = []

    for (const host of testHosts) {
        try {
            const target = new URL(`https://${host}/`)
            const response = await rawHttpRequest(target, 'GET', {
                'Host': host,
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'close',
            }, null)
            results.push({ host, method: 'socket', status: response.status, ok: response.status > 0 })
        } catch (err) {
            results.push({ host, method: 'socket', status: 'error', error: err.message })
        }
    }

    return new Response(JSON.stringify(results, null, 2), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
        },
    })
}
