# llm-meta

每天从 Cloudflare 官方公开网页读取 Workers AI 模型目录、神经元价格和 Unified Billing 充值手续费，生成 New API 可以读取的 JSON。Node.js 20+，无第三方运行依赖，不需要 Cloudflare API Key，也不发送推理请求。

## 文件与导入地址

| 文件 | 用途 |
| --- | --- |
| `newapi/ratio_config-v1.json` | 基础价格，未加充值手续费 |
| `newapi/ratio_config-v1-with-fee.json` | 基础价格乘以官方 Unified Billing 充值成本系数，目前为 1.05 |
| `newapi/cf_models.txt` | 官方 Workers AI 目录中的全部模型 ID，单行英文逗号分隔 |
| `newapi/cf_models_mapping.json` | New API 模型映射，格式为 `短名称 → 完整模型 ID` |
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

## 模型列表与映射

- [支持的模型列表](https://raw.githubusercontent.com/58cdn/llm-meta/master/newapi/cf_models.txt)：保留官方完整模型 ID 和大小写，以英文逗号分隔，包含尚无可导入价格的模型。
- [模型映射](https://raw.githubusercontent.com/58cdn/llm-meta/master/newapi/cf_models_mapping.json)：JSON 对象，例如 `"glm-5.3-flash": "@cf/zai-org/glm-5.3-flash"`，可用于 New API 渠道的模型映射配置。

两份文件与价格使用同一批官方目录数据生成，并在同一次更新中提交。映射保留已有的第三方及历史条目，这些条目不代表当前 Workers AI 目录仍支持它们；清单见同步报告的 `preserved_mapping_aliases`。短名称冲突时停止同步并报错。

模型列表使用完整 ID，映射的键使用短名称。若客户端以短名称请求，还需在 New API 配置对应的渠道模型和计费项；本项目的价格文件按完整 ID 发布。仓库文件更新不会自动修改 New API 实例的渠道配置。

## 其他定价预设

以下为独立维护的公共定价源，可按需在 New API 中选用。本项目不合并或镜像这些数据，Cloudflare Workers AI 定价请使用上方的专用同步地址。

| 预设 | 地址 |
| --- | --- |
| 官方定价预设（New API 内置预设，basellm 维护） | [https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json](https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json) |
| models.dev 定价预设 | [https://models.dev/api.json](https://models.dev/api.json) |

“官方定价预设”是 New API 的预设名称，不代表 Cloudflare 官方发布的同步接口。models.dev 使用独立的数据格式，需通过 New API 对应预设导入。

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

## 模型覆盖

最新覆盖情况见 [`data/sync-report.json`](data/sync-report.json)：

- 按 token 计费的模型转换为 New API 倍率，包括语言模型、文本向量、重排序和翻译模型。
- 按分钟、字符、像素或步数计费的模型保留原始报价，需要相应的计费适配，不进入 token 倍率文件。
- 未发布可用价格的模型单独列出，不按免费模型处理。

语音分钟、TTS 输入字符数、图像 tile/像素/步数与音频 token 是不同单位。要将这些模型接入 New API 精确计费，必须先确认渠道适配器实际提供哪些用量，以及部署版本的计费表达式是否支持这些字段；不能把每分钟价格填入每百万 token 的栏位。即使价格摘要显示 `$0.00 per step`，也不会自动认定其免费。

来源中的报价差异记录在同步报告中。模型 ID 保留官方 API 标识的大小写，导入时应与渠道模型名称一致。

## 本地运行

```sh
node scripts/sync-cloudflare.mjs --dry-run
node scripts/sync-cloudflare.mjs --write
```

默认 dry-run，只联网读取与显示预期改动。`--write` 管理上述六个文件，先完成全部抓取、解析、映射冲突及覆盖检查再写文件，并回读核验；不要在生成文件中手工维护价格。没有内容变化时不重写文件。脚本不执行 Git 操作。

## GitHub Actions

工作流文件：`.github/workflows/sync-cloudflare.yml`。

- 每日 UTC 17:00，即次日北京时间 01:00 触发；也可在 Actions 页面手动运行。
- 工作流和代码变更推送到默认分支时运行一次；生成 JSON 的提交不形成循环。
- 校验通过后抓取并生成价格、模型列表和映射，仅在六个生成文件有变化时提交并推送。
- 只使用仓库内置 `GITHUB_TOKEN`，不需要设置 Cloudflare Secret；同步任务有 `contents: write` 权限。
- 如果仓库规则禁止机器人直接推送默认分支，提交步骤将失败并保留错误，需按仓库协作规则改为 PR 流程；不会强推或绕过保护。
- GitHub 定时任务可能延迟，不保证精确到 01:00；工作流必须存在于默认分支。公开仓库 60 天无活动时定时任务可能停用，需要重新启用。参见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

网络失败、网页结构变化、模型计数不符、重复 ID、明显 token 价格冲突或已发布价格/模型消失时，脚本返回非零，工作流不会提交新价格。模型正式下线时需要人工核对并更新已提交的基线；不自动删除历史模型。

同步运行状态见 [GitHub Actions](https://github.com/58cdn/llm-meta/actions/workflows/sync-cloudflare.yml)，价格变更见 [提交记录](https://github.com/58cdn/llm-meta/commits/master/)。生成文件不附加每日变化的时间戳，价格未变时不产生额外提交。
