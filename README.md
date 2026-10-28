# Source Insight Context & Relation

> 把 Source Insight 4 的 **Context Window**、**Relation Window** 和 **工程符号搜索** 搬到 VS Code 底部面板，并为 C 语言内置了独立的符号数据库（宏、typedef、结构体成员、函数声明/定义、变量、汇编标签），不再只是简单的文本/语言服务搜索。

![Source Insight Context & Relation](https://raw.githubusercontent.com/SpiritualHeart/source-insight-context-relation/main/media/preview.png)

> **第一次使用？** 按 `Ctrl+Shift+P` 运行 **Source Insight: 打开使用说明**；或直接按 `Ctrl+Alt+I` 打开面板。

## 主要功能

- **底部双栏**：左侧 Context 显示定义代码，右侧 Relation 显示可递归展开的关系图。
- **自带 C 符号索引（2.1.0 新增）**
  - 打开工程后后台扫描 `.c/.h/.s/.asm/.inc`，建立类似 Source Insight 的符号数据库。
  - 识别对象宏 / 函数式宏、typedef（含指针/函数指针别名）、struct/union/enum 及其成员、函数原型与定义、全局变量、数组、指针、汇编标签。
  - 索引失败或文件未收录时自动回退到 VS Code 语言服务，不影响原有 C/C++ 工程。
- **按符号类型区分的关系逻辑**
  - 函数：调用者 / 被调用 / 双向 / 引用（调用、读、写、取址）/ 声明与定义。
  - 宏：宏引用（不含 `#define` 本身）、宏定义；函数式宏的调用点标记为“调用”。
  - 结构体 / 联合体：成员、变量实例（自动区分 **值实例** 与 **指针实例**）、类型别名、引用、声明/定义。
  - 枚举：枚举成员、引用、声明/定义。
  - typedef：目标类型、成员、变量实例、引用。
  - 变量 / 指针变量：引用、类型、**成员访问（区分 `.` 与 `->`）**、类型全部成员、声明/定义。
  - 汇编标签：调用者、被调用、引用、声明。
- **Context**
  - 定义 / 声明 / 类型三种视图；函数原型与定义严格区分（原型在 `.h`、定义在 `.c`）。
  - 指针变量与结构体变量分别标注「结构体指针」「结构体变量」「指针成员」等类型。
  - 定义行与符号名高亮、同名符号匹配导航、锁定、后退/前进、复制名称、打开定义、可选行号。
- **Relation**
  - 1–6 层自动展开；节点可按需展开；循环检测；读/写/调用/取址次数标记。
  - 节点显示属性标签：指针、数组、extern、static、原型、函数式宏、`→ 类型` 等。
  - 成员访问节点显示 `值访问 · 字段` / `指针访问 · 字段`，并列出每个读写位置。
  - 单击节点在 Context 中预览，双击跳转，右键打开关系菜单（含新增“变量实例 / 成员访问 / 声明与定义”）。
  - 多个 Relation 标签页、横向/纵向/轮廓布局、折线/曲线/直线、箭头、间距和阴影。
- **工程搜索（正则表达式）**
  - 顶部搜索按钮或命令 **Source Insight: 工程搜索**。
  - 支持普通文本、整词匹配、JavaScript 正则表达式、区分大小写的正则。
  - 结果以「文件 → 行」树形显示在 Relation 窗口，双击直接跳转到源码行。
- **状态栏**：显示当前 Context 符号、关系数量或搜索结果数量；点击可聚焦对应窗口。

## 安装

```powershell
code --install-extension source-insight-context-relation-2.1.0.vsix
```

安装后重新加载 VS Code：

1. 打开 C 工程，等待后台符号索引完成（可在状态栏/输出面板 `Source Insight` 查看）；
2. 按 `Ctrl+Alt+I` 打开底部面板；
3. 把光标放到函数、宏、变量、结构体成员或 `p->field` 上，面板自动分析；
4. 需要全工程搜索时点击面板右上角「搜索」。

## 快捷键

| 命令 | 快捷键 |
| --- | --- |
| 打开 / 聚焦 Context / Relation 面板 | `Ctrl+Alt+I` |
| 切换光标跟随 | `Ctrl+Alt+F` |
| 重新分析当前符号 | 面板刷新按钮 |
| 工程搜索（正则） | 面板搜索按钮 / 命令面板 |
| 重建 C 符号索引 | 命令面板 |

## 关系示例

```text
[定义] ──┬── [声明]            ← 函数原型 / extern 变量 / struct 前置声明
         ├── [调用者 A] ── [调用者 A 的调用者]
         ├── [调用者 B]
         └── ...

[结构体 ST] ──┬── [成员 state]
              ├── [变量实例 g_value      (值实例)]
              ├── [变量实例 gp_ptr       (指针实例)]
              └── [类型别名 ST_Handle]

[变量 gp_ptr] ──┬── [state  (指针访问 · 结构体成员)]  Line 12 写
                └── [count  (指针访问 · 结构体成员)]  Line 18 读
```

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `sourceInsight.enableProjectIndex` | `true` | 启用插件自带的 C/汇编符号索引 |
| `sourceInsight.indexOnStartup` | `true` | 打开工程后自动后台建立索引 |
| `sourceInsight.maxIndexFileSize` | `2097152` | 跳过超过该字节数的文件 |
| `sourceInsight.followCursor` | `true` | 面板可见时跟随编辑器光标 |
| `sourceInsight.trackingMode` | `symbol` | `symbol` 跟踪符号，`enclosing` 跟踪所在函数，`off` 关闭 |
| `sourceInsight.autoReveal` | `false` | 光标变化时自动打开面板 |
| `sourceInsight.contextLines` | `12` | 变量上下文行数 |
| `sourceInsight.contextLineNumbers` | `true` | Context 显示行号 |
| `sourceInsight.maxContextLines` | `600` | Context 最多渲染行数 |
| `sourceInsight.maxReferences` | `300` | 每个符号最多查询的引用/调用点 |
| `sourceInsight.maxRelationNodes` | `500` | 关系树节点上限 |
| `sourceInsight.defaultDepth` | `1` | 新 Relation 默认层级（1–6） |
| `sourceInsight.debounceMs` | `280` | 跟随刷新防抖 |
| `sourceInsight.providerTimeoutMs` | `15000` | 语言服务查询超时（索引回退时使用） |
| `sourceInsight.excludeMacros` | `false` | 调用图排除 C 函数式宏 |
| `sourceInsight.excludedSymbols` | `[]` | 不展开的函数/符号名 |
| `sourceInsight.expandDuplicateBranches` | `false` | 自动展开重复分支 |
| `sourceInsight.showLocations` | `false` | 节点显示文件/行号列 |
| `sourceInsight.relationLineStyle` | `elbow` | `elbow` 折线、`curve` 曲线、`direct` 直线 |
| `sourceInsight.relationSpacing` | `40` | 图节点列间距 |
| `sourceInsight.relationArrows` | `true` | 连接线末端显示箭头 |
| `sourceInsight.relationNodeShadow` | `true` | 节点阴影 |
| `sourceInsight.sortReferencesByFile` | `true` | 引用按文件/行号排序 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `Source Insight: 打开上下文 / 关系窗口` | 打开面板并分析当前符号 |
| `Source Insight: 刷新当前符号` | 清除缓存并重新分析 |
| `Source Insight: 工程搜索（支持正则表达式）` | 全工程文本 / 正则搜索 |
| `Source Insight: 重建 C 符号索引` | 重建工程符号数据库 |
| `Source Insight: Relation 显示变量实例（值/指针）` | 结构体 / typedef 实例 |
| `Source Insight: Relation 显示成员访问（. / ->）` | 变量实际访问的字段 |
| `Source Insight: Relation 显示声明/定义` | 原型、extern、前置声明与定义 |
| `Source Insight: 跳转到当前符号定义` | 打开定义位置 |
| `Source Insight: 清空窗口` | 清空面板状态 |

## 已知边界

- 内置索引按声明级启发式解析 C（包含常见的宏、typedef、struct/union/enum、函数、全局变量、复杂声明），不做完整预处理/宏展开；`#if` 各分支会同时收录。
- 函数体内的局部变量仍交给语言服务处理；全局符号、宏、结构体和汇编标签优先使用内置索引。
- 汇编目前按标签和 `call/jmp/b/bl/...` 目标建立关系，不做指令级数据流分析。
- C++ 模板、命名空间和类继承仍以语言服务结果为准。
- 宏展开后的类型推导、宏参数级关系不在此版本范围内。

## 开发

```powershell
npm install
npm run check
npm test
npm run test:integration   # 虚拟文档 + 自定义 Provider 端到端测试
npm run test:cpp           # 本机 ms-vscode.cpptools 真实 C 工程 + 截图
npm run package
```

产物：`dist-vsix/source-insight-context-relation-2.1.0.vsix`。

## License

MIT
