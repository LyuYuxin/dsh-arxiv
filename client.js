// Client half of dsh-arxiv.
//
// A single-paper arXiv reading tab: import by arXiv ID (or abs/pdf/HTML URL),
// streamed AI quick-read summary, follow-up Q&A over the same paper, and a model
// picker that switches the current DSH session model through the normal
// `modelDirectories` service so the composer and this view always agree.
//
// The bundle is hand-written lazy-CJS: the module body registers a factory, and
// everything (styles included) runs at materialization. `require` only reaches
// shared platform modules; the host routes live at /dsh-arxiv/*.
window.__ModuleLoader__.load({
  id: 'dsh-arxiv',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-arxiv'
    const ROUTE = '/dsh-arxiv'
    const RECENT_KEY = 'dsh-arxiv.recent'
    const SUMMARY_KEY = 'dsh-arxiv.summary.'
    const RECENT_MAX = 8
    const SUMMARY_WAIT_MS = 2500
    const LIBRARY_KEY = 'dsh-arxiv.library'
    const TARGET_SESSION_KEY = 'dsh-arxiv.targetSession'
    const LAST_PAPER_KEY = 'dsh-arxiv.lastPaper'
    const LIBRARY_MAX = 30
    const SEL_MAX = 2000

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = `
.axv-root{box-sizing:border-box;height:100%;overflow-y:auto;overscroll-behavior:contain;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.axv-panel-wrap{box-sizing:border-box;height:100%;min-height:0}
.axv-inner{box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:18px 24px 48px;display:flex;flex-direction:column;gap:14px}
.axv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.axv-brand{display:flex;align-items:center;gap:8px;min-width:0}
.axv-brand-icon{display:inline-flex;width:22px;height:22px;flex:none;color:var(--dsw-alias-brand-primary)}
.axv-brand-name{font-size:15px;font-weight:650;letter-spacing:.01em}
.axv-brand-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap}
.axv-spacer{margin-left:auto}
.axv-model{position:relative;flex:none}
.axv-model-trigger{display:inline-flex;align-items:center;gap:6px;max-width:260px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:border-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out),color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}
.axv-model-trigger:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.axv-model-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.axv-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--dsw-alias-label-primary)}
.axv-model-provider{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.axv-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;width:320px;max-height:min(420px,70vh);overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.axv-menu-group{padding:5px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;letter-spacing:.02em}
.axv-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.axv-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.axv-menu-item[data-current="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent)}
.axv-menu-check{width:14px;flex:none;display:inline-flex;color:var(--dsw-alias-brand-primary)}
.axv-menu-empty{padding:10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.axv-search{display:flex;gap:8px;align-items:stretch;min-width:0}
.axv-input{box-sizing:border-box;min-width:0;flex:1;height:38px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.axv-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.axv-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:0;border-color:transparent}
.axv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;padding:0 16px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:550;cursor:pointer;white-space:nowrap;transition:background-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out),border-color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out),opacity var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}
.axv-btn:disabled{opacity:.45;cursor:not-allowed}
.axv-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.axv-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.axv-btn-primary:hover:not(:disabled){filter:brightness(1.05)}
.axv-btn-outline{height:30px;padding:0 12px;border-color:var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.axv-btn-outline:hover:not(:disabled){border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.axv-btn-ghost{height:28px;padding:0 9px;border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500}
.axv-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.axv-recent{display:flex;flex-wrap:wrap;gap:6px;min-height:0}
.axv-chip{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}
.axv-chip:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.axv-status{color:var(--dsw-alias-label-secondary);font-size:11.5px;display:flex;align-items:center;gap:6px;min-height:16px}
.axv-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:axv-pulse 1.1s ease-in-out infinite}
@keyframes axv-pulse{0%,100%{opacity:.25}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.axv-dot{animation:none}}
.axv-error{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);border-radius:10px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.axv-card{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;min-width:0}
.axv-paper-head{display:flex;flex-direction:column;gap:7px;min-width:0}
.axv-paper-title{margin:0;font-size:17px;line-height:1.4;font-weight:650;overflow-wrap:anywhere}
.axv-paper-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:11.5px;min-width:0}
.axv-paper-authors{overflow-wrap:anywhere}
.axv-tag{display:inline-flex;align-items:center;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:18px}
.axv-links{display:flex;flex-wrap:wrap;gap:12px;margin-top:2px}
.axv-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;display:inline-flex;align-items:center;gap:3px}
.axv-link:hover{text-decoration:underline}
.axv-abstract{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin:2px 0 0}
.axv-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.axv-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.axv-section-title{font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.axv-section-caption{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.axv-summary{padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-height:56px;overflow-wrap:anywhere}
.axv-placeholder{color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.axv-upgrade{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:9px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.axv-md{display:flex;flex-direction:column;gap:8px;min-width:0}
.axv-md h1,.axv-md h2,.axv-md h3,.axv-md h4{margin:7px 0 0;font-size:13.5px;line-height:1.45;font-weight:650;color:var(--dsw-alias-label-primary)}
.axv-md h1{font-size:15px}
.axv-md p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.axv-md ul,.axv-md ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px}
.axv-md li{overflow-wrap:anywhere}
.axv-md code{padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.axv-md pre{margin:0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);overflow-x:auto}
.axv-md pre code{padding:0;background:transparent;font-size:11.5px;line-height:1.5}
.axv-md blockquote{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.axv-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:2px 0}
.axv-md a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.axv-md a:hover{text-decoration:underline}
.axv-math{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.8px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 7%, transparent);border-radius:4px;padding:0 3px}
.axv-md .axv-math-block{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;white-space:pre-wrap;overflow-x:auto}
.axv-qa{display:flex;flex-direction:column;gap:10px;min-width:0}
.axv-msg{display:flex;flex-direction:column;gap:3px;min-width:0}
.axv-msg-user{align-self:flex-end;max-width:82%}
.axv-msg-user .axv-bubble{padding:8px 12px;border-radius:12px 12px 3px 12px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.axv-msg-assistant{align-self:stretch}
.axv-msg-role{color:var(--dsw-alias-label-tertiary);font-size:10.5px;letter-spacing:.02em}
.axv-msg-assistant .axv-bubble{padding:11px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px}
.axv-msg-error .axv-bubble{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);color:var(--dsw-alias-state-error-primary)}
.axv-cursor{display:inline-block;width:7px;height:13px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-brand-primary);animation:axv-pulse 1s ease-in-out infinite;border-radius:1px}
.axv-ask{position:sticky;bottom:0;display:flex;gap:8px;align-items:flex-end;padding:10px 0 2px;background:linear-gradient(180deg,transparent,var(--dsw-alias-bg-layer-1) 32%)}
.axv-ask .axv-input{height:auto;min-height:38px;max-height:132px;padding:8px 12px;resize:none;line-height:1.5;font-family:inherit}
.axv-suggest{display:flex;flex-wrap:wrap;gap:6px}
.axv-kv{color:var(--dsw-alias-label-tertiary);font-size:11px}
.axv-empty{display:flex;flex-direction:column;gap:16px;padding:26px 4px 8px}
.axv-empty-title{font-size:20px;font-weight:650;line-height:1.35}
.axv-empty-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:620px}
.axv-examples{display:flex;flex-wrap:wrap;gap:8px}
.axv-example{display:flex;flex-direction:column;gap:2px;padding:8px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;max-width:250px}
.axv-example:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
.axv-example-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;color:var(--dsw-alias-brand-primary)}
.axv-example-title{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.axv-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.axv-root{container-type:inline-size}
.axv-modebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.axv-seg{display:inline-flex;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.axv-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;padding:2px 10px;border-radius:7px;cursor:pointer}
.axv-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.axv-seg-btn[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.axv-seg-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.axv-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start;min-width:0}
.axv-workspace.axv-mode-ai,.axv-workspace.axv-mode-source{grid-template-columns:minmax(0,1fr)}
.axv-mode-ai .axv-source-pane,.axv-mode-source .axv-ai-pane{display:none}
.axv-pane{min-width:0;height:clamp(460px,62vh,860px);overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:2px 6px 2px 2px;scrollbar-width:thin}
.axv-ai-pane .axv-ask{padding-bottom:8px}
.axv-source-pane{gap:8px}
.axv-pane-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;top:0;z-index:2;padding:2px 0 6px;background:var(--dsw-alias-bg-layer-1)}
.axv-source-text{display:flex;flex-direction:column;gap:8px;font-size:12.5px;line-height:1.72;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.axv-source-text h3{margin:10px 0 0;font-size:13px;line-height:1.45;font-weight:650;color:var(--dsw-alias-label-primary)}
.axv-source-text p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;content-visibility:auto;contain-intrinsic-size:auto 64px}
@container (max-width:980px){
  .axv-workspace.axv-mode-split{grid-template-columns:minmax(0,1fr)}
  .axv-mode-split .axv-pane{height:auto;max-height:46vh}
}
.axv-panel-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.axv-session{position:relative;flex:none;min-width:0}
.axv-session-trigger{display:inline-flex;align-items:center;gap:6px;max-width:240px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}
.axv-session-trigger:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.axv-session-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.axv-session-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--dsw-alias-label-primary)}
.axv-session-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:320px;max-height:min(380px,60vh);overflow-y:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.axv-session-option{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.axv-session-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.axv-session-option[data-current="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent)}
.axv-session-title{font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.axv-session-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.axv-session-empty{padding:9px;color:var(--dsw-alias-label-secondary);font-size:12px}
.axv-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.axv-attach{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}
.axv-attach:hover:not(:disabled){border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.axv-attach[data-attached="true"]{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, var(--dsw-alias-border-l2));background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);color:var(--dsw-alias-brand-primary)}
.axv-attach:disabled{opacity:.5;cursor:not-allowed}
.axv-attach-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.axv-library{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
.axv-library-chip{display:inline-flex;align-items:center;gap:5px;max-width:260px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer}
.axv-library-chip:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.axv-library-chip[data-pinned="true"]{border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2));color:var(--dsw-alias-brand-primary)}
.axv-star{border:0;background:transparent;color:inherit;cursor:pointer;padding:0;line-height:1;font-size:11px;opacity:.55}
.axv-star:hover{opacity:1}
.axv-toast{font-size:11.5px;color:var(--dsw-alias-brand-primary)}
`

    // ── dictionaries ──────────────────────────────────────────────────────────
    const zh = {
      tab: 'arXiv 速读',
      brandSub: '单篇精读 · AI 速览与问答',
      queryPlaceholder: '粘贴 arXiv ID 或链接，如 2401.12345 / arxiv.org/abs/1706.03762',
      import: '导入',
      importing: '正在导入…',
      loadingText: '正在获取全文…',
      textReady: '全文已就绪（{source}，{chars} 字）',
      textAbstractOnly: '未取到全文，基于摘要',
      sourceAr5iv: 'ar5iv',
      sourceHtml: 'arXiv HTML',
      sourceAbstract: '摘要',
      emptyTitle: '读一篇 arXiv，只要几秒',
      emptySub: '粘贴 arXiv ID 直接导入；自动生成中文速览，然后可以就这篇论文继续追问。使用 DSH 当前模型，可随时切换。',
      examples: '试试这些',
      recent: '最近',
      summary: 'AI 速览',
      summarize: '生成速览',
      regenerate: '重新生成',
      stop: '停止',
      summaryIdle: '导入论文后自动生成速览。',
      summaryStreaming: '正在生成速览…',
      summaryCached: '已缓存',
      upgrade: '全文已就绪，用全文重新总结更准确',
      upgradeAction: '用全文重写',
      summaryFrom: '基于',
      summaryBy: '由 {model} 生成',
      summaryStale: '当前模型是 {model}，可用新模型重新生成',
      copy: '复制',
      copied: '已复制',
      qa: '追问这篇论文',
      qaHint: '基于全文回答，可追问方法、实验、局限等。',
      modes: '显示方式',
      paneSplit: '并排',
      paneAi: '只看 AI',
      paneSource: '只看原文',
      sourcePane: '原文',
      sourceLoading: '正在获取原文…',
      sourceEmpty: '暂无可显示的原文，请打开 arXiv HTML 或 PDF。',
      sourceTruncated: '原文较长，这里只显示前 {chars} 字；完整内容请打开 arXiv HTML/PDF。',
      sourceNote: '正文由 arXiv / ar5iv 自动提取，公式与图表请以 HTML/PDF 为准。',
      copySource: '复制原文',
      sourceCopied: '已复制',
      panel: 'arXiv',
      targetSession: '目标会话',
      sessionNone: '无会话',
      sessionLoading: '读取会话…',
      sessionPick: '选择要把论文挂载/发送到的会话',
      attach: '挂到会话',
      attached: '已挂到会话',
      detach: '取消挂载',
      attachHint: '挂载后，该会话里的 agent 会知道你在读这篇论文，并可用 arxiv 工具读取正文。',
      sendAgent: '发给 agent',
      sendSelection: '问选中段落',
      sendSent: '已发送到会话',
      sendFailed: '发送失败：{message}',
      needSession: '先选择一个目标会话',
      library: '论文库',
      libraryEmpty: '导入过的论文会出现在这里',
      pin: '收藏',
      unpin: '取消收藏',
      selectionEmpty: '先在原文里选中一段文字',
      backConversation: '回到会话',
      agentReadable: '本会话的 agent 已能看到这篇论文',
      askPlaceholder: '问一个关于这篇论文的问题…',
      ask: '发送',
      answer: 'arXiv 速读',
      you: '你',
      thinking: '思考中…',
      model: '模型',
      modelLoading: '读取模型…',
      modelEmpty: '没有可用模型',
      needModel: '还没有可用模型，请先在 DSH 里选择模型。',
      modelUnavailable: '模型选择服务不可用，将无法切换模型。',
      modelSwitched: '已切换到 {model}',
      modelSwitchFailed: '切换模型失败：{message}',
      errorTitle: '出错了',
      retry: '重试',
      noPaper: '还没有导入论文',
      suggestions: {
        problem: '这篇论文解决了什么问题？',
        method: '方法的核心思路是什么？',
        limits: '实验有哪些局限性？',
      },
      error: {
        'bad-id': '无法识别这个 arXiv ID，请检查格式。',
        'not-found': 'arXiv 上没有找到这篇论文。',
        network: '网络请求失败，请稍后重试。',
        timeout: '请求超时，请稍后重试。',
        parse: '论文信息解析失败。',
        'bad-request': '请求参数有误。',
        NO_ADAPTER: '当前 DSH 没有可用的模型服务。',
        MISSING_CREDENTIAL: '模型缺少凭据，请在 DSH 设置里登录或配置。',
        AUTH: '模型认证失败，请重新登录 DSH。',
        RATE_LIMIT: '模型请求过于频繁，请稍后再试。',
        QUOTA: '模型额度不足。',
        ABORTED: '已取消。',
        EMPTY_RESPONSE: '模型没有产生可见输出，请重试或换一个模型。',
        internal: '内部错误，请重试。',
      },
    }
    const en = {
      tab: 'arXiv Read',
      brandSub: 'One paper, fast: AI overview and Q&A',
      queryPlaceholder: 'Paste an arXiv ID or URL, e.g. 2401.12345',
      import: 'Import',
      importing: 'Importing…',
      loadingText: 'Loading full text…',
      textReady: 'Full text ready ({source}, {chars} chars)',
      textAbstractOnly: 'No full text, using abstract',
      sourceAr5iv: 'ar5iv',
      sourceHtml: 'arXiv HTML',
      sourceAbstract: 'abstract',
      emptyTitle: 'Read an arXiv paper in seconds',
      emptySub: 'Paste an arXiv ID to import. An AI overview streams automatically, then ask questions about the paper. Uses the current DSH model, switchable at any time.',
      examples: 'Try these',
      recent: 'Recent',
      summary: 'AI overview',
      summarize: 'Summarize',
      regenerate: 'Regenerate',
      stop: 'Stop',
      summaryIdle: 'Import a paper to generate an overview.',
      summaryStreaming: 'Generating overview…',
      summaryCached: 'cached',
      upgrade: 'Full text is ready — rewrite the overview from it',
      upgradeAction: 'Rewrite from full text',
      summaryFrom: 'from',
      summaryBy: 'by {model}',
      summaryStale: 'Current model is {model}; regenerate with it',
      copy: 'Copy',
      copied: 'Copied',
      qa: 'Ask about this paper',
      qaHint: 'Answers come from the paper. Ask about method, experiments, limitations.',
      modes: 'Layout',
      paneSplit: 'Split',
      paneAi: 'AI only',
      paneSource: 'Source only',
      sourcePane: 'Original text',
      sourceLoading: 'Loading the paper text…',
      sourceEmpty: 'No extracted text available; open the arXiv HTML or PDF instead.',
      sourceTruncated: 'The paper is long; showing the first {chars} chars. Open the arXiv HTML/PDF for all of it.',
      sourceNote: 'Extracted automatically from arXiv / ar5iv; formulas and figures are best viewed in HTML/PDF.',
      copySource: 'Copy text',
      sourceCopied: 'Copied',
      panel: 'arXiv',
      targetSession: 'Target session',
      sessionNone: 'No session',
      sessionLoading: 'Loading sessions…',
      sessionPick: 'Choose the session to attach/send this paper to',
      attach: 'Attach to session',
      attached: 'Attached to session',
      detach: 'Detach',
      attachHint: 'Attached sessions let their agent see this paper and read it through the arxiv tool.',
      sendAgent: 'Send to agent',
      sendSelection: 'Ask about selection',
      sendSent: 'Sent to the session',
      sendFailed: 'Send failed: {message}',
      needSession: 'Pick a target session first',
      library: 'Library',
      libraryEmpty: 'Imported papers will show up here',
      pin: 'Pin',
      unpin: 'Unpin',
      selectionEmpty: 'Select some original text first',
      backConversation: 'Back to conversation',
      agentReadable: 'This session’s agent can see the paper',
      askPlaceholder: 'Ask a question about this paper…',
      ask: 'Send',
      answer: 'arXiv Read',
      you: 'You',
      thinking: 'Thinking…',
      model: 'Model',
      modelLoading: 'Loading models…',
      modelEmpty: 'No models available',
      needModel: 'No model available yet. Select a model in DSH first.',
      modelUnavailable: 'Model selection service unavailable; switching is disabled.',
      modelSwitched: 'Switched to {model}',
      modelSwitchFailed: 'Failed to switch model: {message}',
      errorTitle: 'Something went wrong',
      retry: 'Retry',
      noPaper: 'No paper imported yet',
      suggestions: {
        problem: 'What problem does this paper solve?',
        method: 'What is the core idea of the method?',
        limits: 'What are the limitations of the experiments?',
      },
      error: {
        'bad-id': 'That arXiv ID was not recognized.',
        'not-found': 'No such paper on arXiv.',
        network: 'Network request failed. Try again.',
        timeout: 'Request timed out. Try again.',
        parse: 'Could not parse the paper record.',
        'bad-request': 'Invalid request.',
        NO_ADAPTER: 'No model service available in this DSH.',
        MISSING_CREDENTIAL: 'The model has no credentials. Sign in or configure DSH.',
        AUTH: 'Model authentication failed. Sign in to DSH again.',
        RATE_LIMIT: 'Rate limited by the model provider. Try again shortly.',
        QUOTA: 'Model quota exhausted.',
        ABORTED: 'Cancelled.',
        EMPTY_RESPONSE: 'The model produced no visible output. Retry or switch models.',
        internal: 'Internal error. Try again.',
      },
    }

    // ── icons ─────────────────────────────────────────────────────────────────
    const svg = (props, children) => h('svg', Object.assign({
      viewBox: '0 0 24 24',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, props), children)
    const IconDoc = () => svg({ width: 22, height: 22, className: 'axv-brand-icon' }, [
      h('path', { key: 'a', d: 'M6.5 3.5h7l4 4v11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z' }),
      h('path', { key: 'b', d: 'M13.5 3.5v4h4' }),
      h('path', { key: 'c', d: 'M8 12.5h5.5M8 15.5h4' }),
    ])
    const IconChevron = () => svg(null, h('path', { d: 'm6 9 6 6 6-6' }))
    const IconCheck = () => svg({ width: 13, height: 13 }, h('path', { d: 'm5 12.5 4.5 4.5L19 7' }))
    const IconStop = () => svg({ width: 13, height: 13 }, h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 }))
    const IconCopy = () => svg({ width: 13, height: 13 }, [
      h('rect', { key: 'a', x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }),
      h('path', { key: 'b', d: 'M15.5 5.5v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1' }),
    ])
    const IconArrow = () => svg({ width: 12, height: 12 }, h('path', { d: 'M7 17 17 7M9 7h8v8' }))
    /** Sidebar panel-list icon: same document glyph, sized by the sidebar seat. */
    const ArxivPanelIcon = (props) => {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return svg({ width: size, height: size }, [
        h('path', { key: 'a', d: 'M6.5 3.5h7l4 4v11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z' }),
        h('path', { key: 'b', d: 'M13.5 3.5v4h4' }),
        h('path', { key: 'c', d: 'M8 12.5h5.5M8 15.5h4' }),
      ])
    }

    // ── small helpers ─────────────────────────────────────────────────────────
    function injectStyles() {
      if (typeof document === 'undefined') return
      const marker = 'style[data-plugin="dsh-arxiv"]'
      if (document.querySelector(marker) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-arxiv'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function readJson(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        if (raw === null) return fallback
        const value = JSON.parse(raw)
        return value === null || value === undefined ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* storage may be full or disabled */
      }
    }

    function isAbortError(error) {
      return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORTED')
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function fmtNumber(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '0'
      return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n))
    }

    function fmtDate(value) {
      if (typeof value !== 'string' || value === '') return ''
      return value.slice(0, 10)
    }

    function fmtAuthors(authors) {
      const list = Array.isArray(authors) ? authors.filter((name) => typeof name === 'string') : []
      if (list.length === 0) return ''
      // arXiv citation metadata is "Last, First"; present it as "First Last".
      const names = list.map((name) => {
        const match = /^([^,]+),\s*(.+)$/.exec(name)
        return match === null ? name : `${match[2].trim()} ${match[1].trim()}`
      })
      if (names.length <= 6) return names.join(', ')
      return `${names.slice(0, 6).join(', ')} 等 ${names.length} 人`
    }

    function summaryKey(baseId, model) {
      return `${SUMMARY_KEY}${baseId}.${model.provider}/${model.model}`
    }

    function errorText(t, code, fallback) {
      const dict = t.error ?? {}
      if (typeof code === 'string' && typeof dict[code] === 'string') return dict[code]
      return fallback || String(code || t.errorTitle)
    }

    // ── host calls ────────────────────────────────────────────────────────────
    async function getJson(route, params, signal) {
      const query = new URLSearchParams(params || {}).toString()
      let response
      try {
        response = await fetch(`${ROUTE}/${route}${query ? `?${query}` : ''}`, {
          headers: { accept: 'application/json' },
          signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw Object.assign(new Error('network'), { code: 'network' })
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        throw Object.assign(new Error('bad response'), { code: 'parse' })
      }
      if (body === null || typeof body !== 'object') throw Object.assign(new Error('bad response'), { code: 'parse' })
      if (body.ok !== true) {
        const err = body.error ?? {}
        throw Object.assign(new Error(String(err.message ?? 'request failed')), {
          code: typeof err.code === 'string' ? err.code : 'internal',
        })
      }
      return body
    }

    async function postJson(route, payload, signal) {
      let response
      try {
        response = await fetch(`${ROUTE}/${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw Object.assign(new Error('network'), { code: 'network' })
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        throw Object.assign(new Error('bad response'), { code: 'parse' })
      }
      if (body === null || typeof body !== 'object') throw Object.assign(new Error('bad response'), { code: 'parse' })
      if (body.ok !== true) {
        const err = body.error ?? {}
        throw Object.assign(new Error(String(err.message ?? 'request failed')), {
          code: typeof err.code === 'string' ? err.code : 'internal',
        })
      }
      return body
    }

    /**
     * POST /dsh-arxiv/ai and dispatch its SSE records.
     * @returns {Promise<void>} resolves when the stream terminates
     */
    async function streamAi(body, handlers) {
      let response
      try {
        response = await fetch(`${ROUTE}/ai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: handlers.signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw Object.assign(new Error('network'), { code: 'network' })
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        let parsed = null
        try {
          parsed = await response.json()
        } catch {
          /* fall through */
        }
        const err = parsed && parsed.error ? parsed.error : {}
        throw Object.assign(new Error(String(err.message ?? 'request failed')), {
          code: typeof err.code === 'string' ? err.code : 'internal',
        })
      }
      if (!response.ok || response.body === null) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'network' })
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const dispatch = (record) => {
        if (record === null || typeof record !== 'object') return
        if (record.type === 'start') handlers.onStart?.(record)
        else if (record.type === 'delta') handlers.onDelta?.(typeof record.text === 'string' ? record.text : '')
        else if (record.type === 'reasoning') handlers.onReasoning?.()
        else if (record.type === 'done') handlers.onDone?.(record)
        else if (record.type === 'error') {
          handlers.onError?.({
            code: typeof record.code === 'string' ? record.code : 'internal',
            message: String(record.message ?? 'request failed'),
          })
        }
      }
      const consume = (raw) => {
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (json === '') continue
          let record = null
          try {
            record = JSON.parse(json)
          } catch {
            continue
          }
          dispatch(record)
        }
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // Normalize CRLF across chunk boundaries before splitting records.
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const raw = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            consume(raw)
            boundary = buffer.indexOf('\n\n')
          }
        }
        // A proxy may truncate the stream after the last record without the
        // final blank line; still process complete trailing data lines.
        const tail = buffer
        buffer = ''
        if (tail.trim() !== '') consume(tail)
      } finally {
        if (handlers.signal !== undefined && handlers.signal.aborted) {
          try {
            await reader.cancel()
          } catch {
            /* stream already closed */
          }
        }
        try {
          reader.releaseLock()
        } catch {
          /* already released */
        }
      }
    }

    // ── markdown (deliberately small: headings, lists, code, bold, links, math) ─
    const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\$[^$\n]+\$|\[[^\]\n]+\]\([^)\s]+\))/g

    function renderInline(text, keyBase) {
      const nodes = []
      let last = 0
      let match
      INLINE.lastIndex = 0
      while ((match = INLINE.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `${keyBase}-${match.index}`
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key }, token.slice(1, -1)))
        } else if (token.startsWith('$')) {
          nodes.push(h('span', { key, className: 'axv-math' }, token.slice(1, -1)))
        } else {
          const close = token.indexOf('](')
          const label = token.slice(1, close)
          const href = token.slice(close + 2, -1)
          // Model output is untrusted: only web/mail/anchor/relative links.
          if (!/^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(href)) {
            nodes.push(label)
          } else {
            nodes.push(h('a', {
              key,
              href,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, label))
          }
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes.length === 0 ? text : nodes
    }

    function renderMarkdown(text) {
      const source = typeof text === 'string' ? text : ''
      if (source.trim() === '') return []
      const lines = source.replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let key = 0
      const isListLine = (line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)
      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '') {
          index += 1
          continue
        }
        if (/^\s*```/.test(line)) {
          const code = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: key++ }, h('code', null, code.join('\n'))))
          continue
        }
        if (/^\s*\$\$/.test(line)) {
          const first = line.trim()
          let math = ''
          if (first.length > 4 && first.endsWith('$$')) {
            math = first.slice(2, -2)
            index += 1
          } else {
            const collected = [first.slice(2)]
            index += 1
            while (index < lines.length && !lines[index].includes('$$')) {
              collected.push(lines[index])
              index += 1
            }
            if (index < lines.length) {
              collected.push(lines[index].replace(/\$\$.*$/, ''))
              index += 1
            }
            math = collected.join('\n')
          }
          blocks.push(h('div', { key: key++, className: 'axv-math-block' }, math.trim()))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = Math.min(heading[1].length + 1, 6)
          blocks.push(h(`h${level}`, { key: key++ }, renderInline(heading[2].trim(), `h${key}`)))
          index += 1
          continue
        }
        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
          blocks.push(h('hr', { key: key++ }))
          index += 1
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: key++ }, quote.join('\n')))
          continue
        }
        if (isListLine(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const items = []
          while (index < lines.length && isListLine(lines[index])) {
            items.push(lines[index].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
            index += 1
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: key++ }, items.map((item, i) => (
            h('li', { key: i }, renderInline(item, `li${key}-${i}`))
          ))))
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length) {
          const next = lines[index]
          if (next.trim() === '' || /^\s*```/.test(next) || /^(#{1,6})\s+/.test(next) || isListLine(next) || /^\s*>\s?/.test(next)) break
          paragraph.push(next)
          index += 1
        }
        blocks.push(h('p', { key: key++ }, renderInline(paragraph.join('\n'), `p${key}`)))
      }
      return blocks
    }

    function Markdown({ text }) {
      const blocks = React.useMemo(() => renderMarkdown(text), [text])
      return h('div', { className: 'axv-md' }, blocks)
    }

    /**
     * Render extracted paper text: `## heading` lines become headings, blank
     * lines split paragraphs. Text is escaped by React and kept selectable.
     */
    function PaperText({ text }) {
      const blocks = React.useMemo(() => {
        const lines = String(text).replace(/\r\n/g, '\n').split('\n')
        const out = []
        let paragraph = []
        const flush = () => {
          if (paragraph.length === 0) return
          out.push({ type: 'p', text: paragraph.join('\n') })
          paragraph = []
        }
        for (const line of lines) {
          if (/^#{2,4}\s+/.test(line)) {
            flush()
            out.push({ type: 'h', text: line.replace(/^#{2,4}\s+/, '').trim() })
            continue
          }
          if (line.trim() === '') {
            flush()
            continue
          }
          paragraph.push(line)
        }
        flush()
        return out
      }, [text])
      return h('div', { className: 'axv-source-text', 'data-axv': 'source-text' },
        blocks.map((block, index) => block.type === 'h'
          ? h('h3', { key: index }, block.text)
          : h('p', { key: index }, block.text)))
    }

    // ── model directory bridge (session-scoped DSH model selection) ───────────
    function createModelBridge(ctx) {
      function directoryFor(sessionId) {
        const service = ctx.get('modelDirectories')
        if (service === undefined || service === null || typeof service.directoryFor !== 'function') {
          throw Object.assign(new Error('model selection service unavailable'), { code: 'model-unavailable' })
        }
        return service.directoryFor(sessionId)
      }
      return {
        async load(sessionId) {
          const directory = directoryFor(sessionId)
          const snapshot = await directory.load()
          return {
            current: snapshot.current ?? null,
            groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
            status: snapshot.status,
          }
        },
        async select(sessionId, selection) {
          const directory = directoryFor(sessionId)
          const result = await directory.select(selection)
          if (result && result.ok === false) {
            const err = result.error ?? {}
            throw Object.assign(new Error(String(err.message ?? 'select failed')), {
              code: typeof err.code === 'string' ? err.code : 'model-switch-failed',
            })
          }
          return selection
        },
      }
    }

    function currentModelName(groups, current) {
      if (!current) return ''
      for (const group of groups || []) {
        for (const model of group.models || []) {
          if (model.id === current.model) return model.name || model.id
        }
      }
      return current.model
    }

    function providerName(groups, current) {
      if (!current) return ''
      for (const group of groups || []) {
        if (group.id === current.provider) return group.name || group.id
      }
      return current.provider
    }

    /**
     * Lowest advertised reasoning effort for one model. A quick-read summary
     * uses it so provider-side thinking cannot eat the whole output budget.
     */
    function fastEffortFor(groups, current) {
      if (!current) return undefined
      let meta = null
      for (const group of groups || []) {
        if (group.id !== current.provider) continue
        for (const model of group.models || []) {
          if (model.id === current.model) { meta = model; break }
        }
        if (meta !== null) break
      }
      const efforts = meta && meta.reasoning && Array.isArray(meta.reasoning.efforts)
        ? meta.reasoning.efforts
        : []
      if (efforts.length === 0) return undefined
      const lower = (value) => String(value || '').toLowerCase()
      const off = efforts.find((effort) => lower(effort.id) === 'off')
      if (off !== undefined) return off.id
      const low = efforts.find((effort) => lower(effort.id) === 'low')
      if (low !== undefined) return low.id
      return efforts[0].id
    }

    // ── components ────────────────────────────────────────────────────────────
    function ModelPicker({ t, groups, current, onSelect, disabled }) {
      const [open, setOpen] = React.useState(false)
      const [switching, setSwitching] = React.useState(false)
      const rootRef = React.useRef(null)
      const label = currentModelName(groups, current) || ''
      const provider = providerName(groups, current)
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      const choose = async (group, model) => {
        if (switching) return
        setSwitching(true)
        try {
          await onSelect({
            provider: group.id,
            model: model.id,
            ...(current && current.model === model.id && current.reasoningEffort !== undefined
              ? { reasoningEffort: current.reasoningEffort }
              : {}),
          })
          setOpen(false)
        } finally {
          setSwitching(false)
        }
      }
      return h('div', { className: 'axv-model', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'axv-model-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': current ? `${provider} / ${label}` : t('modelEmpty'),
          title: current ? `${provider} / ${label}` : t('modelEmpty'),
          onClick: () => setOpen((value) => !value),
          disabled: disabled || switching,
        },
        h('span', { className: 'axv-model-provider' }, provider || t('model')),
        h('span', { className: 'axv-model-name', 'data-axv': 'model' }, label || t('modelLoading')),
        h('span', { style: { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } }, h(IconChevron))),
        open ? h('div', { className: 'axv-menu', role: 'listbox', 'aria-label': t('model') },
          groups.length === 0
            ? h('div', { className: 'axv-menu-empty' }, t('modelEmpty'))
            : groups.map((group) => [
              h('div', { key: `g-${group.id}`, className: 'axv-menu-group' }, group.name || group.id),
              (group.models || []).map((model) => {
                const selected = current !== null && current !== undefined
                  && current.provider === group.id && current.model === model.id
                return h('button', {
                  key: `${group.id}/${model.id}`,
                  type: 'button',
                  className: 'axv-menu-item',
                  role: 'option',
                  'aria-selected': selected,
                  'data-axv': 'model-option',
                  'data-current': selected ? 'true' : 'false',
                  title: model.description || `${group.name || group.id} / ${model.name || model.id}`,
                  disabled: switching,
                  onClick: () => choose(group, model),
                },
                h('span', { className: 'axv-menu-check' }, selected ? h(IconCheck) : null),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model.name || model.id))
              }),
            ]))
          : null)
    }

    function SessionPicker({ t, sessions, currentId, onSelect, disabled }) {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const current = sessions.find((session) => session.id === currentId) ?? null
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      return h('div', { className: 'axv-session', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'axv-session-trigger',
          'data-axv': 'session',
          title: t('sessionPick'),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          disabled,
          onClick: () => setOpen((value) => !value),
        },
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } }, t('targetSession')),
        h('span', { className: 'axv-session-label' }, current ? current.title || String(current.id).slice(0, 12) : t('sessionNone')),
        h('span', { style: { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } }, h(IconChevron))),
        open ? h('div', { className: 'axv-session-menu', role: 'listbox' },
          sessions.length === 0
            ? h('div', { className: 'axv-session-empty' }, t('sessionNone'))
            : sessions.map((session) => h('button', {
              key: String(session.id),
              type: 'button',
              className: 'axv-session-option',
              role: 'option',
              'data-axv': 'session-option',
              'data-current': session.id === currentId ? 'true' : 'false',
              onClick: () => { onSelect(session.id); setOpen(false) },
            },
            h('span', { className: 'axv-session-title' }, session.title || String(session.id).slice(0, 12)),
            h('span', { className: 'axv-session-sub' }, String(session.id))))) : null)
    }

    function LibraryChips({ t, items, currentId, onOpen, onTogglePin }) {
      if (items.length === 0) return null
      return h('div', { className: 'axv-library', 'data-axv': 'library' },
        h('span', { className: 'axv-kv' }, t('library')),
        items.map((item) => h('span', {
          key: item.id,
          className: 'axv-library-chip',
          'data-axv': 'library-item',
          'data-pinned': item.pinned ? 'true' : 'false',
          'data-current': item.id === currentId ? 'true' : 'false',
          title: `${item.id} ${item.title ?? ''}`,
          onClick: () => onOpen(item.id),
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.id),
        h('button', {
          type: 'button',
          className: 'axv-star',
          'data-axv': 'pin',
          title: item.pinned ? t('unpin') : t('pin'),
          'aria-label': item.pinned ? t('unpin') : t('pin'),
          onClick: (event) => { event.stopPropagation(); onTogglePin(item.id) },
        }, item.pinned ? '★' : '☆'))))
    }

    function SummarySection(props) {
      const {
        t, text, phase, source, modelLabel, cached, canUpgrade, onGenerate, onStop, onUpgrade, onCopy,
        copied, staleModel, reasoning,
      } = props
      const streaming = phase === 'streaming'
      return h('section', { className: 'axv-section' },
        h('div', { className: 'axv-section-head' },
          h('span', { className: 'axv-section-title' }, t('summary')),
          source ? h('span', { className: 'axv-section-caption' }, `${t('summaryFrom')} ${sourceLabel(t, source)}`) : null,
          cached ? h('span', { className: 'axv-tag' }, t('summaryCached')) : null,
          modelLabel ? h('span', { className: 'axv-section-caption' }, t('summaryBy', { model: modelLabel })) : null,
          h('span', { className: 'axv-spacer' }),
          text && !streaming ? h('button', {
            type: 'button',
            className: 'axv-btn axv-btn-ghost',
            onClick: onCopy,
          }, h(IconCopy), copied ? t('copied') : t('copy')) : null,
          streaming
            ? h('button', { type: 'button', className: 'axv-btn axv-btn-outline', 'data-axv': 'stop-summary', onClick: onStop }, h(IconStop), t('stop'))
            : h('button', {
              type: 'button',
              className: 'axv-btn axv-btn-outline',
              'data-axv': 'summarize',
              onClick: onGenerate,
            }, text ? t('regenerate') : t('summarize'))),
        canUpgrade ? h('div', { className: 'axv-upgrade' },
          h('span', null, t('upgrade')),
          h('button', {
            type: 'button',
            className: 'axv-btn axv-btn-ghost',
            'data-axv': 'upgrade',
            onClick: onUpgrade,
          }, t('upgradeAction'))) : null,
        staleModel ? h('div', { className: 'axv-upgrade' },
          h('span', null, t('summaryStale', { model: staleModel })),
          h('button', { type: 'button', className: 'axv-btn axv-btn-ghost', 'data-axv': 'summarize-stale', onClick: onGenerate }, t('regenerate'))) : null,
        h('div', { className: 'axv-summary', 'data-axv': 'summary' },
          text
            ? [h(Markdown, { key: 'md', text }),
              streaming ? h('span', { key: 'cursor', className: 'axv-cursor' }) : null]
            : h('div', { className: 'axv-placeholder' }, streaming
              ? (reasoning && text === '' ? t('thinking') : t('summaryStreaming'))
              : t('summaryIdle'))))
    }

    function sourceLabel(t, source) {
      if (source === 'ar5iv') return t('sourceAr5iv')
      if (source === 'arxiv-html') return t('sourceHtml')
      if (source === 'abstract') return t('sourceAbstract')
      return source
    }

    function QaSection(props) {
      const {
        t, paper, messages, question, onQuestion, onAsk, onStop, streaming, askRef, listRef, disabled,
      } = props
      return h('section', { className: 'axv-section' },
        h('div', { className: 'axv-section-head' },
          h('span', { className: 'axv-section-title' }, t('qa')),
          h('span', { className: 'axv-section-caption' }, t('qaHint'))),
        messages.length > 0 ? h('div', { className: 'axv-qa', 'data-axv': 'messages', ref: listRef },
          messages.map((message, index) => {
            if (message.role === 'user') {
              return h('div', { key: index, className: 'axv-msg axv-msg-user' },
                h('div', { className: 'axv-msg-role' }, t('you')),
                h('div', { className: 'axv-bubble' }, message.content))
            }
            const last = index === messages.length - 1
            return h('div', {
              key: index,
              className: `axv-msg axv-msg-assistant${message.error ? ' axv-msg-error' : ''}`,
            },
            h('div', { className: 'axv-msg-role' }, t('answer')),
            h('div', { className: 'axv-bubble', 'data-axv': 'answer' },
              message.error
                ? message.content
                : [h(Markdown, { key: 'md', text: message.content }),
                  last && message.streaming ? h('span', { key: 'cursor', className: 'axv-cursor' }) : null,
                  last && message.streaming && message.content === '' ? h('span', { key: 'thinking', className: 'axv-placeholder' }, t('thinking')) : null]))
          }))
          : null,
        paper !== null && messages.length === 0 ? h('div', { className: 'axv-suggest' },
          ['problem', 'method', 'limits'].map((key) => h('button', {
            key,
            type: 'button',
            className: 'axv-chip',
            disabled,
            onClick: () => onAsk(t(`suggestions.${key}`)),
          }, t(`suggestions.${key}`)))) : null,
        paper !== null ? h('div', { className: 'axv-ask' },
          h('textarea', {
            className: 'axv-input',
            'data-axv': 'ask-input',
            ref: askRef,
            rows: 1,
            placeholder: t('askPlaceholder'),
            value: question,
            disabled,
            onChange: (event) => onQuestion(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onAsk()
              }
            },
          }),
          streaming
            ? h('button', { type: 'button', className: 'axv-btn axv-btn-outline', 'data-axv': 'stop-ask', onClick: onStop }, h(IconStop), t('stop'))
            : h('button', {
              type: 'button',
              className: 'axv-btn axv-btn-primary',
              'data-axv': 'ask',
              onClick: () => onAsk(),
              disabled: disabled || question.trim() === '',
            }, t('ask'))) : null)
    }

    // ── the view ──────────────────────────────────────────────────────────────
    function View(props) {
      const t = props.t
      const models = props.models
      const faces = props.faces || {}
      const sessionState = typeof props.useSessions === 'function'
        ? props.useSessions((state) => state)
        : null
      const sessions = React.useMemo(() => {
        const state = sessionState
        if (!state || !Array.isArray(state.ids) || state.byId === undefined) return []
        return state.ids
          .map((id) => state.byId[id])
          .filter((row) => row !== undefined && row !== null && row.origin !== 'subagent')
          .slice(0, 40)
          .map((row) => ({
            id: row.id,
            title: row.displayTitle || row.title || String(row.id).slice(0, 12),
            running: row.running === true,
            updatedAt: row.updatedAt,
          }))
      }, [sessionState])
      const [targetSessionId, setTargetSessionId] = React.useState(() => {
        const stored = readJson(TARGET_SESSION_KEY, null)
        return typeof stored === 'string' ? stored : null
      })
      React.useEffect(() => {
        if (sessions.length === 0) return
        if (targetSessionId !== null && sessions.some((session) => String(session.id) === String(targetSessionId))) return
        const next = sessions[0].id
        setTargetSessionId(next)
        writeJson(TARGET_SESSION_KEY, next)
      }, [sessions, targetSessionId])
      const sessionId = targetSessionId
      const [attached, setAttached] = React.useState(null)
      const [library, setLibrary] = React.useState(() => {
        const stored = readJson(LIBRARY_KEY, [])
        return Array.isArray(stored) ? stored.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string').slice(0, LIBRARY_MAX) : []
      })
      const [notice, setNotice] = React.useState('')
      const noticeTimerRef = React.useRef(0)
      const [paper, setPaper] = React.useState(null)
      const [textInfo, setTextInfo] = React.useState(null)
      const [textPending, setTextPending] = React.useState(false)
      const [paperText, setPaperText] = React.useState(null)
      const [viewMode, setViewMode] = React.useState('split')
      const [importing, setImporting] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [recents, setRecents] = React.useState(() => {
        const stored = readJson(RECENT_KEY, [])
        return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string').slice(0, RECENT_MAX) : []
      })
      const [modelState, setModelState] = React.useState({ current: null, groups: [], ready: false, failed: false })
      const [summaryText, setSummaryText] = React.useState('')
      const [summaryPhase, setSummaryPhase] = React.useState('idle')
      const [summarySource, setSummarySource] = React.useState(null)
      const [summaryModel, setSummaryModel] = React.useState(null)
      const [summaryCached, setSummaryCached] = React.useState(false)
      const [summaryReasoning, setSummaryReasoning] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [sourceCopied, setSourceCopied] = React.useState(false)
      const [messages, setMessages] = React.useState([])
      const [question, setQuestion] = React.useState('')
      const [qaStreaming, setQaStreaming] = React.useState(false)

      const aliveRef = React.useRef(true)
      const importRef = React.useRef(null)
      const summaryAbortRef = React.useRef(null)
      const qaAbortRef = React.useRef(null)
      const paperRef = React.useRef(null)
      const textRef = React.useRef(null)
      const paperTextRef = React.useRef('')
      const aiPaneRef = React.useRef(null)
      const sourceTimerRef = React.useRef(0)
      const modelRef = React.useRef(null)
      const modelLoadRef = React.useRef(null)
      const loadedSessionRef = React.useRef(null)
      const summaryBufferRef = React.useRef('')
      const summaryFullRef = React.useRef('')
      const summaryReasoningRef = React.useRef(false)
      const summaryRafRef = React.useRef(0)
      const qaBufferRef = React.useRef('')
      const qaRafRef = React.useRef(0)
      const copyTimerRef = React.useRef(0)
      const listRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const askRef = React.useRef(null)
      const importInputRef = React.useRef(null)

      React.useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          importRef.current?.abort()
          summaryAbortRef.current?.abort()
          qaAbortRef.current?.abort()
          if (summaryRafRef.current) cancelAnimationFrame(summaryRafRef.current)
          if (qaRafRef.current) cancelAnimationFrame(qaRafRef.current)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          if (sourceTimerRef.current) clearTimeout(sourceTimerRef.current)
          if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        }
      }, [])

      const applyModelState = React.useCallback((state) => {
        const next = {
          current: state && state.current ? state.current : null,
          groups: state && Array.isArray(state.groups) ? state.groups : [],
          ready: state !== null,
          failed: state === null,
        }
        modelRef.current = next.current
        setModelState(next)
      }, [])

      const loadModels = React.useCallback(() => {
        if (!sessionId || !models) {
          applyModelState(null)
          return Promise.resolve(null)
        }
        if (loadedSessionRef.current !== sessionId) {
          loadedSessionRef.current = sessionId
          modelLoadRef.current = null
        }
        if (modelLoadRef.current !== null) return modelLoadRef.current
        const task = models.load(sessionId)
          .then((snapshot) => {
            applyModelState(snapshot)
            return snapshot
          })
          .catch(() => {
            applyModelState(null)
            return null
          })
          .finally(() => {
            modelLoadRef.current = null
          })
        modelLoadRef.current = task
        return task
      }, [applyModelState, models, sessionId])

      React.useEffect(() => {
        void loadModels()
        const onFocus = () => {
          if (modelLoadRef.current !== null || !aliveRef.current) return
          const target = sessionId
          models?.load(target).then((snapshot) => {
            if (aliveRef.current && snapshot && loadedSessionRef.current === target) applyModelState(snapshot)
          }).catch(() => {})
        }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [applyModelState, loadModels, models, sessionId])

      const pushSummary = React.useCallback((text) => {
        if (text === '') return
        summaryFullRef.current += text
        if (!aliveRef.current) return
        setSummaryText((current) => current + text)
      }, [])

      const queueSummary = React.useCallback((text) => {
        if (text === '') return
        summaryBufferRef.current += text
        if (summaryRafRef.current !== 0) return
        summaryRafRef.current = requestAnimationFrame(() => {
          summaryRafRef.current = 0
          const buffered = summaryBufferRef.current
          summaryBufferRef.current = ''
          pushSummary(buffered)
        })
      }, [pushSummary])

      const flushSummary = React.useCallback(() => {
        if (summaryRafRef.current !== 0) {
          cancelAnimationFrame(summaryRafRef.current)
          summaryRafRef.current = 0
        }
        const buffered = summaryBufferRef.current
        summaryBufferRef.current = ''
        pushSummary(buffered)
      }, [pushSummary])

      const queueAnswer = React.useCallback((text) => {
        if (text === '') return
        qaBufferRef.current += text
        if (qaRafRef.current !== 0) return
        qaRafRef.current = requestAnimationFrame(() => {
          qaRafRef.current = 0
          const buffered = qaBufferRef.current
          qaBufferRef.current = ''
          if (buffered === '' || !aliveRef.current) return
          setMessages((current) => {
            if (current.length === 0) return current
            const copy = current.slice()
            const last = copy[copy.length - 1]
            if (last.role !== 'assistant') return current
            copy[copy.length - 1] = Object.assign({}, last, { content: last.content + buffered })
            return copy
          })
        })
      }, [])

      const flushAnswer = React.useCallback(() => {
        if (qaRafRef.current !== 0) {
          cancelAnimationFrame(qaRafRef.current)
          qaRafRef.current = 0
        }
        const buffered = qaBufferRef.current
        qaBufferRef.current = ''
        if (buffered === '' || !aliveRef.current) return
        setMessages((current) => {
          if (current.length === 0) return current
          const copy = current.slice()
          const last = copy[copy.length - 1]
          if (last.role !== 'assistant') return current
          copy[copy.length - 1] = Object.assign({}, last, { content: last.content + buffered })
          return copy
        })
      }, [])

      const showError = React.useCallback((code, message) => {
        const text = errorText(t, code, message)
        setError(text)
        setStatus('')
      }, [t])

      const saveRecent = React.useCallback((entry) => {
        setRecents((current) => {
          const next = [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, RECENT_MAX)
          writeJson(RECENT_KEY, next)
          return next
        })
      }, [])

      const showNotice = React.useCallback((text) => {
        setNotice(text)
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = window.setTimeout(() => {
          if (aliveRef.current) setNotice('')
        }, 4000)
      }, [])

      const rememberPaper = React.useCallback((entry) => {
        setLibrary((current) => {
          const previous = current.find((item) => item.id === entry.id)
          const next = [
            { ...entry, pinned: previous?.pinned === true, updatedAt: Date.now() },
            ...current.filter((item) => item.id !== entry.id),
          ].slice(0, LIBRARY_MAX)
          writeJson(LIBRARY_KEY, next)
          return next
        })
      }, [])

      const togglePin = React.useCallback((id) => {
        setLibrary((current) => {
          const next = current.map((item) => item.id === id ? { ...item, pinned: item.pinned !== true } : item)
            .sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          writeJson(LIBRARY_KEY, next)
          return next
        })
      }, [])

      const refreshAttach = React.useCallback(async () => {
        if (!sessionId || typeof faces.getAttach !== 'function') {
          setAttached(null)
          return
        }
        try {
          const record = await faces.getAttach(sessionId)
          if (aliveRef.current) setAttached(record ?? null)
        } catch {
          if (aliveRef.current) setAttached(null)
        }
      }, [faces, sessionId])

      React.useEffect(() => {
        if (paper !== null) void refreshAttach()
      }, [paper, sessionId, refreshAttach])

      const toggleAttach = React.useCallback(async () => {
        if (!sessionId) {
          showNotice(t('needSession'))
          return
        }
        if (paper === null || typeof faces.attach !== 'function') return
        try {
          const detaching = attached !== null && attached.baseId === paper.baseId
          const result = await faces.attach(sessionId, detaching ? null : paper.id)
          if (aliveRef.current) setAttached(result ?? null)
          showNotice(result === null || result === undefined ? t('detach') : t('attached'))
        } catch (failure) {
          showError(failure.code, failure.message)
        }
      }, [attached, faces, paper, sessionId, showError, showNotice, t])

      const sendPromptToAgent = React.useCallback(async (text) => {
        if (!sessionId) {
          showNotice(t('needSession'))
          return false
        }
        if (typeof faces.sendPrompt !== 'function') {
          showError('send-failed', t('sendFailed', { message: 'session service unavailable' }))
          return false
        }
        try {
          if (paper !== null && (attached === null || attached.baseId !== paper.baseId) && typeof faces.attach === 'function') {
            try {
              const record = await faces.attach(sessionId, paper.id)
              if (aliveRef.current && record !== null && record !== undefined) setAttached(record)
            } catch {
              /* attachment is best effort for a send */
            }
          }
          await faces.sendPrompt(sessionId, text)
          showNotice(t('sendSent'))
          if (typeof faces.openConversation === 'function') faces.openConversation()
          return true
        } catch (failure) {
          showError('send-failed', t('sendFailed', { message: String(failure?.message ?? failure) }))
          return false
        }
      }, [attached, faces, paper, sessionId, showError, showNotice, t])

      const sendPaperToAgent = React.useCallback(() => {
        if (paper === null) return
        void sendPromptToAgent(`[dsh-arxiv] 我正在阅读 arXiv:${paper.id}《${paper.title}》。请结合这篇论文回答：它解决了什么问题、核心方法和主要结论是什么？`)
      }, [paper, sendPromptToAgent])

      const sendSelectionToAgent = React.useCallback(() => {
        if (paper === null) return
        const raw = typeof window.getSelection === 'function' ? String(window.getSelection() ?? '') : ''
        const selection = raw.trim().slice(0, SEL_MAX)
        if (selection === '') {
          showNotice(t('selectionEmpty'))
          return
        }
        void sendPromptToAgent(`[dsh-arxiv] 关于 arXiv:${paper.id} 的原文选段：\n> ${selection.replace(/\n/g, '\n> ')}\n\n请解释这段内容。`)
      }, [paper, sendPromptToAgent, showNotice, t])

      const startSummary = React.useCallback(async (targetPaper, options) => {
        const paperValue = targetPaper || paperRef.current
        if (!paperValue) return
        const model = modelRef.current
        if (!model) {
          showError('model-missing', t('needModel'))
          return
        }
        summaryAbortRef.current?.abort()
        const controller = new AbortController()
        summaryAbortRef.current = controller
        summaryBufferRef.current = ''
        summaryFullRef.current = ''
        summaryReasoningRef.current = false
        setSummaryText('')
        setSummarySource(null)
        setSummaryCached(false)
        setSummaryReasoning(false)
        setError(null)
        setSummaryPhase('streaming')
        const quality = options && options.quality
          ? options.quality
          : (textRef.current !== null && textRef.current.source !== 'abstract' ? 'deep' : 'fast')
        let source = null
        let terminal = false
        try {
          await streamAi({
            id: paperValue.id,
            mode: 'summary',
            quality,
            provider: model.provider,
            model: model.model,
            ...(() => {
              const effort = fastEffortFor(modelState.groups, model)
              return effort === undefined ? {} : { reasoningEffort: effort }
            })(),
          }, {
            signal: controller.signal,
            onStart: (record) => {
              source = typeof record.source === 'string' ? record.source : null
              if (aliveRef.current) setSummarySource(source)
            },
            onReasoning: () => {
              if (!aliveRef.current) return
              summaryReasoningRef.current = true
              setSummaryReasoning(true)
            },
            onDelta: (text) => {
              if (summaryReasoningRef.current) {
                summaryReasoningRef.current = false
                if (aliveRef.current) setSummaryReasoning(false)
              }
              queueSummary(text)
            },
            onDone: () => {
              terminal = true
              flushSummary()
              if (!aliveRef.current) return
              setSummaryPhase('done')
              setSummaryModel(model)
              const value = summaryFullRef.current
              if (value !== '') {
                writeJson(summaryKey(paperValue.baseId, model), {
                  text: value,
                  source,
                  model,
                  at: Date.now(),
                })
              }
            },
            onError: (failure) => {
              if (failure.code === 'ABORTED') return
              if (!aliveRef.current) return
              terminal = true
              flushSummary()
              setSummaryPhase('error')
              showError(failure.code, failure.message)
            },
          })
          if (!terminal && aliveRef.current) {
            // The stream ended without a terminal record (proxies can do this).
            flushSummary()
            setSummaryPhase('stopped')
          }
        } catch (failure) {
          if (isAbortError(failure)) {
            flushSummary()
            if (aliveRef.current) setSummaryPhase((phase) => (phase === 'streaming' ? 'stopped' : phase))
            return
          }
          flushSummary()
          if (aliveRef.current) {
            setSummaryPhase('error')
            showError(failure.code, failure.message)
          }
        } finally {
          if (summaryAbortRef.current === controller) summaryAbortRef.current = null
        }
      }, [flushSummary, modelState.groups, queueSummary, showError, t])

      const importPaper = React.useCallback(async (rawInput, options) => {
        const input = String(rawInput ?? '').trim()
        if (input === '') return
        const restoreOnly = options !== null && options !== undefined && options.restoreOnly === true
        importRef.current?.abort()
        summaryAbortRef.current?.abort()
        qaAbortRef.current?.abort()
        const controller = new AbortController()
        importRef.current = controller
        setImporting(true)
        setError(null)
        setStatus(t('importing'))
        setPaper(null)
        setTextInfo(null)
        setTextPending(false)
        setPaperText(null)
        setSummaryText('')
        setSummaryPhase('idle')
        setSummarySource(null)
        setSummaryModel(null)
        setSummaryCached(false)
        setMessages([])
        paperRef.current = null
        textRef.current = null
        paperTextRef.current = ''
        const textPromise = getJson('text', { id: input, body: '1' }, controller.signal)
          .then((body) => {
            if (importRef.current !== controller) return null
            const info = {
              source: body.source,
              chars: body.chars,
              sections: Array.isArray(body.sections) ? body.sections : [],
            }
            const text = typeof body.text === 'string' ? body.text : ''
            textRef.current = info
            paperTextRef.current = text
            if (aliveRef.current) {
              setTextPending(false)
              setTextInfo(info)
              setPaperText(text === '' ? null : text)
            }
            return info
          })
          .catch(() => {
            if (importRef.current === controller && aliveRef.current && !controller.signal.aborted) {
              setTextPending(false)
              setStatus(t('textAbstractOnly'))
            }
            return null
          })
        const stale = () => !aliveRef.current || importRef.current !== controller
        try {
          const body = await getJson('meta', { id: input }, controller.signal)
          if (stale()) return
          const imported = body.paper
          paperRef.current = imported
          setPaper(imported)
          setImporting(false)
          setTextPending(true)
          setStatus(t('loadingText'))
          setQuery('')
          if (!restoreOnly) {
            saveRecent({ id: imported.id, baseId: imported.baseId, title: imported.title })
            rememberPaper({ id: imported.id, baseId: imported.baseId, title: imported.title })
            writeJson(LAST_PAPER_KEY, imported.id)
          }
          // Start the model catalog immediately, but never let it delay the
          // first summary past the bounded text race below.
          const modelPromise = loadModels()
          await Promise.race([Promise.all([textPromise, modelPromise]), sleep(SUMMARY_WAIT_MS)])
          if (stale()) return
          if (modelRef.current === null) {
            await Promise.race([modelPromise, sleep(5000)])
            if (stale()) return
          }
          const model = modelRef.current
          const cached = model ? readJson(summaryKey(imported.baseId, model), null) : null
          const cachedValid = cached !== null && typeof cached === 'object' && typeof cached.text === 'string' && cached.text !== ''
          if (cachedValid) {
            summaryFullRef.current = cached.text
            setSummaryText(cached.text)
            setSummaryPhase('done')
            setSummarySource(typeof cached.source === 'string' ? cached.source : null)
            setSummaryModel(cached.model && typeof cached.model === 'object' ? cached.model : model)
            setSummaryCached(true)
            return
          }
          if (restoreOnly) return
          void startSummary(imported)
        } catch (failure) {
          if (isAbortError(failure)) return
          if (!aliveRef.current) return
          controller.abort()
          setImporting(false)
          setTextPending(false)
          showError(failure.code, failure.message)
          setStatus('')
        } finally {
          if (importRef.current === controller) importRef.current = null
        }
      }, [loadModels, saveRecent, showError, startSummary, t])

      // Reopen the last paper when the panel is mounted again (switching back
      // from the conversation must not lose the reading state).
      const restoreOnceRef = React.useRef(false)
      React.useEffect(() => {
        if (restoreOnceRef.current) return
        restoreOnceRef.current = true
        if (paperRef.current !== null) return
        const last = readJson(LAST_PAPER_KEY, null)
        if (typeof last === 'string' && last !== '') void importPaper(last, { restoreOnly: true })
      }, [importPaper])

      const onPickModel = React.useCallback(async (selection) => {
        if (!sessionId || !models) return
        try {
          const applied = await models.select(sessionId, selection)
          const next = {
            provider: applied.provider,
            model: applied.model,
            ...(applied.reasoningEffort === undefined ? {} : { reasoningEffort: applied.reasoningEffort }),
          }
          modelRef.current = next
          setModelState((current) => Object.assign({}, current, { current: next }))
          setError(null)
        } catch (failure) {
          showError(failure.code, t('modelSwitchFailed', { message: String(failure.message ?? failure) }))
        }
      }, [models, sessionId, showError, t])

      const stopSummary = React.useCallback(() => {
        summaryAbortRef.current?.abort()
      }, [])

      const stopAsk = React.useCallback(() => {
        qaAbortRef.current?.abort()
      }, [])

      const ask = React.useCallback(async (preset) => {
        const paperValue = paperRef.current
        if (!paperValue || qaStreaming) return
        const questionValue = String(preset ?? question).trim()
        if (questionValue === '') return
        const model = modelRef.current
        if (!model) {
          showError('model-missing', t('needModel'))
          return
        }
        qaAbortRef.current?.abort()
        const controller = new AbortController()
        qaAbortRef.current = controller
        qaBufferRef.current = ''
        setQuestion('')
        setError(null)
        setQaStreaming(true)
        const history = messages.slice(-6)
          .filter((message) => typeof message.content === 'string' && message.content !== '' && !message.error)
          .map((message) => ({ role: message.role, content: message.content }))
        setMessages((current) => [
          ...current,
          { role: 'user', content: questionValue },
          { role: 'assistant', content: '', streaming: true, error: false },
        ])
        const quality = textRef.current !== null && textRef.current.source !== 'abstract' ? 'deep' : 'fast'
        let terminal = false
        try {
          await streamAi({
            id: paperValue.id,
            mode: 'qa',
            quality,
            question: questionValue,
            history,
            provider: model.provider,
            model: model.model,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          }, {
            signal: controller.signal,
            onDelta: queueAnswer,
            onDone: () => {
              terminal = true
              flushAnswer()
              if (!aliveRef.current) return
              setQaStreaming(false)
              setMessages((current) => {
                const copy = current.slice()
                const last = copy[copy.length - 1]
                if (last && last.role === 'assistant') copy[copy.length - 1] = Object.assign({}, last, { streaming: false })
                return copy
              })
            },
            onError: (failure) => {
              terminal = true
              flushAnswer()
              if (!aliveRef.current) return
              setQaStreaming(false)
              setMessages((current) => {
                const copy = current.slice()
                const last = copy[copy.length - 1]
                if (last && last.role === 'assistant') {
                  copy[copy.length - 1] = Object.assign({}, last, {
                    streaming: false,
                    error: true,
                    content: last.content !== '' ? last.content : errorText(t, failure.code, failure.message),
                  })
                }
                return copy
              })
            },
          })
          if (!terminal && aliveRef.current) {
            // A truncated proxy stream can end with no done/error record.
            flushAnswer()
            setQaStreaming(false)
            setMessages((current) => {
              const copy = current.slice()
              const last = copy[copy.length - 1]
              if (last && last.role === 'assistant') copy[copy.length - 1] = Object.assign({}, last, { streaming: false })
              return copy
            })
          }
        } catch (failure) {
          if (isAbortError(failure)) {
            flushAnswer()
            if (aliveRef.current) {
              setQaStreaming(false)
              setMessages((current) => {
                const copy = current.slice()
                const last = copy[copy.length - 1]
                if (last && last.role === 'assistant') copy[copy.length - 1] = Object.assign({}, last, { streaming: false })
                return copy
              })
            }
            return
          }
          if (aliveRef.current) {
            flushAnswer()
            setQaStreaming(false)
            setMessages((current) => {
              const copy = current.slice()
              const last = copy[copy.length - 1]
              if (last && last.role === 'assistant') {
                copy[copy.length - 1] = Object.assign({}, last, {
                  streaming: false,
                  error: true,
                  content: errorText(t, failure.code, failure.message),
                })
              }
              return copy
            })
          }
        } finally {
          if (qaAbortRef.current === controller) qaAbortRef.current = null
        }
      }, [flushAnswer, messages, qaStreaming, question, queueAnswer, showError, t])

      React.useEffect(() => {
        const pane = aiPaneRef.current
        if (pane === null) return
        pane.scrollTop = pane.scrollHeight
      }, [messages])

      const copySummary = React.useCallback(async () => {
        const value = summaryFullRef.current
        if (value === '') return
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = window.setTimeout(() => {
            if (aliveRef.current) setCopied(false)
          }, 1500)
        } catch {
          /* clipboard may be blocked */
        }
      }, [])

      const copySource = React.useCallback(async () => {
        const value = paperTextRef.current
        if (value === '') return
        try {
          await navigator.clipboard.writeText(value)
          setSourceCopied(true)
          if (sourceTimerRef.current) clearTimeout(sourceTimerRef.current)
          sourceTimerRef.current = window.setTimeout(() => {
            if (aliveRef.current) setSourceCopied(false)
          }, 1500)
        } catch {
          /* clipboard may be blocked */
        }
      }, [])

      const SOURCE_DISPLAY_LIMIT = 150000
      const sourceTruncated = paperText !== null && paperText.length > SOURCE_DISPLAY_LIMIT
      const displaySource = paperText === null
        ? ''
        : (sourceTruncated ? paperText.slice(0, SOURCE_DISPLAY_LIMIT) : paperText)

      const fullTextReady = textInfo !== null && textInfo.source !== 'abstract'
      const summaryUsedAbstract = summarySource === 'abstract' || summarySource === null
      const canUpgrade = fullTextReady && summaryPhase === 'done' && summaryText !== '' && summaryUsedAbstract
      const currentModelLabel = modelRef.current
        ? currentModelName(modelState.groups, modelRef.current) || modelRef.current.model
        : ''
      const staleModel = summaryModel !== null && modelState.current !== null
        && (summaryModel.provider !== modelState.current.provider || summaryModel.model !== modelState.current.model)
        ? currentModelLabel
        : null
      const modelReady = modelState.current !== null

      React.useEffect(() => {
        if (paper !== null && textInfo !== null) {
          setStatus(textInfo.source === 'abstract'
            ? t('textAbstractOnly')
            : t('textReady', { source: sourceLabel(t, textInfo.source), chars: fmtNumber(textInfo.chars) }))
        }
      }, [paper, textInfo, t])

      const disabled = !modelReady || importing

      return h('div', { className: 'axv-root', 'data-axv': 'root', ref: rootRef },
        h('div', { className: 'axv-inner' },
          h('header', { className: 'axv-head' },
            h('div', { className: 'axv-brand' },
              h(IconDoc),
              h('span', { className: 'axv-brand-name' }, t('tab')),
              h('span', { className: 'axv-brand-sub' }, t('brandSub'))),
            h('span', { className: 'axv-spacer' }),
            h(SessionPicker, {
              t,
              sessions,
              currentId: targetSessionId,
              onSelect: (id) => {
                setTargetSessionId(id)
                writeJson(TARGET_SESSION_KEY, id)
              },
              disabled: importing,
            }),
            modelState.failed ? null : h(ModelPicker, {
              t,
              groups: modelState.groups,
              current: modelState.current,
              onSelect: onPickModel,
              disabled: importing,
            })),
          h('div', { className: 'axv-search' },
            h('input', {
              className: 'axv-input',
              'data-axv': 'query',
              ref: importInputRef,
              placeholder: t('queryPlaceholder'),
              value: query,
              spellCheck: false,
              autoComplete: 'off',
              disabled: importing,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void importPaper(query)
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'axv-btn axv-btn-primary',
              'data-axv': 'import',
              disabled: importing || query.trim() === '',
              onClick: () => void importPaper(query),
            }, importing ? t('importing') : t('import'))),
          recents.length > 0 ? h('div', { className: 'axv-recent' },
            h('span', { className: 'axv-kv' }, t('recent')),
            recents.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'axv-chip',
              title: `${item.id} ${item.title}`,
              onClick: () => void importPaper(item.id),
            }, item.id))) : null,
          library.length > 0
            ? h(LibraryChips, {
              t,
              items: library,
              currentId: paper !== null ? paper.id : null,
              onOpen: (id) => void importPaper(id),
              onTogglePin: togglePin,
            })
            : null,
          paper !== null ? h('div', { className: 'axv-actions' },
            h('button', {
              type: 'button',
              className: 'axv-attach',
              'data-axv': 'attach',
              'data-attached': attached !== null && attached.baseId === paper.baseId ? 'true' : 'false',
              'aria-pressed': attached !== null && attached.baseId === paper.baseId,
              title: t('attachHint'),
              disabled: importing || !sessionId,
              onClick: () => void toggleAttach(),
            },
            h('span', { className: 'axv-attach-dot' }),
            attached !== null && attached.baseId === paper.baseId ? t('attached') : t('attach')),
            h('button', {
              type: 'button',
              className: 'axv-btn axv-btn-outline',
              'data-axv': 'send-agent',
              title: attached !== null && attached.baseId === paper.baseId ? t('agentReadable') : t('attachHint'),
              disabled: !sessionId || typeof faces.sendPrompt !== 'function',
              onClick: () => sendPaperToAgent(),
            }, t('sendAgent')),
            h('button', {
              type: 'button',
              className: 'axv-btn axv-btn-ghost',
              onClick: () => { if (typeof faces.openConversation === 'function') faces.openConversation() },
            }, t('backConversation')),
            notice !== '' ? h('span', { className: 'axv-toast', 'data-axv': 'notice' }, notice) : null,
            h('span', { className: 'axv-spacer' }),
            textInfo !== null ? h('span', { className: 'axv-section-caption' },
              `${sourceLabel(t, textInfo.source)} · ${fmtNumber(textInfo.chars)} 字`) : null)
            : null,
          error !== null ? h('div', { className: 'axv-error', 'data-axv': 'error', role: 'alert' }, error) : null,
          status !== '' ? h('div', { className: 'axv-status', 'data-axv': 'status' },
            (importing || textPending) ? h('span', { className: 'axv-dot' }) : null,
            h('span', null, status)) : null,
          paper === null
            ? h('div', { className: 'axv-empty' },
              h('div', { className: 'axv-empty-title' }, t('emptyTitle')),
              h('div', { className: 'axv-empty-sub' }, t('emptySub')),
              h('div', { className: 'axv-examples' },
                h('span', { className: 'axv-kv' }, t('examples')),
                [
                  { id: '1706.03762', title: 'Attention Is All You Need' },
                  { id: '2005.14165', title: 'Language Models are Few-Shot Learners' },
                  { id: '2401.12345', title: 'arXiv 示例' },
                ].map((item) => h('button', {
                  key: item.id,
                  type: 'button',
                  className: 'axv-example',
                  onClick: () => void importPaper(item.id),
                },
                h('span', { className: 'axv-example-id' }, item.id),
                h('span', { className: 'axv-example-title' }, item.title)))))
            : h(React.Fragment, null,
              h('article', { className: 'axv-card' },
                h('div', { className: 'axv-paper-head' },
                  h('h2', { className: 'axv-paper-title', 'data-axv': 'title' }, paper.title),
                  h('div', { className: 'axv-paper-meta' },
                    fmtAuthors(paper.authors) !== '' ? h('span', { className: 'axv-paper-authors' }, fmtAuthors(paper.authors)) : null,
                    paper.published ? h('span', null, fmtDate(paper.published)) : null,
                    paper.primaryCategory ? h('span', { className: 'axv-tag' }, paper.primaryCategory) : null,
                    h('span', { className: 'axv-tag' }, paper.id)),
                  h('div', { className: 'axv-links' },
                    h('a', { className: 'axv-link', href: paper.absUrl, target: '_blank', rel: 'noreferrer noopener' }, 'abs', h(IconArrow)),
                    h('a', { className: 'axv-link', href: paper.pdfUrl, target: '_blank', rel: 'noreferrer noopener' }, 'PDF', h(IconArrow)),
                    h('a', { className: 'axv-link', href: paper.htmlUrl, target: '_blank', rel: 'noreferrer noopener' }, 'HTML', h(IconArrow))),
                  paper.abstract ? h('p', { className: 'axv-abstract' }, paper.abstract) : null)),
              h('div', { className: 'axv-modebar' },
                h('div', { className: 'axv-seg', role: 'group', 'aria-label': t('modes') },
                  [
                    ['split', t('paneSplit'), 'mode-split'],
                    ['ai', t('paneAi'), 'mode-ai'],
                    ['source', t('paneSource'), 'mode-source'],
                  ].map(([mode, label, hook]) => h('button', {
                    key: mode,
                    type: 'button',
                    className: 'axv-seg-btn',
                    'data-axv': hook,
                    'data-active': viewMode === mode ? 'true' : 'false',
                    'aria-pressed': viewMode === mode,
                    onClick: () => setViewMode(mode),
                  }, label))),
                h('span', { className: 'axv-spacer' }),
                textInfo !== null ? h('span', { className: 'axv-section-caption' },
                  `${sourceLabel(t, textInfo.source)} · ${fmtNumber(textInfo.chars)} 字`) : null),
              h('div', { className: `axv-workspace axv-mode-${viewMode}` },
                h('div', { className: 'axv-pane axv-ai-pane', ref: aiPaneRef },
                  h(SummarySection, {
                    t,
                    text: summaryText,
                    phase: summaryPhase,
                    source: summarySource,
                    modelLabel: summaryModel
                      ? currentModelName(modelState.groups, summaryModel) || summaryModel.model
                      : null,
                    cached: summaryCached,
                    canUpgrade,
                    reasoning: summaryReasoning,
                    staleModel: staleModel !== null && summaryText !== '' ? staleModel : null,
                    copied,
                    onGenerate: () => void startSummary(paper),
                    onStop: stopSummary,
                    onUpgrade: () => void startSummary(paper, { quality: 'deep' }),
                    onCopy: () => void copySummary(),
                  }),
                  h(QaSection, {
                    t,
                    paper,
                    messages,
                    question,
                    onQuestion: setQuestion,
                    onAsk: (preset) => void ask(preset),
                    onStop: stopAsk,
                    streaming: qaStreaming,
                    askRef,
                    listRef,
                    disabled,
                  })),
                h('div', { className: 'axv-pane axv-source-pane', 'data-axv': 'source' },
                  h('div', { className: 'axv-pane-head' },
                    h('span', { className: 'axv-section-title' }, t('sourcePane')),
                    textInfo !== null ? h('span', { className: 'axv-section-caption' },
                      `${sourceLabel(t, textInfo.source)} · ${fmtNumber(textInfo.chars)} 字`) : null,
                    h('span', { className: 'axv-spacer' }),
                    h('button', {
                      type: 'button',
                      className: 'axv-btn axv-btn-ghost',
                      'data-axv': 'send-selection',
                      title: t('sendSelection'),
                      disabled: !sessionId || typeof faces.sendPrompt !== 'function',
                      onClick: () => sendSelectionToAgent(),
                    }, t('sendSelection')),
                    paperText !== null && paperText !== '' ? h('button', {
                      type: 'button',
                      className: 'axv-btn axv-btn-ghost',
                      'data-axv': 'source-copy',
                      onClick: () => void copySource(),
                    }, h(IconCopy), sourceCopied ? t('sourceCopied') : t('copySource')) : null),
                  paperText === null || paperText === ''
                    ? h('div', { className: 'axv-placeholder' }, textPending ? t('sourceLoading') : t('sourceEmpty'))
                    : h(React.Fragment, null,
                      h(PaperText, { text: displaySource }),
                      sourceTruncated
                        ? h('div', { className: 'axv-placeholder' }, t('sourceTruncated', { chars: fmtNumber(SOURCE_DISPLAY_LIMIT) }))
                        : null,
                      h('div', { className: 'axv-kv' }, t('sourceNote'))))),
              h('div', { className: 'axv-foot' },
                h('span', null, 'dsh-arxiv · arXiv 内容版权归原作者所有'),
                h('span', { className: 'axv-spacer' }),
                modelState.failed ? h('span', null, t('modelUnavailable')) : null))))
    }

    // ── plugin body ───────────────────────────────────────────────────────────
    function translateFor(locale) {
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        return (key) => {
          const value = key.split('.').reduce((node, part) => (node === undefined ? undefined : node[part]), zh)
          return typeof value === 'string' ? value : key
        }
      }
      try {
        const bound = locale.bind(NS)
        return (key, vars) => {
          try {
            const value = vars === undefined ? bound(key) : bound(key, vars)
            return typeof value === 'string' ? value : key
          } catch {
            return key
          }
        }
      } catch {
        return (key) => key
      }
    }

    function apply(ctx) {
      injectStyles()
      if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
        ctx.effect(() => {
          const disposers = []
          try {
            disposers.push(ctx.locale.register(NS, 'zh', zh))
            disposers.push(ctx.locale.register(NS, 'en', en))
          } catch {
            /* locale is optional for this plugin */
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* already disposed */
              }
            }
          }
        }, 'dsh-arxiv: dictionaries')
      }
      const t = translateFor(ctx.locale)
      const models = createModelBridge(ctx)
      const faces = {
        async sendPrompt(sessionId, text) {
          const sessions = ctx.get('sessions')
          if (sessions === undefined || sessions === null) throw new Error('session service unavailable')
          const result = await sessions.using(sessionId, { source: 'gateway' }, (reference) => (
            reference.binding.session.prompt([{ type: 'text', text }], 'queue')
          ))
          if (result !== null && result !== undefined && result.ok === false) {
            const failure = result.error ?? {}
            throw Object.assign(new Error(String(failure.message ?? 'prompt failed')), {
              code: typeof failure.code === 'string' ? failure.code : 'send-failed',
            })
          }
          return true
        },
        async attach(sessionId, paperId) {
          const body = await postJson('attach', { sessionId, paperId })
          return body.attached ?? null
        },
        async getAttach(sessionId) {
          const body = await getJson('attach', { sessionId })
          return body.attached ?? null
        },
        openConversation() {
          const layout = ctx.get('layout')
          if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
            try {
              layout.selectPanel(null)
            } catch {
              /* conversation may be unavailable in this composition */
            }
          }
        },
      }
      const PanelWithFaces = (props) => h('div', {
        className: 'axv-panel-wrap',
        'data-axv': 'panel',
      }, h(View, Object.assign({}, props, { t, models, faces })))
      PanelWithFaces.displayName = 'ArxivPanel'
      // Left sidebar plugin entry: a global panel, independent of any Session.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'arxiv',
        order: 20,
        label: () => t('panel'),
        locale: NS,
      }, ArxivPanelIcon))
      // The panel body in the layout's root-scoped keyed `main` slot.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'arxiv',
        locale: NS,
      }, PanelWithFaces))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
