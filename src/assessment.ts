// Extracted from balance-monitor/backend/src/upstream/first-text.ts.
export const DEGRADATION_CHECK_PROMPT = `这是一次内部知识测试。
请严格遵守以下所有规则。

1. 禁止联网搜索。
2. 禁止调用浏览器、Web Search、API、插件、外部数据库、外部应用或任何其他外部工具。
3. 所有答案只能来自当前模型自身已有的内部知识。
4. 你必须回答从 Q01 到 Q15 的全部问题。
5. 你必须一直回答到 Q15。即使你不知道其中一个或多个问题的答案，也不得提前停止。
6. 每个问题必须独立判断。
7. 对于每一个单独的问题：
   - 如果你明确知道答案，直接给出答案。
   - 如果你无法明确确定答案，请准确写出："不清楚"
8. "不清楚" 只适用于当前正在回答的那一道题。
9. 对任何一道题写出 "不清楚" 后，必须立即继续回答下一题。
10. 永远不要把 "不清楚" 理解为终止整个回答的指令。
11. 允许你的答案在事实上是错误的。不要为了提高表面正确率而猜测。
12. 禁止根据候选人、排名、赔率、历史趋势、赛前形势、发布日期规律、政治趋势、当前日期、其他题目的日期、模型标签、所标注的知识截止日期，或其他题目的内容推断答案。
13. 不得利用下方标注的模型名称或知识截止日期来判断自己“应该知道”某个答案。这些标签只用于组织测试。
14. 不要在看到后面的题目后回头修改前面的答案。
15. 不要解释推理过程。
16. 不要提供来源、引用、补充说明、限定语或置信度。
17. 不要讨论自己的模型身份、训练数据、实际知识截止日期、系统配置、路由情况，或下方标签是否与当前回答模型一致。
18. 必须原样保留下方所有模型分隔线，并保持顺序不变。
19. 每一道题必须严格输出一行，格式如下：
    "Q01｜答案"
    如果不知道，则输出：
    "Q01｜不清楚"
20. 请用真实答案替换“答案”二字，不要把“答案”这个词原样输出。
21. 不要重复题目文本。
22. 不得遗漏任何题号。
23. 最终回答必须包含从 "Q01" 到 "Q15" 的全部题号，并严格按顺序排列。
24. 除三条模型分隔线和十五条规定答案行之外，不得输出任何其他内容。
    —— GPT-5.5｜Knowledge cutoff: 2025-12-01 ——
    Q01｜2025 年 9 月 6 日举行的美国网球公开赛女子单打决赛，最终冠军是谁？
    Q02｜2025 年 9 月 7 日举行的美国网球公开赛男子单打决赛，最终冠军是谁？
    Q03｜2025 年 10 月 7 日公布的 Nobel Prize in Physics，三位获奖者分别是谁？
    Q04｜2025 年 10 月 8 日公布的 Nobel Prize in Chemistry，三位获奖者分别是谁？
    Q05｜2025 年 11 月 1 日结束的 World Series，最终由哪支 MLB 球队夺冠？
    —— GPT-5.6｜Knowledge cutoff: 2026-02-16 ——
    Q06｜2026 年 1 月 31 日举行的澳大利亚网球公开赛女子单打决赛，最终冠军是谁？
    Q07｜2026 年 2 月 1 日举行的澳大利亚网球公开赛男子单打决赛，最终冠军是谁？
    Q08｜2026 年 2 月 1 日举行的第 68 届 Grammy Awards，Album of the Year 最终由哪张专辑获得？请同时给出演唱者。
    Q09｜2026 年 2 月 1 日举行的第 68 届 Grammy Awards，Record of the Year 最终由哪首歌曲获得？请同时给出演唱者。
    Q10｜2026 年 2 月 8 日举行的 Super Bowl LX，最终由哪支球队夺冠？
    —— GPT-6 Astra｜Knowledge cutoff: 2026-04-30 ——
    Q11｜2026 年 2 月 22 日举行的 EE BAFTA Film Awards，Best Film 最终由哪部影片获得？
    Q12｜2026 年 3 月 8 日举行的 Formula 1 Australian Grand Prix 正赛，最终冠军车手是谁？
    Q13｜2026 年 3 月 15 日举行的第 98 届 Academy Awards，Best Picture 最终由哪部影片获得？
    Q14｜2026 年 3 月 15 日举行的第 98 届 Academy Awards，Actor in a Leading Role 最终由谁获得？
    Q15｜2026 年 3 月 15 日举行的 Formula 1 Chinese Grand Prix 正赛，最终冠军车手是谁？`

function degradationCheckAssessment(responseText: string) {
  const answered = new Set<number>()
  const pattern = /(?:^|\n)\s*Q(\d{2})\s*[｜|]\s*([^\n\r]*)/g
  for (const match of responseText.matchAll(pattern)) {
    const question = Number(match[1])
    const answer = match[2]?.trim() || ''
    if (question >= 1 && question <= 15 && answer && answer !== '不清楚') answered.add(question)
  }
  const missingQuestions = Array.from({ length: 15 }, (_, index) => index + 1)
    .filter((question) => !answered.has(question))
  return {
    answeredCount: answered.size,
    missingQuestions,
    status: missingQuestions.length === 0 ? 'success' as const : 'degraded' as const,
  }
}

export const assessDegradationCheckResponse = degradationCheckAssessment
