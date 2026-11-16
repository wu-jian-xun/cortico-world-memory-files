/**
 * 冒烟测试：在临时目录里把八条命令真跑一遍。
 * 不测「写得对不对」，只测「跑不跑得起来、回执说不说实话」。
 *
 *   node --experimental-transform-types tools/smoke.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { MEMORY_FILES_WORLD } = await import(new URL('../src/definition.ts', import.meta.url).href);

const sandbox = fileURLToPath(new URL('../tmp-smoke/', import.meta.url));
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const root = join(sandbox, 'memory');
const backup = join(sandbox, 'backup');

const world = MEMORY_FILES_WORLD.create({
  dataDir: join(sandbox, 'data'),
  botDir: root,
  timezone: 'Asia/Shanghai',
  cfg: { ...MEMORY_FILES_WORLD.defaults(), enabled: true, root: '', backupDest: backup },
});

const tools = new Map(world.tools().map((t) => [t.name, t]));
const call = async (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  const out = await tool.handler(args);
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  console.log(String(out).trim());
  return String(out);
};

let fails = 0;
const expect = (label, ok) => {
  if (!ok) fails += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
};

const init = await call('ms_init');
expect('init 说建好了', init.includes('init done'));
for (const name of ['STATE.md', 'todo.md', 'handoffs/INDEX.md', 'notes']) {
  expect(`init 之后有 ${name}`, existsSync(join(root, name)));
}

const logged = await call('ms_log', { text: '冒烟测试：写一行中文，看编码对不对——引号"、括号「」、逗号，都得原样。' });
expect('log 落到了 log/ 里', logged.includes('logged'));
const check = await call('ms_check');
expect('check 给了一句 VERDICT', /VERDICT:/.test(check));

const state = await call('ms_read', { what: 'state' });
expect('ms_read state 读得到模板正文', state.length > 10);
const tail = await call('ms_read', { what: 'log', lines: 5 });
expect('中文从文件里读回来没坏', tail.includes('冒烟测试') && tail.includes('引号'));

const handoff = await call('ms_handoff');
expect('handoff 说写好了', handoff.includes('handoff written'));

const again = await call('ms_check');
expect('第二次 check 里交接那条不再是空目录', !again.includes('handoffs/ is empty'));

const bad = await call('ms_backup', { dest: join(root, 'inside') });
expect('备份目录放在根目录里会被拦下', bad.includes('不行'));

const backed = await call('ms_backup');
expect('备份跑成了', backed.includes('backup done'));
expect('备份目录里真有东西', existsSync(backup) && existsSync(join(backup, `memory-${new Date().toISOString().slice(0, 10)}`)));

const missing = await call('ms_read', { what: 'file', path: '没有这个文件.md' });
expect('读不存在的文件如实说读不到', missing.includes('读不到'));

const empty = await call('ms_log', { text: '   ' });
expect('空正文被挡下', empty.includes('不能是空的'));

writeFileSync(join(root, 'notes', 'note.md'), 'x', 'utf8');

// ---- 回忆：关键词搜索 ----
const found = await call('ms_search', { query: '冒烟测试 编码' });
expect('ms_search 按两个词找得到那一行', found.includes('log/') && found.includes('冒烟测试'));
const missed = await call('ms_search', { query: '这句话根本没写过' });
expect('ms_search 没命中时说实话', missed.includes('没有命中'));
const noQuery = await call('ms_search', { query: '  ' });
expect('空关键词被挡下', noQuery.includes('不能是空的'));

// ---- 遗忘：搬家不删 ----
const oldMonth = join(root, 'log', '2025-01.md');
writeFileSync(oldMonth, '- **2025-01-09 03:00** 去年一月的一句旧流水：锚点词「鲸落」。\n', 'utf8');
const plan = await call('ms_archive', {});
expect('ms_archive 不给 apply 就只看不搬', plan.includes('会搬') && existsSync(oldMonth));
const moved = await call('ms_archive', { apply: true });
expect('ms_archive apply 之后真搬走了', moved.includes('搬好了') && !existsSync(oldMonth));
expect('archive/log 里有一月那份', existsSync(join(root, 'archive', 'log', '2025-01.md')));
const stillFound = await call('ms_search', { query: '鲸落' });
expect('搬走的东西 ms_search 还找得到', stillFound.includes('archive/log/2025-01.md'));
const excluded = await call('ms_search', { query: '鲸落', includeArchive: false });
expect('includeArchive=false 时就不扫 archive 了', !excluded.includes('archive/log/2025-01.md'));

// ---- 引力：记账、水位、改引力必须给原因 ----
const e1 = await call('ms_entry', { hook: '取名', brief: '2026-10-26 第一次给一条记忆起名字', weight: 100, anchor: true, date: '2026-10-26', source: 'log/2026-10.md' });
expect('ms_entry 记下了锚点', e1.includes('记下了') && e1.includes('100'));
const e2 = await call('ms_entry', { hook: '沙茶面', brief: '在厦门第一次吃沙茶面', weight: 60, source: 'log/2026-11.md' });
expect('ms_entry 记下了普通条目', e2.includes('沙茶面'));
const refused = await call('ms_entry', { hook: '沙茶面', brief: '随便改一下', weight: 40 });
expect('改引力不给原因会被拒绝', refused.includes('得给原因') && refused.includes('曝光不算强化'));
const changed = await call('ms_entry', {
  hook: '沙茶面',
  brief: '吃完真的热起来了，想起他喝美式',
  weight: 88,
  reason: '真拿它做成过事：靠它写了那篇游记',
});
expect('给原因就改得动', changed.includes('88') && changed.includes('60 → 88'));
const floatLayer = await call('ms_surface', { layer: 'float' });
expect('浮这一层里有改上去的那条', floatLayer.includes('沙茶面') && !floatLayer.includes('取名'));
const anchors = await call('ms_surface', { layer: 'anchors' });
expect('锚单独一层，且永不沉', anchors.includes('取名') && anchors.includes('锚'));
const sink = await call('ms_surface', { layer: 'sink' });
expect('沉那一层现在是空的，且说明沉不等于丢', sink.includes('没有条目') && sink.includes('ms_search'));
const all = await call('ms_surface', { layer: 'all' });
expect('all 能看到当前几条（同钩子只算一条）', all.includes('取名') && all.includes('沙茶面') && all.includes('当前 2 条'));
const ledger = existsSync(join(root, 'entries', '2026-11.tsv'))
  ? readFileSync(join(root, 'entries', '2026-11.tsv'), 'utf8')
  : '';
expect('改引力是追加不是覆盖：两行都在', (ledger.match(/沙茶面/g) ?? []).length >= 2);

// ---- ms_weight：改分必须给原因，锚调不动 ----
const noReason = await call('ms_weight', { hook: '沙茶面', weight: 70 });
expect('ms_weight 不给原因直接拒', noReason.includes('得给原因') && noReason.includes('曝光不算强化'));
const badKind = await call('ms_weight', { hook: '沙茶面', weight: 70, kind: '觉得它重要', reason: '今天又翻了一遍' });
expect('原因不在三类里也拒', badKind.includes('只能填这三种'));
const headsup = await call('ms_weight', { hook: '沙茶面', weight: 82, kind: '重申', reason: '他 11-16 早上又提了一次沙茶面' });
expect('给了原因就改得动', headsup.includes('88 → 82') && headsup.includes('重申'));
const anchorTry = await call('ms_weight', { hook: '取名', weight: 60, kind: '纠正', reason: '想把它挪下来' });
expect('锚点调不动', anchorTry.includes('锚点') && anchorTry.includes('锁 100'));
const ghost = await call('ms_weight', { hook: '没这条', weight: 50, kind: '做成事', reason: 'x' });
expect('没这条就如实说没有', ghost.includes('没有'));
const onlyReason = await call('ms_weight', { hook: '沙茶面', kind: '做成事', reason: '靠它写完了那篇游记' });
expect('只给理由不给分：分数不动，理由记下', onlyReason.includes('没动') && onlyReason.includes('游记'));

// ---- ms_decay：只给建议，不动账本 ----
const d60 = new Date();
d60.setDate(d60.getDate() - 60);
const oldDay = `${d60.getFullYear()}-${String(d60.getMonth() + 1).padStart(2, '0')}-${String(d60.getDate()).padStart(2, '0')}`;
const juneFile = join(root, 'entries', '2026-06.tsv');
writeFileSync(
  juneFile,
  '# 日期\t时间\t引力\t钩子\t简述\t出处\t标记\t记录于\n' +
    `${oldDay}\t08:00\t80\t老照片\t一张很早以前的照片，启程前那天拍的\t-\t\t${oldDay} 08:00\n`,
  'utf8',
);
const beforeLines = readFileSync(juneFile, 'utf8').split(/\r?\n/).filter(Boolean).length;
const decayed = await call('ms_decay', { minDays: 30 });
expect('ms_decay 找出闲置 60 天那条', decayed.includes('老照片') && decayed.includes('闲置 60 天'));
expect('ms_decay 给的是建议值', decayed.includes('建议 74'));
expect('ms_decay 明说不动账本', decayed.includes('账本一个字没改'));
expect('ms_decay 里锚点不出现', !decayed.includes('取名'));
const afterLines = readFileSync(juneFile, 'utf8').split(/\r?\n/).filter(Boolean).length;
expect('ms_decay 真的没动账本', beforeLines === afterLines);
const noneIdle = await call('ms_decay', { minDays: 9999 });
expect('门槛调高就一条都不提', noneIdle.includes('没有闲置'));

// ---- 钩子表 + ms_recall：沉下去靠钩子捞回来 ----
const emptyRecall = await call('ms_recall', {});
expect('钩子表空着就如实说空，并指向 ms_search', emptyRecall.includes('还是空的') && emptyRecall.includes('ms_search'));
const hooked = await call('ms_hook', { hook: '沙茶面', target: 'hooksTarget.md:2', note: '厦门第一碗' });
expect('ms_hook 留了钩子', hooked.includes('留了钩子'));
writeFileSync(join(root, 'hooksTarget.md'), '# 一段旧事\n第一碗沙茶面，汤是甜的，汗一下出来了。\n', 'utf8');
const recalled = await call('ms_recall', { query: '沙茶' });
expect('ms_recall 命中钩子并带出当前引力', recalled.includes('沙茶面') && recalled.includes('引力 82'));
expect('ms_recall 把原文那几行读回来了', recalled.includes('汤是甜的'));
const anchorRecall = await call('ms_recall', { layer: 'anchors' });
expect('按水位筛：锚那一层里没有沙茶面', anchorRecall.includes('没有') && !anchorRecall.includes('汤是甜的'));
const hookGhost = await call('ms_hook', { hook: '沙茶面', target: '../逃出去.md' });
expect('去处越出根目录被拦下', hookGhost.includes('越出了记忆根目录'));
const hookGone = await call('ms_hook', { hook: '没这条', remove: true });
expect('删不存在的钩子如实说', hookGone.includes('没什么可删'));
const hookBank = await call('ms_hook', { hook: '老照片', target: 'entries/2026-06.tsv', note: '空着也行' });
expect('钩子能指到没有行号的地方', hookBank.includes('留了钩子'));
const removed = await call('ms_hook', { hook: '老照片', remove: true });
expect('钩子删得掉', removed.includes('删了'));

if (fails === 0) {
  console.log('\nALL CLEAR：存储、回忆、遗忘、引力、衰减、钩子都跑通了。');
  process.exitCode = 0;
} else {
  console.log(`\n${fails} 处没过，先修再发。`);
  process.exitCode = 1;
}
