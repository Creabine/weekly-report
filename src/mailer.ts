import nodemailer from 'nodemailer';
import type { Config, DateRange } from './collectors.ts';

export async function sendMail(
  config: Config,
  html: string,
  dateRange: DateRange,
): Promise<void> {
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    throw new Error('缺少 SMTP 配置，请在 .env 中配置 SMTP_USER 和 SMTP_PASS');
  }
  if (config.MAIL_TO.length === 0) {
    throw new Error('缺少收件人，请在 .env 中配置 MAIL_TO');
  }

  const formatDate = (d: string) => d.replace(/-/g, '.');
  const subject = config.MAIL_SUBJECT_TEMPLATE
    .replace('{author}', config.MAIL_AUTHOR_NAME)
    .replace('{dateRange}', `${formatDate(dateRange.from)}-${formatDate(dateRange.to)}`);

  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });

  console.error(`[邮件] 发送到 ${config.MAIL_TO.join(', ')}...`);

  await transporter.sendMail({
    from: config.SMTP_USER,
    to: config.MAIL_TO.join(', '),
    cc: config.MAIL_CC.length > 0 ? config.MAIL_CC.join(', ') : undefined,
    subject,
    html,
  });

  console.error('  发送成功!');
}
