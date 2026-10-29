/**
 * 插件 dsh-futures-institutional（期货·机构行为）· CCPM CSV 解析
 *
 * 从宿主 `src/common/utils/parse-ccpm-csv.ts` 原样移植（插件禁 import 宿主 src/）。
 *
 * 文件结构：两行表头，数据行 12 列：
 * `交易日,合约,排名,量会员,量,量增,多会员,多,多增,空会员,空,空增`。
 * 同一（合约+会员）可能只上其中一榜或两榜，按并集归并，缺失指标记 null。
 */
import type { CcpmMemberRow, CcpmProductDayData } from './types';

/**
 * 解析中金所 CCPM 成交持仓排名 CSV 文本（GBK 解码后的字符串）
 * @param text GBK 解码后的 CSV 全文
 * @param fallbackProduct 解析不出合约前缀时的品种兜底（品种代码）
 * @returns 品种单日数据；文本为错误页 / 无数据行时返回 null（由调用方走空态）
 */
export const parseCcpmCsv = (text: string, fallbackProduct: string): CcpmProductDayData | null => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // 找出首个「首列为 8 位数字日期」的数据行；找不到说明是错误页 / 非披露日
  const firstDataRow = lines.find((line) => /^\d{8},/.test(line));
  if (!firstDataRow) {
    return null;
  }

  const rowMap = new Map<string, CcpmMemberRow>();
  const instrumentOrder: string[] = [];
  let tradingDay = firstDataRow.slice(0, 8);

  for (const line of lines) {
    if (!/^\d{8},/.test(line)) {
      continue;
    }
    const cells = line.split(',');
    tradingDay = cells[0] ?? tradingDay;
    const instrumentId = (cells[1] ?? '').trim();
    if (!instrumentId) {
      continue;
    }
    if (!instrumentOrder.includes(instrumentId)) {
      instrumentOrder.push(instrumentId);
    }
    // 三榜并排：量 [3..5]、多 [6..8]、空 [9..11]（会员,值,增减）
    const groups: Array<[number, 'volume' | 'buyPos' | 'sellPos']> = [
      [3, 'volume'],
      [6, 'buyPos'],
      [9, 'sellPos'],
    ];
    for (const [base, board] of groups) {
      const memberName = (cells[base] ?? '').trim();
      if (!memberName) {
        continue;
      }
      const value = toIntOrNull(cells[base + 1]);
      const chg = toIntOrNull(cells[base + 2]);
      mergeBoardCell(rowMap, instrumentId, memberName, board, value, chg);
    }
  }

  if (rowMap.size === 0) {
    return null;
  }

  const totals: CcpmProductDayData['totals'] = {};
  for (const instrumentId of instrumentOrder) {
    totals[instrumentId] = { instrumentId, volume: 0, buy: 0, sell: 0 };
  }
  for (const row of rowMap.values()) {
    const total = totals[row.instrumentId];
    if (!total) {
      continue;
    }
    total.volume += row.volume ?? 0;
    total.buy += row.buyPos ?? 0;
    total.sell += row.sellPos ?? 0;
  }

  return {
    tradingDay,
    product: inferProduct(instrumentOrder[0] ?? '', fallbackProduct),
    instruments: instrumentOrder,
    rows: [...rowMap.values()],
    totals,
  };
};

/**
 * 把单榜单元归并进行映射（同一合约+会员可上多榜，先到者建行、后到者补字段）
 * @param rowMap 行映射（键 = 合约|会员）
 * @param instrumentId 合约代码
 * @param memberName 会员简称
 * @param board 榜类型（决定写入哪个字段对）
 * @param value 持仓 / 成交量值
 * @param chg 对应增减值
 */
const mergeBoardCell = (
  rowMap: Map<string, CcpmMemberRow>,
  instrumentId: string,
  memberName: string,
  board: 'volume' | 'buyPos' | 'sellPos',
  value: number | null,
  chg: number | null,
): void => {
  const key = `${instrumentId}|${memberName}`;
  let row = rowMap.get(key);
  if (!row) {
    row = {
      instrumentId,
      memberName,
      volume: null,
      volumeChg: null,
      buyPos: null,
      buyChg: null,
      sellPos: null,
      sellChg: null,
    };
    rowMap.set(key, row);
  }
  if (board === 'volume') {
    row.volume = value;
    row.volumeChg = chg;
  } else if (board === 'buyPos') {
    row.buyPos = value;
    row.buyChg = chg;
  } else {
    row.sellPos = value;
    row.sellChg = chg;
  }
};

/**
 * 单元格转整数（空串 / 非数字记 null；负号与正号都兼容）
 * @param cell 单元格文本
 * @returns 整数或 null
 */
const toIntOrNull = (cell: string | undefined): number | null => {
  const trimmed = (cell ?? '').trim();
  if (!trimmed || !/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isNaN(value) ? null : value;
};

/**
 * 从合约代码推断品种代码（合约 = 品种 + 到期数字），失败时用兜底值
 * @param instrumentId 合约代码
 * @param fallback 兜底品种代码
 * @returns 品种代码
 */
const inferProduct = (instrumentId: string, fallback: string): string => {
  const match = instrumentId.match(/^([A-Z]+)/);
  return match?.[1] ?? fallback;
};
