// Extra surfaces: Workstream graph (canvas DAG), Context Pack export, Drift, Fork-converge, Inbox

function GraphCanvas() {
  return (
    <div className="sb-frame" style={{width:680, height:480}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url"><b>Obsidian</b> · vault://research/_BAC/auth-redesign.canvas</div>
      </div>
      <div style={{flex:1, position:"relative", background:"#FAF8F2",
        backgroundImage:"radial-gradient(circle, rgba(27,25,22,.08) 1px, transparent 1px)",
        backgroundSize:"22px 22px",
      }}>
        <svg style={{position:"absolute", inset:0, width:"100%", height:"100%"}}>
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)"/>
            </marker>
          </defs>
          <path d="M170 100 C 240 100, 240 220, 320 220" stroke="var(--ink-3)" strokeWidth="1.5" fill="none" markerEnd="url(#arr)"/>
          <path d="M170 100 C 240 100, 240 340, 320 340" stroke="var(--ink-3)" strokeWidth="1.5" fill="none" markerEnd="url(#arr)"/>
          <path d="M450 220 C 530 220, 530 340, 480 340" stroke="var(--signal)" strokeWidth="1.5" fill="none" strokeDasharray="3 3" markerEnd="url(#arr)"/>
          <path d="M450 220 C 540 220, 580 130, 540 100" stroke="var(--ink-3)" strokeWidth="1.5" fill="none" markerEnd="url(#arr)"/>
        </svg>

        {[
          {x:40, y:70, w:130, h:60, kind:"ws", t:"auth-redesign", s:"workstream"},
          {x:320, y:195, w:130, h:50, kind:"bucket", t:"threats", s:"bucket · 4 notes"},
          {x:320, y:315, w:130, h:50, kind:"bucket", t:"impl-notes", s:"bucket · 2 notes"},
          {x:480, y:80, w:140, h:50, kind:"src", t:"stripe-webhook.md", s:"source · cite e3a7"},
          {x:480, y:315, w:140, h:50, kind:"thread", t:"Threat model thread", s:"Claude · awaiting"},
        ].map((n,i)=>(
          <div key={i} style={{
            position:"absolute", left:n.x, top:n.y, width:n.w, height:n.h,
            background:"var(--paper-light)",
            border:"1px solid "+(n.kind==="ws"?"var(--ink)":n.kind==="thread"?"var(--signal)":"var(--rule)"),
            borderRadius:"var(--rad-m)",
            padding:"8px 10px",
            boxShadow:"0 2px 6px rgba(27,25,22,.05)",
            cursor:"move",
          }}>
            <div style={{
              fontFamily:"var(--mono)", fontSize:8.5, letterSpacing:".12em", textTransform:"uppercase",
              color: n.kind==="ws"?"var(--signal)":"var(--ink-3)",
            }}>{n.kind==="ws"?"WORKSTREAM":n.kind==="bucket"?"BUCKET":n.kind==="thread"?"THREAD":"SOURCE"}</div>
            <div style={{fontFamily:"var(--display)", fontSize:13, fontWeight:500, color:"var(--ink)", marginTop:2}}>{n.t}</div>
            <div style={{fontFamily:"var(--mono)", fontSize:9.5, color:"var(--ink-3)", marginTop:1}}>{n.s}</div>
          </div>
        ))}

        <div style={{
          position:"absolute", bottom:12, left:12,
          fontFamily:"var(--mono)", fontSize:9.5, color:"var(--ink-3)",
          background:"var(--paper-light)", border:"var(--hair)", borderRadius:"var(--rad-s)",
          padding:"4px 8px",
        }}>5 nodes · 4 edges · auto-layout</div>
      </div>
    </div>
  );
}

function ContextPack({ onCopy }) {
  return (
    <div className="sb-frame" style={{width:480}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> context pack export</div>
      </div>
      <div style={{padding:"16px 20px", borderBottom:"var(--hair-soft)", background:"var(--paper)"}}>
        <h3 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:19, margin:"0 0 4px"}}>Build a Context Pack</h3>
        <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)"}}>auth-redesign / threats · 6 captures · 3 threads</div>
      </div>

      <div style={{padding:"16px 20px"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:9, letterSpacing:".12em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:8}}>Include</div>
        {[
          ["Claims & decisions (typed)", true, "4 items"],
          ["Source captures w/ provenance", true, "6 items"],
          ["Thread excerpts (last 14 days)", true, "12 items"],
          ["Open questions", true, "3 items"],
          ["Full transcripts", false, "would add 38k tok"],
          ["Vault attachments", false, "0"],
        ].map(([n,on,c],i)=>(
          <div key={i} style={{display:"flex", alignItems:"center", padding:"8px 0", borderBottom: i<5?"var(--hair-soft)":"none"}}>
            <span style={{width:16, height:16, borderRadius:3, border:"1.5px solid "+(on?"var(--ink)":"var(--rule)"), background:on?"var(--ink)":"transparent", display:"grid", placeItems:"center", marginRight:10}}>
              {on && <span style={{color:"var(--paper-light)", fontSize:10}}>✓</span>}
            </span>
            <span style={{fontFamily:"var(--body)", fontSize:13.5, color:on?"var(--ink)":"var(--ink-3)", flex:1}}>{n}</span>
            <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>{c}</span>
          </div>
        ))}

        <div style={{
          marginTop:14, padding:"10px 12px", background:"#2A2620", color:"#F5EFE2",
          borderRadius:"var(--rad-m)", fontFamily:"var(--mono)", fontSize:11, lineHeight:1.6,
        }}>
          <span style={{color:"#DDB892"}}>$</span> bac context-pack <span style={{color:"#B5E48C"}}>--workstream</span> auth-redesign <span style={{color:"#B5E48C"}}>--out</span> pack.md<br/>
          <span style={{color:"rgba(245,239,226,.4)"}}># 4.2 KB · 1,180 tokens · signed</span>
        </div>
      </div>

      <div style={{padding:"14px 20px", borderTop:"var(--hair-soft)", background:"var(--paper)", display:"flex", gap:8}}>
        <button className="sb-btn">Copy markdown</button>
        <button className="sb-btn">Save to vault</button>
        <div style={{flex:1}}/>
        <button className="sb-btn primary" onClick={onCopy}>Send to agent {Icon.arrowR}</button>
      </div>
    </div>
  );
}

function DriftDelta() {
  return (
    <div className="sb-frame" style={{width:460}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> drift detected</div>
      </div>
      <div style={{padding:"14px 18px", borderBottom:"var(--hair-soft)", background:"var(--amber-bg)", display:"flex", alignItems:"center", gap:10}}>
        <span style={{color:"var(--amber)", display:"inline-flex"}}>{Icon.alert}</span>
        <div>
          <div style={{fontFamily:"var(--display)", fontWeight:600, fontSize:14, color:"var(--ink)"}}>Note has drifted from open thread</div>
          <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--amber)"}}>Gemini · "Competitor scan — Q2" · saw v3, note now v5</div>
        </div>
      </div>

      <div style={{padding:"16px 18px", fontFamily:"var(--mono)", fontSize:11.5, lineHeight:1.7, background:"var(--paper-light)"}}>
        <div style={{color:"var(--ink-3)", marginBottom:6}}>delta: comp-scan-q2.md @ §"ramp-up curves"</div>
        <div style={{background:"#FFF5F2", borderLeft:"3px solid #C2410C", padding:"4px 10px", color:"var(--ink-2)"}}>
          <span style={{color:"#C2410C", fontWeight:600}}>−</span> activation curve flattens after week 3
        </div>
        <div style={{background:"var(--green-bg)", borderLeft:"3px solid var(--green)", padding:"4px 10px", color:"var(--ink-2)", marginTop:4}}>
          <span style={{color:"var(--green)", fontWeight:600}}>+</span> activation curve flattens after week 3, but recovers if email day-7 references first capture
        </div>
        <div style={{background:"var(--green-bg)", borderLeft:"3px solid var(--green)", padding:"4px 10px", color:"var(--ink-2)", marginTop:4}}>
          <span style={{color:"var(--green)", fontWeight:600}}>+</span> see [[onboarding-cohort-math]] §3
        </div>
      </div>

      <div style={{padding:"12px 18px", borderTop:"var(--hair-soft)", display:"flex", gap:6, background:"var(--paper)"}}>
        <button className="sb-btn primary">Push delta to Gemini</button>
        <button className="sb-btn">Mark resolved</button>
        <div style={{flex:1}}/>
        <button className="sb-btn" style={{background:"transparent"}}>Snooze</button>
      </div>
    </div>
  );
}

function ForkConverge() {
  const cols = [
    { prov:"gpt", label:"ChatGPT", text:"Use HMAC-SHA256 with a 5-minute tolerance window. Reject duplicates by event id within a 24h cache." },
    { prov:"claude", label:"Claude", text:"Tighten tolerance to 90 seconds for prod. Verify timestamp before signature; reject on clock skew >120s." },
    { prov:"gemini", label:"Gemini", text:"Use HMAC + idempotency key in header. Document the failure mode for replays explicitly." },
  ];
  return (
    <div className="sb-frame" style={{width:780}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> fork &amp; converge · 3 of 3 returned</div>
      </div>
      <div style={{padding:"14px 18px", borderBottom:"var(--hair-soft)", background:"var(--paper)", display:"flex", alignItems:"center", gap:8}}>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>PROMPT</span>
        <span style={{fontFamily:"var(--display)", fontStyle:"italic", fontSize:14, color:"var(--ink-2)"}}>"How should we verify Stripe webhook signatures?"</span>
        <div style={{flex:1}}/>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--green)"}}>● 3/3 returned</span>
      </div>
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", borderBottom:"var(--hair-soft)"}}>
        {cols.map((c,i)=>(
          <div key={i} style={{padding:"14px 16px", borderRight: i<2?"var(--hair-soft)":"none"}}>
            <span className={"sb-prov "+c.prov}>{c.label}</span>
            <p style={{fontFamily:"var(--body)", fontSize:13, color:"var(--ink)", lineHeight:1.55, marginTop:10}}>
              {c.text.split(/(HMAC|SHA256|tolerance|idempotency|replay|signature)/g).map((s,j)=>{
                const hl = ["HMAC","SHA256","tolerance","idempotency","replay","signature"].includes(s);
                return hl ? <span key={j} style={{background:"var(--signal-tint)", padding:"0 2px", borderRadius:2}}>{s}</span> : <span key={j}>{s}</span>;
              })}
            </p>
            <div style={{display:"flex", gap:6, marginTop:10}}>
              <button className="sb-ghost" style={{borderColor:"var(--rule)", color:"var(--ink-2)"}}>+ Merge</button>
              <button className="sb-ghost" style={{borderColor:"var(--rule)", color:"var(--ink-2)"}}>Save claim</button>
            </div>
          </div>
        ))}
      </div>
      <div style={{padding:"14px 18px", background:"var(--signal-bg)"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:9, letterSpacing:".14em", textTransform:"uppercase", color:"var(--signal)", marginBottom:6}}>Convergence draft · 3 chunks accepted</div>
        <p style={{fontFamily:"var(--body)", fontSize:13, color:"var(--ink)", margin:0, lineHeight:1.55}}>
          Verify webhooks with <b>HMAC-SHA256</b>, tighten tolerance window to 90 seconds for prod, dedupe by event id with 24h cache, and document the replay failure mode explicitly.
        </p>
      </div>
    </div>
  );
}

function Inbox() {
  const items = [
    { p:"claude", icon:"signal", t:"Claude replied", s:"Stripe webhook signature flow", w:"auth-redesign", time:"14m" },
    { p:"gpt", icon:"green", t:"You replied", s:"Pricing-experiment writeup", w:"auth-redesign", time:"2h" },
    { p:"gemini", icon:"amber", t:"Drift detected", s:"Competitor scan — Q2", w:"auth-redesign", time:"6h", drift:true },
    { p:"claude", icon:"amber", t:"Awaiting your reply", s:"Auth-refactor — threat model", w:"auth-redesign", time:"1d" },
    { p:"gpt", icon:"gray", t:"Thread went stale", s:"Onboarding cohort math", w:"ramp-up-hypothesis", time:"3d" },
  ];
  return (
    <div className="sb-frame" style={{width:420, height:560}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> inbox</div>
      </div>
      <div className="sb-app-head">
        <div className="sb-mark"><span style={{display:"inline-flex", color:"var(--ink-2)"}}>{Icon.inbox}</span> Inbox</div>
        <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>5 items · 1 unread</div>
      </div>
      <div style={{flex:1, overflow:"auto"}}>
        {items.map((it,i)=>(
          <div key={i} style={{
            padding:"12px 16px", borderBottom:"var(--hair-soft)", display:"grid",
            gridTemplateColumns:"auto 1fr auto", gap:10, alignItems:"start", cursor:"pointer",
            background: it.icon==="signal" ? "var(--signal-bg)" : undefined,
          }}>
            <span className={"sb-dot "+it.icon} style={{marginTop:6}}/>
            <div>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <span className={"sb-prov "+it.p}>{it.p==="gpt"?"ChatGPT":it.p==="claude"?"Claude":"Gemini"}</span>
                <span style={{fontFamily:"var(--display)", fontSize:13.5, fontWeight:500}}>{it.t}</span>
                {it.drift && <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--amber)", background:"var(--amber-bg)", border:"1px solid var(--amber-tint)", padding:"1px 5px", borderRadius:3}}>DRIFT</span>}
              </div>
              <div style={{fontFamily:"var(--body)", fontSize:12.5, color:"var(--ink-2)", marginTop:3, lineHeight:1.45}}>{it.s}</div>
              <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", marginTop:3}}>{it.w}</div>
            </div>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>{it.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { GraphCanvas, ContextPack, DriftDelta, ForkConverge, Inbox });
