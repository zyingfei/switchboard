// Stage v2 — adds 13 new surfaces + refresh deltas
// Uses WorkboardV2, WorkstreamDetailV2, SettingsV2, HealthPanel, DispatchConfirmV2,
// DejaVu, AnnotationsOverlay (from surfaces-v2.jsx).

const { useState: aS2, useEffect: aE2, useRef: aR2 } = React;

const TWEAK_DEFAULTS_V2 = /*EDITMODE-BEGIN*/{
  "scenario": "stripe",
  "screenShare": false,
  "companion": "ok",
  "vault": "ok",
  "view": "workstream",
  "showCodingOffer": true,
  "showUpdate": true,
  "showDejaVu": false,
  "showAnnotations": false,
  "dejaOnClick": true,
  "theme": "auto",
  "panelWidth": 412
}/*EDITMODE-END*/;

const DEMO_STEPS_V2 = [
  { k:"idle",         label:"ready" },
  { k:"highlight",    label:"User highlights replay-defense line" },
  { k:"dejavu",       label:"Déjà-vu — 3 prior threads found" },
  { k:"jumpToThread", label:"Jump to prior thread" },
  { k:"composer",     label:"Open packet composer (with scope sugs)" },
  { k:"dispatchV2",   label:"Dispatch confirm — safety chain (collapsed)" },
  { k:"sent",         label:"Sent · queued reply expected" },
  { k:"reply",        label:"Claude replied — inbound pulse" },
  { k:"health",       label:"Open capture-health diagnostics" },
  { k:"done",         label:"demo complete" },
];

function StageV2() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS_V2);
  const [view, setView] = aS2({ name:"workboard" });
  const [headerTab, setHeaderTab] = aS2("workstream");
  const [modal, setModal] = aS2(null);
  const [reviewOpen, setReviewOpen] = aS2(false);
  const [highlighted, setHighlighted] = aS2(false);
  const [dejaPos, setDejaPos] = aS2(null); // {top,left} when shown
  const [toast, setToast] = aS2(null);
  const [showCodingOffer, setShowCodingOffer] = aS2(true);
  const [showUpdate, setShowUpdate] = aS2(true);
  const [demoIdx, setDemoIdx] = aS2(0);
  const [demoPlaying, setDemoPlaying] = aS2(false);
  const demoTimer = aR2(null);

  // Sync external tweak triggers
  aE2(()=>{ setShowCodingOffer(t.showCodingOffer); }, [t.showCodingOffer]);
  aE2(()=>{ setShowUpdate(t.showUpdate); }, [t.showUpdate]);
  aE2(()=>{
    if (t.showDejaVu) setDejaPos({ top: 230, left: 120 });
    else setDejaPos(null);
  }, [t.showDejaVu]);

  aE2(()=>{
    if (!demoPlaying) return;
    const step = DEMO_STEPS_V2[demoIdx];
    const apply = () => {
      switch(step.k) {
        case "highlight":    setTweak("scenario","stripe"); setHighlighted(true); break;
        case "dejavu":       setDejaPos({top:230,left:120}); break;
        case "jumpToThread": setDejaPos(null); setHighlighted(false); setView({name:"wsDetail", ws:"switchboard"}); setToast("Jumped to: Threat model — replay defense"); break;
        case "composer":     setToast(null); setModal("packetV2"); break;
        case "dispatchV2":   setModal("dispatchV2"); break;
        case "sent":         setModal(null); setToast("Dispatched to Claude"); break;
        case "reply":        setToast(null); setView({name:"workboard"}); break;
        case "health":       setView({name:"health"}); break;
        case "done":         setDemoPlaying(false); break;
        case "idle":
        default:
          setHighlighted(false); setDejaPos(null); setModal(null); setReviewOpen(false); setToast(null);
          setView({name:"workboard"});
      }
    };
    apply();
    if (step.k !== "done") {
      demoTimer.current = setTimeout(()=>setDemoIdx(i=>i+1), step.k==="idle"?300:2400);
    }
    return ()=>{ if (demoTimer.current) clearTimeout(demoTimer.current); };
  }, [demoPlaying, demoIdx]);

  const playDemo = () => {
    if (demoPlaying) { setDemoPlaying(false); setDemoIdx(0); return; }
    setDemoIdx(0); setDemoPlaying(true);
  };

  const onHighlight = () => {
    setHighlighted(true);
    setTimeout(()=>setDejaPos({top:230,left:120}), 240);
  };

  // Click anywhere on the page → trigger Déjà-vu near the cursor
  // (works across all 3 scenarios since stripe-only highlight doesn't cover ChatGPT/Obsidian)
  const onPageClick = (e) => {
    if (dejaPos) return; // already showing
    const host = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - host.left;
    const y = e.clientY - host.top;
    // clamp so popover stays inside
    const left = Math.max(12, Math.min(x - 40, host.width - 372));
    const top  = Math.max(12, Math.min(y + 12, host.height - 280));
    setDejaPos({top, left});
  };

  const onAction = (kind, item) => {
    if (kind==="packet") setModal("packetV2");
    else if (kind==="review") setReviewOpen(true);
    else if (kind==="move") setModal("moveTo");
    else if (kind==="queue") setToast("Queued for follow-up");
    else if (kind==="accept") setToast("Moved to suggested workstream");
  };

  const masked = t.screenShare;

  // Resolve theme: "auto" → media query; otherwise explicit.
  const [systemDark, setSystemDark] = aS2(()=>{
    if (typeof window==="undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  aE2(()=>{
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e)=>setSystemDark(e.matches);
    mq.addEventListener?.("change", fn);
    return ()=>mq.removeEventListener?.("change", fn);
  },[]);
  const resolvedTheme = t.theme==="auto" ? (systemDark ? "ink" : "paper") : (t.theme==="dark" ? "ink" : "paper");

  return (
    <div className="stage" data-screen-label="01 Stage v2" data-theme={resolvedTheme==="ink"?"ink":undefined}>
      <div className="stage-toolbar">
        <div className="brand"><span className="brand-glyph"/>SwitchBoard <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--ink-3)", marginLeft:6}}>v2 · 13 new surfaces</span></div>
        <div className="scenarios">
          {[["stripe","stripe.com docs"],["chatgpt","chatgpt.com"],["obsidian","obsidian vault"]].map(([k,l])=>(
            <button key={k} className={t.scenario===k?"on":""} onClick={()=>setTweak("scenario",k)}>{l}</button>
          ))}
        </div>
        <div className="right">
          {demoPlaying && <span className="demo-step">› {DEMO_STEPS_V2[demoIdx]?.label}</span>}
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
                  <span style={{width:13, height:13, borderRadius:"50%", border:"1.4px solid currentColor", position:"relative"}}>
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
          <div className="bx-page"
               style={{position:"relative", cursor: t.dejaOnClick && !dejaPos ? "crosshair" : "default"}}
               onClick={t.dejaOnClick ? onPageClick : undefined}>
            {t.scenario==="stripe" && <StripeDocs onHighlight={onHighlight} highlighted={highlighted}/>}
            {t.scenario==="chatgpt" && <ChatGPTPage/>}
            {t.scenario==="obsidian" && <ObsidianVault/>}

            {/* Annotation overlay (3rd new surface) */}
            {t.showAnnotations && <AnnotationsOverlay onOpen={()=>setView({name:"wsDetail", ws:"switchboard"})}/>}

            {/* Déjà-vu pop — anchored above the highlight */}
            {dejaPos && (
              <div style={{position:"absolute", top:dejaPos.top, left:dejaPos.left}}>
                <DejaVu
                  onClose={()=>setDejaPos(null)}
                  onJump={(r)=>{ setDejaPos(null); setView({name:"wsDetail", ws:"switchboard"}); setToast("Jumped to: "+r.title); }}
                />
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — side panel */}
        <div className="sp" style={{width: t.panelWidth, flexBasis: t.panelWidth, flex: "0 0 "+t.panelWidth+"px"}}>
          <div className="sp-chrome">
            <span className="pin">{I.pin}</span>
            <span>chrome side panel · pinned</span>
            <span style={{marginLeft:"auto", color:"var(--ink-4)"}}>{t.panelWidth}×</span>
          </div>

          <div className="sp-header">
            <div className="top">
              <div className="mark"><span className="glyph"/>SwitchBoard</div>
              <div className="actions">
                <button className="icon-btn" title="Capture-health" onClick={()=>setView({name:"health"})}>{I.zap}</button>
                <button className="icon-btn" title="Coding session" onClick={()=>setModal("coding")}>{I.code}</button>
                <button className="icon-btn" title="Settings" onClick={()=>setView({name:"settingsV2"})}>{I.settings}</button>
              </div>
            </div>
            {/* View tabs (refresh delta) */}
            <div className="sp-tabs" role="tablist">
              <button className={headerTab==="workstream"?"on":""} onClick={()=>setHeaderTab("workstream")} role="tab">
                Workstream <span className="ct">3</span>
              </button>
              <button className={headerTab==="all"?"on":""} onClick={()=>setHeaderTab("all")} role="tab">
                All threads <span className="ct">12</span>
              </button>
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
            <WorkboardV2
              state={{ companion: t.companion==="down"?"down":"ok", vault: t.vault }}
              masked={masked}
              onAction={onAction}
              onExpandWS={(id)=>setView({name:"wsDetail", ws:id})}
              showCodingOffer={showCodingOffer}
              showUpdate={showUpdate}
              onAttachCoding={()=>{ setShowCodingOffer(false); setToast("Codex session attached to MVP PRD"); }}
              onDismissCoding={()=>setShowCodingOffer(false)}
              onUpdate={()=>{ setShowUpdate(false); setToast("Companion updating to 0.5.1…"); }}
              onDismissUpdate={()=>setShowUpdate(false)}
            />
          }
          {view.name==="wsDetail" &&
            <WorkstreamDetailV2
              wsId={view.ws}
              masked={masked}
              onBack={()=>setView({name:"workboard"})}
              onAction={onAction}
            />
          }
          {view.name==="settingsV2" &&
            <SettingsV2
              onClose={()=>setView({name:"workboard"})}
              onOpenHealth={()=>setView({name:"health"})}
            />
          }
          {view.name==="health" &&
            <HealthPanel onClose={()=>setView({name:"workboard"})}/>
          }

          <div className="sp-cmd">
            <button onClick={()=>setView({name:"workboard"})}>Workboard</button>
            <button onClick={()=>setModal("packetV2")}>Packet</button>
            <button className="primary" onClick={()=>setModal("dispatchV2")}>
              <span style={{display:"inline-flex", width:11, height:11}}>{I.send}</span>Dispatch
            </button>
          </div>

          {reviewOpen && <ReviewComposer onClose={()=>setReviewOpen(false)} onDispatch={()=>{setReviewOpen(false); setModal("dispatchV2");}}/>}

          {toast && (
            <div className="toast">
              <span>{toast}</span>
              <button onClick={()=>setToast(null)}>Undo</button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {modal==="annotation" && <Annotation onClose={()=>setModal(null)}/>}
      {modal==="packetV2" && <PacketComposerV2 onClose={()=>setModal(null)} onDispatch={()=>setModal("dispatchV2")}/>}
      {modal==="packet" && <PacketComposer onClose={()=>setModal(null)} onDispatch={()=>setModal("dispatchV2")}/>}
      {modal==="dispatchV2" && <DispatchConfirmV2 screenShare={t.screenShare} onClose={()=>setModal(null)} onConfirm={()=>{setModal(null); setToast("Dispatched to Claude · paste mode");}}/>}
      {modal==="dispatch" && <DispatchConfirm screenShare={t.screenShare} onClose={()=>setModal(null)} onConfirm={()=>{setModal(null); setToast("Dispatched");}}/>}
      {modal==="recovery" && <TabRecovery onClose={()=>setModal(null)}/>}
      {modal==="moveTo" && <MoveTo onClose={()=>setModal(null)} onMove={(n)=>{setModal(null); setToast("Moved to "+n.n);}}/>}
      {modal==="wizard" && <Wizard onClose={()=>setModal(null)}/>}
      {modal==="coding" && <CodingAttach onClose={()=>setModal(null)}/>}

      <TweaksPanel>
        <TweakSection label="Demo scenario"/>
        <TweakRadio label="Page" value={t.scenario}
          options={[{value:"stripe",label:"Stripe"},{value:"chatgpt",label:"ChatGPT"},{value:"obsidian",label:"Obsidian"}]}
          onChange={v=>setTweak("scenario",v)}/>

        <TweakSection label="Appearance"/>
        <TweakRadio label="Theme" value={t.theme}
          options={[{value:"auto",label:"Auto"},{value:"light",label:"Light"},{value:"dark",label:"Dark"}]}
          onChange={v=>setTweak("theme",v)}/>
        <TweakSlider label="Side-panel width" value={t.panelWidth} min={320} max={600} step={4}
          onChange={v=>setTweak("panelWidth",v)} unit="px"/>

        <TweakSection label="Side panel views"/>
        <TweakButton onClick={()=>setView({name:"workboard"})}>Workboard (refresh)</TweakButton>
        <TweakButton onClick={()=>setView({name:"wsDetail", ws:"switchboard"})}>Workstream detail (linked notes + trust)</TweakButton>
        <TweakButton onClick={()=>setView({name:"settingsV2"})}>Settings v2</TweakButton>
        <TweakButton onClick={()=>setView({name:"health"})}>Capture-health diagnostics</TweakButton>

        <TweakSection label="In-page surfaces"/>
        <TweakToggle label="Click-anywhere triggers Déjà-vu" value={t.dejaOnClick} onChange={v=>setTweak("dejaOnClick",v)} desc="Demo only — anchored to cursor"/>
        <TweakToggle label="Déjà-vu pop (centered)" value={!!dejaPos} onChange={v=>setDejaPos(v?{top:230,left:120}:null)}/>
        <TweakToggle label="Annotations overlay" value={t.showAnnotations} onChange={v=>setTweak("showAnnotations",v)} desc="Restored highlights on revisit"/>

        <TweakSection label="Workboard banners"/>
        <TweakToggle label="Coding-session offer" value={showCodingOffer} onChange={v=>setShowCodingOffer(v)}/>
        <TweakToggle label="Companion update available" value={showUpdate} onChange={v=>setShowUpdate(v)}/>

        <TweakSection label="Modals — refreshed"/>
        <TweakButton onClick={()=>setModal("packetV2")}>Packet composer (scope sugs)</TweakButton>
        <TweakButton onClick={()=>setModal("dispatchV2")}>Dispatch confirm (safety-chain summary)</TweakButton>

        <TweakSection label="System state"/>
        <TweakToggle label="Screen-share active" value={t.screenShare} onChange={v=>setTweak("screenShare",v)} desc="Mask tracked-item titles"/>
        <TweakRadio label="Companion" value={t.companion}
          options={[{value:"ok",label:"running"},{value:"warn",label:"slow"},{value:"down",label:"down"}]}
          onChange={v=>setTweak("companion",v)}/>
        <TweakRadio label="Vault" value={t.vault}
          options={[{value:"ok",label:"connected"},{value:"error",label:"error"}]}
          onChange={v=>setTweak("vault",v)}/>

        <TweakSection label="Legacy modals (v1)"/>
        <TweakButton onClick={()=>setModal("recovery")}>Tab recovery</TweakButton>
        <TweakButton onClick={()=>setModal("moveTo")}>Move to…</TweakButton>
        <TweakButton onClick={()=>setReviewOpen(true)}>Review composer</TweakButton>
        <TweakButton onClick={()=>setModal("wizard")}>First-run wizard</TweakButton>
        <TweakButton onClick={()=>setModal("annotation")}>Annotation modal</TweakButton>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<StageV2/>);
