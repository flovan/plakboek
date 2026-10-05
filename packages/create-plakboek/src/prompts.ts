import { createInterface } from 'node:readline';

export type Prompter = {
  /**
   * Ask one question and return the trimmed answer. Resolves to `null` when
   * the input ended before an answer arrived.
   */
  ask: (question: string) => Promise<string | null>;
  close: () => void;
};

/**
 * Line-based prompts over plain streams: no cursor control, no raw mode. One
 * async iterator reads every answer, so lines that arrive before the next
 * question is asked are buffered rather than lost.
 */
export function createPrompter(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): Prompter {
  const lines = createInterface({ input: stdin, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    ask: async (question) => {
      stdout.write(question);
      const next = await iterator.next();
      return next.done === true ? null : String(next.value).trim();
    },
    close: () => {
      lines.close();
    },
  };
}
