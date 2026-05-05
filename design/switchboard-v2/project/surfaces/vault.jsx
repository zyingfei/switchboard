// Surface 5: Obsidian vault dashboard (Bases) — "Where Was I"
function VaultDash({ pulse=false, screenSafe=false, workstream="auth-redesign" }) {
  return (
    <div className="sb-frame" style={{width:920}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url"><b>Obsidian</b> · vault://research/_BAC/where-was-i.base</div>
      </div>
      <div style={{background:"#FAF8F2", display:"flex", flexDirection:"column"}}>
        <div style={{display:"flex", gap:1, background:"var(--paper-deep)", padding:"6px 8px 0", fontFamily:"var(--mono)", fontSize:10.5}}>
          {["Where was I","auth-redesign","Threats","stripe-webhook.md"].map((t,i)=>(
            <div key={i} style={{
              padding:"5px 12px",
              background: i===0?"#FAF8F2":"var(--paper-deep)",
              color: i===0?"var(--ink)":"var(--ink-3)",
              borderRadius:"4px 4px 0 0",
              fontWeight: i===0?600:400,
            }}>{t}</div>
          ))}
        </div>

        <div style={{padding:"18px 24px 14px", display:"flex", alignItems:"baseline", justifyContent:"space-between", borderBottom:"var(--hair-soft)"}}>
          <div>
            <h2 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:26, letterSpacing:"-.015em", margin:0, lineHeight:1.1}}>Where was I?</h2>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", marginTop:4}}>_BAC/where-was-i.base · auto-regenerated 2s ago</div>
          </div>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>view: <b style={{color:"var(--ink)"}}>By workstream</b></div>
        </div>

        <div style={{padding:"10px 24px", display:"flex", gap:6, alignItems:"center", borderBottom:"var(--hair-soft)", background:"var(--paper)"}}>
          {["All","Awaiting","Stale","Drift"].map((c,i)=>(
            <span key={c} style={{
              fontFamily:"var(--mono)", fontSize:10, padding:"3px 9px", borderRadius:99,
              background: i===0?"var(--ink)":"var(--paper-light)",
              color: i===0?"var(--paper-light)":"var(--ink-2)",
              border:"1px solid "+(i===0?"var(--ink)":"var(--rule)"),
            }}>{c}</span>
          ))}
          <div style={{marginLeft:"auto", fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", display:"flex", gap:14}}>
            <span>4 rows · 1 stale · 1 drift</span>
          </div>
        </div>

        <table style={{width:"100%", borderCollapse:"collapse"}}>
          <thead>
            <tr>{["Thread","Workstream","Provider","State","Last touch","Cite"].map(h=>(
              <th key={h} style={{
                textAlign:"left", padding:"10px 24px", fontFamily:"var(--mono)", fontSize:9.5,
                letterSpacing:".12em", textTransform:"uppercase", color:"var(--ink-3)",
                borderBottom:"var(--hair-soft)", fontWeight:500, background:"var(--paper)",
              }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {[
              {n:"Stripe webhook signature flow", sub:"_BAC/threads/stripe-webhook.md", ws:"auth-redesign", prov:"Claude", state:"unread", touch:"14m ago", cite:"e3a7"},
              {n:"Pricing-experiment writeup", sub:"_BAC/threads/pricing-exp.md", ws:"auth-redesign", prov:"ChatGPT", state:"await", touch:"2h ago", cite:"3f12"},
              {n:"Auth-refactor — threat model", sub:"_BAC/threads/threat-model.md", ws:"auth-redesign", prov:"Claude", state:"wait", touch:"1d ago", cite:"7c9b"},
              {n:"Competitor scan — Q2", sub:"_BAC/threads/comp-scan-q2.md", ws:"auth-redesign", prov:"Gemini", state:"stale", touch:"4d ago", cite:"2a18", drift:true},
            ].map((r,i)=>(
              <tr key={i} style={{
                background: pulse && i===0 ? "var(--signal-bg)" : undefined,
                transition:"background 800ms",
              }}>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)"}}>
                  <div style={{fontFamily:"var(--display)", fontWeight:500, color:"var(--ink)", fontSize:14, letterSpacing:"-.005em"}}>{screenSafe?"•••••••••••••••":r.n}</div>
                  <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", marginTop:2}}>{r.sub}</div>
                  {r.drift && <div style={{
                    marginTop:6, fontFamily:"var(--mono)", fontSize:9.5, color:"var(--amber)",
                    display:"inline-flex", alignItems:"center", gap:5,
                    padding:"2px 7px", background:"var(--amber-bg)", border:"1px solid var(--amber-tint)", borderRadius:3,
                  }}>{Icon.alert} drift detected</div>}
                </td>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)", fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>{r.ws}</td>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)", fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>{r.prov}</td>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)"}}>
                  <span className={"sb-pill s-"+r.state} style={{
                    fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:".04em",
                    padding:"2px 7px", borderRadius:99, display:"inline-flex", alignItems:"center", gap:5,
                    border:"1px solid",
                    background: r.state==="unread"?"var(--signal-bg)":r.state==="await"?"var(--green-bg)":r.state==="wait"?"var(--amber-bg)":"var(--slate-bg)",
                    borderColor: r.state==="unread"?"var(--signal-tint)":r.state==="await"?"var(--green-tint)":r.state==="wait"?"var(--amber-tint)":"#CBD5E1",
                    color: r.state==="unread"?"var(--signal)":r.state==="await"?"var(--green)":r.state==="wait"?"var(--amber)":"var(--slate)",
                  }}>
                    <span style={{
                      width:5, height:5, borderRadius:"50%",
                      background: r.state==="unread"?"var(--signal)":r.state==="await"?"var(--green)":r.state==="wait"?"var(--amber)":"var(--slate)",
                    }}/>
                    {r.state.toUpperCase()}
                  </span>
                </td>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)", fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>{r.touch}</td>
                <td style={{padding:"12px 24px", verticalAlign:"top", borderBottom:"var(--hair-soft)", fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)"}}>{r.cite}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// YAML mirror
function YamlMirror() {
  return (
    <div style={{
      background:"#2A2620", color:"#F5EFE2",
      borderRadius:"var(--rad-l)", padding:"16px 18px",
      fontFamily:"var(--mono)", fontSize:12, lineHeight:1.7,
      overflow:"hidden", position:"relative",
      border:"1px solid var(--ink)", width:540, minHeight:540,
    }}>
      <div style={{position:"absolute", top:12, right:14, fontFamily:"var(--mono)", fontSize:9.5, letterSpacing:".1em", textTransform:"uppercase", color:"rgba(245,239,226,.4)"}}>research/auth-redesign/threats/stripe-webhook.md</div>
      {[
        ["1","---"],
        ["2","# bac-managed: do not edit by hand"],
        ["3",<><span style={{color:"#DDB892"}}>workstream</span>: <span style={{color:"#B5E48C"}}>auth-redesign</span></>],
        ["4",<><span style={{color:"#DDB892"}}>bucket</span>: <span style={{color:"#B5E48C"}}>threats</span></>],
        ["5",<><span style={{color:"#DDB892"}}>cite_id</span>: <span style={{color:"#FFB4A2"}}>e3a7</span></>],
        ["6",<><span style={{color:"#DDB892"}}>provider</span>: <span style={{color:"#B5E48C"}}>claude</span></>],
        ["7",<><span style={{color:"#DDB892"}}>thread_id</span>: <span style={{color:"#FED7AA"}}>th_8c41a2</span></>],
        ["8",<><span style={{color:"#DDB892"}}>state</span>: <span style={{color:"#FED7AA"}}>unread</span></>],
        ["9",<><span style={{color:"#DDB892"}}>captured_at</span>: <span style={{color:"#B5E48C"}}>2026-04-25T14:32:11Z</span></>],
        ["10",<><span style={{color:"#DDB892"}}>source_url</span>: <span style={{color:"#B5E48C"}}>stripe.com/docs/webhooks/signatures</span></>],
        ["11",<><span style={{color:"#DDB892"}}>redactions</span>: <span style={{color:"#FFB4A2"}}>1</span></>],
        ["12",<><span style={{color:"#DDB892"}}>edges</span>:</>],
        ["13",<>  - <span style={{color:"#DDB892"}}>kind</span>: <span style={{color:"#B5E48C"}}>cites</span></>],
        ["14",<>    <span style={{color:"#DDB892"}}>target</span>: <span style={{color:"#B5E48C"}}>"[[threat-model]]"</span></>],
        ["15",<>  - <span style={{color:"#DDB892"}}>kind</span>: <span style={{color:"#B5E48C"}}>derives_from</span></>],
        ["16",<>    <span style={{color:"#DDB892"}}>target</span>: <span style={{color:"#B5E48C"}}>"[[stripe-webhook]]#§3"</span></>],
        ["17","---"],
        ["18",""],
        ["19",<span style={{color:"rgba(245,239,226,.5)"}}># Stripe webhook signature flow</span>],
        ["20",<span style={{color:"rgba(245,239,226,.4)", fontStyle:"italic"}}>// thread auto-archived from Claude · click to open vault</span>],
      ].map(([n, content], i)=>(
        <div key={i}><span style={{color:"rgba(245,239,226,.25)", width:24, display:"inline-block", userSelect:"none"}}>{n}</span><span>{content}</span></div>
      ))}
    </div>
  );
}

Object.assign(window, { VaultDash, YamlMirror });
