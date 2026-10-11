# 前瞻性真实日志盲测：第一轮

评测对象固定为 `22b5fa10df23e6f433fce0ff41f820a80808ea66`。冻结对象、
GGUF 与 CLI SHA-256、llama.cpp 版本及默认参数、请求参数、配置和源文件
哈希记录在 `production_validation_freeze.json`。本轮不修改模型、提示词、
Guard、8K 预算或压缩逻辑，不训练 v3，不发布 npm。

目前新有效样本为 0，独立盲测尚未开始。来源清单仍待确定，不能以历史
记录或采集工具自检代替新的真实运行。50 条是工程评估目标，不证明低故障率。

## 样本边界与预注册

- 四条历史生产故障仅用于固定生产回归，不计入盲测。
- 18 条合成鲁棒性案例仅用于已知格式回归，不计入盲测。
- 76 条历史候选仅用于探索性分析，状态为 `independence_unknown`。
- 首轮盲测仅接纳冻结与来源登记之后采集的真实工作负载，且独立性审核通过。

在执行第一条采集命令之前登记项目目录、真实命令 argv、原始问题、报告
路径、必要环境变量、采集时间窗口和运行选择规则。登记窗口内连续纳入
清单中真实工作的每次运行；不根据 Condense 输出选择样本，不制造错误
凑覆盖，不重复执行同一输入充数。时间窗口或来源更改需要新采集轮次。

至少 50 条审核通过且去重后的新真实日志，并覆盖成功、失败、仅 warning、
混合结果、超长输出（原始 UTF-8 文本超过 8K 字符）、无法明确判定六类。
类别可重叠，缺少任一类时第一轮覆盖未完成。按采集时间、sample_id 排序，
将满足覆盖条件的最早完整前缀作为本轮样本，超出的记录留待下一轮。
选择及标注均在查看任何本轮 Condense 输出之前完成。

本机来源清单模板位于
`~/.local/share/condense-validation/22b5fa1/sources.json`，填写结构如下：

```json
{
  "evaluation_id": "prospective-production-22b5fa1-round1",
  "registered_at": "采集前的 UTC ISO-8601 时间",
  "collection_window": {
    "start": "UTC 时间",
    "end": null,
    "end_condition": "首轮测试完成后关闭；至少 50 条有效样本且覆盖六类，独立标注封存后一次性评测"
  },
  "selection_rule": "窗口内连续采集已登记真实工作负载的所有运行",
  "sources": [{
    "id": "可追溯的来源 ID",
    "project": "/实际项目目录",
    "argv": ["原始生产命令", "实际参数"],
    "question": "执行前确定的用户问题",
    "reports": ["项目内实际测试报告的相对路径"],
    "environment": {}
  }]
}
```

## 本机来源核实

[来源审计](production_source_audit.json) 记录本机检索范围、仓库身份、
命令定义及依赖检查。Lumen 位于 `/Users/mfordjody/other/lumen`，
`npm run build`、构建入口及依赖已核实；未为本次核实执行构建。

`/Users/mfordjody/other/mycode` 已不存在；在已检查范围内未找到 RTK
或 videos-workflow 项目目录。发现的 Caveman 是 Claude 插件目录中的
上游仓库，并非所列 fork，暂不替代登记。用户确认 mycode 已更名为
app2me；当前目录为 `/Users/mfordjody/other/app2me`，与 Lumen 一起登记。
app2me 的 `lint`、`typecheck`、`build` 脚本及根目录依赖已核实；通过
`mise exec -- pnpm run <脚本>` 使用项目指定的 Node 24.14.0、pnpm 10.33.2。
工作区存在用户未提交的变更；来源核实不执行上述工作命令，不计作样本。
Condense 仅用于辅助回归。

本机 `sources.json` 登记 `app2me-lint`、`app2me-typecheck`、`app2me-build`
及 `lumen-build`；登记时间为窗口开始时间，按用户要求在首轮测试完成时
结束。`end` 为 null 时必须预先填写非空 `end_condition`；固定截止时间
仍可使用。不得事后改写已封存清单的结束条件或来源。

达到样本数及覆盖后，封存最早完整前缀并停止为本轮纳入新样本；完成独立
标注、一次性评测后，在采集目录写入 `completion.json`，记录实际完成时间
及评测报告 SHA-256。此文件存在即拒绝启动新采集。窗口开放不代表自动
采集已启动，实际工作须通过下述采集命令运行；当前新有效样本仍为 0。

## 采集与隔离

使用 `collect_prospective.py` 执行已登记的原始产出命令；数据目录必须在
仓库及生产 Condense 配置目录之外。命令退出状态原样保留，非零退出并不
意味着采集失败。登记、启动或文件写入失败则不能作为有效样本。

```sh
python3 train/bench/collect_prospective.py \
  --sources ~/.local/share/condense-validation/22b5fa1/sources.json \
  --source 已登记来源ID \
  --output ~/.local/share/condense-validation/prospective-round1
```

每次运行保存原始合并 stdout/stderr 字节、SHA-256、开始与结束时间、项目、
实际 argv、退出码、时长、环境指纹和报告快照。报告标明是否在本次运行
更新；缺失或陈旧报告不能自动当作当前运行的结论。采集工具不运行
Condense，不生成标准答案。外层包装或脚本内部也不得先裁剪、RTK 过滤或
Condense 压缩原始日志。shell 命令应将真实生产者登记为 argv；复杂脚本
需要复核其输出链路，禁止把已摘要的输出当原文。

新日志、问题、标签和评测输出不得进入训练、提示词调试或 Guard 开发。
原始数据只保存在本机；仓库中的历史清单只含来源状态和哈希。
独立标注人员在标签封存前不接触模型或最终管线输出。

评测时使用新隔离目录，显式关闭 datasetEnabled、autoLearn、
autoPromoteScopes，maxPromptDslEntries 保持代码允许的默认值 40。
配置目录旁的 DSL 目录必须为空，实际提示词不得包含 DSL 注入内容。
保留用户现有生产配置，不能因其启用数据集写入而污染盲测。

## 去重与独立标注

`historical_recall_manifest.json` 保存全部 111 条旧记录的分组、来源状态
和去重结果，其中 76 条为历史候选。原始 Recall 与 Observe 快照在
`~/.local/share/condense-validation/22b5fa1/`，不删除旧记录。
旧记录未保存实际命令，相关字段保持 null；训练清单不可用，不能声称独立。

新日志先以原始字节 SHA-256 检查与本轮样本、历史快照、四条生产回归及
18 条合成案例的重复。进一步去除 ANSI、统一换行和连续空白后，计算
连续五词 shingle 集合的 Jaccard 相似度；大于等于 0.85 的配对，以及
归一化后完全相同的配对，均列入人工复核，不能自动纳入盲测。
短于五词的日志只做精确与归一化匹配并人工核查。同一运行的转录、截断、
路径或时间变化版本也不得作为新样本。已知重复排除；无法确认独立的
高相似记录继续标为 `independence_unknown`，不计入 50 条。
这是预注册复核规则；当前历史审计只完成精确及首尾空白去重，并未完成
高相似检查。新采集文件最初也都不具备盲测资格。

重复检查范围必须列出可访问的历史语料；缺失的 v2 训练数据清单仍标记
为未核查。前瞻性采集与冻结后隔离保证本轮新运行未被反馈用于开发，
不等于证明所有文本或语义从未出现在基础模型或未知历史训练数据中。

标签必须由原始命令退出码、与本次运行对应的测试报告及人工复核确定，
不调用 Condense 提取器生成答案。退出码 0 不自动代表测试通过；未运行
测试、命令语义不明或统计矛盾时标记 UNKNOWN。保留每条必留错误的原文
及字节位置、真实统计、允许的结论、禁止捏造的内容和标注依据。

每条独立标签至少包含这些字段：

```json
{
  "sample_id": "采集 ID",
  "raw_sha256": "原始文件 SHA-256",
  "reviewer": "实际复核人员",
  "reviewed_at": "UTC 时间",
  "expected_outcome": "PASS、FAIL 或 UNKNOWN",
  "categories": ["success、failure、warning_only、mixed、long、unknown 中适用类别"],
  "required_evidence": [{"raw_text": "原始证据", "byte_start": 0, "byte_end": 0}],
  "required_facts": ["独立核定的统计或其他问题要求的信息"],
  "basis": ["退出码及报告文件 SHA-256，人工复核说明"],
  "duplicate_review": {"status": "审核结果", "matched_ids": [], "reason": "依据"},
  "independence_status": "verified_prospective 或 independence_unknown",
  "eligible_for_blind_evaluation": false
}
```

示例中的值是字段说明，不是实际样本或已完成标签。字节区间使用 UTF-8
原文件的半开区间，必须精确还原 raw_text。复核完成、来源可追溯、去重
通过且隔离条件成立后才可标记 eligible。标签不从模型答案反推。

## 封存、一次性评测与指标

封存所选 sample_id 顺序、全部原文及报告哈希、来源登记、完整标签、
协议和冻结对象哈希，并记录封存时间。未完成封存不运行模型。
校验冻结 CLI、GGUF、llama.cpp、默认参数和 chat template 哈希，
以及实际请求的 temperature=0、max_tokens=512、cache_prompt=true、
enable_thinking=false。seed 等未在请求覆盖的参数以冻结的运行时默认值
为准；不承诺跨硬件或并行调度的逐位复现。

每个样本只运行一次冻结 CLI，串行调用同一个新启动的冻结服务，首个样本
之前只做健康检查。每条使用新配置、Recall、Observe、Stats 路径。
透明观察同一次推理的原始模型答案、实际模型输入和最终输出，不额外再
请求一次模型作比较。未调用模型的 bypass 单独统计，模型分母只包含
实际推理记录。服务重启、超时或工具故障保留在首次评测记录中，不以重跑
成功覆盖；必要复现另列诊断结果，不进入首次通过率。

报告必须同时提供分子、分母及六类覆盖：

- 模型原始合约通过率、最终管线合约通过率，以及两者差异。
- 必留错误证据召回率；明确成功样本中的模型和最终输出错误误报率。
- Guard 修复率、原文回退率、UNKNOWN 样本数及模型/管线无法判定率。
- 有效净 token 节省、原文回退放弃的收益，以及端到端 P95。

证据召回按独立标签中的必留错误计算，无错误时分母为零则记为不适用。
正确 UNKNOWN 应保留事实并不强行断言 PASS/FAIL；明确结果却拒绝判断需
按该条问题合约评分，不能从分母中移除。原文回退单列，不能被当作模型
质量提升或成功压缩。有效净节省仅计入合约满足且未回退原文的输出，
使用冻结估算器的 input tokens 减 output tokens，保留负收益；不合格
摘要与原文回退计零收益。报告估算 token，不能标作模型实测 usage。
端到端时长从 CLI 启动至输出与持久化完成，不包括原始命令执行时间；
同时报告全体有效样本 P95 和成功压缩调用 P95，使用排序后 ceil(0.95*N)
位置的 nearest-rank 值。未完成调用单独列失败及超时，不能悄悄排除。

结果封存之后才能分析失败样本。任何基于本轮结果的规则、提示词或模型
修改均把已揭示样本转入开发回归，下一轮使用新的未见样本。不能在这
50 条上反复调规则，再称其为独立泛化成功。完成此轮后再决定证据规则、
性能或 v3 训练是否需要调整。
