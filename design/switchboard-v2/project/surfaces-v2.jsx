// SwitchBoard v2 — new surfaces (13 new + refresh deltas)
// Loaded after panel.jsx, modals.jsx; exposes new components on window.

const { useState: vS, useEffect: vE, useRef: vR } = React;

// ─────────────────────────────────────────────────────────────────────────
// 1) DÉJÀ-VU pop on text highlight (anchored above the selection)
// ─────────────────────────────────────────────────────────────────────────
function DejaVu({ onClose, onJump }) {
  return (
    <div className="deja-pop" role="dialog" aria-label="Déjà-vu — prior thread found">
      <div className="deja-head">
        <span className="dot signal"/>
        <span>Seen this before</span>
        <span className="meta">3 prior threads</span>
        <button className="close" onClick={onClose} aria-label="Dismiss">{I.x}</button>
      </div>
      <div className="deja-list">
        {[
          { id:"d1", prov:"claude", title:"Threat model — replay defense", ago:"14 days ago", score:0.92, snippet:"…use HMAC-SHA256 and keep tolerance under ±2 minutes for production replay defense…" },
          { id:"d2", prov:"gpt",    title:"Stripe webhook tolerance review", ago:"32 days ago", score:0.78, snippet:"5 min is too generous; tighten to 2 min server-side." },
          { id:"d3", prov:"web",    title:"stripe.com/docs/webhooks/signatures", ago:"14 days ago", score:0.71, snippet:"Stripe-Signature header includes timestamp; reject if too old." },
        ].map(r=>(
          <button key={r.id} className="deja-row" onClick={()=>onJump && onJump(r)}>
            <div className="r1">
              <span className={"chip "+r.prov}>{PROVIDER_LABEL[r.prov]}</span>
              <span className="title">{r.title}</span>
              <span className="score" title="similarity">{r.score.toFixed(2)}</span>
            </div>
            <div className="r2">{r.snippet}</div>
            <div className="r3"><span>{r.ago}</span><span className="jump">jump ›</span></div>
          </button>
        ))}
      </div>
      <div className="deja-foot">
        <span className="muted">on-device · vector recall</span>
        <button onClick={onClose}>Don't show again for this page</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2) ANNOTATION VISUAL OVERLAY — restored highlights when revisiting page
// ─────────────────────────────────────────────────────────────────────────
function AnnotationsOverlay({ onOpen }) {
  return (
    <div className="ann-overlay" aria-hidden="true">
      {/* margin marker */}
      <div className="ann-margin" style={{top:"38%"}} onClick={()=>onOpen && onOpen("a1")} title="1 annotation in this region">
        <span className="dot signal"/>
        <span className="ann-tag">1</span>
      </div>
      <div className="ann-margin" style={{top:"54%"}} onClick={()=>onOpen && onOpen("a2")} title="2 annotations in this region">
        <span className="dot amber"/>
        <span className="ann-tag">2</span>
      </div>
      {/* hint */}
      <div className="ann-hint">
        <span className="dot signal"/>
        2 annotations restored on this page
        <button onClick={()=>onOpen && onOpen("all")}>Open in panel</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 3) CODING SESSION ATTACH OFFER — banner variant (vs the modal)
// ─────────────────────────────────────────────────────────────────────────
function CodingOfferBanner({ onAccept, onDismiss }) {
  return (
    <div className="sp-banner offer">
      <span className="b-glyph">{I.code}</span>
      <div className="b-body">
        <div><b>Codex session detected</b></div>
        <div className="muted">cwd <code>~/code/switchboard</code> · branch <code>feat/dispatch-safety</code></div>
      </div>
      <div className="b-actions">
        <button className="b-ghost" onClick={onDismiss}>Dismiss</button>
        <button className="b-primary" onClick={onAccept}>Attach to MVP PRD</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 4) UPDATE-AVAILABLE BANNER — companion behind
// ─────────────────────────────────────────────────────────────────────────
function UpdateBanner({ onUpdate, onLater }) {
  return (
    <div className="sp-banner info">
      <span className="b-glyph">{I.refresh}</span>
      <div className="b-body">
        <div><b>Companion update — 0.4.2 → 0.5.1</b></div>
        <div className="muted">released 6 days ago · gated · review notes</div>
      </div>
      <div className="b-actions">
        <button className="b-ghost" onClick={onLater}>Later</button>
        <button className="b-primary" onClick={onUpdate}>Update</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 5) NEEDS-ORGANIZE PANEL — per-row workstream suggestion
// ─────────────────────────────────────────────────────────────────────────
function NeedsOrganizeRow({ it, onAccept, onPick, onDismiss }) {
  return (
    <div className="item nx">
      <div className="row1">
        <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-3)"}}>{typeIcon(it.type)}</span>
        <span className="title">{it.title}</span>
      </div>
      <div className="row2">
        <span className={"chip "+it.prov}>{PROVIDER_LABEL[it.prov]}</span>
        <span style={{flex:1}}>{it.ago}</span>
      </div>
      <div className="suggest">
        <span className="lead">Looks like →</span>
        <span className="ws-sug">
          <span className="dot green"/>
          <b>{it.suggest || "Switchboard / MVP PRD"}</b>
          <span className="conf">0.{Math.floor(70+Math.random()*25)}</span>
        </span>
        <div className="acts">
          <button onClick={()=>onAccept && onAccept(it)}>Accept</button>
          <button onClick={()=>onPick && onPick(it)}>Pick…</button>
          <button onClick={()=>onDismiss && onDismiss(it)}>×</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 6) COMPOSER SCOPE-PICKER SUGGESTIONS — top-3 inline
// ─────────────────────────────────────────────────────────────────────────
function ScopeSuggestions({ value, onChange }) {
  const sugs = [
    { id:"sb_mvp", n:"Switchboard / MVP PRD", c:0.91, why:"4 shared captures · same week" },
    { id:"sb_arch", n:"Switchboard / Architecture", c:0.74, why:"references state machine" },
    { id:"stripe", n:"Stripe webhook flow", c:0.62, why:"shared link" },
  ];
  return (
    <div className="scope-sugs">
      <div className="scope-sugs-head">
        <span>Suggested scope</span>
        <span className="muted">on-device match</span>
      </div>
      <div className="scope-sugs-rows">
        {sugs.map(s=>(
          <button key={s.id} className={"scope-sug"+(value===s.id?" on":"")} onClick={()=>onChange && onChange(s.id)}>
            <span className="conf-bar"><span style={{width:(s.c*100)+"%"}}/></span>
            <div className="r1">
              <span className="check">{value===s.id ? I.check : null}</span>
              <span className="name">{s.n}</span>
              <span className="conf-num">{s.c.toFixed(2)}</span>
            </div>
            <div className="r2">{s.why}</div>
          </button>
        ))}
      </div>
      <button className="scope-pick">or pick manually…</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 7) LINKED-NOTES PANEL — Obsidian deep-links inside Workstream detail
// ─────────────────────────────────────────────────────────────────────────
function LinkedNotes() {
  const notes = [
    { id:"n1", title:"mvp-prd.md", path:"_BAC/workstreams/switchboard/", edited:"2026-04-26 09:14", pinned:true },
    { id:"n2", title:"dispatch-safety.md", path:"_BAC/workstreams/switchboard/", edited:"2026-04-25 17:02" },
    { id:"n3", title:"replay-defense-meeting.md", path:"_BAC/captures/", edited:"2026-04-22 14:31" },
  ];
  return (
    <div className="linked-notes">
      {notes.map(n=>(
        <a key={n.id} className="ln-row" href="#" onClick={e=>e.preventDefault()}>
          <span className="ln-icon">{I.doc}</span>
          <div className="ln-body">
            <div className="r1">
              <span className="title">{n.title}</span>
              {n.pinned && <span className="pin-tag">pinned</span>}
            </div>
            <div className="r2"><code>{n.path}</code> · edited {n.edited}</div>
          </div>
          <span className="ln-ext" title="open in Obsidian">{I.external}</span>
        </a>
      ))}
      <button className="ln-add">{I.plus} Link a note…</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 8) WORKSTREAM-TRUST TOGGLE — per-tool allow-list (default deny)
// ─────────────────────────────────────────────────────────────────────────
function TrustToggles() {
  const [t, setT] = vS({ move:false, queue:true, bump:false, archive:false });
  const tools = [
    ["queue",   "queue_followup",   "queue an outbound follow-up to a provider"],
    ["move",    "move_thread",      "move a tracked thread to this workstream"],
    ["bump",    "bump_priority",    "raise priority on a queued ask"],
    ["archive", "archive_thread",   "archive a tracked thread"],
  ];
  return (
    <div className="trust-toggles">
      <div className="trust-head">
        <span className="lock">{I.lock}</span>
        <div>
          <div className="t1">MCP write tools — default deny</div>
          <div className="t2">Tools not on this list refuse with <code>NOT_TRUSTED</code>.</div>
        </div>
      </div>
      {tools.map(([k,name,desc])=>(
        <label key={k} className={"trust-row"+(t[k]?" on":"")} onClick={()=>setT({...t, [k]:!t[k]})}>
          <span className="cb"/>
          <div className="body">
            <div className="r1"><code>{name}</code></div>
            <div className="r2">{desc}</div>
          </div>
          <span className="state">{t[k] ? "allow" : "deny"}</span>
        </label>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 9) CAPTURE-HEALTH DIAGNOSTICS — full panel surface
// ─────────────────────────────────────────────────────────────────────────
function HealthPanel({ onClose }) {
  const [copied, setCopied] = vS(false);
  return (
    <div className="sp-body health">
      <div className="health-head">
        <button className="sb-btn" onClick={onClose} style={{padding:"4px 8px"}}>{I.back}</button>
        <span className="title">Capture health</span>
        <span className="muted">snapshot · 09:14:02</span>
      </div>
      {/* 4 cards */}
      <div className="health-grid">
        <div className="hc">
          <div className="hc-lbl">queue depth</div>
          <div className="hc-num">3</div>
          <div className="hc-bar"><span style={{width:"15%"}}/></div>
          <div className="hc-foot">cap 20 · ok</div>
        </div>
        <div className="hc warn">
          <div className="hc-lbl">last capture</div>
          <div className="hc-num small">8m ago</div>
          <div className="hc-foot">claude.ai · last err 2h ago</div>
        </div>
        <div className="hc">
          <div className="hc-lbl">recall index</div>
          <div className="hc-num small">12.4k</div>
          <div className="hc-foot">vectors · 28 MB · last build 2h</div>
        </div>
        <div className="hc">
          <div className="hc-lbl">vault writable</div>
          <div className="hc-num small ok">yes</div>
          <div className="hc-foot">~/Documents/SwitchBoard-vault</div>
        </div>
      </div>

      <div className="hp-sec">
        <div className="hp-sec-head">By provider · last 24h</div>
        {[
          ["claude",  "Claude",  18, 0,  "8m ago",  "ok"],
          ["gpt",     "ChatGPT", 24, 1,  "12m ago", "ok"],
          ["gemini",  "Gemini",  4,  0,  "2h ago",  "ok"],
          ["codex",   "Codex",   2,  2,  "yesterday", "warn"],
        ].map(([k,l,ok,err,last,st])=>(
          <div key={k} className="hp-row">
            <span className={"chip "+k}>{l}</span>
            <span className="hp-num">{ok}<span className="muted"> ok</span></span>
            <span className={"hp-num"+(err>0?" err":"")}>{err}<span className="muted"> err</span></span>
            <span className="muted hp-last">{last}</span>
            <span className={"pill "+(st==="warn"?"pending":"noted")}>{st}</span>
          </div>
        ))}
      </div>

      <div className="hp-sec">
        <div className="hp-sec-head">Recent errors</div>
        <div className="hp-err">
          <div className="r1">
            <span className="dot amber"/>
            <code>codex.capture · timeout</code>
            <span className="muted">2 occurrences · last yesterday 22:14</span>
          </div>
          <div className="r2 muted">net::ERR_TIMED_OUT on chatgpt.com/codex/c/…</div>
        </div>
      </div>

      <div className="hp-foot">
        <button className="sb-btn" onClick={()=>{setCopied(true); setTimeout(()=>setCopied(false), 1500);}}>
          {copied ? <span style={{display:"inline-flex", gap:6, alignItems:"center"}}>{I.check} Copied</span> : "Copy diagnostics"}
        </button>
        <button className="sb-btn">Re-index</button>
        <button className="sb-btn">Open log</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 10) SETTINGS V2 — service-install, import/export, MCP, vault buckets
// ─────────────────────────────────────────────────────────────────────────
function SettingsV2({ onClose, onOpenHealth }) {
  const [autoTrack, setAutoTrack] = vS(true);
  const [ssAuto, setSsAuto] = vS(true);
  const [serviceOn, setServiceOn] = vS(false);
  const [serviceConsent, setServiceConsent] = vS(false);
  const [importDiff, setImportDiff] = vS(false);

  const sections = [
    { id:"track",  l:"Tracking" },
    { id:"priv",   l:"Privacy" },
    { id:"comp",   l:"Companion" },
    { id:"svc",    l:"Run on startup" },
    { id:"vault",  l:"Vaults & buckets" },
    { id:"mcp",    l:"MCP hosts" },
    { id:"port",   l:"Portability" },
    { id:"disp",   l:"Dispatch" },
    { id:"diag",   l:"Diagnostics" },
    { id:"about",  l:"About" },
  ];

  return (
    <div className="sp-body settings-v2">
      <div className="settings-head">
        <button className="sb-btn" onClick={onClose} style={{padding:"4px 8px"}}>{I.back}</button>
        <span className="title">Settings</span>
      </div>

      <div className="settings-toc">
        {sections.map(s=><a key={s.id} href={"#sec-"+s.id} className="toc-link">{s.l}</a>)}
      </div>

      {/* Tracking */}
      <SecBlock id="track" title="Tracking">
        <RowSwitch on={autoTrack} onClick={()=>setAutoTrack(!autoTrack)}
          label="Auto-track new providers" desc="Watches chat.openai.com, claude.ai, gemini.google.com"/>
      </SecBlock>

      {/* Privacy */}
      <SecBlock id="priv" title="Privacy">
        <RowSwitch on={ssAuto} onClick={()=>setSsAuto(!ssAuto)}
          label="Screen-share-safe auto-detect"
          desc="Masks tracked-item titles when getDisplayMedia is active"/>
      </SecBlock>

      {/* Companion */}
      <SecBlock id="comp" title="Companion">
        <div className="kv-row">
          <span className="pill ready"><span className="dot green"/> running</span>
          <span className="muted mono">:7331 · v0.4.2</span>
        </div>
        <div className="kv-row mono">
          <span className="muted">vault</span>
          <span>~/Documents/SwitchBoard-vault</span>
        </div>
      </SecBlock>

      {/* Run on startup — service install consent */}
      <SecBlock id="svc" title="Run on startup">
        <RowSwitch on={serviceOn} onClick={()=>{
          if (!serviceOn && !serviceConsent) { setServiceConsent(true); return; }
          setServiceOn(!serviceOn);
        }}
          label="Launch companion at login"
          desc={serviceOn ? "active · launchd / systemd" : "currently manual — captures pause when you quit Chrome"}/>
        {serviceConsent && !serviceOn && (
          <div className="consent-card">
            <div className="cc-head">
              <span>{I.alert}</span>
              <b>Confirm what gets installed</b>
            </div>
            <ul className="cc-list">
              <li><code>~/Library/LaunchAgents/com.switchboard.companion.plist</code> <span className="muted">(macOS)</span></li>
              <li><code>~/.config/systemd/user/switchboard.service</code> <span className="muted">(Linux)</span></li>
              <li><code>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</code> <span className="muted">(Windows)</span></li>
            </ul>
            <div className="cc-note">No admin/root required. Removable from Settings.</div>
            <div className="cc-actions">
              <button className="sb-btn" onClick={()=>setServiceConsent(false)}>Cancel</button>
              <button className="sb-btn primary" onClick={()=>{ setServiceOn(true); setServiceConsent(false); }}>Install</button>
            </div>
          </div>
        )}
      </SecBlock>

      {/* Vaults & buckets */}
      <SecBlock id="vault" title="Vaults & buckets">
        <div className="muted" style={{marginBottom:8, fontFamily:"var(--mono)", fontSize:11}}>route captures by workstream / provider / url glob → vault</div>
        {[
          { id:"b1", rule:"workstream:Switchboard/*",     vault:"~/Documents/SwitchBoard-vault", def:false },
          { id:"b2", rule:"provider:codex",                vault:"~/Documents/code-vault",         def:false },
          { id:"b3", rule:"url:stripe.com/*",              vault:"~/Documents/SwitchBoard-vault", def:false },
          { id:"b4", rule:"* (default)",                   vault:"~/Documents/SwitchBoard-vault", def:true  },
        ].map(b=>(
          <div key={b.id} className="bucket-row">
            <code className="bucket-rule">{b.rule}</code>
            <span className="bucket-arrow">→</span>
            <code className="bucket-vault">{b.vault}</code>
            {!b.def && <button className="bucket-x" aria-label="remove">{I.x}</button>}
          </div>
        ))}
        <button className="sb-btn" style={{marginTop:8}}>{I.plus} Add bucket</button>
      </SecBlock>

      {/* MCP hosts */}
      <SecBlock id="mcp" title="MCP hosts">
        <div className="muted" style={{marginBottom:8, fontFamily:"var(--mono)", fontSize:11}}>servers Sidetrack will accept tool calls from</div>
        {[
          { url:"http://localhost:7331",          token:"sb_localhost",    role:"self",   ok:true },
          { url:"http://localhost:6277",          token:"cc_••••••2f0",    role:"claude-code", ok:true },
          { url:"http://localhost:9323",          token:"cur_••••••e91",   role:"cursor", ok:false },
        ].map((h,i)=>(
          <div key={i} className={"mcp-row"+(!h.ok?" off":"")}>
            <span className={"dot "+(h.ok?"green":"")}/>
            <code className="url">{h.url}</code>
            <span className="role">{h.role}</span>
            <code className="token">{h.token}</code>
            <button className="bucket-x">{I.x}</button>
          </div>
        ))}
        <div className="mcp-add">
          <input className="mono" placeholder="http://localhost:port" defaultValue=""/>
          <input className="mono" placeholder="bearer token" defaultValue=""/>
          <button className="sb-btn">Add</button>
        </div>
      </SecBlock>

      {/* Portability — import/export */}
      <SecBlock id="port" title="Portability">
        <div className="port-grid">
          <div className="port-card">
            <div className="t1">Export settings</div>
            <div className="t2 muted">downloads <code>switchboard-config.json</code> · no captures included</div>
            <button className="sb-btn">Download bundle</button>
          </div>
          <div className="port-card">
            <div className="t1">Import settings</div>
            <div className="t2 muted">drop a config bundle · review diff before apply</div>
            <button className="sb-btn" onClick={()=>setImportDiff(true)}>Choose file…</button>
          </div>
        </div>
        {importDiff && (
          <div className="diff-card">
            <div className="diff-head">
              <b>Import diff preview</b>
              <button className="close" onClick={()=>setImportDiff(false)}>{I.x}</button>
            </div>
            <pre className="diff">{`+ provider.gemini.auto-send       false → true
- bucket: provider:codex          (will be removed)
+ bucket: workstream:research/*   ~/Documents/research-vault
~ vault.path                      ~/Documents/SwitchBoard-vault`}</pre>
            <div className="diff-foot">
              <span className="muted">3 changes · 0 conflicts</span>
              <button className="sb-btn">Cancel</button>
              <button className="sb-btn primary">Apply 3 changes</button>
            </div>
          </div>
        )}
      </SecBlock>

      {/* Dispatch */}
      <SecBlock id="disp" title="Dispatch">
        <div className="row-locked">
          <div className="lbl">Paste-mode default <span style={{display:"inline-flex", width:10, height:10, verticalAlign:"-1px"}}>{I.lock}</span></div>
          <div className="desc muted">Locked per §24.10 — auto-send is opt-in per provider</div>
        </div>
        {[["ChatGPT — auto-send", false],["Claude — auto-send", false],["Gemini — auto-send", false]].map(([n,v])=>(
          <RowSwitch key={n} on={v} label={n} desc="requires explicit per-provider opt-in" onClick={()=>{}}/>
        ))}
      </SecBlock>

      {/* Diagnostics */}
      <SecBlock id="diag" title="Diagnostics">
        <div className="diag-stats">
          <div><span className="muted">queue</span> <b>3</b></div>
          <div><span className="muted">last</span> <b>8m ago</b></div>
          <div><span className="muted">index</span> <b>12.4k</b></div>
          <div><span className="muted">errors 24h</span> <b>3</b></div>
        </div>
        <button className="sb-btn primary" onClick={onOpenHealth}>Open capture health →</button>
      </SecBlock>

      {/* About */}
      <SecBlock id="about" title="About">
        <div className="mono muted" style={{lineHeight:1.7, fontSize:11}}>
          version 0.4.2 · Sidetrack (repo: switchboard)<br/>
          companion :7331 · HTTP loopback<br/>
          MCP server :7331/mcp · 4 hosts trusted
        </div>
      </SecBlock>
    </div>
  );
}

function SecBlock({ id, title, children }) {
  return (
    <div className="settings-sec" id={"sec-"+id}>
      <div className="settings-sec-head">{title}</div>
      <div className="settings-sec-body">{children}</div>
    </div>
  );
}

function RowSwitch({ on, label, desc, onClick }) {
  return (
    <label className={"switch"+(on?" on":"")} onClick={onClick}>
      <span className="knob"/>
      <span className="lbl">{label}<span className="desc">{desc}</span></span>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 11) DISPATCH CONFIRM v2 — progressive disclosure, safety-chain summary
// ─────────────────────────────────────────────────────────────────────────
function DispatchConfirmV2({ onClose, onConfirm, screenShare }) {
  const [mode, setMode] = vS("paste");
  const [open, setOpen] = vS(false);

  const checks = [
    { k:"redact",  label:"Redaction",   ok:true,   detail:"2 items removed (1 email · 1 GitHub token)" },
    { k:"budget",  label:"Token budget", ok:true,  detail:"4,200 / 200,000 (2.1%)" },
    { k:"share",   label:"Screen-share", ok:!screenShare, detail: screenShare ? "active — packet visible to viewers" : "not active · safe" },
    { k:"inject",  label:"Prompt-injection scrub", ok:true, detail:"no <!-- … --> sequences detected" },
  ];
  const allOk = checks.every(c=>c.ok);

  return (
    <Modal onClose={onClose} w={620}>
      <div className="modal-head dark">
        <div style={{flex:1}}>
          <h3>Confirm dispatch</h3>
          <div className="sub">→ Claude · new chat · paste mode</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body">
        {/* Safety-chain summary */}
        <div className={"safety-chain"+(allOk?" ok":" warn")}>
          <button className="sc-head" onClick={()=>setOpen(!open)} aria-expanded={open}>
            <span className="sc-glyph">{allOk ? I.check : I.alert}</span>
            <span className="sc-title">Safety chain · <b>{checks.filter(c=>c.ok).length}/{checks.length} checks {allOk?"passed":"need review"}</b></span>
            <span className="sc-list">
              {checks.map(c=>(
                <span key={c.k} className={"sc-pip"+(c.ok?" ok":" bad")} title={c.label+" — "+c.detail}>
                  {c.label}
                </span>
              ))}
            </span>
            <span className={"sc-chev"+(open?" open":"")}>{I.chev}</span>
          </button>
          {open && (
            <div className="sc-detail">
              {checks.map(c=>(
                <div key={c.k} className={"sc-row"+(c.ok?" ok":" bad")}>
                  <span className="dot" style={{background: c.ok?"var(--green)":"var(--signal)"}}/>
                  <b>{c.label}</b>
                  <span className="muted">{c.detail}</span>
                </div>
              ))}
              <details className="sc-preview">
                <summary>Final packet preview</summary>
                <pre>{`# Switchboard / MVP PRD — context pack v3
## Workstream
kind: project · created 2026-04-12
## Recent activity
- claude · "Side-panel state machine review"
- gpt · "PRD §24.10 dispatch safety wording"
…`}</pre>
              </details>
            </div>
          )}
        </div>

        {/* Mode */}
        <div className="field" style={{marginTop:14, marginBottom:0}}>
          <label>Send mode</label>
          <div className="radio-row">
            <button className={mode==="paste"?"on":""} onClick={()=>setMode("paste")}>Paste mode (default)</button>
            <button disabled style={{opacity:0.5, cursor:"not-allowed"}}>
              <span style={{display:"inline-flex", width:10, height:10}}>{I.lock}</span>
              Auto-send · not enabled for Claude
            </button>
          </div>
          <div className="hint">Paste mode is locked per §24.10. Opt-in to auto-send per provider in Settings.</div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="sb-btn" onClick={onClose}>Cancel</button>
        <button className="sb-btn">Edit packet</button>
        <div className="spacer"/>
        <button className="sb-btn primary" onClick={onConfirm}>Confirm dispatch</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 12) WORKBOARD V2 — refresh: header view-tabs, banners, density variants,
//                    upgraded Needs-Organize, coding-offer + update banners
// ─────────────────────────────────────────────────────────────────────────
function WorkboardV2({ state, onAction, onExpandWS, masked, showCodingOffer, showUpdate, onOpenCoding, onAttachCoding, onUpdate, onDismissCoding, onDismissUpdate }) {
  const banners = [];
  if (state.companion === "down")
    banners.push(<div key="comp" className="sp-banner error">{I.alert}<b>Companion: disconnected</b><span>· 12 items queued</span><span className="act">Retry</span></div>);
  if (state.vault === "error")
    banners.push(<div key="vault" className="sp-banner amber">{I.alert}<b>Vault: error</b><span>— re-pick folder?</span><span className="act">Re-pick</span></div>);
  if (masked)
    banners.push(<div key="ss" className="sp-banner signal">{I.cast}<b>Screen-share active</b><span>— content masked</span></div>);
  if (showCodingOffer)
    banners.push(<CodingOfferBanner key="co" onAccept={onAttachCoding} onDismiss={onDismissCoding}/>);
  if (showUpdate)
    banners.push(<UpdateBanner key="up" onUpdate={onUpdate} onLater={onDismissUpdate}/>);

  const grayed = state.companion === "down";

  return (
    <div className="sp-body" style={{opacity: grayed?0.55:1, pointerEvents: grayed?"none":"auto"}}>
      {banners}

      {/* Current Tab — full density */}
      <Sec name="Current tab" count="tracked">
        <div className="item full">
          <div className="row1">
            <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-3)"}}>{I.chat}</span>
            <span className={"title ai"+(masked?" priv":"")}>{masked?"[private — workstream item]":"Side-panel state machine review"}</span>
            <span className="dot signal"/>
          </div>
          <div className="row2">
            <span className="chip claude">Claude</span>
            <span style={{color:"var(--signal)", fontFamily:"var(--mono)"}}>● Reply received · 3 min ago</span>
          </div>
          <div className="row2" style={{marginTop:4}}>
            <span className="crumb">in <b>Switchboard / MVP PRD</b></span>
          </div>
          <div className="actrow always">
            <button>Locate</button>
            <button>Stop</button>
            <button className="more">⋯</button>
          </div>
        </div>
      </Sec>

      {/* Active work */}
      <Sec name="Active work" count="3 workstreams">
        {[
          { id:"switchboard", n:"Switchboard / MVP PRD", c:"3 threads · 2 queued · 1 closed", st:"signal" },
          { id:"ramp",        n:"Switchboard / Ramp-up hypothesis", c:"2 threads · 1 queued", st:"green" },
          { id:"webhook",     n:"Stripe webhook flow", c:"1 thread · 1 queued · 4 captures", st:"amber" },
        ].map(w=>(
          <div key={w.id} className="item" onClick={()=>onExpandWS && onExpandWS(w.id)}>
            <div className="row1">
              <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-3)"}}>{I.folder}</span>
              <span className={"title"+(masked && w.id!=="switchboard"?" priv":"")}>{masked && w.id!=="switchboard"?"[private — workstream]":w.n}</span>
              <span className={"dot "+w.st}/>
            </div>
            <div className="row2">
              <span style={{flex:1}}>{w.c}</span>
              <span style={{color:"var(--ink-3)"}}>{I.fwd}</span>
            </div>
          </div>
        ))}
      </Sec>

      {/* Queued */}
      <Sec name="Queued" count={QUEUED.length+" outbound"}>
        {QUEUED.map(q=>(
          <div key={q.id} className="item dense">
            <div className="row1">
              <span className={"chip "+q.target}>{PROVIDER_LABEL[q.target]}</span>
              <span className="title" style={{fontStyle:"italic", fontWeight:400, fontSize:13}}>{masked?"[private — queued ask]":q.prompt}</span>
              <span className={"pill "+q.status}>{q.status}</span>
            </div>
          </div>
        ))}
      </Sec>

      {/* Inbound — full density (attention) */}
      <Sec name="Inbound" count={INBOUND.length+" new"}>
        {INBOUND.map(b=>(
          <div key={b.id} className="item full">
            <div className="row1">
              <span className="dot signal"/>
              <span className={"chip "+b.prov}>{PROVIDER_LABEL[b.prov]}</span>
              <span className={"title ai"+(masked?" priv":"")}>{masked?"[private]":b.title}</span>
            </div>
            <div className="row2">
              <span style={{flex:1}}>{PROVIDER_LABEL[b.prov]} replied {b.ago}</span>
            </div>
            <div className="actrow always">
              <button>Open</button>
              <button>Mark relevant</button>
              <button>Dismiss</button>
            </div>
          </div>
        ))}
      </Sec>

      {/* Needs organize — upgraded */}
      <Sec name="Needs organize" count={WS.inbox.items.length+" in inbox"}>
        {WS.inbox.items.map(it=>(
          <NeedsOrganizeRow key={it.id} it={{...it, suggest: it.title.includes("webhook") ? "Stripe webhook flow" : "Switchboard / MVP PRD"}}
            onAccept={()=>onAction && onAction("accept", it)}
            onPick={()=>onAction && onAction("move", it)}
            onDismiss={()=>{}}/>
        ))}
      </Sec>

      {/* Recent — dense */}
      <Sec name="Recent · search" defaultOpen={false}>
        <div className="search-row">
          {I.search}
          <input placeholder="Search threads, captures, packets…"/>
        </div>
        {RECENT.slice(0,4).map(r=>(
          <div key={r.id} className="item dense">
            <div className="row1">
              <span className={"chip "+r.prov}>{PROVIDER_LABEL[r.prov]}</span>
              <span className={"title"+(r.ai?" ai":"")+(masked?" priv":"")} style={{fontSize:13}}>{masked?"[private]":r.title}</span>
              <span style={{color:"var(--ink-3)", fontFamily:"var(--mono)", fontSize:10}}>{r.ago} ago</span>
            </div>
          </div>
        ))}
      </Sec>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 13) WORKSTREAM DETAIL V2 — adds Linked notes + Trust toggles
// ─────────────────────────────────────────────────────────────────────────
function WorkstreamDetailV2({ wsId, onBack, masked, onAction }) {
  const ws = WS[wsId] || WS.switchboard;
  const [check, setCheck] = vS(ws.checklist || []);
  const toggle = id => setCheck(check.map(c=>c.id===id?{...c, done:!c.done}:c));

  return (
    <div className="sp-body">
      <div className="ws-detail">
        <div className="crumbs">
          <span onClick={onBack}>Active work</span>
          <span>›</span>
          <span className="curr">{masked?"[private]":ws.name}</span>
        </div>
        <div style={{
          fontFamily:"var(--display)", fontWeight:500, fontSize:18, letterSpacing:"-0.01em", marginBottom:4,
        }}>{masked?"[private — workstream]":ws.name}</div>
        <div className="meta">
          <span className="tag">{ws.kind}</span>
          {ws.tags.map(t=><span key={t} className="tag">#{t}</span>)}
          <span style={{flex:1}}/>
          <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--ink-3)"}}>updated {ws.updated || "today"}</span>
        </div>

        <h6>Tracked items · {ws.items.length}</h6>
        {ws.items.map(it => (
          <ItemRow key={it.id} it={it} masked={masked} onAction={onAction} draggable={true}/>
        ))}

        {check.length>0 && (
          <>
            <h6>Manual checklist · {check.filter(c=>!c.done).length} open</h6>
            <div className="checklist">
              {check.map(c=>(
                <label key={c.id} className={"ck"+(c.done?" done":"")} onClick={(e)=>e.preventDefault()}>
                  <input type="checkbox" checked={c.done} onChange={()=>toggle(c.id)}/>
                  <span>{c.text}</span>
                </label>
              ))}
              <div className="add" tabIndex={0}>
                <span className="plus">{I.plus}</span>
                <span className="lbl">Add item</span>
              </div>
            </div>
          </>
        )}

        {ws.queued && ws.queued.length>0 && (
          <>
            <h6>Queued asks · {ws.queued.length}</h6>
            {ws.queued.map(q=>(
              <div key={q.id} className="item dense">
                <div className="row1">
                  <span className={"chip "+q.target}>{PROVIDER_LABEL[q.target]}</span>
                  <span className="title" style={{fontStyle:"italic", fontWeight:400, fontSize:13}}>{masked?"[private]":q.prompt}</span>
                  <span className={"pill "+q.status}>{q.status}</span>
                </div>
              </div>
            ))}
          </>
        )}

        <h6>Linked notes</h6>
        <LinkedNotes/>

        <h6>MCP write tools</h6>
        <TrustToggles/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// 14) PACKET COMPOSER v2 — adds ScopeSuggestions inline at top
// ─────────────────────────────────────────────────────────────────
function PacketComposerV2({ onClose, onDispatch }) {
  const [kind, setKind] = vS("context");
  const [target, setTarget] = vS("claude");
  const [sug, setSug] = vS("sb_mvp");
  const [scope, setScope] = vS({ ws:true, items:true, queue:false, neighbors:1 });
  const tokens = 4200 + (scope.queue?900:0) + scope.neighbors*1100;
  const tokenColor = tokens>32000?"var(--signal)":tokens>26000?"var(--amber)":"var(--ink-2)";
  const wsLabel = sug==="sb_mvp" ? "Switchboard / MVP PRD" : sug==="sb_arch" ? "Switchboard / Architecture" : "Stripe webhook flow";

  return (
    <Modal onClose={onClose} w={920}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Generate packet</h3>
          <div className="sub">scope: {wsLabel} · {kind==="research"?"research packet":kind==="coding"?"coding agent packet":"context pack"}</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body" style={{padding:0, display:"grid", gridTemplateColumns:"1fr 1fr", minHeight:520}}>
        <div style={{padding:"16px 20px", borderRight:"1px solid var(--rule-soft)", overflow:"auto"}}>
          <ScopeSuggestions value={sug} onChange={setSug}/>

          <div className="field">
            <label>Packet kind</label>
            <div className="radio-row">
              {[["context","Context pack"],["research","Research packet"],["coding","Coding agent packet"],["notebook","Notebook export"]].map(([k,l])=>(
                <button key={k} className={kind===k?"on":""} onClick={()=>setKind(k)}>{l}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Dispatch target</label>
            <div className="radio-row">
              {[["gpt","GPT Pro"],["dr","Deep Research"],["claude","Claude"],["gemini","Gemini"],["codex","Codex"],["cc","Claude Code"],["cursor","Cursor"],["md","Markdown"]].map(([k,l])=>(
                <button key={k} className={target===k?"on":""} onClick={()=>setTarget(k)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{padding:"16px 20px", overflow:"auto", background:"var(--paper)", fontFamily:"var(--mono)", fontSize:11.5, lineHeight:1.65, color:"var(--ink-2)"}}>
          <div style={{color:"var(--ink-3)", marginBottom:10}}># {wsLabel} — context pack v3</div>
          <div><b style={{color:"var(--ink)"}}>## Workstream</b></div>
          <div>kind: project · matched on-device</div>
          <div>tags: P0, spec</div>
          <div style={{marginTop:10}}><b style={{color:"var(--ink)"}}>## Recent activity</b></div>
          <div>- claude · "Side-panel state machine review" · 3 min ago</div>
          <div>- gpt · "PRD §24.10 dispatch safety wording" · 2h ago</div>
          <div>- codex · "sb_companion · capture pipeline scaffold" · 1d ago</div>
          <div style={{marginTop:14, color:"var(--ink-3)"}}>
            ...{tokens.toLocaleString()} tokens of rendered markdown
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <div style={{
          fontFamily:"var(--display)", fontStyle:"italic", fontSize:12, color:"var(--ink-3)", flex:1, lineHeight:1.4,
        }}>
          Redacted 2 items: 1 email, 1 GitHub token <span style={{color:"var(--signal)", textDecoration:"underline", cursor:"pointer", fontStyle:"normal", fontFamily:"var(--mono)", fontSize:10.5}}>[reveal]</span>
        </div>
        <div style={{fontFamily:"var(--mono)", fontSize:11, color: tokenColor, fontWeight:500}}>
          {tokens.toLocaleString()} / 32,000 tokens
        </div>
        <button className="sb-btn" onClick={onClose}>Cancel</button>
        <button className="sb-btn primary" onClick={onDispatch}>Dispatch ›</button>
      </div>
    </Modal>
  );
}

Object.assign(window, {
  DejaVu, AnnotationsOverlay, CodingOfferBanner, UpdateBanner,
  NeedsOrganizeRow, ScopeSuggestions, LinkedNotes, TrustToggles,
  HealthPanel, SettingsV2, DispatchConfirmV2, PacketComposerV2,
  WorkboardV2, WorkstreamDetailV2,
});
