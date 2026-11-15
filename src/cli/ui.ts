// Terminal output. Plain text when stdout isn't a TTY or NO_COLOR is set.
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const mint = paint('38;2;126;226;184');

export const ok = (msg: string) => console.log(`  ${green('✓')} ${msg}`);
export const warn = (msg: string) => console.log(`  ${yellow('!')} ${msg}`);
export const fail = (msg: string) => console.log(`  ${red('✗')} ${msg}`);
export const step = (msg: string) => console.log(`  ${mint('→')} ${msg}`);
export const info = (msg: string) => console.log(`    ${dim(msg)}`);

export function elapsed(since: number): string {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Re-render one status line in place while waiting (falls back to occasional lines). */
export function progress(label: string) {
  const start = Date.now();
  let last = 0;
  return {
    update(status: string) {
      const line = `  ${mint('…')} ${label}: ${status} ${dim(`(${elapsed(start)})`)}`;
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
      else if (Date.now() - last > 30_000) {
        console.log(line);
        last = Date.now();
      }
    },
    done(message: string, good = true) {
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
      (good ? ok : fail)(`${message} ${dim(`(${elapsed(start)})`)}`);
    },
  };
}

export class CliError extends Error {}
