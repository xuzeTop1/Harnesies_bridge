import { DispatchRejected } from './types.ts';

/**
 * For CLIs that can only take the prompt as a positional argument (stdin is preferred and used
 * where verified: claude, codex).
 *
 * Two failure modes are closed here:
 *  - a prompt beginning with "-" (a pasted unified diff starts with "--- a/…", a bullet list with
 *    "- ") is parsed as an option: Claude Code answered `unknown option`, Codex `unexpected
 *    argument`. A leading newline makes the token a plain argument for commander/yargs/clap alike
 *    without depending on each CLI's `--` handling, and models ignore it;
 *  - oversized prompts: the OS rejects the spawn (E2BIG/ENAMETOOLONG). Fail fast with a clear
 *    reason instead of a crashed or failed process.
 */
export function argvLimitBytes(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 30_000; // CreateProcess command line: 32,767 UTF-16 units in total
  if (platform === 'linux') return 120_000; // MAX_ARG_STRLEN: 128 KiB per argument
  return 800_000; // macOS: ARG_MAX 1 MiB shared with the environment
}

export function argvPrompt(harness: string, prompt: string, platform: NodeJS.Platform = process.platform): string {
  const limit = argvLimitBytes(platform);
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > limit) {
    throw new DispatchRejected(
      `${harness}: prompt is ${bytes} bytes; this CLI only accepts the prompt on the command line, ` +
        `which this OS caps at about ${limit} bytes. Put the material in a file under cwd and reference it in a short prompt.`,
    );
  }
  return prompt.startsWith('-') ? `\n${prompt}` : prompt;
}
