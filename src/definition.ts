/** World 定义：id/label/defaults/create + 自描述（给扩展页和市场看，不进提示词）。 */
import type { ToolDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { MEMORY_FILES_CONFIG_GROUP, MEMORY_FILES_DEFAULTS, type MemoryFilesConfig } from './config.ts';
import { MemoryFilesWorld } from './world.ts';

const TOOLS: ToolDescribe[] = [
  {
    name: 'ms_read',
    tags: ['read'],
    summary: '读回自己写下的记忆：STATE、待办、流水末尾、交接、任意文件。',
    description:
      '读回你写下的记忆：STATE（现在）、todo（待办）、本月流水末尾、交接列表、最新一份交接，或根目录里任意一个文件。醒来、被清空之后、或要确认「我到底答应过什么」时用它。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        what: {
          type: 'string',
          enum: ['state', 'todo', 'log', 'handoffs', 'index', 'handoff', 'file'],
          description: '读哪一样；默认 state。',
        },
        path: { type: 'string', description: 'what=file 时的相对路径，或 what=handoff 时的文件名。' },
        lines: { type: 'integer', description: 'what=log 时取最后多少行，默认 40。' },
      },
    },
  },
  {
    name: 'ms_search',
    tags: ['read'],
    summary: '在记忆里按关键词找：返回「路径:行号: 那一行」。',
    description:
      '在记忆里按关键词找：返回「路径:行号: 那一行」，命中多处就多条。想不起某件事发生在哪天、对方说过什么、上次怎么解决的——用它，别整篇读。默认连 archive/ 一起扫。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '关键词；多个词用空格分开，同一行里都有才算命中。' },
        limit: { type: 'integer', description: '最多回几条，默认 30。' },
        includeArchive: { type: 'boolean', description: '要不要连 archive/ 一起扫，默认 true。' },
      },
    },
  },
  {
    name: 'ms_entry',
    tags: ['write'],
    summary: '记一条带引力的记忆进账本；改引力必须给原因。',
    description:
      '记一条带引力的记忆，进账本 entries/YYYY-MM.tsv（日期/时间/引力/钩子/简述/出处/标记）。引力 0–100 是自己的判断。已有钩子再记一次=改引力，必须给原因（做成事/重申/纠正），否则拒绝：曝光不算强化。anchor=true 是锚点，锁 100 永不沉。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['hook', 'brief'],
      properties: {
        hook: { type: 'string', description: '钩子，短，别重名。' },
        brief: { type: 'string', description: '一两句说清这条是什么。' },
        weight: { type: 'integer', description: '引力 0–100，默认 90（锚点自动 100）。' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天。' },
        time: { type: 'string', description: 'HH:MM。' },
        source: { type: 'string', description: '出处。' },
        anchor: { type: 'boolean', description: 'true=锚点，锁 100 永不沉。' },
        reason: { type: 'string', description: '改引力时必填。' },
      },
    },
  },
  {
    name: 'ms_surface',
    tags: ['read'],
    summary: '按引力水位取水面：锚 / 浮 / 半浮 / 沉。',
    description:
      '按引力水位取水面：anchors / float / half / sink / all，可按日期和关键词过滤。醒来想知道「现在什么最重要」看 float，想看看哪些该清了看 sink。水位在设置里改。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layer: { type: 'string', enum: ['anchors', 'float', 'half', 'sink', 'all'], description: '默认 float。' },
        since: { type: 'string', description: 'YYYY-MM-DD 之后。' },
        keyword: { type: 'string', description: '按词过滤。' },
        limit: { type: 'integer', description: '默认 40。' },
      },
    },
  },
  {
    name: 'ms_weight',
    tags: ['write'],
    summary: '改一条的引力：必须给原因（做成事 / 重申 / 纠正）。',
    description:
      '改一条已有记忆的引力：新值 + 原因。原因只有三种算数：做成事 / 重申 / 纠正；不给原因直接拒绝——曝光不算强化。改动是追加一行，前面那行留着。锚点锁 100，调不动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['hook', 'reason'],
      properties: {
        hook: { type: 'string', description: '改哪一条：钩子。' },
        weight: { type: 'integer', description: '新的引力 0–100；不填只记理由，分数不动。' },
        kind: { type: 'string', enum: ['做成事', '重申', '纠正'], description: '原因属于哪一种。' },
        reason: { type: 'string', description: '做成了什么 / 对方原话 / 旧说法错在哪。' },
        source: { type: 'string', description: '出处，不填沿用原来的。' },
      },
    },
  },
  {
    name: 'ms_decay',
    tags: ['read'],
    summary: '算「多久没被提过」，给下调建议；账本一个字不改。',
    description:
      '衰减：算出各条「多久没被提过」，给一份下调建议。只给建议，账本不改——要落下得走 ms_weight 并给原因。被反复动过的掉得慢；锚点不算。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minDays: { type: 'integer', description: '至少闲置这么多天才提一句，默认 30。' },
        limit: { type: 'integer', description: '最多列几条，默认 20。' },
      },
    },
  },
  {
    name: 'ms_recall',
    tags: ['read'],
    summary: '按钩子捞：查 hooks.md，回「钩子 + 当前引力 + 原文那几行」，重的在前。',
    description:
      '按钩子捞：查 hooks.md（钩子 → 去处），回一行行「钩子 + 当前引力 + 原文那几行」，重的在前。跟 ms_search 分工：它只捞进过钩子表的（知道轻重），裸搜交给 ms_search。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '钩子或它的一部分；不填就按引力从重到轻列整张表。' },
        layer: { type: 'string', enum: ['anchors', 'float', 'half', 'sink'], description: '只看某一水位。' },
        read: { type: 'boolean', description: '要不要回原文，默认 true。' },
        lines: { type: 'integer', description: '原文读几行，默认 3。' },
        limit: { type: 'integer', description: '最多列几条，默认 10。' },
      },
    },
  },
  {
    name: 'ms_hook',
    tags: ['write'],
    summary: '留一个钩子进 hooks.md（根目录）：钩子 | 去处；不自动，靠人写。',
    description:
      '留一个钩子：往根目录 hooks.md 写一行「钩子 | 去处 | 一句话」。不自动——什么值得留钩子是人/模型的判断。同一个钩子再写=改去处；remove=true 删掉。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['hook'],
      properties: {
        hook: { type: 'string', description: '钩子，短。' },
        target: { type: 'string', description: '去处：路径 或 路径:行号，相对记忆根目录。' },
        note: { type: 'string', description: '一句话备注。' },
        remove: { type: 'boolean', description: 'true = 删掉这一行。' },
      },
    },
  },
  {
    name: 'ms_log',
    tags: ['write'],
    summary: '往本月流水追加一行带时间戳的记录。',
    description:
      '往本月流水追加一行带时间戳的记录（一条一件事，写清发生了什么）。做完一件事、答应一件事、发现一个坑、对方说了句要紧的话——当场写，别攒着。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: '这一行写什么，一两句就够。' } },
    },
  },
  {
    name: 'ms_check',
    tags: ['read'],
    summary: '体检：STATE、流水、交接索引、过期待办、多久没备份。',
    description:
      '体检：今天的 STATE 更新了没、今天写过流水没、交接进没进索引、有没有过期的待办、多久没备份。只读，不改文件。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'ms_handoff',
    tags: ['write'],
    summary: '起草一份交接：把今天的流水和没做完的待办塞进去。',
    description:
      '起草一份交接：把今天的流水和没做完的待办先塞进去，生成 handoffs/ 下的一份新文件，并登记进 INDEX。剩下的第 1、3、4 节要自己补。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'ms_backup',
    tags: ['write'],
    summary: '把整个记忆根目录拷一份到备份目录。',
    description:
      '把整个记忆根目录拷一份到备份目录（memory-YYYY-MM-DD），并记下这次备份的日期。备份目录不能放在根目录里面。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { dest: { type: 'string', description: '备份到哪个文件夹；不填用设置里的。' } },
    },
  },
  {
    name: 'ms_init',
    tags: ['write'],
    summary: '建好记忆骨架：STATE / todo / log / handoffs / notes / archive。',
    description:
      '建好记忆的骨架：STATE.md / todo.md / log/（本月）/ handoffs/（含 INDEX）/ notes/ / archive/。已经有的文件不会动。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'ms_archive',
    tags: ['write'],
    summary: '遗忘：把旧月份流水搬进 archive/，只搬不删。',
    description:
      '遗忘：把 log/ 里早于这个月的月份文件搬进 archive/log/。只搬，不删——搬走的 ms_search 照样找得到。不给 apply 就只看不搬。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: { type: 'boolean', description: '真搬才填 true。' },
        before: { type: 'string', description: '搬早于哪个月（YYYY-MM），不填就是早于这个月。' },
      },
    },
  },
];

export const MEMORY_FILES_WORLD: WorldDefinition<MemoryFilesConfig> = {
  id: 'memory-files',
  label: '文件记忆',
  defaults: () => ({ ...MEMORY_FILES_DEFAULTS }),
  create: (ctx) => new MemoryFilesWorld(ctx),
  describe: { tools: TOOLS, events: [] },
};

/** 设置页表单从这里拿（world.ts 的 webUi 也用同一份）。 */
export { MEMORY_FILES_CONFIG_GROUP };
