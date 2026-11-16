/**
 * worlds['memory-files'] 的形状、默认值与设置页表单。
 * 默认 enabled=false：没在部署配置里打开时不会运行。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface MemoryFilesConfig {
  enabled: boolean;
  /** 记忆根目录：装着 STATE.md / todo.md / log/ / handoffs/ 的那个文件夹。留空 = 用 botDir。 */
  root: string;
  /** 备份落到哪个文件夹；留空 = <root>/backups（和根目录放一起，不往外拷）。 */
  backupDest: string;
  /** 流水文件超过这么多 KB 就在 check 里报一条「该切档了」。 */
  logWarnKB: number;
  /** 引力水位：≥ 这条线算「浮」，浮到水面（STATE / 现在）。默认 85。 */
  gravityFloatLine: number;
  /** 引力水位：< 这条线算「沉」，正文搬 archive、钩子留水面。默认 70。 */
  gravitySinkLine: number;
}

export const MEMORY_FILES_DEFAULTS: MemoryFilesConfig = {
  enabled: false,
  root: '',
  backupDest: '',
  logWarnKB: 300,
  gravityFloatLine: 85,
  gravitySinkLine: 70,
};

/** 设置页表单：键是 cfg 里的点分路径。全部热更新，改完不用重启。 */
export const MEMORY_FILES_CONFIG_GROUP: ConfigGroup = {
  id: 'world:memory-files',
  owner: 'world:memory-files',
  schema: {
    type: 'object',
    title: '文件记忆',
    description:
      '把「别把自己弄丢」这件事写成几条命令：一次醒来先读 STATE、写流水、定期做交接、定期备份。' +
      '文件就是记忆，换模型、清上下文、重启进程都不影响。',
    properties: {
      'worlds.memory-files.root': {
        type: 'string',
        title: '记忆根目录',
        description: '装着 STATE.md / todo.md / log/ / handoffs/ 的文件夹。留空就用伙伴自己的工作区目录。',
        'x-hot': true,
      },
      'worlds.memory-files.backupDest': {
        type: 'string',
        title: '备份到哪',
        description: '每次备份会把整个根目录拷到 <这里>/memory-YYYY-MM-DD。留空就放在根目录下的 backups/。',
        'x-hot': true,
      },
      'worlds.memory-files.logWarnKB': {
        type: 'integer',
        title: '流水多大该切档',
        description: '本月流水超过这个大小，体检时提醒一句把旧月份搬进 archive/。',
        minimum: 50,
        maximum: 2000,
        'x-suffix': 'KB',
        'x-hot': true,
      },
      'worlds.memory-files.gravityFloatLine': {
        type: 'integer',
        title: '引力 · 浮线',
        description: '引力 ≥ 这条线的条目浮到水面（写进 STATE 的「现在」）。默认 85，是起手式，不是真理。',
        minimum: 50,
        maximum: 100,
        'x-hot': true,
      },
      'worlds.memory-files.gravitySinkLine': {
        type: 'integer',
        title: '引力 · 沉线',
        description: '引力 < 这条线的条目算「沉」：正文搬 archive/，钩子留在水面。默认 70。',
        minimum: 10,
        maximum: 95,
        'x-hot': true,
      },
    },
  },
};
