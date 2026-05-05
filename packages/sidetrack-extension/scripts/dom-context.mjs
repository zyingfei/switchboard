import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sp = b.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
if (!sp) { console.log('no side panel'); process.exit(1); }
const data = await sp.evaluate(() => {
  const target = Array.from(document.querySelectorAll('.thread')).find(r => /Agentic Coding Debate/.test(r.textContent || ''));
  if (!target) return { found: false };
  const wsLabelText = target.querySelector('.thread-ws-path')?.textContent;
  // Walk up to find the closest "section" header
  let parent = target.parentElement;
  let sectionHeading = null;
  for (let i = 0; i < 10 && parent; i++) {
    const h = parent.querySelector('h2, h3, .section-head, .bucket-head, [class*="ucket"]');
    if (h && parent.contains(target)) {
      sectionHeading = h.textContent;
      break;
    }
    parent = parent.parentElement;
  }
  return {
    found: true,
    wsLabelText,
    rowText: (target.textContent || '').slice(0, 200),
    sectionHeading,
    parentClasses: target.parentElement?.className,
    parentText: (target.parentElement?.textContent || '').slice(0, 200),
  };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
