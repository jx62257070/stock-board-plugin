/**
 * 插件 dsh-bull-review（历史复盘）· 类型
 *
 * 牛市复盘与熊市复盘共用一套中性类型（`Review*`）：轮次档案 / 四阶段 / 事件线 /
 * 错配画像由 `rounds.ts`（牛）与 `bears.ts`（熊）硬编码，是不可变的历史复盘观点；
 * 行情数据（`MonthlyBar`）为指数月 K，运行时经新浪源拉取后落 `ctx.db`。
 * 页面上的涨幅 / 回撤等数字一律由 `judge.ts` 从月 K 回算，文案只做定性结论。
 */

/** 段落形态分类：牛市 = 瓦解形态（A 跌停潮 / B 中军先滞涨 / C 权重阴跌）；熊市 = 触发杀法（A 流动性急杀 / B 盈利阴跌 / C 制度筹码冲击） */
export type ReviewCollapseType = 'A' | 'B' | 'C';

/** 阶段色调槽位（时间轴色带与明细卡同源；牛熊各自映射不同色板） */
export type ReviewStageTone = 's1' | 's2' | 's3' | 's4';

/** 事件口径：`expected` 预期（叙事启动）/ `landed` 落地（已兑现或已发生） */
export type ReviewEventKind = 'expected' | 'landed';

/** 事件类别（复盘框架五维度：龙头 / 政策 / 海外 / 资金情绪 / 产业业绩） */
export type ReviewEventCategory = 'leader' | 'policy' | 'overseas' | 'funds' | 'sector';

/** 一轮行情里的一个阶段 */
export interface ReviewStage {
  /** 阶段名（牛市：启动 / 主升 / 鱼尾 / 退潮；熊市：初跌 / 反弹中继 / 主跌磨底 / 见底） */
  name: string;
  /** 起始月（YYYY-MM，含） */
  start: string;
  /** 结束月（YYYY-MM，含） */
  end: string;
  /** 色调（决定色带与明细卡配色） */
  tone: ReviewStageTone;
  /** 阶段要点（定性描述） */
  desc: string;
}

/** 轮次内的一次关键事件 */
export interface ReviewRoundEvent {
  /** 事件时间（展示文案，如 `2021.02` / `2021.02.18`） */
  date: string;
  /** 事件标题 */
  title: string;
  /** 一句话说明 */
  detail: string;
  /** 口径：预期 / 落地 */
  kind: ReviewEventKind;
  /** 类别（龙头动向 / 国内政策 / 海外环境 / 资金情绪 / 产业业绩） */
  category: ReviewEventCategory;
}

/** 错配画像的一个维度（复用豆包框架：背离 = 鱼尾信号） */
export interface ReviewMismatch {
  /** 维度名（赚钱效应 / 中军走势 / 媒体舆论 / 机构行为 / 散户情绪） */
  dimension: string;
  /** 该维度在鱼尾期是否与其他维度背离 */
  diverged: boolean;
}

/** 一轮行情的完整档案（结论性内容，硬编码；牛熊共用） */
export interface ReviewRoundMeta {
  /** 轮次 id（插件内唯一，Tab 键） */
  id: string;
  /** 轮次名（如「核心资产·白酒抱团」） */
  name: string;
  /** 短名（Tab / 对比表用，如「16–21」） */
  short: string;
  /** 叠加指数符号（新浪形态，如 `sh000300`） */
  indexSymbol: string;
  /** 叠加指数名 */
  indexName: string;
  /** 行情归类（机构抱团 / 政策驱动 / 杠杆清算…） */
  roundType: string;
  /** 段落形态分类（牛 = 瓦解形态；熊 = 触发杀法） */
  collapseType: ReviewCollapseType;
  /** 形态展示文案（如「C 类·权重阴跌」） */
  collapseLabel: string;
  /** 状态（已瓦解 / 进行中） */
  status: string;
  /** 行情窗口：start 起点月 / peak 见顶（熊市为见底转折参考）月 / end 结束月（进行中轮次为当前月） */
  window: { start: string; peak: string; end: string };
  /** 统计区间展示文案（如 `2016.01 – 2022.04`） */
  span: string;
  /** 抱团主线（熊市 = 下跌主线） */
  mainline: string;
  /** 中军 / 二线成分池（固定口径，豆包框架要求） */
  midCaps: string;
  /** 市场大环境 */
  macro: string;
  /** 同期竞争主线（熊市 = 逆势结构行情） */
  rival: string;
  /** 阶段拆解 */
  stages: readonly ReviewStage[];
  /** 事件时间线 */
  events: readonly ReviewRoundEvent[];
  /** 见顶（熊市：见底）前多因子画像 */
  mismatch: readonly ReviewMismatch[];
  /** 触发器 / 底部信号（一句话，模式库对比表用） */
  trigger: string;
  /** 复盘解读（定性段落） */
  review: string;
}

/** 指数月 K 单根 */
export interface MonthlyBar {
  /** 月份（YYYY-MM） */
  month: string;
  /** 开盘 */
  open: number;
  /** 最高 */
  high: number;
  /** 最低 */
  low: number;
  /** 收盘 */
  close: number;
}

/** 由月 K 回算的一轮牛市统计（页面所有数字的来源） */
export interface ReviewRoundStats {
  /** 起点月 */
  startMonth: string;
  /** 起点收盘 */
  startClose: number;
  /** 见顶月（数据回算值） */
  peakMonth: string;
  /** 顶点收盘 */
  peakClose: number;
  /** 区间最大涨幅（%，起点 → 顶点） */
  gainPercent: number;
  /** 退潮最低月 */
  troughMonth: string;
  /** 退潮最低收盘 */
  troughClose: number;
  /** 退潮最大回撤（%，顶点 → 最低，负值） */
  drawdownPercent: number;
  /** 至顶时长（月） */
  monthsToPeak: number;
  /** 窗口末月 */
  endMonth: string;
  /** 窗口末月收盘 */
  endClose: number;
}

/** 由月 K 回算的一轮熊市统计 */
export interface ReviewBearStats {
  /** 起点月（顶部区起点） */
  startMonth: string;
  /** 顶部收盘（窗口起点，即本轮顶点区） */
  peakClose: number;
  /** 见底月（数据回算值） */
  troughMonth: string;
  /** 底部收盘 */
  troughClose: number;
  /** 区间最大跌幅（%，顶 → 底，负值） */
  drawdownPercent: number;
  /** 见底后最大反弹（%，底 → 窗口末最高收盘） */
  bouncePercent: number;
  /** 下跌时长（月，起点 → 见底） */
  monthsToTrough: number;
  /** 窗口总时长（月） */
  monthsTotal: number;
  /** 窗口末月 */
  endMonth: string;
  /** 窗口末月收盘 */
  endClose: number;
}

/** 同步元信息（落 `sync_meta` 表） */
export interface ReviewSyncMeta {
  /** 最近一次完整同步时间（毫秒时间戳） */
  syncedAt: number;
  /** 各指数落库根数（symbol → 根数） */
  bars: Record<string, number>;
}
