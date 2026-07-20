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

/** 静态资源地址（首页、404 页面等） */
const ASSET_URL = 'https://diaoyunxi.github.io/CF-GitHub-Proxy/'
/** 前缀，如自定义路由为 example.com/gh/*，改为 '/gh/' */
const PREFIX = '/'
/** 白名单，路径中包含指定字符才通过，如 ['/username/'] */
const whiteList = []
/**
 * GitHub Token（可选，用于文件夹下载的 API 认证，提升速率限制到 5000次/小时）
 * 留空则使用未认证方式（60次/小时/IP）
 * 也可通过 URL 参数 ?token=xxx 或 Authorization 请求头传入
 */
const GITHUB_TOKEN = ''
/**
 * 是否启用 Releases 列表功能
 * 开启后访问 /https://github.com/user/repo/releases 返回可点击的 Release 列表页
 * 关闭后该路径走原有混合传输逻辑（返回 GitHub 原始页面）
 */
const ENABLE_RELEASES_LIST = true

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
/** 匹配 github.com tree 路径（文件夹下载） */
const exp10 = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/i
/** 匹配 github.com/user/repo/releases 列表页（不含 /download/ 路径） */
const exp11 = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/releases\/?$/i

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
    } else if (ENABLE_RELEASES_LIST && path.search(exp11) === 0) {
        // github.com/user/repo/releases 列表页 → 返回可点击的 Release 列表
        return releasesListHandler(req, path)
    } else if (path.search(exp1) === 0 || path.search(exp5) === 0 ||
               path.search(exp6) === 0 || path.search(exp3) === 0 ||
               path.search(exp4) === 0 || path.search(exp9) === 0) {
        // github.com releases/archive/info/git-refs/raw/gist/tags/codeload → 混合传输
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        // github.com blob/raw → 转换为 raw 路径走混合传输（不依赖 jsDelivr）
        path = path.replace('/blob/', '/raw/')
        return httpHandler(req, path)
    } else if (path.search(exp10) === 0) {
        // github.com tree 路径 → 文件夹下载（打包为 ZIP）
        return downloadFolderHandler(req, path)
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

// =====================================================================
// Releases 列表页
// =====================================================================

/**
 * HTML 转义，防止 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * 格式化文件大小
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

/**
 * 格式化日期时间
 * @param {string} isoStr - ISO 8601 日期字符串
 * @returns {string}
 */
function formatDate(isoStr) {
    if (!isoStr) return ''
    try {
        const d = new Date(isoStr)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    } catch (e) {
        return isoStr
    }
}

/**
 * 将 Markdown 截断为纯文本摘要
 * @param {string} md - Markdown 文本
 * @param {number} maxLen - 最大长度
 * @returns {string}
 */
function markdownToSummary(md, maxLen = 200) {
    if (!md) return ''
    let text = md
        .replace(/```[\s\S]*?```/g, '[代码块]')
        .replace(/#{1,6}\s/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^\s*[-*+]\s/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
    if (text.length > maxLen) {
        text = text.substring(0, maxLen) + '...'
    }
    return text
}

/**
 * Releases 列表页处理函数
 *
 * 访问 /https://github.com/user/repo/releases 时：
 * 1. 调用 GitHub API 获取该仓库的 Releases 列表
 * 2. 生成 HTML 页面，展示每个 Release 的版本号、时间、摘要、下载链接
 * 3. 下载链接指向代理地址，用户点击后通过本站加速下载
 *
 * @param {Request} req
 * @param {string} path - 匹配 exp11 的路径
 * @returns {Response}
 */
async function releasesListHandler(req, path) {
    const match = path.match(exp11)
    if (!match) {
        return makeRes('Invalid releases URL', 400)
    }
    const [, owner, repoRaw] = match
    const repo = repoRaw.replace(/\.git$/, '')

    // 获取 GitHub Token（与 downloadFolderHandler 一致的优先级）
    const urlObj = new URL(req.url)
    const tokenParam = urlObj.searchParams.get('token')
    const authHeader = req.headers.get('authorization')
    let githubToken = tokenParam || GITHUB_TOKEN
    let authHeaderValue = authHeader
    if (!authHeaderValue && githubToken) {
        authHeaderValue = `token ${githubToken}`
    }

    // 构造 API 请求头（浏览器 UA 避免 WAF 拦截）
    const apiHeaders = {
        'Host': 'api.github.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/vnd.github+json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close',
        'Accept-Encoding': 'identity',
    }
    if (authHeaderValue) {
        apiHeaders['Authorization'] = authHeaderValue
    }

    // 调用 GitHub Releases API
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`
    let apiResult
    try {
        apiResult = await fetchApiJson(apiUrl, apiHeaders)
    } catch (err) {
        return makeRes(`Failed to fetch releases: ${err.message}`, 502)
    }

    if (apiResult.status !== 200) {
        const bodyText = apiResult.bodyText || ''
        if (apiResult.status === 404) {
            return makeRes(`仓库 ${owner}/${repo} 不存在或没有 Releases`, 404)
        }
        if (apiResult.status === 403) {
            const remaining = apiResult.responseHeaders.get('x-ratelimit-remaining')
            return makeRes(
                `GitHub API 速率限制 (403)。剩余: ${remaining || '?'}\n` +
                `可通过 ?token=xxx 传入 Token 提升至 5000次/小时`,
                429
            )
        }
        return makeRes(`GitHub API error: ${apiResult.status}\n${bodyText.substring(0, 300)}`, apiResult.status)
    }

    const releases = apiResult.json || []
    const proxyOrigin = urlObj.origin

    // 生成 HTML 页面
    const html = generateReleasesHtml(owner, repo, releases, proxyOrigin)

    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'access-control-allow-origin': '*',
            'Cache-Control': 'no-cache, no-transform',
        }
    })
}

/**
 * 生成 Releases 列表 HTML 页面
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名
 * @param {Array} releases - GitHub API 返回的 releases 数组
 * @param {string} proxyOrigin - 代理站点 origin（用于拼接下载链接）
 * @returns {string}
 */
function generateReleasesHtml(owner, repo, releases, proxyOrigin) {
    const repoUrl = `${proxyOrigin}/https://github.com/${owner}/${repo}`

    // 构建 Release 卡片
    const cards = releases.map((rel, idx) => {
        const tagName = escapeHtml(rel.tag_name || 'unknown')
        const releaseName = escapeHtml(rel.name || rel.tag_name || '')
        const publishedAt = formatDate(rel.published_at)
        const createdAt = formatDate(rel.created_at)
        const isPrerelease = rel.prerelease
        const isDraft = rel.draft
        const htmlUrl = escapeHtml(rel.html_url || '')
        const summary = escapeHtml(markdownToSummary(rel.body || '', 300))

        // 状态标签
        let badge = ''
        if (isDraft) {
            badge = '<span class="badge badge-draft">Draft</span>'
        } else if (isPrerelease) {
            badge = '<span class="badge badge-pre">Pre-release</span>'
        } else {
            badge = '<span class="badge badge-stable">Latest</span>'
        }

        // Assets 下载链接
        const assets = (rel.assets || []).map(asset => {
            const assetName = escapeHtml(asset.name)
            const assetSize = formatFileSize(asset.size)
            const downloadCount = asset.download_count || 0
            // 下载链接：代理地址 + 原始 GitHub URL
            const downloadUrl = `${proxyOrigin}/${asset.browser_download_url}`
            const ext = assetName.split('.').pop().toLowerCase()
            let icon = '📄'
            if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) icon = '📦'
            else if (['exe', 'msi', 'appimage', 'deb', 'rpm'].includes(ext)) icon = '⚙️'
            else if (['dmg', 'pkg'].includes(ext)) icon = '🍎'
            else if (['apk'].includes(ext)) icon = '📱'
            return `<a href="${downloadUrl}" class="asset-link" title="下载 ${assetName}">
                <span class="asset-icon">${icon}</span>
                <span class="asset-name">${assetName}</span>
                <span class="asset-size">${assetSize}</span>
                <span class="asset-downloads">↓${downloadCount}</span>
            </a>`
        }).join('')

        // Source code 下载链接
        const sourceZipUrl = `${proxyOrigin}/https://github.com/${owner}/${repo}/archive/${rel.tag_name}.zip`
        const sourceTarUrl = `${proxyOrigin}/https://github.com/${owner}/${repo}/archive/${rel.tag_name}.tar.gz`
        const sourceLinks = `
            <a href="${sourceZipUrl}" class="asset-link source-link">
                <span class="asset-icon">📦</span>
                <span class="asset-name">Source code (zip)</span>
            </a>
            <a href="${sourceTarUrl}" class="asset-link source-link">
                <span class="asset-icon">📦</span>
                <span class="asset-name">Source code (tar.gz)</span>
            </a>`

        return `
        <div class="release-card${idx === 0 && !isDraft ? ' release-latest' : ''}">
            <div class="release-header">
                <div class="release-title">
                    <span class="release-tag">${tagName}</span>
                    ${badge}
                </div>
                <div class="release-meta">
                    <span class="release-date" title="发布于 ${publishedAt}">📅 ${publishedAt}</span>
                </div>
            </div>
            ${releaseName && releaseName !== tagName ? `<div class="release-name">${releaseName}</div>` : ''}
            ${summary ? `<div class="release-summary">${summary}</div>` : ''}
            <div class="release-assets">
                ${assets || ''}
                ${sourceLinks}
            </div>
        </div>`
    }).join('\n')

    const emptyState = releases.length === 0
        ? `<div class="empty-state">
            <p>📭 该仓库暂无 Releases</p>
            <a href="${repoUrl}" class="back-link">返回仓库主页</a>
           </div>`
        : ''

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(owner)}/${escapeHtml(repo)} - Releases</title>
<style>
:root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-hover: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --brand: #2f81f7;
    --brand-soft: rgba(47, 129, 247, 0.1);
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --radius: 8px;
    --radius-card: 12px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 20px;
}
.container {
    max-width: 800px;
    margin: 0 auto;
}
.header {
    text-align: center;
    padding: 2rem 1rem 1.5rem;
}
.header h1 {
    font-size: 1.8rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
}
.header h1 a {
    color: var(--brand);
    text-decoration: none;
}
.header h1 a:hover {
    text-decoration: underline;
}
.header .subtitle {
    color: var(--text-muted);
    font-size: 0.9rem;
}
.release-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    padding: 1.5rem;
    margin-bottom: 1rem;
    transition: border-color 0.2s;
}
.release-card:hover {
    border-color: var(--text-muted);
}
.release-latest {
    border-color: var(--green);
}
.release-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.8rem;
}
.release-title {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.release-tag {
    font-size: 1.2rem;
    font-weight: 600;
    font-family: monospace;
}
.badge {
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 500;
}
.badge-stable { background: rgba(63, 185, 80, 0.15); color: var(--green); border: 1px solid rgba(63, 185, 80, 0.3); }
.badge-pre { background: rgba(210, 153, 34, 0.15); color: var(--yellow); border: 1px solid rgba(210, 153, 34, 0.3); }
.badge-draft { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); border: 1px solid var(--border); }
.release-meta { color: var(--text-muted); font-size: 0.85rem; }
.release-name {
    font-size: 1rem;
    font-weight: 500;
    margin-bottom: 0.6rem;
    color: var(--text);
}
.release-summary {
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.6;
    margin-bottom: 1rem;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: hidden;
    position: relative;
}
.release-summary::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 40px;
    background: linear-gradient(transparent, var(--surface));
}
.release-assets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--border);
}
.asset-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    text-decoration: none;
    font-size: 0.85rem;
    transition: all 0.2s;
}
.asset-link:hover {
    background: var(--surface-hover);
    border-color: var(--brand);
    color: var(--brand);
}
.source-link {
    font-style: italic;
    color: var(--text-muted);
}
.asset-icon { font-size: 1rem; }
.asset-name { font-family: monospace; }
.asset-size { color: var(--text-muted); font-size: 0.8rem; }
.asset-downloads { color: var(--text-muted); font-size: 0.75rem; }
.empty-state {
    text-align: center;
    padding: 4rem 1rem;
    color: var(--text-muted);
}
.empty-state p { font-size: 1.2rem; margin-bottom: 1rem; }
.back-link {
    display: inline-block;
    padding: 0.5rem 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--brand);
    text-decoration: none;
    font-size: 0.9rem;
}
.back-link:hover { background: var(--surface-hover); }
.footer {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--text-muted);
    font-size: 0.8rem;
}
.footer a { color: var(--brand); text-decoration: none; }
.footer a:hover { text-decoration: underline; }
@media (max-width: 600px) {
    .release-header { flex-direction: column; align-items: flex-start; }
    .header h1 { font-size: 1.4rem; }
}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1><a href="${repoUrl}">${escapeHtml(owner)}/${escapeHtml(repo)}</a></h1>
        <p class="subtitle">Releases 列表 · 共 ${releases.length} 个版本</p>
    </div>
    ${cards}
    ${emptyState}
    <div class="footer">
        <p>由 <a href="${proxyOrigin}/">GitHub 镜像站</a> 提供加速 · 基于 <a href="https://github.com/Geekertao/CF-Workers-GitHub-Proxy" target="_blank">CF-Workers-GitHub-Proxy</a></p>
    </div>
</div>
</body>
</html>`
}

// =====================================================================
// GitHub API 请求（HTTP/1.1 socket，绕过 fetch() 的 SSL 525）
// =====================================================================

/**
 * 通过 HTTP/1.1 socket 调用 GitHub API 并返回解析后的 JSON
 *
 * 为什么需要专用函数：
 * - fetch() 对 api.github.com 返回 SSL 525 错误
 * - rawHttpRequest 使用 HTTP/1.0，GitHub API 不兼容（返回 403/500）
 * - 本函数使用 HTTP/1.1，完整读取响应，支持 chunked 和 gzip 解码
 *
 * 适用于小响应体（API JSON 响应通常 < 1MB）：
 * - 完整读入内存后解析
 * - 支持 Transfer-Encoding: chunked 解码
 * - 支持 Content-Encoding: gzip 解压（虽然请求 identity，但服务器可能忽略）
 *
 * @param {string} apiUrl - 完整 API URL
 * @param {Object} headers - 请求头键值对
 * @returns {Object} { status, json, responseHeaders, method }
 */
async function fetchApiJson(apiUrl, headers) {
    let currentUrl = apiUrl
    const maxRedirects = 5

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        // 优先尝试 fetch()（某些情况可能不返回 525）
        let result = null
        try {
            const fetchHeaders = new Headers()
            for (const [k, v] of Object.entries(headers)) {
                fetchHeaders.set(k, v)
            }
            const resp = await fetch(currentUrl, { headers: fetchHeaders, redirect: 'manual' })
            if (resp.status !== 525) {
                let bodyText = ''
                let json = null
                try {
                    bodyText = await resp.text()
                    json = JSON.parse(bodyText)
                } catch (e) { /* 非 JSON 响应 */ }

                // 处理重定向
                if (resp.status >= 300 && resp.status < 400) {
                    const location = resp.headers.get('location')
                    if (location && redirectCount < maxRedirects) {
                        currentUrl = new URL(location, currentUrl).href
                        continue
                    }
                }

                return {
                    status: resp.status,
                    json,
                    bodyText,
                    responseHeaders: resp.headers,
                    method: 'fetch',
                }
            }
            // 525 → 回退到 socket
        } catch (e) {
            // fetch 异常 → 回退到 socket
        }

        // 回退到 HTTP/1.1 socket
        const targetUrl = new URL(currentUrl)
        const hostname = targetUrl.hostname
        const port = targetUrl.port || 443
        const path = targetUrl.pathname + targetUrl.search

        const socket = connect(`${hostname}:${port}`, {
            secureTransport: 'on',
            allowHalfOpen: false,
        })

        // 构造 HTTP/1.1 请求
        const writer = socket.writable.getWriter()
        let reqStr = `GET ${path} HTTP/1.1\r\n`
        // 更新 Host 头为当前域名
        const finalHeaders = { ...headers }
        finalHeaders['Host'] = hostname
        if (!finalHeaders['Connection'] && !finalHeaders['connection']) finalHeaders['Connection'] = 'close'
        if (!finalHeaders['Accept-Encoding'] && !finalHeaders['accept-encoding']) finalHeaders['Accept-Encoding'] = 'identity'
        for (const [key, val] of Object.entries(finalHeaders)) {
            reqStr += `${key}: ${val}\r\n`
        }
        reqStr += '\r\n'

        await writer.write(new TextEncoder().encode(reqStr))
        writer.releaseLock()

        // 读取完整响应（API 响应通常较小，可安全读入内存）
        const reader = socket.readable.getReader()
        const chunks = []
        let totalLength = 0

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            totalLength += value.length
        }

        // 合并所有块
        const fullResponse = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
            fullResponse.set(chunk, offset)
            offset += chunk.length
        }

        // 解析响应头
        const headerEnd = findHeaderEnd(fullResponse)
        if (headerEnd === -1) {
            throw new Error('Invalid HTTP response: header end not found')
        }

        const headerText = new TextDecoder().decode(fullResponse.slice(0, headerEnd))
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

        // 处理重定向
        if (status >= 300 && status < 400) {
            const location = responseHeaders['location']
            if (location && redirectCount < maxRedirects) {
                currentUrl = new URL(location, currentUrl).href
                continue
            }
        }

        let bodyBytes = fullResponse.slice(headerEnd + 4)

        // 处理 chunked 编码
        if (responseHeaders['transfer-encoding'] === 'chunked') {
            bodyBytes = dechunkResponse(bodyBytes)
        }

        // 处理 gzip 压缩（虽然请求了 identity，但服务器可能忽略）
        if (responseHeaders['content-encoding'] === 'gzip') {
            const ds = new DecompressionStream('gzip')
            const stream = new Blob([bodyBytes]).stream().pipeThrough(ds)
            bodyBytes = new Uint8Array(await new Response(stream).arrayBuffer())
        }

        // 解析 JSON 和响应体文本
        const bodyText = new TextDecoder().decode(bodyBytes)
        let json = null
        if (status >= 200 && status < 300) {
            try {
                json = JSON.parse(bodyText)
            } catch (e) {
                // JSON 解析失败，返回 null
            }
        }

        // 构造类似 Headers 的对象
        const headersObj = {
            get: (name) => responseHeaders[name.toLowerCase()] || null,
            raw: responseHeaders,
        }

        return {
            status,
            json,
            bodyText,
            responseHeaders: headersObj,
            method: 'socket-http1.1',
        }
    }

    throw new Error(`Too many redirects (> ${maxRedirects})`)
}

/**
 * 解码 HTTP/1.1 chunked Transfer-Encoding
 * @param {Uint8Array} data - chunked 编码的数据
 * @returns {Uint8Array} 解码后的数据
 */
function dechunkResponse(data) {
    const result = []
    let pos = 0
    while (pos < data.length) {
        // 查找 chunk size 行的 CRLF
        const crlfPos = findCRLF(data, pos)
        if (crlfPos === -1) break
        const sizeStr = new TextDecoder().decode(data.slice(pos, crlfPos))
        const chunkSize = parseInt(sizeStr.split(';')[0], 16)
        if (isNaN(chunkSize) || chunkSize === 0) break
        pos = crlfPos + 2 // 跳过 CRLF
        if (pos + chunkSize > data.length) break
        // 提取 chunk 数据
        result.push(data.slice(pos, pos + chunkSize))
        pos += chunkSize + 2 // 跳过数据和 CRLF
    }
    // 合并所有 chunk
    let totalLen = 0
    for (const chunk of result) {
        totalLen += chunk.length
    }
    const merged = new Uint8Array(totalLen)
    let off = 0
    for (const chunk of result) {
        merged.set(chunk, off)
        off += chunk.length
    }
    return merged
}

// =====================================================================
// 文件夹下载：GitHub tree 路径 → 流式 ZIP
// =====================================================================

/**
 * CRC-32 查找表（多项式 0xEDB88320，IEEE 802.3 标准）
 * 用于 ZIP 文件格式的 CRC-32 校验
 */
const CRC32_TABLE = new Uint32Array(256)
;(() => {
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        }
        CRC32_TABLE[n] = c
    }
})()

/**
 * 生成 ZIP Local File Header
 * 使用 Data Descriptor（bit 3 标志）和 UTF-8 文件名（bit 11 标志）
 * CRC 和 size 在 Data Descriptor 中提供，header 中填 0
 *
 * @param {string} filename - ZIP 内的文件路径（UTF-8）
 * @returns {Uint8Array} Local File Header 字节
 */
function makeLocalFileHeader(filename) {
    const nameBytes = new TextEncoder().encode(filename)
    const header = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(header.buffer)

    dv.setUint32(0, 0x04034b50, true)        // 签名 PK\x03\x04
    dv.setUint16(4, 20, true)                 // 解压所需版本 2.0
    dv.setUint16(6, 0x0808, true)             // 标志：bit3=DataDescriptor, bit11=UTF-8
    dv.setUint16(8, 0, true)                  // 压缩方法：0=Store
    dv.setUint16(10, 0, true)                 // 最后修改时间
    dv.setUint16(12, 0x0021, true)            // 最后修改日期（1980-01-01）
    dv.setUint32(14, 0, true)                 // CRC-32（在 Data Descriptor 中）
    dv.setUint32(18, 0, true)                 // 压缩后大小（在 DD 中）
    dv.setUint32(22, 0, true)                 // 原始大小（在 DD 中）
    dv.setUint16(26, nameBytes.length, true)  // 文件名长度
    dv.setUint16(28, 0, true)                 // extra 字段长度
    header.set(nameBytes, 30)

    return header
}

/**
 * 生成 ZIP Data Descriptor
 * 在文件数据之后写入，包含 CRC-32 和实际大小
 *
 * @param {number} crc - CRC-32 值
 * @param {number} size - 文件大小（Store 方法：压缩后大小 = 原始大小）
 * @returns {Uint8Array} Data Descriptor 字节
 */
function makeDataDescriptor(crc, size) {
    const dd = new Uint8Array(16)
    const dv = new DataView(dd.buffer)

    dv.setUint32(0, 0x08074b50, true)  // 签名（可选但推荐）
    dv.setUint32(4, crc, true)          // CRC-32
    dv.setUint32(8, size, true)         // 压缩后大小
    dv.setUint32(12, size, true)        // 原始大小

    return dd
}

/**
 * 生成 ZIP Central Directory Header
 *
 * @param {string} filename - ZIP 内的文件路径
 * @param {number} crc - CRC-32 值
 * @param {number} size - 文件大小
 * @param {number} localHeaderOffset - 对应 Local File Header 的偏移
 * @returns {Uint8Array} Central Directory Header 字节
 */
function makeCentralDirHeader(filename, crc, size, localHeaderOffset) {
    const nameBytes = new TextEncoder().encode(filename)
    const header = new Uint8Array(46 + nameBytes.length)
    const dv = new DataView(header.buffer)

    dv.setUint32(0, 0x02014b50, true)        // 签名 PK\x01\x02
    dv.setUint16(4, 20, true)                 // 制作版本
    dv.setUint16(6, 20, true)                 // 解压所需版本
    dv.setUint16(8, 0x0808, true)             // 标志：bit3+bit11
    dv.setUint16(10, 0, true)                 // 压缩方法：Store
    dv.setUint16(12, 0, true)                 // 最后修改时间
    dv.setUint16(14, 0x0021, true)            // 最后修改日期
    dv.setUint32(16, crc, true)               // CRC-32
    dv.setUint32(20, size, true)              // 压缩后大小
    dv.setUint32(24, size, true)              // 原始大小
    dv.setUint16(28, nameBytes.length, true)  // 文件名长度
    dv.setUint16(30, 0, true)                 // extra 字段长度
    dv.setUint16(32, 0, true)                 // 文件注释长度
    dv.setUint16(34, 0, true)                 // 起始磁盘号
    dv.setUint16(36, 0, true)                 // 内部文件属性
    dv.setUint32(38, 0, true)                 // 外部文件属性
    dv.setUint32(42, localHeaderOffset, true) // 本地文件头相对偏移
    header.set(nameBytes, 46)

    return header
}

/**
 * 生成 ZIP End of Central Directory Record
 *
 * @param {number} entryCount - 文件条目数
 * @param {number} cdSize - Central Directory 总大小
 * @param {number} cdOffset - Central Directory 起始偏移
 * @returns {Uint8Array} EOCD 字节
 */
function makeEOCD(entryCount, cdSize, cdOffset) {
    const eocd = new Uint8Array(22)
    const dv = new DataView(eocd.buffer)

    dv.setUint32(0, 0x06054b50, true)    // 签名 PK\x05\x06
    dv.setUint16(4, 0, true)              // 当前磁盘号
    dv.setUint16(6, 0, true)              // 中央目录起始磁盘号
    dv.setUint16(8, entryCount, true)     // 本磁盘 CD 记录数
    dv.setUint16(10, entryCount, true)    // CD 记录总数
    dv.setUint32(12, cdSize, true)        // CD 大小
    dv.setUint32(16, cdOffset, true)      // CD 起始偏移
    dv.setUint16(20, 0, true)             // 注释长度

    return eocd
}

/**
 * 文件夹下载处理器
 *
 * 解析 github.com tree URL，调用 Git Trees API 获取文件列表，
 * 流式生成 ZIP 返回给客户端。
 *
 * URL 格式：/https://github.com/{owner}/{repo}/tree/{branch}/{folder}
 *
 * 流程：
 * 1. 解析 URL 提取 owner/repo/branch/folder
 * 2. 调用 Git Trees API（recursive=1）获取整个仓库文件树
 * 3. 过滤出指定文件夹下的所有文件
 * 4. 流式生成 ZIP：
 *    - 对每个文件，通过 raw.githubusercontent.com 下载
 *    - 边下载边计算 CRC-32，直接写入 ZIP 输出流
 *    - 使用 Data Descriptor 模式，无需 seek 回写
 * 5. 写入 Central Directory 和 EOCD 完成 ZIP
 *
 * @param {Request} req - 原始请求
 * @param {string} path - 匹配的路径
 * @returns {Response} ZIP 文件流式响应
 */
async function downloadFolderHandler(req, path) {
    // 解析 URL
    const match = path.match(exp10)
    if (!match) {
        return makeRes('Invalid folder URL', 400)
    }
    const [, owner, repo, branch, folderPath] = match
    const cleanFolder = folderPath.replace(/\/+$/, '').replace(/^\/+/, '')

    // 获取 GitHub Token（优先级：URL 参数 > Authorization 头 > 全局配置）
    const urlObj = new URL(req.url)
    const tokenParam = urlObj.searchParams.get('token')
    const authHeader = req.headers.get('authorization')
    let githubToken = tokenParam || GITHUB_TOKEN
    let authHeaderValue = authHeader
    if (!authHeaderValue && githubToken) {
        authHeaderValue = `token ${githubToken}`
    }

    // 构造 Git Trees API URL
    const treeApiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`

    // 构造 API 请求头（使用浏览器 UA 避免 GitHub WAF 拦截）
    const apiHeaders = {
        'Host': 'api.github.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/vnd.github+json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close',
        'Accept-Encoding': 'identity',
    }
    if (authHeaderValue) {
        apiHeaders['Authorization'] = authHeaderValue
    }

    // 调用 Git Trees API（使用 HTTP/1.1 socket，绕过 fetch() 的 SSL 525）
    let apiResult
    try {
        apiResult = await fetchApiJson(treeApiUrl, apiHeaders)
    } catch (err) {
        return makeRes(`Failed to fetch tree: ${err.message}`, 502)
    }

    if (apiResult.status !== 200) {
        const bodyText = apiResult.bodyText || (apiResult.json ? JSON.stringify(apiResult.json) : '(no response body)')
        if (apiResult.status === 403) {
            const remaining = apiResult.responseHeaders.get('x-ratelimit-remaining')
            const limit = apiResult.responseHeaders.get('x-ratelimit-limit')
            // 输出所有响应头用于诊断
            const rawHeaders = apiResult.responseHeaders.raw || {}
            const headerDump = Object.entries(rawHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
            return makeRes(
                `GitHub API rate limit (403). Method: ${apiResult.method}\n` +
                `Rate: ${remaining || '?'}/${limit || '?'} (remaining/limit)\n` +
                `Auth: ${authHeaderValue ? 'yes' : 'no'}\n` +
                `To increase to 5000/hour, set GITHUB_TOKEN, pass ?token=xxx, ` +
                `or send Authorization header.\n\n` +
                `Response headers:\n${headerDump}\n\n` +
                `Response body: ${bodyText.substring(0, 500)}`,
                429
            )
        }
        // 诊断其他错误状态（包含完整响应头）
        const rawHeaders = apiResult.responseHeaders.raw || {}
        const headerDump = Object.entries(rawHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
        return makeRes(
            `GitHub API error (${apiResult.method}): ${apiResult.status}\n` +
            `Response headers:\n${headerDump}\n\n` +
            `Response body: ${bodyText.substring(0, 500)}`,
            apiResult.status
        )
    }

    const treeData = apiResult.json
    if (!treeData) {
        return makeRes('Failed to parse tree response', 502)
    }

    // 检查是否截断
    if (treeData.truncated) {
        return makeRes('Repository too large: tree API returned truncated results. Please use git clone instead.', 501)
    }

    // 过滤出指定文件夹下的文件（type=blob）
    const prefix = cleanFolder ? cleanFolder + '/' : ''
    const files = (treeData.tree || []).filter(item =>
        item.type === 'blob' &&
        (cleanFolder === '' || item.path.startsWith(prefix))
    )

    if (files.length === 0) {
        return makeRes(`Folder '${cleanFolder || '/'}' is empty or does not exist in ${owner}/${repo}:${branch}`, 404)
    }

    // 文件夹名（用于 ZIP 文件名）
    const folderName = cleanFolder ? cleanFolder.split('/').pop() : repo
    const zipFileName = `${folderName}.zip`

    // 流式生成 ZIP
    const { readable, writable } = new IdentityTransformStream()
    const writer = writable.getWriter()

    // 异步生成 ZIP（不 await，让 Response 立即返回开始流式传输）
    ;(async () => {
        const centralDir = []
        let offset = 0
        let fileIndex = 0

        try {
            for (const file of files) {
                // ZIP 内文件路径：去掉文件夹前缀，保留相对路径
                const relativePath = cleanFolder
                    ? file.path.substring(prefix.length)
                    : file.path

                // 写 Local File Header
                const localHeader = makeLocalFileHeader(relativePath)
                await writer.write(localHeader)
                const localHeaderSize = localHeader.length

                // 下载文件内容并计算 CRC-32
                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`
                const fetchHeaders = new Headers({ 'User-Agent': 'git/2.39.0' })
                if (authHeaderValue) {
                    fetchHeaders.set('Authorization', authHeaderValue)
                }

                let crc = 0xFFFFFFFF
                let dataSize = 0

                try {
                    const fileResponse = await fetch(rawUrl, { headers: fetchHeaders })
                    if (fileResponse.ok && fileResponse.body) {
                        const reader = fileResponse.body.getReader()
                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            if (value && value.length > 0) {
                                // 分块更新 CRC-32
                                for (let i = 0; i < value.length; i++) {
                                    crc = CRC32_TABLE[(crc ^ value[i]) & 0xFF] ^ (crc >>> 8)
                                }
                                dataSize += value.length
                                await writer.write(value)
                            }
                        }
                    } else if (fileResponse.ok) {
                        // 无 body 流，用 arrayBuffer 读取
                        const buf = await fileResponse.arrayBuffer()
                        const arr = new Uint8Array(buf)
                        for (let i = 0; i < arr.length; i++) {
                            crc = CRC32_TABLE[(crc ^ arr[i]) & 0xFF] ^ (crc >>> 8)
                        }
                        dataSize = arr.length
                        await writer.write(arr)
                    } else {
                        // 文件下载失败，写入空内容（ZIP 仍可解压其他文件）
                        console.log(JSON.stringify({
                            step: 'folder_download_file_failed',
                            file: file.path,
                            status: fileResponse.status,
                        }))
                    }
                } catch (fileErr) {
                    console.log(JSON.stringify({
                        step: 'folder_download_file_error',
                        file: file.path,
                        error: String(fileErr),
                    }))
                }

                crc = (crc ^ 0xFFFFFFFF) >>> 0

                // 写 Data Descriptor
                const dd = makeDataDescriptor(crc, dataSize)
                await writer.write(dd)

                // 记录 Central Directory 信息
                centralDir.push({
                    name: relativePath,
                    crc,
                    size: dataSize,
                    offset
                })

                offset += localHeaderSize + dataSize + dd.length
                fileIndex++
            }

            // 写 Central Directory
            const cdOffset = offset
            let cdSize = 0
            for (const entry of centralDir) {
                const cdHeader = makeCentralDirHeader(entry.name, entry.crc, entry.size, entry.offset)
                await writer.write(cdHeader)
                cdSize += cdHeader.length
            }

            // 写 EOCD
            const eocd = makeEOCD(centralDir.length, cdSize, cdOffset)
            await writer.write(eocd)

            await writer.close()

            console.log(JSON.stringify({
                step: 'folder_download_complete',
                owner, repo, branch, folder: cleanFolder,
                fileCount: centralDir.length,
                totalSize: offset + cdSize + eocd.length,
            }))
        } catch (err) {
            console.log(JSON.stringify({
                step: 'folder_download_error',
                error: String(err),
                filesProcessed: fileIndex,
            }))
            try { await writer.abort(err) } catch (e) {}
        }
    })()

    return new Response(readable, {
        status: 200,
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${zipFileName}"`,
            'access-control-allow-origin': '*',
            'access-control-expose-headers': '*',
            'Content-Encoding': 'identity',
            'Cache-Control': 'no-cache, no-transform',
        }
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
