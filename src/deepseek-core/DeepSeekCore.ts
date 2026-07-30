import * as path from "path";

export const DEEPSEEK_MODEL = "deepseek-v4-pro";
export const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";

export interface DeepSeekHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface DeepSeekRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type DeepSeekFetcher = (url: string, init: DeepSeekRequestInit) => Promise<DeepSeekHttpResponse>;

export interface DeepSeekCandidateRequest {
  apiKey?: string;
  context: unknown;
  feedback: unknown;
  fetcher?: DeepSeekFetcher;
}

const FIXED_PROMPT = `你是 MAAfight 的作战规划模型。只根据提供的 context 和 feedback 返回一个 JSON 对象，不要 Markdown、解释或代码围栏。
唯一目标：使用玩家当前拥有且技能已解锁的干员，为指定关卡生成结构合法、稳定通关的 MAA 候选。
格式：{"battleDsl":"operator(芬, 1, 1)\\ndeploy(芬, 3, 2, Right)\\nskill(芬, kills=10, timeElapsed=30)"}。battleDsl 每行只能是 operator(name, skill, skillUsage)、deploy(name, x, y, direction[, delay=毫秒])、skill(name[, delay=毫秒][, kills=整数][, costs=整数][, costChanges=整数][, cooling=整数][, timeElapsed=整数])、retreat(name[, delay=毫秒][, 条件...]) 或 skillDaemon()。不要输出 SpeedUp、End、ResetStopwatch、JSON actions 或任何解释。
强制约束：context.allowedOperatorNames 是唯一可选干员名单。operator 和动作中的 name 都必须逐字复制该名单；忽略你的游戏记忆、默认低星编队或名单外干员。每个 operator 的 skill 必须是该干员 roster.skills 中列出的 index；未列出的锁定技能不可选。选人前先比较 roster 的 elite、level、role 和 subProfession：在职责相同的候选中优先更高 elite、再更高 level；不得把低练度干员当作高练度干员的等价替代。用 role/subProfession 区分前线阻挡、治疗、远程输出和快活/支援，不能把所有 MELEE 都视为稳定主坦，也不能把所有 RANGED 都视为同等火力。必须有且只能有 12 条不同的 operator，不是 8 人小队：即使某干员不部署，也必须保留其 operator 行。编队人数不等于同时上场人数：从 0 开始，每条 deploy 加 1、每条 retreat 减 1，任意时刻不得超过 context.stage.characterLimit。x 是列、y 是行；对每条 deploy，必须从 context.stage.deploymentPoints 逐字复制一个 x、y、type 三元组，绝不凭地图印象推断格型或自创坐标；MELEE 只能复制 type 为 melee 或 all 的点，RANGED 只能复制 type 为 ranged 或 all 的点，同一三元组全程只能使用一次。规划以每条 context.stage.routes.path 的最后坐标（蓝门）为目标：先在蓝门前最近的共同 onRoute / isChoke 近战格部署适合作为前线的干员，再部署能覆盖这条终段路线的治疗和输出；前线未建立前不得把连续部署浪费在同一片远程格。不要为了中途分路而分散部署。只有存在不同蓝门时，才分别建立防线。普通压力下优先返回只含 deploy 的稳定脚本；但 stage.summary 出现 extreme 或 boss 时，在前线和后排已完整建立后，为已部署、MANUAL 技能的干员添加必要 skill，避免极端压力下因不放技能而崩盘。每个 skill 的干员必须仍在 active 集合中，retreat 后不可再次 skill 或 retreat。skill 和 retreat 的 kills、costs、costChanges、cooling、timeElapsed 都可省略；只有写出的条件按 AND 同时满足才会执行，绝不输出 null。timeElapsed 必须为正整数；retreat 必须有正 delay 或至少一个条件。只允许 roster.skills[].skillType 为 MANUAL 的已部署干员生成 skill；AUTO 和 PASSIVE 技能正常部署后由游戏自动处理。整个脚本只能选择一种技能控制：含任意 skill 时绝不输出 skillDaemon，否则才可输出 skillDaemon()。提交前必须逐行自检：数 operator( 的数量恰为 12；operator 的 skill 在该 roster 条目中；每个 deploy 三元组存在于 deploymentPoints 且匹配 position；每个 skill 的已选技能类型是 MANUAL 且干员 active；维护 active 计数且不超过限制；所有相同蓝门的路线均被同一防线拦截；每个远程 deploy 都在支援已建立的前线；最后确认没有 skillDaemon 与 skill 混用。不得输出 skip_if_not_ready。反馈含 errors 时必须修正并完整返回 battleDsl。`;

const KNOWLEDGE_PROMPT = "operatorKnowledgeModel 标识本次知识数据；只使用 roster 中实际给出的知识。preferred 仅在职责相同的候选中优先，avoided 仅在没有满足职责的替代时使用，sustainedHealing 用于长期支援已建立的前线。frontline、healing、control、area、anti-air、burst 及 skills[].knowledge.tags 是选人信号；spatial.range 是该技能的实际相对射程，attackPattern、coverage、positionEffect、skillRangeBehavior 决定站位与覆盖判断。vector 的含义以 operatorKnowledgeModel.vectorAxes 为准，只能用于相似性和候选排序；不得由标签或向量杜撰能力、射程或通关保证。";

function defaultFetcher(url: string, init: DeepSeekRequestInit): Promise<DeepSeekHttpResponse> {
  return fetch(url, init).then(response => ({
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  }));
}

function loadEnvFile(): void {
  const processWithEnvFile = process as NodeJS.Process & { loadEnvFile?: (file?: string) => void };
  processWithEnvFile.loadEnvFile?.(path.resolve(".env"));
}

export function resolveDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.DEEPSEEK_API_KEY && env === process.env) loadEnvFile();
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  return apiKey;
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // The HTTP status is enough when the service returns a non-JSON error.
  }
  return body.trim().slice(0, 300) || "unknown error";
}

function parseCandidate(body: string): unknown {
  const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek response did not contain choices[0].message.content");
  return JSON.parse(content);
}

export async function requestDeepSeekCandidate(input: DeepSeekCandidateRequest): Promise<unknown> {
  const apiKey = input.apiKey?.trim() || resolveDeepSeekApiKey();
  const response = await (input.fetcher || defaultFetcher)(DEEPSEEK_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: `${FIXED_PROMPT}\n${KNOWLEDGE_PROMPT}\n最终硬门：context.allowedOperatorNames 只含 E2 干员；在其中优先选取高 rarity、高 level 且职责匹配的高强度干员，伤害选择以 roster.skills.annihilationPower 高者优先。不要因技能编号较小而默认选 S1：每位已选干员都必须先按本局职责比较其 roster.skills.annihilationPower，再选择技能。context.stage.blueGateFronts 的每个 blockingPoints 非空条目都必须有一名 MELEE 前线，且 deploy direction 必须逐字使用该点的 direction；先部署并长期保留这些入口前线，优先高 rarity、高 level 的重装或可靠站场近卫，再部署其他单位。若存在能让同一批医疗和火力同时支援两门的中部 MELEE chokepoint，可额外放置一名高生存重装作为共享前线，但它绝不替代两处蓝门入口前线。前线建立后，RANGED 只从该前线的 safeSupportPoints 中选择：优先 routeDistance 大（更远离敌方路径）的格，并使方向指向前线以攻击被阻挡敌人。存在 boss 时，每个前线还必须各有一名 role=medic 的 RANGED 部署在自己的 safeSupportPoints，不能让任一蓝门前线没有治疗支援；无 retreat 时，所有 deploy 最多等于 characterLimit，按“两名前线、两名医疗、最多四名火力/控制”预算，手动技能持有者必须算在这八人内而不是额外部署。initialCost 低且存在 boss 时采用两阶段：先部署一名高 level 的先锋积累费用，不要开局铺满八人；以 retreat(先锋, kills=整数) 释放其名额后，紧接着部署一名高 annihilationPower 的 RANGED 主力，作为后期/Boss 补充输出。技能策略优先选择 skillType 为 AUTO/PASSIVE 的挂机技能并只输出 skillDaemon()；但存在 boss 时只保留一个 selected squad 中 annihilationPower 最高、用于爆发的 MANUAL 技能，operator 的 skillUsage=2，且只能为前面已经 deploy 的同名干员写一条 skill(name, kills=整数)，随后绝不输出 skillDaemon()。低 annihilationPower 的 S1 不得作为 Boss 的唯一手动技能；收到 BOSS_MANUAL_SKILL_TOO_WEAK 时，改为强度足够的高爆发 MANUAL 技能并保持同名干员已部署。12 条 operator 只是编队；若不写 retreat，deploy 总数绝不能超过 context.stage.characterLimit；若写 retreat，后续 deploy 前必须先使 active 降到限制内。绝不为 AUTO/PASSIVE 技能输出 skill；不确定技能类型时省略 skill。` },
        { role: "user", content: JSON.stringify({ context: input.context, feedback: input.feedback }) },
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      temperature: 0,
      stream: false,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`DeepSeek request failed: ${response.status} ${errorMessage(body)}`);
  return parseCandidate(body);
}
