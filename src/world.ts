/**
 * 文件记忆：把「别把自己弄丢」写成八条命令。
 *
 * 不重写引擎。底层还是 memory-system/ms.ps1 —— init / log / check / handoff / backup
 * 五条老命令；另外三条是 Node 直接干的：
 *   ms_read（醒来要读得回来）、ms_search（想不起要搜得到）、ms_archive（旧的要放得下）。
 * 存储、遗忘、回忆，三件事各有人在管。
 *
 * 三条硬约束（改代码时别破坏）：
 *  1) envPromptVars() 只返回常量，模型前缀永远不变 → 缓存命中率高；
 *  2) 不主动推事件、不自己开定时器：这套东西靠伙伴自己想起来，不靠催；
 *  3) 工具回执只给客观读数（写了哪一行、体检几条没过），判断留给模型。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { StoragePart, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { MEMORY_FILES_CONFIG_GROUP, MEMORY_FILES_DEFAULTS, type MemoryFilesConfig } from './config.ts';
import { engineAvailable, engineWhyUnavailable, formatSearch, readMemory, runEngine, searchMemory, archiveLogs } from './engine.ts';
import { surface, writeEntry, changeWeight, decay, type Layer } from './gravity.ts';
import { recall, writeHook } from './hooks.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 文案（控制台里看的，不进提示词）。 */
interface Text {
  moduleLabel: string;
  lampReady: string;
  lampNoRoot: string;
  lampNoRootHint: string;
  lampNoEngine: string;
  lampNoEngineHint: string;
  badgeRoot: string;
  badgeLog: string;
  badgeHandoff: string;
  badgeBackup: string;
  never: string;
  daysAgo: (n: number) => string;
  today: string;
  configTitle: string;
  storageTitle: string;
  storageNote: string;
  promptDocTitle: string;
  promptDocDescription: string;
}

const ZH: Text = {
  moduleLabel: '文件记忆',
  lampReady: '在记',
  lampNoRoot: '还没有记忆根目录',
  lampNoRootHint: '跑一次 ms_init，或者去设置里填「记忆根目录」',
  lampNoEngine: '找不到引擎',
  lampNoEngineHint: '装有 memory-system/ 的那一层缺了，重装一次',
  badgeRoot: '记在哪',
  badgeLog: '今天写了没',
  badgeHandoff: '最新交接',
  badgeBackup: '上次备份',
  never: '还没有',
  daysAgo: (n: number) => (n === 0 ? '今天' : `${n} 天前`),
  today: '今天写了',
  configTitle: '文件记忆',
  storageTitle: '记忆文件',
  storageNote: '这些都是普通 Markdown，在文件夹里直接改也行。清空目录会真的删文件，想留就先备份。',
  promptDocTitle: '文件记忆 · 环境提示词',
  promptDocDescription: '告诉 Coo 什么时候写、什么时候读、清空之前该做什么。',
};

const EN: Text = {
  moduleLabel: 'File Memory',
  lampReady: 'Keeping files',
  lampNoRoot: 'No memory root yet',
  lampNoRootHint: 'Run ms_init once, or set the root in settings',
  lampNoEngine: 'Engine missing',
  lampNoEngineHint: 'The memory-system/ folder is not next to the wrapper; reinstall',
  badgeRoot: 'Root',
  badgeLog: 'Logged today',
  badgeHandoff: 'Newest handoff',
  badgeBackup: 'Last backup',
  never: 'never',
  daysAgo: (n: number) => (n === 0 ? 'today' : `${n}d ago`),
  today: 'yes',
  configTitle: 'File Memory',
  storageTitle: 'Memory files',
  storageNote: 'Plain Markdown; editing them by hand is fine. Clearing really deletes files — back up first.',
  promptDocTitle: 'File Memory · environment prompt',
  promptDocDescription: 'Tells Coo when to write, when to read, and what to do before a context wipe.',
};

function text(language: Language = 'zh'): Text {
  return language === 'en' ? EN : ZH;
}

function daysSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

export class MemoryFilesWorld implements World {
  readonly id = 'memory-files';

  private readonly ctx: WorldContext<MemoryFilesConfig>;
  private readonly defaults: MemoryFilesConfig;
  private host: WorldHost | null = null;

  constructor(ctx: WorldContext<MemoryFilesConfig>) {
    this.ctx = ctx;
    this.defaults = { ...MEMORY_FILES_DEFAULTS };
    // root 允许写 {workspace} / {botDir}，省得用户去抄绝对路径
    this.botDir = String(ctx.botDir ?? ctx.dataDir ?? '.');
  }

  private readonly botDir: string;

  private cfg(): MemoryFilesConfig {
    return { ...this.defaults, ...(this.ctx.cfg ?? {}) };
  }

  /** 记忆根目录：设置里填了就用它，没填就用伙伴自己的工作区。 */
  private root(): string {
    // 热更新：设置改过之后 cfg 会变，所以这里每次都重算
    const raw = String(this.ctx.cfg?.root ?? '').trim();
    if (raw) return expandPlaceholders(raw, this.botDir);
    return this.botDir;
  }

  private backupDest(): string {
    const raw = String(this.ctx.cfg?.backupDest ?? '').trim();
    if (raw) return expandPlaceholders(raw, this.botDir);
    // 默认放在数据目录里，绝不能放在 root 底下：robocopy 会把刚拷出来的再拷一遍。
    const dataDir = String(this.ctx.dataDir ?? this.botDir);
    return join(dataDir, 'memory-backup');
  }

  // ---------- World 接口 ----------

  envPromptVars(): Record<string, string> {
    // 一个变量都不给：根目录、路径这类会因为设置变化而变的东西
    // 一旦进了提示词，改一次设置就把整段前缀的缓存打碎一次。
    return {};
  }

  tools(): ToolDef[] {
    return [
      this.readTool(),
      this.searchTool(),
      this.entryTool(),
      this.weightTool(),
      this.surfaceTool(),
      this.decayTool(),
      this.recallTool(),
      this.hookTool(),
      this.logTool(),
      this.checkTool(),
      this.handoffTool(),
      this.backupTool(),
      this.initTool(),
      this.archiveTool(),
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const root = this.root();
    const hasRoot = existsSync(join(root, 'STATE.md')) || existsSync(join(root, 'log'));

    let lamp: WorldLamp;
    if (!engineAvailable()) {
      lamp = { label: t.lampNoEngine, state: 'error', hint: engineWhyUnavailable() };
    } else if (!hasRoot) {
      lamp = { label: t.lampNoRoot, state: 'offline', hint: t.lampNoRootHint };
    } else {
      lamp = { label: t.lampReady, state: 'online', hint: root };
    }

    const badges: WorldWebUiDecl['badges'] = [
      { label: t.badgeRoot, value: shortPath(root), tone: hasRoot ? 'plain' : 'on' },
    ];

    const logDays = this.daysFromNewest(join(root, 'log'), (n) => n.endsWith('.md'));
    badges.push({
      label: t.badgeLog,
      value: logDays === null ? t.never : t.daysAgo(logDays),
      tone: logDays === 0 ? 'plain' : 'on',
    });

    const hDays = this.daysFromNewest(join(root, 'handoffs'), (n) => n.endsWith('.md') && n !== 'INDEX.md');
    badges.push({
      label: t.badgeHandoff,
      value: hDays === null ? t.never : t.daysAgo(hDays),
      tone: hDays === null || hDays > 3 ? 'on' : 'plain',
    });

    const bDays = this.daysFromBookmark(join(root, 'notes', 'backup-last.txt'));
    badges.push({
      label: t.badgeBackup,
      value: bDays === null ? t.never : t.daysAgo(bDays),
      tone: bDays === null || bDays > 7 ? 'on' : 'plain',
    });

    return {
      label: t.moduleLabel,
      lamps: [lamp],
      badges,
      storage: [this.storagePart(t)],
      config: [{ ...MEMORY_FILES_CONFIG_GROUP, schema: { ...MEMORY_FILES_CONFIG_GROUP.schema, title: t.configTitle } }],
      promptDocs: [
        {
          key: 'worlds.memory-files.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const root = this.root();
    host.log.info(
      engineAvailable()
        ? `memory-files: 根目录 ${root}；备份到 ${this.backupDest()}`
        : `memory-files: ${engineWhyUnavailable()}`,
    );
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  // ---------- 小工具 ----------

  private daysFromNewest(dir: string, match: (name: string) => boolean): number | null {
    if (!existsSync(dir)) return null;
    let newest = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!match(name)) continue;
        const t = statSync(join(dir, name)).mtimeMs;
        if (t > newest) newest = t;
      }
    } catch {
      return null;
    }
    return newest === 0 ? null : daysSince(newest);
  }

  private daysFromBookmark(path: string): number | null {
    if (!existsSync(path)) return null;
    try {
      const stamp = statSync(path).mtimeMs;
      return daysSince(stamp);
    } catch {
      return null;
    }
  }

  private storagePart(t: Text): StoragePart {
    return {
      id: 'world:memory-files',
      label: t.storageTitle,
      note: t.storageNote,
      paths: [{ label: 'root', path: this.root(), kind: 'dir' }],
    } as unknown as StoragePart;
  }

  private engineError(): string {
    return `没有可用的引擎：${engineWhyUnavailable()}`;
  }

  // ---------- 六个工具 ----------

  /** 只读：把写下来的东西读回去。醒来第一件事。 */
  private readTool(): ToolDef {
    return {
      name: 'ms_read',
      description:
        '读回你写下的记忆：STATE（现在）、todo（待办）、本月流水末尾、交接列表、最新一份交接，或根目录里任意一个文件。' +
        '醒来、被清空之后、或要确认「我到底答应过什么」时用它。只读，不改任何东西。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          what: {
            type: 'string',
            enum: ['state', 'todo', 'log', 'handoffs', 'index', 'handoff', 'file'],
            description:
              '读哪一样。state=STATE.md（现在在做什么）；todo=待办；log=本月流水末尾；handoffs=交接列表；' +
              'index=交接索引；handoff=一份交接（默认最新）；file=指定相对路径的文件。',
          },
          path: {
            type: 'string',
            description: 'what=file 时的相对路径，或 what=handoff 时的文件名。',
          },
          lines: {
            type: 'integer',
            description: 'what=log 时取最后多少行，默认 40。',
          },
        },
      },
      handler: async (args) => {
        const res = readMemory(this.root(), {
          what: args.what as never,
          path: typeof args.path === 'string' ? args.path : undefined,
          lines: typeof args.lines === 'number' ? args.lines : undefined,
        });
        return res.ok ? res.text : `读不到：${res.text}`;
      },
    };
  }

  /** 引力：记一条带重量的记忆。 */
  private entryTool(): ToolDef {
    return {
      name: 'ms_entry',
      description:
        '记一条带引力的记忆，进账本 `entries/YYYY-MM.tsv`（日期/时间/引力/钩子/简述/出处/标记）。' +
        '引力是 0–100：**几分是你自己的判断**，工具只负责记。已有的钩子再记一次就是「改引力」——' +
        '**改必须给原因**（做成事 / 重申 / 纠正），不给会被拒绝：曝光不算强化。' +
        '标记 anchor=true 的是锚点（锁 100，永不沉）。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['hook', 'brief'],
        properties: {
          hook: { type: 'string', description: '钩子：一提就能想起它的那个词（短，别跟别的条目重名）。' },
          brief: { type: 'string', description: '一两句说清这条是什么。' },
          weight: { type: 'integer', description: '引力 0–100。不填按 90（锚点自动 100）。' },
          date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天；补记旧事就写回它那天。' },
          time: { type: 'string', description: '时间 HH:MM，默认现在。' },
          source: { type: 'string', description: '出处：`log/2026-11.md:12` 或原话，方便以后核对。' },
          anchor: { type: 'boolean', description: '是锚点就填 true：引力锁 100，永不沉，只增不删。' },
          reason: {
            type: 'string',
            description: '改已有条目的引力时必填：做成过什么 / 对方怎么重申的 / 旧说法错在哪。',
          },
        },
      },
      handler: async (args) => {
        const r = writeEntry(this.root(), {
          hook: typeof args.hook === 'string' ? args.hook : undefined,
          brief: typeof args.brief === 'string' ? args.brief : undefined,
          weight: typeof args.weight === 'number' ? args.weight : undefined,
          date: typeof args.date === 'string' ? args.date : undefined,
          time: typeof args.time === 'string' ? args.time : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          anchor: args.anchor === true,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        });
        return r.text;
      },
    };
  }

  /** 引力：按水位取水面。 */
  private surfaceTool(): ToolDef {
    const cfg = this.cfg();
    return {
      name: 'ms_surface',
      description:
        '按引力水位取水面：anchors（锚）/ float（浮）/ half（半浮）/ sink（沉）/ all。' +
        '醒来想知道「现在什么最重要」就看 float；想看看哪些该清了就看 sink。' +
        `默认水位：浮线 ${cfg.gravityFloatLine}、沉线 ${cfg.gravitySinkLine}（设置里能改）。只读。`,
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: { type: 'string', enum: ['anchors', 'float', 'half', 'sink', 'all'], description: '看哪一层，默认 float。' },
          since: { type: 'string', description: '只看这一天之后的（YYYY-MM-DD）。' },
          keyword: { type: 'string', description: '只看钩子/简述/出处里带这个词的。' },
          limit: { type: 'integer', description: '最多几条，默认 40。' },
        },
      },
      handler: async (args) => {
        const c = this.cfg();
        return surface(this.root(), {
          layer: (typeof args.layer === 'string' ? args.layer : 'float') as Layer,
          since: typeof args.since === 'string' ? args.since : undefined,
          keyword: typeof args.keyword === 'string' ? args.keyword : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          floatLine: Number(c.gravityFloatLine ?? 85),
          sinkLine: Number(c.gravitySinkLine ?? 70),
        });
      },
    };
  }

  /** 引力：改一条的分，必须给原因。 */
  private weightTool(): ToolDef {
    return {
      name: 'ms_weight',
      description:
        '改一条已有记忆的引力：新值 + 原因。**原因只有三种算数**：做成事 / 重申 / 纠正；' +
        '不给原因直接拒绝——曝光不算强化（读到不算、看过不算、今天又翻了一遍不算）。' +
        '改动是**追加一行**，前面那行留着，所以「什么时候变的、为什么变」永远查得到。' +
        '锚点锁 100，调不动。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['hook', 'reason'],
        properties: {
          hook: { type: 'string', description: '改哪一条：钩子。' },
          weight: { type: 'integer', description: '新的引力 0–100。不填就只记这次的理由，分数不动。' },
          kind: {
            type: 'string',
            enum: ['做成事', '重申', '纠正'],
            description: '原因属于哪一种：①真拿它做成过事 ②对方重申过 ③被纠正过。',
          },
          reason: {
            type: 'string',
            description: '说清为什么动：做成了什么 / 对方原话 / 旧说法错在哪。',
          },
          source: { type: 'string', description: '出处（`log/2026-11.md:12` 或原话），不填沿用原来那条的。' },
        },
      },
      handler: async (args) => {
        const r = changeWeight(this.root(), {
          hook: typeof args.hook === 'string' ? args.hook : undefined,
          weight: typeof args.weight === 'number' ? args.weight : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
        });
        return r.text;
      },
    };
  }

  /** 引力：算闲置，只给建议，不动账本。 */
  private decayTool(): ToolDef {
    return {
      name: 'ms_decay',
      description:
        '衰减：算出各条「多久没被提过」，给一份下调建议。**只给建议，账本一个字不改**——' +
        '要落下得走 ms_weight（并给原因）。被反复动过的条目掉得慢；锚点不算。只读。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          minDays: { type: 'integer', description: '至少闲置这么多天才提一句，默认 30。' },
          limit: { type: 'integer', description: '最多列几条，默认 20。' },
        },
      },
      handler: async (args) => {
        const c = this.cfg();
        return decay(this.root(), {
          minDays: typeof args.minDays === 'number' ? args.minDays : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          floatLine: Number(c.gravityFloatLine ?? 85),
          sinkLine: Number(c.gravitySinkLine ?? 70),
        });
      },
    };
  }

  /** 按钩子捞：走钩子表，先给重的。 */
  private recallTool(): ToolDef {
    return {
      name: 'ms_recall',
      description:
        '按钩子捞：查 `hooks.md`（钩子 → 去处），回的是一行行「钩子 + 当前引力 + 原文那几行」，重的在前。' +
        '**跟 `ms_search` 分工**：它只捞进过钩子表的（知道轻重），裸搜交给 `ms_search`（什么都翻得到，但不知道轻重）。只读。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '钩子或它的一部分；不填就把整张表按引力从重到轻列出来。' },
          layer: {
            type: 'string',
            enum: ['anchors', 'float', 'half', 'sink'],
            description: '只看某一水位的（按账本里的当前引力算）。',
          },
          read: { type: 'boolean', description: '要不要把原文那几行也回出来，默认 true。' },
          lines: { type: 'integer', description: '原文读几行，默认 3。' },
          limit: { type: 'integer', description: '最多列几条，默认 10。' },
        },
      },
      handler: async (args) => {
        const c = this.cfg();
        return recall(this.root(), {
          query: typeof args.query === 'string' ? args.query : undefined,
          layer: (typeof args.layer === 'string' ? args.layer : undefined) as
            | 'anchors'
            | 'float'
            | 'half'
            | 'sink'
            | undefined,
          read: args.read !== false,
          lines: typeof args.lines === 'number' ? args.lines : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          floatLine: Number(c.gravityFloatLine ?? 85),
          sinkLine: Number(c.gravitySinkLine ?? 70),
        });
      },
    };
  }

  /** 留一个钩子：正文沉下去之后靠它捞回来。 */
  private hookTool(): ToolDef {
    return {
      name: 'ms_hook',
      description:
        '留一个钩子：往 `hooks.md`（根目录，跟 STATE.md 并排）写一行「钩子 | 去处 | 一句话」。' +
        '**不自动**：什么值得留个钩子是人/模型自己的判断，这条工具只负责写。' +
        '同一个钩子再写一次就是改去处；remove=true 删掉（原文还在文件里，ms_search 翻得到）。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['hook'],
        properties: {
          hook: { type: 'string', description: '钩子，短，最好跟账本里的钩子同名。' },
          target: { type: 'string', description: '去处：`路径` 或 `路径:行号`，相对记忆根目录。' },
          note: { type: 'string', description: '一句话备注（可省）。' },
          remove: { type: 'boolean', description: 'true = 从钩子表里删掉这一行。' },
        },
      },
      handler: async (args) => {
        const r = writeHook(this.root(), {
          hook: typeof args.hook === 'string' ? args.hook : undefined,
          target: typeof args.target === 'string' ? args.target : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          remove: args.remove === true,
        });
        return r.text;
      },
    };
  }

  /** 回忆：在根目录里按关键词找。 */
  private searchTool(): ToolDef {
    return {
      name: 'ms_search',
      description:
        '在记忆里按关键词找：返回「路径:行号: 那一行」，命中多处就多条。' +
        '想不起某件事发生在哪天、对方说过什么、上次是怎么解决的——用它，别整篇读。' +
        '默认连 archive/ 一起扫（搬走的东西不会真的消失）。只读。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: '关键词。一两个短词最好使（中文双字词、英文单词）；多个词用空格分开，同一行里都有才算命中。',
          },
          limit: {
            type: 'integer',
            description: '最多回几条，默认 30，上限 200。',
          },
          includeArchive: {
            type: 'boolean',
            description: '要不要连 archive/ 一起扫，默认 true。想只看「现在还在用的」就填 false。',
          },
        },
      },
      handler: async (args) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return '要一个关键词：query 不能是空的。';
        const res = searchMemory(this.root(), query, {
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          includeArchive: args.includeArchive !== false,
        });
        return formatSearch(res);
      },
    };
  }

  /** 写一条流水。 */
  private logTool(): ToolDef {
    return {
      name: 'ms_log',
      description:
        '往本月流水追加一行带时间戳的记录（一条一件事，写清发生了什么）。' +
        '做完一件事、答应一件事、发现一个坑、对方说了句要紧的话——当场写，别攒着。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: '这一行写什么。一两句就够，写事实：时间、谁说了什么、做完没做完。',
          },
        },
      },
      handler: async (args) => {
        const body = typeof args.text === 'string' ? args.text.trim() : '';
        if (!body) return '没写东西：text 不能是空的。';
        const r = await runEngine('log', this.root(), body);
        if (!r.ok) return `没写成：${r.err || r.out || `退出码 ${r.code}`}`;
        return r.out;
      },
    };
  }

  /** 只读体检。 */
  private checkTool(): ToolDef {
    return {
      name: 'ms_check',
      description:
        '体检：今天的 STATE 更新了没、今天写过流水没、交接进没进索引、有没有过期的待办、多久没备份。' +
        '只读，不改任何文件。清上下文之前、隔几天、或者心里没底的时候跑一次。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          _: { type: 'string', description: '不用填。' },
        },
      },
      handler: async () => {
        const r = await runEngine('check', this.root());
        if (!r.ok && !r.out) return `体检没跑起来：${r.err || `退出码 ${r.code}`}`;
        return r.out;
      },
    };
  }

  /** 起草交接。 */
  private handoffTool(): ToolDef {
    return {
      name: 'ms_handoff',
      description:
        '起草一份交接：把今天的流水和没做完的待办先塞进去，生成 handoffs/ 下的一份新文件，并登记进 INDEX。' +
        '然后你要自己补第 1、3、4 节（做完的 / 对方今天怎么样 / 踩过的坑）——它只负责把材料摆好。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          _: { type: 'string', description: '不用填。' },
        },
      },
      handler: async () => {
        const r = await runEngine('handoff', this.root());
        if (!r.ok) return `没写成：${r.err || r.out || `退出码 ${r.code}`}`;
        return `${r.out}\n\n接下来要你自己补的：第 1 节（这一段做完了什么）、第 3 节（对方今天怎么样）、第 4 节（踩过的坑、路径、编码）。`;
      },
    };
  }

  /** 备份。 */
  private backupTool(): ToolDef {
    return {
      name: 'ms_backup',
      description:
        '把整个记忆根目录拷一份到备份目录（memory-YYYY-MM-DD），并记下这次备份的日期。' +
        '日记、流水、交接都是普通文件，拷走就是全部。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dest: {
            type: 'string',
            description: '备份到哪个文件夹；不填就用设置里的，或数据目录下的 memory-backup。',
          },
        },
      },
      handler: async (args) => {
        const root = this.root();
        const dest = typeof args.dest === 'string' && args.dest.trim()
          ? expandPlaceholders(args.dest.trim(), this.botDir)
          : this.backupDest();
        const normalizedRoot = root.replace(/[\\/]+$/, '').toLowerCase();
        const normalizedDest = dest.replace(/[\\/]+$/, '').toLowerCase();
        if (normalizedDest === normalizedRoot || normalizedDest.startsWith(`${normalizedRoot}\\`) || normalizedDest.startsWith(`${normalizedRoot}/`)) {
          return `不行：备份目录不能放在记忆根目录里面（${dest}）。robocopy 会把刚拷出来的再拷一遍，越滚越大。换个地方。`;
        }
        const r = await runEngine('backup', root, dest);
        if (!r.ok) return `没备成：${r.err || r.out || `退出码 ${r.code}`}`;
        return r.out;
      },
    };
  }

  /** 建骨架。 */
  private initTool(): ToolDef {
    return {
      name: 'ms_init',
      description:
        '建好记忆的骨架：STATE.md / todo.md / log/（本月）/ handoffs/（含 INDEX）/ notes/ / archive/。' +
        '已经有的文件不会动。第一次装、或者换了个根目录时跑一次。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          _: { type: 'string', description: '不用填。' },
        },
      },
      handler: async () => {
        const root = this.root();
        const dest = this.backupDest();
        const r = await runEngine('init', root);
        if (!r.ok) return `没建成：${r.err || r.out || `退出码 ${r.code}`}`;
        return `${r.out}\n备份会落到：${dest}\n下一步：ms_log 写今天第一条，然后 ms_check 看还差什么。`;
      },
    };
  }
  /** 遗忘：把旧月份流水搬进 archive/，不删。 */
  private archiveTool(): ToolDef {
    return {
      name: 'ms_archive',
      description:
        '遗忘：把 log/ 里早于这个月的月份文件搬进 archive/log/。**只搬，不删**——搬走的 ms_search 照样找得到。' +
        '不给 apply 就只看不搬（先报会搬哪几份）。流水过 300 KB、或者本月文件被旧月份挤得读不到末尾时用。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apply: {
            type: 'boolean',
            description: '真搬才填 true；不填只报「会搬哪几份」。',
          },
          before: {
            type: 'string',
            description: '搬早于哪个月（YYYY-MM）。不填就是「早于这个月」。',
          },
        },
      },
      handler: async (args) => {
        const r = archiveLogs(this.root(), {
          apply: args.apply === true,
          before: typeof args.before === 'string' ? args.before : undefined,
        });
        return r.text;
      },
    };
  }
}

function expandPlaceholders(value: string, botDir: string): string {
  return value
    .replace(/\{workspace\}/gi, botDir)
    .replace(/\{botDir\}/gi, botDir)
    .replace(/^~[\\/]/, () => process.env.USERPROFILE ?? botDir);
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…\\${parts.slice(-2).join('\\')}`;
}
