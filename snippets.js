'use strict'

/**
 * CF-Workers-GitHub-Proxy (Snippets 版本)
 * 修复 SSL 525 错误：通过 workers.dev 中继 github.com 请求
 */

const ASSET_URL = 'https://geekertao.github.io/gh-proxy/'
const PREFIX = '/'

const Config = {
    jsdelivr: 0
}

const whiteList = []

/**
 * workers.dev 中继域名（Cloudflare 官方分配，非第三方镜像）
 */
const WORKERS_DEV_HOST = 'gh.diaoyunxi3878.workers.dev'

/**
 * 受 525 SSL 错误影响的 GitHub 域名
 */
const GITHUB_525_PATTERN = /^https:\/\/(?:github\.com|api\.github\.com|codeload\.github\.com)\//i

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
const exp8 = /^(?:https?:\/\/)?objects\.githubusercontent\.com\/.*$/i
const exp9 = /^(?:https?:\/\/)?codeload\.github\.com\/.*$/i

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
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7, exp8, exp9]) {
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

    // 诊断端点
    if (urlObj.pathname === '/__diag__') {
        return diagnosticsHandler(urlObj.hostname)
    }

    path = urlObj.href
        .substr(urlObj.origin.length + PREFIX.length)
        .replace(/^https?:\/+/, 'https://')

    // 判断当前是否在 workers.dev 域名上
    const isWorkersDev = urlObj.hostname.endsWith('.workers.dev')

    // 中继逻辑：如果在自定义域名上，且请求目标受 525 影响，转发到 workers.dev
    if (!isWorkersDev && GITHUB_525_PATTERN.test(path)) {
        return relayToWorkersDev(path, req)
    }

    // 以下为直接处理逻辑（workers.dev 上或请求目标不受 525 影响的域名）
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

/**
 * 中继到 workers.dev
 * 自定义域名 → workers.dev → GitHub
 * @param {string} path - 请求路径（含目标 URL）
 * @param {Request} req - 原始请求
 */
async function relayToWorkersDev(path, req) {
    const relayUrl = `https://${WORKERS_DEV_HOST}/${path}`
    const cleanHeaders = buildCleanHeaders(req.headers)

    try {
        const res = await fetch(relayUrl, {
            method: req.method,
            headers: cleanHeaders,
            redirect: 'manual',
        })
        const resHdrNew = new Headers(res.headers)

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
            status: res.status,
            headers: resHdrNew,
        })
    } catch (err) {
        return makeRes('relay error: ' + err.message + '\nURL: ' + relayUrl, 502)
    }
}

/**
 * 诊断函数
 * @param {string} hostname
 */
async function diagnosticsHandler(hostname) {
    const isWorkersDev = hostname.endsWith('.workers.dev')
    const testUrls = [
        'https://github.com',
        'https://api.github.com',
        'https://codeload.github.com',
        'https://raw.githubusercontent.com',
        'https://objects.githubusercontent.com',
        'https://raw.githubusercontent.com/diaoyunxi/CF-GitHub-Proxy/main/README.md',
    ]
    if (!isWorkersDev) {
        testUrls.push(`https://${WORKERS_DEV_HOST}/`)
    }
    const results = [{ hostname, isWorkersDev }]
    for (const url of testUrls) {
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'user-agent': 'Mozilla/5.0' },
                redirect: 'manual',
            })
            results.push({ url, status: res.status, ok: res.ok })
        } catch (err) {
            results.push({ url, status: 'error', error: err.message })
        }
    }
    return new Response(JSON.stringify(results, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
    })
}

function buildCleanHeaders(reqHdrRaw) {
    const reqHdrNew = new Headers()
    const keepHeaders = ['accept', 'accept-encoding', 'accept-language', 'user-agent', 'range', 'if-modified-since', 'if-none-match']
    for (const key of keepHeaders) {
        const val = reqHdrRaw.get(key)
        if (val) {
            reqHdrNew.set(key, val)
        }
    }
    return reqHdrNew
}

function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

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
        return new Response("blocked", { status: 403 })
    }

    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }

    const urlObj = newUrl(urlStr)
    const reqHdrNew = buildCleanHeaders(reqHdrRaw)

    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }

    return proxy(urlObj, reqInit, 0)
}

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

        if (status >= 300 && status < 400 && resHdrNew.has('location')) {
            let location = resHdrNew.get('location')
            const newUrlObj = newUrl(location)
            if (!newUrlObj) {
                const absoluteUrl = new URL(location, urlObj.href)
                location = absoluteUrl.href
            } else {
                location = newUrlObj.href
            }

            const cleanHeaders = buildCleanHeaders(reqInit.headers instanceof Headers ? reqInit.headers : new Headers())
            const newReqInit = {
                method: reqInit.method === 'HEAD' ? 'HEAD' : 'GET',
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
