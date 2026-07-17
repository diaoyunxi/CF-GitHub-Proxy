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
            // 取消旧响应的 body 流，释放 socket 连接
            if (response.body) {
                try { response.body.cancel() } catch (e) { /* 忽略 */ }
            }
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
    // 阻止 Cloudflare 边缘代理自动压缩（与 buildSocketResponse 一致）
    resHeaders.set('Content-Encoding', 'identity')
    resHeaders.set('Cache-Control', 'no-cache, no-transform')

    return new Response(response.body, {
        status: response.status,
        headers: resHeaders,
    })
}

// =====================================================================
// socket 方式（用于受 525 影响的域名）
// =====================================================================

/**
 * 解压 gzip 压缩的请求体
 * 用于处理 git 客户端发送的 Content-Encoding: gzip 的 POST 请求体
 * HTTP/1.0 不支持 Content-Encoding，因此需要在 Worker 端先解压再发送
 *
 * @param {ArrayBuffer|Uint8Array} data - gzip 压缩的数据
 * @returns {Promise<ArrayBuffer>} 解压后的数据
 */
async function decompressGzip(data) {
    const ds = new DecompressionStream('gzip')
    const stream = new Blob([data]).stream().pipeThrough(ds)
    return await new Response(stream).arrayBuffer()
}

/**
 * 使用 connect() API 通过 TLS socket 发送 HTTP 请求
 *
 * 关键处理：
 * - 如果请求体有 Content-Encoding: gzip，先在 Worker 端解压
 *   （因为 HTTP/1.0 不支持 Content-Encoding，必须先解压再发送）
 * - 解压后移除 Content-Encoding 头，更新 Content-Length
 *
 * @param {URL} targetUrl
 * @param {string} method
 * @param {Request} originalRequest
 * @param {ArrayBuffer|null} body
 * @returns {Response}
 */
async function fetchViaSocket(targetUrl, method, originalRequest, body) {
    let processedBody = body

    // 如果请求体是 gzip 压缩的，先解压（HTTP/1.0 不支持 Content-Encoding）
    const contentEncoding = originalRequest.headers.get('content-encoding')
    if (contentEncoding === 'gzip' && body && body.byteLength > 0) {
        processedBody = await decompressGzip(body)
    }

    // 构建请求头（buildSocketRequestHeaders 会移除 Content-Encoding 并更新 Content-Length）
    const headers = buildSocketRequestHeaders(originalRequest, targetUrl, processedBody)
    const result = await rawHttpRequest(targetUrl, method, headers, processedBody)
    return buildSocketResponse(result)
}

/**
 * 构建 socket 响应的 Response 对象
 *
 * 关键处理：
 * - 设置 Content-Encoding: identity 阻止 Cloudflare 边缘代理自动 gzip 压缩
 *   （自动压缩会缓冲整个响应体，对大文件（>128MB）导致内存溢出和流截断）
 * - 设置 Cache-Control: no-cache, no-transform 阻止任何中间转换
 * - 跳过 transfer-encoding（已手动处理 chunked）
 *
 * @param {Object} result - { status, headers, body }
 * @returns {Response}
 */
function buildSocketResponse(result) {
    const resHeaders = new Headers()
    for (const [key, val] of Object.entries(result.headers)) {
        // 跳过 transfer-encoding（已手动处理 chunked）
        if (key.toLowerCase() === 'transfer-encoding') continue
        // 跳过 content-encoding（统一在下面设置 identity）
        if (key.toLowerCase() === 'content-encoding') continue
        resHeaders.set(key, val)
    }
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.set('access-control-expose-headers', '*')
    // 阻止 Cloudflare 边缘代理自动压缩（关键修复）
    resHeaders.set('Content-Encoding', 'identity')
    // 阻止任何中间转换（缓存、压缩等）
    resHeaders.set('Cache-Control', 'no-cache, no-transform')

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

    // Content-Encoding（git 客户端可能对 POST 请求体做 gzip 压缩）
    // 必须转发此头，否则目标服务器无法正确解压请求体，返回 400
    const contentEncoding = request.headers.get('content-encoding')
    if (contentEncoding) headers['Content-Encoding'] = contentEncoding

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
 *
 * 关键处理：
 * - 强制 Accept-Encoding: identity（避免响应体 gzip 压缩）
 * - 移除 Content-Encoding（请求体已在 Worker 端解压，HTTP/1.0 不支持 Content-Encoding）
 * - 更新 Content-Length 为解压后的实际大小
 */
function buildSocketRequestHeaders(request, targetUrl, body) {
    const headers = buildRequestHeaders(request, targetUrl, body)
    headers['Accept-Encoding'] = 'identity'
    // 移除 Content-Encoding：请求体已在 fetchViaSocket 中解压
    // HTTP/1.0 不支持 Content-Encoding，发送此头会导致 400 错误
    delete headers['Content-Encoding']
    // Content-Length 已由 buildRequestHeaders 根据解压后的 body 大小正确设置
    return headers
}

// =====================================================================
// HTTP/1.0 over TLS socket 实现（纯管道传输版）
// =====================================================================

/**
 * 通过 connect() API 发送原始 HTTP 请求（纯管道流式响应）
 *
 * 核心架构：
 * 1. 使用 HTTP/1.0 协议（不支持 chunked Transfer-Encoding）
 *    → 服务器不会返回 chunked 响应，用 Connection: close 标识结束
 * 2. 对非 chunked 响应使用纯管道传输（controller.enqueue 直接传引用）
 *    → 不做任何 JavaScript 级别的数据处理，CPU 消耗极低
 * 3. 对 chunked 响应保留 de-chunking 作为兜底（理论上 HTTP/1.0 不会出现）
 *
 * 为什么用 HTTP/1.0 而非 HTTP/1.1：
 * - HTTP/1.1 的 chunked 响应需要 JavaScript de-chunking（concatUint8Arrays + slice）
 * - 处理 172MB 数据的 de-chunking 会累积超过 10ms CPU 时间（免费计划限制）
 * - HTTP/1.0 不支持 chunked 编码，服务器用 Connection: close 标识响应结束
 * - 纯管道传输仅 controller.enqueue(value)，不拷贝/处理数据，CPU ≈ 0
 * - gzip 请求体已在 fetchViaSocket 中解压，无需 Content-Encoding 头
 *
 * @param {URL} targetUrl - 目标 URL
 * @param {string} method - HTTP 方法
 * @param {Object} headers - 请求头键值对
 * @param {ArrayBuffer|null} body - 请求体
 * @returns {Object} { status, headers, body: ReadableStream }
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

    // 写入 HTTP/1.0 请求（HTTP/1.0 不支持 chunked 编码，服务器用 Connection: close 标识响应结束）
    const writer = socket.writable.getWriter()
    let reqStr = `${method} ${path} HTTP/1.0\r\n`
    for (const [key, val] of Object.entries(headers)) {
        reqStr += `${key}: ${val}\r\n`
    }
    reqStr += '\r\n'

    await writer.write(new TextEncoder().encode(reqStr))
    if (body && body.byteLength > 0) {
        await writer.write(new Uint8Array(body))
    }
    writer.releaseLock()

    // === 步骤1：用 reader 手动读取响应头 ===
    const reader = socket.readable.getReader()
    let buffer = new Uint8Array(0)
    let headerEnd = -1

    while (headerEnd === -1) {
        const { done, value } = await reader.read()
        if (done) {
            throw new Error('连接在接收到响应头之前关闭')
        }
        buffer = concatUint8Arrays(buffer, value)
        headerEnd = findHeaderEnd(buffer)
    }

    // 解析状态行和响应头
    const headerText = new TextDecoder().decode(buffer.slice(0, headerEnd))
    const lines = headerText.split('\r\n')
    const statusMatch = lines[0].match(/^HTTP\/\d\.\d\s+(\d+)/)
    const status = statusMatch ? parseInt(statusMatch[1]) : 0

    const responseHeaders = {}
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':')
        if (idx > 0) {
            const key = lines[i].substring(0, idx).trim().toLowerCase()
            const val = lines[i].substring(idx + 1).trim()
            responseHeaders[key] = val
        }
    }

    const isChunked = responseHeaders['transfer-encoding'] === 'chunked'
    const contentLengthStr = responseHeaders['content-length']
    const contentLength = contentLengthStr ? parseInt(contentLengthStr) : -1
    const bodyStart = buffer.slice(headerEnd + 4) // 头部之后的剩余字节

    // === 步骤2：释放 reader 锁 ===
    reader.releaseLock()

    // === 步骤3：返回响应 ===
    // 非 chunked 响应使用 IdentityTransformStream + pipeTo（运行时优化）
    // chunked 响应使用手动 de-chunking 兜底（理论上 HTTP/1.0 不会出现）

    let totalEnqueued = 0
    let bodyStartSent = false
    let chunkBuf = new Uint8Array(0)
    let chunkMode = 0 // 0=读取 size 行, 1=读取数据, 2=完成
    let chunkRemaining = 0
    let socketReader = null
    let streamClosed = false

    /**
     * 处理 body 数据：非 chunked 直接透传，chunked 解码后透传
     * @param {Uint8Array} bytes - body 字节
     * @param {ReadableStreamDefaultController} controller
     */
    function handleBody(bytes, controller) {
        if (bytes.length === 0) return

        if (!isChunked) {
            // 非 chunked：直接透传
            controller.enqueue(bytes)
            totalEnqueued += bytes.length
            return
        }

        // chunked 解码
        chunkBuf = concatUint8Arrays(chunkBuf, bytes)
        while (true) {
            if (chunkMode === 0) {
                // 读取 chunk size 行
                const idx = findCRLF(chunkBuf)
                if (idx === -1) break
                const sizeStr = new TextDecoder().decode(chunkBuf.slice(0, idx))
                const chunkSize = parseInt(sizeStr.split(';')[0], 16)
                chunkBuf = chunkBuf.slice(idx + 2)
                if (isNaN(chunkSize) || chunkSize === 0) {
                    chunkMode = 2
                    break
                }
                chunkRemaining = chunkSize
                chunkMode = 1
            } else if (chunkMode === 1) {
                // 读取 chunk 数据
                if (chunkBuf.length < chunkRemaining + 2) break
                const data = chunkBuf.slice(0, chunkRemaining)
                if (data.length > 0) {
                    controller.enqueue(data)
                    totalEnqueued += data.length
                }
                chunkBuf = chunkBuf.slice(chunkRemaining + 2) // 跳过数据 + \r\n
                chunkMode = 0
            } else {
                break
            }
        }
    }

    /**
     * 检查 body 是否已读取完毕
     * @returns {boolean}
     */
    function isBodyDone() {
        if (isChunked) return chunkMode === 2
        if (contentLength >= 0) return totalEnqueued >= contentLength
        return false // 无 Content-Length 且非 chunked，依赖 socket 关闭
    }

    // 1xx/204/304 响应无 body，直接返回空流
    if ((status >= 100 && status < 200) || status === 204 || status === 304) {
        return {
            status,
            headers: responseHeaders,
            body: new ReadableStream({
                start(c) { c.close() }
            })
        }
    }

    // =================================================================
    // 非 chunked 响应：IdentityTransformStream + pipeTo 纯管道传输
    // =================================================================
    // HTTP/1.0 服务器不会使用 chunked 编码，所以走这个快速路径
    // 使用 Cloudflare 运行时原生的 IdentityTransformStream + pipeTo
    // 比 ReadableStream 的手动 pull() 更高效：
    // - pipeTo 由运行时内部处理，无 JavaScript 回调开销
    // - 自动处理背压和流量控制
    // - 无 pull() 方法超时风险
    if (!isChunked) {
        const { readable, writable } = new IdentityTransformStream()

        // 先写入读取头部时剩余的 body 字节
        const writer = writable.getWriter()
        if (bodyStart.length > 0) {
            writer.write(bodyStart)
        }
        writer.releaseLock()

        // 异步管道传输：socket.readable → writable → readable → 客户端
        // pipeTo 由运行时优化，不消耗 CPU 时间
        // socket 关闭时 pipeTo 自动结束，writable 关闭 → readable 关闭
        socket.readable.pipeTo(writable).catch(() => {
            // socket 关闭或错误时，writable 已自动关闭/错误
            // readable 会传播错误到客户端
        })

        return { status, headers: responseHeaders, body: readable }
    }

    // =================================================================
    // chunked 响应兜底：de-chunking + pull 批量读取
    // =================================================================
    // 理论上 HTTP/1.0 不会出现 chunked 响应，但保留作为兜底
    // 如果服务器不遵守 HTTP/1.0 规范仍返回 chunked，走此路径
    const bodyStream = new ReadableStream({
        async pull(controller) {
            try {
                // 首次 pull：先处理 bodyStart（读取头部时剩余的 body 字节）
                if (!bodyStartSent) {
                    bodyStartSent = true
                    handleBody(bodyStart, controller)
                    if (isBodyDone()) {
                        controller.close()
                        streamClosed = true
                        return
                    }
                }

                // 检查是否已完成
                if (isBodyDone()) {
                    controller.close()
                    streamClosed = true
                    return
                }

                // 延迟获取 socket reader（确保 releaseLock 已完成）
                if (!socketReader) {
                    socketReader = socket.readable.getReader()
                }

                // 批量读取：每次 pull 读取最多 1MB
                const TARGET_BATCH = 1024 * 1024 // 1MB
                let bytesRead = 0

                while (bytesRead < TARGET_BATCH && !isBodyDone()) {
                    const { done, value } = await socketReader.read()
                    if (done) {
                        // socket 关闭，结束流
                        if (!streamClosed) {
                            controller.close()
                            streamClosed = true
                        }
                        return
                    }
                    if (value && value.length > 0) {
                        handleBody(value, controller)
                        bytesRead += value.length
                    }
                }

                // 检查是否读取完毕
                if (isBodyDone() && !streamClosed) {
                    controller.close()
                    streamClosed = true
                }
            } catch (err) {
                if (!streamClosed) {
                    controller.error(err)
                    streamClosed = true
                }
            }
        },

        cancel() {
            // 消费者取消（如重定向时 body.cancel()）
            try { if (socketReader) socketReader.cancel() } catch (e) {}
            try { socket.close() } catch (e) {}
        }
    })

    // 立即返回（无 await，避免阻塞）
    return { status, headers: responseHeaders, body: bodyStream }
}

// =====================================================================
// 流式传输辅助函数
// =====================================================================

/**
 * 拼接两个 Uint8Array
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function concatUint8Arrays(a, b) {
    const result = new Uint8Array(a.length + b.length)
    result.set(a)
    result.set(b, a.length)
    return result
}

/**
 * 在 Uint8Array 中查找 \r\n 的位置
 * @param {Uint8Array} bytes
 * @param {number} start - 起始位置
 * @returns {number} \r\n 的起始索引，-1 表示未找到
 */
function findCRLF(bytes, start = 0) {
    for (let i = start; i < bytes.length - 1; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10) {
            return i
        }
    }
    return -1
}

/**
 * 查找 HTTP 响应头结束位置（\r\n\r\n）
 * @param {Uint8Array} bytes
 * @returns {number} \r\n\r\n 的起始索引，-1 表示未找到
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

// =====================================================================
// 诊断
// =====================================================================

/**
 * 诊断函数：测试各 GitHub 域名的连通性
 */
async function diagnosticsHandler() {
    const results = []

    // 测试 fetch()（包括受 525 影响的域名，验证是否已修复）
    const fetchTestUrls = [
        'https://raw.githubusercontent.com',
        'https://objects.githubusercontent.com',
        'https://github.com/',
        'https://api.github.com/',
        'https://codeload.github.com/',
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
            // 诊断只需状态码，取消 body 流避免 socket 挂起
            if (response.body && response.body.cancel) {
                response.body.cancel()
            }
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
            // 诊断只需状态码，取消 body 流避免 socket 挂起
            if (response.body && response.body.cancel) {
                response.body.cancel()
            }
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
