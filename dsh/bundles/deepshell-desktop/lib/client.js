window.__ModuleLoader__.load({
  id: '@deepshell-agent/dsh-desktop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const { createElement } = require('react')

    const inject = ['slots', 'connection', 'sessions', 'workspaces', 'settingsScope']

    function BrandIcon({ size }) {
      return createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 1024 1024',
        role: 'img',
        'aria-label': 'DeepShell Agent',
        style: { display: 'block' }
      },
        createElement('defs', null,
          createElement('linearGradient', { id: 'deepshell-brand-bg', x1: 164, y1: 96, x2: 860, y2: 928, gradientUnits: 'userSpaceOnUse' },
            createElement('stop', { offset: 0, stopColor: '#0B59B8' }),
            createElement('stop', { offset: .55, stopColor: '#07356E' }),
            createElement('stop', { offset: 1, stopColor: '#031225' })),
          createElement('linearGradient', { id: 'deepshell-brand-shell', x1: 512, y1: 178, x2: 512, y2: 852, gradientUnits: 'userSpaceOnUse' },
            createElement('stop', { offset: 0, stopColor: '#92FFF3' }),
            createElement('stop', { offset: .45, stopColor: '#22E6F2' }),
            createElement('stop', { offset: 1, stopColor: '#178BFF' }))),
        createElement('rect', { x: 48, y: 48, width: 928, height: 928, rx: 214, fill: 'url(#deepshell-brand-bg)' }),
        createElement('path', {
          d: 'M512 164C451 164 430 226 399 268C352 241 296 269 285 323C235 323 196 359 193 410C146 426 124 475 146 520C173 577 223 625 292 663L236 674C203 681 181 707 183 739C224 760 287 759 342 744C384 794 446 828 512 846C578 828 640 794 682 744C737 759 800 760 841 739C843 707 821 681 788 674L732 663C801 625 851 577 878 520C900 475 878 426 831 410C828 359 789 323 739 323C728 269 672 241 625 268C594 226 573 164 512 164Z',
          fill: 'url(#deepshell-brand-shell)'
        }),
        createElement('g', { fill: 'none', stroke: '#042350', strokeWidth: 14, strokeLinecap: 'round', strokeOpacity: .82 },
          createElement('path', { d: 'M399 270C429 314 445 354 450 386' }),
          createElement('path', { d: 'M625 270C595 314 579 354 574 386' }),
          createElement('path', { d: 'M286 324C335 364 369 410 387 452' }),
          createElement('path', { d: 'M738 324C689 364 655 410 637 452' })),
        createElement('g', { fill: 'none', stroke: '#021529', strokeLinecap: 'round', strokeLinejoin: 'round' },
          createElement('path', { d: 'M386 390L510 506L386 622', strokeWidth: 76 }),
          createElement('path', { d: 'M588 604H710', strokeWidth: 64 }))
      )
    }

    function BrandMark({ size = 28, className }) {
      return createElement('span', {
        className,
        'aria-label': 'DeepShell Agent',
        style: {
          display: 'inline-grid', placeItems: 'center', width: size, height: size,
          borderRadius: Math.max(7, Math.round(size * .28)), overflow: 'hidden'
        }
      }, createElement(BrandIcon, { size }))
    }

    function BrandName() {
      return createElement('strong', {
        style: { fontSize: 13, letterSpacing: '-.01em', lineHeight: 1.15, whiteSpace: 'nowrap' }
      }, 'DeepShell Agent')
    }

    function modeFromPreset(preset) {
      if (preset === 'deepshell-coding' || preset === 'deepshell') return 'Coding'
      if (preset === 'deepshell-work') return 'Work'
      if (preset === 'deepshell-general') return 'General'
      return undefined
    }

    function ModeStatus({ sessionId, useSessions }) {
      const preset = useSessions((state) => {
        const value = state.byId[sessionId]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
      const mode = modeFromPreset(preset)
      if (mode === undefined) return null
      return createElement('span', {
        title: `DeepShell Mode: ${mode} (${preset})`,
        'aria-label': `DeepShell Mode: ${mode}`,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: 999,
          border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
          padding: '2px 8px',
          fontSize: 12,
          lineHeight: 1.4,
          opacity: .82,
          whiteSpace: 'nowrap'
        }
      }, `Mode: ${mode}`)
    }

    function waitForBaseline(ctx, settings) {
      const sources = [ctx.connection.state, ctx.sessions.list, ctx.workspaces.list, settings]
      const isReady = () => {
        const connection = ctx.connection.state.getSnapshot()
        const sessions = ctx.sessions.list.getSnapshot()
        const workspaces = ctx.workspaces.list.getSnapshot()
        const preferences = settings.getSnapshot()
        return connection === 'connected' && sessions.phase === 'ready' &&
          workspaces.phase === 'ready' && ['ready', 'unavailable'].includes(preferences.status)
      }
      if (isReady()) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const disposers = []
        const timer = setTimeout(() => finish(new Error('baseline timeout')), 55_000)
        const finish = (error) => {
          clearTimeout(timer)
          for (const dispose of disposers.splice(0)) dispose()
          error ? reject(error) : resolve()
        }
        const changed = () => {
          if (isReady()) finish()
        }
        for (const source of sources) disposers.push(source.subscribe(changed))
        changed()
      })
    }

    async function announceReady(ctx) {
      const instanceId = globalThis.__DEEPSHELL_INSTANCE_ID__
      if (typeof instanceId !== 'string') return
      const settings = ctx.settingsScope.describe()
      await settings.ensure()
      await waitForBaseline(ctx, settings)
      await fetch('/__deepshell/client-ready', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId, baseline: 'ready' })
      })
    }

    function apply(ctx) {
      const brandDispose = ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: -100 }, BrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name', priority: -100 }, BrandName)
            yield ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -100 }, BrandMark)
          })))
      const modeDispose = ctx.slots.inject('conversation.session.header.utilities', function* () {
        yield ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'deepshell-mode',
          order: -20,
          label: 'DeepShell Mode'
        }, ModeStatus)
      })
      queueMicrotask(() => void announceReady(ctx).catch(() => {
        console.error('DeepShell Agent baseline readiness failed')
      }))
      return () => {
        modeDispose()
        brandDispose()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
