import assert from 'node:assert/strict'
import {
  bumpVersion,
  findProblems,
  normalizeDraft,
  renderIndex,
  renderSkill,
  safeAssetPath,
  scanSecrets,
} from '../workflow.js'

const knownTools = new Set(['workflow_save', 'pwsh', 'read'])

function draft(overrides = {}) {
  return normalizeDraft({
    name: 'deploy-model',
    title: '部署并验收模型',
    description: '从选卡到推理验收的完整流程',
    whenToUse: '需要在集群新建模型部署时',
    steps: [
      { title: '检查余量', action: '盘点 worker 与 GPU', how: 'inventory --kind gpus', tools: ['read'], expect: '显存够用' },
      { title: '创建部署', action: '提交模型部署并等待 running', expect: 'state=running' },
    ],
    validation: ['推理接口返回 200'],
    pitfalls: ['backendParameters 必须逐 token 传数组'],
    ...overrides,
  }).draft
}

// --- name and structure ----------------------------------------------------
{
  const result = findProblems(draft(), { knownTools })
  assert.deepEqual(result.errors, [])
}

{
  const result = findProblems(draft({ name: 'Bad_Name' }), { knownTools })
  assert.ok(result.errors.some((error) => error.includes('name')))
}

{
  const result = findProblems(draft({ name: 'index' }), { knownTools })
  assert.ok(result.errors.some((error) => error.includes('保留名')))
}

{
  const result = findProblems(draft({ steps: [{ title: '只有一步', action: '做点什么' }] }), { knownTools })
  assert.ok(result.errors.some((error) => error.includes('至少 2 步')))
}

{
  const result = findProblems(draft({ validation: [] }), { knownTools })
  assert.ok(result.errors.some((error) => error.includes('validation')))
}

{
  const result = findProblems(draft({ steps: [{ title: 'a', action: 'b', tools: ['unknown_tool'] }, { title: 'c', action: 'd' }] }), {
    knownTools,
  })
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.some((warning) => warning.includes('unknown_tool')))
}

// --- secrets ---------------------------------------------------------------
{
  const problems = scanSecrets(draft({ notes: '用 sk-abcdefghijklmnopqrstuvwxyz 调用' }))
  assert.ok(problems.some((problem) => problem.label.includes('密钥')))

  const result = findProblems(draft({ notes: 'token 是 sk-abcdefghijklmnopqrstuvwxyz' }), { knownTools })
  assert.ok(result.errors.some((error) => error.includes('REDACTED')))
}

{
  const ok = findProblems(draft({ notes: '请求头用 Bearer <REDACTED>' }), { knownTools })
  assert.deepEqual(ok.errors, [])
}

{
  // Environment references are not credentials.
  const env = findProblems(draft({ notes: 'api_key = process.env.API_KEY；token: $env:TOKEN' }), { knownTools })
  assert.deepEqual(env.errors, [])
}

{
  const url = findProblems(draft({ references: ['https://user:pass@example.com/x'] }), { knownTools })
  assert.ok(url.errors.some((error) => error.includes('账号密码')))
}

// --- assets ----------------------------------------------------------------
{
  assert.equal(safeAssetPath('scripts/setup.sh'), 'scripts/setup.sh')
  assert.throws(() => safeAssetPath('../escape.sh'))
  assert.throws(() => safeAssetPath('/abs.sh'))
  assert.throws(() => safeAssetPath('C:\\abs.sh'))

  const result = findProblems(
    draft({ assets: [{ path: '../escape.sh', content: 'echo hi' }] }),
    { knownTools },
  )
  assert.ok(result.errors.length > 0)
}

// --- rendering -------------------------------------------------------------
{
  const skill = renderSkill(draft(), { version: '1.0.0', updatedAt: '2026-11-06T06:00:00.000Z' })
  assert.ok(skill.startsWith('---\nname: "deploy-model"'))
  assert.ok(skill.includes('whenToUse: "需要在集群新建模型部署时"'))
  assert.ok(skill.includes('## 何时使用'))
  assert.ok(skill.includes('### 1. 检查余量'))
  assert.ok(skill.includes('inventory --kind gpus'))
  assert.ok(skill.includes('## 验收'))
  assert.ok(skill.includes('### 2. 创建部署'))
}

{
  const english = renderSkill(
    normalizeDraft({
      name: 'deploy-model',
      title: 'Deploy a model',
      description: 'Deploy and verify',
      whenToUse: 'When a model must be deployed',
      steps: [{ title: 'Check capacity', action: 'Inspect GPUs' }, { title: 'Deploy', action: 'Submit' }],
      validation: ['Chat returns 200'],
    }).draft,
    { version: '1.0.0', updatedAt: '2026-11-06T06:00:00.000Z', language: 'en' },
  )
  assert.ok(english.includes('## When to use'))
  assert.ok(english.includes('## Validation'))
}

{
  const index = renderIndex(
    [
      { name: 'a', title: 'A | B', whenToUse: 'when x', steps: 2, updatedAt: '2026-11-06T06:00:00.000Z' },
      { name: 'b', title: 'C', whenToUse: 'when y', steps: 3, updatedAt: '2026-11-05T06:00:00.000Z' },
    ],
    { root: 'C:\\workflows', language: 'zh' },
  )
  assert.ok(index.includes('# 工作流库'))
  assert.ok(index.includes('A \\| B'))
  assert.ok(index.includes('./a/SKILL.md'))
}

// --- versions --------------------------------------------------------------
assert.equal(bumpVersion('1.0.0'), '1.0.1')
assert.equal(bumpVersion('2.3.9'), '2.3.10')
assert.equal(bumpVersion('nope'), '1.0.1')

console.log('workflow.test.mjs: ok')
