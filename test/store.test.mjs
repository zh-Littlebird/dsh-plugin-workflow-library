import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../store.js'
import { normalizeDraft } from '../workflow.js'

function draft(overrides = {}) {
  return normalizeDraft({
    name: 'deploy-model',
    title: '部署并验收模型',
    description: '从选卡到推理验收的完整流程',
    whenToUse: '需要在集群新建模型部署时',
    steps: [
      { title: '检查余量', action: '盘点 worker 与 GPU', expect: '显存够用' },
      { title: '创建部署', action: '提交模型部署并等待 running', expect: 'state=running' },
    ],
    validation: ['推理接口返回 200'],
    assets: [{ path: 'scripts/check.sh', content: '#!/bin/sh\necho ok\n' }],
    ...overrides,
  }).draft
}

const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-library-test-'))
const store = createStore({ root, onConflict: 'suffix', autoIndex: true, language: 'zh' })

try {
  const first = await store.save(draft(), { source: { sessionId: 'session-test' } })
  assert.equal(first.name, 'deploy-model')
  assert.equal(first.replaced, false)
  assert.equal(first.version, '1.0.0')

  const skill = await readFile(path.join(first.dir, 'SKILL.md'), 'utf8')
  assert.ok(skill.includes('name: "deploy-model"'))
  const record = JSON.parse(await readFile(path.join(first.dir, 'workflow.json'), 'utf8'))
  assert.equal(record.name, 'deploy-model')
  assert.equal(record.steps.length, 2)
  assert.equal(record.source.sessionId, 'session-test')
  assert.equal(record.createdAt, record.updatedAt)
  assert.ok((await stat(path.join(first.dir, 'assets', 'scripts', 'check.sh'))).isFile())

  const index = await readFile(path.join(root, 'INDEX.md'), 'utf8')
  assert.ok(index.includes('deploy-model'))
  assert.ok(index.includes('数量：1'))

  // Same name, suffix policy: a new folder and a new skill name.
  const second = await store.save(draft(), {})
  assert.equal(second.name, 'deploy-model-2')
  assert.equal(second.replaced, false)
  assert.equal((await store.list()).length, 2)

  // Replacement keeps createdAt and bumps the patch version.
  const replaced = await store.save(draft({ description: '更新后的描述' }), { overwrite: true })
  assert.equal(replaced.name, 'deploy-model')
  assert.equal(replaced.replaced, true)
  assert.equal(replaced.version, '1.0.1')
  const replacedRecord = JSON.parse(await readFile(path.join(replaced.dir, 'workflow.json'), 'utf8'))
  assert.equal(replacedRecord.createdAt, record.createdAt)
  assert.equal(replacedRecord.description, '更新后的描述')

  const summary = await store.summary()
  assert.equal(summary.count, 2)
  assert.ok(summary.entries.some((entry) => entry.name === 'deploy-model-2'))

  const content = await store.readSkill('deploy-model')
  assert.ok(content !== undefined && content.includes('## 步骤'))
  assert.equal(await store.readSkill('../etc'), undefined)

  console.log('store.test.mjs: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
