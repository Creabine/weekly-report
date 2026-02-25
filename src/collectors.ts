import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ================== 类型定义 ==================

export interface Config {
  LDAP_USERNAME: string;
  LDAP_PASSWORD: string;
  GITLAB_HOST: string;
  GITLAB_TOKEN: string;
  JIRA_HOST: string;
  GIT_AUTHOR: string;
  GIT_REPOS_DIR: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASS: string;
  MAIL_TO: string[];
  MAIL_CC: string[];
  MAIL_SUBJECT_TEMPLATE: string;
}

export interface DateRange {
  from: string; // yyyy-MM-dd
  to: string;
}

export interface MRItem {
  title: string;
  description: string | null;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
}

export interface JiraItem {
  key: string;
  summary: string;
  type: string;
  status: string;
}

export interface GitCommit {
  repo: string;
  message: string;
}

export interface GitRepoSummary {
  repo: string;
  commitCount: number;
}

export interface WeeklyData {
  dateRange: DateRange;
  mrs: MRItem[];
  jiraIssues: JiraItem[];
  commits: GitCommit[];
  gitSummary: GitRepoSummary[];
}

// ================== 配置加载 ==================

export function loadConfig(): Config {
  const envPath = path.resolve(process.cwd(), '.env');
  const env: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    console.error('错误: 未找到 .env 配置文件');
    console.error('请复制 .env.example 为 .env 并填写配置');
    process.exit(1);
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }

  const required = ['LDAP_USERNAME', 'LDAP_PASSWORD', 'GITLAB_HOST', 'GITLAB_TOKEN', 'JIRA_HOST'];
  for (const key of required) {
    if (!env[key]) {
      console.error(`错误: .env 缺少必填配置 ${key}`);
      process.exit(1);
    }
  }

  return {
    LDAP_USERNAME: env.LDAP_USERNAME,
    LDAP_PASSWORD: env.LDAP_PASSWORD,
    GITLAB_HOST: env.GITLAB_HOST,
    GITLAB_TOKEN: env.GITLAB_TOKEN,
    JIRA_HOST: env.JIRA_HOST,
    GIT_AUTHOR: env.GIT_AUTHOR || env.LDAP_USERNAME,
    GIT_REPOS_DIR: env.GIT_REPOS_DIR || '',
    SMTP_HOST: env.SMTP_HOST || 'smtp.exmail.qq.com',
    SMTP_PORT: parseInt(env.SMTP_PORT || '465', 10),
    SMTP_USER: env.SMTP_USER || '',
    SMTP_PASS: env.SMTP_PASS || '',
    MAIL_TO: (env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean),
    MAIL_CC: (env.MAIL_CC || '').split(',').map(s => s.trim()).filter(Boolean),
    MAIL_SUBJECT_TEMPLATE: env.MAIL_SUBJECT_TEMPLATE || '周报 - {author} - {dateRange}',
  };
}

// ================== HTTP 工具 ==================

function httpsRequest<T>(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; data: T; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = options.body ? JSON.stringify(options.body) : null;

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
          ...(postData ? { 'Content-Length': String(Buffer.byteLength(postData)) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          const cookies = (res.headers['set-cookie'] as string[] || [])
            .map(c => c.split(';')[0]).filter(Boolean);
          try {
            const parsed = data ? JSON.parse(data) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data: parsed as T, cookies });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed?.message || parsed?.errorMessages?.join(', ') || data.slice(0, 200)}`));
            }
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: 响应解析失败`));
          }
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ================== GitLab MR 收集 ==================

interface GitLabMR {
  title: string;
  description: string | null;
  state: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
  merged_at: string | null;
  updated_at: string;
}

export async function collectGitLabMRs(config: Config, range: DateRange): Promise<MRItem[]> {
  console.error('[GitLab] 收集 Merge Requests...');

  const params = new URLSearchParams({
    author_username: config.LDAP_USERNAME,
    updated_after: `${range.from}T00:00:00Z`,
    scope: 'all',
    per_page: '100',
  });

  const url = `${config.GITLAB_HOST}/api/v4/merge_requests?${params}`;
  const { data } = await httpsRequest<GitLabMR[]>(url, {
    headers: { 'PRIVATE-TOKEN': config.GITLAB_TOKEN },
  });

  // 本地二次过滤：created_at、merged_at 或 updated_at 在范围内
  const fromDate = new Date(`${range.from}T00:00:00Z`);
  const toDate = new Date(`${range.to}T23:59:59Z`);

  const filtered = data.filter((mr) => {
    if (mr.state === 'closed') return false;
    const created = new Date(mr.created_at);
    const merged = mr.merged_at ? new Date(mr.merged_at) : null;
    const updated = new Date(mr.updated_at);
    return (created >= fromDate && created <= toDate) ||
           (merged && merged >= fromDate && merged <= toDate) ||
           (updated >= fromDate && updated <= toDate);
  });

  console.error(`  找到 ${filtered.length} 个 MR`);

  return filtered.map((mr) => ({
    title: mr.title,
    description: mr.description,
    state: mr.state,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    url: mr.web_url,
    createdAt: mr.created_at,
    mergedAt: mr.merged_at,
  }));
}

// ================== Jira Issue 收集 ==================

interface JiraSearchResult {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      issuetype: { name: string };
      status: { name: string };
    };
  }>;
}

interface JiraSession {
  session: { name: string; value: string };
}

async function jiraLogin(config: Config): Promise<string> {
  console.error('[Jira] 登录...');
  const { data, cookies } = await httpsRequest<JiraSession>(
    `${config.JIRA_HOST}/rest/auth/1/session`,
    {
      method: 'POST',
      body: { username: config.LDAP_USERNAME, password: config.LDAP_PASSWORD },
    },
  );

  const sessionCookie = `${data.session.name}=${data.session.value}`;
  return [...cookies, sessionCookie].join('; ');
}

export async function collectJiraIssues(config: Config, mrs: MRItem[], commits: GitCommit[]): Promise<JiraItem[]> {
  console.error('[Jira] 收集 Issues...');

  // 从 MR 标题、分支名、描述和 commit message 中提取 Jira key
  const keyPattern = /[A-Z][A-Z0-9]+-\d+/g;
  const keysSet = new Set<string>();
  for (const mr of mrs) {
    const text = `${mr.title} ${mr.sourceBranch} ${mr.description || ''}`;
    for (const match of text.matchAll(keyPattern)) {
      keysSet.add(match[0]);
    }
  }
  for (const commit of commits) {
    for (const match of commit.message.matchAll(keyPattern)) {
      keysSet.add(match[0]);
    }
  }

  if (keysSet.size === 0) {
    console.error('  MR 中未发现 Jira Key');
    return [];
  }

  const keys = [...keysSet];
  console.error(`  从 MR 中提取到 ${keys.length} 个 Jira Key: ${keys.join(', ')}`);

  const cookies = await jiraLogin(config);
  const jql = `key in (${keys.join(',')})`;
  const params = new URLSearchParams({
    jql,
    maxResults: '100',
    fields: 'summary,issuetype,status',
  });

  const url = `${config.JIRA_HOST}/rest/api/2/search?${params}`;
  const { data } = await httpsRequest<JiraSearchResult>(url, {
    headers: { Cookie: cookies },
  });

  console.error(`  找到 ${data.issues.length} 个 Issue`);

  return data.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    type: issue.fields.issuetype.name,
    status: issue.fields.status.name,
  }));
}

// ================== Git Commits 收集 ==================

function getGitRemoteUrl(repoPath: string): string | null {
  try {
    return execSync('git remote get-url origin', {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function isGitLabRepo(remoteUrl: string, gitlabHost: string): boolean {
  // 匹配 SSH: git@gitlab.mokahr.com:xxx 或 HTTPS: https://gitlab.mokahr.com/xxx
  const hostname = new URL(gitlabHost).hostname;
  return remoteUrl.includes(hostname);
}

function discoverRepos(config: Config): string[] {
  let dir = config.GIT_REPOS_DIR;
  if (!dir) return [];
  if (dir.startsWith('~')) {
    dir = path.join(process.env.HOME || '', dir.slice(1));
  }
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const repos: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(repoPath, '.git'))) continue;

    const remoteUrl = getGitRemoteUrl(repoPath);
    if (remoteUrl && isGitLabRepo(remoteUrl, config.GITLAB_HOST)) {
      repos.push(repoPath);
    }
  }

  return repos;
}

export function collectGitCommits(config: Config, range: DateRange): { commits: GitCommit[]; summary: GitRepoSummary[] } {
  console.error('[Git] 收集 Commits...');

  const repoPaths = discoverRepos(config);
  if (repoPaths.length === 0) {
    console.error('  未发现匹配的 Git 仓库');
    return { commits: [], summary: [] };
  }

  // --before 不包含当天，需要加一天
  const beforeDate = new Date(`${range.to}T00:00:00Z`);
  beforeDate.setDate(beforeDate.getDate() + 1);
  const beforeStr = beforeDate.toISOString().slice(0, 10);

  console.error(`  发现 ${repoPaths.length} 个 GitLab 仓库`);
  const commits: GitCommit[] = [];
  const summary: GitRepoSummary[] = [];

  for (const repoPath of repoPaths) {
    const repoName = path.basename(repoPath);
    try {
      const output = execSync(
        `git log --author="${config.GIT_AUTHOR} <" --after="${range.from}" --before="${beforeStr}" --format="%s"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const lines = output.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        for (const msg of lines) {
          commits.push({ repo: repoName, message: msg });
        }
        summary.push({ repo: repoName, commitCount: lines.length });
        console.error(`  ${repoName}: ${lines.length} commits`);
      }
    } catch {
      console.error(`  ${repoName}: 读取失败`);
    }
  }

  return { commits, summary };
}

// ================== 汇总收集 ==================

export async function collectAll(config: Config, range: DateRange): Promise<WeeklyData> {
  const mrs = await collectGitLabMRs(config, range).catch((e) => {
    console.error(`  GitLab 收集失败: ${(e as Error).message}`);
    return [] as MRItem[];
  });

  const { commits, summary: gitSummary } = collectGitCommits(config, range);

  // 从 MR 和 commits 中提取 Jira key
  const jiraIssues = await collectJiraIssues(config, mrs, commits).catch((e) => {
    console.error(`  Jira 收集失败: ${(e as Error).message}`);
    return [] as JiraItem[];
  });

  return { dateRange: range, mrs, jiraIssues, commits, gitSummary };
}
