import assert from 'node:assert/strict'
import { createWorkflowProvider, stripFrontmatter } from '../provider.js'

const store = {
  async list() {
    return [
      {
        name: 'deploy-model',
        title: '部署并验收模型',
        description: '从选卡到验收',
        whenToUse: '需要部署模型时',
        version: '1.0.0',
        steps: 2,
        dir: 'C:\\workflows\\deploy-model',
        skillPath: 'C:\\workflows\\deploy-model\\SKILL.md',
      },
    ]
  },
  async readSkill(name) {
    if (name !== 'deploy-model') return undefined
    return '---\nname: "deploy-model"\ndescription: "从选卡到验收"\n---\n\n# 部署并验收模型\n\n正文\n'
  },
}

const provider = createWorkflowProvider({ store })({ invalidate() {} })

assert.equal(provider.name, 'workflow-library')
const candidates = await provider.list()
assert.equal(candidates.length, 1)
assert.equal(candidates[0].name, 'deploy-model')
assert.equal(candidates[0].description, '从选卡到验收')
assert.equal(candidates[0].source, 'custom')
assert.equal(candidates[0].provider, 'workflow-library')
assert.equal(candidates[0].rank, 300)
assert.equal(candidates[0].invocation.modelInvocable, true)
assert.equal(candidates[0].resourceBase.kind, 'directory')
assert.equal(candidates[0].resourceBase.path, 'C:\\workflows\\deploy-model')

const full = await provider.get(candidates[0])
assert.equal(full.content, '# 部署并验收模型\n\n正文\n')
assert.equal(await provider.get({ name: 'missing' }), undefined)

assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter')
assert.equal(stripFrontmatter('---\nname: x\n---\nbody'), 'body')

console.log('provider.test.mjs: ok')
