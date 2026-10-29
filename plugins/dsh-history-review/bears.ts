/**
 * 插件 dsh-bull-review（历史复盘）· 熊市轮次档案（结论性内容）
 *
 * 2000 年以来七轮大级别熊市的标准化拆解，硬编码于此 —— 历史复盘是不可变结论。
 * 定位：把每轮熊市的「三种杀法」（杀估值 / 杀盈利 / 杀制度筹码）、政策底与市场底的
 * 时滞、底部信号、以及熊市里的结构机会沉淀为可对标模式；**不预测底部时点**。
 *
 * 事件时间线按五类标注（龙头动向 / 国内政策 / 海外环境 / 资金情绪 / 产业业绩）。
 * ⚠️ 本轮科技崩盘熊（2026.7–）的近期事件来自用户复盘口径（豆包对话 2026-09-20），随行情推进补录。
 * ⚠️ 全部文字为复盘观点，仅供参考，不构成投资建议；
 * 跌幅 / 反弹等数字由 `judge.ts` 从月 K 回算，这里只写定性与时间窗。
 */
import type { ReviewRoundMeta } from './types';

/** 全部熊市轮次（数组顺序即时间轴顺序） */
export const BEAR_ROUNDS: readonly ReviewRoundMeta[] = [
  {
    id: 'state-share-bear',
    name: '国有股减持大熊市',
    short: '01–05',
    indexSymbol: 'sh000001',
    indexName: '上证指数',
    roundType: '制度冲击 · 四年长熊',
    collapseType: 'C',
    collapseLabel: 'C 类·制度筹码冲击',
    status: '已见底',
    window: { start: '2001-06', peak: '2005-06', end: '2005-07' },
    span: '2001.06 – 2005.06',
    mainline: '全市场系统性杀估值（庄股 / 券商重仓股跌幅最深）',
    midCaps: '银广夏、中科创业、新疆德隆系（崩塌代表）',
    macro: '国有股减持悬念压制全市场估值 · 券商与庄股信用破产 · 股权分置悬而未决',
    rival: '2003「五朵金花」结构行情（熊市中的逆势抱团）',
    stages: [
      { name: '初跌杀估值', start: '2001-06', end: '2002-01', tone: 's1', desc: '减持办法出台 + 全球科技泡沫破裂，2245 → 1339（-40%）' },
      { name: '反弹中继', start: '2002-01', end: '2004-03', tone: 's2', desc: '「6·24」停止减持反弹至 1748 后阴跌；五朵金花逆势结构行情' },
      { name: '主跌磨底', start: '2004-03', end: '2005-02', tone: 's3', desc: '宏观调控 + 加息 + 德隆崩塌 + 券商全行业危机' },
      { name: '见底反转', start: '2005-02', end: '2005-06', tone: 's4', desc: '股改试点恐慌最后一杀，6.6 见 998.23；对价预期随即开启大牛市' },
    ],
    events: [
      { date: '2001.06', title: '国有股减持暂行办法发布', detail: '市价减持国有股充实社保，市场视为重大利空，2245 见顶', kind: 'landed', category: 'policy' },
      { date: '2001.07', title: '减持随新股正式实施', detail: '7.30 单日 -5.3%，杀跌开始；全球科技泡沫破裂共振', kind: 'landed', category: 'overseas' },
      { date: '2001.08', title: '银广夏财务造假曝光', detail: '业绩神话证伪连续跌停；中科系庄股崩盘，庄股信用集体破产', kind: 'landed', category: 'sector' },
      { date: '2002.01', title: '上证 1339 阶段低点', detail: '初跌段结束，七个月 -40%', kind: 'landed', category: 'funds' },
      { date: '2002.06', title: '国务院停止国有股减持', detail: '「6·24」单日 +9.25% 全场涨停——反弹中继的顶点', kind: 'landed', category: 'policy' },
      { date: '2003 全年', title: '五朵金花逆势行情', detail: '熊市里的结构牛：基金抱团价值股，指数熊 ≠ 个股熊的最早范本', kind: 'landed', category: 'leader' },
      { date: '2004.04', title: '宏观调控 + 德隆系崩塌', detail: '最大民营庄股集团「三驾马车」连续跌停覆灭，委托理财链断裂', kind: 'landed', category: 'funds' },
      { date: '2004.H2', title: '券商全行业危机', detail: '南方证券等相继被接管，挪用客户保证金爆雷，机构多杀多', kind: 'landed', category: 'funds' },
      { date: '2004.10', title: '九年首次加息', detail: '紧缩落地，估值再下台阶', kind: 'landed', category: 'policy' },
      { date: '2005.04', title: '股权分置改革试点', detail: '对价不确定性引发最后一跌，恐慌极致', kind: 'landed', category: 'policy' },
      { date: '2005.06', title: '998.23 历史大底', detail: '破净股超百家、日成交不足 50 亿（峰值一成以下）——经典底部特征，随后股改牛市开启', kind: 'landed', category: 'funds' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: false },
      { dimension: '机构行为', diverged: true },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '制度不确定性 + 信用破产双杀，四年 -55%',
    review:
      '制度冲击型熊市的极致样本：估值杀（减持悬念）与信用杀（庄股 / 券商）叠加四年。' +
      '底部由制度变革（股改）终结而非自然出清——「解铃还须系铃人」，制度熊要等制度拐点。',
  },
  {
    id: 'gfc-bear',
    name: '全球金融危机快熊',
    short: '07–08',
    indexSymbol: 'sh000001',
    indexName: '上证指数',
    roundType: '流动性冲击 · 一年快熊',
    collapseType: 'A',
    collapseLabel: 'A 类·流动性急杀',
    status: '已见底',
    window: { start: '2007-10', peak: '2008-10', end: '2008-11' },
    span: '2007.10 – 2008.10',
    mainline: '全市场无差别下跌（周期与金融跌幅居前）',
    midCaps: '中国平安、中信证券、万科（跌幅代表）',
    macro: '大小非解禁洪峰 · 连续紧缩 · 全球金融危机',
    rival: '无（现金为王；债券牛市启动）',
    stages: [
      { name: '初跌杀估值', start: '2007-10', end: '2008-01', tone: 's1', desc: '6124 → 4778：紧缩 + 解禁，估值高位自然回落' },
      { name: '反弹中继', start: '2008-01', end: '2008-05', tone: 's2', desc: '4.24 印花税下调反弹至 3786，随后再创新低' },
      { name: '主跌磨底', start: '2008-05', end: '2008-09', tone: 's3', desc: '「平安 1600 亿再融资门」+ 通胀高企，阴跌不止' },
      { name: '见底反转', start: '2008-09', end: '2008-10', tone: 's4', desc: '雷曼破产恐慌杀至 1664.93，三大利好 + 四万亿计划终结熊市' },
    ],
    events: [
      { date: '2008.01', title: '平安 1600 亿再融资门', detail: '天量再融资计划压垮市场情绪，1 月单月 -16%', kind: 'landed', category: 'funds' },
      { date: '2008 全年', title: '大小非解禁洪峰', detail: '全年解禁市值超 3 万亿，筹码供给碾压申购端', kind: 'landed', category: 'funds' },
      { date: '2008.04', title: '印花税下调救市', detail: '4.24 单日 +9.3%，但反弹止步 3786——政策底不是市场底', kind: 'landed', category: 'policy' },
      { date: '2008.06', title: '油价破 140 + 通胀 8%+', detail: '盈利预期与流动性双紧，阴跌不止', kind: 'landed', category: 'overseas' },
      { date: '2008.09', title: '雷曼破产', detail: '全球金融危机全面爆发，恐慌杀至 1664.93（-72.8%）', kind: 'landed', category: 'overseas' },
      { date: '2008.09', title: '三大利好齐发', detail: '印花税单边征收 + 汇金增持三大行 + 央企回购，19 日全场涨停——政策底确认', kind: 'landed', category: 'policy' },
      { date: '2008.11', title: '四万亿计划出台', detail: '熊市正式终结，V 型反转启动', kind: 'landed', category: 'policy' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: true },
      { dimension: '机构行为', diverged: true },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '解禁 + 紧缩 + 全球金融危机，一年 -73%',
    review:
      '流动性急杀的极致样本：跌得又快又深，但见底也快——从政策底（9.18 三大利好）到市场底（10.28）只有一个月。' +
      '急熊的教训是「反弹中继会骗人」：424 印花税反弹 20% 后再创新低，左侧抄底必须分批。',
  },
  {
    id: 'five-year-bear',
    name: '五年结构长熊',
    short: '09–13',
    indexSymbol: 'sh000001',
    indexName: '上证指数',
    roundType: '盈利下行 · 五年长熊',
    collapseType: 'B',
    collapseLabel: 'B 类·盈利阴跌磨底',
    status: '已见底',
    window: { start: '2009-07', peak: '2013-06', end: '2013-07' },
    span: '2009.08 – 2013.06',
    mainline: '强周期与主板阴跌（创业板同期走牛，结构撕裂）',
    midCaps: '江西铜业、西山煤电、钢铁煤炭全行业（阴跌代表）',
    macro: '四万亿后遗症 · 产能过剩 · 紧缩周期 · 经济增速下台阶',
    rival: '2013 创业板 +83%（结构牛市与主板熊并存）',
    stages: [
      { name: '初跌杀估值', start: '2009-08', end: '2010-07', tone: 's1', desc: '信贷收缩 + 地产调控，3478 → 2319' },
      { name: '反弹中继', start: '2010-07', end: '2011-04', tone: 's2', desc: '反弹至 3067，白酒医药结构牛掩盖指数熊' },
      { name: '主跌磨底', start: '2011-04', end: '2012-11', tone: 's3', desc: '紧缩 + 增速下台阶，2132「玫瑰底」与 1949「银行股底」相继击穿' },
      { name: '见底反转', start: '2012-11', end: '2013-06', tone: 's4', desc: '钱荒 1849.65 二次探底成功，双底确认后创业板牛接棒' },
    ],
    events: [
      { date: '2009.08', title: '信贷骤降见顶 3478', detail: '四万亿退坡，强周期抱团瓦解', kind: 'landed', category: 'policy' },
      { date: '2010.04', title: '地产「国十条」', detail: '地产链及相关周期全面退潮', kind: 'landed', category: 'policy' },
      { date: '2010.10', title: '危机后首次加息', detail: '通胀破 4，紧缩周期开启（至 2011 年共 5 次加息）', kind: 'landed', category: 'policy' },
      { date: '2011 全年', title: '增速下台阶', detail: 'GDP 增速逐季回落，周期行业盈利见顶回落——杀盈利主导', kind: 'landed', category: 'sector' },
      { date: '2012.01', title: '2132「玫瑰底」击穿', detail: '券商喊出的钻石底被跌破，情绪再杀', kind: 'landed', category: 'funds' },
      { date: '2012 全年', title: 'IPO 空窗 + 创业板牛', detail: '新股停发一年，创业板指 +83%——指数熊与结构牛撕裂的典型', kind: 'landed', category: 'leader' },
      { date: '2013.06', title: '钱荒', detail: '隔夜 SHIBOR 13.44%，6.25 见 1849.65——二次探底成功，熊市终章', kind: 'landed', category: 'policy' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: false },
      { dimension: '机构行为', diverged: false },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '产能过剩 + 盈利下行 + 紧缩，五年 -47%',
    review:
      '杀盈利型长熊的样本：估值并不极端，但盈利五年不涨反跌，指数阴跌不止。' +
      '要点是「指数熊 ≠ 全部熊」：2013 创业板与白酒医药的结构牛市都诞生于这轮熊市——磨底期恰是新主线孕育期。',
  },
  {
    id: 'leverage-purge-bear',
    name: '杠杆清算熊',
    short: '15–16',
    indexSymbol: 'sz399006',
    indexName: '创业板指',
    roundType: '杠杆清算 · 半年快熊',
    collapseType: 'A',
    collapseLabel: 'A 类·流动性急杀',
    status: '已见底',
    window: { start: '2015-06', peak: '2016-02', end: '2016-03' },
    span: '2015.06 – 2016.03',
    mainline: '中小创与高杠杆品种（配资重仓股连续跌停）',
    midCaps: '乐视网、全通教育、暴风科技（崩塌代表）',
    macro: '场外配资 1.5 万亿强平 · 三轮股灾 + 熔断 · 人民币汇改冲击',
    rival: '2016 起白马核心资产悄然走强（下一轮主线的起点）',
    stages: [
      { name: '第一轮股灾', start: '2015-06', end: '2015-08', tone: 's1', desc: '清配去杠杆 → 千股跌停 → 停牌潮，4037 → 1779（-56%）' },
      { name: '反弹中继', start: '2015-08', end: '2015-12', tone: 's2', desc: '救市 + 流动性宽松修复至 2915，杠杆资金卷土重来' },
      { name: '熔断杀', start: '2015-12', end: '2016-01', tone: 's3', desc: '汇改贬值 + 熔断机制放大恐慌，单月再跌两成半' },
      { name: '见底反转', start: '2016-01', end: '2016-03', tone: 's4', desc: '熔断暂停 + 注册制暂缓，2 月底见底后震荡修复' },
    ],
    events: [
      { date: '2015.06', title: '清理场外配资', detail: '杠杆链断裂，6.26 创业板 -9%、7.8 约半数个股停牌——强平多杀多', kind: 'landed', category: 'policy' },
      { date: '2015.07', title: '证金公司救市', detail: '「国家队」入场 + IPO 暂停，第一轮股灾止跌', kind: 'landed', category: 'policy' },
      { date: '2015.08', title: '汇改「8·11」', detail: '人民币中间价改革引发贬值恐慌，8.24 单日 -8.5% 二次股灾', kind: 'landed', category: 'overseas' },
      { date: '2015.12', title: '美联储首次加息', detail: '全球流动性拐点确认，新兴市场普跌', kind: 'landed', category: 'overseas' },
      { date: '2016.01', title: '熔断机制四天四次', detail: '新机制放大恐慌后连夜暂停；1 月创业板单月约 -26%', kind: 'landed', category: 'policy' },
      { date: '2016.02', title: '注册制暂缓 + 汇金增持', detail: '政策组合拳止血，创业板 2 月底见底——本轮快熊 -56%', kind: 'landed', category: 'policy' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: true },
      { dimension: '机构行为', diverged: true },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '去杠杆强平 + 汇改冲击 + 熔断放大，半年 -56%',
    review:
      '与 2008 同为流动性急杀，但叠加了「制度应急失当」（熔断）的放大效应。' +
      '教训：救市政策的退出节奏（恢复 IPO、重启熔断讨论）本身会成为二次探底的触发器。',
  },
  {
    id: 'trade-war-bear',
    name: '贸易战去杠杆熊',
    short: '18',
    indexSymbol: 'sh000001',
    indexName: '上证指数',
    roundType: '外部冲击 · 一年阴跌',
    collapseType: 'B',
    collapseLabel: 'B 类·盈利与筹码双杀',
    status: '已见底',
    window: { start: '2018-01', peak: '2018-12', end: '2019-02' },
    span: '2018.01 – 2019.01',
    mainline: '全市场阴跌（股权质押重灾股连续爆仓）',
    midCaps: '贵州茅台（10.29 罕见跌停）、东方园林（发债失败标志）、中兴通讯',
    macro: '中美贸易摩擦 · 资管新规去杠杆 · 股权质押危机 · 民企纾困',
    rival: '2019 起半导体 / 核心资产开启新一轮主线',
    stages: [
      { name: '初跌杀估值', start: '2018-01', end: '2018-04', tone: 's1', desc: '贸易摩擦 + 资管新规，3587 → 3049' },
      { name: '阴跌主跌', start: '2018-04', end: '2018-09', tone: 's3', desc: '2000 亿清单加码，质押爆仓与下跌负反馈，全年几乎无像样反弹' },
      { name: '恐慌杀', start: '2018-09', end: '2018-10', tone: 's1', desc: '茅台跌停 + 千股质押濒临平仓，10.19 恐慌极致' },
      { name: '政策底到市场底', start: '2018-10', end: '2019-01', tone: 's4', desc: '高层集体喊话 + 民企纾困，政策底领先市场底三个月，1.4 见 2440.91' },
    ],
    events: [
      { date: '2018.02', title: '资管新规征求意见', detail: '去杠杆预期发酵，通道业务 / 结构化产品退场开始', kind: 'expected', category: 'policy' },
      { date: '2018.03', title: '贸易摩擦首轮加税', detail: '「301 调查」清单落地，外部冲击贯穿全年', kind: 'landed', category: 'overseas' },
      { date: '2018.04', title: '中兴禁运事件', detail: '「缺芯」之痛引爆，自主可控叙事反而在此孕育', kind: 'landed', category: 'sector' },
      { date: '2018.06', title: '2000 亿清单 + 千股跌停', detail: '6.19 单日 -3.8%，质押平仓线大面积击穿，下跌自我强化', kind: 'landed', category: 'funds' },
      { date: '2018.10', title: '茅台罕见跌停', detail: '三季报不及预期 10.29 跌停——白马信仰第一次动摇', kind: 'landed', category: 'leader' },
      { date: '2018.10.19', title: '高层集体喊话', detail: '刘鹤及一行两会回应市场关切，「政策底」确立（2449）', kind: 'landed', category: 'policy' },
      { date: '2018.11', title: '民企纾困 + 质押解困', detail: '各地纾困基金成立，质押危机逐步化解', kind: 'landed', category: 'policy' },
      { date: '2019.01', title: '全面降准 + 市场底', detail: '1.4 见 2440.91——政策底领先市场底约两个半月，随后开启两年核心资产牛', kind: 'landed', category: 'policy' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: true },
      { dimension: '机构行为', diverged: false },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '外部摩擦 + 去杠杆 + 质押负反馈，一年 -32%',
    review:
      '「政策底 → 市场底」教科书轮：10.19 喊话（政策底 2449）到 1.4 市场底（2440），滞后约两个半月、点位几乎持平——' +
      '政策底后磨底不创新低或浅创新低，是熊转牛最友好的形态。',
  },
  {
    id: 'core-bear',
    name: '核心资产长熊',
    short: '21–24',
    indexSymbol: 'sh000300',
    indexName: '沪深300',
    roundType: '估值盈利双杀 · 三年长熊',
    collapseType: 'B',
    collapseLabel: 'B 类·抱团瓦解长熊',
    status: '已见底',
    window: { start: '2021-02', peak: '2024-01', end: '2024-02' },
    span: '2021.02 – 2024.02',
    mainline: '白马抱团股与成长赛道轮番下跌（茅指数 -50%+、宁组合 -60%+）',
    midCaps: '贵州茅台、宁德时代、恒瑞医药、中国中免（腰斩代表）',
    macro: '抱团瓦解 · 美联储史诗级加息 · 地产下行 · 复苏预期反复证伪',
    rival: '红利 / 微盘 / 出海链轮动（熊市中的避风港结构行情）',
    stages: [
      { name: '杀估值', start: '2021-02', end: '2022-01', tone: 's1', desc: '美债利率杀估值，茅指数第一波 -30%+' },
      { name: '杀盈利与加息', start: '2022-01', end: '2022-10', tone: 's3', desc: '俄乌 + 加息 + 封控三连击，10 月底二次探底' },
      { name: '反弹中继', start: '2022-10', end: '2023-04', tone: 's2', desc: '防疫优化 + 复苏交易修复两成半，随后预期证伪' },
      { name: '磨底出清', start: '2023-04', end: '2024-02', tone: 's4', desc: '弱复苏证伪 + 雪球敲入 + 量化踩踏，汇金扩大增持后 2.5 见底' },
    ],
    events: [
      { date: '2021.02', title: '美债利率杀估值', detail: '春节后核心资产十余日 -20%，三年长熊开幕', kind: 'landed', category: 'overseas' },
      { date: '2021 全年', title: '中概与行业监管冲击', detail: '教育双减、平台整顿，港股中概崩塌传染 A 股白马情绪', kind: 'landed', category: 'policy' },
      { date: '2022 全年', title: '俄乌 + 加息 + 封控', detail: '外部利率与内部景气双杀，沪深300 两度探底', kind: 'landed', category: 'overseas' },
      { date: '2022.11', title: '防疫优化 + 地产三支箭', detail: '复苏交易驱动修复反弹至 2023 年 4 月', kind: 'landed', category: 'policy' },
      { date: '2023.H2', title: '弱复苏证伪', detail: 'PMI 与物价持续走弱，「强预期弱现实」反复打脸，反弹夭折', kind: 'landed', category: 'sector' },
      { date: '2023.08', title: '印花税下调', detail: '四箭齐发仅换来一日行情——政策底信号出现但市场底未到', kind: 'landed', category: 'policy' },
      { date: '2024.01', title: '雪球敲入 + 量化危机', detail: '微盘踩踏传导至权重，流动性螺旋下探至 3108', kind: 'landed', category: 'funds' },
      { date: '2024.02', title: '汇金扩大 ETF 增持', detail: '「国家队」扩围 + 证监会换帅，2.5 沪深300 3108 见底，三年长熊 -43% 终结', kind: 'landed', category: 'policy' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: true },
      { dimension: '机构行为', diverged: true },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '抱团瓦解 + 利率与景气双杀 + 流动性踩踏，三年 -43%',
    review:
      '三年长熊 = 牛市复盘里两轮抱团（茅 / 宁）瓦解的合订本。特征是「反弹中继特别多」：' +
      '2022 底复苏、2023 中特估与 AI 都只是阶段反抽，直到筹码出清（雪球 / 量化）+ 汇金接筹才真正见底。',
  },
  {
    id: 'ai-bear',
    name: '本轮科技崩盘熊',
    short: '26.7–',
    indexSymbol: 'sz399006',
    indexName: '创业板指',
    roundType: '抱团清算 · 进行中',
    collapseType: 'A',
    collapseLabel: 'A 类·批量跌停急杀',
    status: '进行中',
    window: { start: '2026-06', peak: '2026-09', end: '2026-09' },
    span: '2026.07 – 至今',
    mainline: 'AI 算力 / 半导体抱团股集中回撤',
    midCaps: '中际旭创、寒武纪、海光信息（观察中军止跌信号）',
    macro: '机构拥挤筹码出清 · 产业兑现不及预期（复盘口径，随行情推进补录）',
    rival: '红利 / 大金融阶段性避险分流',
    stages: [
      { name: '崩盘急杀', start: '2026-06', end: '2026-07', tone: 's1', desc: '集体大阴线 + 批量跌停，抱团筹码集中出清' },
      { name: '观察期', start: '2026-07', end: '2026-09', tone: 's2', desc: '反弹乏力与修复交替；观察成交额企稳与中军止跌两大信号' },
    ],
    events: [
      { date: '2026.07', title: '板块集体大阴线', detail: '批量跌停确认退潮，创业板指自 6 月顶点快速回撤', kind: 'landed', category: 'funds' },
      { date: '2026.07', title: '自顶点回撤逾两成', detail: '月 K 口径自 4343 顶点回撤约 -23%（数据回算）', kind: 'landed', category: 'leader' },
      { date: '2026.08', title: '出清观察期', detail: '反弹乏力与修复交替；后续路径（磨底 / 反转）由数据说话，本页随行情推进补录', kind: 'expected', category: 'funds' },
    ],
    mismatch: [
      { dimension: '赚钱效应', diverged: true },
      { dimension: '中军走势', diverged: true },
      { dimension: '媒体舆论', diverged: true },
      { dimension: '机构行为', diverged: true },
      { dimension: '散户情绪', diverged: true },
    ],
    trigger: '产业兑现不及预期 + 拥挤筹码出清（进行中）',
    review:
      '牛市复盘「本轮科技 AI 抱团」瓦解后的进行中轮次：鱼尾期四条件全部触发后的清算段。' +
      '对标历史同类（2015 杠杆清算 / 2021 核心资产），确认底部要看：地量成交、中军止跌企稳、以及是否有下一轮主线的萌芽信号。',
  },
];

/** 熊市页签的可复用规律卡片（复盘框架沉淀） */
export const BEAR_PATTERNS: readonly { title: string; desc: string }[] = [
  {
    title: '三种杀法',
    desc: '杀估值（流动性 / 利率，跌最快：2008、2015）→ 杀盈利（业绩下行，跌最久：2010–2013）→ 杀制度筹码（股改、清配、质押：2001、2018）。一轮大熊往往是先杀估值、再杀盈利、最后杀筹码的接力。',
  },
  {
    title: '政策底 ≠ 市场底',
    desc: '政策底通常领先市场底 1–6 个月（2008.9 三大利好 → 10.28 见底；2018.10 喊话 → 2019.1 见底），且政策底后常有一次「最后一跌」，左侧抄底必须分批。',
  },
  {
    title: '底部四信号',
    desc: '① 日成交缩至峰值 1/5 以下（地量）② 破净股超百家 ③ 宽基股息率逼近或超过十年期国债 ④ 新基金发行冰点。四信号齐备后出现的「利好」才是转折级利好。',
  },
  {
    title: '熊市里的结构牛',
    desc: '指数熊 ≠ 全部熊：2003 五朵金花、2013 创业板 +83%、2019 半导体都诞生于熊市 / 磨底期——每一轮大熊的磨底段，都在孕育下一轮主线。',
  },
  {
    title: '牛短熊长',
    desc: '2000 年以来指数级牛市合计约 8 年，熊市与磨底合计约 12 年；「满仓指数等牛市」在 A 股是低效策略，节奏与结构比仓位更重要。',
  },
];
