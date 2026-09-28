import { composeRuleModules } from './rule-composer.mjs';

export const GENERATION_RULES_VERSION = 'hermes-generation-rules/2026-09-21-v4';
// The old monolithic markdown remains as an audit snapshot. Production and
// review requests now compose the versioned modules under prompts/modules.
export const generationRules = composeRuleModules();

export const cardGranularity = Object.freeze({
 default: '先判断独立使用价值，允许总览卡＋子卡，不默认强制一条来源一张卡。',
 split_when: '对象有可辨识名称，包含可复述、可复制或可执行的内容，并且可单独找回或使用。',
 keep_together_when: '只有名称、排名或标签，内容量不足，或离开上下文无法使用的条目留在总览/详情。',
 attachment_merge_check: '仅为取得、安装、启动同一个主对象服务的说明合回主卡；可复制或能执行不单独构成拆卡理由。',
 independent_value_guard: '完整可复用 Prompt、设计方案、独立概念不因依赖主工具而合并；合并保留内容、操作、来源和证据。',
 short_usable_content_exception: '短但能直接复制使用的 Prompt、命令或方法可以独立成卡；普通示例不自动拆卡。',
 count_rule: '拆卡数量不按并列条目数量固定。',
 do_not_split: ['依附于主对象的安装步骤与使用路径', '没有独立价值的限制与付费背景', '依赖缺失上下文的普通示例', '仅作为效果预览的图片'],
 collection_rule: '只有两张及以上独立卡时才能输出来源集合；如果只生成一张卡，collections 必须是空数组 []，不得建立单成员集合；集合不等于总览卡，也不表达父子关系。',
 naming_rule: 'Topic 是找回类别，Card 是具体内容；名称缺入口不必改名，身份不清才用功能名称。'
});

export function buildReviewGenerationPrompt(types) {
 return `${generationRules}
审核协议适配（规则版本 ${GENERATION_RULES_VERSION}）：
仅输出 JSON，固定类型 ${types.join('、')}。不使用历史审核答案。
字段形状：{focus_type:"auto",focus_note:"推断的收藏重点",split_note:"拆卡理由",cards:[{id:"c1",title:"",type:"知识",topics:[],keypoint:"简短卡面重点",detail:"完整详情",relation_note:"关系说明",related_card_ids:[],disposition:"ready或pending",pending_reason:"",evidence_ids:[],image_ids:[],actions:[{label:"操作名称",url:"",text:""}],resources:[{label:"资源及状态",url:"",text:"来源说法或核实状态"}]}]}。
id 为本次输出内唯一临时标识；related_card_ids 指向真实存在的其他卡，子卡引用总览但不靠引用替代本卡证据。image_ids 只引用真实资产。
无最低可用内容才进入 pending；有明确获取线索且用途清楚可以 ready，并在资源说明中保留缺失。网址只能使用已提供的明确 HTTP(S) 链接；动作中的来源链接不冒充资源直链。
所有字段都提供。Prompt 复制操作的 text 必须为已保存、可复用的实际文本，而不是“见详情”等占位词。`;
}
