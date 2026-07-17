'use strict'

const ASSET_URL = 'https://geekertao.github.io/gh-proxy/'
const PREFIX = '/'

const Config = {
    jsdelivr: 0
}

const whiteList = []

const PREFLIGHT_INIT = {
    status: 204,
    headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    },
}

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i
// 新增: GitHub release 文件下载重定向目标域名
const exp8 = /^(?:https?:\/\/)?objects\.githubusercontent\.com\/.*$/i
const exp9 = /^(?:https?:\/\/)?codeload\.github\.com\/.*$/i
// 新增: GitHub general 下载域名
const exp10 = /^(?:https?:\/\/)?(?:.+?\.)?github\.com\/.+?\/releases\/download\/.+$/i

function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, { status, headers })
}

function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch {
        return null
    }
}

function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8, exp9, exp10]) {
        if (u.search(i) === 0) return true
    }
    return false
}

/**
 * ✅ Snippet 入口（ES Module）
 */
export default {
    async fetch(request, env, ctx) {
        try {
            return await fetchHandler(request)
        } catch (err) {
            return makeRes("cfworker error:\n" + err.stack, 502)
        }
    }
}

async function fetchHandler(req) {
    const urlObj = new URL(req.url)
    let path = urlObj.searchParams.get('q')

    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }

    path = urlObj.href
        .substr(urlObj.origin.length + PREFIX.length)
        .replace(/^https?:\/+/, 'https://')

    if (path.search(exp7) === 0) {
        return httpHandler(req, path)
    } else if (
        path.search(exp1) === 0 ||
        path.search(exp5) === 0 ||
        path.search(exp6) === 0 ||
        path.search(exp3) === 0 ||
        path.search(exp4) === 0
    ) {
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path
                .replace('/blob/', '@')
                .replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path)
        }
    } else if (path.search(exp4) === 0) {
        const newUrl = path
            .replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1')
            .replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
        return Response.redirect(newUrl, 302)
    } else {
        return fetch(ASSET_URL + path)
    }
}

function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(whiteList.length)

    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }

    if (!flag) {
        return new Response("blocked", { status: 403 })
    }

    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }

    const urlObj = newUrl(urlStr)

    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        // 使用 follow 模式让 Cloudflare fetch 直接处理重定向，避免 SSL 525 错误
        redirect: 'follow',
        body: req.body
    }

    return proxy(urlObj, reqInit)
}

async function proxy(urlObj, reqInit) {
    // 清理可能导致 SSL 握手问题的 Cloudflare 内部头
    if (reqInit.headers instanceof Headers) {
        reqInit.headers.delete('cf-connecting-ip')
        reqInit.headers.delete('cf-ray')
        reqInit.headers.delete('cf-visitor')
        reqInit.headers.delete('cf-ipcountry')
    }

    try {
        const res = await fetch(urlObj.href, reqInit)

        const resHdrNew = new Headers(res.headers)
        const status = res.status

        // 处理重定向（当 redirect: 'follow' 未生效时的兜底）
        if (resHdrNew.has('location')) {
            let loc = resHdrNew.get('location')
            if (checkUrl(loc)) {
                resHdrNew.set('location', PREFIX + loc)
            }
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
        // 捕获 SSL 和网络错误，返回有意义的错误信息
        return makeRes('proxy error: ' + err.message + '\nURL: ' + urlObj.href, 502)
    }
}
