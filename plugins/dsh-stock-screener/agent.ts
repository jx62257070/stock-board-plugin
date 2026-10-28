/**
 * 插件 dsh-stock-screener · Agent MCP 工具贡献
 *
 * 宿主内置版曾把「MA 金叉回测」收在 stock-sdk 服务器里（run_backtest），
 * 选股器插件化后该工具随插件迁移：装了插件才有，卸载即失效
 * （宿主 `内置 MCP 同步规范`：接口删除 → 同步删除对应工具）。
 */
import { z } from 'zod';
import type { BuiltinMcpServer, McpCallToolResult } from '../../host/agent/mcp/types';
import { runMaCrossBacktest } from './backtest';
import { SCREENER_MCP_ID, SCREENER_MCP_KEY } from './constants';
import type { ScreenerDeps, ScreenerRuntime } from './types';

/** 回测工具入参 schema（JSON Schema 的单一事实源） */
const backtestSchema = z.object({
  symbol: z.string().describe('股票代码（600519 / sh600519 等形态）'),
});

/**
 * 构造插件贡献的 Agent MCP 服务器（单工具：run_backtest）
 * @param runtime 插件取数运行时
 * @param deps 宿主能力（符号归一化用）
 * @returns 内置 MCP 服务器声明
 */
export const createScreenerAgentServer = (
  runtime: ScreenerRuntime,
  deps: ScreenerDeps,
): BuiltinMcpServer => ({
  // 插件贡献服务器沿用负数 id 约定（避开内置 -1 ~ -4），供 resource_grant 授权使用
  id: SCREENER_MCP_ID,
  key: SCREENER_MCP_KEY,
  name: '选股器',
  description: '选股器插件贡献：MA5/MA20 金叉死叉策略回测（近一年日 K，含手续费）',
  tools: [
    {
      definition: {
        name: 'run_backtest',
        description:
          '对单只 A 股运行 MA5/MA20 金叉死叉策略回测（近一年日 K，含手续费），返回收益、最大回撤、交易明细与买入持有基准',
        inputSchema: z.toJSONSchema(backtestSchema) as Record<string, unknown>,
      },
      schema: backtestSchema,
      execute: async (input: unknown): Promise<McpCallToolResult> => {
        const { symbol } = input as { symbol: string };
        const full = deps.format.toFullSymbol(String(symbol ?? '').trim());
        const result = await runMaCrossBacktest(runtime, full);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      },
    },
  ],
});
