/**
 * Skill provider for the workflow library.
 *
 * Each saved workflow folder becomes a native DSH skill: the catalog carries
 * its name, description, and when-to-use line, and the full SKILL.md body is
 * loaded only when the model asks for it. Discovery reads the directory on
 * every lookup, so a freshly saved workflow appears on the next model step
 * without a watcher or a restart.
 */

const PROVIDER_NAME = 'workflow-library'
const PROVIDER_RANK = 300

/**
 * @param {{ store: ReturnType<import('./store.js').createStore> }} deps
 * @returns {(control: { invalidate: () => void }) => object} skill provider factory
 */
export function createWorkflowProvider({ store }) {
  return (control) => ({
    name: PROVIDER_NAME,
    async list() {
      try {
        const entries = await store.list()
        return entries.map((entry) => ({
          name: entry.name,
          description: entry.description.length > 0 ? entry.description : entry.title,
          whenToUse: entry.whenToUse.length > 0 ? entry.whenToUse : undefined,
          path: entry.skillPath,
          source: 'custom',
          provider: PROVIDER_NAME,
          rank: PROVIDER_RANK,
          locator: { name: entry.name },
          invocation: { modelInvocable: true, userInvocable: true },
          resourceBase: { kind: 'directory', path: entry.dir },
          metadata: {
            title: entry.title,
            version: entry.version,
            steps: entry.steps,
          },
        }))
      } catch {
        // An unreadable root is an incomplete observation, not an empty library:
        // the registry keeps the last good catalog and retries later.
        return { candidates: [], complete: false }
      }
    },
    async get(candidate) {
      const content = await store.readSkill(candidate.name)
      if (content === undefined) return undefined
      return { ...candidate, content: stripFrontmatter(content) }
    },
  })
}

/** The catalog already carries the metadata; the body starts after the header. */
export function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  return content.slice(end + 4).replace(/^[\r\n]+/, '')
}

export const providerName = PROVIDER_NAME
