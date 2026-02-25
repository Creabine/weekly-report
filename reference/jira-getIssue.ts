#!/usr/bin/env node --experimental-strip-types
/**
 * Jira Issue 读取工具
 *
 * 使用方式:
 *   node --experimental-strip-types getIssue.ts HCMBUGS-16852
 *   node --experimental-strip-types getIssue.ts -k HCMBUGS-16852
 *   node --experimental-strip-types getIssue.ts -k HCMBUGS-16852 --json
 *
 * 配置文件:
 *   .env.local - LDAP 登录凭据 (LDAP_USERNAME, LDAP_PASSWORD)
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// ================== 类型定义 ==================

interface JiraUser {
  displayName: string;
  emailAddress?: string;
  accountId?: string;
}

interface JiraStatus {
  name: string;
  statusCategory?: {
    name: string;
    colorName: string;
  };
}

interface JiraPriority {
  name: string;
  iconUrl?: string;
}

interface JiraIssueType {
  name: string;
  iconUrl?: string;
}

interface JiraProject {
  key: string;
  name: string;
}

interface JiraComponent {
  name: string;
}

interface JiraVersion {
  name: string;
  released?: boolean;
}

interface JiraAttachment {
  filename: string;
  content: string;
  mimeType: string;
}

interface JiraComment {
  author: JiraUser;
  body: string;
  created: string;
  updated: string;
}

interface JiraIssueLink {
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: {
    key: string;
    fields: {
      summary: string;
      status: JiraStatus;
    };
  };
  outwardIssue?: {
    key: string;
    fields: {
      summary: string;
      status: JiraStatus;
    };
  };
}

interface JiraIssueFields {
  summary: string;
  description: string | null;
  status: JiraStatus;
  priority: JiraPriority;
  issuetype: JiraIssueType;
  project: JiraProject;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  creator: JiraUser | null;
  created: string;
  updated: string;
  resolutiondate: string | null;
  duedate: string | null;
  labels: string[];
  components: JiraComponent[];
  fixVersions: JiraVersion[];
  affectedVersions?: JiraVersion[];
  attachment: JiraAttachment[];
  comment: {
    comments: JiraComment[];
    total: number;
  };
  issuelinks: JiraIssueLink[];
  // 自定义字段 - 可能包含重现步骤、期望结果等
  [key: string]: unknown;
}

interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: JiraIssueFields;
}

interface CLIOptions {
  issueKey: string | null;
  json: boolean;
  help: boolean;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}

interface RequestResponse<T = unknown> {
  status: number;
  data: T | null;
  cookies: string[];
  error?: string;
}

interface SessionResponse {
  session: {
    name: string;
    value: string;
  };
}

// ================== 配置 ==================

// Jira 服务器地址
const JIRA_BASE_URL = 'https://jira.mokahr.com';

/**
 * 从 .env.local 文件加载环境变量
 */
function loadEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env.local');
  const env: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    return env;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    env[key] = value;
  }

  return env;
}

// ================== 工具函数 ==================

/**
 * 解析命令行参数
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    issueKey: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '-k':
      case '--key':
        options.issueKey = nextArg;
        i++;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        // 如果是类似 HCMBUGS-16852 的格式，视为 issue key
        if (/^[A-Z]+-\d+$/i.test(arg)) {
          options.issueKey = arg.toUpperCase();
        }
        break;
    }
  }

  return options;
}

/**
 * 打印帮助信息
 */
function printHelp(): void {
  console.log(`
Jira Issue 读取工具

使用方式:
  node --experimental-strip-types getIssue.ts <ISSUE_KEY>
  node --experimental-strip-types getIssue.ts -k <ISSUE_KEY>
  node --experimental-strip-types getIssue.ts -k <ISSUE_KEY> --json

参数:
  <ISSUE_KEY>    Issue Key (例如: HCMBUGS-16852)
  -k, --key      指定 Issue Key
  --json         以 JSON 格式输出完整信息
  -h, --help     显示帮助信息

配置文件 (.env.local):
  LDAP_USERNAME    LDAP 用户名
  LDAP_PASSWORD    LDAP 密码

示例:
  node --experimental-strip-types getIssue.ts HCMBUGS-16852
  node --experimental-strip-types getIssue.ts -k HCMBUGS-16852 --json
`);
}

/**
 * 发送 HTTPS 请求
 */
function request<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<RequestResponse<T>> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      res => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          // 提取 cookies
          const cookies = (res.headers['set-cookie'] as string[] || [])
            .map(cookie => cookie.split(';')[0])
            .filter(Boolean);

          try {
            const parsed = data ? JSON.parse(data) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({
                status: res.statusCode,
                data: parsed as T,
                cookies,
              });
            } else {
              resolve({
                status: res.statusCode || 0,
                data: parsed,
                cookies,
                error: parsed?.errorMessages?.join(', ') || parsed?.message || `HTTP ${res.statusCode}`,
              });
            }
          } catch {
            resolve({
              status: res.statusCode || 0,
              data: null,
              cookies,
              error: `HTTP ${res.statusCode}`,
            });
          }
        });
      },
    );

    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * 登录 Jira 获取 session cookie
 */
async function login(username: string, password: string): Promise<string> {
  console.error('[登录] Jira...');

  const response = await request<SessionResponse>(
    `${JIRA_BASE_URL}/rest/auth/1/session`,
    {
      method: 'POST',
      body: { username, password },
    },
  );

  if (response.error || !response.data?.session) {
    throw new Error(response.error || '登录失败：未获取到 session');
  }

  const { name, value } = response.data.session;
  const sessionCookie = `${name}=${value}`;

  // 合并所有 cookies
  const allCookies = [...response.cookies, sessionCookie].join('; ');

  console.error('  登录成功!');
  return allCookies;
}

/**
 * 获取 Issue 详情
 */
async function getIssue(issueKey: string, cookies: string): Promise<JiraIssue> {
  console.error(`[获取] Issue: ${issueKey}`);

  const response = await request<JiraIssue>(
    `${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}?expand=comment`,
    {
      method: 'GET',
      headers: { Cookie: cookies },
    },
  );

  if (response.error || !response.data) {
    if (response.status === 404) {
      throw new Error(`Issue ${issueKey} 不存在或无权访问`);
    }
    throw new Error(response.error || '获取 Issue 失败');
  }

  return response.data;
}

/**
 * 格式化日期
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 格式化用户名
 */
function formatUser(user: JiraUser | null): string {
  if (!user) return '-';
  return user.displayName || user.emailAddress || '-';
}

/**
 * 清理 Jira 描述中的格式标记
 * Jira 使用类似 wiki 的标记语法
 */
function cleanDescription(desc: string | null): string {
  if (!desc) return '-';

  return desc
    // 移除 {color} 标记
    .replace(/\{color[^}]*\}/g, '')
    // 移除 {panel} 标记
    .replace(/\{panel[^}]*\}/g, '')
    // 移除 {code} 标记但保留内容
    .replace(/\{code[^}]*\}([\s\S]*?)\{code\}/g, '$1')
    // 移除 {noformat} 标记但保留内容
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '$1')
    // 处理链接 [text|url]
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$1 ($2)')
    // 处理简单链接 [url]
    .replace(/\[([^\]]+)\]/g, '$1')
    // 移除多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 打印格式化的 Issue 信息
 */
function printIssue(issue: JiraIssue): void {
  const { key, fields } = issue;
  const separator = '='.repeat(60);
  const subSeparator = '-'.repeat(40);

  console.log(`\n${separator}`);
  console.log(`  ${key}: ${fields.summary}`);
  console.log(`${separator}\n`);

  // 基本信息
  console.log('【基本信息】');
  console.log(`  类型:     ${fields.issuetype.name}`);
  console.log(`  状态:     ${fields.status.name}`);
  console.log(`  优先级:   ${fields.priority.name}`);
  console.log(`  项目:     ${fields.project.name} (${fields.project.key})`);
  console.log('');

  // 人员信息
  console.log('【人员信息】');
  console.log(`  报告人:   ${formatUser(fields.reporter)}`);
  console.log(`  经办人:   ${formatUser(fields.assignee)}`);
  console.log(`  创建人:   ${formatUser(fields.creator)}`);
  console.log('');

  // 时间信息
  console.log('【时间信息】');
  console.log(`  创建时间: ${formatDate(fields.created)}`);
  console.log(`  更新时间: ${formatDate(fields.updated)}`);
  if (fields.duedate) {
    console.log(`  截止时间: ${formatDate(fields.duedate)}`);
  }
  if (fields.resolutiondate) {
    console.log(`  解决时间: ${formatDate(fields.resolutiondate)}`);
  }
  console.log('');

  // 标签和组件
  if (fields.labels.length > 0) {
    console.log(`【标签】    ${fields.labels.join(', ')}`);
    console.log('');
  }

  if (fields.components.length > 0) {
    console.log(`【组件】    ${fields.components.map(c => c.name).join(', ')}`);
    console.log('');
  }

  if (fields.fixVersions.length > 0) {
    console.log(`【修复版本】${fields.fixVersions.map(v => v.name).join(', ')}`);
    console.log('');
  }

  // 描述
  console.log('【描述】');
  console.log(subSeparator);
  console.log(cleanDescription(fields.description));
  console.log(subSeparator);
  console.log('');

  // 关联 Issue
  if (fields.issuelinks.length > 0) {
    console.log('【关联 Issue】');
    for (const link of fields.issuelinks) {
      if (link.inwardIssue) {
        console.log(`  ${link.type.inward}: ${link.inwardIssue.key} - ${link.inwardIssue.fields.summary} [${link.inwardIssue.fields.status.name}]`);
      }
      if (link.outwardIssue) {
        console.log(`  ${link.type.outward}: ${link.outwardIssue.key} - ${link.outwardIssue.fields.summary} [${link.outwardIssue.fields.status.name}]`);
      }
    }
    console.log('');
  }

  // 附件
  if (fields.attachment.length > 0) {
    console.log('【附件】');
    for (const att of fields.attachment) {
      console.log(`  - ${att.filename} (${att.mimeType})`);
    }
    console.log('');
  }

  // 评论（只显示最近 5 条）
  if (fields.comment.total > 0) {
    console.log(`【评论】(共 ${fields.comment.total} 条，显示最近 5 条)`);
    console.log(subSeparator);
    const recentComments = fields.comment.comments.slice(-5);
    for (const comment of recentComments) {
      console.log(`[${formatDate(comment.created)}] ${formatUser(comment.author)}:`);
      console.log(`  ${cleanDescription(comment.body).replace(/\n/g, '\n  ')}`);
      console.log('');
    }
    console.log(subSeparator);
  }

  // Jira 链接
  console.log(`【链接】    ${JIRA_BASE_URL}/browse/${key}`);
  console.log('');
}

// ================== 主程序 ==================

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.issueKey) {
    console.error('错误: 缺少 Issue Key');
    console.error('使用 -h 查看帮助信息');
    process.exit(1);
  }

  // 加载认证信息
  const envFile = loadEnvFile();
  const username = envFile.LDAP_USERNAME;
  const password = envFile.LDAP_PASSWORD;

  if (!username || !password) {
    console.error('错误: 缺少 LDAP 认证信息');
    console.error('请在 .env.local 文件中配置：');
    console.error('');
    console.error('  LDAP_USERNAME=your_username');
    console.error('  LDAP_PASSWORD=your_password');
    process.exit(1);
  }

  try {
    // 登录获取 session
    const cookies = await login(username, password);

    // 获取 Issue
    const issue = await getIssue(options.issueKey, cookies);

    // 输出结果
    if (options.json) {
      console.log(JSON.stringify(issue, null, 2));
    } else {
      printIssue(issue);
    }
  } catch (error) {
    console.error(`\n错误: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
