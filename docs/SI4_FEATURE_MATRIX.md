# Source Insight 4 Context / Relation 功能对齐清单

本清单依据本机 Source Insight 4.0 帮助文档（`sourceinsight.chm`）中的 Context Window / Relation Window / Multiple Relation Windows / Call Graphs / Graph Options / Relationship Rules 等章节整理，并标注本插件的实际状态。

> 状态说明：**已实现** = 有对应交互和端到端验证；**部分实现** = 有等价能力但不完全同形；**不适用** = VS Code 没有对应工程模型或通用 API。

## Context Window

| Source Insight 4 功能 | 本插件状态 | 说明 |
| --- | --- | --- |
| 自动跟踪光标下符号 | 已实现 | `sourceInsight.trackingMode = symbol` |
| 跟踪光标所在函数/类 | 已实现 | `trackingMode = enclosing` |
| 关闭自动跟踪 / 锁定窗口 | 已实现 | `trackingMode = off`；Context 独立锁定按钮 |
| 显示函数定义、变量声明 | 已实现 | 定义/声明切换；声明缺失时回退定义 |
| 多个同名定义时导航全部匹配 | 已实现 | Context 顶部 `‹ 1 / N ›` 匹配导航 |
| 变量基类型解码（struct/union/class/typedef） | 已实现 | 内置索引解析 typedef/struct 链；未收录时回退 Type Definition Provider |
| 在 Context 中预览 Relation 节点 | 已实现 | 单击 Relation 节点触发；Context 锁定时不更新 |
| 从文件列表/工程符号列表预览 | 不适用 | VS Code 的 Explorer / 符号列表无对应事件 API；由编辑器标签替代 |
| 锁定 Context | 已实现 | 面板锁按钮、命令 |
| 行号显示 / 等宽字体 / 主题颜色 / 缩放 | 已实现 | 行号可配置；字体/缩放/颜色跟随 VS Code |
| Context Window Options | 已实现常用项 | 跟踪方式、行数、行号、超时、锁 |
| 定义/声明/类型导航历史 | 已实现 | Context 后退/前进 |

## Relation Window

| Source Insight 4 功能 | 本插件状态 | 说明 |
| --- | --- | --- |
| 自动跟踪当前符号关系 | 已实现 | 与 Context 共用跟踪设置，Relation 可独立锁定 |
| References | 已实现 | 按引用者函数聚合，显示读/写/调用次数 |
| Calls（被当前函数调用） | 已实现 | `callees` 关系 |
| Callers（调用当前函数） | 已实现 | 函数默认关系 |
| Calls and Callers（双向） | 已实现 | 左侧调用者、右侧被调用 |
| Contains（结构/类成员） | 已实现 | 结构体/类/命名空间子符号 |
| Type of（变量类型） | 已实现 | 变量默认可选“类型”关系；结构体成员可继续展开 |
| Derived / Implementation | 已实现 | C 中显示为“类型别名”；C++ 依赖 Implementation Provider |
| 宏引用 / 函数式宏调用 | 已实现 | 内置索引识别 `#define` 对象宏与函数式宏 |
| 结构体值实例 / 指针实例 | 已实现 | `instances` 关系，节点标记值实例/指针实例 |
| 成员访问 `.` / `->` | 已实现 | `memberAccess` 关系，字段节点区分值访问/指针访问 |
| 声明与定义分离 | 已实现 | 原型 / extern / 前置声明与定义分别成节点 |
| 按符号类型选择默认关系 | 已实现 | 函数/汇编标签 Callers、宏 References、变量 References、结构/枚举 Contains、typedef 目标类型 |
| 自动展开 Levels 1–6 | 已实现 | 工具栏 `− / +`、`sourceInsight.defaultDepth` |
| 防止循环展开 | 已实现 | 祖先链检测，节点标“循环” |
| 重复分支展开/折叠 | 已实现 | `sourceInsight.expandDuplicateBranches` |
| Expand Special（指定层数） | 已实现 | 右键“展开 1/2/3 层” |
| 单节点展开/收起 | 已实现 | 箭头；更深节点按需加载 |
| 右键查看调用者 | 已实现 | 右键菜单“查看调用者” |
| 右键查看被调用 | 已实现 | 右键菜单“查看被调用” |
| 右键查看引用 / 类型 / 成员 / 派生 | 已实现 | 按节点类型显示不同菜单项 |
| 右键设为根节点 | 已实现 | 重新生成以该节点为根的树 |
| 双击节点跳转源码 | 已实现 | 也支持 Enter |
| 单击节点在 Context 预览 | 已实现 | Context 锁定时禁用 |
| Multiple Relation Windows | 已实现（标签页） | 每个标签独立关系类型、层级和树；Context 与锁全局共享 |
| Lock Relation Window | 已实现 | 锁定时光标跟随不替换当前图 |
| Refresh Relation Window | 已实现 | 清缓存并重查 |
| Generate Call Tree | 已实现 | 选择函数自动生成调用者树；任意节点可设为根 |
| 横向图 / 纵向图 | 已实现 | 工具栏布局按钮 |
| 轮廓（Outline） | 已实现 | 工具栏布局按钮 |
| Next Relation Window View | 已实现 | 命令循环三种布局 |
| 图布局、线型、箭头、间距、阴影 | 已实现 | `elbow/curve/direct`、`relationSpacing`、箭头、节点阴影 |
| 连接线颜色 / 主题自适应 | 已实现 | 使用 VS Code 图表色与主题变量 |
| Relationship Rules（按类型选关系） | 部分实现 | 内置默认规则；未提供任意规则脚本 |
| Show all references inside each function | 已实现 | 每个调用者节点显示引用/调用次数、读/写次数 |
| Show duplicate reference branches | 已实现 | 由 `expandDuplicateBranches` 控制 |
| Call Graph Filtering：排除符号 | 已实现 | `sourceInsight.excludedSymbols` |
| Call Graph Filtering：排除 C 宏 | 已实现 | `sourceInsight.excludeMacros` |
| Symbol Type Filter / 代码度量过滤 | 不完全适用 | VS Code Provider 不提供通用代码度量；符号类型由所选关系自然区分 |
| Columns：文件名 / 行号 | 已实现（默认隐藏） | `sourceInsight.showLocations`；按用户要求默认只显示符号名 |
| 排序 / 列头排序 | 部分实现 | 引用按文件/行号排序；无点击列头排序 |
| 右键菜单 | 已实现 | 关系类型、设根、预览、展开、打开、复制 |
| Create Bookmarks from Relation Items | 部分实现 | 提供“复制关系树为文本”；书签交给 VS Code 书签扩展 |
| Print Relation Window | 不适用 | 使用 VS Code/系统打印；未单独实现 |
| Touch All Files in Relation | 不适用 | VS Code 无 Source Insight 式工程文件时间戳管理 |

## 工程搜索

| Source Insight 4 功能 | 本插件状态 | 说明 |
| --- | --- | --- |
| Search Project（普通文本） | 已实现 | 顶部搜索按钮 / 命令 |
| 正则表达式搜索 | 已实现 | JavaScript RegExp；支持区分大小写 |
| 整词匹配 | 已实现 | 普通文本 + `\b` |
| 搜索结果文件/行树 | 已实现 | 结果显示在 Relation 窗口，双击跳转 |
| 搜索结果替换 | 暂未实现 | 可在 VS Code 全局替换中完成 |

## 与 Source Insight 的显示差异

Source Insight 的 Relation 列表可以显示文件、行号、代码片段和多种列。本插件按当前需求默认只显示**函数/变量/成员名称**，以保持图形树干净；需要文件位置时可在设置中打开 `sourceInsight.showLocations`。Context 顶部同样只显示符号名和类型，不显示文件路径。

## 依赖

C / 头文件 / 汇编文件的全局符号、宏、typedef、结构体成员、声明/定义、成员访问和工程搜索由插件自带索引解析，不要求安装语言服务。语言服务（`ms-vscode.cpptools` / clangd）用于补足函数内局部变量、C++ 模板/类继承等索引未覆盖的场景。
