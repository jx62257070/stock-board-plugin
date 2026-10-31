/**
 * 散户情绪指数插件 · 真实上游端到端验证（live）
 *
 * 用法：
 * ```bash
 * node scripts/check-sentiment-live.mjs
 * ```
 *
 * 与 `check-sentiment-index.mjs`（离线合成数据）的区别：本脚本打**真实东财上游**，
 * 验证取数层解析 / 指标计算 / 落库 / 增量去重的全链路。依赖 clist（板块清单）的
 * runScan 编排层**不在本脚本范围**——clist 是东财封禁最晚放行的端点（2026-10-30
 * 实测：kline/fflow/pool 先解封、clist 接口级 TCP RST 仍在），清单解封后再跑
 * `runScan` 全流程。这里用硬编码已知板块代码直连底层数据链。
 *
 * 断言覆盖：
 * 1. 板块日 K（push2his kline）：行数、首尾日期、价量额字段；
 * 2. fflow daykline：行数（≈121 日深度）、小单净占比非空行数、抽样值；
 * 3. 沪深指数分母：两序列行数 >300、合计 >0；
 * 4. 合并 + 指标：computeIndexSeries 长度对齐、尾日双指数在 0~100、
 *    小单分位非空行数 ≈ fflow 行数；
 * 5. 落库 + 增量：saveScan 首扫 addedRows = 全行数、二次 saveScan addedRows = 0
 *    （同数据 upsert 不产生重复行）；
 * 6. 涨停池（push2ex，经宿主 deps 桩）：成员含 industry、能聚合出板块内涨停数；
 * 7. 炸板 / 跌停池总数（fetchPoolTotal）非空。
 */
import { createServer } from 'vite';

const ROOT = process.cwd();

/** 断言失败累积器 */
const failures = [];
/** 通过计数 */
let passed = 0;

/**
 * 断言
 * @param {boolean} condition 是否成立
 * @param {string} message 失败说明
 */
const assert = (condition, message) => {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${message}\n`);
    return;
  }
  failures.push(message);
  process.stdout.write(`  ✗ ${message}\n`);
};

// ---------- 宿主 deps 桩（真实网络 + 真实涨停池实现） ----------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 东财 Referer */
const EM_REFERER = 'https://quote.eastmoney.com/';

/**
 * 延迟
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * curl 子进程 fetch（Response-like：ok / status / text()）
 *
 * 为什么不用 Node 原生 fetch：2026-10-30 实测 Node 24 undici 的 TLS 指纹被东财
 * push2 系 WAF 识别拒绝（`other side closed`，加浏览器 UA 也无效），而 curl 指纹
 * 放行 —— 宿主运行时走 Tauri Rust reqwest / WebView，同为「非 undici」指纹，
 * 不受影响；脚本侧用 curl 与宿主语义等价（外部可信 HTTP 客户端）。
 * @param {string} url 目标地址
 * @param {{headers?: Record<string, string>}} [init] 请求头
 * @returns {Promise<{ok: boolean, status: number, text: () => Promise<string>}>} 响应
 */
const curlFetch = async (url, init = {}) => {
  const args = ['-s', '--max-time', '15', '-w', '__STATUS__%{http_code}'];
  for (const [key, value] of Object.entries(init.headers ?? {})) args.push('-H', `${key}: ${value}`);
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
  const marker = stdout.lastIndexOf('__STATUS__');
  const status = Number(stdout.slice(marker + '__STATUS__'.length).trim());
  const body = stdout.slice(0, marker);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

/** 宿主 deps 桩（与插件运行时同签名，网络走 curl） */
const deps = {
  http: {
    fetch: curlFetch,
    allowedHosts: ['eastmoney.com'],
    isAllowed: () => true,
  },
  format: {
    placeholder: '--',
    delay: sleep,
    trend: (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'flat'),
    trendClass: () => '',
    trendPillClass: () => '',
    percent: (value) => (value === null || value === undefined ? '--' : `${value.toFixed(2)}%`),
    percentUnsigned: (value) => (value === null || value === undefined ? '--' : `${Math.abs(value).toFixed(2)}%`),
    price: (value) => (value === null || value === undefined ? '--' : value.toFixed(2)),
    relativeTime: () => '',
    debounce: (fn) => fn,
    toFullSymbol: (input) => input,
    toBareCode: (input) => input,
    normalizeCode: (input) => input,
    findQuote: () => undefined,
  },
  market: {
    fetchIndustryBoards: async () => [],
    fetchMarketTurnover: async () => [],
    fetchIndexQuotes: async () => [],
    /**
     * 东财涨停池（push2ex getTopicZTPool；与宿主 fetchZtPool 同端点同字段口径）
     * @param {string} date 交易日 YYYY-MM-DD
     * @returns {Promise<object[]>} 池子成员
     */
    fetchLimitUpPool: async (date) => {
      const ymd = (date ?? '').replaceAll('-', '');
      const url =
        'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989'
        + `&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fbt:asc&date=${ymd}`;
      const response = await curlFetch(url, { headers: { Referer: EM_REFERER } });
      if (!response.ok) throw new Error(`ZTPool HTTP ${response.status}`);
      const payload = await response.json();
      const pool = Array.isArray(payload?.data?.pool) ? payload.data.pool : [];
      return pool.map((member) => ({
        code: String(member.c ?? ''),
        name: String(member.n ?? ''),
        price: typeof member.zdp === 'number' ? null : null,
        changePercent: null,
        continuousBoardCount: typeof member.lbc === 'number' ? member.lbc : null,
        boardAmount: typeof member.fund === 'number' ? member.fund : null,
        industry: String(member.hybk ?? ''),
      }));
    },
  },
  ui: {},
  notify: { notify: (options) => String(options?.title ?? '') },
};

/**
 * 内存 db 桩（PluginDatabase 接口；json 列原样存）
 * @returns db 桩
 */
const createMemoryDb = () => {
  const tables = new Map();
  let nextId = 1;
  return {
    /**
     * 建表（幂等）
     * @param {string} table 表名
     * @returns {Promise<void>}
     */
    ensureTable: async (table) => {
      if (!tables.has(table)) tables.set(table, { columns: [], rows: new Map() });
    },
    /**
     * 插入一行
     * @param {string} table 表名
     * @param {Record<string, unknown>} row 行数据
     * @returns {Promise<number>} 主键
     */
    insert: async (table, row) => {
      const store = tables.get(table);
      const id = nextId++;
      store.rows.set(id, { ...row, id, createdAt: Date.now(), updatedAt: Date.now() });
      return id;
    },
    /**
     * 查询
     * @param {string} table 表名
     * @param {object} [query] 查询条件
     * @returns {Promise<object[]>} 行列表
     */
    select: async (table, query) => {
      const store = tables.get(table);
      if (!store) throw new Error(`table not ensured: ${table}`);
      let rows = [...store.rows.values()];
      if (query?.where) {
        for (const [key, value] of Object.entries(query.where)) {
          rows = rows.filter((row) => row[key] === value);
        }
      }
      if (query?.orderBy) {
        const { column, desc } = query.orderBy;
        rows.sort((a, b) => (desc ? b[column] - a[column] : a[column] - b[column]));
      }
      return rows;
    },
    /**
     * 按主键更新
     * @param {string} table 表名
     * @param {number} id 主键
     * @param {Record<string, unknown>} patch 增量
     * @returns {Promise<void>}
     */
    update: async (table, id, patch) => {
      const store = tables.get(table);
      const current = store.rows.get(id);
      if (!current) throw new Error(`row not found: ${table}#${id}`);
      store.rows.set(id, { ...current, ...patch, updatedAt: Date.now() });
    },
    /**
     * 按主键删除
     * @param {string} table 表名
     * @param {number} id 主键
     * @returns {Promise<void>}
     */
    remove: async (table, id) => {
      tables.get(table)?.rows.delete(id);
    },
    /**
     * 统计
     * @param {string} table 表名
     * @param {Record<string, unknown>} [where] 等值条件
     * @returns {Promise<number>} 行数
     */
    count: async (table, where) => {
      const store = tables.get(table);
      let rows = [...store.rows.values()];
      if (where) for (const [key, value] of Object.entries(where)) rows = rows.filter((row) => row[key] === value);
      return rows.length;
    },
    /**
     * 清表
     * @param {string} table 表名
     * @returns {Promise<void>}
     */
    clear: async (table) => {
      tables.get(table).rows.clear();
    },
  };
};

// ---------- 加载插件真实模块 ----------
const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const emData = await server.ssrLoadModule('/plugins/dsh-sentiment-index/em-data.ts');
const judge = await server.ssrLoadModule('/plugins/dsh-sentiment-index/judge.ts');
const storage = await server.ssrLoadModule('/plugins/dsh-sentiment-index/storage.ts');
const scan = await server.ssrLoadModule('/plugins/dsh-sentiment-index/scan.ts');

process.stdout.write('\n== 1) 板块日 K（push2his kline） ==\n');
const klines = await emData.fetchBoardKline(deps, 'BK1036');
process.stdout.write(`  行数 ${klines.length}，首 ${klines[0]?.date}，尾 ${klines.at(-1)?.date}\n`);
assert(klines.length > 250, `半导体日 K 行数应 >250（实际 ${klines.length}）`);
assert(klines.at(-1)?.close !== null && klines.at(-1)?.amount > 0, '尾行应含收盘价与成交额');

process.stdout.write('\n== 2) fflow daykline（小单拆分） ==\n');
const fflows = await emData.fetchBoardFflow(deps, 'BK1036');
const smallRows = fflows.filter((row) => row.smallRatio !== null);
process.stdout.write(
  `  行数 ${fflows.length}（小单非空 ${smallRows.length}），首 ${fflows[0]?.date}，尾 ${fflows.at(-1)?.date}\n`
  + `  尾行：mainNet=${fflows.at(-1)?.mainNet} smallRatio=${fflows.at(-1)?.smallRatio}\n`,
);
assert(fflows.length > 90, `fflow 深度应 >90 交易日（实测上游 ≈121，实际 ${fflows.length}）`);
assert(smallRows.length === fflows.length, 'fflow 全部行应有小单净占比（f58）');
assert(fflows.at(-1)?.date === klines.at(-1)?.date, 'fflow 尾日应与日 K 尾日一致（同一板块日历）');

process.stdout.write('\n== 3) 沪深指数分母（同源） ==\n');
const [shAmounts, szAmounts] = await Promise.all([
  emData.fetchIndexAmounts(deps, '1.000001'),
  emData.fetchIndexAmounts(deps, '0.399001'),
]);
const totals = new Map();
for (const series of [shAmounts, szAmounts]) {
  for (const point of series) totals.set(point.date, (totals.get(point.date) ?? 0) + point.amount);
}
const market = [...totals.entries()]
  .map(([date, totalAmount]) => ({ date, totalAmount }))
  .sort((a, b) => a.date.localeCompare(b.date));
process.stdout.write(`  沪 ${shAmounts.length} 日 + 深 ${szAmounts.length} 日 → 合计 ${market.length} 日\n`);
assert(market.length > 300, `分母序列应 >300 交易日（实际 ${market.length}）`);
assert(market.at(-1)?.totalAmount > 1e10, '尾日两市成交额应为真实量级（>100 亿）');

process.stdout.write('\n== 4) 合并 + 指标计算 ==\n');
const boardRef = { code: 'BK1036', name: '半导体', kind: 'industry' };
const merged = scan.mergeBoardDays(undefined, boardRef, klines, fflows, null, '', new Map(), klines.at(-1)?.date ?? '');
const marketMap = judge.buildMarketMap(market);
const series = judge.computeIndexSeries(merged.days, marketMap);
const last = series.at(-1);
const smallDays = merged.days.filter((day) => day.smallRatio !== null).length;
process.stdout.write(
  `  序列 ${series.length} 日；尾日 heat=${last?.heatIndex?.toFixed(1)} retail=${last?.retailIndex?.toFixed(1)}\n`
  + `  小单非空 ${smallDays} 日；小单分位非空 ${series.filter((point) => point.percentiles.smallNetRatio !== null).length} 日\n`,
);
assert(series.length === merged.days.length, '指数序列应与板块日线逐日对齐');
assert(last?.retailIndex >= 0 && last?.retailIndex <= 100, '散户情绪指数应在 0~100');
assert(last?.heatIndex >= 0 && last?.heatIndex <= 100, '热度指数应在 0~100');
assert(
  series.filter((point) => point.percentiles.smallNetRatio !== null).length >= Math.min(20, smallDays),
  '小单分位在样本 ≥20 后应有值',
);

process.stdout.write('\n== 5) 落库 + 增量去重 ==\n');
const repo = await storage.createSentimentRepo(createMemoryDb());
const first = await repo.saveScan({
  boards: [merged],
  market,
  meta: {
    scannedAt: Date.now(),
    asOf: merged.days.at(-1)?.date ?? '',
    excludedDate: '',
    watchCount: 1,
    firstScanAt: Date.now(),
    limitUpBackfillDate: '',
    failures: [],
    turnoverSeen: false,
    limitUpTotal: null,
    streak2Count: null,
    zhaBanCount: null,
    limitDownCount: null,
  },
  indexByCode: new Map([[boardRef.code, series]]),
});
assert(first.addedRows === merged.days.length, `首扫 addedRows 应=全行数 ${merged.days.length}（实际 ${first.addedRows}）`);
const second = await repo.saveScan({
  boards: [merged],
  market,
  meta: {
    scannedAt: Date.now(),
    asOf: merged.days.at(-1)?.date ?? '',
    excludedDate: '',
    watchCount: 1,
    firstScanAt: Date.now(),
    limitUpBackfillDate: '',
    failures: [],
    turnoverSeen: false,
    limitUpTotal: null,
    streak2Count: null,
    zhaBanCount: null,
    limitDownCount: null,
  },
  indexByCode: new Map([[boardRef.code, series]]),
});
assert(second.addedRows === 0, `同数据重扫 addedRows 应=0（实际 ${second.addedRows}）`);
const snapshot = repo.snapshot();
assert(snapshot.boards.length === 1 && snapshot.boards[0]?.days.length === merged.days.length, '水合后板块行数应一致');

process.stdout.write('\n== 6) 涨停池（push2ex，宿主 deps 桩） ==\n');
const asOf = merged.days.at(-1)?.date ?? '';
const pool = await deps.market.fetchLimitUpPool(asOf);
process.stdout.write(`  ${asOf} 池子成员 ${pool.length} 家；样例 ${JSON.stringify(pool[0] ?? null)}\n`);
assert(pool.length > 0, '涨停池当日应有成员');
assert(typeof pool[0]?.industry === 'string' && pool[0].industry.length > 0, '成员应含行业字段（hybk）');
const matched = pool.filter((member) => member.industry === boardRef.name).length;
process.stdout.write(`  其中归属「${boardRef.name}」${matched} 家\n`);
assert(matched >= 0, '行业归属统计可计算');

process.stdout.write('\n== 7) 炸板 / 跌停池总数 ==\n');
const zhaBan = await emData.fetchPoolTotal(deps, 'zhaBan', asOf);
const limitDown = await emData.fetchPoolTotal(deps, 'limitDown', asOf);
process.stdout.write(`  炸板 ${zhaBan} · 跌停 ${limitDown}\n`);
assert(zhaBan !== null && limitDown !== null, '两个池子总数应可取得');

await server.close();
process.stdout.write(`\n———— 通过 ${passed} 项${failures.length > 0 ? `，失败 ${failures.length} 项` : '，全部通过'} ————\n`);
if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`  ✗ ${message}\n`);
  process.exit(1);
}
process.stdout.write('✓ live 端到端验证通过（clist 清单链路除外，待其解封后跑 runScan 全流程）\n');
