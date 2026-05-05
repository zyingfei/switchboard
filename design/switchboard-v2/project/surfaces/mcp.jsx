// Surface 6: MCP server settings panel
function McpSettings({ running=true, onToggle }) {
  const [open, setOpen] = useState(running);
  const live = onToggle ? running : open;
  const flip = ()=>{ if(onToggle) onToggle(); else setOpen(!open); };

  return (
    <div className="sb-frame" style={{width:480}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">switchboard <b>·</b> settings · integrations</div>
      </div>

      <div style={{padding:"18px 20px", borderBottom:"var(--hair-soft)"}}>
        <h4 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:16, letterSpacing:"-.005em", margin:"0 0 12px"}}>
          MCP Server <em style={{fontStyle:"italic", fontWeight:400, color:"var(--ink-3)", fontSize:13, marginLeft:6}}>localhost · read-only</em>
        </h4>

        <div style={{background:"var(--paper)", border:"1px solid var(--rule)", borderRadius:"var(--rad-m)", padding:12}}>
          {[
            ["Status", <span style={{color:live?"var(--green)":"var(--ink-3)", fontFamily:"var(--mono)", fontSize:12, display:"inline-flex", alignItems:"center", gap:6}}>
              <span style={{width:7, height:7, borderRadius:"50%", background:live?"var(--green)":"var(--ink-4)", animation:live?"sb-pulse-amber 2s infinite":undefined}}/>
              {live?"Running":"Stopped"}
            </span>],
            ["Endpoint", "ws://127.0.0.1:8721/mcp"],
            ["Transport", "WebSocket · Streamable HTTP fallback"],
            ["API key", "sk_bac_••••••a91"],
          ].map(([k,v], i)=>(
            <div key={i} style={{display:"grid", gridTemplateColumns:"90px 1fr auto", gap:"var(--r3)", alignItems:"center", padding:"4px 0"}}>
              <span style={{fontFamily:"var(--mono)", fontSize:10, letterSpacing:".06em", textTransform:"uppercase", color:"var(--ink-3)"}}>{k}</span>
              <span style={{fontFamily:"var(--mono)", fontSize:12, color:"var(--ink)"}}>{v}</span>
              <button className="sb-icon-btn" title="Copy">{Icon.copy}</button>
            </div>
          ))}
        </div>

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginTop:10}}>
          {[
            ["bac.search", "Vector recall over event log + captures", true],
            ["bac.recent_threads", "List active threads by workstream", true],
            ["bac.workstream", "Read workstream graph + edges", true],
            ["bac.context_pack", "Build a portable handoff bundle", true],
            ["bac.append_decision", "Write a typed decision (deferred)", false],
            ["bac.dispatch", "Send a prompt from the agent (deferred)", false],
          ].map(([n,d,read], i)=>(
            <div key={i} style={{
              border:"1px solid var(--rule-soft)", borderRadius:"var(--rad-s)",
              padding:"8px 10px", background:"var(--paper-light)",
              opacity: read?1:0.55,
            }}>
              <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink)", fontWeight:600}}>{n}
                <span style={{
                  marginLeft:6, fontSize:8.5, letterSpacing:".1em",
                  padding:"1px 4px", borderRadius:2, verticalAlign:1,
                  color: read?"var(--green)":"var(--amber)",
                  background: read?"var(--green-bg)":"var(--amber-bg)",
                }}>{read?"READ":"v1.5"}</span>
              </div>
              <div style={{fontFamily:"var(--body)", fontSize:11.5, color:"var(--ink-3)", marginTop:2, lineHeight:1.4}}>{d}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{padding:"18px 20px"}}>
        <h4 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:16, margin:"0 0 12px"}}>
          Connected agents <em style={{fontStyle:"italic", fontWeight:400, color:"var(--ink-3)", fontSize:13, marginLeft:6}}>{live?"3 live":"none"}</em>
        </h4>
        <div style={{display:"flex", flexDirection:"column", gap:6}}>
          {[
            ["CC", "Claude Code", "claude --chrome bridge", true, "8 calls today"],
            ["CU", "Cursor", "cursor mcp config", true, "23 calls today"],
            ["CO", "Codex CLI", "codex --mcp ws://...", true, "2 calls today"],
            ["WS", "Windsurf", "not configured", false, ""],
          ].map(([ic,nm,sub,on,ct], i)=>(
            <div key={i} style={{
              display:"grid", gridTemplateColumns:"32px 1fr auto auto", gap:12, alignItems:"center",
              padding:"10px 12px", border:"1px solid var(--rule-soft)", borderRadius:"var(--rad-m)",
              background:"var(--paper)",
            }}>
              <div style={{
                width:32, height:32, borderRadius:"var(--rad-s)", border:"1px solid var(--rule)",
                display:"grid", placeItems:"center", fontFamily:"var(--mono)", fontSize:12, fontWeight:600,
                background:"var(--paper-light)", color:"var(--ink)",
              }}>{ic}</div>
              <div>
                <div style={{fontFamily:"var(--display)", fontWeight:500, fontSize:14}}>{nm}</div>
                <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", marginTop:2}}>{sub}</div>
              </div>
              <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:on&&live?"var(--green)":"var(--ink-3)", display:"inline-flex", alignItems:"center", gap:5}}>
                <span style={{width:6, height:6, borderRadius:"50%", background:on&&live?"var(--green)":"var(--ink-4)"}}/>
                {on&&live?"connected":"off"}
              </div>
              {on&&live ? (
                <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)"}}>{ct}</div>
              ) : (
                <button style={{fontFamily:"var(--mono)", fontSize:10, padding:"4px 10px", background:"transparent", border:"1px solid var(--rule)", borderRadius:"var(--rad-s)", color:"var(--ink-2)", cursor:"pointer"}}>Connect</button>
              )}
            </div>
          ))}
        </div>

        <div style={{marginTop:14, display:"flex", gap:8}}>
          <button className="sb-btn primary" onClick={flip}>{live?"Stop server":"Start server"}</button>
          <button className="sb-btn">Rotate API key</button>
          <button className="sb-btn">View logs</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { McpSettings });
