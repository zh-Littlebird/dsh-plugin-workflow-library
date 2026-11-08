/**
 * dsh-plugin-workflow-library — Host half.
 *
 * Turns a repeatable procedure into an asset:
 *   1. the model calls `workflow_save` once, replaying what actually happened;
 *   2. the plugin validates the draft, renders SKILL.md + workflow.json, and
 *      writes a new folder under the configured library root;
 *   3. the workflow is exposed through the native skill registry, so later
 *      sessions discover it in the catalog and load the body only on demand.
 *
 * The plugin never invents the summary itself: the tool schema is the
 * collection contract, and the model that did the work already holds the
 * context. No second model pass is involved.
 */

import Schema from '@deepseek-ai/schemastery'
import { createWorkflowProvider } from './provider.js'
import { assertRootAllowed, createStore, resolveRoot } from './store.js'
import { findProblems, normalizeDraft } from './workflow.js'

export const name = 'workflow-library'

/** Tools are mandatory; the skill registry is optional so saving still works. */
export const inject = ['tools']

export const Config = Schema.object({
  root: Schema.string()
    .default('')
    .description('工作流库根目录；留空使用 ~/.dsh/workflows（即 $DSH_HOME/workflows）。'),
  registerSkills: Schema.boolean()
    .default(true)
    .description('把工作流注册为技能，供模型在后续会话中发现与加载。'),
  autoIndex: Schema.boolean()
    .default(true)
    .description('每次保存后重建根目录下的 INDEX.md。'),
  onConflict: Schema.union([Schema.const('suffix'), Schema.const('replace')])
    .default('suffix')
    .description('同名工作流的默认处理方式：suffix 新建带后缀的文件夹；replace 覆盖并升版本。'),
  language: Schema.union([Schema.const('auto'), Schema.const('zh'), Schema.const('en')])
    .default('auto')
    .description('生成 SKILL.md 与索引正文的语言；auto 跟随工作流内容。'),
})

const TOOL_DESCRIPTION = [
  '把一个可重复使用的流程固化成工作流：先复盘本次会话真实做过的步骤，再在工作流库目录下新建文件夹，写出 SKILL.md（可被技能目录发现、下次按需加载）和 workflow.json（结构化记录），并刷新索引。',
  '仅在用户明确要求“固化/沉淀/保存成工作流/以后都按这个流程来”时调用；一次性任务、还没真正跑通的流程、或只是让你总结对话，都不要调用。',
  '调用前先做一次复盘：按时间顺序回放实际操作，保留确切的命令、路径、端口、模型名、参数和报错；把踩过的坑与修复写进 pitfalls；不要编造没有发生过的步骤。缺少关键信息（参数来源、成功判据）时先问用户，不要猜。',
  'name 用小写英文短横线（如 deploy-gpustack-model），title 可用中文；同名时默认新建带 -2 后缀的文件夹，传 overwrite=true 才覆盖。',
].join('\n\n')

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'action'],
  properties: {
    title: { type: 'string', description: '这一步做什么，短句。' },
    action: { type: 'string', description: '具体操作说明，能让没做过的人照着执行。' },
    how: { type: 'string', description: '确切的命令、工具调用或路径；多行用换行分隔。' },
    tools: { type: 'array', items: { type: 'string' }, description: '这一步用到的工具名。' },
    expect: { type: 'string', description: '通过标准：看到什么才算这一步成功。' },
    onFailure: { type: 'string', description: '失败时怎么处理。' },
  },
}

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'description', 'whenToUse', 'steps', 'validation'],
  properties: {
    name: {
      type: 'string',
      description: '工作流标识，同时是文件夹名和技能名：2-64 位小写字母、数字、短横线，如 deploy-gpustack-model。',
    },
    title: { type: 'string', description: '人类可读标题，可以中文，如「在 GPUStack 上部署并验收模型」。' },
    description: {
      type: 'string',
      description: '一句话说明这个工作流做什么（不超过 240 字），会进入技能目录。',
    },
    whenToUse: {
      type: 'string',
      description: '什么情况下该用它、什么情况下别用；写清触发条件，模型下次靠它判断是否加载。',
    },
    tags: { type: 'array', items: { type: 'string' }, description: '分类标签，如 gpustack、deploy。' },
    inputs: {
      type: 'array',
      description: '执行前需要用户提供或确认的参数。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
          example: { type: 'string' },
          default: { type: 'string' },
        },
      },
    },
    preconditions: {
      type: 'array',
      items: { type: 'string' },
      description: '环境、权限、依赖、前置文件等必须满足的条件。',
    },
    steps: {
      type: 'array',
      minItems: 2,
      description: '至少 2 步，按真实执行顺序排列。',
      items: STEP_SCHEMA,
    },
    validation: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: '怎么验收整个流程成功。',
    },
    pitfalls: {
      type: 'array',
      items: { type: 'string' },
      description: '本次实际踩过的坑与修复方式。',
    },
    artifacts: { type: 'array', items: { type: 'string' }, description: '产物：生成的文件、配置或命令输出。' },
    references: { type: 'array', items: { type: 'string' }, description: '相关链接、文档或文件路径。' },
    assets: {
      type: 'array',
      description: '可选的脚本或模板，写入工作流目录的 assets/ 下。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: '相对路径，如 scripts/setup.sh；不能包含 ..，单个文件不超过 64KB。' },
          content: { type: 'string', description: '文件全文。' },
        },
      },
    },
    notes: { type: 'string', description: '自由补充：背景、权衡、后续改进。' },
    overwrite: { type: 'boolean', description: '同名时是否覆盖已有文件夹并升版本；默认 false，新建带后缀的文件夹。' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'name', 'path', 'skillPath', 'indexPath', 'version', 'steps', 'replaced', 'skillRegistered', 'warnings'],
  properties: {
    ok: { type: 'boolean' },
    name: { type: 'string' },
    path: { type: 'string' },
    skillPath: { type: 'string' },
    indexPath: { type: 'string' },
    version: { type: 'string' },
    steps: { type: 'integer' },
    replaced: { type: 'boolean' },
    skillRegistered: { type: 'boolean' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

export function apply(ctx, config) {
  const options = {
    root: typeof config?.root === 'string' ? config.root : '',
    registerSkills: config?.registerSkills !== false,
    autoIndex: config?.autoIndex !== false,
    onConflict: config?.onConflict === 'replace' ? 'replace' : 'suffix',
    language: config?.language === 'zh' || config?.language === 'en' ? config.language : 'auto',
  }
  const store = createStore(options)

  let skillsService
  let invalidate = () => {}
  let providerActive = false

  if (options.registerSkills) {
    try {
      ctx.inject(['skills'], (inner) => {
        skillsService = inner.skills
        inner.effect(() => {
          try {
            return inner.skills.registerProvider((control) => {
              providerActive = true
              invalidate = () => {
                try {
                  control.invalidate()
                } catch {
                  // A disposed provider has nothing to invalidate.
                }
              }
              return createWorkflowProvider({ store })(control)
            })
          } catch (error) {
            ctx.logger?.warn?.(`workflow-library: 技能注册失败：${error instanceof Error ? error.message : String(error)}`)
            return () => {}
          }
        })
      })
    } catch (error) {
      ctx.logger?.warn?.(`workflow-library: 技能服务不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workflow_save',
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          const title = typeof args?.title === 'string' && args.title.length > 0 ? args.title : value.name
          const lines = [
            `已固化工作流「${title}」`,
            `  目录：${value.path}`,
            `  技能名：${value.name}（${value.skillRegistered ? '已注册，后续会话可自动发现' : '未注册为技能'}）`,
            `  步骤：${value.steps}，版本：${value.version}${value.replaced ? '（已覆盖）' : ''}`,
            `  索引：${value.indexPath}`,
          ]
          const warnings = Array.isArray(value.warnings) ? value.warnings.slice(0, 8) : []
          if (warnings.length > 0) {
            lines.push('  提示：')
            for (const warning of warnings) lines.push(`  - ${warning}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const normalized = normalizeDraft(args)
        const draft = normalized.draft
        const knownTools = collectToolNames(ctx, exec)
        const problems = findProblems(draft, { knownTools })
        if (problems.errors.length > 0) {
          throw new Error(`工作流未保存：\n- ${problems.errors.join('\n- ')}`)
        }
        const warnings = [...normalized.warnings, ...problems.warnings]

        if (skillsService !== undefined) {
          try {
            const existing = await skillsService.list()
            const clash = existing.find((skill) => skill.name === draft.name && skill.provider !== 'workflow-library')
            if (clash !== undefined) {
              warnings.push(`技能目录里已有同名技能「${draft.name}」（来源 ${clash.provider}），本工作流可能不会被优先加载`)
            }
          } catch {
            // Catalog inspection is best-effort.
          }
        }

        const saved = await store.save(draft, {
          overwrite: normalized.overwrite,
          source: sourceOf(exec),
          index: options.autoIndex,
        })
        if (saved.name !== draft.name) {
          warnings.push(`同名工作流已存在，本次保存为「${saved.name}」`)
        }
        invalidate()

        return {
          ok: true,
          name: saved.name,
          path: saved.dir,
          skillPath: saved.skillPath,
          indexPath: saved.indexPath,
          version: saved.version,
          steps: draft.steps.length,
          replaced: saved.replaced,
          skillRegistered: providerActive,
          warnings,
        }
      },
    }),
  )

  mountRoute(ctx, store, config, ctx.fiber?.entry, () => ({ skills: providerActive }))
}

function collectToolNames(ctx, exec) {
  const names = new Set()
  try {
    // Resolve the calling agent's admitted set: preset-scoped tools (read,
    // write, pwsh, …) are invisible from the plugin's global view.
    for (const definition of ctx.tools.definitions(exec?.agent, exec?.toolSet)) names.add(definition.name)
  } catch {
    // The registry is present but a scope error should not block saving.
  }
  return names
}

function sourceOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  return {
    sessionId: typeof agent?.id === 'string' ? agent.id : null,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : safeCwd(),
    capturedAt: new Date().toISOString(),
  }
}

function safeCwd() {
  try {
    return process.cwd()
  } catch {
    return null
  }
}

function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Browser-facing read-only listing for the settings page. The page writes
 * configuration through the shared settings form, so this route only reads.
 */
function mountRoute(ctx, store, config, entry, status) {
  const route = {
    kind: 'prefix',
    path: '/workflow-library',
    handler: (req, res) => handleRoute(req, res, store, ctx, config, entry, status),
  }
  const attach = (scope) => {
    const webServer = optionalService(scope, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    scope.effect(() => webServer.register(route))
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => attach(inner))
      return
    }
  } catch {
    // Fall through to the direct read for older contexts.
  }
  attach(ctx)
}

async function handleRoute(req, res, store, ctx, config, entry, status) {
  try {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/workflow-library/, '').replace(/\/+$/, '') || '/'
    const picker = optionalService(ctx, 'directoryPickerController')
    const pickerReady = picker !== undefined && typeof picker.pick === 'function'
    const editor = optionalService(ctx, 'configEditor')
    const editable = entry !== undefined && editor !== undefined && typeof editor.edit === 'function'

    if (req.method === 'GET' && (sub === '/' || sub === '/list')) {
      const summary = await store.summary()
      sendJson(res, 200, summary)
      return
    }
    if (req.method === 'GET' && sub === '/capabilities') {
      sendJson(res, 200, { root: store.root, picker: pickerReady, ...status() })
      return
    }
    if (req.method === 'GET' && sub === '/config') {
      sendJson(res, 200, {
        values: readConfigValues(config),
        effectiveRoot: store.root,
        editable,
        picker: pickerReady,
        ...status(),
      })
      return
    }
    if (req.method === 'POST' && sub === '/config') {
      if (!hasUiWriteHeader(req)) {
        sendJson(res, 403, { error: 'missing-ui-header' })
        return
      }
      if (!editable) {
        sendJson(res, 409, { error: 'not-editable', message: '当前 profile 不支持从界面写配置（缺少 configEditor 或 profile 行）' })
        return
      }
      const body = await readJsonBody(req, 8192)
      const patch = validateConfigPatch(body)
      const nextValues = { ...readConfigValues(config), ...patch }
      await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }))
      sendJson(res, 200, { ok: true, values: nextValues, restarting: true })
      return
    }
    if (req.method === 'POST' && sub === '/pick') {
      if (!hasUiWriteHeader(req)) {
        sendJson(res, 403, { error: 'missing-ui-header' })
        return
      }
      if (!pickerReady) {
        sendJson(res, 501, { error: 'picker-unavailable' })
        return
      }
      const picked = await picker.pick(new AbortController().signal)
      sendJson(res, 200, { path: typeof picked === 'string' ? picked : null })
      return
    }
    sendJson(res, 404, { error: 'not-found' })
  } catch (error) {
    try {
      sendJson(res, 400, { error: 'bad-request', message: error instanceof Error ? error.message : String(error) })
    } catch {
      // The socket may already be gone.
    }
  }
}

/** Read a Config value that may be a volatile reference or a plain value. */
function readRef(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined ? fallback : current
  }
  return value === undefined ? fallback : value
}

function readConfigValues(config) {
  const root = readRef(config?.root, '')
  const onConflict = readRef(config?.onConflict, 'suffix')
  const language = readRef(config?.language, 'auto')
  return {
    root: typeof root === 'string' ? root : '',
    registerSkills: readRef(config?.registerSkills, true) !== false,
    autoIndex: readRef(config?.autoIndex, true) !== false,
    onConflict: onConflict === 'replace' ? 'replace' : 'suffix',
    language: language === 'zh' || language === 'en' ? language : 'auto',
  }
}

function validateConfigPatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象')
  const patch = {}
  if ('root' in body) {
    if (typeof body.root !== 'string') throw new Error('root 必须是字符串')
    const raw = body.root.trim()
    if (raw.length > 400) throw new Error('root 过长')
    if (/[\r\n\u0000]/.test(raw)) throw new Error('root 不能包含换行或空字符')
    assertRootAllowed(resolveRoot(raw))
    patch.root = raw
  }
  for (const key of ['registerSkills', 'autoIndex']) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
      patch[key] = body[key]
    }
  }
  if ('onConflict' in body) {
    if (body.onConflict !== 'suffix' && body.onConflict !== 'replace') {
      throw new Error('onConflict 只能是 suffix 或 replace')
    }
    patch.onConflict = body.onConflict
  }
  if ('language' in body) {
    if (body.language !== 'auto' && body.language !== 'zh' && body.language !== 'en') {
      throw new Error('language 只能是 auto、zh 或 en')
    }
    patch.language = body.language
  }
  if (Object.keys(patch).length === 0) throw new Error('没有可保存的字段')
  return patch
}

async function readJsonBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

function hasUiWriteHeader(req) {
  const header = req.headers['x-workflow-library-ui']
  return Array.isArray(header) ? header[0] === '1' : header === '1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress ?? undefined)
}

export { resolveRoot }
