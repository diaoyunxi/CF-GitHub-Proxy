'use strict'

/**
 * CF-Workers-GitHub-Proxy
 * 基于 Cloudflare Workers 的 GitHub 加速代理
 * 修复 SSL 525 错误：手动处理重定向 + 清理请求头 + cf 缓存选项
 */

/**
 * static files (404.html, sw.js, conf.js)
 */
const ASSET_URL = 'https://geekertao.github.io/gh-proxy/'
// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
const PREFIX = '/'
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
    jsdelivr: 0
}

const whiteList = [] // 白名单，路径里面有包含字符的才会通过，e.g. ['/username/']

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}


const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i
// GitHub release 文件下载重定向目标域名
const exp8 = /^(?:https?:\/\/)?objects\.githubusercontent\.com\/.*$/i
const exp9 = /^(?:https?:\/\/)?codeload\.github\.com\/.*$/i
// GitHub general 下载域名
const exp10 = /^(?:https?:\/\/)?(?:.+?\.)?github\.com\/.+?\/releases\/download\/.+$/i

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, {status, headers})
}


/**
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


addEventListener('fetch', e => {
    const ret = fetchHandler(e)
        .catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    e.respondWith(ret)
})


function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8, exp9, exp10]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * @param {FetchEvent} e
 */
async function fetchHandler(e) {
    const req = e.request
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.substr(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')
    if (path.search(exp7) === 0) {
        return httpHandler(req, path)
    } else if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0 || path.search(exp4) === 0) {
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path)
        }
    } else if (path.search(exp4) === 0) {
        const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
        return Response.redirect(newUrl, 302)
    } else {
        return fetch(ASSET_URL + path)
    }
}


/**
 * 构建干净的请求头，只保留必要的头部信息
 * 移除可能导致 SSL 握手失败的 Cloudflare 内部头部
 * @param {Headers} reqHdrRaw
 * @returns {Headers}
 */
function buildCleanHeaders(reqHdrRaw) {
    const reqHdrNew = new Headers()
    // 只保留必要的请求头
    const keepHeaders = ['accept', 'accept-encoding', 'accept-language', 'user-agent', 'range', 'if-modified-since', 'if-none-match']
    for (const key of keepHeaders) {
        const val = reqHdrRaw.get(key)
        if (val) {
            reqHdrNew.set(key, val)
        }
    }
    return reqHdrNew
}


/**
 * @param {Request} req
 * @param {string} pathname
 */
function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    let urlStr = pathname
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
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)

    // 构建干净的请求头，避免 SSL 握手问题
    const reqHdrNew = buildCleanHeaders(reqHdrRaw)

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        // 使用 manual 模式手动处理重定向，确保每个重定向目标使用干净连接
        redirect: 'manual',
        body: req.body
    }
    return proxy(urlObj, reqInit, 0)
}


/**
 * 递归代理函数，手动跟随重定向
 * 每次重定向使用全新的干净请求头，避免 SSL 握手失败
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 * @param {number} redirectCount
 * @param {number} maxRedirects
 */
async function proxy(urlObj, reqInit, redirectCount = 0, maxRedirects = 10) {
    if (!urlObj) {
        return makeRes('Invalid URL', 400)
    }
    if (redirectCount >= maxRedirects) {
        return makeRes('Too many redirects', 502)
    }

    try {
        const res = await fetch(urlObj.href, reqInit)
        const resHdrNew = new Headers(res.headers)
        const status = res.status

        // 处理重定向（3xx）
        if (status >= 300 && status < 400 && resHdrNew.has('location')) {
            let location = resHdrNew.get('location')
            // 将相对路径转换为绝对路径
            const newUrlObj = newUrl(location)
            if (!newUrlObj) {
                // 相对路径
                const absoluteUrl = new URL(location, urlObj.href)
                location = absoluteUrl.href
            } else {
                location = newUrlObj.href
            }

            // 递归处理重定向，使用全新的干净请求头
            const cleanHeaders = buildCleanHeaders(reqInit.headers instanceof Headers ? reqInit.headers : new Headers())
            const newReqInit = {
                method: reqInit.method === 'HEAD' ? 'HEAD' : 'GET', // 重定向通常用 GET
                headers: cleanHeaders,
                redirect: 'manual',
            }
            return proxy(newUrl(location), newReqInit, redirectCount + 1, maxRedirects)
        }

        resHdrNew.set('access-control-expose-headers', '*')
        resHdrNew.set('access-control-allow-origin', '*')

        resHdrNew.delete('content-security-policy')
        resHdrNew.delete('content-security-policy-report-only')
        resHdrNew.delete('clear-site-data')

        return new Response(res.body, {
            status,
            headers: resHdrNew,
        })
    } catch (err) {
        return makeRes('proxy error: ' + err.message + '\nURL: ' + urlObj.href, 502)
    }
}
