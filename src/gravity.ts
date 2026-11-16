/**
 * 引力：每条记忆带一个 0–100 的重量，按水位摆位置。
 *
 * 这里只做**机械活**：记账、算水位、按水位取水面。
 * **「一条值几分」不在这里**——那是模型的判断，工具替它打分，它就会得到一堆别人家的秤。
 *
 * 账本：`<root>/entries/YYYY-MM.tsv`，一行一条，七列：
 *   日期 \t 时间 \t 引力 \t 钩子 \t 简述 \t 出处 \t 标记 \t 记录于
 *
 * 两条铁律：
 *  1) **改引力是追加一行，不覆盖。** 什么时候变的、为什么变，永远查得到。
 *  2) **曝光不算强化。** 读到不算，看过不算。动引力只有三种原因：做成事 / 重申 / 纠正。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENTRY_HEADER = '# 日期\t时间\t引力\t钩子\t简述\t出处\t标记\t记录于';
const MONTH_RE = /^(\d{4})-(\d{2})\.tsv$/;

export interface Entry {
  date: string;
  time: string;
  weight: number;
  hook: string;
  brief: string;
  source: string;
  /** '' 或 '锚'（锚点：引力锁 100，永不沉） */
  mark: string;
  /** 这一行是什么时候写进去的 */
  recordedAt: string;
}

export function entriesDir(root: string): string {
  return join(root, 'entries');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function localNow(): { date: string; time: string; month: string } {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time, month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` };
}

export function monthOf(date: string): string {
  return String(date ?? '').slice(0, 7);
}

function monthFiles(root: string): string[] {
  const dir = entriesDir(root);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => MONTH_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** 读出全部条目，按「月份升序 + 文件内行序」——后出现的才是当前值。 */
export function readAllEntries(root: string): Entry[] {
  const dir = entriesDir(root);
  const out: Entry[] = [];
  for (const name of monthFiles(root)) {
    let body = '';
    try {
      body = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = raw.split('\t');
      if (cols.length < 5) continue;
      const weight = Number(cols[2]);
      if (!Number.isFinite(weight)) continue;
      out.push({
        date: cols[0].trim(),
        time: (cols[1] ?? '').trim(),
        weight,
        hook: (cols[3] ?? '').trim(),
        brief: (cols[4] ?? '').trim(),
        source: (cols[5] ?? '').trim(),
        mark: (cols[6] ?? '').trim(),
        recordedAt: (cols[7] ?? '').trim(),
      });
    }
  }
  return out;
}

/** 每个钩子当前的那一行（最后出现的赢）。 */
export function currentByHook(root: string): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const e of readAllEntries(root)) {
    if (!e.hook) continue;
    map.set(e.hook, e);
  }
  return map;
}

export interface WriteResult {
  ok: boolean;
  text: string;
}

/**
 * 记一条（或给同一条记一次改动）。
 *
 * `reason` 只在「改已有条目的引力」时要求：不给就拒绝。
 * 那三种原因为什么非写不可——见文件头的第 2 条铁律。
 */
export function writeEntry(
  root: string,
  input: {
    date?: string;
    time?: string;
    weight?: number;
    hook?: string;
    brief?: string;
    source?: string;
    anchor?: boolean;
    reason?: string;
  },
): WriteResult {
  const hook = String(input.hook ?? '').trim();
  const brief = String(input.brief ?? '').trim();
  if (!hook) return { ok: false, text: '钩子不能空：钩子是一提就能想起它的那个词，将来靠它捞。' };
  if (!brief) return { ok: false, text: '简述不能空：一两句说清这条是什么。' };
  if (hook.includes('\t') || brief.includes('\t')) return { ok: false, text: '正文里不能有制表符（是 tsv，会串列）。' };
  if (hook.includes('\n') || brief.includes('\n')) return { ok: false, text: '一条一行：别换行。' };

  const now = localNow();
  // 改已有条目时，日期时间默认沿用那条自己的（不然「十一月的事」会被改成今天）
  const existing0 = currentByHook(root).get(hook);
  const date = String(input.date ?? '').trim() || existing0?.date || now.date;
  const time =
    String(input.time ?? '').trim() || existing0?.time || (date === now.date ? now.time : '00:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, text: `日期得是 YYYY-MM-DD，给的是「${date}」。` };

  const anchor = input.anchor === true;
  const rawWeight = input.weight === undefined ? (anchor ? 100 : 90) : Number(input.weight);
  if (!Number.isFinite(rawWeight) || rawWeight < 0 || rawWeight > 100) {
    return { ok: false, text: '引力是 0–100 的整数。' };
  }
  const weight = anchor ? 100 : Math.round(rawWeight);

  // 改已有条目：必须说清为什么动
  const existing = currentByHook(root).get(hook);
  if (existing && existing.weight !== weight) {
    const reason = String(input.reason ?? '').trim();
    if (!reason) {
      return {
        ok: false,
        text:
          `「${hook}」现在是 ${existing.weight}，要改成 ${weight} 得给原因。\n` +
          '只有三种原因算数：①真拿它做成过事（带出处）②对方重申过（带原话）③被纠正过（带旧说法错在哪）。\n' +
          '**曝光不算强化**——今天又翻了一遍不算，读过不算，想它不算。',
      };
    }
  }

  const dir = entriesDir(root);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, text: `建不了 entries/：${(e as Error).message}` };
  }
  const file = join(dir, `${monthOf(date)}.tsv`);
  const createdAt = existsSync(file) ? '' : `${ENTRY_HEADER}\n`;
  const line =
    `${createdAt}${date}\t${time}\t${weight}\t${hook}\t${brief}\t${String(input.source ?? '').trim() || '-'}\t` +
    `${anchor ? '锚' : ''}\t${now.date} ${now.time}\n`;

  try {
    appendFileSync(file, line, 'utf8');
  } catch (e) {
    return { ok: false, text: `写不进去：${(e as Error).message}` };
  }

  const total = readAllEntries(root).length;
  if (existing && existing.weight !== weight) {
    return {
      ok: true,
      text: `改了：entries/${monthOf(date)}.tsv 追加一行，「${hook}」${existing.weight} → ${weight}（原因已记）。账本现在 ${total} 行。`,
    };
  }
  if (existing) {
    return { ok: true, text: `记下了：entries/${monthOf(date)}.tsv 追加一行，「${hook}」还是 ${weight}。账本现在 ${total} 行。` };
  }
  return { ok: true, text: `记下了：entries/${monthOf(date)}.tsv 追加一行，「${hook}」引力 ${weight}。账本现在 ${total} 行。` };
}

export type Layer = 'anchors' | 'float' | 'half' | 'sink' | 'all';

export interface SurfaceOptions {
  layer?: Layer;
  since?: string;
  keyword?: string;
  limit?: number;
  floatLine: number;
  sinkLine: number;
}

export function layerOf(e: Entry, floatLine: number, sinkLine: number): Exclude<Layer, 'all'> {
  if (e.mark === '锚' || e.weight >= 100) return 'anchors';
  if (e.weight >= floatLine) return 'float';
  if (e.weight >= sinkLine) return 'half';
  return 'sink';
}

export function surface(root: string, opts: SurfaceOptions): string {
  const current = currentByHook(root);
  if (current.size === 0) return '账本还是空的：先用 ms_entry 记一条。';

  const layer = opts.layer ?? 'float';
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 40)));
  const since = String(opts.since ?? '').trim();
  const kw = String(opts.keyword ?? '').trim().toLowerCase();

  let rows = [...current.values()];
  if (layer !== 'all') rows = rows.filter((e) => layerOf(e, opts.floatLine, opts.sinkLine) === layer);
  if (since) rows = rows.filter((e) => e.date >= since);
  if (kw) rows = rows.filter((e) => `${e.hook} ${e.brief} ${e.source}`.toLowerCase().includes(kw));

  if (rows.length === 0) {
    return `这一层（${layer}）现在没有条目。${layer === 'sink' ? '沉下去不等于丢了：ms_search 还是找得到原文。' : ''}`;
  }

  // 重的在前
  rows.sort((a, b) => b.weight - a.weight || (a.date < b.date ? 1 : -1));
  const shown = rows.slice(0, limit);
  const lines = shown.map(
    (e) =>
      `- ${e.date}${e.time ? ` ${e.time}` : ''} · 引力 ${e.weight}${e.mark ? ` ${e.mark}` : ''} · **${e.hook}** · ${e.brief}` +
      `${e.source && e.source !== '-' ? `（${e.source}）` : ''}`,
  );
  const head =
    `当前 ${current.size} 条；这一层 ${rows.length} 条` +
    `（浮线 ${opts.floatLine} / 沉线 ${opts.sinkLine}${since ? `，${since} 之后` : ''}）`;
  const tail = rows.length > shown.length ? `\n…只回了前 ${shown.length} 条，要更多就给大一点的 limit。` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

// ---------------------------------------------------------------- 改分与衰减

/** 三种算数的原因。别的一律不认——曝光不算强化。 */
export const REASON_KINDS = ['做成事', '重申', '纠正'] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

/**
 * 改一条的引力：新值 + 原因（做成事 / 重申 / 纠正）+ 出处。
 *
 * 这里是 `ms_weight` 的地方，跟 `ms_entry` 的区别只有一个：
 * **它不管「新记一条」，只负责把已有的那条往上或往下挪，并且必须说清为什么。**
 */
export function changeWeight(
  root: string,
  input: { hook?: string; weight?: number; kind?: string; reason?: string; source?: string },
): WriteResult {
  const hook = String(input.hook ?? '').trim();
  if (!hook) return { ok: false, text: '钩子不能空：要改哪一条？' };
  const existing = currentByHook(root).get(hook);
  if (!existing) {
    return {
      ok: false,
      text: `账本里没有「${hook}」这一条。先记它（ms_entry），再谈改分。\n已有钩子：${[...currentByHook(root).keys()].slice(0, 12).join(' / ') || '（空）'}`,
    };
  }
  if (existing.mark === '锚') {
    return { ok: false, text: `「${hook}」是锚点：引力锁 100，永不沉，也不往下调。要动它得先跟对方说。` };
  }

  const kind = String(input.kind ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    return {
      ok: false,
      text:
        `「${hook}」现在是 ${existing.weight}，要动它得给原因。\n` +
        '只有三种原因算数：①做成事（真拿它做成过什么，带出处）②重申（对方又说过一次，带原话）③纠正（旧说法错在哪）。\n' +
        '**曝光不算强化**——今天又翻了一遍不算，读过不算，想它不算。',
    };
  }
  if (kind && !(REASON_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, text: `原因是哪一类？只能填这三种之一：${REASON_KINDS.join(' / ')}。给的是「${kind}」。` };
  }
  const weight = input.weight === undefined ? undefined : Number(input.weight);
  if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) {
    return { ok: false, text: '引力是 0–100 的整数。' };
  }

  const note = kind ? `[${kind}] ${reason}` : reason;
  const r = writeEntry(root, {
    hook,
    brief: existing.brief,
    date: existing.date,
    time: existing.time,
    source: String(input.source ?? '').trim() || existing.source,
    weight: weight ?? existing.weight,
    reason: note,
  });
  if (!r.ok) return r;
  if (weight === undefined) return { ok: true, text: `「${hook}」引力没动（还是 ${existing.weight}），但这次的理由记下了：${note}。` };
  return { ok: true, text: `「${hook}」${existing.weight} → ${Math.round(weight)}，因为${note}。账本追加一行，前面那行留着。` };
}

/** 两个日期差几天（date 只算日子，不算时刻）。 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

export interface DecayOptions {
  /** 至少闲置这么多天才提一句，默认 30。 */
  minDays?: number;
  limit?: number;
  floatLine: number;
  sinkLine: number;
}

/**
 * 衰减：算出「多久没被提过」，给一份**建议**。
 *
 * 绝不动账本。确认之后要落下，得走 `ms_weight`（带原因）。
 * 形状不是公式：30 天没提 ≈ 掉三分，被反复动过的掉得慢。
 */
export function decay(root: string, opts: DecayOptions): string {
  const all = readAllEntries(root);
  const current = currentByHook(root);
  if (current.size === 0) return '账本还是空的：先用 ms_entry 记一条。';

  const touches = new Map<string, number>();
  for (const e of all) {
    if (e.hook) touches.set(e.hook, (touches.get(e.hook) ?? 0) + 1);
  }

  const today = localNow().date;
  const minDays = Math.max(1, Number(opts.minDays ?? 30));
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 20)));

  interface Row {
    e: Entry;
    daysIdle: number;
    touches: number;
    suggested: number;
  }
  const rows: Row[] = [];
  for (const e of current.values()) {
    if (e.mark === '锚' || e.weight >= 100) continue;
    const touched = e.recordedAt.slice(0, 10) || e.date;
    const daysIdle = daysBetween(touched, today);
    if (daysIdle < minDays) continue;
    const n = touches.get(e.hook) ?? 1;
    // 被反复动过的衰减得慢：动过三次的，闲置天数按七折算。
    const effective = daysIdle / (1 + 0.15 * (n - 1));
    const drop = Math.min(30, Math.max(1, Math.round((effective / 30) * 3)));
    const suggested = Math.max(10, e.weight - drop);
    if (suggested >= e.weight) continue;
    rows.push({ e, daysIdle, touches: n, suggested });
  }

  if (rows.length === 0) {
    return `没有闲置超过 ${minDays} 天、还该往下走的条目。账本现在 ${current.size} 条。`;
  }

  rows.sort((a, b) => b.daysIdle - a.daysIdle || a.suggested - b.suggested);
  const shown = rows.slice(0, limit);
  const lines = shown.map(
    ({ e, daysIdle, touches: n, suggested }) =>
      `- **${e.hook}** ${e.weight} → 建议 ${suggested}（闲置 ${daysIdle} 天，动过 ${n} 次；现在落${
        layerOf(e, opts.floatLine, opts.sinkLine) === 'float' ? '在浮' : layerOf(e, opts.floatLine, opts.sinkLine) === 'half' ? '在半浮' : '在沉'
      }）`,
  );
  return (
    `${shown.length} 条放着没动了（≥ ${minDays} 天，锚点不算）。**这只是建议，账本一个字没改。**\n` +
    `${lines.join('\n')}\n` +
    (rows.length > shown.length ? `…还有 ${rows.length - shown.length} 条，给大一点的 limit。\n` : '') +
    '要落下就走 `ms_weight`，并且给原因（做成事 / 重申 / 纠正）；不想降就放着——**沉下去不等于丢了**，`ms_search` 照样翻得到。'
  );
}
