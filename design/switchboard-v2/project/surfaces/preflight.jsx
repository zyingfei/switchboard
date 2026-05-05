// Surface 4: Dispatch preflight modal
function Preflight({ onSend, onCancel, autoSend=false, autoSendOpen=false, screenSafe=false }) {
  const [autoOn, setAutoOn] = useState(autoSendOpen);
  return (
    <div className="sb-frame" style={{width:480}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> dispatch preflight</div>
      </div>

      <div style={{padding:"16px 20px", borderBottom:"var(--hair-soft)", background:"var(--paper)"}}>
        <h3 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:19, letterSpacing:"-0.01em", margin:"0 0 4px"}}>Dispatch preflight</h3>
        <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)"}}>3 targets · 1 redaction applied · provenance attached</div>
      </div>

      <div style={{padding:"16px 20px"}}>
        {[
          ["Targets", <span><span style={{color:"var(--signal)", fontWeight:600}}>ChatGPT</span> + <span style={{color:"var(--signal)", fontWeight:600}}>Claude</span> + <span style={{color:"var(--green)", fontWeight:600}}>Notebook</span></span>],
          ["Workstream", <span className="sb-mono" style={{fontSize:12}}>auth-redesign / threats</span>],
          ["Provenance", <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>stripe.com/docs/webhooks/signatures · cite-id <b>e3a7</b></span>],
          ["Redaction", <div>
            <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--green)", display:"inline-flex", alignItems:"center", gap:5}}>
              {Icon.check} 1 API key matched · scrubbed
            </div>
            <div style={{
              background:"var(--amber-bg)", border:"1px solid var(--amber-tint)", borderRadius:"var(--rad-m)",
              padding:"10px 12px", marginTop:8, fontFamily:"var(--mono)", fontSize:11, color:"var(--amber)", lineHeight:1.5,
            }}>
              <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:6, fontWeight:600}}>{Icon.alert}<span>Redaction</span></div>
              <code style={{background:"rgba(161,98,7,.1)", padding:"1px 5px", borderRadius:3}}>sk_live_4f…a91</code>
              <span style={{margin:"0 4px"}}>→</span>
              <code style={{background:"rgba(161,98,7,.1)", padding:"1px 5px", borderRadius:3}}>{"<API_KEY>"}</code>
            </div>
          </div>],
          ["Token cost", <div style={{display:"flex", alignItems:"center", gap:8, fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>
            <div style={{flex:1, height:6, background:"var(--paper-deep)", borderRadius:99, overflow:"hidden"}}>
              <div style={{height:"100%", width:"22%", background:"var(--green)", borderRadius:99}}/>
            </div>
            <span>1.2k / 5k</span>
          </div>],
        ].map(([lbl, val], i)=>(
          <div key={i} style={{
            display:"grid", gridTemplateColumns:"110px 1fr", gap:"var(--r3)",
            padding:"8px 0", borderBottom: i<4?"var(--hair-soft)":"none", alignItems:"start",
          }}>
            <div style={{fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em", textTransform:"uppercase", color:"var(--ink-3)", paddingTop:2}}>{lbl}</div>
            <div style={{fontFamily:"var(--body)", fontSize:13.5, color:"var(--ink)", lineHeight:1.45}}>{val}</div>
          </div>
        ))}
      </div>

      <div style={{padding:"14px 20px", borderTop:"var(--hair-soft)", display:"flex", gap:8, alignItems:"center", background:"var(--paper)"}}>
        <button className={"sb-toggle "+(autoOn?"on":"")} onClick={()=>setAutoOn(!autoOn)} style={{
          background:"none", border:"none", cursor:"pointer",
          fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)",
          display:"flex", alignItems:"center", gap:6, padding:0,
        }}>
          <span style={{
            width:28, height:16, background:autoOn?"var(--ink)":"var(--rule)", borderRadius:99, position:"relative", transition:"all 120ms",
          }}>
            <span style={{
              content:'""', position:"absolute", width:12, height:12, background:"var(--paper-light)",
              borderRadius:"50%", top:2, left:autoOn?14:2, transition:"all 120ms", boxShadow:"0 1px 2px rgba(0,0,0,.15)",
              display:"block",
            }}/>
          </span>
          Skip preflight for this workstream
        </button>
        <div style={{flex:1}}/>
        <button className="sb-btn" onClick={onCancel}>Cancel</button>
        <button className="sb-btn primary" onClick={onSend}>Send {Icon.send}</button>
      </div>
    </div>
  );
}

Object.assign(window, { Preflight });
