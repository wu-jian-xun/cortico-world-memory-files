/**
 * 生成 describe.json（自描述：给扩展页和市场看，不进提示词）。
 *
 * 为什么要有这一步：definition.ts 里的 describe 和世界实际给出去的工具必须一致，
 * 手抄两遍总有一天抄歪。这里从 definition.ts 直接读，不重打一遍。
 *
 *   node --experimental-transform-types tools/gen-describe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
// 在 Windows 上动态 import 必须给 file:// URL，不能给盘符路径
const { MEMORY_FILES_WORLD } = await import(new URL('../src/definition.ts', import.meta.url).href);

const envPrompt = readFileSync(`${pkgRoot}src/ENV_PROMPT.md`, 'utf8');

const describe = {
  tools: MEMORY_FILES_WORLD.describe.tools,
  events: MEMORY_FILES_WORLD.describe.events ?? [],
  prompts: [
    {
      key: 'worlds.memory-files.envPrompt',
      title: '文件记忆 · 环境提示词',
      role: 'envPrompt',
      content: envPrompt,
    },
  ],
};

// 无 BOM UTF-8：JSON.parse 遇到 BOM 会直接报错
writeFileSync(`${pkgRoot}describe.json`, `${JSON.stringify(describe, null, 2)}\n`, 'utf8');
console.log(`describe.json 写好了：${describe.tools.length} 个工具 / ${describe.events.length} 个事件 / ${describe.prompts.length} 段提示词`);
