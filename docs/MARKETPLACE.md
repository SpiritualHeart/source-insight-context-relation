# 发布到 VS Code Marketplace

本扩展**可以**发布到 VS Code Marketplace。发布后，用户可以在 VS Code 扩展市场搜索安装，后续版本也会通过 Marketplace 自动更新。

发布本身需要你的 Microsoft/Azure 账号和 Marketplace publisher 权限，这些凭据不能由我替你创建或保存。下面是本项目的发布步骤。

---

## 1. 准备账号

1. 使用 Microsoft 账号登录：
   - <https://marketplace.visualstudio.com/manage>
2. 创建 **Publisher**。
3. Publisher ID 建议使用：

   ```text
   onepiece-tools
   ```

   如果该 ID 已被占用，改成你自己的唯一 ID，并同步修改 `package.json`：

   ```json
   {
     "publisher": "你的 publisher id"
   }
   ```

> Publisher ID 一旦发布，扩展 ID 就固定为 `publisher.name`，后续不要随意改。

---

## 2. 创建 Azure DevOps PAT

1. 登录 <https://dev.azure.com/>；
2. 右上角 **User settings → Personal access tokens → New Token**；
3. Scopes 选择 **Marketplace → Manage**；
4. 设置有效期并复制 token。

不要把 token 写进 `package.json`、README 或提交到 Git。

在当前终端临时设置：

```powershell
$env:VSCE_PAT = "你的 PAT"
```

关闭终端后即失效。

---

## 3. 登录发布者

```powershell
npx vsce login onepiece-tools
```

按提示粘贴 PAT。也可以跳过 login，直接使用环境变量发布。

---

## 4. 发布当前版本

先确认版本号和包内容：

```powershell
npm run check
npm run test
npm run package
```

然后发布：

```powershell
npx vsce publish --packagePath "dist-vsix/source-insight-context-relation-2.0.3.vsix" --allow-missing-repository
```

也可以使用项目脚本：

```powershell
npm run publish:marketplace
```

该脚本会执行检查、测试，再调用 `vsce publish`。

> 当前项目没有配置 Git 仓库地址，因此使用 `--allow-missing-repository`。  
> 如果以后绑定 GitHub，建议在 `package.json` 增加 `repository`，Marketplace 页面会显示源码链接。

---

## 5. 后续更新

每次发布新版本：

1. 修改代码；
2. 更新 `CHANGELOG.md`；
3. 提升版本号：

   ```powershell
   npm version patch --no-git-tag-version
   ```

   或手动修改 `package.json` 的 `version`。

4. 重新检查、测试、打包：

   ```powershell
   npm run check
   npm run test
   npm run package
   ```

5. 发布：

   ```powershell
   npx vsce publish --packagePath "dist-vsix/source-insight-context-relation-<版本号>.vsix" --allow-missing-repository
   ```

6. Marketplace 审核/索引完成后，已安装用户会在 VS Code 中收到更新。

> 同一个版本号不能重复发布。发布前务必确认 `version` 已增加。

---

## 6. 预发布版本（可选）

如果想先发测试版：

```powershell
npx vsce publish --pre-release --allow-missing-repository
```

预发布版会显示为 Pre-release，普通用户不会默认收到。

---

## 7. Marketplace 页面注意事项

- **扩展详情页不能内嵌 VSIX 内的本地图片或 data URI**。当前 README 不放本地截图，避免出现坏图标。
- `README.md` 会作为 Marketplace 详情页正文。
- `CHANGELOG.md` 会显示更新记录。
- `LICENSE`、`icon.png`、`README.md` 已包含在 VSIX 中。
- `docs/USER_GUIDE.md` 也会随 VSIX 打包，用户安装后可运行 **Source Insight: 打开使用说明**。

---

## 8. 当前环境说明

本机测试环境访问 `marketplace.visualstudio.com` 时出现过 TLS/网络错误，因此**实际发布建议在你自己的网络环境中执行**，或者先确保：

```powershell
npx vsce login onepiece-tools
```

能够正常连通。

发布者账号、PAT、双重验证和 Marketplace 协议需要你本人确认；不要把 PAT 发到聊天中。

---

## 9. 发布后验证

```powershell
npx vsce show onepiece-tools.source-insight-context-relation
```

或在浏览器打开：

```text
https://marketplace.visualstudio.com/items?itemName=onepiece-tools.source-insight-context-relation
```

确认：

- 版本号正确；
- README 没有坏图片；
- 图标、许可证、分类正确；
- 安装后 `Ctrl+Alt+I` 能打开面板；
- 光标跟随、右键关系菜单、层级调节正常。
