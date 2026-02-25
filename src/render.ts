import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { WeeklyData, JiraItem } from './collectors.ts';

// ================== Markdown 草稿生成 ==================

function formatDate(d: string): string {
  return d.replace(/-/g, '.');
}

function stateEmoji(state: string): string {
  switch (state) {
    case 'merged': return '✅';
    case 'opened': return '🔵';
    case 'closed': return '🔴';
    default: return '⬜';
  }
}

function capitalizeState(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function generateMarkdown(data: WeeklyData): string {
  const { dateRange, mrs, jiraIssues, gitSummary } = data;
  const lines: string[] = [];

  lines.push(`# 周报 ${formatDate(dateRange.from)} - ${formatDate(dateRange.to)}`);
  lines.push('');

  // 本周完成 - 按 Jira issue 类型分组
  lines.push('## 本周完成');
  lines.push('');

  const bugs = jiraIssues.filter(i => /bug/i.test(i.type));
  const features = jiraIssues.filter(i => !/bug/i.test(i.type));

  if (features.length > 0) {
    lines.push('### 需求开发');
    for (const issue of features) {
      lines.push(`- [${issue.key}] ${issue.summary} (${issue.status})`);
    }
    lines.push('');
  }

  if (bugs.length > 0) {
    lines.push('### Bug 修复');
    for (const issue of bugs) {
      lines.push(`- [${issue.key}] ${issue.summary} (${issue.status})`);
    }
    lines.push('');
  }

  if (jiraIssues.length === 0) {
    lines.push('_本周无 Jira Issue 记录_');
    lines.push('');
  }

  // Merge Requests 表格
  if (mrs.length > 0) {
    lines.push('## Merge Requests');
    lines.push('| MR | 状态 | 目标分支 |');
    lines.push('|----|------|----------|');
    for (const mr of mrs) {
      lines.push(`| [${mr.title}](${mr.url}) | ${stateEmoji(mr.state)} ${capitalizeState(mr.state)} | ${mr.targetBranch} |`);
    }
    lines.push('');
  }

  // Git 提交摘要
  if (gitSummary.length > 0) {
    lines.push('## 代码提交摘要');
    for (const repo of gitSummary) {
      lines.push(`- ${repo.repo}: ${repo.commitCount} commits`);
    }
    lines.push('');
  }

  // 补充内容
  lines.push('## 补充内容');
  lines.push('<!-- 在这里添加你的补充内容，如：下周计划、遇到的问题、需要协调的事项等 -->');
  lines.push('');

  return lines.join('\n');
}

// ================== 草稿文件操作 ==================

function getDraftsDir(): string {
  const dir = path.resolve(process.cwd(), 'drafts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function saveDraft(markdown: string, toDate: string): string {
  const draftsDir = getDraftsDir();
  const filePath = path.join(draftsDir, `${toDate}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  return filePath;
}

export function getLatestDraft(): string | null {
  const draftsDir = getDraftsDir();
  const files = fs.readdirSync(draftsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(draftsDir, files[0]) : null;
}

// ================== HTML 渲染 ==================

function getRandomTemplate(): string | null {
  const templatesDir = path.resolve(process.cwd(), 'templates');
  if (!fs.existsSync(templatesDir)) return null;

  const templates = fs.readdirSync(templatesDir).filter(f => f.startsWith('email-') && f.endsWith('.html'));
  if (templates.length === 0) return null;

  const chosen = templates[Math.floor(Math.random() * templates.length)];
  return fs.readFileSync(path.join(templatesDir, chosen), 'utf-8');
}

export async function renderHTML(markdown: string): Promise<string> {
  const htmlBody = await marked(markdown);
  const template = getRandomTemplate();

  if (template) {
    return template.replace('{{content}}', htmlBody);
  }

  // 无模板时使用内联样式
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333;">
${htmlBody}
</body>
</html>`;
}
