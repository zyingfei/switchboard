// Main app: composes all surfaces into a design canvas with Play Demo + Tweaks

const { useEffect, useRef, useMemo } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "paper",
  "accent": "rust",
  "density": "comfortable",
  "workstream": "auth-redesign",
  "screenSafe": false,
  "showDeja": false,
  "driftEnabled": true
}/*EDITMODE-END*/;

// ── Play Demo orchestrator ───────────────────────────────────
// Walks through: highlight → flyout → preflight → side panel pulse → vault pulse
const DEMO_STEPS = [
  { id:"idle",     label:"Idle",                       focus:null },
  { id:"highlight",label:"1 · Highlight on page",      focus:"hook/flyout" },
  { id:"preflight",label:"2 · Preflight redaction",    focus:"hook/preflight" },
  { id:"dispatch", label:"3 · Dispatched · side panel", focus:"anchor/default" },
  { id:"vault",    label:"4 · Vault projection updates", focus:"arch/dash" },
  { id:"recall",   label:"5 · Déjà-vu surfaces",       focus:"anchor/deja" },
];

function useDemo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const tRef = useRef(null);

  useEffect(() => {
    if (!playing) return;
    const advance = () => {
      setStep(s => {
        if (s >= DEMO_STEPS.length - 1) { setPlaying(false); return 0; }
        return s + 1;
      });
    };
    tRef.current = setTimeout(advance, step === 0 ? 500 : 2400);
    return () => clearTimeout(tRef.current);
  }, [playing, step]);

  const play = () => { setStep(0); setPlaying(true); };
  const stop = () => { setPlaying(false); setStep(0); };
  const next = () => setStep(s => Math.min(DEMO_STEPS.length-1, s+1));
  const prev = () => setStep(s => Math.max(0, s-1));

  return { step, stepData: DEMO_STEPS[step], playing, play, stop, next, prev, total: DEMO_STEPS.length };
}

function DemoBar({ demo }) {
  return (
    <div style={{
      position:"fixed", top:14, left:"50%", transform:"translateX(-50%)",
      zIndex:50,
      background:"var(--paper-light)", border:"1px solid var(--ink)", borderRadius:99,
      boxShadow:"0 6px 18px -8px rgba(27,25,22,.3), 0 1px 0 rgba(255,255,255,.5) inset",
      padding:"6px 8px 6px 14px", display:"flex", alignItems:"center", gap:10,
      fontFamily:"var(--mono)", fontSize:11, color:"var(--ink)",
    }}>
      <span className="sb-glyph" style={{width:18,height:18,borderWidth:1.2}}/>
      <span style={{fontFamily:"var(--display)", fontSize:13, fontWeight:500, letterSpacing:"-.005em"}}>SwitchBoard</span>
      <span style={{color:"var(--ink-3)"}}>·</span>
      <span style={{color:"var(--ink-2)", minWidth:170}}>{demo.stepData.label}</span>
      <div style={{display:"flex", gap:2, alignItems:"center"}}>
        {DEMO_STEPS.map((_,i)=>(
          <span key={i} style={{
            width:i===demo.step?14:5, height:5, borderRadius:99,
            background:i<=demo.step?"var(--signal)":"var(--rule)",
            transition:"all 240ms",
          }}/>
        ))}
      </div>
      <button onClick={demo.prev} className="sb-icon-btn" disabled={demo.step===0} style={{opacity:demo.step===0?.3:1}}>‹</button>
      {demo.playing ? (
        <button onClick={demo.stop} className="sb-btn" style={{padding:"4px 12px", fontSize:11, background:"var(--ink)", color:"var(--paper-light)", borderColor:"var(--ink)"}}>{Icon.pause} Stop</button>
      ) : (
        <button onClick={demo.play} className="sb-btn primary" style={{padding:"4px 12px", fontSize:11, display:"inline-flex", alignItems:"center", gap:5}}>{Icon.play} Play demo</button>
      )}
      <button onClick={demo.next} className="sb-icon-btn" disabled={demo.step===demo.total-1} style={{opacity:demo.step===demo.total-1?.3:1}}>›</button>
    </div>
  );
}

// ── Tweaks ────────────────────────────────────────────────────
function TweaksUI({ t, setTweak }) {
  return (
    <TweaksPanel>
      <TweakSection label="Theme" />
      <TweakRadio label="Mode" value={t.theme} options={["paper","ink"]}
        onChange={v=>setTweak("theme",v)} />
      <TweakRadio label="Accent" value={t.accent} options={["rust","ink","violet","forest"]}
        onChange={v=>setTweak("accent",v)} />
      <TweakRadio label="Density" value={t.density} options={["comfortable","compact"]}
        onChange={v=>setTweak("density",v)} />

      <TweakSection label="Demo data" />
      <TweakSelect label="Workstream" value={t.workstream}
        options={["auth-redesign","ramp-up-hypothesis"]}
        onChange={v=>setTweak("workstream",v)} />

      <TweakSection label="Modes" />
      <TweakToggle label="Screen-share-safe" value={t.screenSafe}
        onChange={v=>setTweak("screenSafe",v)} />
      <TweakToggle label="Déjà-vu recall" value={t.showDeja}
        onChange={v=>setTweak("showDeja",v)} />
      <TweakToggle label="Drift detection" value={t.driftEnabled}
        onChange={v=>setTweak("driftEnabled",v)} />
    </TweaksPanel>
  );
}

// ── Page note (shows under highlight selection) ──────────────
function PageHighlight({ active }) {
  return (
    <div className="sb-frame" style={{width:520, height:380}}>
      <div className="sb-titlebar">
        <div className="dots"><span/><span/><span/></div>
        <div className="sb-url">stripe.com/docs/<b>webhooks/signatures</b></div>
      </div>
      <div style={{padding:"24px 32px", flex:1, background:"var(--paper-light)", overflow:"hidden", position:"relative"}}>
        <div style={{fontFamily:"var(--display)", fontSize:18, fontWeight:600, marginBottom:10}}>Verifying webhook signatures</div>
        <p style={{fontFamily:"var(--body)", fontSize:13.5, color:"var(--ink-2)", lineHeight:1.6, margin:"0 0 10px"}}>
          Stripe signs each webhook event sent to your endpoint. We include a <code style={{fontFamily:"var(--mono)", fontSize:12, background:"var(--paper-deep)", padding:"1px 4px", borderRadius:3}}>Stripe-Signature</code> header containing a timestamp and one or more signatures.
        </p>
        <p style={{fontFamily:"var(--body)", fontSize:13.5, color:"var(--ink-2)", lineHeight:1.6, margin:"0 0 10px"}}>
          You should{" "}
          <span style={{
            background: active ? "var(--signal-tint)" : "transparent",
            transition:"background 200ms",
            padding:"2px 1px",
            position:"relative",
          }}>verify the tolerance window server-side; ours is currently 5 minutes which is too generous for production replay defense</span>
          . Adjust based on your latency tolerance and clock-skew assumptions.
        </p>
        {active && (
          <div style={{position:"absolute", left:120, top:160, animation:"sb-deja-in 220ms"}}>
            <div style={{
              width:10,height:10,borderRadius:"50%",background:"var(--signal)",
              boxShadow:"0 0 0 4px rgba(194,65,12,.2)",
              position:"absolute", left:-12, top:-4,
              animation:"sb-pulse 1.4s infinite",
            }}/>
          </div>
        )}
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const demo = useDemo();

  // Apply theme/accent/density to root
  useEffect(()=>{
    const r = document.documentElement;
    r.dataset.theme = t.theme;
    r.dataset.accent = t.accent;
    r.dataset.density = t.density;
  }, [t.theme, t.accent, t.density]);

  // Demo step → derived flags
  const demoFlags = useMemo(()=>{
    const id = demo.stepData.id;
    return {
      pageHighlight: ["highlight","preflight","dispatch","vault"].includes(id),
      flyoutOpen:    id === "highlight",
      preflightOpen: id === "preflight",
      sidePanelPulse: id === "dispatch",
      vaultPulse:    id === "vault" || id === "dispatch",
      dejaForce:     id === "recall",
    };
  }, [demo.step]);

  const showDeja = t.showDeja || demoFlags.dejaForce;

  return (
    <>
      <DemoBar demo={demo} />
      <TweaksUI t={t} setTweak={setTweak} />

      <DesignCanvas>

        <DCSection id="anchor" title='01 / Anchor' subtitle='"Where was I?" — the side panel.'>
          <DCArtboard id="default" label="A · Default" width={380} height={720}>
            <SidePanel
              workstream={t.workstream}
              screenSafe={t.screenSafe}
            />
          </DCArtboard>
          <DCArtboard id="deja" label="B · Déjà-vu recall" width={380} height={720}>
            <SidePanel
              workstream={t.workstream}
              showDeja={showDeja || true}
              screenSafe={t.screenSafe}
            />
          </DCArtboard>
          <DCArtboard id="screensafe" label="C · Screen-share-safe" width={380} height={720}>
            <SidePanel
              workstream={t.workstream}
              screenSafe={true}
            />
          </DCArtboard>
        </DCSection>

        <DCSection id="hook" title='02 / Hook' subtitle="Capture & dispatch — entry points.">
          <DCArtboard id="page" label="Source page" width={520} height={380}>
            <PageHighlight active={demoFlags.pageHighlight} />
          </DCArtboard>
          <DCArtboard id="flyout" label="On-page flyout" width={320} height={300}>
            <Flyout demoActive={demoFlags.flyoutOpen} />
          </DCArtboard>
          <DCArtboard id="preflight" label="Dispatch preflight" width={480} height={420}>
            <Preflight />
          </DCArtboard>
        </DCSection>

        <DCSection id="arch" title='03 / Architecture' subtitle="Vault as canonical projection.">
          <DCArtboard id="dash" label="Obsidian Bases dashboard" width={920} height={500}>
            <VaultDash pulse={demoFlags.vaultPulse} screenSafe={t.screenSafe} workstream={t.workstream}/>
          </DCArtboard>
          <DCArtboard id="yaml" label="YAML mirror" width={540} height={540}>
            <YamlMirror />
          </DCArtboard>
          <DCArtboard id="graph" label="Workstream graph (.canvas)" width={680} height={480}>
            <GraphCanvas />
          </DCArtboard>
        </DCSection>

        <DCSection id="moat" title='04 / Moat' subtitle="MCP, both ways.">
          <DCArtboard id="mcp" label="MCP server settings" width={480} height={720}>
            <McpSettings />
          </DCArtboard>
          <DCArtboard id="pack" label="Context Pack export" width={480} height={520}>
            <ContextPack />
          </DCArtboard>
          <DCArtboard id="fork" label="Fork & converge" width={780} height={420}>
            <ForkConverge />
          </DCArtboard>
        </DCSection>

        <DCSection id="onboard" title='05 / Onboarding' subtitle="First run · step 2 of 4.">
          <DCArtboard id="wiz" label="Connect Obsidian" width={520} height={520}>
            <Wizard step={2}/>
          </DCArtboard>
          <DCArtboard id="inbox" label="Inbox" width={420} height={560}>
            <Inbox />
          </DCArtboard>
        </DCSection>

        <DCSection id="safety" title='06 / Safety' subtitle="Drift, screen-share, and the long tail.">
          <DCArtboard id="drift" label="Drift delta-paste" width={460} height={420}>
            <DriftDelta />
          </DCArtboard>
        </DCSection>

      </DesignCanvas>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
