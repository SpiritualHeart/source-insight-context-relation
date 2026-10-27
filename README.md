# Source Insight Context & Relation

> 把 Source Insight 4 的 **Context Window** 和 **Relation Window** 搬到 VS Code 底部面板：定义/声明/类型、可调层级的调用树、调用者/被调用/双向/引用/成员/类型关系，以及右键关系菜单。

![Source Insight Context & Relation](https://raw.githubusercontent.com/SpiritualHeart/source-insight-context-relation/main/media/preview.png)

> **第一次使用？** 按 `Ctrl+Shift+P` 运行 **Source Insight: 打开使用说明**，按“安装 → 打开面板 → 查调用者”的顺序操作。

## 主要功能

- **底部双栏**：左侧 Context 显示定义代码，右侧 Relation 显示可递归展开的关系图。
- **干净节点**：关系节点默认只显示函数/变量/成员名，**不显示文件路径、行号或代码片段**；需要时可在设置中打开位置列。
- **Context**
  - 显示定义、函数声明、变量类型；定义行和目标符号名会高亮，超长函数自动截断并可点击任意行跳转。
  - 多个同名定义时提供匹配导航。
  - Context 独立锁定、后退/前进、复制名称、打开定义。
  - 可选行号；颜色跟随 VS Code 主题。
- **Relation**
  - 函数默认显示 **调用者（Callers）**，变量默认 **引用（References）**，结构/类默认 **成员（Contains）**。
  - 支持 **调用者 / 被调用 / 双向 / 引用 / 成员 / 类型 / 派生** 七种关系。
  - **1–6 层**自动展开，工具栏 `− / +` 调整；任意节点可单独展开或按 1/2/3 层展开。
  - 声明节点固定在函数关系的第一位；读取/写入、调用次数、循环引用均有标记。
  - 单击节点在 Context 中预览，双击打开源码，右键打开关系菜单。
  - 横向图、纵向图、轮廓列表三种布局；折线/曲线/直线、箭头、间距、阴影可配置。
  - 多个 Relation 视图标签页，每个标签独立保存关系类型、层级和树。
  - Relation 独立锁定、后退/前进、刷新；锁定后光标移动不会替换当前图。
- **状态栏**：显示当前 Context 符号和关系数量；点击分别聚焦 Context / Relation。
- **纯 Language Server 驱动**：使用 VS Code 标准 Definition / Declaration / Reference / TypeDefinition / Implementation / DocumentSymbol Provider，可配合 C/C++、clangd、Pylance、TypeScript 等语言服务。

## 安装

```powershell
code --install-extension source-insight-context-relation-2.0.1.vsix
```

安装后重新加载 VS Code：

1. 打开工程，等待语言服务完成索引；
2. 第一次使用：按 `Ctrl+Alt+I`（macOS `Cmd+Alt+I`），或点击状态栏的 **Source Insight**，打开底部面板；
3. 面板打开后，把光标放到函数或变量上，插件会自动查询，**不需要每次再按快捷键**；
4. 在底部 Panel 中拖动中间分隔条调整两栏宽度。

> 自动查询只在面板可见且跟随开启时进行；面板关闭时不会在后台反复分析，需要时重新打开即可。

## 快捷键

| 命令 | 快捷键 |
| --- | --- |
| 打开 / 聚焦 Context / Relation 面板 | `Ctrl+Alt+I` |
| 切换光标跟随 | `Ctrl+Alt+F` |
| 重新分析当前符号 | 面板刷新按钮 |
| 增加 / 减少关系层级 | 面板 `− / +` |
| 下一个 Relation 布局 | 命令面板 |

> `Ctrl+Alt+I` 只用于第一次打开面板，或面板关闭后重新打开；光标跟随会自动刷新，不需要反复按。

## 使用

### Context

- 函数显示从签名开始的完整定义；变量显示定义行附近上下文。
- 变量存在 `extern` 声明时可切换到“声明”；结构体/类变量可查看成员。
- 顶部只显示符号名和类型，不显示文件路径。
- 代码行单击打开对应位置；顶部按钮可后退/前进、锁定、打开定义。

### Relation

```text
[定义] ──┬── [声明]
         ├── [调用者 A]
         ├── [调用者 B] ── [调用者 B 的调用者]
         └── ...
```

- **关系**下拉框切换关系类型；**层级**控制自动展开深度。
- **双击**节点跳转，**单击**在 Context 预览，**右键**打开：
  - 查看调用者 / 被调用 / 引用 / 类型 / 成员 / 派生；
  - 设为根节点；
  - 在 Context 中查看；
  - 展开 1 / 2 / 3 层；
  - 打开定义、复制名称。
- 节点左侧 `+` 表示还有更深关系可按需加载；`▾ / ▸` 收起或展开已加载分支。
- 顶部 `+` 新建 Relation 视图；标签上的 `×` 关闭；同一视图内切换布局不丢关系。
- Context 锁定后 Relation 单击预览不会改写 Context；Relation 锁定后光标跟随不会替换当前关系图。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sourceInsight.followCursor` | `true` | 面板可见时跟随编辑器光标 |
| `sourceInsight.trackingMode` | `symbol` | `symbol` 跟踪符号，`enclosing` 跟踪所在函数/类，`off` 关闭自动跟踪 |
| `sourceInsight.autoReveal` | `false` | 光标变化时自动打开面板 |
| `sourceInsight.contextLines` | `12` | 变量的上下文行数 |
| `sourceInsight.contextLineNumbers` | `true` | Context 显示行号 |
| `sourceInsight.maxContextLines` | `600` | Context 最多渲染行数 |
| `sourceInsight.maxReferences` | `300` | 每个符号最多查询的引用/调用点 |
| `sourceInsight.maxRelationNodes` | `500` | 关系树节点上限 |
| `sourceInsight.defaultDepth` | `1` | 新 Relation 默认层级（1–6） |
| `sourceInsight.debounceMs` | `280` | 跟随刷新防抖 |
| `sourceInsight.providerTimeoutMs` | `15000` | Language Server 查询超时 |
| `sourceInsight.excludeMacros` | `false` | 调用图排除 C 函数式宏 |
| `sourceInsight.excludedSymbols` | `[]` | 不展开的函数/符号名 |
| `sourceInsight.expandDuplicateBranches` | `false` | 自动展开重复分支 |
| `sourceInsight.showLocations` | `false` | 节点显示文件/行号列（默认关闭） |
| `sourceInsight.relationLineStyle` | `elbow` | `elbow` 折线、`curve` 曲线、`direct` 直线 |
| `sourceInsight.relationSpacing` | `40` | 图节点列间距 |
| `sourceInsight.relationArrows` | `true` | 连接线末端显示箭头 |
| `sourceInsight.relationNodeShadow` | `true` | 节点阴影 |
| `sourceInsight.sortReferencesByFile` | `true` | 引用按文件/行号排序 |

## 已知边界

- 关系质量取决于语言服务的 Definition / Declaration / Reference / Implementation / DocumentSymbol 能力；未安装语言服务时只能做词级回退。
- C/C++ 匿名 `typedef struct` 的名称在不同 cpptools 版本中可能显示为内部名；插件会从声明行回退解析真实类型名，但成员展示仍依赖 DocumentSymbol 结构。
- 标签页共享 Context 与全局锁定；每个标签独立保存关系类型、层级和树，非活动标签在切换回来时按当前符号重建。
- Source Insight 的 Project Symbol List、Code Metrics、Touch Files、打印等工程管理能力没有 VS Code 通用对应接口，未伪造实现；可用 VS Code 工程/书签/打印扩展替代。
- Relation 的层级递归依赖语言服务对调用者函数的引用查询；大型工程可降低 `defaultDepth`、`maxRelationNodes` 或使用 `excludedSymbols`。

## 开发

```powershell
npm install
npm run check
npm test
npm run test:integration   # 自定义 Provider 端到端测试
npm run test:cpp           # 本机 ms-vscode.cpptools 真实 C 工程 + 截图
npm run package
```

产物：`dist-vsix/source-insight-context-relation-2.0.1.vsix`。

## License

MIT
