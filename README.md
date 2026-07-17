# CF-Workers-GitHub-Proxy

基于 Cloudflare Workers 的 **GitHub 全功能镜像站**，使用 `cloudflare:sockets` `connect()` API 绕过 Worker `fetch()` 的 SSL 525 错误，支持 Git clone / push 等全功能。

## 桌面端预览
![desktop](src/desktop.png)
## 移动端预览
![mobile](src/mobile.png)

## 简介

GitHub release、archive、raw 文件、API 加速项目，**完整支持 git clone / push**，基于 Cloudflare Workers 实现。

### 核心技术

| 技术 | 用途 |
|------|------|
| `cloudflare:sockets` `connect()` | 绕过 Worker `fetch()` 对 github.com 的 SSL 525 错误 |
| `fetch()` | 处理不受 525 影响的域名（`*.githubusercontent.com`），支持流式传输大文件 |
| 混合传输 | 自动根据目标域名选择 socket 或 fetch，跟随重定向时自动切换 |
| HTTP/1.0 协议 | 避免 chunked 编码，简化响应处理，降低 CPU 消耗 |
| `IdentityTransformStream` + `pipeTo` | 运行时原生优化的流式传输，支持 170MB+ 大仓库完整克隆 |
| `Content-Encoding: identity` | 阻止 Cloudflare 边缘代理自动压缩，避免大文件缓冲溢出 |
| `DecompressionStream('gzip')` | 解压 git 客户端 gzip 压缩的 POST 请求体（HTTP/1.0 不支持 Content-Encoding） |

### 支持功能

- ✅ GitHub Release 下载
- ✅ Archive 下载（分支/标签源码包）
- ✅ Git clone（通过 HTTP 智能协议，支持 170MB+ 大仓库完整克隆）
- ✅ Git push（通过 `http.extraHeader` 认证）
- ✅ API 访问（api.github.com）
- ✅ Raw 文件（raw.githubusercontent.com）
- ✅ Gist（gist.githubusercontent.com）
- ✅ Codeload（codeload.github.com）
- ✅ 大文件流式传输（githubusercontent.com 走 fetch）
- ✅ POST 请求体转发（git-upload-pack / git-receive-pack）

### 性能测试

| 测试项 | 仓库大小 | 耗时 | 结果 |
|--------|----------|------|------|
| 浅克隆 (--depth 1) | 740K | ~3s | ✅ |
| 完整克隆 (media-on-terminal) | 174M | 79s | ✅ |
| 完整克隆 (workers-sdk) | 191M | 27s | ✅ |
| Archive 下载 | 112K | <1s | ✅ |
| Raw 文件下载 | 52K | <1s | ✅ |
| API 访问 | - | <1s | ✅ |

## 使用方法

### 基本用法

在 GitHub URL 前加上镜像站地址即可：

```
https://your-domain.com/https://github.com/user/repo/releases/download/v1.0/file.zip
```

### Git Clone

```bash
git clone https://your-domain.com/https://github.com/user/repo.git
```

### Git Push

Git push 需要通过 `http.extraHeader` 传递认证信息：

```bash
# 生成 Base64 认证串
AUTH=$(echo -n "username:TOKEN" | base64)

# 使用 extraHeader 推送
git -c http.extraHeader="Authorization: Basic $AUTH" push origin main
```

### 私有仓库 Clone

```bash
git clone https://user:TOKEN@your-domain.com/https://github.com/user/repo.git
```

### 合法输入示例

以下都是合法输入（仅示例，文件不存在）：

- 分支源码：`https://github.com/hunshcn/project/archive/master.zip`
- release源码：`https://github.com/hunshcn/project/archive/v0.1.0.tar.gz`
- release文件：`https://github.com/hunshcn/project/releases/download/v0.1.0/example.zip`
- 分支文件：`https://github.com/hunshcn/project/blob/master/filename`
- commit文件：`https://github.com/hunshcn/project/blob/1111111111111111111111111111/filename`
- gist：`https://gist.githubusercontent.com/cielpy/351557e6e465c12986419ac5a4dd2568/raw/cmd.py`
- api：`https://api.github.com/repos/Geekertao/CF-Workers-GitHub-Proxy`
- codeload：`https://codeload.github.com/hunshcn/project/zip/refs/heads/master`

## 部署方法

### 方法一：Wrangler 命令行部署（推荐）

```bash
# 安装 wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 部署
wrangler deploy workers.js --name gh --compatibility-date 2026-07-17
```

### 方法二：Cloudflare Dashboard 部署

1. 在 Cloudflare Worker 控制台中创建一个新的 Worker
2. 将 [workers.js](./workers.js) 的内容粘贴到 Worker 编辑器中
3. 保存并部署
4. 绑定自定义域名（推荐，避免 workers.dev SSL 问题）

### 方法三：Snippets 部署

1. 确认已开通 Snippets 功能（需 Pro 以上计划）
2. 在 Snippets 平台中创建一个新的 Snippet
3. 将 [snippets.js](./snippets.js) 的内容粘贴到 Snippet 编辑器中
4. 添加片段规则，自定义筛选表达式：
   ```
   (http.host eq "your-domain.com")
   ```
5. 保存并部署

> **注意**：Snippets 部署需确认是否支持 `cloudflare:sockets` 模块。如不支持，建议使用 Workers 部署方式。

## 诊断端点

部署后可通过以下端点诊断连通性：

- `https://your-domain.com/__diag__` - 测试各 GitHub 域名的 fetch() 和 socket 连通性
- `https://your-domain.com/__socket_test__` - 测试 connect() API 对各 GitHub 域名的连通性

## 配置说明

在 `workers.js` 顶部修改以下配置：

```javascript
// 静态资源地址（404 页面、sw.js、conf.js）
const ASSET_URL = 'https://geekertao.github.io/gh-proxy/'
// 路由前缀
const PREFIX = '/'
// jsDelivr 镜像开关（1=开启 blob 文件走 jsDelivr，0=关闭）
const Config = { jsdelivr: 0 }
// 白名单（路径中包含指定字符才通过，空数组=不限制）
const whiteList = []
```

## 架构说明

```
用户请求 → Cloudflare Worker (workers.js)
                ├── github.com / api.github.com / codeload.github.com
                │   └── connect() TLS socket（绕过 SSL 525）
                │       └── HTTP/1.0 + IdentityTransformStream + pipeTo
                └── *.githubusercontent.com
                    └── fetch()（流式传输，支持大文件）
```

### 关键技术细节

**HTTP/1.0 协议选择**：
- HTTP/1.0 不支持 chunked Transfer-Encoding，简化了响应处理
- 服务端通过 Connection: close 标识响应结束
- 避免 de-chunking 操作消耗 CPU 时间（免费计划限制 10ms）

**IdentityTransformStream + pipeTo 流式传输**：
- 使用 Cloudflare 运行时原生的 `IdentityTransformStream`（无操作 TransformStream）
- `pipeTo` 由运行时内部处理，无 JavaScript 回调开销
- 自动处理背压和流量控制
- 支持 170MB+ 大仓库完整克隆，CPU 时间 < 1ms

**请求体 gzip 解压**：
- git 客户端可能对 POST 请求体做 gzip 压缩（Content-Encoding: gzip）
- HTTP/1.0 不支持 Content-Encoding，Worker 端使用 `DecompressionStream('gzip')` 解压
- 解压后移除 Content-Encoding 头，更新 Content-Length

**阻止 Cloudflare 自动压缩**：
- 响应头设置 `Content-Encoding: identity`，阻止边缘代理自动 gzip 压缩
- 自动压缩会缓冲整个响应体，对大文件（>128MB）导致内存溢出和流截断
- 设置 `Cache-Control: no-cache, no-transform` 阻止任何中间转换

### 域名分类

| 域名 | 传输方式 | 原因 |
|------|----------|------|
| github.com | socket (connect) | fetch() 存在 SSL 525 错误 |
| api.github.com | socket (connect) | fetch() 存在 SSL 525 错误 |
| codeload.github.com | socket (connect) | fetch() 存在 SSL 525 错误 |
| gist.github.com | socket (connect) | fetch() 存在 SSL 525 错误 |
| *.githubusercontent.com | fetch | 不受 525 影响，支持流式传输 |
| *.githubassets.com | fetch | 不受 525 影响 |
| *.github.io | fetch | 不受 525 影响 |

## 项目文件说明

- **`workers.js`**：主 Worker 代码，基于 [gh-proxy](https://github.com/hunshcn/gh-proxy) 修改，使用 `cloudflare:sockets` 绕过 SSL 525
- **`snippets.js`**：Snippets 部署版本，代码与 workers.js 一致
- **`wrangler.toml`**：Wrangler 部署配置文件
- **`backend.js`**：已废弃（原双 Worker 架构的后端，已合并到 workers.js）

## 致谢

[gh-proxy](https://github.com/hunshcn/gh-proxy)、[jsproxy](https://github.com/EtherDream/jsproxy/)、[CF-Workers-GitHub](https://github.com/cmliu/CF-Workers-GitHub/)

## 赞助
<a href="https://afdian.com/a/Geekertao" target="_blank" rel="noopener noreferrer" style="flex-shrink: 0;">
      <img src="https://img.shields.io/badge/💵_爱发电-FF4D4D?style=flat-square&logo=usd&logoColor=white" alt="爱发电" style="max-height: 50px;">
    </a>
