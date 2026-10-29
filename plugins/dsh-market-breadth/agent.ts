/**
 * 插件 dsh-market-breadth · Agent MCP 工具贡献
 *
 * 两个只读工具（写法对标 dsh-stock-screener 的 agent.ts，zod schema 为
 * JSON Schema 的单一事实源）：
 * - `get_breadth_snapshot`：当日宽度统计（涨跌家数 / ADL / ADR / OBOS / ARMS / 活跃占比）；
 *   数据陈旧（> 60 秒未 ingest）时自动重拉一轮全市场快照（与页面同一频率红线内）；
 * - `get_breadth_history`：近 N 日日 bar 序列（默认 30，上限 120，控制 token）。
 */
import { z } from 'zod';
import {
  BREADTH_MCP_ID,
  BREADTH_MCP_KEY,
  BREADTH_PLUGIN_NAME,
  MCP_HISTORY_DEFAULT_DAYS,
  MCP_HISTORY_LINE_MAX_CHARS,
  MCP_HISTORY_MAX_DAYS,
} from './constants';
import { computeBreadthIndicatorSeries } from './indicators';
import type { BuiltinMcpServer, McpCallToolResult } from '../../host/agent/mcp/types';
import type { BreadthRepo } from './storage';
import type { BreadthRuntime } from './types';

/** 快照自动刷新的陈旧阈值（毫秒） */
const SNAPSHOT_STALE_MS = 60_000;

/** 快照工具入参 schema（JSON Schema 的单一事实源） */
const snapshotSchema = z.object({
  refresh: z
    .boolean()
    .optional()
    .describe('是否允许自动重拉全市场快照（数据陈旧 >60s 时）；默认 true。false 则只读本地库'),
});

/** 历史序列工具入参 schema */
const historySchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(MCP_HISTORY_MAX_DAYS)
    .optional()
    .describe(`返回最近多少个交易日的日 bar；默认 ${MCP_HISTORY_DEFAULT_DAYS}，上限 ${MCP_HISTORY_MAX_DAYS}`),
});

/**
 * 单行截断（控制 token：宁少勿爆）
 * @param line 原始行
 * @returns 截断后的行
 */
const capLine = (line: string): string =>
  line.length > MCP_HISTORY_LINE_MAX_CHARS
    ? line.slice(0, MCP_HISTORY_LINE_MAX_CHARS) + '…'
    : line;

/**
 * 构造插件贡献的 Agent MCP 服务器（get_breadth_snapshot / get_breadth_history）
 * @param repo 本地积累仓储（读库 + 按需 ingest）
 * @param runtime 取数运行时（全市场快照）
 * @returns 内置 MCP 服务器声明
 */
export const createBreadthAgentServer = (
  repo: BreadthRepo,
  runtime: BreadthRuntime,
): BuiltinMcpServer => {
  /** 上次 ingest 时刻（模块闭包内记，供快照工具的陈旧判定） */
  let lastIngestAt = 0;

  return {
    // 插件贡献服务器沿用负数 id 约定（避开内置 -1 ~ -4 与 screener 的 -101）
    id: BREADTH_MCP_ID,
    key: BREADTH_MCP_KEY,
    name: BREADTH_PLUGIN_NAME,
    description: '市场宽度插件贡献：当日宽度统计（ADL/ADR/OBOS/ARMS/活跃占比）与近 N 日日 bar 序列（只读）',
    tools: [
      {
        definition: {
          name: 'get_breadth_snapshot',
          description:
            '获取 A 股当日市场宽度统计：涨/跌/平家数、ADL 腾落线、ADR 涨跌比率、OBOS 超买超卖、ARMS 平滑均线、MCO 麦克莱伦震荡与活跃占比（换手率>5% 家数占比）。数据陈旧时自动重拉一轮全市场快照（东财源）',
          inputSchema: z.toJSONSchema(snapshotSchema) as Record<string, unknown>,
        },
        schema: snapshotSchema,
        execute: async (input: unknown): Promise<McpCallToolResult> => {
          const { refresh = true } = (input ?? {}) as { refresh?: boolean };
          if (refresh && Date.now() - lastIngestAt > SNAPSHOT_STALE_MS) {
            try {
              await repo.ingest(runtime);
              lastIngestAt = Date.now();
            } catch {
              // 快照拉取失败不阻断读库：返回本地已有数据并在结果里注明
            }
          }
          const { bars, minutes } = repo.snapshot();
          const series = computeBreadthIndicatorSeries(bars);
          const last = series.dates.length - 1;
          /**
           * 取序列末位的值
           * @param values 指标序列
           * @returns 末位值；全空为 null
           */
          const at = (values: ReadonlyArray<number | null>): number | null =>
            last < 0 ? null : (values[last] ?? null);
          const todayPoints = minutes.get(
            (() => {
              const now = new Date();
              const month = String(now.getMonth() + 1).padStart(2, '0');
              const day = String(now.getDate()).padStart(2, '0');
              return `${now.getFullYear()}-${month}-${day}`;
            })(),
          );
          const todayLast = todayPoints?.at(-1) ?? null;
          const result = {
            accumDays: bars.length,
            latestBarDate: bars.at(-1)?.date ?? null,
            todaySample: todayLast
              ? {
                  time: new Date(todayLast.time).toLocaleString('zh-CN'),
                  upCount: todayLast.upCount,
                  downCount: todayLast.downCount,
                  flatCount: todayLast.flatCount,
                  arms: todayLast.arms,
                  activeRatioPct:
                    todayLast.activeTotal !== undefined && todayLast.activeTotal > 0
                      ? Number((((todayLast.activeCount ?? 0) / todayLast.activeTotal) * 100).toFixed(1))
                      : null,
                }
              : null,
            indicators:
              last < 0
                ? null
                : {
                    date: series.dates[last],
                    adl: at(series.adl),
                    adr: at(series.adr),
                    obos: at(series.obos),
                    armsMa: at(series.armsMa),
                    mco: at(series.mco),
                    activeRatioPct: at(series.activeRatio),
                  },
            units: '家数为只数；upVol/downVol 单位手；activeRatioPct 为百分数',
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        },
      },
      {
        definition: {
          name: 'get_breadth_history',
          description:
            '获取 A 股市场宽度近 N 日的日 bar 序列（日期 | 涨/跌家数 | ARMS | 活跃占比），按日期倒序（最近在前），用于趋势与背离分析',
          inputSchema: z.toJSONSchema(historySchema) as Record<string, unknown>,
        },
        schema: historySchema,
        execute: async (input: unknown): Promise<McpCallToolResult> => {
          const { days = MCP_HISTORY_DEFAULT_DAYS } = (input ?? {}) as { days?: number };
          const { bars } = repo.snapshot();
          const picked = bars.slice(-days).reverse();
          const lines = picked.map((bar) => {
            const active =
              bar.activeCount !== undefined && bar.activeTotal
                ? `${((bar.activeCount / bar.activeTotal) * 100).toFixed(1)}%`
                : '--';
            return capLine(
              `${bar.date} | 涨${bar.upCount} 跌${bar.downCount} | ARMS ${bar.arms === null ? '--' : bar.arms.toFixed(2)} | 活跃占比 ${active}`,
            );
          });
          const text =
            lines.length === 0
              ? '本地暂无日 bar（历史按日积累，安装后首个交易日收盘起出数）'
              : `共 ${lines.length} 日（日期 | 涨/跌家数 | ARMS | 活跃占比，倒序）：\n${lines.join('\n')}`;
          return { content: [{ type: 'text', text }] };
        },
      },
    ],
  };
};
