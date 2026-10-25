/**
 * 宽基跟踪插件 · 取数解析层离线自检
 *
 * 用法：
 * ```bash
 * node scripts/check-broad-track-parse.mjs
 * ```
 *
 * **为什么需要它**：插件的取数链路（HTTP → 解析 → 落库）在开发期靠肉眼验收，
 * 但上游返回形态是**外部契约** —— 东财 F10 给的是 JavaScript 对象字面量
 * （`var gmbd_apidata={content:"<table>…"}`，key 不带引号），
 * **不是合法 JSON**。2026-10-25 就因此踩过一次：解析层用 `JSON.parse` 解析整个对象，
 * 在第 2 个字符就抛 "Expected property name"，函数返回 null，
 * 上层拿到 0 行却**不报错** —— 界面只显示「份额 0 行、持有人 0 行」，
 * 排查方向完全被带偏（先怀疑网络 / 宿主通道，绕了很大一圈）。
 *
 * 这类「静默归零」是插件最危险的失败模式：请求成功、无告警、结果为空。
 * 所以把**上游真实样本**固化成 fixture（`scripts/fixtures/`），
 * 每次改解析层都跑一遍断言 —— 形态一变、列序一变、索引错位，立刻红。
 *
 * 覆盖三件事：
 * 1. `extractF10Object` 能从 JS 对象字面量里剥出 `content`（含转义处理）；
 * 2. 两张表的**列索引**与上游表头一致（份额 6 列 / 持有人 5 列）；
 * 3. 关键数值口径正确（份额单位「亿份」、净资产「亿元」、比例「%」）。
 *
 * 2026-10-25 追加（东财行情域被整域掐断后的降级链）：
 * 4. `parseSinaHqQuotes` 能从新浪 hq 文本还原行情（20 个标的全覆盖）；
 * 5. `parseSinaMoneyFlow` 能从新浪资金流 JSON 还原主力 / 超大单两档，
 *    且**小单 / 中单 / 大单留 null**（不当 0 用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures');

/** 断言失败累积器（全部跑完再汇总，不在第一个失败就退出） */
const failures = [];

/**
 * 断言
 * @param {boolean} condition 是否成立
 * @param {string} message 失败说明
 */
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

/**
 * 读取 fixture 文本
 * @param {string} name 文件名
 * @returns {string} 内容
 */
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ---------- 加载插件解析层（vite SSR 加载 .ts 源码） ----------
const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const {
  extractF10Object,
  parseGmbdTable,
  parseCyrjgTable,
  parseSinaHqQuotes,
  parseSinaMoneyFlow,
} = await server.ssrLoadModule('/plugins/dsh-broad-track/em-parse.ts');
const { EM_F10_GMBD_FIELD, EM_F10_CYRJG_FIELD } = await server.ssrLoadModule(
  '/plugins/dsh-broad-track/constants.ts',
);
const {
  parseSseShareSnapshot,
  parseSzseShareHistory,
  parseTencentKline,
  computeShareChanges,
  normalizeDate,
} = await server.ssrLoadModule('/plugins/dsh-broad-track/share-parse.ts');
const {
  buildComboSeries,
  buildShareSignalWaves,
  runShareBacktest,
  percentileOf,
} = await server.ssrLoadModule('/plugins/dsh-broad-track/share-signal.ts');
const { addDays } = await server.ssrLoadModule('/plugins/dsh-broad-track/share-data.ts');

// ---------- 1) 份额变动表（gmbd） ----------
const gmbdText = readFixture('f10-gmbd.txt');
const gmbdPayload = extractF10Object(gmbdText, 'gmbd_apidata');

assert(gmbdPayload !== null, 'gmbd：extractF10Object 应返回对象（上游是 JS 对象字面量，不是 JSON）');
assert(
  typeof gmbdPayload?.content === 'string' && gmbdPayload.content.length > 1000,
  'gmbd：content 应为非空 HTML 表格文本',
);
assert(
  !gmbdPayload?.content.includes('\\"'),
  'gmbd：content 不应残留反斜杠转义（JS 字符串字面量应被正确解码）',
);

const gmbdRows = parseGmbdTable(gmbdPayload?.content ?? '', '510300');
assert(gmbdRows.length > 10, `gmbd：应解析出多行季度数据，实际 ${gmbdRows.length}`);
assert(
  gmbdRows[0]?.periodEnd === '2026-06-30',
  `gmbd：首行报告期应为 2026-06-30，实际 ${gmbdRows[0]?.periodEnd}`,
);
assert(
  gmbdRows[0]?.subscribeYi === 61.27,
  `gmbd：期间申购应为 61.27 亿份，实际 ${gmbdRows[0]?.subscribeYi}`,
);
assert(
  gmbdRows[0]?.redeemYi === 320.41,
  `gmbd：期间赎回应为 320.41 亿份，实际 ${gmbdRows[0]?.redeemYi}`,
);
assert(
  gmbdRows[0]?.sharesEndYi === 189.15,
  `gmbd：期末总份额应为 189.15 亿份，实际 ${gmbdRows[0]?.sharesEndYi}`,
);
assert(
  gmbdRows[0]?.netAssetYi === 948.72,
  `gmbd：期末净资产应为 948.72 亿元，实际 ${gmbdRows[0]?.netAssetYi}`,
);
assert(
  gmbdRows[0]?.assetChangeRate === -52.54,
  `gmbd：净资产变动率应为 -52.54%，实际 ${gmbdRows[0]?.assetChangeRate}`,
);
// 列索引与表头对齐（表头：日期/期间申购/期间赎回/期末总份额/期末净资产/净资产变动率）
assert(
  EM_F10_GMBD_FIELD.PERIOD_END === 0 &&
    EM_F10_GMBD_FIELD.SUBSCRIBE === 1 &&
    EM_F10_GMBD_FIELD.REDEEM === 2 &&
    EM_F10_GMBD_FIELD.SHARES_END === 3 &&
    EM_F10_GMBD_FIELD.NET_ASSET === 4 &&
    EM_F10_GMBD_FIELD.ASSET_CHANGE_RATE === 5,
  'gmbd：列索引常量与上游表头顺序不一致',
);

// ---------- 2) 持有人结构表（cyrjg） ----------
const cyrjgText = readFixture('f10-cyrjg.txt');
const cyrjgPayload = extractF10Object(cyrjgText, 'apidata');

assert(cyrjgPayload !== null, 'cyrjg：extractF10Object 应返回对象');
assert(
  typeof cyrjgPayload?.content === 'string' && cyrjgPayload.content.length > 500,
  'cyrjg：content 应为非空 HTML 表格文本',
);

const cyrjgRows = parseCyrjgTable(cyrjgPayload?.content ?? '', '510300');
assert(cyrjgRows.length > 5, `cyrjg：应解析出多行持有人数据，实际 ${cyrjgRows.length}`);
assert(
  cyrjgRows[0]?.periodEnd === '2026-06-30',
  `cyrjg：首行公告日应为 2026-06-30，实际 ${cyrjgRows[0]?.periodEnd}`,
);
assert(
  cyrjgRows[0]?.instRatio === 61.65,
  `cyrjg：机构持有比例应为 61.65%，实际 ${cyrjgRows[0]?.instRatio}`,
);
// ⚠️ 总份额在第 5 列（索引 4），不是第 4 列（索引 3，那是「内部持有比例」）
assert(
  cyrjgRows[0]?.totalSharesYi === 189.15,
  `cyrjg：总份额应为 189.15 亿份（索引 4），实际 ${cyrjgRows[0]?.totalSharesYi}`,
);
// 列索引与表头对齐（表头：公告日期/机构持有比例/个人持有比例/内部持有比例/总份额）
assert(
  EM_F10_CYRJG_FIELD.PERIOD_END === 0 &&
    EM_F10_CYRJG_FIELD.INST_RATIO === 1 &&
    EM_F10_CYRJG_FIELD.PERSON_RATIO === 2 &&
    EM_F10_CYRJG_FIELD.INTERNAL_RATIO === 3 &&
    EM_F10_CYRJG_FIELD.TOTAL_SHARES === 4,
  'cyrjg：列索引常量与上游表头顺序不一致（总份额是第 5 列 / 索引 4）',
);

// ---------- 3) 负例：形态不符必须返回 null（而不是抛错或返回脏值） ----------
assert(
  extractF10Object('var gmbd_apidata={content:"x"};', 'not_exist') === null,
  'extractF10Object：变量名不存在时应返回 null',
);
assert(
  extractF10Object('var gmbd_apidata={data:[{content:"x"}]};', 'gmbd_apidata') === null,
  'extractF10Object：content 只在嵌套层时应返回 null（不取脏值）',
);

// ---------- 4) 新浪 hq 行情（降级源，2026-10-25 追加） ----------
const sinaHqText = readFixture('sina-hq.txt');
const sinaQuotes = parseSinaHqQuotes(sinaHqText);

assert(
  sinaQuotes.length === 20,
  `sina-hq：应解析出 20 个标的（14 只 ETF + 6 个指数），实际 ${sinaQuotes.length}`,
);
assert(
  sinaQuotes.every((row) => /^\d{6}$/.test(row.code)),
  'sina-hq：每行 code 应为 6 位裸码（已去掉 sh/sz 前缀）',
);

const q300 = sinaQuotes.find((row) => row.code === '510300');
assert(q300 !== undefined, 'sina-hq：应包含 510300');
// 与腾讯源交叉核对过：510300 on 2026-10-23 → 收盘 4.178 / 涨跌幅 1.73% / 成交额 15423238067
assert(
  q300?.price === 4.178,
  `sina-hq：510300 最新价应为 4.178，实际 ${q300?.price}`,
);
assert(
  q300?.changePercent !== null
    && Math.abs(q300.changePercent - 1.73) < 0.02,
  `sina-hq：510300 涨跌幅应约 1.73%（由昨收自算），实际 ${q300?.changePercent}`,
);
assert(
  q300?.amount === 15423238067,
  `sina-hq：510300 成交额应为 15423238067 元，实际 ${q300?.amount}`,
);
assert(
  q300?.name === '沪深300ETF华泰柏瑞',
  `sina-hq：510300 名称应为「沪深300ETF华泰柏瑞」，实际 ${q300?.name}`,
);

// 指数同样要能解析（指数代码也是 6 位裸码）
const idx300 = sinaQuotes.find((row) => row.code === '000300');
assert(idx300 !== undefined, 'sina-hq：应包含指数 000300');
assert(
  idx300?.price === 4105.3286,
  `sina-hq：沪深300 指数点位应为 4105.3286，实际 ${idx300?.price}`,
);

// 负例：空体（上游对无效代码返回 hq_str_xxx=""）应被丢弃
assert(
  parseSinaHqQuotes('var hq_str_sh999999="";').length === 0,
  'sina-hq：空数据行应被丢弃（不产生空行）',
);
assert(
  parseSinaHqQuotes('').length === 0,
  'sina-hq：空响应应返回空数组',
);

// ---------- 5) 新浪资金流（降级源，2026-10-25 追加） ----------
const sinaMfText = readFixture('sina-moneyflow.txt');
const sinaMfRows = parseSinaMoneyFlow(sinaMfText);

assert(
  sinaMfRows.length >= 20,
  `sina-moneyflow：应解析出多日资金流，实际 ${sinaMfRows.length}`,
);
const mf0 = sinaMfRows[0];
assert(
  mf0?.date === '2026-10-23',
  `sina-moneyflow：首行日期应为 2026-10-23（上游降序），实际 ${mf0?.date}`,
);
assert(
  mf0?.mainInflow === 1308942683.773,
  `sina-moneyflow：主力净流入应为 1308942683.773 元，实际 ${mf0?.mainInflow}`,
);
assert(
  mf0?.superInflow === 1234942251.573,
  `sina-moneyflow：超大单净流入应为 1234942251.573 元，实际 ${mf0?.superInflow}`,
);
// ⚠️ 涨跌幅上游是小数（0.0170441），解析后必须是百分数（1.70）
assert(
  mf0?.changePercent !== null && Math.abs(mf0.changePercent - 1.70441) < 0.001,
  `sina-moneyflow：涨跌幅应从小数换算为百分数（1.70441），实际 ${mf0?.changePercent}`,
);
assert(
  mf0?.close === 4.177,
  `sina-moneyflow：收盘价应为 4.177，实际 ${mf0?.close}`,
);
// ⚠️ 新浪只给两档 —— 其余三档必须留 null，绝不能当 0 用
assert(
  mf0?.bigInflow === null && mf0?.midInflow === null && mf0?.smallInflow === null,
  'sina-moneyflow：小单 / 中单 / 大单应留 null（新浪只有两档，不当 0 用）',
);

// 负例：空数组与脏响应
assert(
  parseSinaMoneyFlow('[]').length === 0,
  'sina-moneyflow：空数组应返回空数组',
);
assert(
  parseSinaMoneyFlow('not json').length === 0,
  'sina-moneyflow：脏响应应返回空数组（不抛错）',
);

// ---------- 6) 份额序列解析（上交所逐日全市场） ----------
const sseText = readFixture('sse-shares.json');
const sseRows = parseSseShareSnapshot(sseText, '2026-10-23');
assert(sseRows.length > 500, `sse-shares：应解析出全市场 ETF（实得 ${sseRows.length} 行）`);

const sse300 = sseRows.find((row) => row.code === '510300');
assert(sse300 !== undefined, 'sse-shares：应含 510300');
// 上游 TOT_VOL 单位万份：3524268.77 万份 → 352.426877 亿份
assert(
  Math.abs(sse300.sharesYi - 352.426877) < 0.001,
  `sse-shares：510300 份额应为 352.4269 亿份（实得 ${sse300.sharesYi}）`,
);
assert(sse300.date === '2026-10-23', 'sse-shares：日期应取上游 STAT_DATE');
assert(sse300.name === '300ETF', `sse-shares：名称应取上游 SEC_NAME（实得 ${sse300.name}）`);

// 负例：脏响应与空结果
assert(
  parseSseShareSnapshot('not json', '2026-10-23').length === 0,
  'sse-shares：脏响应应返回空数组（不抛错）',
);
assert(
  parseSseShareSnapshot(JSON.stringify({ result: [] }), '2026-10-23').length === 0,
  'sse-shares：空 result 应返回空数组',
);
assert(
  parseSseShareSnapshot(
    JSON.stringify({ result: [{ SEC_CODE: 'bad', TOT_VOL: '1' }, { SEC_CODE: '510300', TOT_VOL: 'x' }] }),
    '2026-10-23',
  ).length === 0,
  'sse-shares：坏代码与坏份额应被丢弃',
);

// ---------- 7) 深交所逐日份额解析 ----------
const szseText = readFixture('szse-shares.json');
const szseRows = parseSzseShareHistory(szseText, '159919');
assert(szseRows.length === 4, `szse-shares：应解析出 4 行（实得 ${szseRows.length}）`);
// current_size 单位万份：42,150.00 万份 → 4.215 亿份
assert(
  Math.abs(szseRows[0].sharesYi - 4.215) < 0.0001,
  `szse-shares：159919 份额应为 4.215 亿份（实得 ${szseRows[0].sharesYi}）`,
);
assert(szseRows[0].date === '2026-10-23', 'szse-shares：日期应取 size_date');
assert(szseRows[0].code === '159919', 'szse-shares：代码应取传入值');
assert(
  parseSzseShareHistory('not json', '159919').length === 0,
  'szse-shares：脏响应应返回空数组（不抛错）',
);

// ---------- 8) 腾讯不复权日 K 解析 ----------
const tencentText = readFixture('tencent-kline.json');
const tencentRows = parseTencentKline(tencentText, 'sh510300');
assert(tencentRows.length > 20, `tencent-kline：应解析出 20+ 行（实得 ${tencentRows.length}）`);
assert(
  tencentRows.every((row) => row.close > 0),
  'tencent-kline：收盘价应全为正数',
);
assert(
  tencentRows[tencentRows.length - 1].date === '2026-10-23',
  `tencent-kline：末行日期应为 2026-10-23（实得 ${tencentRows[tencentRows.length - 1].date}）`,
);
assert(
  Math.abs(tencentRows[tencentRows.length - 1].close - 4.178) < 0.001,
  `tencent-kline：510300 收盘应为 4.178（实得 ${tencentRows[tencentRows.length - 1].close}）`,
);
assert(
  parseTencentKline('not json', 'sh510300').length === 0,
  'tencent-kline：脏响应应返回空数组（不抛错）',
);

// ---------- 9) 日期规范化与加天数 ----------
assert(normalizeDate('2026/1/5') === '2026-01-05', 'normalizeDate：斜杠应规范化');
assert(normalizeDate('bad') === '', 'normalizeDate：非法日期应返回空串');
assert(addDays('2026-02-28', 1) === '2026-03-01', 'addDays：应跨月');
assert(addDays('2024-02-28', 1) === '2024-02-29', 'addDays：应识别闰年');
assert(addDays('2024-01-01', -1) === '2023-12-31', 'addDays：应支持负数');

// ---------- 10) 份额变动与净申赎金额 ----------
const priceRows = new Map([
  ['510300', new Map([['2026-10-22', 4.0], ['2026-10-23', 4.2]])],
]);
const changeRows = [
  { code: '510300', date: '2026-10-21', sharesYi: 100 },
  { code: '510300', date: '2026-10-22', sharesYi: 110 },
  { code: '510300', date: '2026-10-23', sharesYi: 105 },
];
const changes = computeShareChanges(changeRows, priceRows);
assert(
  Math.abs(changes.get('2026-10-22')?.get('510300').deltaYi - 10) < 1e-9,
  'computeShareChanges：份额变动应为 +10 亿份',
);
assert(
  Math.abs(changes.get('2026-10-23')?.get('510300').deltaYi + 5) < 1e-9,
  'computeShareChanges：份额变动应为 -5 亿份',
);
// 金额 = Δ份额 × 当日收盘价：10 亿份 × 4.0 元 = 40 亿元
assert(
  Math.abs(changes.get('2026-10-22')?.get('510300').amountYi - 40) < 1e-9,
  `computeShareChanges：净申赎金额应为 40 亿元（实得 ${changes.get('2026-10-22')?.get('510300').amountYi}）`,
);
// 价格缺失 → 金额为 null（不是 0）
assert(
  changes.get('2026-10-21') === undefined,
  'computeShareChanges：首个交易日无「上一交易日」，不应产生变动',
);

// ---------- 11) 组合序列与信号引擎 ----------
/**
 * 造一份可控的份额序列（用于信号判定断言）
 * @param {string} code 6 位代码
 * @param {Array<[string, number, number]>} series [日期, 份额（亿份）, 收盘价]
 * @returns {Array<object>} 份额行
 */
const makeRows = (code, series) =>
  series.map(([date, sharesYi, price]) => ({
    date,
    code,
    sharesYi,
    deltaYi: 0,
    price,
    amountYi: null,
    source: 'sse',
  }));

// ---------- 11a) 固定权重指数与份额变动解耦 ----------
// 价格恒定 → 指数恒为 100（份额怎么变都不该影响价格指数）
const flatRows = makeRows('510300', [
  ['2026-01-05', 1000, 10],
  ['2026-01-06', 1010, 10],
  ['2026-01-07', 1020, 10],
]);
for (let i = 1; i < flatRows.length; i += 1) {
  flatRows[i].deltaYi = flatRows[i].sharesYi - flatRows[i - 1].sharesYi;
  flatRows[i].amountYi = flatRows[i].deltaYi * flatRows[i].price;
}
flatRows[0].amountYi = 0;
const flatCombo = buildComboSeries(new Map([['510300', flatRows]]));
assert(
  flatCombo.every((point) => Math.abs(point.avgPrice - 100) < 0.01),
  'buildComboSeries：价格不变时指数应恒定（与份额变动解耦）',
);
assert(
  Math.abs(flatCombo[0].avgPrice - 100) < 0.01,
  `buildComboSeries：基准日指数应为 100（实得 ${flatCombo[0].avgPrice}）`,
);

// ---------- 11b) 退场信号：高位 + 连续净减 ----------
// 30 个交易日：前 25 日价格与份额同步上行（指数一路上行 → 末端处于历史高位），
// 后 5 日份额连续净减 30 亿份/日 → 应触发「退场」波段。
const riseShares = Array.from({ length: 30 }, (_, i) => [
  `2026-01-${String(i + 1).padStart(2, '0')}`,
  i <= 24 ? 1000 + i * 10 : 1240 - (i - 24) * 30,
  10 + i * 0.12,
]);
const comboRows = makeRows('510300', riseShares);
for (let i = 1; i < comboRows.length; i += 1) {
  comboRows[i].deltaYi = comboRows[i].sharesYi - comboRows[i - 1].sharesYi;
  comboRows[i].amountYi = comboRows[i].deltaYi * comboRows[i].price;
}
comboRows[0].amountYi = 0;

const comboMap = new Map([['510300', comboRows]]);
const combo = buildComboSeries(comboMap);
assert(combo.length === 30, `buildComboSeries：应有 30 个点（实得 ${combo.length}）`);
assert(
  Math.abs(combo[0].avgPrice - 100) < 0.01,
  `buildComboSeries：基准日指数应为 100（实得 ${combo[0].avgPrice}）`,
);
// ⚠️ **当日价必须当日生效**（不能滞后一日）：第 10 日价 11.2 → 指数 112。
// 若实现写成「无条件用上一日价」，这里会得到 111.6（滞后一日）。
assert(
  Math.abs(combo[10].avgPrice - 112) < 0.01,
  `buildComboSeries：指数应反映当日收盘价（期望 112，实得 ${combo[10].avgPrice}）`,
);

const waves = buildShareSignalWaves(combo);
assert(waves.length >= 1, 'buildShareSignalWaves：应至少产出一个波段');
const exitWave = waves.find((wave) => wave.level === 'exit');
assert(exitWave !== undefined, 'buildShareSignalWaves：高位连续净减应触发退场波段');
assert(exitWave.streak >= 3, `buildShareSignalWaves：退场波段连续天数应 ≥3（实得 ${exitWave?.streak}）`);
assert(
  exitWave.netFlowYi !== null && exitWave.netFlowYi < 0,
  'buildShareSignalWaves：退场波段净申赎应为负',
);
const enterWave = waves.find((wave) => wave.level === 'enter');
assert(enterWave !== undefined, 'buildShareSignalWaves：低位连续净增应触发进场波段');

// 分位计算
const levels = Array.from({ length: 30 }, (_, i) => 100 + i);
assert(
  percentileOf(levels, 100) === 0,
  'percentileOf：最低值分位应为 0',
);
// 取最大值本身（129）：严格小于它的有 29 个 → 29/30
assert(
  Math.abs((percentileOf(levels, 129) ?? 0) - 29 / 30) < 0.01,
  'percentileOf：最高值分位应接近 1',
);
assert(percentileOf([1, 2], 5) === null, 'percentileOf：样本不足应返回 null');

// 回测：波段级统计
const stats = runShareBacktest(combo, 5);
assert(stats.length === 2, 'runShareBacktest：应按进场 / 退场两档产出统计');
assert(
  stats.find((item) => item.level === 'exit')?.count === 1,
  'runShareBacktest：退场波段应只计 1 次（不按天重复计）',
);
assert(
  stats.find((item) => item.level === 'enter')?.count === 1,
  'runShareBacktest：进场波段应只计 1 次（不按天重复计）',
);

await server.close();

// ---------- 汇总 ----------
if (failures.length > 0) {
  process.stderr.write(`✗ 宽基跟踪解析层自检失败（${failures.length} 项）：\n`);
  for (const message of failures) process.stderr.write(`  · ${message}\n`);
  process.exit(1);
}
process.stdout.write(
  '✓ 宽基跟踪解析层自检通过（F10 对象字面量剥离 / 两张表列序 / 数值口径 / 负例 / 新浪降级源解析 / '
  + '份额序列解析 / 份额变动与净申赎金额 / 组合指数与信号引擎）\n',
);
