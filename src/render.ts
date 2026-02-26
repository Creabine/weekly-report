import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { WeeklyData, JiraItem, MRDetail, Config } from './collectors.ts';

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

export function generateMarkdown(data: WeeklyData, config: Config): string {
  const { dateRange, mrs, mrDetails } = data;
  const lines: string[] = [];
  const keyPattern = /[A-Z][A-Z0-9]+-\d+/g;
  const jiraUrl = (key: string) => `${config.JIRA_HOST}/browse/${key}`;

  lines.push(`# 周报 ${formatDate(dateRange.from)} - ${formatDate(dateRange.to)}`);
  lines.push('');

  // 本周完成 - 按 MR 分组，列出 commits
  lines.push('## 本周完成');
  lines.push('');

  if (mrDetails.length > 0) {
    for (const detail of mrDetails) {
      const { mr, commits, deployStatus, isHotfix } = detail;
      // 从 MR title 提取 Jira key
      const keys = [...mr.title.matchAll(keyPattern)].map(m => m[0]);
      const jiraKey = keys[0];
      const statusTag = `(${deployStatus})`;
      const hotfixTag = isHotfix ? ' [hotfix]' : '';

      if (jiraKey) {
        lines.push(`### [${jiraKey}](${jiraUrl(jiraKey)}) ${mr.title} ${statusTag}${hotfixTag}`);
      } else {
        lines.push(`### ${mr.title} ${statusTag}${hotfixTag}`);
      }

      for (const commit of commits) {
        lines.push(`- ${commit.message}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_本周无 MR 记录_');
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

function getTemplate(templateName: string): string | null {
  const templatesDir = path.resolve(process.cwd(), 'templates');
  const filePath = path.join(templatesDir, `${templateName}.html`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

export async function renderHTML(markdown: string, templateName = 'email-cerberus-light'): Promise<string> {
  const renderer = new marked.Renderer();
  renderer.link = ({ href, text }) => {
    return `<a href="${href}" target="_blank">${text}</a>`;
  };
  const htmlBody = (await marked(markdown, { renderer }))
    .replace(/<ul>/g, '<ul style="padding-left:0;margin:8px 0;list-style:none;">')
    .replace(/<li>/g, '<li style="position:relative;padding:8px 12px 8px 24px;margin-bottom:4px;background:#f8f9fb;border-radius:6px;font-size:13.5px;line-height:1.6;color:#374151;list-style:none;"><span style="position:absolute;left:10px;color:#667eea;font-size:12px;">▸</span>');
  const template = getTemplate(templateName);

  const footer = 'Powered by <a href="https://github.com/Creabine/weekly-report" target="_blank">weekly-report</a>';

  if (template) {
    return template.replace('{{content}}', htmlBody).replace('{{footer}}', footer);
  }

  // 无模板时使用内联样式
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333;">
${htmlBody}
<footer style="color: #999; font-size: 12px; padding-top: 15px;">${footer}</footer>
</body>
</html>`;
}
