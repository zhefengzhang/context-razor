# @weibaohui/context-razor

[![DSH plugin](https://img.shields.io/badge/dsh-plugin-green)](https://github.com/topics/dsh-plugin)
[![npm version](https://img.shields.io/npm/v/@weibaohui/context-razor)](https://www.npmjs.com/package/@weibaohui/context-razor)

**上下文剃刀**：把当前会话上下文逐条列出来——角色、预览、≈token（cl100k_base 估算，与技能市场同词表）——超阈值标红，勾选后精确裁剪。压缩不知道裁了什么，剃刀让你自己挑。

![上下文剃刀：逐条 token + 精确裁剪](docs/demo.gif)

## 核心功能

- **逐条列出**：当前会话模型可见的每条上下文（用户/助手/工具结果）按序排列，带预览、字符数与 ≈token 估算，点 ⋯ 查看全文与真实 usage
- **占比标注**：每条的 token 徽章同时显示其占全部上下文的百分比（如 `≈5728 · 15%`），一眼看出谁是上下文大头
- **类型筛选**：按类型一键过滤——用户 / 注入 / 助手，以及各工具名（bash、skill、read、edit…按会话实际出现的动态生成）。多选 toggle，与 token 量级筛选正交叠加
- **超阈值标红**：可调阈值（默认 500 token，本地记忆），超限条目红色高亮；「只看超阈值」过滤 + 「token 高→低」排序，大头一眼可见
- **精确裁剪**：勾选任意条目一键删除——连续段自动合并处理。删除走宿主 surface replace 协议（与官方 compaction 同款机制），**不经 LLM 总结**，删了什么、删了多少完全由你决定。每行尾部带 ✕ 快捷按钮，**单条直接删**与勾选后**多选批量删**走同一确认弹窗
- **配对与系统提示词**：工具调用与其结果是不可拆开的一对（宿主不变式），只勾一半会自动补上另一半并如实告知；系统提示词不可删（宿主只允许它被另一条 system/message 覆写），UI 上标为锁定
- **不重排**：本插件不会改变上下文条目顺序，只会剔除选中条目；「token 高→低」排序仅影响页面显示，模型可见顺序始终由会话 surface 决定
- **安全护栏**：会话运行中禁止裁剪（等当前回合结束）；每次替换附带一条 notice 标记消息，模型知道这段历史被你移除了，需要时会主动向你确认
- **非破坏**：append-only 日志保留全部痕迹（宿主机制如此）。「删除」= 从模型视野与界面投影中移除

## 安装

```bash
dsh plugin --profile web add @weibaohui/context-razor -w
```

装完重启 `dsh web` 即生效。入口：打开会话 → 顶部「上下文剃刀」标签（Hermes Loop 右侧），自动锁定当前会话。

## 删除的实现方式

dsh 会话是 append-only 事件日志（深冻结 + zstd 校验），物理删除不存在也不必要。本插件的裁剪 = 仿官方 `dsh-compaction-tool-result-pruner` 协议：对每个连续段追加一条 `compaction/prune` 计价事件 + 一条带 `surfaceOp: {op:'replace', startSeq, endSeq}` 的 notice 标记消息（`sourceEventSeqs` 覆盖全部被影子化节点）。被删节点从此不进 `deriveMessages()`——模型看不到、UI 不再渲染、token 不再计入上下文，而日志留痕可审计。

### 三条宿主契约（v0.4.4 起显式遵守）

实现的每一处都必须对上宿主当前的校验，错一条就会静默失效或把会话推进损坏状态：

1. **`surfaceOp` 的 replace 只认 `{op, startSeq, endSeq}` 三个键**（`isReplaceOp` / `validateSurfaceMetadata`）。字段名写成 `start`/`end` 会被拒：`carries an invalid replace surfaceOp`——v0.4.3 及更早版本的删除 100% 因此失败。
2. **工具配对不可拆开**。宿主的折叠遇到"没有对应 `tool-call` 的 `tool/result`"会直接判为损坏（`… has no matching tool-call (corrupt surface)`），压缩引擎也拒绝在不平衡切口下刀。判定用宿主自己导出的 `toolPairingBalancedBefore/After`（`@deepseek-ai/dsh-compaction` 根导出，与压缩引擎同一份实现），**不本地重写 fold**。
3. **surface node 0 若是系统提示词，只能被另一条 `system/message` 单节点覆写**（`assertSystemHeadRewrite`）。剃刀用 `user/message` 标记替换整段，所以**系统提示词不可删**——UI 上把这一条标为锁定，宿主侧也会在写任何事件之前拦下。

### 勾选会被自动扩到配对边界

只勾一个 `tool/result`（本插件最典型的用法：按工具名筛出大块工具输出）会拆开配对，所以删除时会自动把发起该次调用的助手消息一并纳入，并在响应里以 `expanded.seqs` 如实回显多删了哪几条——不会静默多删。反向同理：只勾含 `tool-call` 的助手消息，会把它的 `tool/result` 一并带上。

### 计价用的是宿主的尺子，不是界面上那把

`compaction/prune` 的 `shadowedTokenCount` 会被宿主的 surface 折叠直接相减，而宿主给每条消息定价用的是固定启发式（chars/4 + 结构开销）。所以写进去的必须是 `ctx.tokenMeter.estimateMessage()` 的结果。界面上展示的 `≈token` 仍是 cl100k（与技能市场同词表），两者对同一段中文能差一倍——界面数字用于比较大小，折叠用宿主数字。所用来源随接口回显（`guards.pricing`）。

## 开发

```bash
npm install     # 装 devDependencies 里锁定的 harness 包
npm test        # host-plane + client-plane 测试
npm run check   # 语法检查
npm run build:client   # 改过 client/index.js 后必须重建 client/bundle.js
```

**测试跑在真实的 `@deepseek-ai/dsh-session` 上，不用自造假 session。** 这一条是硬要求：v0.4.3 的删除路径长期 100% 失败却测试全绿，原因就是当时的测试用一个只复刻了"作者以为是"的协议的假对象——假对象只会确认你的假设，不会反驳它。harness 包按精确版本锁在 `devDependencies`（当前 `0.1.6-alpha.1`），宿主契约变了只能靠一次有意的版本升级进来。

## 联系我 :飞书群

![飞书群](https://foruda.gitee.com/images/1774880015525784725/4fd67005_77493.png)
