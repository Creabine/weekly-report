import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// ================== 类型定义 ==================

export interface Config {
  LDAP_USERNAME: string;
  LDAP_PASSWORD: string;
  GITLAB_HOST: string;
  GITLAB_TOKEN: string;
  JIRA_HOST: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASS: string;
  MAIL_TO: string[];
  MAIL_CC: string[];
  MAIL_SUBJECT_TEMPLATE: string;
  MAIL_AUTHOR_NAME: string;
  MAIL_THREAD: boolean;
  MAIL_TEMPLATE: string;
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
  projectId: number;
  iid: number;
  mergeCommitSha: string | null;
}

export interface MRCommit {
  sha: string;
  message: string;
}

export interface MRDetail {
  mr: MRItem;
  commits: MRCommit[];
  deployStatus: string; // 开发中 | 已提测 | 灰度中 | 已上线
  isHotfix: boolean;
}

export interface JiraItem {
  key: string;
  summary: string;
  type: string;
  status: string;
}

export interface WeeklyData {
  dateRange: DateRange;
  mrs: MRItem[];
  mrDetails: MRDetail[];
  jiraIssues: JiraItem[];
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
    SMTP_HOST: env.SMTP_HOST || 'smtp.exmail.qq.com',
    SMTP_PORT: parseInt(env.SMTP_PORT || '465', 10),
    SMTP_USER: env.SMTP_USER || '',
    SMTP_PASS: env.SMTP_PASS || '',
    MAIL_TO: (env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean),
    MAIL_CC: (env.MAIL_CC || '').split(',').map(s => s.trim()).filter(Boolean),
    MAIL_SUBJECT_TEMPLATE: env.MAIL_SUBJECT_TEMPLATE || '【工作周报-前端】{dateRange} {author}',
    MAIL_AUTHOR_NAME: env.MAIL_AUTHOR_NAME || env.LDAP_USERNAME,
    MAIL_THREAD: env.MAIL_THREAD === 'true',
    MAIL_TEMPLATE: env.MAIL_TEMPLATE || 'email-cerberus-light',
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
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
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
  project_id: number;
  iid: number;
  merge_commit_sha: string | null;
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
    projectId: mr.project_id,
    iid: mr.iid,
    mergeCommitSha: mr.merge_commit_sha,
  }));
}

// ================== MR 详情收集 ==================

const FLOW_BRANCHES = new Set(['main', 'master', 'gray-release', 'release']);

function isMergeBranchMR(mr: MRItem): boolean {
  return FLOW_BRANCHES.has(mr.sourceBranch) && FLOW_BRANCHES.has(mr.targetBranch);
}

const NOISE_COMMIT_RE = /^Merge (remote-tracking )?branch /;

async function fetchMRCommits(config: Config, mr: MRItem): Promise<MRCommit[]> {
  const url = `${config.GITLAB_HOST}/api/v4/projects/${mr.projectId}/merge_requests/${mr.iid}/commits?per_page=100`;
  const { data } = await httpsRequest<Array<{ id: string; message: string; author_email: string }>>(url, {
    headers: { 'PRIVATE-TOKEN': config.GITLAB_TOKEN },
  });
  const username = config.LDAP_USERNAME.toLowerCase();
  return data
    .filter(c => c.author_email.toLowerCase().split('@')[0] === username)
    .map(c => ({ sha: c.id, message: c.message.split('\n')[0] }))
    .filter(c => !NOISE_COMMIT_RE.test(c.message));
}

async function fetchCommitRefs(config: Config, projectId: number, sha: string): Promise<string[]> {
  const url = `${config.GITLAB_HOST}/api/v4/projects/${projectId}/repository/commits/${sha}/refs?type=branch`;
  const { data } = await httpsRequest<Array<{ name: string }>>(url, {
    headers: { 'PRIVATE-TOKEN': config.GITLAB_TOKEN },
  });
  return data.map(r => r.name);
}

function resolveDeployStatus(branches: string[]): string {
  const set = new Set(branches);
  if (set.has('release')) return '已上线';
  if (set.has('gray-release')) return '灰度中';
  if (set.has('main') || set.has('master')) return '已提测';
  return '开发中';
}

export async function collectMRDetails(config: Config, mrs: MRItem[]): Promise<MRDetail[]> {
  console.error('[GitLab] 收集 MR 详情...');

  const featureMRs = mrs.filter(mr => !isMergeBranchMR(mr));
  const details: MRDetail[] = [];

  for (const mr of featureMRs) {
    const commits = await fetchMRCommits(config, mr);
    if (commits.length === 0) continue;

    const isHotfix = mr.targetBranch !== 'main' && mr.targetBranch !== 'master';

    let deployStatus: string;
    if (mr.state !== 'merged') {
      deployStatus = '开发中';
    } else if (mr.mergeCommitSha) {
      const refs = await fetchCommitRefs(config, mr.projectId, mr.mergeCommitSha);
      deployStatus = resolveDeployStatus(refs);
    } else {
      // fallback: 从 targetBranch 推断
      deployStatus = resolveDeployStatus([mr.targetBranch]);
    }

    console.error(`  ${mr.title} → ${deployStatus}${isHotfix ? ' [hotfix]' : ''}`);
    details.push({ mr, commits, deployStatus, isHotfix });
  }

  return details;
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

export async function collectJiraIssues(config: Config, mrs: MRItem[]): Promise<JiraItem[]> {
  console.error('[Jira] 收集 Issues...');

  // 从 MR 标题、分支名、描述中提取 Jira key
  const keyPattern = /[A-Z][A-Z0-9]+-\d+/g;
  const keysSet = new Set<string>();
  for (const mr of mrs) {
    const text = `${mr.title} ${mr.sourceBranch} ${mr.description || ''}`;
    for (const match of text.matchAll(keyPattern)) {
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

// ================== 汇总收集 ==================

export async function collectAll(config: Config, range: DateRange): Promise<WeeklyData> {
  const mrs = await collectGitLabMRs(config, range).catch((e) => {
    console.error(`  GitLab 收集失败: ${(e as Error).message}`);
    return [] as MRItem[];
  });

  const mrDetails = await collectMRDetails(config, mrs).catch((e) => {
    console.error(`  MR 详情收集失败: ${(e as Error).message}`);
    return [] as MRDetail[];
  });

  // 从 MR 中提取 Jira key
  const jiraIssues = await collectJiraIssues(config, mrs).catch((e) => {
    console.error(`  Jira 收集失败: ${(e as Error).message}`);
    return [] as JiraItem[];
  });

  return { dateRange: range, mrs, mrDetails, jiraIssues };
}
