/* eslint-disable no-console -- 开发期脚本，console 是唯一的进度输出方式 */
/**
 * dsh-history-review · 开发期数据生成脚本（非运行时代码，build 不打包）
 *
 * 一次性从腾讯周 K 接口拉取三轮复盘用指数的全量周 K，转成紧凑元组 JSON
 * 落到 `data/weekly-kline.json`，由 `weekly-data.ts` 静态导入随插件打包。
 * 运行：`node gen-weekly-kline.mjs`（需可直连 web.ifzq.gtimg.cn）
 *
 * 数据再变动（如「本轮科技 AI 抱团」进行中轮次推进）时重跑本脚本并重新构建插件。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 复盘轮次用到的指数（与 rounds.ts / bears.ts 的 indexSymbol 对齐） */
const SYMBOLS = ['sh000001', 'sz399006', 'sh000300'];

/** 单次请求根数（实测 week 档 datalen=1400 可覆盖 1999-04 至今） */
const DATALEN = 1400;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 拉取单只指数全量周 K（升序）
 * @param symbol 指数符号
 * @returns 周 K 元组 [date, open, high, low, close, volume]
 *   （腾讯原始顺序为 [date, open, close, high, low, volume]，此处重排为惯用 OHLC 顺序）
 */
const fetchWeekly = async (symbol) => {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=${symbol},week,,,${DATALEN},,`;
  const res = await fetch(url, { headers: { Referer: 'https://gu.qq.com/' } });
  if (!res.ok) throw new Error(`${symbol} 请求失败：${res.status}`);
  const json = await res.json();
  const rows = json?.data?.[symbol]?.week;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${symbol} 响应无周 K 数据`);
  }
  return rows.map((row) => {
    const num = (index) => Number(Number(row[index]).toFixed(2));
    return [
      row[0],
      num(1), // open
      num(3), // high（腾讯第 4 位）
      num(4), // low（腾讯第 5 位）
      num(2), // close（腾讯第 3 位）
      Math.round(Number(row[5])), // volume（手）
    ];
  });
};

const out = {};
for (const symbol of SYMBOLS) {
  const rows = await fetchWeekly(symbol);
  out[symbol] = rows;
  console.log(`${symbol}: ${rows.length} 根（${rows[0][0]} → ${rows.at(-1)[0]}）`);
}

const target = join(here, 'data', 'weekly-kline.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out));
console.log(`已写入 ${target}（${(JSON.stringify(out).length / 1024).toFixed(0)} KB）`);
