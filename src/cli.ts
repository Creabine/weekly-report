import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { loadConfig, collectAll } from './collectors.ts';
import type { DateRange } from './collectors.ts';
import { generateMarkdown, saveDraft, getLatestDraft, renderHTML } from './render.ts';
import { sendMail } from './mailer.ts';

// ================== 日期工具 ==================

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function formatDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getThisWeekRange(): DateRange {
  const today = new Date();
  const monday = getMonday(today);
  return { from: formatDateStr(monday), to: formatDateStr(today) };
}

function getLastWeekRange(): DateRange {
  const today = new Date();
  const thisMonday = getMonday(today);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastFriday = new Date(lastMonday);
  lastFriday.setDate(lastFriday.getDate() + 4);
  return { from: formatDateStr(lastMonday), to: formatDateStr(lastFriday) };
}

// ================== 交互式输入 ==================

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveDateRange(): Promise<DateRange> {
  console.error('? 选择日期范围:');
  console.error('  1) 本周（周一 ~ 今天）');
  console.error('  2) 上周（上周一 ~ 上周五）');
  console.error('  3) 自定义范围');

  const choice = await ask('> ');

  switch (choice) {
    case '1': return getThisWeekRange();
    case '2': return getLastWeekRange();
    case '3': {
      const from = await ask('起始日期 (yyyy-MM-dd): ');
      const to = await ask('结束日期 (yyyy-MM-dd): ');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        console.error('日期格式错误，使用默认本周范围');
        return getThisWeekRange();
      }
      return { from, to };
    }
    default:
      return getThisWeekRange();
  }
}

// ================== 参数解析 ==================

interface CLIArgs {
  command: 'draft' | 'preview' | 'send' | 'run' | 'help';
  interactive: boolean;
  from: string | null;
  to: string | null;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = { command: 'help', interactive: false, from: null, to: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case 'draft': case 'preview': case 'send': case 'run':
        result.command = arg;
        break;
      case '-i': case '--interactive':
        result.interactive = true;
        break;
      case '--from':
        result.from = args[++i];
        break;
      case '--to':
        result.to = args[++i];
        break;
      case '-h': case '--help': case 'help':
        result.command = 'help';
        break;
    }
  }

  return result;
}

async function resolveDateRange(args: CLIArgs): Promise<DateRange> {
  if (args.from && args.to) return { from: args.from, to: args.to };
  if (args.interactive) return interactiveDateRange();
  return getThisWeekRange();
}

// ================== 命令实现 ==================

async function cmdDraft(args: CLIArgs): Promise<void> {
  const config = loadConfig();
  const range = await resolveDateRange(args);

  console.error(`\n📋 收集 ${range.from} ~ ${range.to} 的工作数据...\n`);

  const data = await collectAll(config, range);
  const markdown = generateMarkdown(data, config);
  const filePath = saveDraft(markdown, range.to);

  console.error(`\n✅ 草稿已生成: ${filePath}`);
}

async function cmdPreview(): Promise<void> {
  const draftPath = getLatestDraft();
  if (!draftPath) {
    console.error('没有找到草稿文件，请先运行 draft 命令');
    process.exit(1);
  }

  const markdown = fs.readFileSync(draftPath, 'utf-8');
  const config = loadConfig();
  const html = await renderHTML(markdown, config.MAIL_TEMPLATE);

  const tmpPath = path.resolve(process.cwd(), 'drafts', 'preview.html');
  fs.writeFileSync(tmpPath, html, 'utf-8');

  console.error(`预览文件: ${tmpPath}`);
  try {
    execSync(`open "${tmpPath}"`, { stdio: 'ignore' });
  } catch {
    console.error('无法自动打开浏览器，请手动打开上述文件');
  }
}

async function cmdSend(): Promise<void> {
  const draftPath = getLatestDraft();
  if (!draftPath) {
    console.error('没有找到草稿文件，请先运行 draft 命令');
    process.exit(1);
  }

  const config = loadConfig();
  const markdown = fs.readFileSync(draftPath, 'utf-8');
  const html = await renderHTML(markdown, config.MAIL_TEMPLATE);

  // 从文件名解析日期范围
  const fileName = path.basename(draftPath, '.md');
  const firstLine = markdown.split('\n')[0] || '';
  const dateMatch = firstLine.match(/(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})/);
  const range: DateRange = dateMatch
    ? { from: dateMatch[1].replace(/\./g, '-'), to: dateMatch[2].replace(/\./g, '-') }
    : { from: fileName, to: fileName };

  const confirm = await ask(`确认发送周报到 ${config.MAIL_TO.join(', ')}? (y/N) `);
  if (confirm.toLowerCase() !== 'y') {
    console.error('已取消');
    return;
  }

  await sendMail(config, html, range);
}

async function cmdRun(args: CLIArgs): Promise<void> {
  await cmdDraft(args);

  const draftPath = getLatestDraft();
  if (!draftPath) return;

  // 尝试用编辑器打开
  const editor = process.env.EDITOR || 'code';
  try {
    if (editor === 'code') {
      execSync(`code --wait "${draftPath}"`, { stdio: 'inherit' });
    } else {
      execSync(`${editor} "${draftPath}"`, { stdio: 'inherit' });
    }
  } catch {
    console.error(`请手动编辑草稿: ${draftPath}`);
    const done = await ask('编辑完成后按回车继续...');
  }

  const sendConfirm = await ask('是否发送? (y/N) ');
  if (sendConfirm.toLowerCase() === 'y') {
    await cmdSend();
  }
}

function printHelp(): void {
  console.log(`
周报自动化工具

使用方式:
  weekly-report <command> [options]

命令:
  draft     收集数据 + 生成 Markdown 草稿
  preview   浏览器预览邮件 HTML
  send      发送最新草稿
  run       draft → 编辑 → 确认发送

选项:
  -i, --interactive   交互式选择日期范围
  --from <date>       起始日期 (yyyy-MM-dd)
  --to <date>         结束日期 (yyyy-MM-dd)
  -h, --help          显示帮助

示例:
  weekly-report draft                          # 默认本周一到今天
  weekly-report draft -i                       # 交互式选择日期
  weekly-report draft --from 2026-02-16 --to 2026-02-20
  weekly-report run                            # 一键流程
`);
}

// ================== 入口 ==================

async function main(): Promise<void> {
  const args = parseArgs();

  switch (args.command) {
    case 'draft': await cmdDraft(args); break;
    case 'preview': await cmdPreview(); break;
    case 'send': await cmdSend(); break;
    case 'run': await cmdRun(args); break;
    case 'help': printHelp(); break;
  }
}

main().catch((err) => {
  console.error(`\n错误: ${(err as Error).message}`);
  process.exit(1);
});
