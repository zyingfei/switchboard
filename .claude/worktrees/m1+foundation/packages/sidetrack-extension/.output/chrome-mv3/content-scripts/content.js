var content=(function(){function e(e){return e}var t=32,n=e=>{let t=(e.ownerDocument??document).createTreeWalker(e,NodeFilter.SHOW_TEXT),n=[],r=t.nextNode();for(;r!==null;)n.push(r),r=t.nextNode();return n},r=e=>(e.commonAncestorContainer.ownerDocument??document).body,i=(e,t,r)=>{let i=0;for(let a of n(e)){if(a===t)return i+r;i+=a.data.length}return i},a=e=>{if(e===null)return`body`;let t=[],n=e;for(;;){let e=n.tagName.toLowerCase(),r=n.parentElement;if(r===null){t.unshift(e);break}let i=Array.from(r.children).filter(e=>e.tagName===n.tagName),a=i.length<=1?``:`:nth-of-type(${String(i.indexOf(n)+1)})`;t.unshift(`${e}${a}`),n=r}return t.join(` > `)},o=(e,t,r)=>{let i=(e.ownerDocument??document).createRange(),a=0,o=!1;for(let s of n(e)){let e=a+s.data.length;if(!o&&t>=a&&t<=e&&(i.setStart(s,t-a),o=!0),o&&r>=a&&r<=e)return i.setEnd(s,r-a),i;a=e}return null},s=e=>{let n=r(e),o=n.textContent,s=i(n,e.startContainer,e.startOffset),c=i(n,e.endContainer,e.endOffset);return{textQuote:{exact:e.toString(),prefix:o.slice(Math.max(0,s-t),s),suffix:o.slice(c,Math.min(o.length,c+t))},textPosition:{start:s,end:c},cssSelector:e.startContainer instanceof Element?a(e.startContainer):a(e.startContainer.parentElement)}},c=(e,n)=>{try{let r=e.textContent,i=n.textQuote.exact;if(i.length>0){let a=0;for(;a<=r.length;){let s=r.indexOf(i,a);if(s<0)break;let c=r.slice(Math.max(0,s-t),s),l=r.slice(s+i.length,s+i.length+t),u=n.textQuote.prefix.length===0||c.endsWith(n.textQuote.prefix),d=n.textQuote.suffix.length===0||l.startsWith(n.textQuote.suffix);if(u&&d)return o(e,s,s+i.length);a=s+1}}let a=o(e,n.textPosition.start,n.textPosition.end);if(a!==null)return a;let s=e.querySelector(n.cssSelector);if(s!==null){let e=o(s,0,s.textContent.length);if(e!==null)return e}return null}catch{return null}},l=`sidetrack.settings`,u=e=>typeof e==`object`&&!!e,d=e=>{if(!u(e))return;let t=e;return typeof t.detail==`string`?t.detail:typeof t.title==`string`?t.title:void 0},f=async()=>{let e=(await chrome.storage.local.get({[l]:void 0}))[l];if(!u(e)||!u(e.companion))return;let t=e.companion;if(!(typeof t.port!=`number`||typeof t.bridgeKey!=`string`)&&t.bridgeKey.trim().length!==0)return{port:t.port,bridgeKey:t.bridgeKey}},p=class{baseUrl;constructor(e){this.settings=e,this.baseUrl=`http://127.0.0.1:${String(e.port)}/v1`}async createAnnotation(e){let t=await this.request(`/annotations`,{method:`POST`,headers:{"idempotency-key":`annotation-${crypto.randomUUID()}`},body:JSON.stringify(e)});if(!u(t)||!u(t.data))throw Error(`Companion annotation response missing data.`);return t.data}async listAnnotationsForUrl(e){let t=await this.request(`/annotations?url=${encodeURIComponent(e)}`,{method:`GET`});if(!u(t)||!Array.isArray(t.data))throw Error(`Companion annotation list response missing data array.`);return t.data}async request(e,t){let n=new Headers(t.headers);n.set(`content-type`,`application/json`),n.set(`x-bac-bridge-key`,this.settings.bridgeKey);let r=await fetch(`${this.baseUrl}${e}`,{...t,headers:n}),i=await r.json();if(!r.ok)throw Error(d(i)??`Companion HTTP ${String(r.status)}`);return i}},ee=async()=>{let e=await f();return e===void 0?void 0:new p(e)},m=e=>e.nodeType===1,h=e=>e.nodeType===3,g=(e,t)=>t.length>0?`${e}${t}${e}`:``,_=e=>{let t=e.textContent;return typeof t==`string`?t:``},v=(e,t)=>{let n=e.getAttribute(t);return typeof n==`string`?n:``},y=e=>{if(h(e))return _(e).replace(/\s+/g,` `);if(!m(e))return``;let t=e.tagName.toLowerCase(),n=Array.from(e.childNodes).map(y).join(``);if(t===`br`)return`
`;if(t===`strong`||t===`b`)return g(`**`,n.trim());if(t===`em`||t===`i`)return g(`*`,n.trim());if(t===`code`)return g("`",n);if(t===`s`||t===`del`)return g(`~~`,n);if(t===`a`){let t=v(e,`href`);return t.length>0?`[${n.trim()}](${t})`:n}return t===`img`?`![${v(e,`alt`)}](${v(e,`src`)})`:n},b=(e,t)=>{if(h(e)){let t=_(e).replace(/\s+/g,` `);return t.trim().length>0?t:``}if(!m(e))return``;let n=e.tagName.toLowerCase();if(/^h[1-6]$/.test(n)){let t=Number(n.slice(1)),r=y(e).trim();return`${`#`.repeat(t)} ${r}\n\n`}if(n===`p`){let t=y(e).trim();return t.length>0?`${t}\n\n`:``}if(n===`pre`){let t=e.querySelector(`code`)??e,n=m(t)?v(t,`class`):``,r=/language-([\w-]+)/.exec(n);return`\`\`\`${r!==null&&typeof r[1]==`string`?r[1]:``}\n${_(t).replace(/\n$/,``)}\n\`\`\`\n\n`}if(n===`blockquote`)return`${Array.from(e.childNodes).map(e=>b(e,t)).join(``).trim().split(`
`).map(e=>`> ${e}`).join(`
`)}\n\n`;if(n===`hr`)return`---

`;if(n===`ul`||n===`ol`){let r=n===`ol`,i=v(e,`start`),a=i.length>0?Number(i):1;return`${Array.from(e.children).filter(e=>e.tagName.toLowerCase()===`li`).map((e,n)=>{let i=r?`${String(a+n)}.`:`-`,o=Array.from(e.childNodes).map(e=>m(e)&&(e.tagName.toLowerCase()===`ul`||e.tagName.toLowerCase()===`ol`)?`\n${b(e,t+1).trimEnd()}`:y(e)).join(``).trim(),s=`  `.repeat(t);return`${s}${i} ${o.replace(/\n/g,`\n${s}  `)}`}).join(`
`)}\n\n`}if(n===`table`){let t=Array.from(e.querySelectorAll(`tr`));if(t.length===0)return``;let n=e=>Array.from(e.children).map(e=>y(e).trim().replace(/\|/g,`\\|`)),r=n(t[0]),i=r.map(()=>`---`),a=t.slice(1).map(e=>`| ${n(e).join(` | `)} |`);return`| ${r.join(` | `)} |\n| ${i.join(` | `)} |\n${a.join(`
`)}\n\n`}return Array.from(e.childNodes).map(e=>b(e,t)).join(``)},x=e=>e===null?``:b(e,0).replace(/\n{3,}/g,`

`).trim(),S=e=>{if(e===null)return``;let t=e.textContent;return typeof t==`string`?t.trim():``},C=(e,t)=>{if(e===null)return``;let n=e.getAttribute(t);return typeof n==`string`?n:``},te=e=>{let t=e.trim();if(t.length===0)return e;let n=t.replace(/^gpt-(\d)-(\d)\b/i,`GPT§$1.$2`).replace(/^gpt-(\d+)([a-z]+)?\b/i,(e,t,n)=>`GPT§${String(t)}${typeof n==`string`?n:``}`);return n=n.split(`-`).map((e,t)=>t===0?e:e.charAt(0).toUpperCase()+e.slice(1)).join(` `),n.replace(RegExp(`§`,`g`),`-`)},ne=(e,t)=>{let n=e.getAttribute(`data-message-model-slug`);if(typeof n==`string`&&n.length>0)return te(n);let r=S(t.querySelector(`[aria-label="Switch model"]`)??t.querySelector(`button[data-testid="model-switcher-dropdown-button"]`));return r.length>0?r:void 0},re=e=>e.querySelector(`[aria-label*="Deep research"]`)!==null,ie=e=>{let t=Array.from(e.querySelectorAll(`[data-testid="webpage-citation-pill"]`));if(t.length===0)return[];let n=new Set,r=[];for(let e of t){let t=S(e),i=C(e.querySelector(`a`)??e.closest(`a`),`href`),a=i.length>0?i:t;a.length===0||n.has(a)||(n.add(a),r.push(i.length>0?{source:t,url:i}:{source:t}))}return r},ae=e=>Array.from(e.querySelectorAll(`img`)).filter(e=>{let t=C(e,`src`);return t.length>0&&!/avatars|favicon|sprite/.test(t)}).map(e=>{let t=C(e,`src`),n=C(e,`alt`);return{kind:`image`,...t.length>0?{url:t}:{},...n.length>0?{alt:n}:{}}}),oe=e=>{let t=e.turnNode.querySelector(`.markdown.prose, .prose, .markdown`),n=t===null?void 0:x(t),r=ne(e.turnNode,e.doc),i=ae(e.turnNode),a=e.turnNode.querySelectorAll(`[data-testid="webpage-citation-pill"]`).length,o=ie(e.turnNode),s=re(e.doc)||a>=3,c=e.role===`assistant`&&s?{mode:`deep-research`,...o.length>0?{citations:o}:{}}:void 0;return{...r===void 0?{}:{modelName:r},...n===void 0||n.length===0?{}:{markdown:n},...i.length>0?{attachments:i}:{},...c===void 0?{}:{researchReport:c}}},se=e=>{let t=e.querySelector(`[data-testid="model-selector-dropdown"]`);if(t===null)return;let n=C(t,`aria-label`),r=/Model:\s*(.+)/i.exec(n)?.[1];if(typeof r==`string`&&r.length>0)return r.trim();let i=S(t);return i.length>0?i:void 0},ce=e=>{let t=[];for(let n of Array.from(e.querySelectorAll(`img`))){let e=C(n,`src`);if(e.length>0&&!/avatars|favicon/.test(e)){let r=C(n,`alt`);t.push({kind:`image`,url:e,...r.length>0?{alt:r}:{}})}}for(let n of Array.from(e.querySelectorAll(`[data-testid*="artifact"], [class*="artifact"]`))){let e=S(n).slice(0,80);t.push({kind:`artifact`,...e.length>0?{alt:e}:{}})}return t},le=e=>{let t=e.turnNode.querySelector(`.font-claude-response, .prose, [class*="markdown"]`),n=t===null?void 0:x(t),r=se(e.doc),i=ce(e.turnNode);return{...r===void 0?{}:{modelName:r},...n===void 0||n.length===0?{}:{markdown:n},...i.length>0?{attachments:i}:{}}},ue=e=>{let t=S(e.querySelector(`[data-test-id="bard-mode-menu-button"]`)??e.querySelector(`.side-nav-menu-button.with-pill-ui`)??e.querySelector(`[aria-label*="Gemini"][aria-label*="model"]`));if(t.length>0&&t.length<60)return t},de=e=>{let t=/^\s{0,4}Show thinking[\s\S]+?Gemini said\s{0,4}/i.exec(e);if(t===null)return{visible:e};let n=e.slice(0,t[0].length).replace(/^\s*Show thinking\s*/i,``).replace(/\s*Gemini said\s*$/i,``).trim(),r=e.slice(t[0].length).trim();return n.length>=30&&/[\p{L}\p{N}]/u.test(n)?{visible:r,thinking:n}:{visible:r}},fe=e=>{let t=e.turnNode.querySelector(`.response-content, .model-response-text, .markdown`);if(t===null)return{};let n=x(t),r,i=e.turnNode.querySelector(`[data-test-id="thoughts-content"], .thoughts-section, [class*="thinking"]`);if(i!==null){let e=S(i);e.length>0&&(r=e)}else{let e=de(n);n=e.visible,e.thinking!==void 0&&e.thinking.length>0&&(r=e.thinking)}let a=ue(e.doc),o=/Research|Deep dive|Sources/i.test(n.slice(0,200))&&n.length>2e3,s=e.role===`assistant`&&o?{mode:`gemini-deep-research`}:void 0;return{...a===void 0?{}:{modelName:a},...n.length===0?{}:{markdown:n},...r===void 0?{}:{reasoning:r},...s===void 0?{}:{researchReport:s}}},pe=e=>e.provider===`chatgpt`?oe(e):e.provider===`claude`?le(e):e.provider===`gemini`?fe(e):{},me=/[ \t\r\f\v]+/g,w=e=>e.replace(/\u00a0/g,` `).split(`
`).map(e=>e.replace(/[ \t]+/g,` `).trim()).join(`
`).replace(/\n{3,}/g,`

`).trim(),T=e=>e.replace(/\u00a0/g,` `).replace(me,` `).replace(/ *\n */g,`
`).replace(/\n{3,}/g,`

`).trim(),E=e=>e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement,D=e=>{if(e.closest(`[aria-hidden="true"], [hidden]`)||e instanceof HTMLInputElement&&e.type===`hidden`)return!1;let t=e.ownerDocument.defaultView;if(!t)return!0;let n=e;for(;n;){let e=t.getComputedStyle(n);if(e.display===`none`||e.visibility===`hidden`)return!1;n=n.parentElement}return!0},O=e=>{if(!D(e))return``;let t=e.ownerDocument,n=t.defaultView?.NodeFilter,r=t.createTreeWalker(e,n?.SHOW_TEXT??4,{acceptNode(e){let t=e.parentElement;return!t||!D(t)||E(t)?n?.FILTER_REJECT??2:w(e.textContent??``)?n?.FILTER_ACCEPT??1:n?.FILTER_REJECT??2}}),i=[],a=r.nextNode();for(;a;){let e=w(a.textContent??``);e&&i.push(e),a=r.nextNode()}return w(i.join(`
`))},he=e=>{let t=e.filter(D),n=new Set(t);return t.filter(e=>{let t=e.parentElement;for(;t;){if(n.has(t))return!1;t=t.parentElement}return!0})},k=(e,t,n={})=>{let r=Array.from(e.querySelectorAll(t)).filter(D);return n.filterNestedMatches?he(r):r},ge=e=>[...e].sort((e,t)=>{if(e.element===t.element)return 0;let n=e.element.compareDocumentPosition(t.element);return n&Node.DOCUMENT_POSITION_FOLLOWING?-1:n&Node.DOCUMENT_POSITION_PRECEDING?1:0}),_e=new Set([`chatgpt`,`claude`,`gemini`,`codex`]),A=e=>{let t=e.searchParams.get(`provider`);return t!==null&&_e.has(t)?t:null},j=e=>{let t;try{t=new URL(e)}catch{return`unknown`}let n=A(t);if(n!==null)return n;let r=t.hostname.toLowerCase();return r===`chatgpt.com`||r===`chat.openai.com`?r===`chatgpt.com`&&t.pathname.startsWith(`/codex/`)?`codex`:`chatgpt`:r===`claude.ai`?`claude`:r===`gemini.google.com`?`gemini`:`unknown`},M=(e,t)=>{if(e===`unknown`)return!1;let n;try{n=new URL(t)}catch{return!1}if((n.hostname===`127.0.0.1`||n.hostname===`localhost`)&&A(n)===e)return!0;let r=n.pathname;switch(e){case`chatgpt`:return/\/(?:c|g\/[^/]+\/c)\/[^/?#]+/u.test(r);case`codex`:return/\/codex\/[^/?#]+/u.test(r);case`claude`:return/\/chat\/[^/?#]+/u.test(r);case`gemini`:return/\/app\/[^/?#]+/u.test(r)}},N={chatgpt:{provider:`chatgpt`,version:`2026-04-25-chatgpt-v3`,mergeAdjacentSameRoleTurns:!0,directSources:[{selector:`[data-capture-turn]`,sourceSelector:`[data-capture-turn]`,role:`infer`,roleAttributes:[`data-role`,`data-capture-role`],filterNestedMatches:!0},{selector:`main [data-message-author-role], article[data-message-author-role]`,sourceSelector:`main [data-message-author-role]`,role:`infer`,roleAttributes:[`data-message-author-role`],filterNestedMatches:!0},{selector:`main article, main [data-testid*="conversation-turn"], main [data-testid*="message"]`,sourceSelector:`chatgpt fallback message selectors`,role:`infer`,roleAttributes:[`data-testid`,`aria-label`,`data-role`],alternatingRoles:[`user`,`assistant`],filterNestedMatches:!0}],headingSources:[{selector:`h1, h2, h3, h4, h5, h6, [role="heading"]`,sourceSelector:`chatgpt heading fallback`,rolePatterns:[{pattern:`^you said\\b`,role:`user`},{pattern:`^chatgpt said\\b`,role:`assistant`}],maxAncestorChars:12e3}]},claude:{provider:`claude`,version:`2026-04-25-claude-v2`,directSources:[{selector:`[data-capture-turn]`,sourceSelector:`[data-capture-turn]`,role:`infer`,roleAttributes:[`data-role`,`data-capture-role`],filterNestedMatches:!0},{selector:[`[data-testid*="user-message"]`,`[data-testid*="assistant-message"]`,`[data-testid*="chat-message"]`,`[data-claude-message-role]`,`[data-message-role]`,`.font-claude-message`].join(`, `),sourceSelector:`claude message selectors`,role:`infer`,roleAttributes:[`data-testid`,`data-claude-message-role`,`data-message-role`,`aria-label`],alternatingRoles:[`user`,`assistant`],filterNestedMatches:!0}],headingSources:[{selector:`h1, h2, h3, h4, h5, h6, [role="heading"]`,sourceSelector:`claude heading fallback`,rolePatterns:[{pattern:`^you said\\b`,role:`user`},{pattern:`^claude responded\\b`,role:`assistant`}],maxAncestorChars:14e3}]},gemini:{provider:`gemini`,version:`2026-04-25-gemini-v2`,directSources:[{selector:`[data-capture-turn]`,sourceSelector:`[data-capture-turn]`,role:`infer`,roleAttributes:[`data-role`,`data-capture-role`],filterNestedMatches:!0},{selector:[`user-query`,`model-response`,`[data-testid*="user-query"]`,`[data-testid*="model-response"]`,`[data-response-index]`,`[data-role="user"]`,`[data-role="assistant"]`].join(`, `),sourceSelector:`gemini message selectors`,role:`infer`,roleAttributes:[`data-testid`,`data-role`,`aria-label`],tagRoles:{"user-query":`user`,"model-response":`assistant`},alternatingRoles:[`user`,`assistant`],filterNestedMatches:!0}],headingSources:[{selector:`h1, h2, h3, h4, h5, h6, [role="heading"]`,sourceSelector:`gemini heading fallback`,rolePatterns:[{pattern:`^you said\\b`,role:`user`},{pattern:`^gemini said\\b`,role:`assistant`}],maxAncestorChars:12e3}],editableSources:[{selector:`[contenteditable="true"], [contenteditable="plaintext-only"]`,sourceSelector:`gemini editable panel`,role:`assistant`,minTextLength:200,excludePattern:`ask gemini|let'?s write or build together`}]},codex:{provider:`codex`,version:`2026-05-03-codex-web-v1`,mergeAdjacentSameRoleTurns:!0,directSources:[{selector:`main [data-testid*="codex-turn"], main [data-message-author-role], article[data-message-author-role]`,sourceSelector:`codex role-attributed turn selectors`,role:`infer`,roleAttributes:[`data-message-author-role`,`data-role`,`aria-label`,`data-testid`],filterNestedMatches:!0},{selector:`main [data-testid*="codex"], main [class*="codex" i], main [class*="message" i]`,sourceSelector:`codex task/message fallback selectors`,role:`infer`,roleAttributes:[`data-testid`,`aria-label`,`data-role`],alternatingRoles:[`user`,`assistant`],filterNestedMatches:!0}],headingSources:[{selector:`h1, h2, h3, h4, [role="heading"]`,sourceSelector:`codex heading fallback`,rolePatterns:[{pattern:`^you\\b`,role:`user`},{pattern:`^(?:codex|assistant)\\b`,role:`assistant`}],maxAncestorChars:12e3}]},unknown:{provider:`unknown`,version:`2026-04-25-unknown-v1`,directSources:[{selector:`[data-capture-turn]`,sourceSelector:`[data-capture-turn]`,role:`infer`,roleAttributes:[`data-role`,`data-capture-role`],filterNestedMatches:!0}]}},ve=/\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,ye=/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,be=/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[^/\s]+\.(?:local|internal|corp))\S*/i,P=(e,t,n)=>{e.some(e=>e.code===t)||e.push({code:t,message:n,severity:`warning`})},xe=(e,t)=>{let n=[],r=`${t}\n${e}`;return ve.test(r)&&P(n,`possible_api_key`,`Visible text may contain an API key or access token.`),ye.test(r)&&P(n,`email`,`Visible text may contain an email address.`),be.test(r)&&P(n,`internal_url`,`Visible text may contain an internal or private URL.`),e.length>3e4&&n.push({code:`long_capture`,message:`Visible capture is long; review before using it as downstream context.`,severity:`info`}),n},F=new Set(`address.article.aside.blockquote.details.div.dl.fieldset.figcaption.figure.footer.form.h1.h2.h3.h4.h5.h6.header.hr.li.main.nav.ol.p.pre.section.summary.table.tbody.thead.tfoot.tr.td.th.ul`.split(`.`)),Se=e=>e.replace(/\|/g,`\\|`).replace(/\n/g,`<br>`),Ce=e=>e.map(e=>e.trim()).filter(Boolean).join(`

`).replace(/\n{3,}/g,`

`).trim(),we=e=>{let t=[e.getAttribute(`data-language`),e.closest(`[data-language]`)?.getAttribute(`data-language`),e.getAttribute(`class`),e.querySelector(`[data-language]`)?.getAttribute(`data-language`)].filter(e=>!!e);for(let e of t){let t=/(?:language-|lang(?:uage)?=)?([a-z0-9_+-]{2,20})/i.exec(e);if(t)return t[1].toLowerCase()}return``},I=e=>T(Array.from(e.childNodes).map(e=>L(e)).join(``)),L=e=>{if(e.nodeType===Node.TEXT_NODE)return e.textContent??``;if(!(e instanceof Element)||!D(e)||E(e))return``;let t=e.tagName.toLowerCase();if(t===`br`)return`
`;if(t===`code`&&e.closest(`pre`))return O(e);let n=I(e);if(!n)return t===`img`?T(e.getAttribute(`alt`)??``):``;if(t===`a`){let t=e.getAttribute(`href`);return t&&/^https?:\/\//i.test(t)?`[${n}](${t})`:n}return t===`strong`||t===`b`?`**${n}**`:t===`em`||t===`i`?`*${n}*`:t===`s`||t===`del`?`~~${n}~~`:t===`code`?`\`${n}\``:n},R=(e,t=0)=>{let n=Array.from(e.children).filter(e=>e.tagName.toLowerCase()===`li`),r=e.tagName.toLowerCase()===`ol`;return n.map((e,n)=>{let i=r?`${String(n+1)}. `:`- `,a=`  `.repeat(t),o=[],s=[];Array.from(e.childNodes).forEach(e=>{if(e instanceof Element&&F.has(e.tagName.toLowerCase())&&e.tagName.toLowerCase()!==`code`){let n=e.tagName.toLowerCase()===`ul`||e.tagName.toLowerCase()===`ol`?R(e,t+1):B(e);n&&s.push(n);return}let n=L(e);n&&o.push(n)});let c=[`${a}${i}${T(o.join(``))}`.trimEnd()];return s.forEach(e=>{let t=`${a}  `;c.push(e.split(`
`).map(e=>e?`${t}${e}`:t).join(`
`))}),c.join(`
`)}).filter(Boolean).join(`
`)},Te=e=>{let t=(e instanceof HTMLTableElement?Array.from(e.rows):Array.from(e.querySelectorAll(`tr`)).filter(e=>e instanceof HTMLTableRowElement)).map(e=>Array.from(e.cells).map(e=>Se(I(e)||O(e)))).filter(e=>e.some(Boolean));if(t.length===0)return``;let n=t[0],r=t.slice(1),i=n.map(()=>`---`);return[`| ${n.join(` | `)} |`,`| ${i.join(` | `)} |`,...r.map(e=>`| ${e.join(` | `)} |`)].join(`
`)},z=e=>{let t=[],n=``,r=()=>{let e=T(n);e&&t.push(e),n=``};return Array.from(e.childNodes).forEach(e=>{if(e instanceof Element&&D(e)&&F.has(e.tagName.toLowerCase())){r();let n=B(e);n&&t.push(n);return}n+=L(e)}),r(),t.length===0?T(I(e)):Ce(t)},B=e=>{if(!D(e)||E(e))return``;let t=e.tagName.toLowerCase();if(t===`pre`){let t=O(e);return t?`\`\`\`${we(e)}\n${t}\n\`\`\``:``}if(t===`table`)return Te(e);if(t===`ul`||t===`ol`)return R(e);if(t===`blockquote`)return z(e).split(`
`).map(e=>e?`> ${e}`:`>`).join(`
`);if(/^h[1-6]$/.test(t)){let n=Number(t.slice(1)),r=I(e);return r?`${`#`.repeat(n)} ${r}`:``}return t===`hr`?`---`:t===`p`||t===`summary`||t===`figcaption`?I(e):z(e)},Ee=18e3,V=(e,t)=>{let n=w(e);return n.length>t?`${n.slice(0,t).trimEnd()}\n[truncated]`:n},De=e=>{let t=(e??``).toLowerCase();return t.includes(`assistant`)||t.includes(`model`)||t.includes(`claude`)||t.includes(`gemini`)?`assistant`:t.includes(`user`)||t.includes(`human`)||t.includes(`you`)?`user`:t.includes(`system`)?`system`:`unknown`},Oe=(e,t)=>t.reduce((t,n)=>t+Number(new RegExp(n,`i`).test(e)),0),ke=(e,t)=>Array.from(e.querySelectorAll(t.selector)).reduce((e,n)=>{let r=w(O(n)||n.textContent||``),i=t.rolePatterns.some(e=>new RegExp(e.pattern,`i`).test(r));return e+Number(i)},0),Ae=(e,t)=>{let n=e.parentElement??e,r=n;for(;r.parentElement&&r.parentElement!==r.ownerDocument.body;){let e=r.parentElement,i=O(e);if(!i)break;let a=t.rolePatterns.map(e=>e.pattern),o=t.maxAncestorChars??12e3;if(Oe(i,a)>1||ke(e,t)>1||i.length>o)break;n=e,r=e}return n},je=(e,t,n)=>{let r=e.tagName.toLowerCase(),i=n.tagRoles?.[r];if(i!==void 0)return i;if(n.role!==`infer`)return n.role;let a=n.roleAttributes?.map(t=>e.getAttribute(t)).find(e=>typeof e==`string`&&e.length>0);return a?De(a):n.alternatingRoles?n.alternatingRoles[t%2]:`unknown`},H=(e,t,n)=>{let r=O(e);return r?{role:t,text:r,formattedText:B(e)||r,sourceSelector:n,element:e}:null},Me=(e,t)=>k(e,t.selector,{filterNestedMatches:t.filterNestedMatches}).map((e,n)=>H(e,je(e,n,t),t.sourceSelector)).filter(e=>e!==null),Ne=(e,t,n,r)=>{t&&(e.some(e=>e.element===t&&e.role===n)||e.push({element:t,role:n,sourceSelector:r}))},Pe=(e,t)=>{let n=[];return k(e,t.selector).forEach(e=>{let r=w(O(e)||e.textContent||``);t.rolePatterns.forEach(i=>{new RegExp(i.pattern,`i`).test(r)&&Ne(n,Ae(e,t),i.role,t.sourceSelector)})}),n},Fe=(e,t)=>k(e,t.selector).filter(e=>{let n=O(e);return n.length<t.minTextLength?!1:t.excludePattern?!new RegExp(t.excludePattern,`i`).test(n):!0}).map(e=>({element:e,role:t.role,sourceSelector:t.sourceSelector})),Ie=(e,t)=>{let n=new Set(e.turns.filter(e=>e.role!==`unknown`).map(e=>e.role)),r=new Set(t.turns.filter(e=>e.role!==`unknown`).map(e=>e.role)),i=[Number(n.has(`user`)&&n.has(`assistant`)),n.size,e.turns.filter(e=>e.role!==`unknown`).length,e.turns.length,Number(e.sourceKind===`direct`),e.turns.reduce((e,t)=>e+t.text.length,0)],a=[Number(r.has(`user`)&&r.has(`assistant`)),r.size,t.turns.filter(e=>e.role!==`unknown`).length,t.turns.length,Number(t.sourceKind===`direct`),t.turns.reduce((e,t)=>e+t.text.length,0)];for(let e=0;e<i.length;e+=1){let t=i[e]-a[e];if(t!==0)return t}return 0},Le=(e,t)=>{let n=t.directSources.map(t=>({sourceKind:`direct`,turns:Me(e,t)})).filter(e=>e.turns.length>0),r=ge([...t.headingSources?.flatMap(t=>Pe(e,t))??[],...t.editableSources?.flatMap(t=>Fe(e,t))??[]]).map(e=>H(e.element,e.role,e.sourceSelector)).filter(e=>e!==null);return r.length>0&&n.push({sourceKind:`structural`,turns:r}),[...n.reduce((e,t)=>!e||Ie(t,e)>0?t:e,null)?.turns??[]]},Re=(e,t)=>{if(!t.mergeAdjacentSameRoleTurns)return[...e];let n=[];for(let t of e){let e=n.at(-1);if(e?.role===t.role&&e.sourceSelector===t.sourceSelector){e.text=`${e.text}\n\n${t.text}`.trim(),e.formattedText=`${e.formattedText}\n\n${t.formattedText}`.trim();continue}n.push({...t})}return n},U=(e,t,n,r,i)=>{let a=[];for(let o of Re(e,n)){let e=V(o.text,t);if(!e)continue;let s=o.element!==void 0&&i!==void 0?pe({provider:n.provider,turnNode:o.element,role:o.role,doc:i}):{};a.push({role:o.role,text:e,formattedText:o.formattedText.trim()||e,ordinal:a.length,capturedAt:r,sourceSelector:o.sourceSelector,...s.modelName===void 0?{}:{modelName:s.modelName},...s.markdown===void 0?{}:{markdown:s.markdown},...s.reasoning===void 0?{}:{reasoning:s.reasoning},...s.attachments===void 0?{}:{attachments:s.attachments},...s.researchReport===void 0?{}:{researchReport:s.researchReport}})}return a},ze=(e,t,n)=>{let r=e.querySelector(`main`)??e.body;return U([{role:`unknown`,text:V(O(r),t),formattedText:B(r)||O(r),sourceSelector:`visible main/body fallback`}],t,N.unknown,n)},Be=(e,t)=>e.length===0?`failed`:t?`warning`:`ok`,Ve=(e,t)=>{try{let n=new URL(t);if(e===`chatgpt`)return/\/(?:c|g\/[^/]+\/c)\/([^/?#]+)/.exec(n.pathname)?.[1];if(e===`codex`)return/\/codex\/([^/?#]+)/.exec(n.pathname)?.[1];if(e===`claude`)return/\/chat\/([^/?#]+)/.exec(n.pathname)?.[1];if(e===`gemini`)return n.pathname.split(`/`).filter(Boolean).at(-1)}catch{return}},W=e=>{let t=e.trim();if(!(t.length===0||t.length>80))return t},He=(e,t)=>{try{if(t===`gemini`){let t=e.querySelector(`bard-mode-switcher button`);return t===null?void 0:W(t.textContent)}if(t===`claude`){let t=Array.from(e.querySelectorAll(`button`)).find(e=>{let t=e.textContent.trim();return/^(?:Claude\s|Sonnet|Opus|Haiku)/i.test(t)&&t.length<=60});return t===void 0?void 0:W(t.textContent)}if(t===`chatgpt`){for(let t of[`Heavy`,`Thinking`,`Pro`,`Auto`])if(Array.from(e.querySelectorAll(`button, span`)).find(e=>e.textContent.trim()===t)!==void 0)return t;return}return}catch{return}},Ue=e=>{let t=Array.from(e.querySelectorAll(`a, button, [role="link"], [role="button"], header *, [class*="branch" i], [data-testid*="branch" i]`)).slice(0,200);for(let e of t){let t=e.textContent.trim();if(t.length===0||t.length>200)continue;let n=/^(?:branched|forked)\s+from[:\s]+(.+)$/i.exec(t);if(n===null)continue;let r=n[1].trim().replace(/^["“]|["”]$/g,``),i=e instanceof HTMLAnchorElement?e:e.closest(`a`)??e.querySelector(`a`),a=i instanceof HTMLAnchorElement&&i.href.length>0?i.href:void 0;return{...r.length===0?{}:{forkedFromTitle:r},...a===void 0?{}:{forkedFromUrl:a}}}return{}},We=(e,t={})=>{let n=t.url??e.location.href,r=t.title??e.title,i=t.capturedAt??new Date().toISOString(),a=t.maxChars??Ee,o=j(n),s=N[o],c=!1,l=U(Le(e,s),a,s,i,e);l.length===0&&o===`unknown`&&(c=!0,l=ze(e,a,i));let u=l.map(e=>e.text).join(`

`),d=xe(u,n);o===`unknown`&&d.push({code:`unsupported_provider`,message:`Provider is unknown; capture used conservative visible-text selectors.`,severity:`info`});let f=Ue(e),p=He(e,o);return{provider:o,threadId:Ve(o,n),threadUrl:n,title:r,capturedAt:i,selectorCanary:Be(l,c),extractionConfigVersion:s.version,visibleTextCharCount:u.length,warnings:d,turns:l,...f,...p===void 0?{}:{selectedModel:p}}},G={captureVisibleThread:`sidetrack.capture.visible-thread`,autoCapture:`sidetrack.capture.auto`,captureFeedback:`sidetrack.capture.feedback`,selectorCanary:`sidetrack.capture.selector-canary`,getWorkboardState:`sidetrack.workboard.state`,saveCompanionSettings:`sidetrack.settings.companion.save`,captureCurrentTab:`sidetrack.capture.current-tab`,createWorkstream:`sidetrack.workstream.create`,updateWorkstream:`sidetrack.workstream.update`,bulkUpdateWorkstreamPrivacy:`sidetrack.workstream.privacy.bulkUpdate`,moveThread:`sidetrack.thread.move`,updateThreadTracking:`sidetrack.thread.tracking.update`,setThreadAutoSend:`sidetrack.thread.autoSend.set`,autoSendItem:`sidetrack.queue.autoSend.item`,autoSendInterimReport:`sidetrack.queue.autoSend.interimReport`,retryAutoSend:`sidetrack.queue.autoSend.retry`,dispatchAutoSendInNewTab:`sidetrack.dispatch.autoSend.newTab`,cacheDispatchOriginal:`sidetrack.dispatch.cacheOriginal`,cacheLastDispatchTarget:`sidetrack.dispatch.cacheLastTarget`,focusThreadInSidePanel:`sidetrack.sidepanel.focusThread`,restoreThreadTab:`sidetrack.thread.restore-tab`,queueFollowUp:`sidetrack.queue.create`,updateQueueItem:`sidetrack.queue.update`,reorderQueueItems:`sidetrack.queue.reorder`,createReminder:`sidetrack.reminder.create`,updateReminder:`sidetrack.reminder.update`,setCollapsedSections:`sidetrack.sections.collapsed.set`,setCollapsedBuckets:`sidetrack.threadBuckets.collapsed.set`,setScreenShareMode:`sidetrack.screenShareMode.set`,workboardChanged:`sidetrack.workboard.changed`,createCodingAttachToken:`sidetrack.coding.attach-token.create`,detachCodingSession:`sidetrack.coding.session.detach`,codingAttachListOffers:`sidetrack.codingAttach.listOffers`,codingAttachMarkStatus:`sidetrack.codingAttach.markStatus`,saveLocalPreferences:`sidetrack.preferences.local.save`,createCaptureNote:`sidetrack.capture.note.create`,updateCaptureNote:`sidetrack.capture.note.update`,deleteCaptureNote:`sidetrack.capture.note.delete`,appendReviewDraftSpan:`sidetrack.review.draft.appendSpan`,dropReviewDraftSpan:`sidetrack.review.draft.dropSpan`,updateReviewDraft:`sidetrack.review.draft.update`,discardReviewDraft:`sidetrack.review.draft.discard`,sendReviewDraftAsFollowUp:`sidetrack.review.draft.sendAsFollowUp`,archiveDispatch:`sidetrack.dispatch.archive`,unarchiveDispatch:`sidetrack.dispatch.unarchive`,recallQuery:`sidetrack.recall.query`},Ge=e=>{let t=Date.parse(e);if(Number.isNaN(t))return`recently`;let n=Math.max(1,Math.round((Date.now()-t)/1e3));if(n<60)return`${String(n)} sec ago`;let r=Math.round(n/60);if(r<60)return`${String(r)} min ago`;let i=Math.round(r/60);return i<48?`${String(i)} hr ago`:`${String(Math.round(i/24))} days ago`},K=`sidetrack-overlay-style`,Ke=`sidetrack-overlay-root`,qe=`
.sidetrack-overlay-root {
  --paper: #f5efe2;
  --paper-light: #fbf7ee;
  --paper-deep: #e8dfc8;
  --ink: #1b1916;
  --ink-2: #4a453d;
  --ink-3: #7a7269;
  --ink-4: #a39a8c;
  --rule: #d4cdb8;
  --rule-soft: #e5ddc9;
  --signal: #c2410c;
  --signal-tint: #fed7aa;
  --signal-bg: #fff7ed;
  --amber: #a16207;
  --amber-tint: #fef3c7;
  --green: #166534;
  --display: 'Fraunces', 'EB Garamond', Georgia, serif;
  --body: 'Source Serif 4', Georgia, serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  font-family: var(--body);
  color: var(--ink);
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483640;
  font-size: 13px;
  line-height: 1.5;
}
.sidetrack-overlay-root * { box-sizing: border-box; }
.sidetrack-ann-margin {
  position: absolute;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 99px;
  background: var(--paper-light);
  border: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  box-shadow: 0 4px 12px -4px rgba(0,0,0,0.15);
  pointer-events: auto;
  cursor: pointer;
}
.sidetrack-ann-margin:hover {
  background: var(--signal-bg);
  border-color: var(--signal-tint);
}
.sidetrack-ann-margin .dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--signal);
}
.sidetrack-ann-hint {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--paper-light);
  border: 1px solid var(--rule);
  border-radius: 99px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  pointer-events: auto;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.2);
}
.sidetrack-ann-hint .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
}
.sidetrack-ann-hint button {
  font-family: var(--mono);
  font-size: 10px;
  background: var(--ink);
  color: var(--paper-light);
  border: 1px solid var(--ink);
  padding: 3px 9px;
  border-radius: 99px;
  cursor: pointer;
}
.sidetrack-ann-hint .close {
  background: transparent;
  color: var(--ink-3);
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 13px;
  line-height: 1;
}
.sidetrack-deja-pop {
  position: absolute;
  background: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 8px;
  width: 360px;
  max-width: 90vw;
  box-shadow: 0 22px 60px -12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.05);
  pointer-events: auto;
  overflow: hidden;
}
.sidetrack-deja-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--signal);
}
.sidetrack-deja-head .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--signal);
}
.sidetrack-deja-head .meta {
  margin-left: auto;
  color: var(--ink-3);
}
.sidetrack-deja-head .close {
  background: transparent;
  color: var(--ink-3);
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
}
.sidetrack-deja-head .close:hover { color: var(--ink); }
.sidetrack-deja-head .sidetrack-deja-mute {
  background: transparent;
  color: var(--ink-3);
  border: 1px solid var(--rule);
  border-radius: 99px;
  cursor: pointer;
  padding: 2px 7px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0;
  text-transform: none;
}
.sidetrack-deja-head .sidetrack-deja-mute:hover {
  color: var(--ink);
  border-color: var(--signal-tint);
  background: var(--signal-bg);
}
.sidetrack-deja-list {
  max-height: 280px;
  overflow: auto;
}
.sidetrack-deja-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: none;
  background: transparent;
  cursor: default;
  border-bottom: 1px solid var(--rule-soft);
  font-family: inherit;
  color: inherit;
}
.sidetrack-deja-row:hover { background: var(--paper); }
.sidetrack-deja-row .r1 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.sidetrack-deja-row .title {
  flex: 1;
  font-family: var(--display);
  font-weight: 500;
  font-size: 13px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidetrack-deja-row .score {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--signal);
  background: var(--signal-bg);
  border: 1px solid var(--signal-tint);
  padding: 1px 5px;
  border-radius: 3px;
}
.sidetrack-deja-provider {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--ink-2);
  background: var(--paper);
  border: 1px solid var(--rule);
  padding: 1px 5px;
  border-radius: 99px;
  white-space: nowrap;
}
.sidetrack-deja-when {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--ink-3);
  white-space: nowrap;
}
.sidetrack-deja-row .snippet {
  font-family: var(--display);
  font-style: italic;
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.45;
  padding-left: 8px;
  border-left: 2px solid var(--signal-tint);
  margin: 4px 0 0;
}
.sidetrack-deja-row .r2 {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 7px;
}
.sidetrack-deja-row .r2 button {
  font-family: var(--mono);
  font-size: 10px;
  border-radius: 99px;
  border: 1px solid var(--rule);
  background: var(--paper-light);
  color: var(--ink-2);
  padding: 3px 8px;
  cursor: pointer;
}
.sidetrack-deja-row .r2 button:hover {
  border-color: var(--signal-tint);
  background: var(--signal-bg);
  color: var(--ink);
}
.sidetrack-deja-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--paper);
  border-top: 1px solid var(--rule-soft);
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
}
.sidetrack-rv-chip-group {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  pointer-events: auto;
}
.sidetrack-rv-chip {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: var(--ink);
  color: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 99px;
  font-family: var(--mono);
  font-size: 10.5px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 8px 24px -8px rgba(0,0,0,0.25);
}
.sidetrack-rv-chip:hover { background: var(--signal); border-color: var(--signal); }
/* Both chips share the same dark-on-paper palette so they read as a
   single chip cluster. The Déjà-vu chip used to invert (paper bg,
   ink text), which broke the visual pairing — they looked like two
   different controls instead of two siblings of one selection
   action. Glyphs differentiate intent. */
.sidetrack-rv-chip .glyph {
  font-family: var(--display); font-size: 12px; line-height: 1; font-weight: 500;
}
.sidetrack-rv-pop {
  position: absolute;
  background: var(--paper-light);
  border: 1px solid var(--ink);
  border-radius: 8px;
  width: 320px;
  max-width: 90vw;
  pointer-events: auto;
  box-shadow: 0 22px 60px -12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.05);
  overflow: hidden;
}
.sidetrack-rv-pop .head {
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule-soft);
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--signal);
  display: flex; align-items: center; gap: 8px;
}
.sidetrack-rv-pop .head .meta { margin-left: auto; color: var(--ink-3); }
.sidetrack-rv-pop .head .close {
  background: transparent; color: var(--ink-3); border: none; cursor: pointer;
  padding: 0 4px; font-size: 14px; line-height: 1;
}
.sidetrack-rv-pop .head .close:hover { color: var(--ink); }
.sidetrack-rv-pop .quote {
  padding: 10px 12px 6px;
  font-family: var(--display); font-style: italic;
  font-size: 12px; color: var(--ink-2); line-height: 1.45;
  border-left: 2px solid var(--signal-tint);
  margin: 8px 12px 4px;
}
.sidetrack-rv-pop textarea {
  display: block; width: calc(100% - 24px); margin: 6px 12px 8px;
  min-height: 80px; resize: vertical;
  font-family: var(--body); font-size: 13px; color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--rule); border-radius: 5px;
  padding: 7px 9px; outline: none;
}
.sidetrack-rv-pop textarea:focus { border-color: var(--ink-3); }
.sidetrack-rv-pop .acts {
  display: flex; gap: 6px; padding: 7px 12px;
  background: var(--paper); border-top: 1px solid var(--rule-soft);
}
.sidetrack-rv-pop .acts .grow { flex: 1; }
.sidetrack-rv-pop .acts button {
  font-family: var(--mono); font-size: 10.5px;
  padding: 5px 11px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--paper-light); color: var(--ink-2);
}
.sidetrack-rv-pop .acts button.primary {
  background: var(--ink); color: var(--paper-light); border-color: var(--ink);
}
.sidetrack-rv-pop .acts button.primary:hover { background: var(--signal); border-color: var(--signal); }
.sidetrack-rv-pop .acts button:disabled { opacity: 0.5; cursor: not-allowed; }
`,q=()=>{let e=document.getElementById(K);e===null&&(e=document.createElement(`style`),e.id=K,document.head.appendChild(e)),e.textContent!==qe&&(e.textContent=qe);let t=document.getElementById(Ke);return t===null&&(t=document.createElement(`div`),t.id=Ke,t.className=`sidetrack-overlay-root`,document.body.appendChild(t)),t},Je=e=>{for(let t of e.querySelectorAll(`.sidetrack-ann-margin, .sidetrack-ann-hint`))t.remove()},Ye=e=>{if(e.length===0)return;let t=q();Je(t);let n=Math.max(document.documentElement.scrollHeight,document.documentElement.clientHeight,1);for(let r of e){let e=document.createElement(`div`);e.className=`sidetrack-ann-margin`;let i=r.rect.top+window.scrollY,a=Math.max(2,Math.min(96,i/n*100));e.style.top=`${String(a)}%`,e.title=`Annotation ${r.id}`,e.innerHTML=`<span class="dot"></span><span>1</span>`,t.appendChild(e)}let r=document.createElement(`div`);r.className=`sidetrack-ann-hint`,r.innerHTML=`
    <span class="dot"></span>
    <span>${String(e.length)} annotation${e.length===1?``:`s`} restored</span>
    <button type="button" class="close" aria-label="Dismiss">×</button>
  `,r.querySelector(`.close`)?.addEventListener(`click`,()=>{r.remove()}),t.appendChild(r)},Xe=360,Ze=e=>{for(let t of e.querySelectorAll(`.sidetrack-deja-pop`))t.remove()},J=320,Qe=e=>{for(let t of e.querySelectorAll(`.sidetrack-rv-chip, .sidetrack-rv-chip-group, .sidetrack-rv-pop`))t.remove()},$e=e=>{let t=q();Qe(t);let n=e.onDejaVu===void 0?110:216,r=document.documentElement.clientWidth,i=Math.max(8,e.anchorRect.right-50);i+n>r-8&&(i=r-n-8),i<8&&(i=8);let a=e.anchorRect.bottom+6,o=document.createElement(`button`);o.type=`button`,o.className=`sidetrack-rv-chip`,o.style.left=`${String(i)}px`,o.style.top=`${String(a)}px`,o.innerHTML=`<span class="glyph">+</span><span>Comment</span>`;let s;e.onDejaVu!==void 0&&(s=document.createElement(`button`),s.type=`button`,s.className=`sidetrack-rv-chip`,s.style.left=`${String(i+110+6)}px`,s.style.top=`${String(a)}px`,s.innerHTML=`<span class="glyph">⟲</span><span>Déjà-vu</span>`);let c=()=>{o.remove(),s?.remove();for(let e of t.querySelectorAll(`.sidetrack-rv-pop`))e.remove();e.onDismiss?.()},l=()=>{o.remove(),s?.remove();let n=document.createElement(`div`);n.className=`sidetrack-rv-pop`;let r=document.documentElement.clientWidth,i=e.anchorRect.left+e.anchorRect.width/2-J/2;i<8&&(i=8),i+J>r-8&&(i=r-8-J),n.style.left=`${String(i)}px`,n.style.top=`${String(e.anchorRect.bottom+6)}px`;let a=e.quote.length>200?`${e.quote.slice(0,200).trimEnd()}…`:e.quote;n.innerHTML=`
      <div class="head">
        <span>Comment on selection</span>
        <span class="meta"></span>
        <button type="button" class="close" aria-label="Dismiss">×</button>
      </div>
      <div class="quote"></div>
      <textarea placeholder="What did this miss / get wrong / need next?" autofocus></textarea>
      <div class="acts">
        <span class="grow"></span>
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="primary save" disabled>Save</button>
      </div>
    `;let l=n.querySelector(`.quote`);l!==null&&(l.textContent=a);let u=n.querySelector(`textarea`),d=n.querySelector(`.save`);u!==null&&d!==null&&(u.addEventListener(`input`,()=>{d.disabled=u.value.trim().length===0}),d.addEventListener(`click`,()=>{let t=u.value.trim();t.length!==0&&(d.disabled=!0,Promise.resolve(e.onSave(t)).then(()=>{c()}).catch(()=>{d.disabled=!1}))})),n.querySelector(`.cancel`)?.addEventListener(`click`,c),n.querySelector(`.head .close`)?.addEventListener(`click`,c),t.appendChild(n),window.setTimeout(()=>u?.focus(),0)};if(o.addEventListener(`click`,e=>{e.preventDefault(),e.stopPropagation(),l()}),s!==void 0){let t=s;t.addEventListener(`click`,n=>{n.preventDefault(),n.stopPropagation(),o.remove(),t.remove(),e.onDejaVu?.()})}return t.appendChild(o),s!==void 0&&t.appendChild(s),{close:c}},et=e=>e===`chatgpt`?`ChatGPT`:e===`claude`?`Claude`:e===`gemini`?`Gemini`:e===`codex`?`Codex`:`Generic`,tt=e=>{let t=q();Ze(t);let n=document.createElement(`div`);n.className=`sidetrack-deja-pop`,n.style.left=`-9999px`,n.style.top=`0px`,n.style.maxHeight=`${String(Math.min(420,document.documentElement.clientHeight-40))}px`,n.style.overflow=`auto`;let r=e.items.length===0;n.innerHTML=`
    <div class="sidetrack-deja-head">
      <span class="dot"></span>
      <span>${r?`Déjà-vu`:`Seen this before`}</span>
      <span class="meta">${r?`no prior threads matched`:`${String(e.items.length)} prior thread${e.items.length===1?``:`s`}`}</span>
      <button type="button" class="sidetrack-deja-mute">Mute on this page</button>
      <button type="button" class="close" aria-label="Dismiss">×</button>
    </div>
    <div class="sidetrack-deja-list"></div>
    <div class="sidetrack-deja-foot">
      <span style="flex:1">on-device · vector recall</span>
    </div>
  `;let i=n.querySelector(`.sidetrack-deja-list`);if(r&&i!==null){let e=document.createElement(`div`);e.className=`sidetrack-deja-empty`,e.style.cssText=`padding: 18px 14px; text-align: center; color: var(--ink-3); font-style: italic; font-size: 12px;`,e.textContent=`No similar prior threads found in your vault.`,i.appendChild(e)}if(!r&&i!==null)for(let t of e.items){let n=document.createElement(`div`);n.className=`sidetrack-deja-row`,n.innerHTML=`
        <div class="r1">
          <span class="title"></span>
          <span class="sidetrack-deja-provider"></span>
          <span class="sidetrack-deja-when"></span>
          <span class="score"></span>
        </div>
        <div class="snippet"></div>
        <div class="r2">
          <button type="button" class="jump">Jump</button>
          <button type="button" class="mute">Mute on this page</button>
        </div>
      `;let r=n.querySelector(`.title`);r!==null&&(r.textContent=t.title);let a=n.querySelector(`.sidetrack-deja-provider`);a!==null&&(a.textContent=et(t.provider));let o=n.querySelector(`.sidetrack-deja-when`);o!==null&&(o.textContent=Ge(t.relativeWhen));let s=n.querySelector(`.score`);s!==null&&(s.textContent=t.score.toFixed(2));let c=n.querySelector(`.snippet`);c!==null&&(c.textContent=t.snippet),n.querySelector(`.jump`)?.addEventListener(`click`,()=>{e.onJump?.(t)}),n.querySelector(`.mute`)?.addEventListener(`click`,()=>{e.onMute?.()}),i.appendChild(n)}let a=()=>{n.remove(),e.onDismiss?.()};n.querySelector(`.close`)?.addEventListener(`click`,a),n.querySelector(`.sidetrack-deja-mute`)?.addEventListener(`click`,()=>{e.onMute?.()}),t.appendChild(n);let o=()=>{let t=n.getBoundingClientRect(),r=t.height,i=t.width||Xe,a=document.documentElement.clientWidth,o=document.documentElement.clientHeight,s=e.anchorRect.left+e.anchorRect.width/2-i/2;s<8&&(s=8),s+i>a-8&&(s=a-8-i);let c=e.anchorRect.top-8,l=o-e.anchorRect.bottom-8,u;u=r+6<=c?e.anchorRect.top-r-6:r+6<=l?e.anchorRect.bottom+6:l>=c?Math.max(8,o-r-8):8,n.style.left=`${String(Math.round(s))}px`,n.style.top=`${String(Math.round(u))}px`};return o(),requestAnimationFrame(o),{close:a}},nt={chatgpt:{composer:[`div#prompt-textarea[role="textbox"]`,`#prompt-textarea`],sendButton:[],stopButton:[`button[data-testid="stop-button"]`,`button[aria-label*="Stop" i]`]},claude:{composer:[`div[data-testid="chat-input"][role="textbox"]`,`div.tiptap.ProseMirror`],sendButton:[],stopButton:[`button[aria-label*="Stop" i]`]},gemini:{composer:[`rich-textarea div.ql-editor[role="textbox"]`,`rich-textarea div.ql-editor`],sendButton:[`button[aria-label*="Send message" i]`,`button.send-button`],stopButton:[`button[aria-label*="Stop" i]`]}},Y=e=>{for(let t of e){let e=document.querySelector(t);if(e!==null)return e}return null},X=e=>new Promise(t=>setTimeout(t,e)),Z=async(e,t,n=250)=>{let r=Date.now()+t;for(;Date.now()<r;){if(e())return!0;await X(n)}return!1},Q=e=>{for(let t of e.stopButton){let e=document.querySelector(t);if(e!==null&&e.offsetParent!==null)return!0}return!1},rt=async(e,t,n)=>{let r=j(window.location.href);if(r===`unknown`)return{ok:!1,error:`Not on a supported provider page.`};if(r===`codex`)return{ok:!1,error:`Auto-send does not support Codex sessions yet.`};let i=nt[r];await Z(()=>Y(i.composer)!==null,15e3,200);let a=Y(i.composer);if(!(a instanceof HTMLElement))return{ok:!1,error:`Composer not found in DOM (timed out after 15s).`};let o=a;if(Q(i))return{ok:!1,error:`AI is still responding to a previous message.`};if(o.focus(),await X(80),document.execCommand(`insertText`,!1,t),await X(120),i.sendButton.length>0){let e=Y(i.sendButton);if(!(e instanceof HTMLElement))return{ok:!1,error:`Send button not found in DOM.`};e.click()}else o.dispatchEvent(new KeyboardEvent(`keydown`,{key:`Enter`,bubbles:!0,cancelable:!0}));return await Z(()=>Q(i),5e3,200)&&e!==void 0&&chrome.runtime.sendMessage({type:G.autoSendInterimReport,itemId:e,phase:`waiting`}),await Z(()=>!Q(i),n,500)?{ok:!0}:{ok:!1,error:`AI did not finish responding within the timeout.`}},it=e=>typeof e==`object`&&!!e&&`type`in e&&e.type===G.autoSendItem&&`text`in e&&typeof e.text==`string`,at=e=>typeof e==`object`&&!!e&&`type`in e&&e.type===G.captureVisibleThread,ot=e({matches:[`https://chatgpt.com/*`,`https://chat.openai.com/*`,`https://claude.ai/*`,`https://gemini.google.com/*`,`http://127.0.0.1/*`,`http://localhost/*`],runAt:`document_idle`,main(){let e=``,t,n=()=>We(document,{url:window.location.href,title:document.title}),r=[],i=async()=>{try{let e=await ee();if(e===void 0)return;let t=await e.listAnnotationsForUrl(window.location.href);for(let e of t){let t=c(document.documentElement,e.anchor);t!==null&&r.push({id:e.bac_id,rect:t.getBoundingClientRect()})}r.length>0&&Ye(r)}catch{}},a=(e,t)=>{r.push({id:e,rect:t.getBoundingClientRect()}),Ye(r)},o,l=null,u=null,d=new Set,f=`dejaVuMutedUrls`,p=async()=>{try{let e=(await chrome.storage.session.get({[f]:[]}))[f];if(Array.isArray(e)){d.clear();for(let t of e)typeof t==`string`&&d.add(t)}}catch{}},m=async()=>{d.add(window.location.href);try{await chrome.storage.session.set({[f]:Array.from(d)})}catch{}};p();let h=()=>{l?.close(),l=null},g=()=>{u?.close(),u=null},_=()=>{let e=j(window.location.href);if(e===`unknown`)return null;let t=N[e].directSources.map(e=>e.selector).filter(e=>e.length>0);return t.length===0?null:t.join(`, `)},v=e=>{let t=_();if(t===null)return!1;let n=e.anchorNode;if(n===null)return!1;let r=n instanceof Element?n:n.parentElement;if(r===null)return!1;try{return r.closest(t)!==null}catch{return!1}},y=(e,t)=>{let n=j(window.location.href);if(n===`unknown`||!M(n,window.location.href))return;let r=e.getRangeAt(0),i=e.toString(),o;try{o=s(r)}catch{return}let c=window.location.href;g(),u=$e({anchorRect:t,quote:i,onSave:async e=>{await chrome.runtime.sendMessage({type:G.appendReviewDraftSpan,threadUrl:c,anchor:o,quote:i,comment:e,capturedAt:new Date().toISOString()}),a(`local-${String(Date.now())}`,r)},onDismiss:()=>{u=null},onDejaVu:()=>{u=null,b(i.trim(),t,!0)}})},b=async(e,t,n=!1)=>{if(!(!n&&d.has(window.location.href)))try{let r=await chrome.runtime.sendMessage({type:G.recallQuery,q:e,limit:5,currentUrl:window.location.href});if(!r.ok&&(console.warn(`[sidetrack] recall query failed:`,r.error),!n))return;let i=r.items;if(i.length===0&&!n)return;h(),l=tt({items:i.map(e=>({id:e.id,title:e.title??`thread ${e.threadId.slice(0,12)}`,snippet:e.snippet??``,score:e.score,relativeWhen:e.capturedAt,provider:j(e.threadUrl??window.location.href),...e.threadUrl===void 0?{}:{threadUrl:e.threadUrl},bacId:e.threadId})),anchorRect:t,onJump:e=>{e.threadUrl!==void 0&&chrome.runtime.sendMessage({type:G.focusThreadInSidePanel,threadUrl:e.threadUrl,...e.bacId===void 0?{}:{bacId:e.bacId},title:e.title,lastSeenAt:e.relativeWhen}),h()},onMute:()=>{m(),h()},onDismiss:()=>{l=null}})}catch{}};document.addEventListener(`selectionchange`,()=>{o!==void 0&&window.clearTimeout(o),o=window.setTimeout(()=>{let e=window.getSelection();if(e===null||e.rangeCount===0)return;let t=e.toString().trim();if(t.length<3)return;let n=e.getRangeAt(0).getBoundingClientRect();n.width===0&&n.height===0||(v(e)&&y(e,n),t.length>=18&&b(t,n))},400)}),document.addEventListener(`mousedown`,e=>{let t=e.target;t instanceof Element&&(l!==null&&t.closest(`.sidetrack-deja-pop`)===null&&h(),u!==null&&t.closest(`.sidetrack-rv-chip, .sidetrack-rv-pop`)===null&&g())});let x=e=>{let t=e.turns.at(-1);return`${e.provider}:${e.threadUrl}:${String(e.turns.length)}:${t?.role??``}:${t?.text.slice(0,120)??``}`},S=()=>{try{let t=n();if(t.provider===`unknown`||t.turns.length===0||!M(t.provider,t.threadUrl))return;let r=x(t);if(r===e)return;e=r,chrome.runtime.sendMessage({type:G.autoCapture,capture:t})}catch{document.documentElement.setAttribute(`data-sidetrack-provider-canary`,`failed`)}};chrome.runtime.onMessage.addListener((e,t,r)=>{if(at(e)){try{r({ok:!0,capture:n()})}catch(e){r({ok:!1,error:e instanceof Error?e.message:`Visible conversation capture failed.`})}return!0}if(it(e)){let t=e.perItemTimeoutMs??9e4;return rt(e.itemId,e.text,t).then(e=>{r(e)}).catch(e=>{r({ok:!1,error:e instanceof Error?e.message:`auto-send failed.`})}),!0}}),window.setTimeout(()=>{try{let e=n();if(document.documentElement.setAttribute(`data-sidetrack-provider-canary`,e.selectorCanary??`failed`),e.provider===`unknown`||!M(e.provider,e.threadUrl)||e.turns.length===0)return;chrome.runtime.sendMessage({type:G.selectorCanary,report:{provider:e.provider,url:e.threadUrl,title:e.title??e.threadUrl,selectorCanary:e.selectorCanary??`failed`,checkedAt:e.capturedAt}})}catch{document.documentElement.setAttribute(`data-sidetrack-provider-canary`,`failed`)}},1200),window.setTimeout(()=>{i()},1500),window.setTimeout(S,3e3),new MutationObserver(()=>{t!==void 0&&window.clearTimeout(t),t=window.setTimeout(S,2500)}).observe(document.body,{childList:!0,subtree:!0,characterData:!0})}}),st={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)},ct=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome,lt=class e extends Event{static EVENT_NAME=$(`wxt:locationchange`);constructor(t,n){super(e.EVENT_NAME,{}),this.newUrl=t,this.oldUrl=n}};function $(e){return`${ct?.runtime?.id}:content:${e}`}var ut=typeof globalThis.navigation?.addEventListener==`function`;function dt(e){let t,n=!1;return{run(){n||(n=!0,t=new URL(location.href),ut?globalThis.navigation.addEventListener(`navigate`,e=>{let n=new URL(e.destination.url);n.href!==t.href&&(window.dispatchEvent(new lt(n,t)),t=n)},{signal:e.signal}):e.setInterval(()=>{let e=new URL(location.href);e.href!==t.href&&(window.dispatchEvent(new lt(e,t)),t=e)},1e3))}}}var ft=class e{static SCRIPT_STARTED_MESSAGE_TYPE=$(`wxt:content-script-started`);id;abortController;locationWatcher=dt(this);constructor(e,t){this.contentScriptName=e,this.options=t,this.id=Math.random().toString(36).slice(2),this.abortController=new AbortController,this.stopOldScripts(),this.listenForNewerScripts()}get signal(){return this.abortController.signal}abort(e){return this.abortController.abort(e)}get isInvalid(){return ct.runtime?.id??this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(e){return this.signal.addEventListener(`abort`,e),()=>this.signal.removeEventListener(`abort`,e)}block(){return new Promise(()=>{})}setInterval(e,t){let n=setInterval(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearInterval(n)),n}setTimeout(e,t){let n=setTimeout(()=>{this.isValid&&e()},t);return this.onInvalidated(()=>clearTimeout(n)),n}requestAnimationFrame(e){let t=requestAnimationFrame((...t)=>{this.isValid&&e(...t)});return this.onInvalidated(()=>cancelAnimationFrame(t)),t}requestIdleCallback(e,t){let n=requestIdleCallback((...t)=>{this.signal.aborted||e(...t)},t);return this.onInvalidated(()=>cancelIdleCallback(n)),n}addEventListener(e,t,n,r){t===`wxt:locationchange`&&this.isValid&&this.locationWatcher.run(),e.addEventListener?.(t.startsWith(`wxt:`)?$(t):t,n,{...r,signal:this.signal})}notifyInvalidated(){this.abort(`Content script context invalidated`),st.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){document.dispatchEvent(new CustomEvent(e.SCRIPT_STARTED_MESSAGE_TYPE,{detail:{contentScriptName:this.contentScriptName,messageId:this.id}})),window.postMessage({type:e.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:this.id},`*`)}verifyScriptStartedEvent(e){let t=e.detail?.contentScriptName===this.contentScriptName,n=e.detail?.messageId===this.id;return t&&!n}listenForNewerScripts(){let t=e=>{!(e instanceof CustomEvent)||!this.verifyScriptStartedEvent(e)||this.notifyInvalidated()};document.addEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t),this.onInvalidated(()=>document.removeEventListener(e.SCRIPT_STARTED_MESSAGE_TYPE,t))}},pt={debug:(...e)=>([...e],void 0),log:(...e)=>([...e],void 0),warn:(...e)=>([...e],void 0),error:(...e)=>([...e],void 0)};return(async()=>{try{let{main:e,...t}=ot;return await e(new ft(`content`,t))}catch(e){throw pt.error(`The content script "content" crashed on startup!`,e),e}})()})();
content;