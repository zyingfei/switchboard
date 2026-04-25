const workspacePage = 'workspace.html';

const workspaceUrl = (): string => chrome.runtime.getURL(workspacePage);

const findWorkspaceTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  const targetUrl = workspaceUrl();
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url?.startsWith(targetUrl));
};

export const openWorkspace = async (): Promise<void> => {
  const existingTab = await findWorkspaceTab();
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, { active: true });
    if (typeof existingTab.windowId === 'number') {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    return;
  }

  const url = workspaceUrl();
  try {
    await chrome.windows.create({
      url,
      type: 'popup',
      width: 560,
      height: 920,
    });
    return;
  } catch {
    await chrome.tabs.create({ url });
  }
};
