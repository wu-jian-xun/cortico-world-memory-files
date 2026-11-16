/**
 * 引擎：调用 memory-system/ms.ps1。
 *
 * 刻意不重写。那套脚本是被人一条一条跑熟了的（PowerShell 5.1 / 7 都能跑，
 * 全是 ASCII，中文只在 .md 模板里），重写一遍只会多出一堆新的坑。
 * 这里只负责：找到脚本 → 拼参数 → 拿 stdout → 原样交回去。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MS_PS1 = fileURLToPath(new URL('../memory-system/ms.ps1', import.meta.url));
export const TEMPLATE_DIR = fileURLToPath(new URL('../memory-system/templates/', import.meta.url));

export interface RunResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
}

/** 这个引擎只在 Windows 上跑：ms.ps1 用了 robocopy 和反斜杠路径。 */
export function engineAvailable(): boolean {
  return process.platform === 'win32' && existsSync(MS_PS1);
}

export function engineWhyUnavailable(): string {
  if (process.platform !== 'win32') {
    return `这套引擎现在只在 Windows 上跑（ms.ps1 用了 robocopy 和反斜杠路径），当前系统是 ${process.platform}。Mac / Linux 版还没写。`;
  }
  return `找不到引擎脚本：${MS_PS1}。包装缺了 memory-system/ 目录，重新装一次。`;
}

/**
 * 跑一条 ms.ps1 命令。
 *
 * 用 spawn + 参数数组，不拼命令行字符串——日志正文里会有引号、括号、中文，
 * 拼字符串总有一天被它们咬到。
 */
export function runEngine(command: string, arg1?: string, arg2?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!engineAvailable()) {
      resolve({ ok: false, code: -1, out: '', err: engineWhyUnavailable() });
      return;
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      MS_PS1,
      command,
    ];
    if (typeof arg1 === 'string' && arg1.length > 0) args.push(arg1);
    if (typeof arg2 === 'string' && arg2.length > 0) args.push(arg2);

    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      // 输出按 UTF-8 解；脚本本身全是 ASCII，路径可能是中文。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
      finish({ ok: false, code: -1, out: out.trim(), err: '超时（60 秒）——备份大目录时可能不够，单独再跑一次。' });
    }, 60_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, out: out.trim(), err: `启动 powershell 失败：${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const c = typeof code === 'number' ? code : -1;
      finish({ ok: c === 0, code: c, out: out.trim(), err: err.trim() });
    });
  });
}

// ---------------------------------------------------------------- 读（不走 ms.ps1）

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function clip(text: string, limit: number): string {
  const s = text.replace(/\r\n/g, '\n').trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n…（还有 ${s.length - limit} 字，需要就再读细一点）`;
}

export interface ReadTarget {
  what?: 'state' | 'todo' | 'log' | 'handoffs' | 'index' | 'handoff' | 'file';
  /** what=file 时的相对路径；what=handoff 时可给文件名，不给就取最新一份。 */
  path?: string;
  /** what=log 时取最后多少行，默认 40。 */
  lines?: number;
}

/** 读回自己写下的东西：醒来第一件事靠它。 */
export function readMemory(root: string, target: ReadTarget): { ok: boolean; text: string } {
  const what = target.what ?? 'state';
  const lines = Math.min(400, Math.max(4, Number(target.lines ?? 40)));

  if (what === 'file') {
    const rel = String(target.path ?? '').trim();
    if (!rel) return { ok: false, text: '要给 path（相对记忆根目录的路径）。' };
    if (rel.includes('..')) return { ok: false, text: '只能读记忆根目录里的文件。' };
    const p = join(root, rel);
    if (!existsSync(p)) return { ok: false, text: `没有这个文件：${rel}` };
    return { ok: true, text: clip(readText(p), 4000) };
  }

  if (what === 'state' || what === 'todo') {
    const name = what === 'state' ? 'STATE.md' : 'todo.md';
    const p = join(root, name);
    if (!existsSync(p)) return { ok: false, text: `${name} 不存在——还没 init 过。` };
    return { ok: true, text: clip(readText(p), 4000) };
  }

  if (what === 'log') {
    const month = new Date().toISOString().slice(0, 7);
    const p = join(root, 'log', `${month}.md`);
    if (!existsSync(p)) return { ok: false, text: `没有本月的流水（log/${month}.md）。` };
    const all = readText(p).split(/\r?\n/);
    const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
    return { ok: true, text: clip(tail, 4000) };
  }

  if (what === 'handoffs') {
    const dir = join(root, 'handoffs');
    if (!existsSync(dir)) return { ok: false, text: '还没有 handoffs/ 目录。' };
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && n !== 'INDEX.md')
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 20);
    if (files.length === 0) return { ok: false, text: 'handoffs/ 是空的——清上下文之前先写一份。' };
    return { ok: true, text: files.map((f) => `- ${f.n}`).join('\n') };
  }

  if (what === 'index') {
    const p = join(root, 'handoffs', 'INDEX.md');
    if (!existsSync(p)) return { ok: false, text: '没有 handoffs/INDEX.md。' };
    return { ok: true, text: clip(readText(p), 3000) };
  }

  // what === 'handoff'：默认最新一份
  const dir = join(root, 'handoffs');
  if (!existsSync(dir)) return { ok: false, text: '还没有 handoffs/ 目录。' };
  const wanted = String(target.path ?? '').trim();
  let name = wanted;
  if (!name) {
    const files = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && n !== 'INDEX.md')
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files.length === 0) return { ok: false, text: 'handoffs/ 是空的。' };
    name = files[0].n;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, text: '只给文件名，不带路径。' };
  }
  const p = join(dir, name);
  if (!existsSync(p)) return { ok: false, text: `没有这份交接：${name}` };
  return { ok: true, text: clip(readText(p), 6000) };
}

// ---------------------------------------------------------------- 回忆（不走 ms.ps1）

/**
 * 在记忆根目录里按关键词找东西。
 *
 * 为什么要有它：`ms_read` 只会按「state / todo / log」这几样读，
 * 想找「上个月哪天说过那句话」就抓瞎。会写不会找，等于半套记忆。
 *
 * 用 Node 直接扫文件，不走 PowerShell：读文件是本职，绕一层 shell 只多一处编码风险。
 * 只读，不改任何东西。
 */

const SEARCH_EXTS = ['.md', '.txt'];
const SEARCH_SKIP = new Set(['node_modules', '.git', '.pnpm', 'backups', 'memory-backup', 'tmp-smoke']);

export interface SearchHit {
  /** 相对根目录的路径，用 / 分隔 */
  path: string;
  /** 行号，1 起 */
  line: number;
  text: string;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  /** 一共命中多少行（可能比返回的多） */
  total: number;
  /** 扫了多少个文件、有没有被截断 */
  scanned: number;
  truncated: boolean;
  error?: string;
}

function collectFiles(dir: string, rel: string, out: string[], includeArchive: boolean, depth = 0): void {
  if (depth > 6 || out.length > 4000) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const name = e.name;
    const childRel = rel ? `${rel}/${name}` : name;
    if (e.isDirectory()) {
      if (SEARCH_SKIP.has(name.toLowerCase())) continue;
      // 遗忘不是删：archive/ 里的东西默认也找得到，除非调用时明确排除
      if (!includeArchive && name.toLowerCase() === 'archive') continue;
      collectFiles(join(dir, name), childRel, out, includeArchive, depth + 1);
    } else if (e.isFile()) {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!SEARCH_EXTS.includes(ext)) continue;
      out.push(childRel);
    }
  }
}

export function searchMemory(
  root: string,
  query: string,
  opts: { limit?: number; includeArchive?: boolean } = {},
): SearchResult {
  const empty = { hits: [] as SearchHit[], total: 0, scanned: 0, truncated: false };
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, ...empty, error: '要给一个关键词（一两个词最好使）。' };
  if (!existsSync(root)) return { ok: false, ...empty, error: `没有这个目录：${root}` };

  const includeArchive = opts.includeArchive !== false;
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 30)));
  // 多个词用空格分开：一行里这几个词都出现才算命中
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

  const files: string[] = [];
  collectFiles(root, '', files, includeArchive);

  const hits: SearchHit[] = [];
  let total = 0;
  for (const rel of files) {
    let body: string;
    try {
      body = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!body) continue;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (!tokens.every((t) => low.includes(t))) continue;
      total++;
      if (hits.length < limit) hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
  }

  return { ok: true, hits, total, scanned: files.length, truncated: total > hits.length };
}

export function formatSearch(res: SearchResult): string {
  if (!res.ok) return `找不到：${res.error}`;
  if (res.total === 0) {
    return `扫了 ${res.scanned} 个文件，没有命中。换个短一点的词，或者同义说法再试一次。`;
  }
  const lines = res.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
  const tail = res.truncated ? `\n…一共命中 ${res.total} 行，只回了前 ${res.hits.length} 行。关键词再窄一点。` : '';
  return `${lines.join('\n')}${tail}`;
}

// ---------------------------------------------------------------- 遗忘（搬家，不删）

/**
 * 把上个月的流水搬进 archive/log/。
 *
 * 「遗忘」在这套东西里只有一种做法：**搬家**。搬走的还找得到（ms_search 默认连 archive 一起扫），
 * 但不再占着 log/ 的位置，醒来读末尾时不会被旧月份挤掉。
 *
 * 默认只看不搬：不给 apply 就只报「会搬哪几个」。真要搬，调用方得明说。
 */
export function archiveLogs(
  root: string,
  opts: { apply?: boolean; before?: string } = {},
): { ok: boolean; text: string } {
  const logDir = join(root, 'log');
  if (!existsSync(logDir)) return { ok: false, text: '还没有 log/ 目录——先 ms_init。' };

  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const before = String(opts.before ?? '').trim() || current;
  const monthRe = /^(\d{4})-(\d{2})\.md$/i;

  let names: string[];
  try {
    names = readdirSync(logDir)
      .filter((n) => {
        const m = monthRe.exec(n);
        return !!m && `${m[1]}-${m[2]}` < before;
      })
      .sort();
  } catch {
    return { ok: false, text: `读不了 log/：${logDir}` };
  }

  if (names.length === 0) return { ok: true, text: `没有要搬的：log/ 里没有早于 ${before} 的月份文件。` };

  const destDir = join(root, 'archive', 'log');
  if (!opts.apply) {
    return {
      ok: true,
      text: `会搬这几份（还没动）：\n${names.map((n) => `- log/${n} → archive/log/${n}`).join('\n')}\n确认要搬就再调一次，带 apply=true。`,
    };
  }

  const moved: string[] = [];
  const skipped: string[] = [];
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return { ok: false, text: `建不了 archive/log：${(e as Error).message}` };
  }
  for (const n of names) {
    const from = join(logDir, n);
    const to = join(destDir, n);
    if (existsSync(to)) {
      skipped.push(n);
      continue;
    }
    try {
      renameSync(from, to);
      moved.push(n);
    } catch {
      skipped.push(n);
    }
  }

  const parts: string[] = [];
  if (moved.length) parts.push(`搬好了：${moved.map((n) => `log/${n} → archive/log/${n}`).join('、')}`);
  if (skipped.length) parts.push(`没搬（archive/log 里已经有同名，或者搬不动）：${skipped.join('、')}`);
  parts.push('搬走的还找得到：ms_search 默认连 archive 一起扫。');
  return { ok: true, text: parts.join('\n') };
}
