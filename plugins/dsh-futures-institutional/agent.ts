/**
 * 插件 dsh-futures-institutional（期货·机构行为）· Agent MCP 工具贡献
 *
 * 两只只读工具（数据源 = ctx.db 本地缓存，不触网、零上游压力）：
 * - `get_ccpm_summary`：指定品种（可选指定交易日，缺省取最近披露日）的席位持仓
 *   与多空行为标注摘要；
 * - `get_ccpm_history`：指定席位的合并净持仓时序（回看近 N 个披露日）。
 *
 * zod schema 为入参单一事实源（inputSchema 由 z.toJSONSchema 推导），
 * 写法参照 dsh-stock-screener 的 agent.ts；结果控 token（席位榜只回 TOP N）。
 */
import { z } from 'zod';
import type { BuiltinMcpServer, McpCallToolResult } from '../../host/agent/mcp/types';
import { aggregateCcpmByMember } from './compute';
import { CCPM_SERIES_DAYS, FUTURES_MCP_ID, FUTURES_MCP_KEY } from './constants';
import type { FuturesRuntime } from './types';

/** 摘要默认返回的席位条数（控 token；按 |净持仓| 降序取前 N） */
const SUMMARY_TOP_MEMBERS = 10;

/** 摘要允许的最大席位条数 */
const SUMMARY_TOP_MAX = 20;

/** 时序工具允许的最大回看披露日数 */
const HISTORY_DAYS_MAX = 45;

/** get_ccpm_summary 入参 schema（JSON Schema 的单一事实源） */
const summarySchema = z.object({
  product: z
    .enum(['IF', 'IH', 'IC', 'IM', 'T', 'TF', 'TS', 'TL'])
    .describe('中金所品种代码（IF/IH/IC/IM 股指，T/TF/TS/TL 国债）'),
  day: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .describe('交易日 yyyyMMdd；缺省取本地缓存里该品种最近一个披露日'),
  top: z
    .number()
    .int()
    .min(1)
    .max(SUMMARY_TOP_MAX)
    .optional()
    .describe(`返回的席位条数上限（按净持仓绝对值降序，默认 ${SUMMARY_TOP_MEMBERS}）`),
});

/** get_ccpm_history 入参 schema */
const historySchema = z.object({
  member: z.string().min(1).describe('席位（会员）名称，如 中信期货(代客)'),
  product: z
    .enum(['IF', 'IH', 'IC', 'IM', 'T', 'TF', 'TS', 'TL'])
    .optional()
    .describe('品种代码（默认 IF）'),
  days: z
    .number()
    .int()
    .min(2)
    .max(HISTORY_DAYS_MAX)
    .optional()
    .describe(`回看的披露日数量（默认 ${CCPM_SERIES_DAYS}，上限 ${HISTORY_DAYS_MAX}）`),
});

/**
 * 把工具执行结果包成 MCP 文本响应
 * @param payload 序列化进 content 的数据（先在调用点控好体积）
 * @returns MCP CallToolResult
 */
const toResult = (payload: unknown): McpCallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
});

/**
 * 构造插件贡献的 Agent MCP 服务器（两只只读工具）
 * @param runtime 插件取数运行时（repo 读本地缓存）
 * @returns 内置 MCP 服务器声明
 */
export const createFuturesAgentServer = (runtime: FuturesRuntime): BuiltinMcpServer => ({
  // 插件贡献服务器沿用负数 id 约定（避开内置 -1 ~ -4 与 screener 的 -101）
  id: FUTURES_MCP_ID,
  key: FUTURES_MCP_KEY,
  name: '期货机构行为',
  description: '期货机构行为插件贡献：中金所 CCPM 席位持仓摘要与席位净持仓时序（读本地缓存）',
  tools: [
    {
      definition: {
        name: 'get_ccpm_summary',
        description:
          '查询中金所 CCPM 成交持仓排名摘要：指定品种（可选交易日）的上榜合约合计与席位多空持仓、增减与行为标注（对冲/单边多/单边空）。数据为期货公司代客口径、仅达标/前20会员',
        inputSchema: z.toJSONSchema(summarySchema) as Record<string, unknown>,
      },
      schema: summarySchema,
      execute: async (input: unknown): Promise<McpCallToolResult> => {
        const { product, day, top } = input as { product: string; day?: string; top?: number };
        const limit = top ?? SUMMARY_TOP_MEMBERS;
        const record = day
          ? await runtime.repo.readDay(product, day)
          : (await runtime.repo.readRecentDays(product, 5)).find((item) => item.data !== null) ?? null;
        if (!record || record.data === null) {
          return toResult({
            error: `本地暂无 ${product}${day ? ` ${day}` : ''} 的 CCPM 缓存，请用户先在「机构行为」页同步数据`,
          });
        }
        const data = record.data;
        const members = aggregateCcpmByMember([data])
          .slice(0, limit)
          .map((row) => ({
            member: row.memberName,
            buy: row.totalBuy,
            sell: row.totalSell,
            net: row.totalNet,
            buyChg: row.totalBuyChg,
            sellChg: row.totalSellChg,
            tag: row.tag,
            partial: row.isPartial,
          }));
        return toResult({
          tradingDay: data.tradingDay,
          product,
          instruments: data.instruments,
          totalsByInstrument: data.totals,
          topMembers: members,
          note: '持仓单位手；代客口径（会员全部客户合并）；仅达标/前20会员；tag 为算法标注仅供分析',
        });
      },
    },
    {
      definition: {
        name: 'get_ccpm_history',
        description:
          '查询指定席位在某品种的合并净持仓时序（近 N 个披露日，逐日多/空/净持仓与净增减），用于观察席位加减仓趋势',
        inputSchema: z.toJSONSchema(historySchema) as Record<string, unknown>,
      },
      schema: historySchema,
      execute: async (input: unknown): Promise<McpCallToolResult> => {
        const { member, product = 'IF', days = CCPM_SERIES_DAYS } = input as {
          member: string;
          product?: string;
          days?: number;
        };
        const records = (await runtime.repo.readRecentDays(product, HISTORY_DAYS_MAX + 5))
          .filter((item) => item.data !== null)
          .slice(0, days)
          .sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
        if (records.length === 0) {
          return toResult({
            error: `本地暂无 ${product} 的 CCPM 缓存，请用户先在「机构行为」页同步数据`,
          });
        }
        const points = records.flatMap((record) => {
          const data = record.data;
          if (!data) {
            return [];
          }
          const aggregated = aggregateCcpmByMember([data], member);
          const row = aggregated[0];
          return row
            ? [
                {
                  day: record.tradingDay,
                  buy: row.totalBuy,
                  sell: row.totalSell,
                  net: row.totalNet,
                  netChg: row.totalNetChg,
                  partial: row.isPartial,
                },
              ]
            : [];
        });
        return toResult({
          member,
          product,
          days: points.length,
          cachedFrom: records[0]?.tradingDay ?? '',
          cachedTo: records[records.length - 1]?.tradingDay ?? '',
          points,
          note: '持仓单位手；partial=true 表示当日该席位仅部分合约上榜，净头寸不完整',
        });
      },
    },
  ],
});
