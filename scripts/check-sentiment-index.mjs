/**
 * 散户情绪指数插件 · 指标纯函数离线冒烟
 *
 * 用法：
 * ```bash
 * node scripts/check-sentiment-index.mjs
 * ```
 *
 * 覆盖（混合源架构 1.1.0，全部离线断言，不联网）：
 * 1. THS 解析层：清单锚点 / 快照行（GBK HTML fixture）/ 年 K JSONP（含罗马后缀与脏行）；
 * 2. EM 解析层：fflow 字段序（小单在下标 2 / 7）、BK 清单解析、THS→BK 名称映射
 *    （等值 / 罗马后缀 / 别名表 / 不猜前缀）、池子 total；
 * 3. judge 指标层：分位窗口、缺席因子权重重分配、背离两条、滞后天数与成交额变化；
 * 4. scan 合并层：日 K 覆盖价量额并补涨跌幅、fflow 不开新行、未落定日不合并、
 *    快照保留、结果裁到基准日、非关注板块尾部行裁剪。
 */
import { createServer } from 'vite';

const ROOT = process.cwd();

/** 断言失败累积器（全部跑完再汇总） */
const failures = [];
/** 断言计数 */
let passed = 0;

/**
 * 断言
 * @param {boolean} condition 是否成立
 * @param {string} message 失败说明
 */
const assert = (condition, message) => {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(message);
};

/**
 * 断言近似相等（浮点）
 * @param {number|null} actual 实际值
 * @param {number} expected 期望值
 * @param {string} message 失败说明
 */
const assertClose = (actual, expected, message) => {
  assert(actual !== null && Math.abs(actual - expected) < 1e-6, `${message}（实际 ${actual}，期望 ${expected}）`);
};

// ---------- 加载插件源码（vite SSR） ----------
const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const emData = await server.ssrLoadModule('/plugins/dsh-sentiment-index/em-data.ts');
const thsData = await server.ssrLoadModule('/plugins/dsh-sentiment-index/ths-data.ts');
const judge = await server.ssrLoadModule('/plugins/dsh-sentiment-index/judge.ts');
const scan = await server.ssrLoadModule('/plugins/dsh-sentiment-index/scan.ts');

// ---------- 1) THS 解析层 ----------

// 清单锚点：行业只留 881xxx，概念留 885xxx / 30xxxx；同码去重
const thsIndustryHtml = `
  <a href="/thshy/detail/code/881121/" >半导体</a>
  <a href="/thshy/detail/code/881121/" >半导体</a>
  <a href="/thshy/detail/code/885333/" >不该出现</a>
  <a href="/thshy/detail/code/881273/" >白酒</a>`;
const industryRefs = thsData.parseBoardListHtml(thsIndustryHtml, 'industry');
assert(industryRefs.length === 2 && industryRefs[0]?.code === '881121', `THS 行业锚点：应 2 行且过滤非 881 码（实际 ${industryRefs.length}）`);
const conceptRefs = thsData.parseBoardListHtml(
  '<a href="/gn/detail/code/885333/" >AI算力</a><a href="/gn/detail/code/308555/" >ETC</a><a href="/gn/detail/code/881121/" >不该出现</a>',
  'concept',
);
assert(conceptRefs.length === 2, `THS 概念锚点：应 2 行（实际 ${conceptRefs.length}）`);

// 快照行：GBK 表格 fixture（列序：序号/板块/涨跌幅/量/额/净流入/上涨/下跌/均价/领涨股/最新价/涨跌幅）
const snapshotHtml = `<table><tr>
  <td>1</td>
  <td><a href="/thshy/detail/code/881121/">半导体</a></td>
  <td class="change">2.15</td><td>1200</td><td>2,080.0</td><td>12.5</td><td>120</td><td>30</td><td>10.2</td><td><a>某股</a></td><td>4000</td><td>2.15</td>
</tr><tr>
  <td>2</td>
  <td><a href="/thshy/detail/code/881273/">白酒</a></td>
  <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
</tr></table>`;
const snapshotRows = thsData.parseBoardListSnapshotHtml(snapshotHtml, 'industry');
assert(snapshotRows.length === 2, `THS 快照行：应 2 行（实际 ${snapshotRows.length}）`);
assert(
  snapshotRows[0]?.name === '半导体' && snapshotRows[0]?.pctChg === 2.15 && snapshotRows[0]?.upCount === 120,
  'THS 快照行：名称 / 涨跌幅 / 上涨家数应正确',
);
assertClose(snapshotRows[0]?.amount ?? null, 2080e8, 'THS 快照行：成交额应亿元换算为元');
assert(
  snapshotRows[1]?.pctChg === null && snapshotRows[1]?.upCount === null,
  'THS 快照行："-" 应归 null（绝不当 0）',
);
assert(snapshotRows[0]?.turnover === null, 'THS 快照行：换手率无此列恒 null（因子缺席自动重分配）');

// 年 K JSONP：字段序 日期,开,高,低,收,量,额；脏行丢弃；YYYYMMDD 转横杠
const klineJsonp = `quotebridge_x({"data":"20261028,100.0,103.0,99.0,102.0,12345,678901234;dirty;20261029,102.0,104.0,100.5,101.0,15000,700000000"})`;
const klines = thsData.parseKlineJsonp(klineJsonp);
assert(klines.length === 2, `THS 年K：脏行应丢弃得 2 行（实际 ${klines.length}）`);
assert(klines[0]?.date === '2026-10-28' && klines[0]?.close === 102, 'THS 年K：日期应转 YYYY-MM-DD、收在第 5 列');
assert(klines[0]?.amount === 678901234 && klines[0]?.volume === 12345, 'THS 年K：量额在第 6/7 列');

// ---------- 2) EM 解析层 ----------

// fflow：11 列，小单净额在下标 2、小单净占比在下标 7
const fflowPayload = JSON.stringify({
  data: {
    klines: [
      '2026-10-28,100,200,300,400,500,1.1,2.2,3.3,4.4,5.5',
      '2026-10-29,90,180,270,360,450,-1.0,-2.0,-3.0,-4.0,-5.0',
      'short,1,2',
    ],
  },
});
const fflows = emData.parseFflowJson(fflowPayload);
assert(fflows.length === 2, `fflow：短行应丢弃得 2 行，实际 ${fflows.length}`);
assert(fflows[0]?.mainNet === 100 && fflows[0]?.smallNet === 200, 'fflow：主力净额下标 1 / 小单净额下标 2');
assert(fflows[0]?.smallRatio === 2.2, 'fflow：小单净占比应在下标 7（f58）');

// BK 清单解析 + 名称映射（等值 / 罗马 / 别名 / 不猜）
const clistPayload = JSON.stringify({
  data: {
    diff: [
      { f12: 'BK1036', f14: '半导体' },
      { f12: 'BK0473', f14: '证券' },
      { f12: 'BK0475', f14: '银行 Ⅱ' },
      { f12: 'BK0535', f14: '航运港口' },
      { f12: '880000', f14: '非板块行' },
    ],
  },
});
const emBoards = emData.parseClistBoardJson(clistPayload);
assert(emBoards.length === 4, `BK 清单：应过滤非 BK 行得 4 行（实际 ${emBoards.length}）`);
const emMap = emData.matchThsToEm(
  [
    { code: '881121', name: '半导体' },
    { code: '881155', name: '银行' },
    { code: '881148', name: '港口航运' },
    { code: '881169', name: '贵金属' },
  ],
  emBoards,
);
assert(emMap['881121'] === 'BK1036', '映射：名称等值应命中');
assert(emMap['881155'] === 'BK0475', '映射：剥罗马后缀应命中（银行 → 银行 Ⅱ）');
assert(emMap['881148'] === 'BK0535', '映射：别名表应命中（港口航运 → 航运港口）');
assert(emMap['881169'] === undefined, '映射：东财无同义板块时不猜（散户因子如实缺席）');

assert(emData.parsePoolTotal('{"data":{"total":31}}') === 31, 'pool：应取 data.total');
assert(emData.parsePoolTotal('not-json') === null, 'pool：坏 JSON 应返回 null');

// ---------- 3) 指标层 ----------

/**
 * 构造合成日线
 * @param {number} count 天数
 * @param {(index: number) => {close?: number, smallRatio?: number|null, pct?: number}} [shape] 形状
 * @returns {object[]} 日线
 */
const makeDays = (count, shape = () => ({})) =>
  Array.from({ length: count }, (_, index) => {
    const extra = shape(index);
    const close = extra.close ?? 100 + index;
    return {
      date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 1000 + index,
      amount: 1e9 + index * 1e7,
      pctChg: extra.pct ?? 0.5,
      mainNet: null,
      mainRatio: null,
      smallNet: (extra.smallRatio ?? 0) * 1e8,
      smallRatio: extra.smallRatio ?? 0,
      upCount: null,
      downCount: null,
      turnover: null,
      limitUpCount: null,
    };
  });

// 3a) 分位窗口：单调占比序列尾部分位 = 100；样本不足（<20）记 null
{
  const days = makeDays(30);
  const market = days.map((day) => ({ date: day.date, totalAmount: 1e11 }));
  const series = judge.computeIndexSeries(days, judge.buildMarketMap(market));
  const last = series[series.length - 1];
  assertClose(last?.percentiles.amountShare ?? null, 100, '分位：单调占比序列尾部分位应为 100');
  const early = series[10];
  assert(early?.heatIndex === null, '分位：样本不足 20 时热度指数应为 null（缺样本 ≠ 正常）');
}

// 3b) 权重重分配：换手缺席时热度 = 其余因子分位按权重归一合成（等价 0.75:0.25）
{
  const days = makeDays(40);
  const market = days.map((day) => ({ date: day.date, totalAmount: 1e11 }));
  const series = judge.computeIndexSeries(days, judge.buildMarketMap(market));
  const last = series[series.length - 1];
  const sharePct = last?.percentiles.amountShare ?? 0;
  const volPct = last?.percentiles.volumeRatio ?? 0;
  assertClose(
    last?.heatIndex ?? null,
    (0.6 * sharePct + 0.2 * volPct) / 0.8,
    '权重重分配：换手缺席时热度 = 占比与放量分位按 0.6:0.2 归一合成',
  );
  const smallPct = last?.percentiles.smallNetRatio ?? 0;
  assertClose(
    last?.retailIndex ?? null,
    (0.4 * smallPct + 0.3 * sharePct) / 0.7,
    '权重重分配：赚钱效应缺席时散户情绪指数 = 小单与占比 0.4:0.3 归一合成',
  );
  assert(
    last?.percentiles.turnover === null && last?.percentiles.upRatio === null,
    '口径：缺席因子的分位保持 null（不当 0）',
  );
}

// 3c) 背离两条（直接构造序列断言）
{
  const days = Array.from({ length: 20 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    open: null,
    high: null,
    low: null,
    close: index < 15 ? 100 + index : 115 - (index - 14) * 3,
    volume: 1000,
    amount: 1e10,
    pctChg: index < 15 ? 1 : -2.5,
    mainNet: null,
    mainRatio: null,
    smallNet: 1e8,
    smallRatio: 1,
    upCount: null,
    downCount: null,
    turnover: null,
    limitUpCount: null,
  }));
  const series = days.map((day, index) => ({
    date: day.date,
    heatIndex: 50,
    retailIndex: index < 15 ? 50 : 80,
    factors: {},
    percentiles: {},
  }));
  const marks = judge.detectDivergences(series, days);
  assert(
    marks.some((mark) => mark.kind === 'blunt' && mark.date === days[19]?.date),
    `背离：价格 5 日新低 + 情绪 ≥60 应标「钝化」，实际 ${JSON.stringify(marks)}`,
  );

  const fadeDays = days.map((day, index) => ({
    ...day,
    close: 100 + index,
    pctChg: 1,
    smallNet: index >= 17 ? -1e8 : 1e8,
    smallRatio: index >= 17 ? -1 : 1,
  }));
  const fadeSeries = fadeDays.map((day, index) => ({
    date: day.date,
    heatIndex: 50,
    retailIndex: index === 19 ? 90 : 40 + (index % 30),
    factors: {},
    percentiles: {},
  }));
  const fadeMarks = judge.detectDivergences(fadeSeries, fadeDays);
  assert(
    fadeMarks.some((mark) => mark.kind === 'fade' && mark.date === fadeDays[19]?.date),
    `背离：情绪 5 日新高 + 小单连负 3 日应标「衰竭」，实际 ${JSON.stringify(fadeMarks)}`,
  );
}

// 3d) 滞后天数与成交额变化
{
  const dates = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  assert(judge.resolveStaleDays(dates, '2026-10-28', '2026-10-30') === 2, '滞后：隔 2 个交易日应记 2');
  assert(judge.resolveStaleDays(dates, '2026-10-30', '2026-10-30') === 0, '滞后：基准日当日为 0');
  const change = judge.marketAmountChangePct([
    { date: '2026-10-29', totalAmount: 1.5e12 },
    { date: '2026-10-30', totalAmount: 1.8e12 },
  ]);
  assertClose(change, 20, '成交额变化：1.5→1.8 万亿应为 +20%');
}

// ---------- 4) 合并层 ----------

const boardRef = { code: '881121', name: '半导体', kind: 'industry' };

// 4a) 日 K 覆盖价量额 + 按相邻收盘价补涨跌幅；快照字段保留；fflow 不开新行
{
  const existing = {
    ...boardRef,
    days: [
      {
        date: '2026-10-28',
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
        amount: null,
        pctChg: null,
        mainNet: null,
        mainRatio: null,
        smallNet: null,
        smallRatio: null,
        upCount: 120,
        downCount: 30,
        turnover: null,
        limitUpCount: null,
      },
    ],
  };
  const merged = scan.mergeBoardDays(
    existing,
    boardRef,
    [
      { date: '2026-10-27', open: 99, high: 100, low: 98, close: 99.5, volume: 1e5, amount: 2.0e11 },
      { date: '2026-10-28', open: 100, high: 103, low: 99, close: 102, volume: 1.2e5, amount: 2.08e11 },
    ],
    [{ date: '2026-10-29', mainNet: 5e9, mainRatio: 3, smallNet: -1e9, smallRatio: -0.6 }],
    null,
    '',
    new Map([['2026-10-28', 3]]),
    '2026-10-28',
  );
  const day = merged.days.find((item) => item.date === '2026-10-28');
  assert(day?.close === 102 && day?.open === 100, '合并：日 K 价量额应覆盖');
  assertClose(day?.pctChg ?? null, ((102 - 99.5) / 99.5) * 100, '合并：无快照时涨跌幅应由相邻收盘价补出');
  assert(day?.upCount === 120, '合并：快照字段（家数）应保留');
  assert(day?.limitUpCount === 3, '合并：涨停数应并入对应日期');
  assert(!merged.days.some((item) => item.date === '2026-10-29'), '合并：fflow 不应开新行（日 K 无该日）');
}

// 4b) 未落定日：快照日晚于基准日不合并、晚于基准日的行被裁掉
{
  const merged = scan.mergeBoardDays(
    undefined,
    boardRef,
    [
      { date: '2026-10-29', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
      { date: '2026-10-30', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 },
    ],
    null,
    { code: '881121', name: '半导体', pctChg: 9.9, amount: 9.9e12, turnover: null, mainNet: 1, upCount: 1, downCount: 1 },
    '2026-10-30',
    new Map(),
    '2026-10-29',
  );
  assert(!merged.days.some((day) => day.date === '2026-10-30'), '落定：晚于基准日的行应被裁掉');
  const day = merged.days.find((item) => item.date === '2026-10-29');
  assert(day?.pctChg === null, '落定：快照日（未落定日）的字段不得写入历史行');
}

// 4c) 非关注板块尾部行：只保留 TAIL_KEEP_DAYS 天
{
  const existing = {
    ...boardRef,
    days: Array.from({ length: 10 }, (_, index) => ({
      date: `2026-10-${String(20 + index).padStart(2, '0')}`,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null,
      amount: 1e10,
      pctChg: 1,
      mainNet: null,
      mainRatio: null,
      smallNet: null,
      smallRatio: null,
      upCount: 10,
      downCount: 5,
      turnover: null,
      limitUpCount: null,
    })),
  };
  const merged = scan.tailBoardDays(
    existing,
    boardRef,
    { code: '881121', name: '半导体', pctChg: 1.5, amount: 2e10, turnover: null, mainNet: 1e9, upCount: 11, downCount: 4 },
    '2026-10-30',
    '2026-10-30',
  );
  assert(merged.days.length === 5, `尾部行：应只保留 5 天，实际 ${merged.days.length}`);
  assert(merged.days.at(-1)?.date === '2026-10-30', '尾部行：最新快照日应追加成功');
  assert(merged.days.at(-1)?.upCount === 11, '尾部行：快照字段应写入');
}

// ---------- 汇总 ----------
await server.close();
if (failures.length > 0) {
  process.stderr.write(`✗ 散户情绪指数冒烟：${failures.length} 项失败（通过 ${passed} 项）\n`);
  for (const message of failures) process.stderr.write(`  - ${message}\n`);
  process.exit(1);
}
process.stdout.write(`✓ 散户情绪指数冒烟：${passed} 项断言全部通过\n`);
