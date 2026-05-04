// Fake page bodies that fill the browser left-pane

function StripeDocs({ onHighlight, highlighted }) {
  return (
    <div style={{padding:"36px 56px", maxWidth:780, margin:"0 auto", fontFamily:"var(--body)", color:"var(--ink)", lineHeight:1.7}}>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)", marginBottom:10, letterSpacing:"0.04em"}}>
        DOCS · WEBHOOKS
      </div>
      <h1 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:38, letterSpacing:"-0.02em", margin:"0 0 16px"}}>
        Verify webhook signatures
      </h1>
      <p style={{fontSize:16, color:"var(--ink-2)", marginBottom:20}}>
        Stripe signs webhook events it sends to your endpoints by including a signature in each event's
        <code style={{fontFamily:"var(--mono)", fontSize:13, padding:"1px 5px", background:"var(--paper-deep)", borderRadius:3, margin:"0 3px"}}>Stripe-Signature</code>
        header. This lets you verify that the events were sent by Stripe, not by a third party.
      </p>
      <h2 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:24, letterSpacing:"-0.01em", marginTop:32}}>Preventing replay attacks</h2>
      <p style={{fontSize:15.5, color:"var(--ink-2)"}}>
        A replay attack is when an attacker intercepts a valid payload and its signature, then re-sends them.
        To mitigate such attacks, Stripe includes a timestamp in the
        <code style={{fontFamily:"var(--mono)", fontSize:13, padding:"1px 5px", background:"var(--paper-deep)", borderRadius:3, margin:"0 3px"}}>Stripe-Signature</code>
        header.
      </p>
      <p style={{fontSize:15.5, color:"var(--ink-2)"}}>
        Because the timestamp is part of the signed payload, it's also verified by the signature, so
        an attacker can't change the timestamp without invalidating the signature. If the signature is valid
        but the timestamp is too old, you can reject the payload.{" "}
        <span
          onClick={onHighlight}
          style={{
            background: highlighted?"#FFF1E6":"transparent",
            borderBottom: highlighted?"2px solid var(--signal)":"none",
            padding: highlighted?"2px 4px":"0",
            margin: highlighted?"0 -4px":"0",
            cursor:"pointer", borderRadius:2, transition:"all 200ms",
          }}
        >Use HMAC with SHA-256 and reject any timestamp outside ±2 minutes.</span>
      </p>
      <p style={{fontSize:15.5, color:"var(--ink-2)"}}>
        Our library uses a default tolerance of 5 minutes between the timestamp and the current time.
        You can change this by passing the <code style={{fontFamily:"var(--mono)", fontSize:13, padding:"1px 5px", background:"var(--paper-deep)", borderRadius:3}}>tolerance</code> parameter.
      </p>
      <pre style={{
        padding:"18px 20px", background:"#0F1115", color:"#E2E8F0", borderRadius:8, marginTop:20,
        fontFamily:"var(--mono)", fontSize:13, lineHeight:1.65, overflow:"auto",
      }}>
        <span style={{color:"#94A3B8"}}>{`// node — verify signature`}</span>{`
`}
        <span style={{color:"#A78BFA"}}>const</span>{` event `}<span style={{color:"#A78BFA"}}>=</span>{` stripe.webhooks.constructEvent(`}{`
  `}{`payload, sig, secret,`}{`
  `}<span style={{color:"#94A3B8"}}>{`{ tolerance: 120 }`}</span>{`
);`}
      </pre>
      <h2 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:24, letterSpacing:"-0.01em", marginTop:32}}>Verify manually</h2>
      <p style={{fontSize:15.5, color:"var(--ink-2)"}}>
        If you can't use the Stripe library, you can still verify webhooks. The signature scheme is documented in detail below.
      </p>
      <p style={{fontSize:15.5, color:"var(--ink-2)", color:"var(--ink-3)"}}>
        Step 1 — Extract the timestamp and signatures from the header. Split the header using the
        <code style={{fontFamily:"var(--mono)", fontSize:13, padding:"1px 5px", background:"var(--paper-deep)", borderRadius:3, margin:"0 3px"}}>,</code> character …
      </p>
    </div>
  );
}

function ChatGPTPage() {
  return (
    <div style={{display:"flex", flexDirection:"column", height:"100%", background:"#FAF9F7"}}>
      <div style={{padding:"10px 18px", borderBottom:"1px solid #E8E5DD", display:"flex", alignItems:"center", gap:10, fontFamily:"var(--body)"}}>
        <div style={{width:26, height:26, borderRadius:"50%", background:"#10A37F", display:"grid", placeItems:"center", color:"white", fontWeight:700, fontFamily:"var(--mono)", fontSize:12}}>G</div>
        <span style={{fontWeight:500, fontSize:14}}>ChatGPT</span>
        <span style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-3)"}}>· PRD §24.10 dispatch wording</span>
      </div>
      <div style={{flex:1, overflow:"auto", padding:"24px 0"}}>
        <div style={{maxWidth:720, margin:"0 auto", padding:"0 24px"}}>
          <div style={{padding:"14px 18px", marginBottom:14, fontFamily:"var(--body)", fontSize:15, color:"var(--ink)", lineHeight:1.6}}>
            <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>You</div>
            Help me tighten the wording for §24.10 — specifically the rule that auto-send is opt-in per provider. The current draft is mushy.
          </div>
          <div style={{padding:"16px 20px", background:"white", border:"1px solid #E8E5DD", borderRadius:10, fontFamily:"var(--body)", fontSize:15, color:"var(--ink)", lineHeight:1.65}}>
            <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"var(--ink-3)", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.06em"}}>ChatGPT</div>
            <p style={{margin:"0 0 12px"}}>Here's a tighter version:</p>
            <blockquote style={{
              margin:"10px 0", padding:"10px 14px", borderLeft:"3px solid #10A37F",
              background:"#F5F9F7", fontFamily:"var(--display)", fontStyle:"italic", fontSize:15.5,
            }}>
              Dispatch defaults to paste-mode. Auto-send is disabled by default for every provider, and must be explicitly enabled per provider in Settings — the toggle is opt-in only and is not exposed via API.
            </blockquote>
            <p style={{margin:"0 0 0"}}>This makes three things explicit: (1) the default is paste, (2) auto-send is per-provider, (3) there's no API workaround. Want me to draft the Settings copy too?</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ObsidianVault() {
  return (
    <div style={{display:"flex", height:"100%", background:"#1E1E22", color:"#D4D4D4", fontFamily:"var(--body)"}}>
      <div style={{width:260, background:"#252529", borderRight:"1px solid #18181B", padding:"14px 12px", overflow:"auto"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"#888", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10}}>VAULT · _BAC</div>
        {[
          ["📁","workstreams/"],
          ["  📁","switchboard/"],
          ["    📄","mvp-prd.md"],
          ["    📄","ramp-up.md"],
          ["    📁","subclusters/"],
          ["📁","captures/"],
          ["📁","packets/"],
          ["    📄","prd-context-v3.md"],
          ["📁","reviews/"],
          ["📁","dispatches/"],
        ].map(([i,n])=>(
          <div key={n} style={{padding:"4px 8px", fontFamily:"var(--mono)", fontSize:12, cursor:"pointer", borderRadius:3, color: n.includes("mvp-prd")?"#FFA94D":"#D4D4D4", background: n.includes("mvp-prd")?"rgba(194,65,12,0.15)":"transparent"}}>
            {i} {n.trim()}
          </div>
        ))}
      </div>
      <div style={{flex:1, padding:"32px 48px", overflow:"auto"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:10.5, color:"#888", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10}}>workstreams/switchboard/mvp-prd.md</div>
        <h1 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:32, color:"#F5EFE2", letterSpacing:"-0.01em", margin:"0 0 16px"}}>Switchboard / MVP PRD</h1>
        <pre style={{fontFamily:"var(--mono)", fontSize:12.5, color:"#A3A3A3", background:"#18181B", padding:"14px 16px", borderRadius:6, lineHeight:1.6, marginBottom:20}}>{`---
bac_id: ws_8c41a2f0
kind: project
tags: [P0, spec]
created: 2026-04-12
updated: 2026-04-26T09:14
---`}</pre>
        <h2 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:22, color:"#E5E5E5", marginTop:24}}>Tracked items</h2>
        <ul style={{fontFamily:"var(--body)", fontSize:14.5, lineHeight:1.85, color:"#C4C4C4", paddingLeft:24}}>
          <li>[[claude · Side-panel state machine review]] — 3 min ago · 4 links</li>
          <li>[[gpt · PRD §24.10 dispatch safety wording]] — 2h ago · 2 links</li>
          <li>[[codex · sb_companion · capture pipeline scaffold]] — yesterday</li>
          <li>[[packet · PRD context v3]]</li>
        </ul>
        <h2 style={{fontFamily:"var(--display)", fontWeight:500, fontSize:22, color:"#E5E5E5", marginTop:24}}>Manual checklist</h2>
        <ul style={{fontFamily:"var(--body)", fontSize:14.5, lineHeight:1.85, color:"#C4C4C4", paddingLeft:24, listStyle:"none"}}>
          <li>☑ Lock §24.10 paste-mode default copy</li>
          <li>☑ Decide companion install path</li>
          <li>☐ Spec the redaction rules registry</li>
          <li>☐ Wireframe dispatch confirm states</li>
        </ul>
      </div>
    </div>
  );
}

Object.assign(window, { StripeDocs, ChatGPTPage, ObsidianVault });
