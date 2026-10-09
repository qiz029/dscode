/** Map a scoped chrome.debugger connection to the CDP browser/target envelope. */
export class SharedTabs {
  constructor(api, emit) {
    this.api = api;
    this.emit = emit;
    this.tabs = new Map();
    this.attachedTabs = new Set();
    this.sessions = new Map();
    this.discover = false;
    this.autoAttach = false;
    this.sequence = 0;
    this.closed = false;
  }

  info(tab, type = 'page') {
    return { targetId: type === 'tab' ? `tab-${tab.id}` : tab.targetId, type,
      title: tab.title ?? '', url: tab.url, attached: true, canAccessOpener: false, browserContextId: 'shared' };
  }

  event(method, params, sessionId) { this.emit({ method, params, ...(sessionId ? { sessionId } : {}) }); }

  attach(tab, type, parent) {
    const sessionId = `dscode-${++this.sequence}`;
    this.sessions.set(sessionId, { tabId: tab.id, type, parent });
    this.event('Target.attachedToTarget', { sessionId, targetInfo: this.info(tab, type), waitingForDebugger: false }, parent);
    return { sessionId };
  }

  async share(tabId) {
    if (this.closed) throw Error('Sharing has ended. Pair again.');
    if (this.tabs.has(tabId)) return;
    const tab = await this.api.tabs.get(tabId);
    // activeTab is granted by the toolbar gesture. A popup reopened from another
    // extension surface still gets metadata only for the explicitly chosen ID.
    if (!tab.url) {
      const target = (await this.api.debugger.getTargets()).find(t => t.tabId === tabId);
      tab.url = target?.url; tab.title = target?.title;
    }
    if (!/^https?:\/\//.test(tab.url ?? '') && tab.url !== 'about:blank') throw Error('Only HTTP(S) pages can be shared.');
    if (this.closed) throw Error('Sharing has ended.');
    await this.api.debugger.attach({ tabId }, '1.3');
    this.attachedTabs.add(tabId);
    try {
      if (this.closed) throw Error('Sharing has ended.');
      const { targetInfo } = await this.api.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      if (this.closed || !this.attachedTabs.has(tabId)) throw Error('Sharing has ended.');
      const shared = { id: tabId, targetId: targetInfo.targetId, url: tab.url, title: tab.title };
      this.tabs.set(tabId, shared);
      if (this.discover) for (const type of ['tab', 'page']) this.event('Target.targetCreated', { targetInfo: this.info(shared, type) });
      if (this.autoAttach) this.attach(shared, 'tab');
    } catch (error) {
      if (this.attachedTabs.delete(tabId)) await this.api.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
  }

  async stop() {
    this.closed = true;
    const ids = [...this.attachedTabs];
    this.attachedTabs.clear();
    this.tabs.clear();
    this.sessions.clear();
    await Promise.allSettled(ids.map(tabId => this.api.debugger.detach({ tabId })));
  }

  update(tabId, change) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (change.url !== undefined) tab.url = change.url;
    if (change.title !== undefined) tab.title = change.title;
    for (const type of ['tab', 'page']) this.event('Target.targetInfoChanged', { targetInfo: this.info(tab, type) });
  }

  detach(sessionId, params = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // A detached ancestor invalidates every descendant route. Notify clients
    // while those descendants' parent routes still exist in their session tree.
    for (const [id, child] of [...this.sessions]) if (child.parent === sessionId) this.detach(id);
    this.sessions.delete(sessionId);
    this.event('Target.detachedFromTarget', { ...params, sessionId }, session.parent);
    return true;
  }

  remove(tabId) {
    this.attachedTabs.delete(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    for (const [id, session] of [...this.sessions]) if (session.tabId === tabId) this.detach(id);
    for (const type of ['page', 'tab']) this.event('Target.targetDestroyed', { targetId: this.info(tab, type).targetId });
  }

  debuggerEvent(source, method, params) {
    if (!this.tabs.has(source.tabId)) return;
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.tabId !== source.tabId || session.type !== 'page' || session.child !== source.sessionId) continue;
      if (method === 'Target.attachedToTarget') {
        const child = `${sessionId}:${params.sessionId}`;
        this.sessions.set(child, { tabId: source.tabId, type: 'page', child: params.sessionId, parent: sessionId });
        this.event(method, { ...params, sessionId: child }, sessionId);
      } else if (method === 'Target.detachedFromTarget') {
        const child = `${sessionId}:${params.sessionId}`;
        this.detach(child, params);
      } else this.event(method, params, sessionId);
    }
  }

  async command({ method, params = {}, sessionId }) {
    if (this.closed) throw Error('Sharing has ended.');
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) throw Error('Unknown shared session.');
    const tab = session ? this.tabs.get(session.tabId) : undefined;
    if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
    if (method === 'Target.getTargets') return { targetInfos: [...this.tabs.values()].flatMap(t => [this.info(t, 'tab'), this.info(t)]) };
    if (method === 'Target.setDiscoverTargets' && !session) {
      this.discover = !!params.discover;
      if (this.discover) for (const t of this.tabs.values()) for (const type of ['tab', 'page']) this.event('Target.targetCreated', { targetInfo: this.info(t, type) });
      return {};
    }
    if (method === 'Target.setAutoAttach' && (!session || session.type === 'tab')) {
      if (!params.flatten || !params.autoAttach) throw Error('Only flattened automatic attachment is supported.');
      if (!session) {
        if (!this.autoAttach) { this.autoAttach = true; for (const t of this.tabs.values()) this.attach(t, 'tab'); }
      } else if (!session.attached) { session.attached = true; this.attach(tab, 'page', sessionId); }
      return {};
    }
    if (method === 'Runtime.runIfWaitingForDebugger' && session?.type === 'tab') return {};
    if (method === 'Target.attachToTarget') {
      const found = [...this.tabs.values()].find(t => t.targetId === params.targetId || `tab-${t.id}` === params.targetId);
      if (!found || !params.flatten) throw Error('Target is not shared.');
      return this.attach(found, params.targetId.startsWith('tab-') ? 'tab' : 'page', sessionId);
    }
    if (method === 'Target.detachFromTarget') {
      if (!this.detach(params.sessionId)) throw Error('Unknown shared session.');
      return {};
    }
    if (method === 'Target.createTarget' && !session) {
      if (params.browserContextId || (!/^https?:\/\//.test(params.url) && params.url !== 'about:blank')) throw Error('Only HTTP(S) or blank tabs in the shared browser are supported.');
      const created = await this.api.tabs.create({ url: params.url, active: !params.background });
      await this.share(created.id);
      return { targetId: this.tabs.get(created.id).targetId };
    }
    if (['Target.closeTarget', 'Target.activateTarget'].includes(method)) {
      const found = [...this.tabs.values()].find(t => t.targetId === params.targetId || `tab-${t.id}` === params.targetId);
      if (!found) throw Error('Target is not shared.');
      if (method === 'Target.closeTarget') { await this.api.tabs.remove(found.id); return { success: true }; }
      await this.api.tabs.update(found.id, { active: true }); return {};
    }
    if (method === 'Browser.getVersion') return this.api.version();
    if (!session || session.type !== 'page') throw Error(`Unsupported browser command: ${method}`);
    // Target discovery and cookie APIs can escape the selected tab's scope.
    if (method.startsWith('Browser.') ||
        (method.startsWith('Target.') && !['Target.setAutoAttach', 'Target.getTargetInfo'].includes(method)) ||
        (method.startsWith('Storage.') && method !== 'Storage.getStorageKeyForFrame') ||
        ['Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache'].includes(method)) {
      throw Error(`Command is outside shared-tab scope: ${method}`);
    }
    if (method === 'Target.getTargetInfo') {
      if (params.targetId && params.targetId !== tab.targetId) throw Error('Target is not shared in this session.');
      if (!session.child) return { targetInfo: this.info(tab) };
    }
    if (method === 'Target.setAutoAttach') {
      params = { ...params, flatten: true, filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }] };
    }
    return this.api.debugger.sendCommand({ tabId: session.tabId, ...(session.child ? { sessionId: session.child } : {}) }, method, params);
  }
}
