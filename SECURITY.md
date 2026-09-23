# 安全说明

## 报告问题

如果你发现了安全问题，请**不要开公开 issue**，走仓库的
[私密漏洞报告](https://github.com/K-02-b/nmb-reader/security/advisories/new) 告知
（用法见 [GitHub 文档](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)）。

## 设计上如何处理敏感信息

| 数据 | 处理方式 |
| --- | --- |
| 抓取用 Cookie | Fernet 加密后存库；接口永不回显；日志与任务消息里不出现；按提交者取用（A 的 Cookie 只用于 A 的任务） |
| 主密钥 | `THREAD_READER_SECRET_KEY`，留空则在 `data/secret.key` 生成（权限 600）；**泄露密钥等于泄露所有 Cookie** |
| 用户口令 | scrypt 加盐哈希（`app/security.py`），不可逆 |
| 会话 | 签名 Cookie `xdnmb_session`，HttpOnly；TTL 见 `docs/architecture.md` |
| 备份文件 | 管理页导出的备份含加密后的 Cookie，按敏感数据对待 |

## 部署注意

- `.env`、`data/`（含数据库、图片、`secret.key`）都已在 `.gitignore` 里，**别提交**
- 公网部署请自行加 HTTPS 反代（`deploy/nginx/` 有样例），并改掉所有默认口令
- HTTPS 下必须设 `THREAD_READER_COOKIE_SECURE=true`，否则浏览器不保存会话 Cookie
- 默认口令只用于本地试跑；上线前用管理页「修改密码」或 `scripts/manage_users.py` 改掉

## 不在范围内

- 被抓取站点的自身安全问题
- 使用者自己泄露 Cookie（例如贴到公开 issue 里）
