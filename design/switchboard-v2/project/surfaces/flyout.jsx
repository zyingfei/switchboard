// Surface 3: On-page selection flyout
function Flyout({ onDispatch, onClose, demoActive=false }) {
  const [targets, setTargets] = useState({ chatgpt:true, claude:true, gemini:false, search:false, notebook:true });
  const toggle = k => setTargets({...targets, [k]:!targets[k]});

  return (
    <div style={{
      background:"var(--paper-light)", border:"1px solid var(--ink)", borderRadius:"var(--rad-l)",
      padding:12, width:320,
      boxShadow:"0 1px 0 rgba(27,25,22,.04), 0 14px 32px -10px rgba(27,25,22,.25), 0 30px 60px -20px rgba(27,25,22,.18)",
      animation: demoActive ? "sb-deja-in 240ms cubic-bezier(.2,.8,.2,1)" : undefined,
    }}>
      <div style={{
        fontFamily:"var(--display)", fontStyle:"italic", fontSize:13, color:"var(--ink-2)",
        padding:"6px 10px", background:"var(--paper)", borderRadius:"var(--rad-s)",
        borderLeft:"2px solid var(--signal)", marginBottom:10, lineHeight:1.5,
      }}>
        "…verify the <b style={{fontStyle:"normal"}}>tolerance window</b> server-side; 5min is too generous…"
      </div>

      <div style={{
        fontFamily:"var(--mono)", fontSize:9, letterSpacing:".12em", textTransform:"uppercase",
        color:"var(--ink-3)", margin:"10px 0 6px", display:"flex", justifyContent:"space-between",
      }}>
        <span>Dispatch to</span><span>3 selected</span>
      </div>
      <div style={{display:"flex", flexWrap:"wrap", gap:4}}>
        {[
          ["chatgpt","ChatGPT","gpt"],
          ["claude","Claude","claude"],
          ["gemini","Gemini","gemini"],
          ["search","Web search","search"],
          ["notebook","+ Notebook","notebook"],
        ].map(([k,label,m])=>(
          <button key={k} onClick={()=>toggle(k)} style={{
            fontFamily:"var(--mono)", fontSize:10, padding:"4px 9px", borderRadius:99,
            border:"1px solid "+(targets[k]?"var(--ink)":"var(--rule)"),
            background:targets[k]?"var(--ink)":"var(--paper)",
            color:targets[k]?"var(--paper-light)":"var(--ink)",
            display:"inline-flex", alignItems:"center", gap:5, cursor:"pointer",
          }}>
            <span style={{
              width:5, height:5, borderRadius:"50%",
              background:m==="gpt"?"#1B5E3F":m==="claude"?"#884617":m==="gemini"?"#2E4A8C":m==="search"?"var(--ink-3)":"var(--signal)"
            }}/>
            {label}
          </button>
        ))}
      </div>

      <div style={{
        marginTop:12, paddingTop:10, borderTop:"var(--hair-soft)",
        fontFamily:"var(--mono)", fontSize:10, color:"var(--amber)",
        display:"flex", alignItems:"center", gap:6,
      }}>
        {Icon.alert}<span>Redaction will scrub <b>1 API key</b> before send.</span>
      </div>

      <div style={{display:"flex", gap:6, marginTop:10}}>
        <button className="sb-btn primary" style={{flex:1}} onClick={onDispatch}>Send {Icon.send}</button>
        <button className="sb-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

Object.assign(window, { Flyout });
