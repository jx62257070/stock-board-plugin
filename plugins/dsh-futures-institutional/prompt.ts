/**
 * 插件 dsh-futures-institutional（期货·机构行为）· AI 分析提示词组装
 *
 * 从宿主 `src/common/utils/build-ccpm-analysis-prompt.ts` + 
 * `build-rank-analysis-prompt.ts` 移植为自包含实现（插件禁 import 宿主 src/）：
 * 口径与披露日注入 → 数据段拼接 → 超长截断 → 填入模板。
 */
import { CCPM_ANALYSIS_MAX_CHARS, CCPM_ANALYSIS_PROMPT_TEMPLATE } from './constants';
import type { CcpmAnalysisDataset } from './types';

/**
 * 把数据段列表拼成纯文本表格（`标题` + 表头行 + 数据行，竖线分隔）
 * @param datasets 数据段列表
 * @returns 拼接文本；全部段都无行时为空串
 */
const buildDatasetSections = (datasets: readonly CcpmAnalysisDataset[]): string =>
  datasets
    .filter((dataset) => dataset.rows.length > 0)
    .map((dataset) => {
      const header = dataset.columns.map((col) => col.label).join(' | ');
      const lines = dataset.rows.map((row) =>
        dataset.columns.map((col) => String(row[col.key] ?? '--')).join(' | '),
      );
      return `【${dataset.title}】\n${header}\n${lines.join('\n')}`;
    })
    .join('\n\n');

/**
 * 把机构行为页（中金所 CCPM 席位持仓）的当前口径数据组装成「AI 分析」提示词
 * @param scopeLabel 当前口径展示名
 * @param dayText 披露交易日（`yyyy-MM-dd`；数据未就绪传空串，提示词显「未就绪」）
 * @param datasets 席位数据段列表
 * @returns 提示词；无有效数据返回空串
 */
export const buildCcpmAnalysisPrompt = (
  scopeLabel: string,
  dayText: string,
  datasets: readonly CcpmAnalysisDataset[],
): string => {
  const data = buildDatasetSections(datasets);
  if (data === '') {
    return '';
  }
  const capped =
    data.length > CCPM_ANALYSIS_MAX_CHARS
      ? data.slice(0, CCPM_ANALYSIS_MAX_CHARS) + '\n…（已截断）'
      : data;
  return CCPM_ANALYSIS_PROMPT_TEMPLATE.replace('{scope}', scopeLabel)
    .replace('{day}', dayText === '' ? '未就绪' : dayText)
    .replace('{data}', capped);
};
