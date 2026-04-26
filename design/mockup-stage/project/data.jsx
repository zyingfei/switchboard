// Icons (sleek, single-path, 1.6 stroke)
const I = {
  search:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2 2 2 0 1 1-2.8-2.8 1.7 1.7 0 0 0-1.2-2.9 2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9 2 2 0 1 1 2.8-2.8 1.7 1.7 0 0 0 2.9-1.2 2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2 2 2 0 1 1 2.8 2.8 1.7 1.7 0 0 0-1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1Z"/></svg>,
  send:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>,
  alert:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>,
  check:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m20 6-11 11L4 12"/></svg>,
  x:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M18 6 6 18M6 6l12 12"/></svg>,
  chev:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
  play:     <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20"/></svg>,
  pause:    <svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>,
  lock:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  pin:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 2v8l4 4-4 8-4-8 4-4Z"/></svg>,
  doc:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M14 3v6h6"/></svg>,
  chat:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  code:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
  pkg:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>,
  share:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
  cast:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>,
  back:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m15 18-6-6 6-6"/></svg>,
  fwd:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m9 18 6-6-6-6"/></svg>,
  refresh:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>,
  folder:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  drag:     <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>,
  reply:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>,
  plus:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14"/></svg>,
  zap:      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  external: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  globe:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  stop:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>,
  history:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>,
};

// Workstreams + items fixture
const WS = {
  switchboard: {
    name: "Switchboard / MVP PRD",
    kind: "project",
    tags: ["P0", "spec"],
    created: "2026-04-12",
    updated: "2026-04-26 09:14",
    items: [
      { id:"i1", type:"chat", prov:"claude", title:"Side-panel state machine review", ago:"3 min ago", links:4, ai:true, status:"signal" },
      { id:"i2", type:"chat", prov:"gpt", title:"PRD §24.10 dispatch safety wording", ago:"2h ago", links:2 },
      { id:"i3", type:"code", prov:"codex", title:"sb_companion · capture pipeline scaffold", ago:"yesterday", links:1, status:"amber" },
      { id:"i4", type:"pkg", prov:"web", title:"PRD packet · v3 (4.2k tok)", ago:"yesterday", links:6 },
    ],
    checklist: [
      { id:"c1", text:"Lock §24.10 paste-mode default copy", done:true },
      { id:"c2", text:"Decide companion install path (Native vs HTTP)", done:true },
      { id:"c3", text:"Spec the redaction rules registry", done:false },
      { id:"c4", text:"Wireframe dispatch confirm states", done:false },
    ],
    queued: [
      { id:"q1", target:"claude", prompt:"Review side-panel state machine for race conditions", status:"ready" },
      { id:"q2", target:"gemini", prompt:"Comp scan: similar tab-tracking products", status:"pending" },
    ],
  },
  inbox: {
    name: "Inbox",
    kind: "cluster",
    tags: [],
    items: [
      { id:"in1", type:"chat", prov:"gpt", title:"Untitled — about webhook tolerance", ago:"6 min ago", links:0, ai:true },
      { id:"in2", type:"chat", prov:"claude", title:"random side question on rate limiting", ago:"22 min ago", links:0, ai:true },
      { id:"in3", type:"web", prov:"web", title:"stripe.com/docs/webhooks/signatures", ago:"14 min ago", links:0 },
    ],
  },
  ramp: {
    name: "Switchboard / Ramp-up hypothesis",
    kind: "subcluster",
    tags: ["research"],
    items: [
      { id:"r1", type:"chat", prov:"gpt", title:"Onboarding cohort math", ago:"30 min ago", links:2 },
      { id:"r2", type:"chat", prov:"gemini", title:"Activation funnel — comp scan", ago:"6 min ago", links:1, status:"signal", ai:true },
    ],
  },
};

const QUEUED = [
  { id:"q1", target:"claude", source:"Stripe webhook flow", prompt:"Review the threat model under tightened tolerance", status:"ready" },
  { id:"q2", target:"gpt", source:"PRD §24.10", prompt:"Check that paste-mode wording is unambiguous", status:"pending" },
  { id:"q3", target:"gemini", source:"Comp scan", prompt:"Find 3 products that bridge AI tab + research notes", status:"sent" },
];

const INBOUND = [
  { id:"b1", prov:"claude", title:"Side-panel state machine review", thread:"th_8c41a2", ws:"Switchboard / MVP PRD", ago:"3 min ago", ai:true },
  { id:"b2", prov:"gemini", title:"Activation funnel — comp scan", thread:"th_2f01e9", ws:"Switchboard / Ramp-up hypothesis", ago:"6 min ago", ai:true },
];

const RECENT = [
  { id:"x1", prov:"claude", title:"Stripe webhook signature flow", ago:"14 min", ai:true },
  { id:"x2", prov:"gpt", title:"PRD §24.10 dispatch wording", ago:"2h", ai:true },
  { id:"x3", prov:"web", title:"stripe.com/docs/webhooks/signatures", ago:"14m" },
  { id:"x4", prov:"codex", title:"sb_companion · capture pipeline", ago:"1d" },
  { id:"x5", prov:"claude", title:"Threat model — replay defense", ago:"1d", ai:true },
];

const REVIEW_FIXTURE = {
  prov: "claude",
  capturedAt: "2026-04-26T09:11:42Z",
  spans: [
    { id:"s1", text:"verify the tolerance window server-side; ours is currently 5min which is too generous for production replay defense" },
    { id:"s2", text:"Use HMAC with SHA-256 and reject any timestamp outside ±2 minutes." },
  ],
};

const PROVIDER_LABEL = { gpt:"ChatGPT", claude:"Claude", gemini:"Gemini", codex:"Codex", web:"Web" };

// Type icons inline used in item rows
const typeIcon = (k) => ({
  chat: I.chat,
  search: I.search,
  code: I.code,
  pkg: I.pkg,
  web: I.globe,
}[k] || I.doc);

Object.assign(window, { I, WS, QUEUED, INBOUND, RECENT, REVIEW_FIXTURE, PROVIDER_LABEL, typeIcon });
