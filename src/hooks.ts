/**
 * 钩子表：正文可以沉，钩子留在水面。
 *
 * 文件：`<root>/hooks.md`，一张两列（第三列可省）的表：
 *
 *   钩子 | 去处 | 一句话
 *   沙茶面 | archive/log/2026-06.md:58 | 厦门第一碗
 *
 * 三条规矩：
 *  1) **引力不写在这里。** 轻重只有账本 `entries/YYYY-MM.tsv` 一处算数，抄一份迟早两个数打架。
 *  2) **钩子跟账本的钩子对得上**，这样「轻重」和「原文」才接得起来。
 *  3) **不自动同步。** 什么值得留个钩子，是人的判断；工具只提供 `ms_hook` 让人写，不替人写。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { currentByHook, layerOf, readAllEntries, type Entry } from './gravity.ts';

export const HOOKS_HEADER = `# 钩子表 · 钩子 → 去处

# 一行一条：「钩子 | 去处 | 一句话（可省）」。去处写 \`路径\` 或 \`路径:行号\`（相对记忆根目录）。
# 引力不在这儿写：账本 entries/YYYY-MM.tsv 是唯一算数的地方。
# 正文搬进 archive/ 之前，先在这儿留一行——沉下去不等于丢了，钩子一提就能捞回来。
`;

export interface HookRow {
  hook: string;
  target: string;
  note: string;
}

export function hooksPath(root: string): string {
  return join(root, 'hooks.md');
}

export function readHooks(root: string): HookRow[] {
  const file = hooksPath(root);
  if (!existsSync(file)) return [];
  let body = '';
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: HookRow[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    const cols = line.split('|');
    if (cols.length < 2) continue;
    const hook = cols[0].trim();
    const target = cols[1].trim();
    if (!hook || !target) continue;
    rows.push({ hook, target, note: (cols[2] ?? '').trim() });
  }
  return rows;
}

/** 路径必须在根目录里面：钩子表里的去处由模型自己写，别让它跑出记忆根目录。 */
function inside(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) return null;
  return full;
}

function splitTarget(target: string): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)$/.exec(target);
  if (m) return { path: m[1], line: Number(m[2]) };
  return { path: target, line: null };
}

/** 把一行「去处」读成几行原文；读不到就说清楚为什么读不到。 */
function readTarget(root: string, target: string, lines: number): { ok: boolean; text: string } {
  const { path: rel, line } = splitTarget(target);
  const full = inside(root, rel);
  if (!full) return { ok: false, text: `去处越出了记忆根目录：${rel}` };
  if (!existsSync(full)) return { ok: false, text: `去处不存在：${rel}（搬过家的话，钩子行该跟着改）` };
  let body = '';
  try {
    body = readFileSync(full, 'utf8');
  } catch (e) {
    return { ok: false, text: `读不进去：${(e as Error).message}` };
  }
  const all = body.split(/\r?\n/);
  const start = line && line > 0 ? line - 1 : 0;
  const slice = all.slice(start, start + Math.max(1, lines));
  const where = line ? `${rel}:${line}` : rel;
  return { ok: true, text: `  从 ${where}：\n${slice.map((l) => `    ${l}`).join('\n')}` };
}

export interface RecallOptions {
  query?: string;
  layer?: 'anchors' | 'float' | 'half' | 'sink';
  read?: boolean;
  lines?: number;
  floatLine: number;
  sinkLine: number;
  limit?: number;
}

/**
 * 按钩子捞。跟 `ms_search` 的分工：**它只捞进过钩子表的**（知道轻重、先给重的），
 * 裸搜交给 `ms_search`（什么都翻得到，但不知道轻重）。两条都留，不合并。
 */
export function recall(root: string, opts: RecallOptions): string {
  const rows = readHooks(root);
  if (rows.length === 0) {
    return (
      '钩子表还是空的（`hooks.md`）。\n' +
      '它不是自动生成的：要留哪一条，用 `ms_hook` 写一行「钩子 | 去处」。\n' +
      '想裸搜原文就用 `ms_search`——它不管轻重，但什么都能翻到。'
    );
  }

  const current = currentByHook(root);
  const weightOf = (hook: string): Entry | undefined => current.get(hook);
  const layerName = (e: Entry | undefined): string => {
    if (!e) return '没有账本条目';
    const l = layerOf(e, opts.floatLine, opts.sinkLine);
    return l === 'anchors' ? '锚' : l === 'float' ? '在浮' : l === 'half' ? '在半浮' : '在沉';
  };

  const q = String(opts.query ?? '').trim().toLowerCase();
  let picked = q ? rows.filter((r) => r.hook.toLowerCase().includes(q) || r.note.toLowerCase().includes(q)) : rows;
  if (opts.layer) {
    picked = picked.filter((r) => {
      const e = weightOf(r.hook);
      if (!e) return false;
      return layerOf(e, opts.floatLine, opts.sinkLine) === opts.layer;
    });
  }
  if (picked.length === 0) {
    return (
      `钩子表里没有${q ? `「${opts.query}」` : '对得上的'}这一条${opts.layer ? `（也限定在 ${opts.layer} 这一层）` : ''}。\n` +
      `表里现有 ${rows.length} 条。想翻原文就走 \`ms_search\`——裸搜不会因为「没留钩子」就漏掉什么。`
    );
  }

  // 重的在前；没有账本条目的排最后
  picked = [...picked].sort((a, b) => (weightOf(b.hook)?.weight ?? -1) - (weightOf(a.hook)?.weight ?? -1));
  const limit = Math.min(50, Math.max(1, Number(opts.limit ?? 10)));
  const shown = picked.slice(0, limit);
  const wantRead = opts.read !== false;
  const lines = Math.min(20, Math.max(1, Number(opts.lines ?? 3)));

  const blocks = shown.map((r) => {
    const e = weightOf(r.hook);
    const head = `- **${r.hook}**${e ? `（引力 ${e.weight}，${layerName(e)}）` : '（账本里没有对应的条目）'} → ${r.target}${r.note ? ` · ${r.note}` : ''}`;
    if (!wantRead) return head;
    const got = readTarget(root, r.target, lines);
    return `${head}\n${got.text}`;
  });

  const tail =
    picked.length > shown.length ? `\n…还有 ${picked.length - shown.length} 条，给大一点的 limit。` : '';
  const ledgerOnly = readAllEntries(root).length;
  return (
    `钩子表里 ${picked.length} 条命中（表里共 ${rows.length} 条，账本 ${ledgerOnly} 行）：\n` +
    `${blocks.join('\n')}${tail}\n` +
    '要对没留钩子的东西，走 `ms_search` 裸搜。'
  );
}

export interface HookWriteResult {
  ok: boolean;
  text: string;
}

/** 写一行钩子。同一个钩子再写一次就是改去处（这张表是地图，不是历史，改就地改）。 */
export function writeHook(
  root: string,
  input: { hook?: string; target?: string; note?: string; remove?: boolean },
): HookWriteResult {
  const hook = String(input.hook ?? '').trim();
  if (!hook) return { ok: false, text: '钩子不能空：要留/要改/要删哪一条？' };
  if (hook.includes('|')) return { ok: false, text: '钩子里不能有竖线（是竖线分列的表）。' };

  const rows = readHooks(root);
  const idx = rows.findIndex((r) => r.hook === hook);

  if (input.remove === true) {
    if (idx < 0) return { ok: false, text: `钩子表里没有「${hook}」，没什么可删的。` };
    rows.splice(idx, 1);
    return save(root, rows, `删了：「${hook}」不再留在水面。原文还在文件里，ms_search 翻得到。`);
  }

  const target = String(input.target ?? '').trim();
  if (!target) return { ok: false, text: '去处不能空：写 `路径` 或 `路径:行号`（相对记忆根目录）。' };
  if (target.includes('|')) return { ok: false, text: '去处里不能有竖线。' };
  if (!inside(root, splitTarget(target).path)) {
    return { ok: false, text: `去处越出了记忆根目录：${target}。钩子表只指根目录里面的东西。` };
  }

  const note = String(input.note ?? '').trim();
  const row: HookRow = { hook, target, note };
  if (idx >= 0) {
    const old = rows[idx];
    rows[idx] = row;
    return save(
      root,
      rows,
      old.target === target ? `「${hook}」还是指向 ${target}（备注已更新）。` : `改了：「${hook}」${old.target} → ${target}。`,
    );
  }
  rows.push(row);
  return save(root, rows, `留了钩子：「${hook}」→ ${target}。正文将来搬进 archive/，靠它捞得回来。`);
}

function save(root: string, rows: HookRow[], done: string): HookWriteResult {
  const body =
    `${HOOKS_HEADER}\n` +
    rows.map((r) => `${r.hook} | ${r.target}${r.note ? ` | ${r.note}` : ''}`).join('\n') +
    (rows.length ? '\n' : '');
  try {
    writeFileSync(hooksPath(root), body, 'utf8');
  } catch (e) {
    return { ok: false, text: `写不进去：${(e as Error).message}` };
  }
  return { ok: true, text: `${done}钩子表现在 ${rows.length} 条。` };
}
