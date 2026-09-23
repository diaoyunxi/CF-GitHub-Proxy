# 贡献指南

感谢你对 CF-GitHub-Proxy 项目的关注！这是一个基于 Cloudflare Workers 的 GitHub 代理。

## 开发环境

- **运行时：** Cloudflare Workers
- **语言：** JavaScript（ESM）
- **部署：** Wrangler CLI

## 本地开发

```bash
npx wrangler dev
```

## 安全注意事项

本项目作为代理服务处理网络流量，修改时请特别注意：

- Token URL 参数的安全处理（防止日志泄露 CWE-598）
- CORS 策略配置（避免通配符 `*`）
- 安全响应头（MIME 嗅探、点击劫持防护）
- 速率限制（429 Retry-After）
- 白名单域名的完整性

## 部署

```bash
npx wrangler deploy
```

## 提交 Pull Request

1. Fork 本仓库并创建功能分支
2. 本地测试通过（`wrangler dev`）
3. 如涉及安全相关修改，请提供安全分析说明
4. 遵循 Conventional Commits 规范提交
