#!/usr/bin/env node
// Generates docs/demo.gif: `runway setup`, a workflow using it, and `runway status`.
//
//   npm run demo:gif
//
// Setup really takes about 10 minutes and deploys into an AWS account, so this doesn't run it:
// it replays the output of a real fresh install (2026-11-15, eu-central-1), sped up, with the
// account, org and job IDs replaced by placeholders. The lines and symbols match src/cli/ui.ts.
// It renders each frame in Google Chrome (playwright-core, channel 'chrome') and encodes the GIF
// with ffmpeg (palettegen/paletteuse, per-frame delays).
//
// Env: FFMPEG (default: ffmpeg on PATH, then /opt/homebrew/bin/ffmpeg), DEMO_KEEP=1 keeps frames.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_GIF = join(ROOT, 'docs', 'demo.gif');

const WIDTH = 1040;
const ROWS = 26;
const FONT_SIZE = 14;
const LINE_H = 20;
const PROMPT = '<span class="c-cyan">~/code/acme-api</span> <span class="c-green">❯</span> ';

// ---------------------------------------------------------------------------------------------
// The CLI's output, as HTML (same symbols and colors as src/cli/ui.ts).

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b = (s) => `<span class="b">${esc(s)}</span>`;
const dim = (s) => `<span class="dim">${esc(s)}</span>`;
const ok = (s, extra = '') =>
  `  <span class="c-green">✓</span> ${s}${extra ? ` ${dim(extra)}` : ''}`;
const step = (s) => `  <span class="c-mint">→</span> ${s}`;
const info = (s) => `    ${dim(s)}`;
const wait = (label, status, t) =>
  `  <span class="c-mint">…</span> ${label}: ${status} ${dim(`(${t})`)}`;
/** A "Recent runners" row, laid out like src/cli/status.ts. */
const runner = (pk, compute, detail, job) =>
  `  <span class="c-green">${'done'.padEnd(9)}</span> ${pk}  ${compute.padEnd(7)} ${dim(detail.padEnd(22))} acme/api job 13283701${job}  ${dim('1m ago')}`;

const SETUP_HEAD = [
  '',
  `  ${b('runway setup')} ${dim('· account 123456789012 · eu-central-1 · stack runway')}`,
  '',
  ok('GitHub organization acme'),
  ok('Uploaded code to s3://runway-runway-123456789012-eu-central-1'),
];
const STACK_PROGRESS = [
  ['create in progress', '20s'],
  ['create in progress', '1m40s'],
  ['create in progress', '3m05s'],
];
const STACK_DONE = [
  ok('Creating stack runway: create complete', '(4m13s)'),
  ok('Stack runway is ready', "(webhook accepts GitHub's 9 webhook ranges only)"),
  step(
    `Create runway's GitHub App in your browser: <span class="u">http://127.0.0.1:61782/start?state=…</span>`,
  ),
  info('The page is served by this terminal (127.0.0.1), so open it on this machine.'),
  info('Then install the App on the repositories that should use runway.'),
];
const APP_DONE = [
  ok(`Created the GitHub App ${b('runway-acme')}`, '(its key is stored in SSM)'),
  ok('Installed on acme (selected repositories)'),
  '',
  info('Images take about 10 minutes. Ctrl-C is safe: they keep building, and jobs wait for them.'),
];
const IMAGE_PROGRESS = [
  ['1/3 done', '2m10s'],
  ['2/3 done', '4m02s'],
];
const SETUP_DONE = [
  ok(
    'Runner images built',
    '(actions/runner 2.338.2: microvm arm64-1cpu, container arm64, container x64) (5m26s)',
  ),
  '',
  `  ${b('runway is ready.')} ${dim('Check on it any time with: npx -y @mintwork/runway status')}`,
  '',
];

const WORKFLOW = [
  `<span class="c-gray"># .github/workflows/ci.yml</span>`,
  `<span class="c-blue">jobs</span>:`,
  `  <span class="c-blue">test</span>:`,
  `    <span class="c-blue">runs-on</span>: [runway, microvm]                <span class="c-gray"># Firecracker VM, Docker included</span>`,
  `  <span class="c-blue">build</span>:`,
  `    <span class="c-blue">runs-on</span>: [runway, ec2, spot, arm64, 8cpu]  <span class="c-gray"># Graviton Spot instance</span>`,
  `  <span class="c-blue">lint</span>:`,
  `    <span class="c-blue">runs-on</span>: [runway, lambda]                 <span class="c-gray"># Lambda function</span>`,
  `  <span class="c-blue">e2e</span>:`,
  `    <span class="c-blue">runs-on</span>: [runway, fargate, x64, 4cpu]     <span class="c-gray"># ECS Fargate task</span>`,
  '',
];

const STATUS = [
  '',
  `  ${b('runway status')} ${dim('· account 123456789012 · eu-central-1 · stack runway')}`,
  '',
  ok('Stack create complete'),
  ok('GitHub App runway-acme installed on acme (selected)'),
  ok('Runner images: actions/runner 2.338.2, built 6m ago'),
  ok('MicroVM image arm64-1cpu: created, version 1.0 active'),
  `  ${dim('·')} arm64 MicroVM memory quota: 2048 GB (1024 x 1cpu MicroVMs at once)`,
  '',
  `  ${b('Recent runners')}`,
  runner('runway-0bc5a4ced5', 'microvm', 'arm64-1cpu', '1001'),
  runner('runway-ea9f7e9993', 'ec2', 'c7g.2xlarge spot', '1002'),
  runner('runway-de92b9f006', 'lambda', 'arm64 1769 MB', '1003'),
  runner('runway-5ab8fa6cd3', 'fargate', 'x64 4cpu/8gb', '1004'),
  '',
];

// ---------------------------------------------------------------------------------------------
// Timeline: { lines, cursor, overlay, ms } states. Identical neighbours are merged.

function buildTimeline() {
  const states = [];
  let screen = [];
  const push = (ms, extra = {}) =>
    states.push({
      lines: screen.slice(),
      cursor: extra.cursor ?? null,
      overlay: extra.overlay ?? null,
      ms,
    });
  const hold = (ms, extra = {}) => {
    if (!extra.cursor) return push(ms, extra);
    for (let t = 0; t < ms; t += 500)
      push(Math.min(500, ms - t), { ...extra, cursor: (t / 500) % 2 === 0 ? extra.cursor : 'off' });
  };
  const type = (cmd) => {
    screen.push(PROMPT);
    const idx = screen.length - 1;
    hold(500, { cursor: 'on' });
    for (let i = 1; i <= cmd.length; i++) {
      screen[idx] = PROMPT + esc(cmd.slice(0, i));
      push(cmd[i - 1] === ' ' ? 70 : 35 + ((i * 37) % 30), { cursor: 'on' });
    }
    push(350, { cursor: 'on' });
  };
  const reveal = (lines, ms) => {
    for (const line of lines) {
      screen.push(line);
      push(ms);
    }
  };
  /** A status line re-rendered in place, like ui.progress(). */
  const progress = (label, updates, ms) => {
    screen.push('');
    for (const [status, t] of updates) {
      screen[screen.length - 1] = wait(label, status, t);
      push(ms);
    }
    screen.pop();
  };

  // 1. Setup.
  type('npx -y @mintwork/runway setup --owner acme --region eu-central-1');
  reveal(SETUP_HEAD, 220);
  progress('Creating stack runway', STACK_PROGRESS, 650);
  reveal(STACK_DONE, 260);
  push(700);
  hold(2600, { overlay: 'create' });
  hold(1800, { overlay: 'install' });
  reveal(APP_DONE, 300);
  progress('Building runner images', IMAGE_PROGRESS, 750);
  reveal(SETUP_DONE, 300);
  screen.push(PROMPT);
  hold(1500, { cursor: 'on' });

  // 2. A workflow that uses it.
  screen = [];
  type('cat .github/workflows/ci.yml');
  reveal(WORKFLOW, 90);
  screen.push(PROMPT);
  hold(3000, { cursor: 'on' });

  // 3. Status after a push.
  screen = [];
  type('npx -y @mintwork/runway status');
  reveal(STATUS, 120);
  screen.push(PROMPT);
  hold(4500, { cursor: 'on' });

  const merged = [];
  for (const s of states) {
    const prev = merged.at(-1);
    if (
      prev &&
      prev.cursor === s.cursor &&
      prev.overlay === s.overlay &&
      prev.lines.join('\n') === s.lines.join('\n')
    )
      prev.ms += s.ms;
    else merged.push({ ...s });
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Page: a terminal window, plus the browser pages setup opens (shown as an overlay).

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; background: #0b0e14; }
  body { padding: 26px 28px 28px; font-family: Menlo, 'SF Mono', ui-monospace, monospace; }
  .win { background: #11151c; border: 1px solid #262c36; border-radius: 12px; overflow: hidden; position: relative;
         box-shadow: 0 20px 50px rgba(0,0,0,.45); }
  .bar { height: 38px; display: flex; align-items: center; padding: 0 14px; background: #181d26; border-bottom: 1px solid #232a35; }
  .dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
  .title { flex: 1; text-align: center; color: #7d8590; font: 13px -apple-system, 'Helvetica Neue', sans-serif; margin-right: 60px; }
  .pad { padding: 14px 22px 16px; }
  #term { color: #d6dbe2; font-size: ${FONT_SIZE}px; line-height: ${LINE_H}px; height: ${ROWS * LINE_H}px;
          white-space: pre; overflow: hidden; -webkit-font-smoothing: antialiased; }
  .b { font-weight: 700; color: #f0f3f6; } .dim { opacity: .62; } .u { text-decoration: underline; }
  .c-green { color: #56d364; } .c-cyan { color: #56d4dd; } .c-blue { color: #79c0ff; } .c-gray { color: #7d8590; }
  .c-mint { color: #7ee2b8; }
  .cur { display: inline-block; width: .6em; height: 1.2em; background: #d6dbe2; vertical-align: -.25em; }
  .cur.off { visibility: hidden; }
  .overlay { position: absolute; left: 0; right: 0; top: 70px; display: none; justify-content: center; }
  .browser { width: 640px; border-radius: 10px; overflow: hidden; box-shadow: 0 16px 50px rgba(0,0,0,.6);
             font: 15px/1.55 -apple-system, 'Helvetica Neue', sans-serif; }
  .chrome { background: #e9ebee; padding: 9px 12px; display: flex; align-items: center; gap: 10px; }
  .chrome .dots span { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
  .url { flex: 1; background: #fff; border-radius: 6px; padding: 4px 10px; font-size: 12.5px; color: #3c4043; }
  .local { background: #0d1714; color: #e6f2ed; padding: 30px 34px 32px; }
  .local h1 { font-size: 24px; letter-spacing: -.02em; margin-bottom: 10px; }
  .local p { color: #c9dbd4; font-size: 14.5px; margin-bottom: 18px; }
  .btn { display: inline-block; font-weight: 600; padding: 10px 20px; border-radius: 999px; background: #7ee2b8; color: #0d1714; }
  .gh { background: #fff; color: #1f2328; padding: 26px 30px 28px; }
  .gh h2 { font-size: 20px; font-weight: 600; margin-bottom: 12px; }
  .gh .opt { border: 1px solid #d1d9e0; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; font-size: 14px; }
  .gh .opt.on { border-color: #0969da; box-shadow: 0 0 0 1px #0969da; }
  .gh .repo { display: inline-block; background: #ddf4ff; color: #0969da; border-radius: 999px; padding: 1px 10px; font-size: 13px; margin-left: 6px; }
  .ghbtn { display: inline-block; margin-top: 8px; background: #1f883d; color: #fff; font-weight: 600; border-radius: 6px; padding: 7px 16px; font-size: 14px; }
</style></head><body>
<div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span><span class="title">acme-api — zsh</span></div>
  <div class="pad"><div id="term"></div></div>
  <div class="overlay" id="ov-create"><div class="browser">
    <div class="chrome"><span class="dots"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></span>
      <span class="url">127.0.0.1:61782/start</span></div>
    <div class="local"><h1>Create runway’s GitHub App</h1>
      <p>This sends the App’s settings to GitHub, where you confirm them. Its private key comes back to the runway CLI on this machine and is stored in your AWS account, never shown here.</p>
      <span class="btn">Create GitHub App on acme</span></div>
  </div></div>
  <div class="overlay" id="ov-install"><div class="browser">
    <div class="chrome"><span class="dots"><span style="background:#ff5f57"></span><span style="background:#febc2e"></span><span style="background:#28c840"></span></span>
      <span class="url">github.com/apps/runway-acme/installations/new</span></div>
    <div class="gh"><h2>Install runway-acme on acme</h2>
      <div class="opt">All repositories</div>
      <div class="opt on">Only select repositories <span class="repo">acme/api</span><span class="repo">acme/web</span></div>
      <span class="ghbtn">Install</span></div>
  </div></div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------------------------

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
    throw new Error('ffmpeg not found; set FFMPEG=/path/to/ffmpeg');
  }
}

async function main() {
  const ffmpeg = findFfmpeg();
  const base = mkdtempSync(join(tmpdir(), 'runway-demo-'));
  const frames = join(base, 'frames');
  mkdirSync(frames);
  try {
    const states = buildTimeline();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: 400 },
      deviceScaleFactor: 1,
    });
    await page.setContent(pageHtml());
    const height = await page.evaluate(() =>
      Math.ceil(document.body.getBoundingClientRect().height),
    );
    await page.setViewportSize({ width: WIDTH, height: height + (height % 2) });

    const list = [];
    for (const [i, s] of states.entries()) {
      await page.evaluate(({ lines, cursor, overlay }) => {
        const out = lines.slice();
        if (cursor)
          out[out.length - 1] += `<span class="cur${cursor === 'off' ? ' off' : ''}"></span>`;
        const term = document.getElementById('term');
        term.innerHTML = out.join('\n');
        term.scrollTop = term.scrollHeight; // scroll like a real terminal
        for (const id of ['create', 'install'])
          document.getElementById(`ov-${id}`).style.display = overlay === id ? 'flex' : 'none';
      }, s);
      const file = join(frames, `f${String(i).padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      list.push(`file '${file}'`, `duration ${(Math.round(s.ms / 10) / 100).toFixed(2)}`);
    }
    await browser.close();
    list.push(`file '${join(frames, `f${String(states.length - 1).padStart(4, '0')}.png`)}'`);
    writeFileSync(join(frames, 'list.txt'), `${list.join('\n')}\n`);

    mkdirSync(dirname(OUT_GIF), { recursive: true });
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        join(frames, 'list.txt'),
        '-vf',
        'split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
        '-fps_mode',
        'vfr',
        '-loop',
        '0',
        OUT_GIF,
      ],
      { stdio: 'inherit' },
    );
    const total = states.reduce((n, s) => n + s.ms, 0) / 1000;
    const mb = (statSync(OUT_GIF).size / 1024 / 1024).toFixed(2);
    console.log(
      `wrote ${OUT_GIF} (${WIDTH}x${height}, ${states.length} frames, ${total.toFixed(1)}s, ${mb} MB)`,
    );
  } finally {
    if (process.env.DEMO_KEEP) console.log(`kept ${base}`);
    else rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
