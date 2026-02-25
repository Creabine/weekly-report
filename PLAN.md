# Weekly Report - 周报自动化工具

## 概述

Node.js CLI 工具，自动从 GitLab MR、Jira Issue、Git Commits 收集本周工作数据，生成 Markdown 草稿，支持手动补充后通过 SMTP 发送邮件。

## 设计原则

- **轻量依赖**：核心逻辑使用 Node.js 内置模块，SMTP 和 Markdown 渲染使用三方库
- **模块拆分**：按职责拆分为 cli / collectors / render / mailer 四个模块，保持可维护性
- **直接运行**：`node --experimental-strip-types` 直接执行 TypeScript

## 项目结构

```
weekly-report/
├── PLAN.md                   # 开发计划（本文件）
├── README.md                 # 用户文档（开发完成后编写）
├── package.json              # 依赖管理 + bin 入口
├── tsconfig.json             # TypeScript 配置
├── .env.local                # 配置文件（gitignore）
├── .env.example              # 配置模板
├── .gitignore
├── src/
│   ├── cli.ts                # 入口 + 命令分发 + 交互式日期选择
│   ├── collectors.ts         # GitLab/Jira/Git 数据收集
│   ├── render.ts             # Markdown 生成 + HTML 渲染
│   └── mailer.ts             # SMTP 发送
├── dist/                     # 编译输出（gitignore，npm 发布）
├── drafts/                   # 生成的草稿目录（gitignore）
├── templates/
│   └── email-*.html          # 邮件 HTML 模板（多套，随机选用）
└── reference/                # 参考代码（开发完成后可删除）
    ├── gitlab.ts             # GitLab skill 参考
    └── jira-getIssue.ts      # Jira skill 参考
```

## 工作流程

```
1. draft   →  收集 GitLab MR + Jira Issue + Git Commits → 生成 Markdown 草稿
2. 手动编辑  →  在草稿的"补充内容"区域添加个人总结、下周计划
3. preview →  浏览器预览 HTML 邮件效果
4. send    →  Markdown → HTML → SMTP 发送
```

## CLI 命令

开发时：
```bash
node --experimental-strip-types src/cli.ts draft
```

用户安装后：
```bash
# 全局安装
npm install -g weekly-report

# 或直接 npx
npx weekly-report draft

# 可用命令
weekly-report draft     # 收集数据 + 生成草稿
weekly-report preview   # 浏览器预览邮件（open 命令打开临时 HTML）
weekly-report send      # 发送最新草稿
weekly-report run       # draft → 打开编辑 → 确认后 send
```

### 日期范围

默认：本周一 ~ 今天。支持交互式选择和命令行参数覆盖：

```bash
# 默认本周一到今天
weekly-report draft

# 交互式：提示用户选择日期范围（本周 / 上周 / 自定义）
weekly-report draft -i

# 命令行参数指定
weekly-report draft --from 2026-02-16 --to 2026-02-20
```

交互模式（`-i`）使用 Node.js 内置 `readline` 提供选项：
```
? 选择日期范围:
  1) 本周（周一 ~ 今天）
  2) 上周（上周一 ~ 上周五）
  3) 自定义范围
```

## 配置文件 .env.local

```bash
# LDAP 账号（GitLab / Jira / Git author 共用）
LDAP_USERNAME=chenlei1
LDAP_PASSWORD=your_password

# GitLab 配置（使用 LDAP 密码认证，非 Token）
GITLAB_HOST=https://gitlab.mokahr.com

# Jira 配置（使用 LDAP Basic Auth）
JIRA_HOST=https://jira.mokahr.com

# Git 配置（多仓库逗号分隔）
GIT_REPOS=/Users/creabine/code/pa-fe-mono,/Users/creabine/code/another-repo

# 企业邮箱 SMTP 配置
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=xxx@mokahr.com
SMTP_PASS=xxxxxx

# 收件人（逗号分隔）
MAIL_TO=leader@mokahr.com
MAIL_CC=
MAIL_SUBJECT_TEMPLATE=周报 - {author} - {dateRange}
```

## 数据收集详情

### GitLab MR

复用 `reference/gitlab.ts` 的 HTTP 请求模式，使用 LDAP 密码认证（Private-Token 或 Basic Auth）。

```
GET /api/v4/merge_requests?author_username=xxx&updated_after=xxx&scope=all
```

注意：使用 `updated_after` 而非 `created_after`，避免漏掉上周创建、本周才 merge 的 MR。获取后在本地按日期范围二次过滤（created_at 或 merged_at 在范围内）。

收集：标题、状态（merged/opened/closed）、目标分支、链接

### Jira Issue

复用 `reference/jira-getIssue.ts` 的 LDAP Basic Auth（username:password base64）认证模式。

```
GET /rest/api/2/search?jql=assignee=currentUser() AND updated >= "yyyy-MM-dd"
```

注意：使用 `updated >=` 而非 `status changed DURING`，避免漏掉本周持续处理但状态未变的 issue。

收集：Issue Key、标题、类型（需求/Bug）、状态

### Git Commits

使用 `child_process.execSync` 执行本地 git log，遍历 `GIT_REPOS` 中配置的所有仓库。

```bash
git log --author="xxx" --after="yyyy-mm-dd" --oneline
```

按仓库分组汇总 commit 数量。

## 草稿格式

生成到 `drafts/2026-02-27.md`：

```markdown
# 周报 2026.02.23 - 2026.02.27

## 本周完成

### 需求开发
- [HCM-50624] 修复清除申请人时依然返回默认申请人的问题 ✅ Merged
- [HCM-50706] 人员范围控制新增选项 ✅ Merged

### Bug 修复
- [HCMBUGS-xxxxx] xxx问题修复

## Merge Requests
| MR | 状态 | 目标分支 |
|----|------|----------|
| !1234 修复xxx | Merged | main |

## 代码提交摘要
- pa-fe-mono: 10 commits

## 补充内容
<!-- 在这里添加你的补充内容，如：下周计划、遇到的问题、需要协调的事项等 -->
```

## 邮件发送

使用 `nodemailer` 发送邮件，支持：
- TLS 连接（企业邮箱 SMTP 465 端口）
- AUTH LOGIN 认证
- MIME 格式邮件（HTML body）

Markdown → HTML 渲染使用 `marked` 库，配合多套预设 HTML 邮件模板（`templates/email-*.html`），每次发送随机选用一套。

## 定时任务

```bash
# crontab -e
# 每周五 16:00 自动生成草稿 + macOS 桌面通知
0 16 * * 5 cd ~/code/weekly-report && node --experimental-strip-types src/cli.ts draft && osascript -e 'display notification "周报草稿已生成，请检查后发送" with title "Weekly Report"'
```

## npm 发布

- 包名：`weekly-report`（或 `@creabine/weekly-report` 如果被占用）
- `package.json` 中配置 `"bin": { "weekly-report": "./dist/cli.js" }`
- 构建：`tsc` 编译 src → dist，构建脚本需在入口文件顶部插入 shebang `#!/usr/bin/env node`（tsc 不会自动添加）
- 发布前 `npm run build`，`dist/` 目录随包发布
- `files` 字段只包含 `dist/` 和 `templates/`

## 实现步骤

1. 初始化项目，安装依赖（`nodemailer`、`marked`、`typescript`）
2. 配置 `tsconfig.json` 和 `package.json`（bin、files、build 脚本，build 后插入 shebang）
3. 实现 .env.local 配置加载（参考现有 skill）
4. 实现 GitLab MR 收集器（LDAP 密码认证，updated_after + 本地二次过滤）
5. 实现 Jira Issue 收集器（LDAP Basic Auth，updated >= 过滤）
6. 实现 Git Commits 收集器（child_process.execSync，支持多仓库）
7. 实现 Markdown 草稿生成器
8. 实现 Markdown → HTML 渲染（marked + 多套邮件模板随机选用）
9. 实现 SMTP 邮件发送（nodemailer）
10. 实现 CLI 命令分发（draft / preview / send / run），preview 使用 `open` 命令打开临时 HTML，run 使用 `$EDITOR` 或 `code` 打开草稿（带 fallback）
11. 实现交互式日期选择（readline，支持 -i 和 --from/--to）
12. 编写 .env.example
13. 编写 README.md（面向用户的安装和使用文档）
14. npm publish
