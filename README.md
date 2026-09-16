# llm-meta

每天从 Cloudflare 官方公开网页读取 Workers AI 模型目录、神经元价格和 Unified Billing 充值手续费，生成 New API 可以读取的 JSON。Node.js 20+，无第三方运行依赖，不需要 Cloudflare API Key，也不发送推理请求。

## 文件与导入地址

| 文件 | 用途 |
| --- | --- |
| `newapi/ratio_config-v1.json` | 基础价格，未加充值手续费 |
| `newapi/ratio_config-v1-with-fee.json` | 基础价格乘以官方 Unified Billing 充值成本系数，目前为 1.05 |
| `data/cloudflare-workers-ai.json` | 完整模型目录、原始报价、神经元报价、换算结果与每个字段的价格来源 |
| `data/sync-report.json` | 可导入模型、需要单位适配的模型、未标价模型及官方报价差异 |

仓库为 [58cdn/llm-meta](https://github.com/58cdn/llm-meta)，发布分支为 `master`。在 New API 的「模型定价 → 上游价格同步」中使用以下自定义地址。**必须填写原始 JSON 地址，不能填写 GitHub 的 `/blob/` 网页地址。**

```text
https://raw.githubusercontent.com/58cdn/llm-meta/master/newapi/ratio_config-v1.json
```

通过 AI Gateway 购买预付额度、希望覆盖充值手续费时使用：

```text
https://raw.githubusercontent.com/58cdn/llm-meta/master/newapi/ratio_config-v1-with-fee.json
```

若页面分成「基础地址」和「接口路径」：

```text
基础地址：https://raw.githubusercontent.com
接口路径：/58cdn/llm-meta/master/newapi/ratio_config-v1-with-fee.json
```

选择需要的模型，检查同步差异后应用并保存。文件是 `success/message/data` 包装的 `/api/ratio_config` 协议，不要作为 models.dev 数据解析。New API 具体界面取决于部署版本。

如果同名模型已有计费表达式，先在 New API 将该模型切换为「按 Token」并保存，再应用倍率；本项目的数值倍率不会强行清除表达式。JSON 中没有的模型或字段也不代表应将已有价格清零。导入价格不等于对应渠道和测试端点已经支持该模型。

## 价格口径

官方来源：

- [模型目录](https://developers.cloudflare.com/workers-ai/models/)：确定完整、区分大小写的 API 模型 ID，并补充价格总表没有的 token 价格，例如某些缓存读取价格。
- [神经元价格表](https://developers.cloudflare.com/workers-ai/platform/pricing/)：优先使用每种单位的神经元数换算美元，保留更精确的小数，而不是使用页面四舍五入后的美元展示价。
- [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)：动态解析充值手续费。
- [New API 价格同步源码](https://github.com/QuantumNous/new-api/blob/main/controller/ratio_sync.go)：校对 JSON 包装与倍率字段。

换算规则：

```text
每单位美元价格 = 每单位神经元数 × 每 1000 神经元美元价格 ÷ 1000
当前：1 神经元 = 0.000011 美元

model_ratio = 每百万输入 token 美元价格 ÷ 2
completion_ratio = 输出价格 ÷ 输入价格
cache_ratio = 缓存读取价格 ÷ 输入价格
create_cache_ratio = 缓存写入价格 ÷ 输入价格（仅来源明确发布时）

含手续费的输入价格 = 基础输入价格 × (1 + 充值手续费率)
所有 token 维度同比例加价，因此 completion_ratio/cache_ratio 保持不变。
```

5% 适用于 **Unified Billing 购买预付额度**：100 美元额度付款 105 美元，系数为 `1.05`，不是 `1 / 0.95`。它不应被一概视为 Workers Paid 的每次推理手续费。基础文件适用于不需要这项成本加成的情况；含手续费文件不包含你的利润、税费、汇率、固定订阅费或支付平台额外费用。

每天免费 10,000 神经元是账户级额度，官方写明在 UTC 00:00（北京时间 08:00）重置。**不把免费额度摊入模型价格**：实际消费总量未知，不同计费模式和模型的适用条件也不能通过静态定价文件推断。目录中的免费额度字段只作说明，不承诺所有预付请求都享受减免。

同一字段同时有目录美元报价与总表神经元价格时，以神经元换算为准，并核对差异；明显的 token 报价冲突会使整个任务失败。总表缺失而目录明确发布的 token 价格，会以 `catalog_usd` 标记其来源。缺价格不会静默变成零。

## 覆盖边界

首次抓取（2026-09-16）得到 65 个模型：

- 38 个可按 token 倍率导入，包含 BGE embeddings/reranker、翻译模型和语言模型。
- 19 个需要独立的单位适配，原始价格保存在完整目录中，不进入 token 倍率文件。
- 8 个在抓取的目录与总表中未发布可用价格，单独列在报告里；不代表它们免费。

语音分钟、TTS 输入字符数、图像 tile/像素/步数与音频 token 是不同单位。要将这些模型接入 New API 精确计费，必须先确认渠道适配器实际提供哪些用量，以及部署版本的计费表达式是否支持这些字段；不能把每分钟价格填入每百万 token 的栏位。即使价格摘要显示 `$0.00 per step`，也不会自动认定其免费。

例如官方 `smart-turn-v2` 的美元价与神经元价差距明显；报告保存两者，要求核对，不擅自补一个用于计费的数值。API ID 保留官网 `data-model-id` 的大小写，例如 `@cf/ai4bharat/indictrans2-en-indic-1B`；不使用小写搜索字段冒充 API ID。

## 本地运行

```sh
node --test
node scripts/sync-cloudflare.mjs --help
node scripts/sync-cloudflare.mjs --dry-run
node scripts/sync-cloudflare.mjs --write
```

默认 dry-run，只联网读取与显示预期改动。`--write` 仅管理上述四个 JSON，先完成全部抓取、解析和覆盖检查再写文件，并回读核验；不要在生成文件中手工维护价格。没有内容变化时不重写文件。脚本不执行 Git 操作。

## GitHub Actions

工作流文件：`.github/workflows/sync-cloudflare.yml`。

- 每日 UTC 17:00，即次日北京时间 01:00 触发；也可在 Actions 页面手动运行。
- 工作流和代码变更推送到默认分支时运行一次；生成 JSON 的提交不形成循环。
- 先执行测试，再联网抓取和生成，最后只暂存四个生成 JSON，有实际变化才提交并推送。
- 只使用仓库内置 `GITHUB_TOKEN`，不需要设置 Cloudflare Secret；同步任务有 `contents: write` 权限。
- 如果仓库规则禁止机器人直接推送默认分支，提交步骤将失败并保留错误，需按仓库协作规则改为 PR 流程；不会强推或绕过保护。
- GitHub 定时任务可能延迟，不保证精确到 01:00；工作流必须存在于默认分支。公开仓库 60 天无活动时定时任务可能停用，需要重新启用。参见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

网络失败、网页结构变化、模型计数不符、重复 ID、明显 token 价格冲突或已发布价格/模型消失时，脚本返回非零，工作流不会提交新价格。模型正式下线时需要人工核对并更新已提交的基线；不自动删除历史模型。

生成文件不附加每天变化的时间戳，避免价格未变时每天提交；每日成功抓取的证据看 Actions 运行日志，价格内容更新时间看 Git 历史。新模型缺价格和非 token 单位会在每次运行摘要及 `sync-report.json` 中明确显示。

本地生成与测试不代表 GitHub 定时任务已经启用，也不代表你的 New API 实例完成导入。发布后请先选一个已知模型核对显示价格与测试端点，再逐批应用。
