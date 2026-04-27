// Side panel — main views (Mock 1 workboard, Mock 2 workstream detail,
// Mock 7 inline review composer)

const { useState: uS, useEffect: uE, useRef: uR } = React;

// ── Item row (used in workboard sections + workstream detail)
function ItemRow({ it, masked, onAction, draggable, onDragStart, onDragEnd, isDragging, isDropTarget, onDragOver, onDrop }) {
  const title = masked ? "[private — workstream item]" : it.title;
  return (
    <div
      className={"item"+(isDragging?" dragging":"")+(isDropTarget?" drop-target":"")}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="row1">
        <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-3)"}}>{typeIcon(it.type)}</span>
        <span className={"title"+((it.ai && !masked)?" ai":"")+(masked?" priv":"")}>{title}</span>
        {it.status && <span className={"dot "+it.status}/>}
      </div>
      <div className="row2">
        <span className={"chip "+it.prov}>{PROVIDER_LABEL[it.prov]}</span>
        <span style={{flex:1, color:"var(--ink-3)", fontFamily:"var(--mono)"}}>{it.ago}</span>
        {it.links > 0 && <span title="primary links" style={{fontFamily:"var(--mono)", color:"var(--ink-3)"}}>↗ {it.links}</span>}
      </div>
      <div className="actrow">
        <button onClick={(e)=>{e.stopPropagation(); onAction && onAction("locate", it);}}>Locate</button>
        <button onClick={(e)=>{e.stopPropagation(); onAction && onAction("queue", it);}}>Queue</button>
        <button onClick={(e)=>{e.stopPropagation(); onAction && onAction("packet", it);}}>Packet</button>
        <button onClick={(e)=>{e.stopPropagation(); onAction && onAction("review", it);}}>Review</button>
        <button onClick={(e)=>{e.stopPropagation(); onAction && onAction("move", it);}}>Move to…</button>
      </div>
    </div>
  );
}

// ── Section card (collapsible)
function Sec({ name, count, defaultOpen=true, children, action }) {
  const [open, setOpen] = uS(defaultOpen);
  return (
    <div className={"sec"+(open?"":" collapsed")}>
      <div className="sec-head" onClick={()=>setOpen(!open)}>
        <span className="name">{name}</span>
        {count != null && <span className="count">{count}</span>}
        <span className="chev" style={{display:"inline-flex"}}>{I.chev}</span>
      </div>
      <div className="sec-body">{children}{action}</div>
    </div>
  );
}

// ── Mock 1+11: Workboard
function Workboard({ state, onAction, onExpandWS, masked, demoFlags }) {
  // companion / vault state banners
  const banners = [];
  if (state.companion === "down") {
    banners.push(<div key="comp" className="sp-banner error">{I.alert}<b>Companion: disconnected</b><span>· 12 items queued</span><span className="act">Retry</span></div>);
  }
  if (state.vault === "error") {
    banners.push(<div key="vault" className="sp-banner amber">{I.alert}<b>Vault: error</b><span>— re-pick folder?</span><span className="act">Re-pick</span></div>);
  }
  if (masked) {
    banners.push(<div key="ss" className="sp-banner signal">{I.cast}<b>Screen-share active</b><span>— content masked</span></div>);
  }

  const grayed = state.companion === "down";

  return (
    <div className="sp-body" style={{opacity: grayed?0.55:1, pointerEvents: grayed?"none":"auto"}}>
      {banners}

      {/* Section 1 — Current Tab */}
      <Sec name="Current tab" count="tracked">
        <div className="item" style={{cursor:"default"}}>
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
          <div className="actrow" style={{display:"flex"}}>
            <button>Locate</button>
            <button>Stop</button>
            <button>Queue</button>
            <button>Packet</button>
          </div>
        </div>
      </Sec>

      {/* Section 2 — Active work */}
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

      {/* Section 3 — Queued (outbound) */}
      <Sec name="Queued" count={QUEUED.length+" outbound"}>
        {QUEUED.map(q=>(
          <div key={q.id} className="item">
            <div className="row1">
              <span className={"chip "+q.target}>{PROVIDER_LABEL[q.target]}</span>
              <span className="title" style={{fontStyle:"italic", fontWeight:400, fontSize:13}}>{masked?"[private — queued ask]":q.prompt}</span>
            </div>
            <div className="row2">
              <span style={{flex:1, color:"var(--ink-3)"}}>from <b style={{color:"var(--ink-2)"}}>{q.source}</b></span>
              <span className={"pill "+q.status}>{q.status}</span>
            </div>
          </div>
        ))}
      </Sec>

      {/* Section 4 — Inbound */}
      <Sec name="Inbound" count={INBOUND.length+" new"}>
        {INBOUND.map(b=>(
          <div key={b.id} className="item">
            <div className="row1">
              <span className="dot signal"/>
              <span className={"chip "+b.prov}>{PROVIDER_LABEL[b.prov]}</span>
              <span className={"title ai"+(masked?" priv":"")}>{masked?"[private]":b.title}</span>
            </div>
            <div className="row2">
              <span style={{flex:1}}>{PROVIDER_LABEL[b.prov]} replied {b.ago}</span>
            </div>
            <div className="actrow" style={{display:"flex"}}>
              <button>Open</button>
              <button>Mark relevant</button>
              <button>Dismiss</button>
            </div>
          </div>
        ))}
      </Sec>

      {/* Section 5 — Needs Organize */}
      <Sec name="Needs organize" count={WS.inbox.items.length+" in inbox"} defaultOpen={false}>
        {WS.inbox.items.map(it=>(
          <ItemRow key={it.id} it={it} masked={masked} onAction={onAction} draggable={true}/>
        ))}
      </Sec>

      {/* Section 6 — Recent / Search */}
      <Sec name="Recent · search">
        <div className="search-row">
          {I.search}
          <input placeholder="Search threads, captures, packets…"/>
        </div>
        {RECENT.slice(0,4).map(r=>(
          <div key={r.id} className="item" style={{padding:"8px 12px"}}>
            <div className="row1">
              <span className={"chip "+r.prov}>{PROVIDER_LABEL[r.prov]}</span>
              <span className={"title"+(r.ai?" ai":"")+(masked?" priv":"")} style={{fontSize:13}}>{masked?"[private]":r.title}</span>
            </div>
            <div className="row2"><span style={{color:"var(--ink-3)"}}>{r.ago} ago</span></div>
          </div>
        ))}
      </Sec>
    </div>
  );
}

// ── Mock 2: Workstream detail (replaces section in-place)
function WorkstreamDetail({ wsId, onBack, masked, onAction }) {
  const ws = WS[wsId] || WS.switchboard;
  const [check, setCheck] = uS(ws.checklist || []);

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
              <div key={q.id} className="item" style={{padding:"8px 10px"}}>
                <div className="row1">
                  <span className={"chip "+q.target}>{PROVIDER_LABEL[q.target]}</span>
                  <span className="title" style={{fontStyle:"italic", fontWeight:400, fontSize:13}}>{masked?"[private]":q.prompt}</span>
                </div>
                <div className="row2"><span className={"pill "+q.status}>{q.status}</span></div>
              </div>
            ))}
          </>
        )}

        {wsId==="switchboard" && (
          <>
            <h6>Subclusters</h6>
            <div className="item" onClick={()=>{}} style={{padding:"8px 10px", background:"var(--paper)", border:"1px solid var(--rule-soft)"}}>
              <div className="row1">
                <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-3)"}}>{I.folder}</span>
                <span className="title">Ramp-up hypothesis</span>
              </div>
              <div className="row2"><span>2 threads · 1 queued</span></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Mock 7: Inline review composer
function ReviewComposer({ onClose, onDispatch }) {
  const [verdict, setVerdict] = uS("partial");
  const [note, setNote] = uS("");
  const [perSpan, setPerSpan] = uS({});

  return (
    <div className="review">
      <div className="modal-head">
        <button className="close" onClick={onClose}>{I.x}</button>
        <div style={{flex:1}}>
          <h3>Review — captured turn</h3>
          <div className="sub">{PROVIDER_LABEL[REVIEW_FIXTURE.prov]} · captured {new Date(REVIEW_FIXTURE.capturedAt).toLocaleString()}</div>
        </div>
      </div>
      <div className="modal-body">
        {REVIEW_FIXTURE.spans.map((s,i)=>(
          <div key={s.id} style={{marginBottom:14}}>
            <div style={{
              fontFamily:"var(--display)", fontStyle:"italic", fontSize:13.5, color:"var(--ink-2)",
              padding:"8px 12px", background:"var(--paper)", borderRadius:6,
              borderLeft:"2px solid var(--signal)", lineHeight:1.5, marginBottom:6,
            }}>
              "{s.text}"
            </div>
            <div style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--ink-3)", marginBottom:6}}>
              span {i+1} · {PROVIDER_LABEL[REVIEW_FIXTURE.prov]} · 09:11:42
            </div>
            <textarea
              placeholder="Comment on this span…"
              value={perSpan[s.id]||""}
              onChange={e=>setPerSpan({...perSpan, [s.id]: e.target.value})}
              style={{
                width:"100%", minHeight:48, resize:"vertical",
                padding:"6px 10px", border:"1px solid var(--rule)", borderRadius:6,
                background:"var(--paper-light)", fontFamily:"var(--body)", fontSize:13, outline:"none",
              }}
            />
          </div>
        ))}

        <div className="field" style={{marginTop:18}}>
          <label>Reviewer note</label>
          <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Overall: what's right, what's wrong, what needs more…"/>
        </div>

        <div className="field">
          <label>Verdict</label>
          <div className="radio-row">
            {[["agree","Agree"],["disagree","Disagree"],["partial","Partial"],["needs","Needs source"],["open","Open"]].map(([k,l])=>(
              <button key={k} className={"verdict-"+k+(verdict===k?" on":"")} onClick={()=>setVerdict(k)}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{
          fontFamily:"var(--display)", fontStyle:"italic", fontSize:12, color:"var(--ink-3)",
          marginTop:16, lineHeight:1.5,
        }}>
          Saving review will be visible later in <code style={{fontFamily:"var(--mono)", fontStyle:"normal", background:"var(--paper)", padding:"1px 4px", borderRadius:3}}>_BAC/reviews/</code> and in déjà-vu surfacing.
        </div>
      </div>
      <div className="modal-foot">
        <button className="sb-btn" onClick={onClose}>Save review only</button>
        <div className="spacer"/>
        <button className="sb-btn">Submit-back to Claude</button>
        <button className="sb-btn primary" onClick={onDispatch}>Dispatch to…</button>
      </div>
    </div>
  );
}

Object.assign(window, { Workboard, WorkstreamDetail, ReviewComposer, ItemRow });
