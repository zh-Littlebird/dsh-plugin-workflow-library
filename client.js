/**
 * dsh-plugin-workflow-library — Web half.
 *
 * Settings → Workflow library: the library root, the generation switches, and
 * a read-only list of saved workflows.
 *
 * Configuration is written through the plugin's own loopback route, which asks
 * the Host config editor to persist the change. The shared settings form
 * (`configForms`) is not used on purpose: @deepseek-ai/dsh-settings exposes
 * only `.volatile()` fields there, and these fields need a plugin restart to
 * rebuild the store and the skill provider.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-workflow-library',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const API = '/workflow-library'
    const UI_HEADER = 'x-workflow-library-ui'
    const DEFAULTS = { root: '', registerSkills: true, autoIndex: true, onConflict: 'suffix', language: 'auto' }

    const COPY = {
      zh: {
        nav: '工作流库',
        title: '工作流库',
        subtitle:
          '把可重复的流程沉淀下来：对模型说一句「把这个流程固化一下」，它会在下面的目录里新建工作流；下次会话模型能自动发现并按需加载。',
        rootLabel: '工作流目录',
        rootHint: '留空则使用 ~/.dsh/workflows。保存后立即生效。',
        rootPlaceholder: '~/.dsh/workflows',
        choose: '选择目录',
        save: '保存目录',
        saving: '保存中…',
        saved: '已保存。',
        saveFailed: '保存失败，请重试。',
        settings: '生成设置',
        skillsLabel: '注册为技能',
        skillsHint: '开启后工作流进入技能目录，模型可在后续会话中发现；关闭则只归档文件。',
        indexLabel: '自动维护索引',
        indexHint: '每次保存后重建根目录下的 INDEX.md。',
        conflictLabel: '同名工作流',
        conflictSuffix: '新建带后缀的文件夹',
        conflictReplace: '覆盖并升版本',
        languageLabel: '生成语言',
        langAuto: '跟随内容',
        langZh: '中文',
        langEn: 'English',
        listTitle: '已保存的工作流',
        listEmpty: '还没有工作流。对模型说「把这个流程固化一下」即可创建第一个。',
        refresh: '刷新',
        loading: '正在读取…',
        loadFailed: '读取设置失败',
        retry: '重试',
        listFailed: '读取工作流列表失败',
        steps: '步',
        updated: '更新于',
        rootNow: '当前目录',
        indexNow: '索引文件',
        count: '数量',
        hintFooter: '每个工作流是一个文件夹：SKILL.md（模型读）+ workflow.json（结构化记录）+ assets/（可选脚本）。',
        readonly: '当前 profile 不允许从界面写配置；请改用 profile 的 cordis.patch.yml。',
        pickFailed: '目录选择器不可用，可以直接粘贴路径。',
      },
      en: {
        nav: 'Workflows',
        title: 'Workflow library',
        subtitle:
          'Keep repeatable procedures: tell the model to solidify a workflow and it creates a new folder here; later sessions discover it and load it on demand.',
        rootLabel: 'Library root',
        rootHint: 'Leave empty to use ~/.dsh/workflows. Saving applies immediately.',
        rootPlaceholder: '~/.dsh/workflows',
        choose: 'Choose folder',
        save: 'Save root',
        saving: 'Saving…',
        saved: 'Saved.',
        saveFailed: 'Could not save. Try again.',
        settings: 'Generation',
        skillsLabel: 'Register as skills',
        skillsHint: 'On: workflows enter the skill catalog and later sessions can find them. Off: files only.',
        indexLabel: 'Maintain INDEX.md',
        indexHint: 'Rebuild the root INDEX.md after every save.',
        conflictLabel: 'Same name',
        conflictSuffix: 'Create a suffixed folder',
        conflictReplace: 'Replace and bump version',
        languageLabel: 'Language',
        langAuto: 'Follow content',
        langZh: '中文',
        langEn: 'English',
        listTitle: 'Saved workflows',
        listEmpty: 'No workflows yet. Ask the model to solidify a procedure to create the first one.',
        refresh: 'Refresh',
        loading: 'Reading…',
        loadFailed: 'Could not read settings',
        retry: 'Retry',
        listFailed: 'Could not read the workflow list',
        steps: 'steps',
        updated: 'updated',
        rootNow: 'Root',
        indexNow: 'Index',
        count: 'Count',
        hintFooter: 'Each workflow is a folder: SKILL.md (for the model) + workflow.json (structured record) + assets/ (optional scripts).',
        readonly: 'This profile does not allow editing configuration from the UI; edit the profile cordis.patch.yml instead.',
        pickFailed: 'The folder picker is unavailable; paste a path instead.',
      },
    }

    function useCopy(ctx) {
      const subscribe = React.useCallback((listener) => ctx.locale.subscribe(listener), [ctx])
      const getSnapshot = React.useCallback(() => ctx.locale.getSnapshot(), [ctx])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const active = String(snapshot?.active ?? '').toLowerCase()
      return active.startsWith('zh') ? COPY.zh : COPY.en
    }

    async function requestJson(path, options) {
      const response = await fetch(`${API}${path}`, options)
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.message ?? data?.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    function formatDate(value) {
      const text = typeof value === 'string' ? value : ''
      if (text.length < 10) return '—'
      return `${text.slice(0, 10)} ${text.slice(11, 16)}`.trim()
    }

    function Card({ title, children }) {
      return h(
        'section',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            background: 'var(--dsw-alias-bg-base)',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          },
        },
        title
          ? h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title)
          : null,
        children,
      )
    }

    function Hint({ children }) {
      return h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, children)
    }

    function Switch({ checked, disabled, onToggle, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          title: label,
          disabled,
          onClick: onToggle,
          style: {
            width: 34,
            height: 20,
            flex: 'none',
            borderRadius: 10,
            border: 'none',
            padding: 0,
            position: 'relative',
            cursor: disabled ? 'default' : 'pointer',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            opacity: disabled ? 0.55 : 1,
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    function SwitchRow({ label, hint, checked, disabled, onToggle }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, label),
          hint ? h(Hint, null, hint) : null,
        ),
        h(Switch, { checked, disabled, onToggle, label }),
      )
    }

    function Choice({ title, options, value, disabled, onChange }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', minWidth: 96 } }, title),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          options.map((option) =>
            h(
              'button',
              {
                key: option.id,
                type: 'button',
                disabled,
                'aria-pressed': option.id === value,
                onClick: () => {
                  if (option.id !== value) onChange(option.id)
                },
                style: {
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 7,
                  padding: '4px 10px',
                  fontSize: 12,
                  cursor: disabled ? 'default' : 'pointer',
                  color: option.id === value ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  background: option.id === value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  fontWeight: option.id === value ? 500 : 400,
                },
              },
              option.label,
            ),
          ),
        ),
      )
    }

    function WorkflowList({ copy, listing, onRefresh }) {
      const data = listing.data
      const entries = Array.isArray(data?.entries) ? data.entries : []
      const busy = listing.state === 'loading' || listing.state === 'refreshing'
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: 1 } },
            data
              ? `${copy.count}: ${data.count ?? entries.length}`
              : listing.state === 'error'
                ? `${copy.listFailed}${listing.error ? ` — ${listing.error}` : ''}`
                : copy.loading,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onRefresh,
              disabled: busy,
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            copy.refresh,
          ),
        ),
        entries.length === 0
          ? h(Hint, null, listing.state === 'loading' ? copy.loading : copy.listEmpty)
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              entries.map((entry) =>
                h(
                  'div',
                  {
                    key: entry.name,
                    style: {
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 8,
                      padding: '9px 11px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                    h('code', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, entry.name),
                    h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, entry.title),
                    h(
                      'span',
                      { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                      `${entry.steps ?? 0} ${copy.steps} · ${copy.updated} ${formatDate(entry.updatedAt)}`,
                    ),
                  ),
                  entry.whenToUse
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' } },
                        entry.whenToUse,
                      )
                    : null,
                ),
              ),
            ),
      )
    }

    function Page({ ctx }) {
      const copy = useCopy(ctx)
      const [state, setState] = React.useState({
        phase: 'loading',
        values: DEFAULTS,
        editable: false,
        picker: false,
        effectiveRoot: '',
        error: null,
      })
      const [root, setRoot] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [listing, setListing] = React.useState({ state: 'loading', data: null, error: null })

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, phase: 'loading', error: null }))
        try {
          const data = await requestJson('/config', { headers: { accept: 'application/json' } })
          setState({
            phase: 'ready',
            values: { ...DEFAULTS, ...(data?.values ?? {}) },
            editable: data?.editable === true,
            picker: data?.picker === true,
            effectiveRoot: typeof data?.effectiveRoot === 'string' ? data.effectiveRoot : '',
            error: null,
          })
          setRoot(String(data?.values?.root ?? ''))
        } catch (failure) {
          setState({ phase: 'error', values: DEFAULTS, editable: false, picker: false, effectiveRoot: '', error: String(failure?.message ?? failure) })
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        let alive = true
        setListing((current) => ({ state: current.data ? 'refreshing' : 'loading', data: current.data, error: null }))
        requestJson('/list', { headers: { accept: 'application/json' } })
          .then((data) => {
            if (alive) setListing({ state: 'ready', data, error: null })
          })
          .catch((failure) => {
            if (alive) setListing({ state: 'error', data: null, error: String(failure?.message ?? failure) })
          })
        return () => {
          alive = false
        }
      }, [tick])

      const save = React.useCallback(
        async (patch) => {
          if (busy) return false
          setBusy(true)
          setError(null)
          setNotice(null)
          try {
            const data = await requestJson('/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json', [UI_HEADER]: '1' },
              body: JSON.stringify(patch),
            })
            setState((current) => ({
              ...current,
              values: { ...current.values, ...(data?.values ?? patch) },
            }))
            setNotice(copy.saved)
            return true
          } catch (failure) {
            setError(failure instanceof Error && failure.message ? failure.message : copy.saveFailed)
            return false
          } finally {
            setBusy(false)
          }
        },
        [busy, copy],
      )

      const refreshListSoon = React.useCallback(() => {
        window.setTimeout(() => setTick((current) => current + 1), 900)
      }, [])

      const choose = React.useCallback(async () => {
        setError(null)
        try {
          const data = await requestJson('/pick', {
            method: 'POST',
            headers: { 'content-type': 'application/json', [UI_HEADER]: '1' },
            body: '{}',
          })
          if (typeof data?.path === 'string' && data.path.length > 0) setRoot(data.path)
        } catch {
          setError(copy.pickFailed)
        }
      }, [copy])

      const header = h(
        'header',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, copy.title),
        h('div', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, copy.subtitle),
      )

      if (state.phase === 'loading') {
        return h('div', { style: { padding: 24 } }, header, h('div', { style: { marginTop: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, copy.loading))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 12 } },
          header,
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, `${copy.loadFailed}：${state.error ?? ''}`),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void load(),
              style: {
                alignSelf: 'flex-start',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: 7,
                padding: '6px 14px',
                fontSize: 13,
                cursor: 'pointer',
              },
            },
            copy.retry,
          ),
        )
      }

      const values = state.values
      const disabled = busy || !state.editable
      const rootValue = root.trim()
      const rootChanged = rootValue !== String(values.root ?? '')

      return h(
        'div',
        {
          style: {
            maxWidth: 760,
            margin: '0 auto',
            padding: '24px 20px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          },
        },
        header,
        state.editable ? null : h(Hint, null, copy.readonly),

        h(
          Card,
          { title: copy.rootLabel },
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              type: 'text',
              value: root,
              placeholder: copy.rootPlaceholder,
              spellCheck: false,
              disabled,
              onChange: (event) => setRoot(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && rootChanged) {
                  void save({ root: rootValue }).then((ok) => {
                    if (ok) refreshListSoon()
                  })
                }
              },
              style: {
                flex: '1 1 280px',
                minWidth: 220,
                padding: '6px 10px',
                fontSize: 13,
                borderRadius: 7,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                outline: 'none',
              },
            }),
            state.picker
              ? h(
                  'button',
                  {
                    type: 'button',
                    disabled,
                    onClick: () => void choose(),
                    style: {
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-primary)',
                      borderRadius: 7,
                      padding: '6px 12px',
                      fontSize: 13,
                      cursor: disabled ? 'default' : 'pointer',
                      opacity: disabled ? 0.6 : 1,
                    },
                  },
                  copy.choose,
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                disabled: disabled || !rootChanged,
                onClick: () => {
                  void save({ root: rootValue }).then((ok) => {
                    if (ok) refreshListSoon()
                  })
                },
                style: {
                  border: 'none',
                  background: 'var(--dsw-alias-brand-primary)',
                  color: '#ffffff',
                  borderRadius: 7,
                  padding: '6px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: disabled || !rootChanged ? 'default' : 'pointer',
                  opacity: disabled || !rootChanged ? 0.55 : 1,
                },
              },
              busy ? copy.saving : copy.save,
            ),
          ),
          h(Hint, null, copy.rootHint),
        ),

        h(
          Card,
          { title: copy.settings },
          h(SwitchRow, {
            label: copy.skillsLabel,
            hint: copy.skillsHint,
            checked: values.registerSkills !== false,
            disabled,
            onToggle: () => void save({ registerSkills: values.registerSkills === false }),
          }),
          h(SwitchRow, {
            label: copy.indexLabel,
            hint: copy.indexHint,
            checked: values.autoIndex !== false,
            disabled,
            onToggle: () => void save({ autoIndex: values.autoIndex === false }),
          }),
          h(Choice, {
            title: copy.conflictLabel,
            value: values.onConflict === 'replace' ? 'replace' : 'suffix',
            disabled,
            onChange: (next) => void save({ onConflict: next }),
            options: [
              { id: 'suffix', label: copy.conflictSuffix },
              { id: 'replace', label: copy.conflictReplace },
            ],
          }),
          h(Choice, {
            title: copy.languageLabel,
            value: values.language ?? 'auto',
            disabled,
            onChange: (next) => void save({ language: next }),
            options: [
              { id: 'auto', label: copy.langAuto },
              { id: 'zh', label: copy.langZh },
              { id: 'en', label: copy.langEn },
            ],
          }),
        ),

        h(Card, { title: copy.listTitle }, h(WorkflowList, { copy, listing, onRefresh: () => setTick((current) => current + 1) })),

        h(
          'footer',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              lineHeight: '18px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          notice ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
          listing.data ? h('div', null, `${copy.rootNow}: ${listing.data.root}`) : null,
          listing.data ? h('div', null, `${copy.indexNow}: ${listing.data.indexPath}`) : null,
          h('div', null, copy.hintFooter),
        ),
      )
    }

    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: 24, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } },
            `工作流库页面出错：${this.state.error?.message ?? String(this.state.error)}`,
          )
        }
        return this.props.children
      }
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'workflow-library',
            order: 27,
            label: () => {
              const active = String(ctx?.locale?.getSnapshot?.()?.active ?? '').toLowerCase()
              return active.startsWith('zh') ? COPY.zh.nav : COPY.en.nav
            },
          },
          function WorkflowLibraryPage() {
            return h(PageBoundary, null, h(Page, { ctx }))
          },
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
