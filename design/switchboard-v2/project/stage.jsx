// Stage — the demo shell. Full viewport. Browser left + side panel right.

const { useState: aS, useEffect: aE, useRef: aR } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scenario": "stripe",
  "screenShare": false,
  "companion": "ok",
  "vault": "ok",
  "highContrast": false
}/*EDITMODE-END*/;

// Demo script: ordered steps.
const DEMO_STEPS = [
  { k:"idle",       label:"ready" },
  { k:"highlight",  label:"User highlights replay-defense line" },
  { k:"annotate",   label:"Annotation popup → save to PRD workstream" },
  { k:"panelOpen",  label:"Item appears in PRD workstream" },
  { k:"reviewOpen", label:"Open inline review composer" },
  { k:"packet",     label:"Generate context pack" },
  { k:"dispatch",   label:"Dispatch confirm — safety chain" },
  { k:"sent",       label:"Sent · queued reply expected" },
  { k:"reply",      label:"Claude replied — inbound pulse" },
  { k:"recovery",   label:"Tab closed → recover dialog" },
  { k:"done",       label:"demo complete" },
];

function Stage() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = aS({ name:"workboard" }); // workboard | settings | wsDetail
  const [wsExpanded, setWsExpanded] = aS(null);
  const [modal, setModal] = aS(null);
  const [reviewOpen, setReviewOpen] = aS(false);
  const [highlighted, setHighlighted] = aS(false);
  const [toast, setToast] = aS(null);
  const [demoIdx, setDemoIdx] = aS(0);
  const [demoPlaying, setDemoPlaying] = aS(false);
  const demoTimer = aR(null);

  // Demo orchestrator
  aE(()=>{
    if (!demoPlaying) return;
    const step = DEMO_STEPS[demoIdx];
    const apply = () => {
      switch(step.k) {
        case "highlight": setTweak("scenario","stripe"); setHighlighted(true); break;
        case "annotate":  setModal("annotation"); break;
        case "panelOpen": setModal(null); setView({name:"wsDetail", ws:"switchboard"}); setToast("Saved to Switchboard / MVP PRD"); break;
        case "reviewOpen": setToast(null); setReviewOpen(true); break;
        case "packet":    setReviewOpen(false); setModal("packet"); break;
        case "dispatch":  setModal("dispatch"); break;
        case "sent":      setModal(null); setToast("Dispatched to Claude"); break;
        case "reply":     setToast(null); setView({name:"workboard"}); break;
        case "recovery":  setModal("recovery"); break;
        case "done":      setModal(null); setDemoPlaying(false); break;
        case "idle":
        default:
          setHighlighted(false); setModal(null); setReviewOpen(false); setToast(null);
          setView({name:"workboard"});
      }
    };
    apply();
    if (step.k !== "done") {
      demoTimer.current = setTimeout(()=>setDemoIdx(i=>i+1), step.k==="idle"?400:2200);
    }
    return ()=>{ if (demoTimer.current) clearTimeout(demoTimer.current); };
  }, [demoPlaying, demoIdx]);

  const playDemo = () => {
    if (demoPlaying) { setDemoPlaying(false); setDemoIdx(0); return; }
    setDemoIdx(0); setDemoPlaying(true);
  };

  const onHighlight = () => {
    setHighlighted(true);
    setTimeout(()=>setModal("annotation"), 350);
  };

  const onAction = (kind, item) => {
    if (kind==="packet") setModal("packet");
    else if (kind==="review") setReviewOpen(true);
    else if (kind==="move") setModal("moveTo");
    else if (kind==="queue") setToast("Queued for follow-up");
  };

  const masked = t.screenShare;

  return (
    <div className="stage" data-screen-label="01 Stage">
      <div className="stage-toolbar">
        <div className="brand"><span className="brand-glyph"/>SwitchBoard</div>
        <div className="scenarios">
          {[["stripe","stripe.com docs"],["chatgpt","chatgpt.com"],["obsidian","obsidian vault"]].map(([k,l])=>(
            <button key={k} className={t.scenario===k?"on":""} onClick={()=>setTweak("scenario",k)}>{l}</button>
          ))}
        </div>
        <div className="right">
          {demoPlaying && <span className="demo-step">› {DEMO_STEPS[demoIdx]?.label}</span>}
          <button className="demo-btn" onClick={playDemo}>
            <span style={{display:"inline-flex", width:11, height:11, alignItems:"center", justifyContent:"center"}}>
              {demoPlaying ? I.pause : I.play}
            </span>
            {demoPlaying ? "Stop" : "Play demo"}
          </button>
        </div>
      </div>

      <div className="stage-body">
        {/* LEFT — fake browser */}
        <div className="bx">
          <div className="bx-chrome">
            <div className="row">
              <div className="traffic"><span/><span/><span/></div>
              <div style={{display:"flex", gap:0, alignItems:"center", color:"var(--ink-3)"}}>
                <span style={{padding:4, cursor:"pointer", display:"inline-flex", width:14, height:14}}>{I.back}</span>
                <span style={{padding:4, cursor:"pointer", display:"inline-flex", width:14, height:14, opacity:0.4}}>{I.fwd}</span>
                <span style={{padding:4, cursor:"pointer", display:"inline-flex", width:14, height:14}}>{I.refresh}</span>
              </div>
              <div className="url">
                {I.lock}
                <span>{
                  t.scenario==="stripe" ? <><b>stripe.com</b>/docs/webhooks/signatures</> :
                  t.scenario==="chatgpt" ? <><b>chatgpt.com</b>/c/8c41a2f0-prd-dispatch-wording</> :
                  <><b>obsidian://</b>vault/_BAC/workstreams/switchboard/mvp-prd</>
                }</span>
              </div>
              <div className="ext-icon" title="SwitchBoard pinned">
                <span style={{display:"grid", placeItems:"center", width:14, height:14, color:"var(--ink-2)"}}>
                  <span style={{
                    width:13, height:13, borderRadius:"50%", border:"1.4px solid currentColor", position:"relative",
                  }}>
                    <span style={{position:"absolute", inset:2, borderRadius:"50%", background:"var(--signal)"}}/>
                  </span>
                </span>
              </div>
            </div>
            <div className="tabs">
              <div className={"tab"+(t.scenario==="stripe"?" active":"")}>
                <span className="favicon" style={{background:"#635BFF"}}/>
                <span className="title">Verify webhook signatures · Stripe</span>
              </div>
              <div className={"tab"+(t.scenario==="chatgpt"?" active":"")}>
                <span className="favicon" style={{background:"#10A37F"}}/>
                <span className="title">PRD §24.10 — ChatGPT</span>
              </div>
              <div className={"tab"+(t.scenario==="obsidian"?" active":"")}>
                <span className="favicon" style={{background:"#7C3AED"}}/>
                <span className="title">mvp-prd — Obsidian</span>
              </div>
            </div>
          </div>
          <div className="bx-page">
            {t.scenario==="stripe" && <StripeDocs onHighlight={onHighlight} highlighted={highlighted}/>}
            {t.scenario==="chatgpt" && <ChatGPTPage/>}
            {t.scenario==="obsidian" && <ObsidianVault/>}
          </div>
        </div>

        {/* RIGHT — side panel */}
        <div className="sp">
          <div className="sp-chrome">
            <span className="pin">{I.pin}</span>
            <span>chrome side panel · pinned</span>
            <span style={{marginLeft:"auto", color:"var(--ink-4)"}}>412×</span>
          </div>

          <div className="sp-header">
            <div className="top">
              <div className="mark"><span className="glyph"/>SwitchBoard</div>
              <div className="actions">
                <button className="icon-btn" title="Coding session" onClick={()=>setModal("coding")}>{I.code}</button>
                <button className="icon-btn" title="First-run" onClick={()=>setModal("wizard")}>{I.zap}</button>
                <button className="icon-btn" title="Settings" onClick={()=>setView({name:"settings"})}>{I.settings}</button>
              </div>
            </div>
            <div className="sp-status">
              <span className={"pill "+(t.vault==="error"?"err":"")}>
                <span className={"dot "+(t.vault==="error"?"":"green")} style={t.vault==="error"?{background:"#B91C1C"}:undefined}/>
                vault {t.vault==="error"?"error":"connected"}
              </span>
              <span className={"pill "+(t.companion==="down"?"err":t.companion==="warn"?"warn":"")}>
                <span className={"dot "+(t.companion==="down"?"":t.companion==="warn"?"amber":"green")} style={t.companion==="down"?{background:"#B91C1C"}:undefined}/>
                companion {t.companion==="down"?"down":t.companion==="warn"?"slow":"running"}
              </span>
            </div>
          </div>

          {view.name==="workboard" &&
            <Workboard
              state={{ companion: t.companion==="down"?"down":"ok", vault: t.vault }}
              masked={masked}
              onAction={onAction}
              onExpandWS={(id)=>setView({name:"wsDetail", ws:id})}
            />
          }
          {view.name==="wsDetail" &&
            <WorkstreamDetail
              wsId={view.ws}
              masked={masked}
              onBack={()=>setView({name:"workboard"})}
              onAction={onAction}
            />
          }
          {view.name==="settings" &&
            <Settings onClose={()=>setView({name:"workboard"})}/>
          }

          <div className="sp-cmd">
            <button onClick={()=>setView({name:"workboard"})}>Workboard</button>
            <button onClick={()=>setModal("packet")}>Packet</button>
            <button className="primary" onClick={()=>setModal("dispatch")}>{I.send && <span style={{display:"inline-flex", width:11, height:11}}>{I.send}</span>}Dispatch</button>
          </div>

          {/* Inline review composer overlays the panel */}
          {reviewOpen && <ReviewComposer onClose={()=>setReviewOpen(false)} onDispatch={()=>{setReviewOpen(false); setModal("dispatch");}}/>}

          {toast && (
            <div className="toast">
              <span>{toast}</span>
              <button onClick={()=>setToast(null)}>Undo</button>
            </div>
          )}
        </div>
      </div>

      {/* Modals — overlay the whole stage */}
      {modal==="annotation" && <Annotation onClose={()=>setModal(null)}/>}
      {modal==="packet" && <PacketComposer onClose={()=>setModal(null)} onDispatch={()=>setModal("dispatch")}/>}
      {modal==="dispatch" && <DispatchConfirm screenShare={t.screenShare} onClose={()=>setModal(null)} onConfirm={()=>{setModal(null); setToast("Dispatched to Claude · paste mode");}}/>}
      {modal==="recovery" && <TabRecovery onClose={()=>setModal(null)}/>}
      {modal==="moveTo" && <MoveTo onClose={()=>setModal(null)} onMove={(n)=>{setModal(null); setToast("Moved to "+n.n);}}/>}
      {modal==="wizard" && <Wizard onClose={()=>setModal(null)}/>}
      {modal==="coding" && <CodingAttach onClose={()=>setModal(null)}/>}

      <TweaksPanel>
        <TweakSection label="Demo scenario"/>
        <TweakRadio label="Page" value={t.scenario}
          options={[{value:"stripe",label:"Stripe"},{value:"chatgpt",label:"ChatGPT"},{value:"obsidian",label:"Obsidian"}]}
          onChange={v=>setTweak("scenario",v)}/>
        <TweakSection label="System state"/>
        <TweakToggle label="Screen-share active" value={t.screenShare} onChange={v=>setTweak("screenShare",v)} desc="Mask tracked-item titles"/>
        <TweakRadio label="Companion" value={t.companion}
          options={[{value:"ok",label:"running"},{value:"warn",label:"slow"},{value:"down",label:"down"}]}
          onChange={v=>setTweak("companion",v)}/>
        <TweakRadio label="Vault" value={t.vault}
          options={[{value:"ok",label:"connected"},{value:"error",label:"error"}]}
          onChange={v=>setTweak("vault",v)}/>
        <TweakSection label="Open modals"/>
        <TweakButton onClick={()=>setModal("recovery")}>Tab recovery (Mock 3)</TweakButton>
        <TweakButton onClick={()=>setModal("moveTo")}>Move to… (Mock 4)</TweakButton>
        <TweakButton onClick={()=>setModal("packet")}>Packet composer (Mock 5)</TweakButton>
        <TweakButton onClick={()=>setModal("dispatch")}>Dispatch confirm (Mock 6)</TweakButton>
        <TweakButton onClick={()=>setReviewOpen(true)}>Review composer (Mock 7)</TweakButton>
        <TweakButton onClick={()=>setModal("wizard")}>First-run wizard (Mock 8)</TweakButton>
        <TweakButton onClick={()=>setView({name:"settings"})}>Settings (Mock 9)</TweakButton>
        <TweakButton onClick={()=>setModal("coding")}>Coding session (Mock 12)</TweakButton>
        <TweakButton onClick={()=>setModal("annotation")}>Annotation (Mock 14)</TweakButton>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Stage/>);
