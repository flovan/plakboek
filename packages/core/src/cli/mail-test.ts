/**
 * `plakboek mail:test <address>`: the headless delivery check (D-10). It sends
 * the real sign-in template, marked as a test, through the same lazy sender
 * the running site uses, and needs no database, secret or host config.
 */
import { MailSendError } from '@plakboek/auth';
import { PlakboekEnvError, readMailEnv } from '../runtime/env.js';
import {
  MailNotConfiguredError,
  buildTestEmail,
  createLazyMailSender,
} from '../runtime/mail.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  UsageError,
  messageOf,
  oneLine,
  parseFlags,
  printError,
  printLine,
} from './output.js';

export const MAIL_TEST_HELP = `Usage: plakboek mail:test <address>

Sends one test email to <address> using the real sign-in email template, to
check that the mail settings deliver. In development without an SMTP server
the message is printed to the console instead.

Environment:
  PLAKBOEK_URL          The installation's public origin (required)
  PLAKBOEK_MAIL_FROM    The sender address, such as no-reply@example.org
  PLAKBOEK_SMTP_HOST, PLAKBOEK_SMTP_PORT, PLAKBOEK_SMTP_SECURE,
  PLAKBOEK_SMTP_USER, PLAKBOEK_SMTP_PASS   The SMTP server

Options:
  -h, --help            Show this help`;

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The transport's own error text: the `cause` of a `MailSendError`, else its
 * message, on one line with any SMTP credential removed. */
function transportMessage(error: unknown, secrets: readonly string[]): string {
  const detail =
    error instanceof MailSendError && error.cause !== undefined
      ? messageOf(error.cause)
      : messageOf(error);
  return oneLine(detail, secrets);
}

export async function runMailTestCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values, positionals } = parseFlags(argv, {
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    printLine(MAIL_TEST_HELP);
    return EXIT_OK;
  }
  if (positionals.length !== 1) {
    throw new UsageError('Give exactly one email address to send the test to.');
  }
  const address = (positionals[0] ?? '').trim();
  if (!ADDRESS_PATTERN.test(address)) {
    throw new UsageError(
      `"${address}" is not an email address. Use one like name@example.com.`,
    );
  }

  let mailEnv: ReturnType<typeof readMailEnv>;
  try {
    mailEnv = readMailEnv(env);
  } catch (error) {
    if (error instanceof PlakboekEnvError) {
      for (const issue of error.issues) printError(issue.message);
      return EXIT_FAILURE;
    }
    throw error;
  }

  const mail = createLazyMailSender({ env: mailEnv });
  const secrets = [mailEnv.smtp?.pass ?? '', mailEnv.smtp?.user ?? ''];
  try {
    await mail.send(buildTestEmail({ to: address, siteUrl: mailEnv.siteUrl }));
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      printError(error.message);
    } else if (error instanceof MailSendError) {
      printError(
        `Could not send the test email: ${transportMessage(error, secrets)}`,
      );
    } else {
      printError(oneLine(messageOf(error), secrets));
    }
    return EXIT_FAILURE;
  }

  if (mail.describe() === 'console') {
    printLine(
      'No SMTP server is configured, so the email was printed above instead.',
    );
  } else {
    printLine(`Sent a test email to ${address}.`);
  }
  return EXIT_OK;
}
