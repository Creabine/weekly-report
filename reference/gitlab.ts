#!/usr/bin/env node --experimental-strip-types
/**
 * GitLab 管理脚本
 *
 * 功能:
 * 1. MR 操作: 查看、列表、创建、合并、查看 diff
 * 2. Pipeline 操作: 列表、查看详情、查看 jobs
 * 3. Issue 操作: 查看、列表、创建
 *
 * 使用方式:
 *   node gitlab.ts -a mr-view -m 123           # 查看 MR
 *   node gitlab.ts -a mr-list                   # 列表 MR
 *   node gitlab.ts -a mr-diff -m 123            # 查看 MR diff
 *   node gitlab.ts -a pipeline-list             # 列表 Pipeline
 *   node gitlab.ts -a issue-view -i 456         # 查看 Issue
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// ================== 常量配置 ==================

const GITLAB_API_URL = 'https://gitlab.mokahr.com/api/v4';

// ================== 类型定义 ==================

type Action =
  | 'mr-view'
  | 'mr-list'
  | 'mr-create'
  | 'mr-update'
  | 'mr-merge'
  | 'mr-diff'
  | 'mr-discussions'
  | 'mr-comment'
  | 'mr-comment-code'
  | 'issue-view'
  | 'issue-list'
  | 'issue-create'
  | 'pipeline-list'
  | 'pipeline-view'
  | 'pipeline-jobs'
  | 'job-view'
  | 'job-log';

interface CLIOptions {
  action: Action;
  mrIid: number | null;
  issueIid: number | null;
  pipelineId: number | null;
  jobId: number | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  title: string | null;
  description: string | null;
  labels: string | null;
  project: string | null;
  limit: number;
  state: string | null;
  json: boolean;
  help: boolean;
  // 评论相关
  body: string | null;
  filePath: string | null;
  line: number | null;
  lineType: 'new' | 'old' | null;
}

interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  web_url: string;
}

interface MergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  source_branch: string;
  target_branch: string;
  author: GitLabUser;
  assignee: GitLabUser | null;
  assignees: GitLabUser[];
  reviewers: GitLabUser[];
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merged_by: GitLabUser | null;
  web_url: string;
  labels: string[];
  has_conflicts: boolean;
  merge_status: string;
  changes_count: string;
  draft: boolean;
}

interface MRDiff {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

interface Issue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  author: GitLabUser;
  assignee: GitLabUser | null;
  assignees: GitLabUser[];
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  web_url: string;
}

interface Pipeline {
  id: number;
  iid: number;
  status:
    | 'created'
    | 'waiting_for_resource'
    | 'preparing'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'manual'
    | 'scheduled';
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  user: GitLabUser;
}

interface PipelineJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  duration: number | null;
  started_at: string | null;
  finished_at: string | null;
  web_url: string;
  ref?: string;
  allow_failure?: boolean;
  failure_reason?: string;
  user?: GitLabUser;
  commit?: {
    id: string;
    short_id: string;
    title: string;
    message: string;
    author_name: string;
  };
  pipeline?: {
    id: number;
    status: string;
    ref: string;
    web_url: string;
  };
  runner?: {
    id: number;
    description: string;
    status: string;
  };
}

// MR Discussion/Note 类型
interface MRNote {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  updated_at: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  resolved_by: GitLabUser | null;
  position?: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    position_type: string;
    old_line: number | null;
    new_line: number | null;
  };
}

interface MRDiscussion {
  id: string;
  individual_note: boolean;
  notes: MRNote[];
}

// ================== 配置加载 ==================

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

function getProjectIdFromGit(): string | null {
  try {
    const gitConfigPath = path.join(process.cwd(), '.git/config');
    if (!fs.existsSync(gitConfigPath)) {
      return null;
    }

    const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');

    // 匹配 GitLab remote URL
    // 支持 SSH: git@gitlab.mokahr.com:TryMoka/hcm-platform-fe.git
    // 支持 HTTPS: https://gitlab.mokahr.com/TryMoka/hcm-platform-fe.git
    const sshMatch = gitConfig.match(
      /url\s*=\s*git@gitlab\.mokahr\.com:(.+?)(?:\.git)?$/m,
    );
    const httpsMatch = gitConfig.match(
      /url\s*=\s*https:\/\/gitlab\.mokahr\.com\/(.+?)(?:\.git)?$/m,
    );

    const projectPath = sshMatch?.[1] || httpsMatch?.[1];
    if (projectPath) {
      return encodeURIComponent(projectPath.replace(/\.git$/, ''));
    }

    return null;
  } catch {
    return null;
  }
}

// ================== CLI 参数解析 ==================

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    action: 'mr-list',
    mrIid: null,
    issueIid: null,
    pipelineId: null,
    jobId: null,
    sourceBranch: null,
    targetBranch: null,
    title: null,
    description: null,
    labels: null,
    project: null,
    limit: 20,
    state: null,
    json: false,
    help: false,
    // 评论相关
    body: null,
    filePath: null,
    line: null,
    lineType: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '-a':
      case '--action':
        options.action = nextArg as Action;
        i++;
        break;
      case '-m':
      case '--mr':
        options.mrIid = parseInt(nextArg, 10);
        i++;
        break;
      case '-i':
      case '--issue':
        options.issueIid = parseInt(nextArg, 10);
        i++;
        break;
      case '-p':
      case '--pipeline':
        options.pipelineId = parseInt(nextArg, 10);
        i++;
        break;
      case '-j':
      case '--job':
        options.jobId = parseInt(nextArg, 10);
        i++;
        break;
      case '-s':
      case '--source':
        options.sourceBranch = nextArg;
        i++;
        break;
      case '-t':
      case '--target':
        options.targetBranch = nextArg;
        i++;
        break;
      case '--title':
        options.title = nextArg;
        i++;
        break;
      case '-d':
      case '--description':
        options.description = nextArg;
        i++;
        break;
      case '--labels':
        options.labels = nextArg;
        i++;
        break;
      case '--project':
        options.project = nextArg;
        i++;
        break;
      case '-l':
      case '--limit':
        options.limit = parseInt(nextArg, 10);
        i++;
        break;
      case '--state':
        options.state = nextArg;
        i++;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-b':
      case '--body':
        options.body = nextArg;
        i++;
        break;
      case '-f':
      case '--file':
        options.filePath = nextArg;
        i++;
        break;
      case '--line':
        options.line = parseInt(nextArg, 10);
        i++;
        break;
      case '--line-type':
        options.lineType = nextArg as 'new' | 'old';
        i++;
        break;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
GitLab 管理工具

使用方式:
  node gitlab.ts -a <action> [options]

MR 操作:
  mr-view        查看 MR 详情
  mr-list        列出 MR (默认)
  mr-create      创建 MR
  mr-merge       合并 MR
  mr-diff        查看 MR 变更
  mr-discussions 查看 MR 讨论/评论
  mr-comment     添加 MR 评论
  mr-comment-code 添加代码行评论

Pipeline 操作:
  pipeline-list   列出 Pipeline
  pipeline-view   查看 Pipeline 详情
  pipeline-jobs   查看 Pipeline Jobs
  job-view        查看 Job 详情
  job-log         查看 Job 日志

Issue 操作:
  issue-view    查看 Issue 详情
  issue-list    列出 Issue
  issue-create  创建 Issue

参数:
  -a, --action      操作类型
  -m, --mr          MR IID
  -i, --issue       Issue IID
  -p, --pipeline    Pipeline ID
  -j, --job         Job ID
  -s, --source      源分支 (创建 MR 时)
  -t, --target      目标分支 (创建 MR 时, 默认 main)
  --title           标题 (创建 MR/Issue 时)
  -d, --description 描述
  --labels          标签 (逗号分隔)
  --project         项目路径 (默认自动检测)
  -l, --limit       列表数量 (默认 20)
  --state           状态过滤 (opened/closed/merged/all)
  --json            JSON 格式输出
  -h, --help        显示帮助

评论参数:
  -b, --body        评论内容
  -f, --file        文件路径 (代码评论时)
  --line            行号 (代码评论时)
  --line-type       行类型: new|old (代码评论时, 默认 new)

示例:
  node gitlab.ts -a mr-list                           # 列出 MR
  node gitlab.ts -a mr-view -m 123                    # 查看 MR #123
  node gitlab.ts -a mr-diff -m 123                    # 查看 MR #123 的 diff
  node gitlab.ts -a mr-discussions -m 123             # 查看 MR #123 的讨论
  node gitlab.ts -a mr-comment -m 123 -b "LGTM!"      # 添加普通评论
  node gitlab.ts -a mr-comment-code -m 123 -b "这里有问题" -f src/index.ts --line 42
  node gitlab.ts -a mr-create -s feat/xxx -t main --title "feat: xxx"
  node gitlab.ts -a mr-merge -m 123                   # 合并 MR #123
  node gitlab.ts -a pipeline-list                     # 列出 Pipeline
  node gitlab.ts -a job-view -j 1705650               # 查看 Job 详情
  node gitlab.ts -a job-log -j 1705650                # 查看 Job 日志
  node gitlab.ts -a issue-view -i 456                 # 查看 Issue #456
`);
}

// ================== HTTP 请求 ==================

function gitlabRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
    data?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const envFile = loadEnvFile();
  const token = envFile.GITLAB_TOKEN;

  if (!token) {
    throw new Error('请在 .env.local 中配置 GITLAB_TOKEN');
  }

  const url = new URL(endpoint, GITLAB_API_URL);
  const postData = options.data ? JSON.stringify(options.data) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            handleApiError(res.statusCode, data);
            return;
          }

          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`JSON 解析错误: ${data}`));
          }
        });
      },
    );

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function handleApiError(status: number, data: string): never {
  let message = '';
  try {
    const parsed = JSON.parse(data);
    message = parsed.message || parsed.error || data;
  } catch {
    message = data;
  }

  switch (status) {
    case 401:
      throw new Error('认证失败: 请检查 GITLAB_TOKEN 是否正确');
    case 403:
      throw new Error(`权限不足: ${message}`);
    case 404:
      throw new Error('资源不存在或无权访问');
    case 409:
      throw new Error(`冲突: ${message}`);
    case 422:
      throw new Error(`参数错误: ${message}`);
    case 429:
      throw new Error('请求过于频繁，请稍后重试');
    default:
      throw new Error(`GitLab API 错误: HTTP ${status} - ${message}`);
  }
}

// ================== GitLab API 操作 ==================

// MR 操作
async function getMergeRequest(
  projectId: string,
  mrIid: number,
): Promise<MergeRequest> {
  return gitlabRequest<MergeRequest>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}`,
  );
}

async function listMergeRequests(
  projectId: string,
  options: { state?: string; limit?: number } = {},
): Promise<MergeRequest[]> {
  const params = new URLSearchParams();
  params.set('per_page', String(options.limit || 20));
  if (options.state && options.state !== 'all') {
    params.set('state', options.state);
  }
  params.set('order_by', 'updated_at');
  params.set('sort', 'desc');

  return gitlabRequest<MergeRequest[]>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests?${params.toString()}`,
  );
}

async function createMergeRequest(
  projectId: string,
  data: {
    source_branch: string;
    target_branch: string;
    title: string;
    description?: string;
    labels?: string;
  },
): Promise<MergeRequest> {
  return gitlabRequest<MergeRequest>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests`,
    { method: 'POST', data },
  );
}

async function updateMergeRequest(
  projectId: string,
  mrIid: number,
  data: {
    title?: string;
    description?: string;
    target_branch?: string;
    labels?: string;
  },
): Promise<MergeRequest> {
  return gitlabRequest<MergeRequest>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}`,
    { method: 'PUT', data },
  );
}

async function mergeMergeRequest(
  projectId: string,
  mrIid: number,
): Promise<MergeRequest> {
  return gitlabRequest<MergeRequest>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/merge`,
    { method: 'PUT' },
  );
}

async function getMergeRequestDiffs(
  projectId: string,
  mrIid: number,
): Promise<MRDiff[]> {
  const result = await gitlabRequest<{ diffs: MRDiff[] }>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/changes`,
  );
  return result.diffs || [];
}

// MR 讨论/评论操作
async function getMergeRequestDiscussions(
  projectId: string,
  mrIid: number,
): Promise<MRDiscussion[]> {
  return gitlabRequest<MRDiscussion[]>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/discussions`,
  );
}

async function createMergeRequestNote(
  projectId: string,
  mrIid: number,
  body: string,
): Promise<MRNote> {
  return gitlabRequest<MRNote>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/notes`,
    { method: 'POST', data: { body } },
  );
}

async function createMergeRequestDiscussion(
  projectId: string,
  mrIid: number,
  body: string,
  position?: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    position_type: 'text';
    new_line?: number;
    old_line?: number;
  },
): Promise<MRDiscussion> {
  const data: Record<string, unknown> = { body };
  if (position) {
    data.position = position;
  }
  return gitlabRequest<MRDiscussion>(
    `${GITLAB_API_URL}/projects/${projectId}/merge_requests/${mrIid}/discussions`,
    { method: 'POST', data },
  );
}

// Pipeline 操作
async function listPipelines(
  projectId: string,
  options: { limit?: number } = {},
): Promise<Pipeline[]> {
  const params = new URLSearchParams();
  params.set('per_page', String(options.limit || 20));
  params.set('order_by', 'updated_at');
  params.set('sort', 'desc');

  return gitlabRequest<Pipeline[]>(
    `${GITLAB_API_URL}/projects/${projectId}/pipelines?${params.toString()}`,
  );
}

async function getPipeline(
  projectId: string,
  pipelineId: number,
): Promise<Pipeline> {
  return gitlabRequest<Pipeline>(
    `${GITLAB_API_URL}/projects/${projectId}/pipelines/${pipelineId}`,
  );
}

async function getPipelineJobs(
  projectId: string,
  pipelineId: number,
): Promise<PipelineJob[]> {
  return gitlabRequest<PipelineJob[]>(
    `${GITLAB_API_URL}/projects/${projectId}/pipelines/${pipelineId}/jobs`,
  );
}

// Job 操作
async function getJob(
  projectId: string,
  jobId: number,
): Promise<PipelineJob> {
  return gitlabRequest<PipelineJob>(
    `${GITLAB_API_URL}/projects/${projectId}/jobs/${jobId}`,
  );
}

async function getJobLog(
  projectId: string,
  jobId: number,
): Promise<string> {
  const envFile = loadEnvFile();
  const token = envFile.GITLAB_TOKEN;

  if (!token) {
    throw new Error('请在 .env.local 中配置 GITLAB_TOKEN');
  }

  const url = new URL(`${GITLAB_API_URL}/projects/${projectId}/jobs/${jobId}/trace`);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'GET',
        headers: {
          'PRIVATE-TOKEN': token,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`获取 Job 日志失败: HTTP ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

// Issue 操作
async function getIssue(projectId: string, issueIid: number): Promise<Issue> {
  return gitlabRequest<Issue>(
    `${GITLAB_API_URL}/projects/${projectId}/issues/${issueIid}`,
  );
}

async function listIssues(
  projectId: string,
  options: { state?: string; limit?: number } = {},
): Promise<Issue[]> {
  const params = new URLSearchParams();
  params.set('per_page', String(options.limit || 20));
  if (options.state && options.state !== 'all') {
    params.set('state', options.state);
  }
  params.set('order_by', 'updated_at');
  params.set('sort', 'desc');

  return gitlabRequest<Issue[]>(
    `${GITLAB_API_URL}/projects/${projectId}/issues?${params.toString()}`,
  );
}

async function createIssue(
  projectId: string,
  data: {
    title: string;
    description?: string;
    labels?: string;
  },
): Promise<Issue> {
  return gitlabRequest<Issue>(
    `${GITLAB_API_URL}/projects/${projectId}/issues`,
    { method: 'POST', data },
  );
}

// ================== 输出格式化 ==================

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatUser(user: GitLabUser | null): string {
  if (!user) return '-';
  return `${user.name} (@${user.username})`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes > 0) {
    return `${minutes}分${remainingSeconds}秒`;
  }
  return `${Math.floor(seconds)}秒`;
}

function getMRStateEmoji(state: string, draft: boolean): string {
  if (draft) return '📝';
  switch (state) {
    case 'opened':
      return '🟢';
    case 'merged':
      return '🟣';
    case 'closed':
      return '🔴';
    default:
      return '⚪';
  }
}

function getMRStateText(state: string, draft: boolean): string {
  if (draft) return 'Draft';
  switch (state) {
    case 'opened':
      return '开放';
    case 'merged':
      return '已合并';
    case 'closed':
      return '已关闭';
    default:
      return state;
  }
}

function getPipelineStatusEmoji(status: string): string {
  switch (status) {
    case 'success':
      return '✅';
    case 'failed':
      return '❌';
    case 'running':
      return '🔄';
    case 'pending':
      return '⏳';
    case 'canceled':
      return '⏹️';
    case 'skipped':
      return '⏭️';
    case 'manual':
      return '👆';
    default:
      return '❓';
  }
}

function getIssueStateEmoji(state: string): string {
  switch (state) {
    case 'opened':
      return '🟢';
    case 'closed':
      return '🔴';
    default:
      return '⚪';
  }
}

// ================== 打印函数 ==================

function printMergeRequest(mr: MergeRequest): void {
  const separator = '='.repeat(60);

  console.log(`\n${separator}`);
  console.log(`  !${mr.iid}: ${mr.title}`);
  console.log(`${separator}\n`);

  console.log('【基本信息】');
  console.log(
    `  状态:       ${getMRStateEmoji(mr.state, mr.draft)} ${getMRStateText(mr.state, mr.draft)}`,
  );
  console.log(`  源分支:     ${mr.source_branch}`);
  console.log(`  目标分支:   ${mr.target_branch}`);
  console.log(`  冲突:       ${mr.has_conflicts ? '❌ 有冲突' : '✅ 无冲突'}`);
  console.log(`  变更文件:   ${mr.changes_count} 个`);
  console.log('');

  console.log('【人员信息】');
  console.log(`  作者:       ${formatUser(mr.author)}`);
  console.log(
    `  指派:       ${mr.assignees.length > 0 ? mr.assignees.map(formatUser).join(', ') : '-'}`,
  );
  console.log(
    `  审核人:     ${mr.reviewers.length > 0 ? mr.reviewers.map(formatUser).join(', ') : '-'}`,
  );
  console.log('');

  console.log('【时间信息】');
  console.log(`  创建时间:   ${formatDate(mr.created_at)}`);
  console.log(`  更新时间:   ${formatDate(mr.updated_at)}`);
  if (mr.merged_at) {
    console.log(`  合并时间:   ${formatDate(mr.merged_at)}`);
    console.log(`  合并人:     ${formatUser(mr.merged_by)}`);
  }
  console.log('');

  if (mr.labels.length > 0) {
    console.log(`【标签】      ${mr.labels.join(', ')}`);
    console.log('');
  }

  if (mr.description) {
    console.log('【描述】');
    console.log(mr.description.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  }

  console.log(`【链接】      ${mr.web_url}`);
  console.log('');
}

function printMergeRequestList(mrs: MergeRequest[]): void {
  console.log(`\n📋 Merge Requests (共 ${mrs.length} 个)\n`);

  if (mrs.length === 0) {
    console.log('  暂无 MR\n');
    return;
  }

  for (const mr of mrs) {
    const emoji = getMRStateEmoji(mr.state, mr.draft);
    const state = getMRStateText(mr.state, mr.draft);
    const time = formatDate(mr.updated_at);

    console.log(
      `  ${emoji} !${mr.iid.toString().padEnd(5)} ${state.padEnd(6)} ${mr.title.slice(0, 50).padEnd(50)} ${time}`,
    );
    console.log(`     ${mr.source_branch} → ${mr.target_branch}`);
  }

  console.log('');
}

function printMRDiffs(diffs: MRDiff[]): void {
  console.log(`\n📝 MR 变更 (共 ${diffs.length} 个文件)\n`);

  for (const diff of diffs) {
    let prefix = '  ';
    if (diff.new_file) {
      prefix = '+ ';
    } else if (diff.deleted_file) {
      prefix = '- ';
    } else if (diff.renamed_file) {
      prefix = '→ ';
    }

    const filePath = diff.renamed_file
      ? `${diff.old_path} → ${diff.new_path}`
      : diff.new_path;

    console.log(`${prefix}${filePath}`);

    if (diff.diff) {
      console.log('');
      // 只显示前 50 行 diff
      const lines = diff.diff.split('\n').slice(0, 50);
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          console.log(`  \x1b[32m${line}\x1b[0m`);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          console.log(`  \x1b[31m${line}\x1b[0m`);
        } else if (line.startsWith('@@')) {
          console.log(`  \x1b[36m${line}\x1b[0m`);
        } else {
          console.log(`  ${line}`);
        }
      }
      if (diff.diff.split('\n').length > 50) {
        console.log(`  ... (省略剩余行)`);
      }
      console.log('');
    }
  }
}

function printPipeline(pipeline: Pipeline): void {
  const separator = '='.repeat(60);

  console.log(`\n${separator}`);
  console.log(`  Pipeline #${pipeline.id}`);
  console.log(`${separator}\n`);

  console.log('【基本信息】');
  console.log(
    `  状态:       ${getPipelineStatusEmoji(pipeline.status)} ${pipeline.status}`,
  );
  console.log(`  分支:       ${pipeline.ref}`);
  console.log(`  Commit:     ${pipeline.sha.slice(0, 8)}`);
  console.log(`  耗时:       ${formatDuration(pipeline.duration)}`);
  console.log('');

  console.log('【时间信息】');
  console.log(`  创建时间:   ${formatDate(pipeline.created_at)}`);
  if (pipeline.started_at) {
    console.log(`  开始时间:   ${formatDate(pipeline.started_at)}`);
  }
  if (pipeline.finished_at) {
    console.log(`  完成时间:   ${formatDate(pipeline.finished_at)}`);
  }
  console.log('');

  console.log(`【触发者】    ${formatUser(pipeline.user)}`);
  console.log(`【链接】      ${pipeline.web_url}`);
  console.log('');
}

function printPipelineList(pipelines: Pipeline[]): void {
  console.log(`\n📋 Pipelines (共 ${pipelines.length} 个)\n`);

  if (pipelines.length === 0) {
    console.log('  暂无 Pipeline\n');
    return;
  }

  for (const p of pipelines) {
    const emoji = getPipelineStatusEmoji(p.status);
    const time = formatDate(p.created_at);
    const duration = formatDuration(p.duration);

    console.log(
      `  ${emoji} #${p.id.toString().padEnd(8)} ${p.status.padEnd(10)} ${p.ref.slice(0, 30).padEnd(30)} ${duration.padEnd(10)} ${time}`,
    );
  }

  console.log('');
}

function printPipelineJobs(jobs: PipelineJob[]): void {
  console.log(`\n📋 Pipeline Jobs (共 ${jobs.length} 个)\n`);

  // 按 stage 分组
  const stages = new Map<string, PipelineJob[]>();
  for (const job of jobs) {
    const stageJobs = stages.get(job.stage) || [];
    stageJobs.push(job);
    stages.set(job.stage, stageJobs);
  }

  for (const [stage, stageJobs] of stages) {
    console.log(`  📦 ${stage}`);
    for (const job of stageJobs) {
      const emoji = getPipelineStatusEmoji(job.status);
      const duration = formatDuration(job.duration);
      console.log(`     ${emoji} ${job.name.padEnd(30)} ${duration}`);
    }
    console.log('');
  }
}

function printJob(job: PipelineJob): void {
  const separator = '='.repeat(60);

  console.log(`\n${separator}`);
  console.log(`  Job #${job.id}: ${job.name}`);
  console.log(`${separator}\n`);

  console.log('【基本信息】');
  console.log(`  状态:       ${getPipelineStatusEmoji(job.status)} ${job.status}`);
  console.log(`  阶段:       ${job.stage}`);
  console.log(`  分支:       ${job.ref || '-'}`);
  console.log(`  耗时:       ${formatDuration(job.duration)}`);
  if (job.failure_reason) {
    console.log(`  失败原因:   ${job.failure_reason}`);
  }
  console.log('');

  if (job.started_at || job.finished_at) {
    console.log('【时间信息】');
    if (job.started_at) {
      console.log(`  开始时间:   ${formatDate(job.started_at)}`);
    }
    if (job.finished_at) {
      console.log(`  完成时间:   ${formatDate(job.finished_at)}`);
    }
    console.log('');
  }

  if (job.user) {
    console.log(`【触发者】    ${formatUser(job.user)}`);
  }

  if (job.commit) {
    console.log('【Commit】');
    console.log(`  SHA:        ${job.commit.short_id}`);
    console.log(`  标题:       ${job.commit.title.slice(0, 60)}`);
    console.log('');
  }

  if (job.pipeline) {
    console.log('【Pipeline】');
    console.log(`  ID:         ${job.pipeline.id}`);
    console.log(`  状态:       ${getPipelineStatusEmoji(job.pipeline.status)} ${job.pipeline.status}`);
    console.log(`  链接:       ${job.pipeline.web_url}`);
    console.log('');
  }

  if (job.runner) {
    console.log('【Runner】');
    console.log(`  ID:         ${job.runner.id}`);
    console.log(`  描述:       ${job.runner.description}`);
    console.log('');
  }

  console.log(`【链接】      ${job.web_url}`);
  console.log('');
}

function printJobLog(log: string, lines: number = 100): void {
  const logLines = log.split('\n');
  const displayLines = logLines.slice(-lines);

  if (logLines.length > lines) {
    console.log(`\n... (省略前 ${logLines.length - lines} 行)\n`);
  }

  for (const line of displayLines) {
    // 简单的 ANSI 颜色处理，保留一些基本格式
    console.log(line);
  }
}

function printIssue(issue: Issue): void {
  const separator = '='.repeat(60);

  console.log(`\n${separator}`);
  console.log(`  #${issue.iid}: ${issue.title}`);
  console.log(`${separator}\n`);

  console.log('【基本信息】');
  console.log(`  状态:       ${getIssueStateEmoji(issue.state)} ${issue.state}`);
  console.log('');

  console.log('【人员信息】');
  console.log(`  作者:       ${formatUser(issue.author)}`);
  console.log(
    `  指派:       ${issue.assignees.length > 0 ? issue.assignees.map(formatUser).join(', ') : '-'}`,
  );
  console.log('');

  console.log('【时间信息】');
  console.log(`  创建时间:   ${formatDate(issue.created_at)}`);
  console.log(`  更新时间:   ${formatDate(issue.updated_at)}`);
  if (issue.closed_at) {
    console.log(`  关闭时间:   ${formatDate(issue.closed_at)}`);
  }
  console.log('');

  if (issue.labels.length > 0) {
    console.log(`【标签】      ${issue.labels.join(', ')}`);
    console.log('');
  }

  if (issue.description) {
    console.log('【描述】');
    console.log(issue.description.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  }

  console.log(`【链接】      ${issue.web_url}`);
  console.log('');
}

function printIssueList(issues: Issue[]): void {
  console.log(`\n📋 Issues (共 ${issues.length} 个)\n`);

  if (issues.length === 0) {
    console.log('  暂无 Issue\n');
    return;
  }

  for (const issue of issues) {
    const emoji = getIssueStateEmoji(issue.state);
    const time = formatDate(issue.updated_at);

    console.log(
      `  ${emoji} #${issue.iid.toString().padEnd(5)} ${issue.state.padEnd(6)} ${issue.title.slice(0, 50).padEnd(50)} ${time}`,
    );
  }

  console.log('');
}

function printMRDiscussions(discussions: MRDiscussion[]): void {
  // 过滤掉系统消息
  const userDiscussions = discussions.filter(
    (d) => !d.notes[0]?.system,
  );

  console.log(`\n💬 MR 讨论 (共 ${userDiscussions.length} 个)\n`);

  if (userDiscussions.length === 0) {
    console.log('  暂无讨论\n');
    return;
  }

  for (const discussion of userDiscussions) {
    const firstNote = discussion.notes[0];
    if (!firstNote) continue;

    const resolved = firstNote.resolvable
      ? firstNote.resolved
        ? '✅ 已解决'
        : '⏳ 待解决'
      : '';

    // 检查是否是代码评论
    if (firstNote.position) {
      const pos = firstNote.position;
      const lineInfo = pos.new_line
        ? `+${pos.new_line}`
        : pos.old_line
          ? `-${pos.old_line}`
          : '';
      console.log(
        `  📝 ${pos.new_path}:${lineInfo} ${resolved}`,
      );
    } else {
      console.log(`  💬 普通评论 ${resolved}`);
    }

    // 打印所有 notes
    for (const note of discussion.notes) {
      if (note.system) continue;
      const author = formatUser(note.author);
      const time = formatDate(note.created_at);
      console.log(`     ${author} (${time}):`);
      // 缩进评论内容
      const lines = note.body.split('\n');
      for (const line of lines.slice(0, 10)) {
        console.log(`       ${line}`);
      }
      if (lines.length > 10) {
        console.log(`       ... (省略 ${lines.length - 10} 行)`);
      }
    }
    console.log('');
  }
}

// ================== 主要操作 ==================

async function doMRView(
  projectId: string,
  mrIid: number,
  json: boolean,
): Promise<void> {
  const mr = await getMergeRequest(projectId, mrIid);
  if (json) {
    console.log(JSON.stringify(mr, null, 2));
  } else {
    printMergeRequest(mr);
  }
}

async function doMRList(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  const mrs = await listMergeRequests(projectId, {
    state: options.state || 'opened',
    limit: options.limit,
  });
  if (options.json) {
    console.log(JSON.stringify(mrs, null, 2));
  } else {
    printMergeRequestList(mrs);
  }
}

async function doMRCreate(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  if (!options.sourceBranch) {
    throw new Error('创建 MR 需要指定源分支 (-s 参数)');
  }
  if (!options.title) {
    throw new Error('创建 MR 需要指定标题 (--title 参数)');
  }

  const mr = await createMergeRequest(projectId, {
    source_branch: options.sourceBranch,
    target_branch: options.targetBranch || 'main',
    title: options.title,
    description: options.description || undefined,
    labels: options.labels || undefined,
  });

  console.log(`\n✅ MR 创建成功!`);
  console.log(`   !${mr.iid}: ${mr.title}`);
  console.log(`   ${mr.web_url}\n`);
}

async function doMRUpdate(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  if (!options.mrIid) {
    throw new Error('更新 MR 需要指定 MR IID (-m 参数)');
  }
  if (!options.title && !options.description && !options.targetBranch && !options.labels) {
    throw new Error('更新 MR 需要指定至少一个更新字段 (--title, --description, -t, --labels)');
  }

  const data: {
    title?: string;
    description?: string;
    target_branch?: string;
    labels?: string;
  } = {};

  if (options.title) data.title = options.title;
  if (options.description) data.description = options.description;
  if (options.targetBranch) data.target_branch = options.targetBranch;
  if (options.labels) data.labels = options.labels;

  const mr = await updateMergeRequest(projectId, options.mrIid, data);

  console.log(`\n✅ MR 更新成功!`);
  console.log(`   !${mr.iid}: ${mr.title}`);
  console.log(`   ${mr.web_url}\n`);
}

async function doMRMerge(
  projectId: string,
  mrIid: number,
): Promise<void> {
  const mr = await mergeMergeRequest(projectId, mrIid);

  console.log(`\n✅ MR 合并成功!`);
  console.log(`   !${mr.iid}: ${mr.title}`);
  console.log(`   ${mr.source_branch} → ${mr.target_branch}\n`);
}

async function doMRDiff(
  projectId: string,
  mrIid: number,
  json: boolean,
): Promise<void> {
  const diffs = await getMergeRequestDiffs(projectId, mrIid);
  if (json) {
    console.log(JSON.stringify(diffs, null, 2));
  } else {
    printMRDiffs(diffs);
  }
}

async function doMRDiscussions(
  projectId: string,
  mrIid: number,
  json: boolean,
): Promise<void> {
  const discussions = await getMergeRequestDiscussions(projectId, mrIid);
  if (json) {
    console.log(JSON.stringify(discussions, null, 2));
  } else {
    printMRDiscussions(discussions);
  }
}

async function doMRComment(
  projectId: string,
  mrIid: number,
  body: string,
): Promise<void> {
  const note = await createMergeRequestNote(projectId, mrIid, body);
  console.log(`\n✅ 评论添加成功!`);
  console.log(`   作者: ${formatUser(note.author)}`);
  console.log(`   时间: ${formatDate(note.created_at)}`);
  console.log(`   内容: ${note.body.slice(0, 100)}${note.body.length > 100 ? '...' : ''}\n`);
}

async function doMRCommentCode(
  projectId: string,
  mrIid: number,
  body: string,
  filePath: string,
  line: number,
  lineType: 'new' | 'old',
): Promise<void> {
  // 先获取 MR 的 diff_refs
  const mr = await getMergeRequest(projectId, mrIid);
  const diffRefs = (mr as unknown as { diff_refs: { base_sha: string; start_sha: string; head_sha: string } }).diff_refs;

  if (!diffRefs) {
    throw new Error('无法获取 MR 的 diff_refs');
  }

  const position: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    position_type: 'text';
    new_line?: number;
    old_line?: number;
  } = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    old_path: filePath,
    new_path: filePath,
    position_type: 'text',
  };

  if (lineType === 'new') {
    position.new_line = line;
  } else {
    position.old_line = line;
  }

  const discussion = await createMergeRequestDiscussion(
    projectId,
    mrIid,
    body,
    position,
  );

  console.log(`\n✅ 代码评论添加成功!`);
  console.log(`   文件: ${filePath}:${line}`);
  console.log(`   内容: ${body.slice(0, 100)}${body.length > 100 ? '...' : ''}\n`);
}

async function doPipelineList(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  const pipelines = await listPipelines(projectId, { limit: options.limit });
  if (options.json) {
    console.log(JSON.stringify(pipelines, null, 2));
  } else {
    printPipelineList(pipelines);
  }
}

async function doPipelineView(
  projectId: string,
  pipelineId: number,
  json: boolean,
): Promise<void> {
  const pipeline = await getPipeline(projectId, pipelineId);
  if (json) {
    console.log(JSON.stringify(pipeline, null, 2));
  } else {
    printPipeline(pipeline);
  }
}

async function doPipelineJobs(
  projectId: string,
  pipelineId: number,
  json: boolean,
): Promise<void> {
  const jobs = await getPipelineJobs(projectId, pipelineId);
  if (json) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    printPipelineJobs(jobs);
  }
}

async function doJobView(
  projectId: string,
  jobId: number,
  json: boolean,
): Promise<void> {
  const job = await getJob(projectId, jobId);
  if (json) {
    console.log(JSON.stringify(job, null, 2));
  } else {
    printJob(job);
  }
}

async function doJobLog(
  projectId: string,
  jobId: number,
  lines: number = 100,
): Promise<void> {
  const job = await getJob(projectId, jobId);
  console.log(`\n📋 Job #${job.id}: ${job.name}`);
  console.log(`   状态: ${getPipelineStatusEmoji(job.status)} ${job.status}`);
  console.log(`${'='.repeat(60)}\n`);

  const log = await getJobLog(projectId, jobId);
  printJobLog(log, lines);
}

async function doIssueView(
  projectId: string,
  issueIid: number,
  json: boolean,
): Promise<void> {
  const issue = await getIssue(projectId, issueIid);
  if (json) {
    console.log(JSON.stringify(issue, null, 2));
  } else {
    printIssue(issue);
  }
}

async function doIssueList(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  const issues = await listIssues(projectId, {
    state: options.state || 'opened',
    limit: options.limit,
  });
  if (options.json) {
    console.log(JSON.stringify(issues, null, 2));
  } else {
    printIssueList(issues);
  }
}

async function doIssueCreate(
  projectId: string,
  options: CLIOptions,
): Promise<void> {
  if (!options.title) {
    throw new Error('创建 Issue 需要指定标题 (--title 参数)');
  }

  const issue = await createIssue(projectId, {
    title: options.title,
    description: options.description || undefined,
    labels: options.labels || undefined,
  });

  console.log(`\n✅ Issue 创建成功!`);
  console.log(`   #${issue.iid}: ${issue.title}`);
  console.log(`   ${issue.web_url}\n`);
}

// ================== 主程序 ==================

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  try {
    // 确定项目 ID
    let projectId = options.project;
    if (!projectId) {
      projectId = getProjectIdFromGit();
      if (!projectId) {
        console.error('❌ 无法识别当前项目,请使用 --project 参数指定项目路径');
        console.error('   例如: --project TryMoka/hcm-platform-fe');
        process.exit(1);
      }
    } else {
      projectId = encodeURIComponent(projectId);
    }

    // 执行操作
    switch (options.action) {
      case 'mr-view':
        if (!options.mrIid) {
          throw new Error('查看 MR 需要指定 MR IID (-m 参数)');
        }
        await doMRView(projectId, options.mrIid, options.json);
        break;

      case 'mr-list':
        await doMRList(projectId, options);
        break;

      case 'mr-create':
        await doMRCreate(projectId, options);
        break;

      case 'mr-update':
        await doMRUpdate(projectId, options);
        break;

      case 'mr-merge':
        if (!options.mrIid) {
          throw new Error('合并 MR 需要指定 MR IID (-m 参数)');
        }
        await doMRMerge(projectId, options.mrIid);
        break;

      case 'mr-diff':
        if (!options.mrIid) {
          throw new Error('查看 MR diff 需要指定 MR IID (-m 参数)');
        }
        await doMRDiff(projectId, options.mrIid, options.json);
        break;

      case 'mr-discussions':
        if (!options.mrIid) {
          throw new Error('查看 MR 讨论需要指定 MR IID (-m 参数)');
        }
        await doMRDiscussions(projectId, options.mrIid, options.json);
        break;

      case 'mr-comment':
        if (!options.mrIid) {
          throw new Error('添加 MR 评论需要指定 MR IID (-m 参数)');
        }
        if (!options.body) {
          throw new Error('添加评论需要指定评论内容 (-b 参数)');
        }
        await doMRComment(projectId, options.mrIid, options.body);
        break;

      case 'mr-comment-code':
        if (!options.mrIid) {
          throw new Error('添加代码评论需要指定 MR IID (-m 参数)');
        }
        if (!options.body) {
          throw new Error('添加评论需要指定评论内容 (-b 参数)');
        }
        if (!options.filePath) {
          throw new Error('添加代码评论需要指定文件路径 (-f 参数)');
        }
        if (!options.line) {
          throw new Error('添加代码评论需要指定行号 (--line 参数)');
        }
        await doMRCommentCode(
          projectId,
          options.mrIid,
          options.body,
          options.filePath,
          options.line,
          options.lineType || 'new',
        );
        break;

      case 'pipeline-list':
        await doPipelineList(projectId, options);
        break;

      case 'pipeline-view':
        if (!options.pipelineId) {
          throw new Error('查看 Pipeline 需要指定 Pipeline ID (-p 参数)');
        }
        await doPipelineView(projectId, options.pipelineId, options.json);
        break;

      case 'pipeline-jobs':
        if (!options.pipelineId) {
          throw new Error('查看 Pipeline Jobs 需要指定 Pipeline ID (-p 参数)');
        }
        await doPipelineJobs(projectId, options.pipelineId, options.json);
        break;

      case 'job-view':
        if (!options.jobId) {
          throw new Error('查看 Job 需要指定 Job ID (-j 参数)');
        }
        await doJobView(projectId, options.jobId, options.json);
        break;

      case 'job-log':
        if (!options.jobId) {
          throw new Error('查看 Job 日志需要指定 Job ID (-j 参数)');
        }
        await doJobLog(projectId, options.jobId, options.limit);
        break;

      case 'issue-view':
        if (!options.issueIid) {
          throw new Error('查看 Issue 需要指定 Issue IID (-i 参数)');
        }
        await doIssueView(projectId, options.issueIid, options.json);
        break;

      case 'issue-list':
        await doIssueList(projectId, options);
        break;

      case 'issue-create':
        await doIssueCreate(projectId, options);
        break;

      default:
        console.error(`❌ 未知操作: ${options.action}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ 错误: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

main();
