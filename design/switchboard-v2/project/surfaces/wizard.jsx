// Surface 7: First-run wizard · Surface 8: Screen-share-safe banner

function Wizard({ step=2, onNext, onBack }) {
  return (
    <div className="sb-frame" style={{width:520}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> first run · step {step} of 4</div>
      </div>

      <div style={{padding:"22px 28px 18px", borderBottom:"var(--hair-soft)", background:"var(--paper-deep)"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:10, letterSpacing:".14em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:6}}>Step {step} of 4 · Connect Obsidian</div>
        <h2 style={{fontFamily:"var(--display)", fontWeight:400, fontSize:28, margin:0, letterSpacing:"-.02em", lineHeight:1.1}}>
          Point us at your <em style={{fontStyle:"italic", color:"var(--signal)", fontWeight:400}}>vault.</em>
        </h2>
        <div style={{display:"flex", gap:4, marginTop:14}}>
          {[1,2,3,4].map(i=>(
            <span key={i} style={{
              height:3, flex:1, borderRadius:2,
              background: i<step?"var(--ink)":i===step?"var(--signal)":"var(--rule)",
            }}/>
          ))}
        </div>
      </div>

      <div style={{padding:"22px 28px"}}>
        <p style={{fontFamily:"var(--body)", fontSize:15, color:"var(--ink-2)", margin:"0 0 18px", lineHeight:1.55}}>
          SwitchBoard writes plain Markdown into your Obsidian vault. We'll only touch the <code style={{fontFamily:"var(--mono)", background:"var(--paper-deep)", padding:"1px 5px", borderRadius:3, fontSize:13}}>_BAC/</code> folder unless you tell us otherwise.
        </p>

        <div style={{marginBottom:14}}>
          <label style={{display:"block", fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:6}}>Local REST API endpoint</label>
          <div style={{display:"flex", border:"1px solid var(--rule)", borderRadius:"var(--rad-m)", background:"var(--paper-light)", overflow:"hidden"}}>
            <input defaultValue="https://127.0.0.1:27124" style={{flex:1, border:0, background:"transparent", outline:"none", padding:"9px 12px", fontFamily:"var(--mono)", fontSize:12.5, color:"var(--ink)"}}/>
            <div style={{padding:"0 12px", borderLeft:"var(--hair-soft)", display:"grid", placeItems:"center", fontFamily:"var(--mono)", fontSize:10, color:"var(--green)", background:"var(--paper)"}}>● live</div>
          </div>
        </div>

        <div style={{marginBottom:14}}>
          <label style={{display:"block", fontFamily:"var(--mono)", fontSize:10, letterSpacing:".08em", textTransform:"uppercase", color:"var(--ink-3)", marginBottom:6}}>API key</label>
          <div style={{display:"flex", border:"1px solid var(--rule)", borderRadius:"var(--rad-m)", background:"var(--paper-light)", overflow:"hidden"}}>
            <input type="password" defaultValue="••••••••••••••••••••••••" style={{flex:1, border:0, background:"transparent", outline:"none", padding:"9px 12px", fontFamily:"var(--mono)", fontSize:12.5, color:"var(--ink)"}}/>
            <button style={{padding:"0 12px", borderLeft:"var(--hair-soft)", border:0, fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", background:"var(--paper)", cursor:"pointer"}}>Show</button>
          </div>
        </div>

        <div style={{background:"var(--paper)", border:"1px solid var(--rule)", borderRadius:"var(--rad-m)", padding:"12px 14px", fontFamily:"var(--body)", fontSize:13, color:"var(--ink-2)", lineHeight:1.55}}>
          Don't have it yet? Install <code style={{fontFamily:"var(--mono)", background:"var(--paper-deep)", padding:"1px 5px", borderRadius:3}}>obsidian-local-rest-api</code> from Community Plugins, then copy your key from <a href="#" style={{color:"var(--signal)", textDecoration:"underline dotted"}}>Settings → Local REST API</a>.
        </div>
      </div>

      <div style={{padding:"14px 28px", borderTop:"var(--hair-soft)", display:"flex", gap:8, background:"var(--paper)"}}>
        <button className="sb-btn" onClick={onBack}>← Back</button>
        <button className="sb-btn" style={{background:"transparent"}}>Skip for now</button>
        <div style={{flex:1}}/>
        <button className="sb-btn primary" onClick={onNext}>Test connection</button>
      </div>
    </div>
  );
}

// Screen-share-safe banner header (surface variant — full side panel handled by SidePanel screenSafe prop)
function ScreenSafeBanner() {
  return (
    <div style={{
      background:"linear-gradient(90deg, #1B1916 0%, #2A2620 100%)",
      color:"var(--paper-light)",
      padding:"8px 14px",
      display:"flex", alignItems:"center", gap:8,
      fontFamily:"var(--mono)", fontSize:10.5, letterSpacing:".04em",
    }}>
      <span style={{width:13, height:13, display:"inline-flex"}}>{Icon.cast}</span>
      <b style={{color:"var(--signal-tint)", marginRight:4}}>SCREEN SHARING DETECTED</b>
      <span>· workstream names &amp; provenance masked · <u style={{cursor:"pointer"}}>override</u></span>
    </div>
  );
}

Object.assign(window, { Wizard, ScreenSafeBanner });
