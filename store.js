/**
 * Filesystem store for the workflow library.
 *
 * The store owns exactly four kinds of writes:
 *   - a new workflow directory (staged under a temp name, then renamed in)
 *   - SKILL.md and workflow.json replacement in an existing directory
 *   - assets under <workflow>/assets
 *   - the generated INDEX.md at the root
 *
 * `workflow.json` is authoritative; a directory without one is still listed
 * when its SKILL.md carries valid frontmatter, so hand-authored skills remain
 * visible.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NAME_PATTERN, bumpVersion, renderIndex, renderSkill, safeAssetPath } from './workflow.js'

const SKILL_FILE = 'SKILL.md'
const RECORD_FILE = 'workflow.json'
const INDEX_FILE = 'INDEX.md'

/**
 * Resolve the configured root, or the global default under the DSH home.
 * Supports `~`, `%VAR%`, and `$DSH_HOME`.
 * @param {string | undefined} configured
 * @returns {string} absolute path
 */
export function resolveRoot(configured) {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw.length > 0) return path.resolve(expandPath(raw))
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  return path.join(home, 'workflows')
}

function expandPath(value) {
  let expanded = value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match)
  if (expanded === '~') return os.homedir()
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return path.join(os.homedir(), expanded.slice(2))
  return expanded
}

function denyList() {
  if (process.platform === 'win32') {
    return ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\system volume information']
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev']
}

/**
 * Reject roots that would scatter workflow folders through the OS or use an
 * entire volume as the library.
 * @param {string} root resolved absolute root
 */
export function assertRootAllowed(root) {
  const parsed = path.parse(root)
  if (root === parsed.root) throw new Error(`工作流目录不能是磁盘根目录：${root}`)
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root
  for (const denied of denyList()) {
    const prefix = process.platform === 'win32' ? denied : denied
    if (normalized === prefix || normalized.startsWith(`${prefix}${path.sep}`) || normalized.startsWith(`${prefix}/`)) {
      throw new Error(`工作流目录不能放在系统目录下：${root}`)
    }
  }
}

async function directoryExists(target) {
  try {
    const items = await readdir(target)
    return Array.isArray(items)
  } catch {
    return false
  }
}

async function writeAtomic(target, content) {
  const temporary = `${target}.tmp-${randomUUID()}`
  await writeFile(temporary, content, 'utf8')
  await rm(target, { force: true })
  await rename(temporary, target)
}

function parseFrontmatter(content) {
  if (typeof content !== 'string' || !content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  if (end < 0) return null
  const header = content.slice(3, end).replace(/\r\n/g, '\n')
  const fields = {}
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      try {
        value = JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"` : value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith('[')) {
      try {
        value = JSON.parse(value.replace(/'/g, '"'))
      } catch {
        value = []
      }
    }
    fields[key] = value
  }
  return fields
}

async function readSkillEntry(dir) {
  const skillPath = path.join(dir, SKILL_FILE)
  let content
  try {
    content = await readFile(skillPath, 'utf8')
  } catch {
    return null
  }
  const fields = parseFrontmatter(content)
  if (fields === null) return null
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (!NAME_PATTERN.test(name) || description.length === 0) return null
  return {
    name,
    title: typeof fields.title === 'string' && fields.title.length > 0 ? fields.title : name,
    description,
    whenToUse: typeof fields.whenToUse === 'string' ? fields.whenToUse : '',
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    version: typeof fields.version === 'string' ? fields.version : '',
    steps: 0,
    createdAt: null,
    updatedAt: null,
    dir,
    skillPath,
    record: null,
  }
}

async function readEntry(dir) {
  const recordPath = path.join(dir, RECORD_FILE)
  let raw
  try {
    raw = await readFile(recordPath, 'utf8')
  } catch {
    return readSkillEntry(dir)
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return readSkillEntry(dir)
  }
  if (record === null || typeof record !== 'object') return readSkillEntry(dir)
  const name = typeof record.name === 'string' ? record.name : path.basename(dir)
  if (!NAME_PATTERN.test(name)) return readSkillEntry(dir)
  return {
    name,
    title: typeof record.title === 'string' && record.title.length > 0 ? record.title : name,
    description: typeof record.description === 'string' ? record.description : '',
    whenToUse: typeof record.whenToUse === 'string' ? record.whenToUse : '',
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    version: typeof record.version === 'string' ? record.version : '',
    steps: Array.isArray(record.steps) ? record.steps.length : 0,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    dir,
    skillPath: path.join(dir, SKILL_FILE),
    record,
  }
}

/**
 * Create the store bound to one resolved root.
 * @param {{ root?: string, onConflict?: 'suffix'|'replace', autoIndex?: boolean, language?: 'auto'|'zh'|'en' }} options
 */
export function createStore(options = {}) {
  const root = resolveRoot(options.root)
  const onConflict = options.onConflict === 'replace' ? 'replace' : 'suffix'
  const autoIndex = options.autoIndex !== false
  const language = options.language === 'zh' || options.language === 'en' ? options.language : 'auto'

  async function ensureRoot() {
    assertRootAllowed(root)
    await mkdir(root, { recursive: true })
    const probe = path.join(root, `.write-probe-${randomUUID()}`)
    try {
      await writeFile(probe, '', 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`工作流目录不可写：${root}（${reason}）`)
    } finally {
      await rm(probe, { force: true })
    }
  }

  async function list() {
    let dirents
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return []
      throw error
    }
    const entries = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name.startsWith('~')) continue
      const entry = await readEntry(path.join(root, dirent.name))
      if (entry !== null) entries.push(entry)
    }
    entries.sort((left, right) => {
      const byDate = String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      return byDate !== 0 ? byDate : left.name.localeCompare(right.name)
    })
    return entries
  }

  async function nextFreeName(base) {
    let index = 2
    while (index < 1000) {
      const candidate = `${base}-${index}`
      if (!(await directoryExists(path.join(root, candidate)))) return candidate
      index += 1
    }
    throw new Error(`同名工作流过多，无法为「${base}」生成新目录`)
  }

  async function writeAssets(targetDir, assets) {
    for (const asset of assets) {
      const relative = safeAssetPath(asset.path)
      const target = path.join(targetDir, 'assets', ...relative.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, asset.content, 'utf8')
    }
  }

  /**
   * Persist one workflow.
   * @param {object} draft normalized draft
   * @param {{ overwrite?: boolean, source?: object|null, index?: boolean }} saveOptions
   */
  async function save(draft, saveOptions = {}) {
    if (!NAME_PATTERN.test(draft.name)) throw new Error(`工作流名不合法：${draft.name}`)
    await ensureRoot()

    const base = draft.name
    let finalName = base
    let dir = path.join(root, finalName)
    let replaced = false
    let previous = null

    if (await directoryExists(dir)) {
      if (saveOptions.overwrite === true || onConflict === 'replace') {
        replaced = true
        previous = await readEntry(dir)
      } else {
        finalName = await nextFreeName(base)
        dir = path.join(root, finalName)
      }
    }

    const updatedAt = new Date().toISOString()
    const version = previous !== null && previous.record !== null ? bumpVersion(previous.record.version) : '1.0.0'
    const record = {
      schemaVersion: 1,
      name: finalName,
      title: draft.title,
      description: draft.description,
      whenToUse: draft.whenToUse,
      tags: draft.tags,
      version,
      createdAt: previous?.record?.createdAt ?? updatedAt,
      updatedAt,
      source: saveOptions.source ?? null,
      inputs: draft.inputs,
      preconditions: draft.preconditions,
      steps: draft.steps,
      validation: draft.validation,
      pitfalls: draft.pitfalls,
      artifacts: draft.artifacts,
      references: draft.references,
      notes: draft.notes,
    }
    const skill = renderSkill({ ...draft, name: finalName }, { version, updatedAt, language })
    const files = [
      [SKILL_FILE, skill],
      [RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`],
    ]

    if (replaced) {
      await mkdir(dir, { recursive: true })
      for (const [name, content] of files) await writeAtomic(path.join(dir, name), content)
      await writeAssets(dir, draft.assets)
    } else {
      const staging = path.join(root, `.tmp-${randomUUID()}`)
      await mkdir(staging, { recursive: true })
      try {
        for (const [name, content] of files) await writeFile(path.join(staging, name), content, 'utf8')
        await writeAssets(staging, draft.assets)
        await rename(staging, dir)
      } catch (error) {
        await rm(staging, { recursive: true, force: true })
        throw error
      }
    }

    const indexPath = path.join(root, INDEX_FILE)
    if (saveOptions.index !== false && autoIndex) {
      const entries = await list()
      await writeAtomic(indexPath, renderIndex(entries, { root, language }))
    }

    const entry = await readEntry(dir)
    return {
      dir,
      name: finalName,
      version,
      replaced,
      entry,
      skillPath: path.join(dir, SKILL_FILE),
      indexPath,
    }
  }

  /** Rebuild INDEX.md from the current directory contents. */
  async function rebuildIndex() {
    await ensureRoot()
    const entries = await list()
    const indexPath = path.join(root, INDEX_FILE)
    await writeAtomic(indexPath, renderIndex(entries, { root, language }))
    return { indexPath, count: entries.length }
  }

  /** Load one SKILL.md body by workflow name. */
  async function readSkill(name) {
    const candidate = String(name ?? '')
    if (!NAME_PATTERN.test(candidate)) return undefined
    try {
      return await readFile(path.join(root, candidate, SKILL_FILE), 'utf8')
    } catch {
      return undefined
    }
  }

  /** Load one structured record by workflow name. */
  async function readRecord(name) {
    const candidate = String(name ?? '')
    if (!NAME_PATTERN.test(candidate)) return undefined
    return readEntry(path.join(root, candidate))
  }

  /** Compact view for the settings page. */
  async function summary() {
    const entries = await list()
    return {
      root,
      count: entries.length,
      indexPath: path.join(root, INDEX_FILE),
      entries: entries.map((entry) => ({
        name: entry.name,
        title: entry.title,
        description: entry.description,
        whenToUse: entry.whenToUse,
        steps: entry.steps,
        version: entry.version,
        updatedAt: entry.updatedAt,
      })),
    }
  }

  return { root, ensureRoot, list, save, rebuildIndex, readSkill, readRecord, summary }
}
