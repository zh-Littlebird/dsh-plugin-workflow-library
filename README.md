# dsh-plugin-workflow-library

把可重复的流程固化成可复用资产：对模型说一句「把这个流程固化一下」，它会在你配置的目录里新建一个工作流文件夹；后续会话里，这个工作流会作为技能自动出现在目录中，按需加载。

## 用法

1. 装好后打开 **设置 → 工作流库**，确认根目录（默认 `~/.dsh/workflows`）。
2. 在任意会话里把一件事跑通，然后说「把这个流程固化成工作流」。
3. 模型调用 `workflow_save`，生成：

```
<root>/
  INDEX.md
  deploy-model/
    SKILL.md          # 模型读：何时使用 / 输入 / 步骤 / 验收 / 常见坑
    workflow.json     # 结构化记录：步骤、参数、来源会话、版本
    assets/           # 可选：脚本与模板
```

4. 下个会话直接说「按上次部署模型那套来」，模型从技能目录加载 `SKILL.md` 后照做。

## 工作流格式

`workflow.json` 是权威记录，`SKILL.md` 由它渲染，因此创建时不会出现两份内容不一致。`SKILL.md` 的 frontmatter（`name` / `description` / `whenToUse` / `metadata`）与 `@deepseek-ai/dsh-skill-filesystem` 兼容：将来想脱离本插件，把 `customSkillDirs` 指向这个目录即可。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `''` → `~/.dsh/workflows` | 工作流库根目录 |
| `registerSkills` | `true` | 注册为技能，供模型发现 |
| `autoIndex` | `true` | 每次保存后重建 `INDEX.md` |
| `onConflict` | `suffix` | 同名时新建 `-2` 文件夹，或 `replace` 覆盖升版本 |
| `language` | `auto` | 生成正文语言：`auto` / `zh` / `en` |

## 安全边界

- 保存前扫描常见密钥形态（`sk-…`、`ghp_…`、私钥、Bearer、URL 内嵌口令），命中即拒绝，要求改成 `<REDACTED>`。
- `assets` 只接受相对路径，拒绝 `..`、绝对路径与盘符；单文件 64KB，总量 256KB。
- 根目录不能是磁盘根或系统目录；实际写入前做可写探测。
- 工作流只写进配置的库目录，不会碰工作区里的其它文件。

## 开发

```
pnpm install
node test/workflow.test.mjs
node test/store.test.mjs
```

安装：在 Harness 里用 `plugin_manager` 的 `install_bundle`，`target` 指向本目录。
