// Modals — Mocks 3, 4-picker, 5, 6, 8, 9, 12, 14
const { useState: mS, useEffect: mE } = React;

function Modal({ children, onClose, w=520 }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{width:w}} onClick={e=>e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ── Mock 3: Tab recovery
function TabRecovery({ onClose }) {
  const [strategy, setStrategy] = mS("focus");
  const opts = [
    { k:"focus", label:"Focus open tab", desc:"Tab is still open in window 2", primary:true },
    { k:"restore", label:"Restore session", desc:"Recently closed — Chrome can rehydrate" },
    { k:"reopen", label:"Reopen URL", desc:"Always available — opens a fresh tab" },
  ];
  return (
    <Modal onClose={onClose} w={460}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Reopen tab</h3>
          <div className="sub">captured 2026-04-26 09:08 · last active 14 min ago</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body">
        <div style={{
          padding:"10px 12px", background:"var(--paper)", borderRadius:6,
          border:"1px solid var(--rule-soft)", marginBottom:14,
        }}>
          <div style={{
            fontFamily:"var(--display)", fontStyle:"italic", fontSize:15,
            letterSpacing:"-0.005em", marginBottom:5,
          }}>Stripe webhook signature flow</div>
          <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:4}}>
            <span className="chip claude">Claude</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>claude.ai/chat/8c41a2f0-…</span>
          </div>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {opts.map(o=>(
            <button key={o.k} onClick={()=>setStrategy(o.k)} style={{
              textAlign:"left", padding:"11px 13px", borderRadius:8,
              border: strategy===o.k?"1.5px solid var(--ink)":"1px solid var(--rule)",
              background: strategy===o.k?"var(--paper-deep)":"var(--paper-light)",
              cursor:"pointer", fontFamily:"var(--body)", color:"var(--ink)",
            }}>
              <div style={{display:"flex", alignItems:"center", gap:8}}>
                <span style={{fontFamily:"var(--display)", fontSize:14, fontWeight:500}}>{o.label}</span>
                {o.primary && <span className="pill ready">recommended</span>}
              </div>
              <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginTop:3}}>{o.desc}</div>
            </button>
          ))}
        </div>
        <div style={{
          fontFamily:"var(--display)", fontStyle:"italic", fontSize:12, color:"var(--ink-3)",
          marginTop:14, padding:"8px 10px", background:"var(--green-bg)", borderRadius:5,
          border:"1px solid var(--green-tint)",
        }}>
          Will run: <code style={{fontStyle:"normal", fontFamily:"var(--mono)"}}>chrome.tabs.update(t, {`{active:true}`})</code> · falls back to reopen URL if focus fails.
        </div>
      </div>
      <div className="modal-foot">
        <div className="spacer"/>
        <button className="sb-btn" onClick={onClose}>Cancel</button>
        <button className="sb-btn primary">Run</button>
      </div>
    </Modal>
  );
}

// ── Mock 4-picker: Move to…
function MoveTo({ onClose, onMove }) {
  const [filter, setFilter] = mS("");
  const tree = [
    { id:"sb", n:"Switchboard", k:"project", children:[
      { id:"sb_mvp", n:"MVP PRD", k:"project" },
      { id:"sb_ramp", n:"Ramp-up hypothesis", k:"subcluster" },
      { id:"sb_arch", n:"Architecture / state", k:"subcluster" },
    ]},
    { id:"stripe", n:"Stripe webhook flow", k:"project" },
    { id:"inbox", n:"Inbox", k:"cluster" },
    { id:"misc", n:"Misc", k:"cluster" },
  ];
  const renderNode = (node, depth=0) => (
    <React.Fragment key={node.id}>
      <div onClick={()=>onMove && onMove(node)} style={{
        padding:"7px 10px", paddingLeft: 10+depth*16, borderRadius:5, cursor:"pointer",
        display:"flex", alignItems:"center", gap:7,
      }} onMouseEnter={e=>e.currentTarget.style.background="var(--paper-deep)"}
         onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
        <span style={{display:"grid", placeItems:"center", width:13, height:13, color:"var(--ink-3)"}}>{I.folder}</span>
        <span style={{fontFamily:"var(--display)", fontSize:13.5}}>{node.n}</span>
        <span style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--ink-3)"}}>{node.k}</span>
      </div>
      {node.children && node.children.map(c=>renderNode(c, depth+1))}
    </React.Fragment>
  );
  const showCreate = filter.includes("/") && !["Switchboard","Inbox","Misc"].some(n => n.toLowerCase()===filter.toLowerCase());
  return (
    <Modal onClose={onClose} w={460}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Move to…</h3>
          <div className="sub">type a path · press / to nest</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body" style={{paddingTop:8}}>
        <div className="search-row" style={{margin:"0 0 12px"}}>
          {I.search}
          <input autoFocus value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter or type a new path…"/>
        </div>
        {showCreate && (
          <div onClick={()=>onMove && onMove({n:filter, k:"new"})} style={{
            padding:"8px 10px", borderRadius:5, background:"var(--signal-bg)",
            border:"1px solid var(--signal-tint)", cursor:"pointer",
            display:"flex", alignItems:"center", gap:7, marginBottom:10,
          }}>
            <span style={{display:"grid", placeItems:"center", width:13, height:13, color:"var(--signal)"}}>{I.plus}</span>
            <span style={{fontFamily:"var(--display)", fontSize:13.5}}>Create new: <b>{filter}</b></span>
          </div>
        )}
        {tree.map(n=>renderNode(n))}
      </div>
    </Modal>
  );
}

// ── Mock 5: Packet composer
function PacketComposer({ onClose, onDispatch }) {
  const [kind, setKind] = mS("context");
  const [target, setTarget] = mS("claude");
  const [scope, setScope] = mS({ ws:true, items:true, queue:false, neighbors:1 });
  const tokens = 4200 + (scope.queue?900:0) + scope.neighbors*1100;
  const tokenColor = tokens>32000?"var(--signal)":tokens>26000?"var(--amber)":"var(--ink-2)";

  return (
    <Modal onClose={onClose} w={920}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Generate packet</h3>
          <div className="sub">scope: Switchboard / MVP PRD · {kind==="research"?"research packet":kind==="coding"?"coding agent packet":"context pack"}</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body" style={{padding:0, display:"grid", gridTemplateColumns:"1fr 1fr", minHeight:480}}>
        <div style={{padding:"16px 20px", borderRight:"1px solid var(--rule-soft)", overflow:"auto"}}>
          <div className="field">
            <label>Packet kind</label>
            <div className="radio-row">
              {[["context","Context pack"],["research","Research packet"],["coding","Coding agent packet"],["notebook","Notebook export"]].map(([k,l])=>(
                <button key={k} className={kind===k?"on":""} onClick={()=>setKind(k)}>{l}</button>
              ))}
            </div>
          </div>
          {kind==="research" && (
            <div className="field">
              <label>Template</label>
              <select defaultValue="web2ai">
                <option value="web2ai">Web-to-AI checklist</option>
                <option value="resume">Resume tech-stack</option>
                <option value="radar">Latest developments radar</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          )}
          <div className="field">
            <label>Scope</label>
            <label className="switch" onClick={()=>setScope({...scope, ws:!scope.ws})}>
              <span className={"knob"} style={{background: scope.ws?"var(--ink)":"var(--rule)"}}>
                <span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left: scope.ws?16:2, transition:"all 120ms"}}/>
              </span>
              <span className="lbl">Workstream subtree<span className="desc">all 4 tracked items + subcluster</span></span>
            </label>
            <label className="switch" onClick={()=>setScope({...scope, items:!scope.items})}>
              <span className="knob" style={{background: scope.items?"var(--ink)":"var(--rule)"}}>
                <span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left: scope.items?16:2, transition:"all 120ms"}}/>
              </span>
              <span className="lbl">Tracked items<span className="desc">conversations + captures</span></span>
            </label>
            <label className="switch" onClick={()=>setScope({...scope, queue:!scope.queue})}>
              <span className="knob" style={{background: scope.queue?"var(--ink)":"var(--rule)"}}>
                <span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left: scope.queue?16:2, transition:"all 120ms"}}/>
              </span>
              <span className="lbl">Queue items<span className="desc">2 pending follow-ups</span></span>
            </label>
            <div style={{marginTop:10, display:"flex", alignItems:"center", gap:10}}>
              <span style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", flex:1}}>Neighborhood depth</span>
              <input type="range" min="0" max="2" value={scope.neighbors} onChange={e=>setScope({...scope, neighbors:+e.target.value})} style={{flex:2}}/>
              <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink)"}}>{scope.neighbors}</span>
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
          <div style={{color:"var(--ink-3)", marginBottom:10}}># Switchboard / MVP PRD — context pack v3</div>
          <div><b style={{color:"var(--ink)"}}>## Workstream</b></div>
          <div>kind: project · created 2026-04-12</div>
          <div>tags: P0, spec</div>
          <div style={{marginTop:10}}><b style={{color:"var(--ink)"}}>## Recent activity</b></div>
          <div>- claude · "Side-panel state machine review" · 3 min ago</div>
          <div>- gpt · "PRD §24.10 dispatch safety wording" · 2h ago</div>
          <div>- codex · "sb_companion · capture pipeline scaffold" · 1d ago</div>
          {scope.queue && <><div style={{marginTop:10}}><b style={{color:"var(--ink)"}}>## Pending asks</b></div>
            <div>- → claude: review state machine for races</div>
            <div>- → gemini: comp scan</div></>}
          {scope.neighbors>0 && <><div style={{marginTop:10}}><b style={{color:"var(--ink)"}}>## Linked context (depth {scope.neighbors})</b></div>
            <div>- ramp-up hypothesis · 2 threads</div></>}
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
        <button className="sb-btn">Copy to clipboard</button>
        <button className="sb-btn">Save to vault</button>
        <button className="sb-btn primary" onClick={onDispatch}>Dispatch</button>
      </div>
    </Modal>
  );
}

// ── Mock 6: Dispatch confirm + safety
function DispatchConfirm({ onClose, onConfirm, screenShare }) {
  const [mode, setMode] = mS("paste");
  return (
    <Modal onClose={onClose} w={620}>
      <div className="modal-head" style={{background:"var(--ink)", color:"var(--paper-light)", borderBottom:"1px solid var(--ink)"}}>
        <div style={{flex:1}}>
          <h3 style={{color:"var(--paper-light)"}}>Confirm dispatch</h3>
          <div className="sub" style={{color:"rgba(245,239,226,0.6)"}}>→ Claude · new chat · paste mode</div>
        </div>
        <button className="close" onClick={onClose} style={{background:"rgba(255,255,255,0.1)", color:"var(--paper-light)"}}>{I.x}</button>
      </div>
      <div className="modal-body">
        {/* Redaction */}
        <div style={{
          padding:"10px 12px", background:"var(--signal-bg)", border:"1px solid var(--signal-tint)",
          borderRadius:6, marginBottom:10, display:"flex", gap:10, alignItems:"flex-start",
        }}>
          <span style={{color:"var(--signal)", flex:"none", marginTop:2}}>{I.lock}</span>
          <div style={{flex:1, fontFamily:"var(--display)", fontStyle:"italic", fontSize:13, lineHeight:1.5}}>
            <b style={{fontStyle:"normal", color:"var(--signal)"}}>Redaction fired:</b> 2 items removed —
            <span style={{fontFamily:"var(--mono)", fontStyle:"normal", fontSize:11}}> 1 email, 1 GitHub token</span>
            <span style={{display:"block", marginTop:3, fontFamily:"var(--mono)", fontStyle:"normal", fontSize:10.5, color:"var(--signal)", textDecoration:"underline", cursor:"pointer"}}>[reveal redacted]</span>
          </div>
        </div>
        {/* Token budget */}
        <div style={{marginBottom:10}}>
          <div style={{display:"flex", justifyContent:"space-between", marginBottom:4, fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)"}}>
            <span>Token budget</span>
            <span style={{color:"var(--ink)"}}>4,200 / 200,000</span>
          </div>
          <div style={{height:5, background:"var(--paper-deep)", borderRadius:3}}>
            <div style={{height:"100%", width:"2.1%", background:"var(--green)", borderRadius:3}}/>
          </div>
        </div>
        {/* Screen-share */}
        <div style={{
          padding:"9px 12px",
          background: screenShare?"var(--signal-bg)":"var(--green-bg)",
          border:"1px solid "+(screenShare?"var(--signal-tint)":"var(--green-tint)"),
          borderRadius:6, marginBottom:14, display:"flex", gap:10, alignItems:"center",
          fontFamily:"var(--mono)", fontSize:11,
          color: screenShare?"var(--signal)":"var(--green)",
        }}>
          <span style={{flex:"none"}}>{screenShare?I.cast:I.check}</span>
          <span style={{flex:1}}>
            {screenShare
              ? <><b>Screen-share active</b> — packet contents will be visible to viewers.</>
              : <>Screen-share <b>not</b> active · safe to dispatch.</>}
          </span>
        </div>
        {/* Preview collapsible */}
        <details style={{
          padding:"8px 12px", background:"var(--paper)", border:"1px solid var(--rule-soft)",
          borderRadius:6, marginBottom:14,
        }}>
          <summary style={{cursor:"pointer", fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", textTransform:"uppercase", letterSpacing:"0.1em"}}>Final packet preview</summary>
          <div style={{
            marginTop:10, padding:"8px 10px", background:"var(--paper-light)",
            fontFamily:"var(--mono)", fontSize:11, lineHeight:1.6, color:"var(--ink-2)",
            maxHeight:120, overflow:"auto", borderRadius:4,
          }}>
            # Switchboard / MVP PRD — context pack v3<br/>
            ## Workstream<br/>
            kind: project · created 2026-04-12<br/>
            ## Recent activity<br/>
            - claude · "Side-panel state machine review"<br/>
            ...
          </div>
        </details>
        {/* Mode */}
        <div className="field" style={{marginBottom:0}}>
          <label>Send mode</label>
          <div className="radio-row">
            <button className={mode==="paste"?"on":""} onClick={()=>setMode("paste")}>Paste mode (default)</button>
            <button onClick={()=>{}} disabled style={{opacity:0.5, cursor:"not-allowed"}}>
              {I.lock && <span style={{display:"inline-flex", width:11, height:11}}>{I.lock}</span>}
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

// ── Mock 8: First-run wizard
function Wizard({ onClose }) {
  const [step, setStep] = mS(0);
  const steps = ["Welcome","Companion","Vault","Providers","Done"];
  return (
    <Modal onClose={onClose} w={580}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Set up SwitchBoard</h3>
          <div className="sub">step {step+1} of {steps.length} · {steps[step]}</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body" style={{minHeight:380}}>
        {step===0 && (
          <div>
            <div style={{
              fontFamily:"var(--display)", fontWeight:500, fontSize:30, lineHeight:1.15,
              letterSpacing:"-0.02em", marginBottom:14,
            }}>Track your AI work without losing the thread.</div>
            <div style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:16, color:"var(--ink-2)", lineHeight:1.55, marginBottom:20}}>
              SwitchBoard watches your AI tabs, recovers what you lost, and lets you hand context to other models — without copy-paste fatigue.
            </div>
            <a style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--signal)", textDecoration:"underline", cursor:"pointer"}}>skip the tour →</a>
          </div>
        )}
        {step===1 && (
          <div>
            <div style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:14, color:"var(--ink-3)", lineHeight:1.55, marginBottom:14}}>
              Pick how the companion connects. Without it, captures pause when Chrome is idle.
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
              <div style={{padding:14, border:"1.5px solid var(--ink)", borderRadius:8, background:"var(--paper-deep)"}}>
                <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)", marginBottom:5}}>OPTION A · easier</div>
                <div style={{fontFamily:"var(--display)", fontSize:15, fontWeight:500, marginBottom:5}}>HTTP loopback</div>
                <code style={{fontFamily:"var(--mono)", fontSize:11, background:"var(--ink)", color:"var(--paper-light)", padding:"5px 8px", display:"block", borderRadius:4}}>npx switchboard-companion</code>
                <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginTop:8}}>port-based · no installer</div>
              </div>
              <div style={{padding:14, border:"1px solid var(--rule)", borderRadius:8}}>
                <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)", marginBottom:5}}>OPTION B · stricter</div>
                <div style={{fontFamily:"var(--display)", fontSize:15, fontWeight:500, marginBottom:5}}>Native Messaging</div>
                <code style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)", padding:"5px 8px", display:"block", border:"1px solid var(--rule)", borderRadius:4}}>install host (registry/plist)</code>
                <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginTop:8}}>no port · admin install</div>
              </div>
            </div>
            <div style={{
              marginTop:14, padding:"8px 12px", background:"var(--green-bg)", border:"1px solid var(--green-tint)",
              borderRadius:5, fontFamily:"var(--mono)", fontSize:11, color:"var(--green)",
              display:"flex", alignItems:"center", gap:8,
            }}>
              <span className="dot green"/> Companion reachable on :7331
            </div>
          </div>
        )}
        {step===2 && (
          <div>
            <div style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:14, color:"var(--ink-3)", marginBottom:14}}>Pick the folder where SwitchBoard writes its vault.</div>
            <button style={{
              width:"100%", padding:18, border:"1.5px dashed var(--rule)", borderRadius:8,
              background:"var(--paper)", cursor:"pointer", fontFamily:"var(--display)", fontSize:14,
              display:"flex", alignItems:"center", gap:10, justifyContent:"center",
            }}>{I.folder} Choose folder…</button>
            <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)", marginTop:10, padding:"6px 10px", background:"var(--paper-deep)", borderRadius:4}}>
              ~/Documents/SwitchBoard-vault
            </div>
            <div style={{
              fontFamily:"var(--display)", fontStyle:"italic", fontSize:13, color:"var(--green)",
              marginTop:10, padding:"6px 10px", background:"var(--green-bg)", borderRadius:4,
              border:"1px solid var(--green-tint)",
            }}>
              <b style={{fontStyle:"normal", fontFamily:"var(--mono)", fontSize:11}}>Local REST API plugin detected</b> — will use surgical PATCH for vault writes.
            </div>
          </div>
        )}
        {step===3 && (
          <div>
            <div style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:14, color:"var(--ink-3)", marginBottom:14}}>Auto-track which providers? You can disable any per-site later.</div>
            {[["ChatGPT","gpt"],["Claude","claude"],["Gemini","gemini"],["Codex","codex"]].map(([n,k])=>(
              <label key={k} className="switch on">
                <span className="knob"><span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left:16}}/></span>
                <span className="lbl">{n}<span className="desc">{({gpt:"chat.openai.com, chatgpt.com",claude:"claude.ai",gemini:"gemini.google.com",codex:"chatgpt.com/codex"})[k]}</span></span>
              </label>
            ))}
          </div>
        )}
        {step===4 && (
          <div style={{textAlign:"center", paddingTop:20}}>
            <div style={{fontSize:48, marginBottom:14}}>✓</div>
            <div style={{fontFamily:"var(--display)", fontWeight:500, fontSize:26, letterSpacing:"-0.01em", marginBottom:10}}>You're set up.</div>
            <div style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:15, color:"var(--ink-2)", lineHeight:1.5}}>
              Open any AI chat tab to start tracking. The side panel is pinned to your toolbar.
            </div>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <div style={{display:"flex", gap:5}}>
          {steps.map((_,i)=><span key={i} style={{width:6, height:6, borderRadius:"50%", background: i===step?"var(--ink)":"var(--rule)"}}/>)}
        </div>
        <div className="spacer"/>
        {step>0 && <button className="sb-btn" onClick={()=>setStep(step-1)}>Back</button>}
        {step<steps.length-1
          ? <button className="sb-btn primary" onClick={()=>setStep(step+1)}>Next</button>
          : <button className="sb-btn primary" onClick={onClose}>Open SwitchBoard</button>}
      </div>
    </Modal>
  );
}

// ── Mock 12: Coding session attach
function CodingAttach({ onClose }) {
  const [tool, setTool] = mS("cc");
  return (
    <Modal onClose={onClose} w={560}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Attach coding session</h3>
          <div className="sub">to · Switchboard / MVP PRD</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body">
        <div className="field">
          <label>Tool</label>
          <div className="radio-row">
            {[["codex","Codex"],["cc","Claude Code"],["cursor","Cursor"],["jb","JetBrains"],["other","Other"]].map(([k,l])=>(
              <button key={k} className={tool===k?"on":""} onClick={()=>setTool(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          <div className="field">
            <label>cwd</label>
            <input className="mono" defaultValue="~/code/switchboard"/>
          </div>
          <div className="field">
            <label>branch</label>
            <input className="mono" defaultValue="feat/dispatch-safety"/>
          </div>
        </div>
        <div className="field">
          <label>session id</label>
          <input className="mono" defaultValue="cc_8c41a2f0"/>
        </div>
        <div className="field">
          <label>name</label>
          <input defaultValue="Side-panel state machine refactor"/>
        </div>
        <div className="field">
          <label>resume command</label>
          <textarea className="mono" defaultValue="claude resume cc_8c41a2f0"/>
          <div className="hint">We can resume this with <code style={{fontFamily:"var(--mono)", fontStyle:"normal"}}>claude resume cc_8c41a2f0</code> — confirm?</div>
        </div>
      </div>
      <div className="modal-foot">
        <div className="spacer"/>
        <button className="sb-btn" onClick={onClose}>Cancel</button>
        <button className="sb-btn primary" onClick={onClose}>Attach</button>
      </div>
    </Modal>
  );
}

// ── Mock 14: Annotation capture
function Annotation({ onClose, selection="Use HMAC with SHA-256 and reject any timestamp outside ±2 minutes." }) {
  const [ws, setWs] = mS("Switchboard / MVP PRD");
  return (
    <Modal onClose={onClose} w={460}>
      <div className="modal-head">
        <div style={{flex:1}}>
          <h3>Save selection</h3>
          <div className="sub">stripe.com/docs/webhooks/signatures</div>
        </div>
        <button className="close" onClick={onClose}>{I.x}</button>
      </div>
      <div className="modal-body">
        <div style={{
          padding:"10px 12px", background:"var(--paper)", borderRadius:6,
          border:"1px solid var(--rule-soft)", marginBottom:14,
          fontFamily:"var(--display)", fontStyle:"italic", fontSize:14, lineHeight:1.55,
          borderLeft:"2px solid var(--signal)",
        }}>
          "{selection}"
        </div>
        <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginBottom:14}}>
          stripe.com/docs/webhooks/signatures · "Verify webhook signatures"
        </div>
        <div className="field">
          <label>Why are you saving this?</label>
          <textarea placeholder="Why are you saving this?"/>
        </div>
        <div className="field">
          <label>Workstream</label>
          <select value={ws} onChange={e=>setWs(e.target.value)}>
            <option>Switchboard / MVP PRD</option>
            <option>Stripe webhook flow</option>
            <option>Inbox</option>
          </select>
        </div>
      </div>
      <div className="modal-foot">
        <div className="spacer"/>
        <button className="sb-btn" onClick={onClose}>Save to Inbox</button>
        <button className="sb-btn primary" onClick={onClose}>Save to {ws.split("/").pop().trim()}</button>
      </div>
    </Modal>
  );
}

// ── Mock 9: Settings (rendered as full panel takeover)
function Settings({ onClose }) {
  const [autoTrack, setAutoTrack] = mS(true);
  const [ssAuto, setSsAuto] = mS(true);
  const [autoDl, setAutoDl] = mS(true);
  return (
    <div className="sp-body" style={{background:"var(--paper)"}}>
      <div style={{
        padding:"12px 14px", borderBottom:"1px solid var(--rule)", display:"flex", alignItems:"center", gap:8,
        background:"var(--paper-deep)",
      }}>
        <button className="sb-btn" onClick={onClose} style={{padding:"4px 8px"}}>{I.back}</button>
        <span style={{fontFamily:"var(--display)", fontSize:16, fontWeight:500, letterSpacing:"-0.005em"}}>Settings</span>
      </div>
      {[
        ["Tracking", [
          ["Auto-track new providers", autoTrack, setAutoTrack, "Watches chat.openai.com, claude.ai, gemini.google.com"],
        ]],
        ["Privacy", [
          ["Screen-share-safe auto-detect", ssAuto, setSsAuto, "Masks tracked-item titles when getDisplayMedia is active"],
        ]],
      ].map(([sec, rows])=>(
        <div key={sec} style={{padding:"14px 16px", borderBottom:"1px solid var(--rule-soft)"}}>
          <div style={{fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:"0.14em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:8}}>{sec}</div>
          {rows.map(([n,v,set,desc])=>(
            <label key={n} className={"switch"+(v?" on":"")} onClick={()=>set(!v)}>
              <span className="knob"><span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left: v?16:2, transition:"all 120ms"}}/></span>
              <span className="lbl">{n}<span className="desc">{desc}</span></span>
            </label>
          ))}
        </div>
      ))}
      <div style={{padding:"14px 16px", borderBottom:"1px solid var(--rule-soft)"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:"0.14em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:8}}>Companion</div>
        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6}}>
          <span className="pill ready"><span className="dot green"/> running</span>
          <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)", flex:1}}>:7331 · v0.4.2</span>
        </div>
        <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)", padding:"6px 10px", background:"var(--paper-deep)", borderRadius:4}}>
          ~/Documents/SwitchBoard-vault
        </div>
      </div>
      <div style={{padding:"14px 16px", borderBottom:"1px solid var(--rule-soft)"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:"0.14em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:8}}>Dispatch</div>
        <label className="switch on" style={{opacity:0.7, cursor:"not-allowed"}}>
          <span className="knob"><span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left:16}}/></span>
          <span className="lbl">Paste-mode default <span style={{display:"inline-flex", width:11, height:11, verticalAlign:"-1px"}}>{I.lock}</span><span className="desc">Locked per §24.10 — auto-send is opt-in per provider</span></span>
        </label>
        {[["ChatGPT — auto-send", false],["Claude — auto-send", false],["Gemini — auto-send", false]].map(([n])=>(
          <label key={n} className="switch">
            <span className="knob"><span style={{position:"absolute", width:16, height:16, background:"var(--paper-light)", borderRadius:"50%", top:2, left:2}}/></span>
            <span className="lbl">{n}<span className="desc">requires explicit per-provider opt-in</span></span>
          </label>
        ))}
      </div>
      <div style={{padding:"14px 16px", borderBottom:"1px solid var(--rule-soft)"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:"0.14em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:8}}>About</div>
        <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", lineHeight:1.7}}>
          version 0.4.2<br/>
          vault <span style={{color:"var(--ink-2)"}}>~/Documents/SwitchBoard-vault</span><br/>
          companion <span style={{color:"var(--ink-2)"}}>:7331 (HTTP loopback)</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TabRecovery, MoveTo, PacketComposer, DispatchConfirm, Wizard, CodingAttach, Annotation, Settings, Modal });
