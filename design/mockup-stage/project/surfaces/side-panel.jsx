// Surface 1: Side panel — "Where was I?" + Surface 2: Déjà-vu recall
const { useState } = React;

function SidePanel({ workstream="auth-redesign", showDeja=false, screenSafe=false, selectedId, onSelect, onCompose, demoLog=[] }) {
  const [draft, setDraft] = useState("");
  const [targets, setTargets] = useState({ chatgpt:true, claude:true, gemini:false, notebook:true });
  const threads = THREADS[workstream] || THREADS["auth-redesign"];

  return (
    <div className="sb-frame" style={{width:380, height:720}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">chrome-extension://<b>switchboard</b>/sidepanel.html</div>
      </div>
      <div className="sb-app" style={{overflow:"auto"}}>
        <div className="sb-app-head">
          <div className="sb-mark"><span className="sb-glyph"/>SwitchBoard <span className="tag">/ companion</span></div>
          <div className="sb-actions">
            <button className="sb-icon-btn" title="Search">{Icon.search}</button>
            <button className="sb-icon-btn" title="Settings">{Icon.settings}</button>
          </div>
        </div>

        <div className="sb-ws">
          <span className="lbl">Workstream</span>
          <span className="ws-name">{screenSafe ? "••••••••" : workstream}</span>
          <span className="swap">↓</span>
        </div>

        <div className="sb-sec-head"><span>Open threads</span><span className="count">{threads.length} active</span></div>
        <div className="sb-thread-list">
          {threads.map(t => (
            <div key={t.id} className={"sb-thread"+(selectedId===t.id?" is-selected":"")} onClick={()=>onSelect && onSelect(t.id)}>
              <div className="row1">
                <span className={"sb-prov "+t.prov}>{t.prov==="gpt"?"ChatGPT":t.prov==="claude"?"Claude":"Gemini"}</span>
                <span className="name">{screenSafe ? "•••••••••••••••••••••" : t.name}</span>
                {t.driftBadge && <span className="badge">DRIFT</span>}
              </div>
              <div className="row2">
                <span className={"sb-dot "+t.state}/>
                <span>{t.stamp}</span>
              </div>
              {t.drift && (
                <div className="drift">{Icon.alert}<span>{t.drift}</span></div>
              )}
            </div>
          ))}
        </div>

        {showDeja && (
          <div className="sb-deja">
            <div className="head">{Icon.history}<span>Déjà vu · 6 days ago</span></div>
            <div className="body">You discussed <span className="term">ramp-up curve</span> with Claude.</div>
            <div className="snippet">"…the activation curve flattens after week 3 if onboarding emails don't reference the user's first capture…"</div>
            <div className="actions">
              <button className="sb-ghost primary">Open thread</button>
              <button className="sb-ghost">Pin to dispatch</button>
              <button className="sb-ghost" onClick={()=>onCompose && onCompose("dismiss-deja")}>Dismiss</button>
            </div>
          </div>
        )}

        <div className="sb-sec-head"><span>Recent captures</span><span className="count">Today</span></div>
        {CAPTURES.map(c => (
          <div key={c.id} className="sb-capture">
            {c.icon==="chat" ? Icon.chat : Icon.doc}
            <div>
              <div className="text" style={screenSafe?{filter:"blur(4px)"}:undefined}>{c.text}</div>
              <div className="meta">{c.meta}</div>
            </div>
          </div>
        ))}

        <div style={{flex:1,minHeight:8}}/>
        <div className="sb-composer">
          <textarea
            placeholder="Dispatch a prompt to selected targets…"
            value={draft}
            onChange={e=>setDraft(e.target.value)}
          />
          <div className="sb-targets">
            {[["chatgpt","ChatGPT"],["claude","Claude"],["gemini","Gemini"],["notebook","+ Notebook"]].map(([k,label])=>(
              <button key={k} className={"sb-chip"+(targets[k]?" on":"")} onClick={()=>setTargets({...targets,[k]:!targets[k]})}>{label}</button>
            ))}
          </div>
          <div className="sb-foot">
            <span className="sb-pre">{Icon.check} Redact OK · 0 PII</span>
            <button className="sb-send" onClick={()=>onCompose && onCompose(draft)}>Dispatch {Icon.send}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { SidePanel });
