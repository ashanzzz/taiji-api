import { AdminApi, ApiError } from './api.js';
import { empty, labels, loginView, pageView, shell, time } from './views.js';
import { icon } from './icons.js';

const api = new AdminApi();
const appRoot = document.querySelector('#app');
const routes = new Set(Object.keys(labels));

class ConsoleApp {
  constructor() {
    this.state = null;
    this.models = null;
    this.tests = [];
    this.logs = [];
    this.route = this.getRoute();
    this.playAbort = null;
    this.testPoll = null;
  }

  async start() {
    window.addEventListener('hashchange', () => this.navigate());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.state) this.refreshState(false);
    });
    try {
      await this.loadState();
      this.renderShell();
      await this.prepareRoute();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.renderLogin();
      else this.renderFatal(error);
    }
  }

  getRoute() {
    const route = window.location.hash.replace(/^#\//, '');
    return routes.has(route) ? route : 'overview';
  }

  async navigate() {
    if (!this.state) return;
    this.stopPlayground();
    this.route = this.getRoute();
    this.renderShell();
    await this.prepareRoute();
    document.querySelector('#main')?.focus({ preventScroll: true });
  }

  renderLogin() {
    this.stopTestPolling();
    appRoot.innerHTML = loginView();
    document.querySelector('#login-form').addEventListener('submit', (event) => this.login(event));
  }

  renderFatal(error) {
    appRoot.innerHTML = `<main class="login"><section class="login-card"><div class="brand"><span class="brand-mark">太</span><span>太极 API 控制台</span></div><h1>控制台暂不可用</h1><p id="fatal-copy"></p><button id="retry" class="button button--primary button--wide button--retry">重试</button></section></main>`;
    document.querySelector('#fatal-copy').textContent = message(error);
    document.querySelector('#retry').addEventListener('click', () => this.start());
  }

  renderShell() {
    appRoot.innerHTML = shell(this.route, this.state);
    appRoot.querySelectorAll('[data-action="logout"]').forEach((button) => button.addEventListener('click', () => this.logout()));
    appRoot.querySelector('[data-action="refresh"]')?.addEventListener('click', () => this.refreshState(true));
    appRoot.querySelectorAll('[data-density]').forEach((button) => button.addEventListener('click', () => {
      document.documentElement.dataset.density = button.dataset.density;
    }));
  }

  async prepareRoute() {
    if (['overview', 'models', 'playground', 'tests', 'settings'].includes(this.route) && !this.models) await this.loadModels(false);
    if (this.route === 'tests') await this.loadTests(false);
    if (this.route === 'logs') await this.loadLogs(false);
    this.renderPage();
    if (this.route === 'tests') this.updateTestPolling();
  }

  renderPage() {
    const main = document.querySelector('#main');
    if (!main) return;
    main.innerHTML = pageView(this.route, this);
    main.querySelector('[data-action="load-models"]')?.addEventListener('click', () => this.loadModels(true));
    main.querySelector('[data-action="load-tests"]')?.addEventListener('click', () => this.loadTests(true));
    main.querySelector('[data-action="load-logs"]')?.addEventListener('click', () => this.loadLogs(true));
    main.querySelector('[data-action="stop-playground"]')?.addEventListener('click', () => this.stopPlayground());
    main.querySelector('[data-action="checkin"]')?.addEventListener('click', () => this.checkin());
    main.querySelector('[data-action="discover"]')?.addEventListener('click', () => this.discover());
    main.querySelector('#playground-form')?.addEventListener('submit', (event) => this.playground(event));
    main.querySelector('#play-model')?.addEventListener('change', () => this.syncPlayCapabilities());
    main.querySelector('#test-form')?.addEventListener('submit', (event) => this.startTest(event));
    main.querySelector('#settings-form')?.addEventListener('submit', (event) => this.saveSettings(event));
    main.querySelector('#model-search')?.addEventListener('input', event => {
      const query = event.target.value.toLowerCase().trim();
      let count = 0;
      main.querySelectorAll('[data-search]').forEach(row => { row.hidden = !row.dataset.search.includes(query); if (!row.hidden) count++; });
      main.querySelector('#model-match-count').textContent = `${count} 个匹配模型`;
    });
    if (this.route === 'playground') this.syncPlayCapabilities();
    if (this.route === 'tests') this.renderTests();
    if (this.route === 'logs') this.renderLogs();
  }

  async login(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.key;
    const error = form.querySelector('#key-error');
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    if (!input.value.trim()) return this.fieldError(input, error, '请输入管理密钥。');
    const submit = form.querySelector('button[type="submit"]');
    this.setLoading(submit, true, '正在验证');
    try {
      const result = await api.login(input.value);
      if (!result?.ok) throw new Error('管理密钥未被接受。');
      input.value = '';
      await this.loadState();
      this.route = this.getRoute();
      this.renderShell();
      await this.prepareRoute();
    } catch (failure) {
      this.fieldError(input, error, message(failure));
    } finally {
      this.setLoading(submit, false, '进入控制台');
    }
  }

  async logout() {
    this.stopPlayground();
    try { await api.logout(); } catch { /* local reset still protects this view */ }
    this.state = null;
    this.models = null;
    this.tests = [];
    this.renderLogin();
  }

  async refreshState(announce) {
    try {
      await this.loadState();
      this.patchState();
      if (this.route === 'overview') this.renderPage();
      if (announce) this.notice('已读取最新服务状态。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return this.logout();
      if (announce) this.notice(message(error), 'error');
    }
  }

  async loadState() {
    this.state = await api.get('/admin/state');
  }

  async loadModels(render) {
    try {
      this.models = await api.get('/admin/models');
      await this.loadState(); this.patchState();
      if (render && this.route === 'models') this.renderPage();
      if (render) this.notice('模型目录已更新。');
    } catch (error) {
      this.models ||= { defaultModel: this.state?.settings?.defaultModel, models: [] };
      if (render || this.route === 'models' || this.route === 'playground' || this.route === 'settings') this.notice(message(error), 'error');
    }
  }

  async loadTests(announce) {
    try {
      const response = await api.get('/admin/tests');
      this.tests = response.tests || [];
      if (this.route === 'tests') this.renderTests();
      this.updateTestPolling();
      if (announce) this.notice('测试任务已刷新。');
    } catch (error) {
      if (announce || this.route === 'tests') this.notice(message(error), 'error');
    }
  }

  async loadLogs(announce) {
    try {
      const response = await api.get('/admin/logs');
      this.logs = response.logs || [];
      if (this.route === 'logs') this.renderLogs();
      if (announce) this.notice('运行日志已刷新。');
    } catch (error) {
      if (announce || this.route === 'logs') this.notice(message(error), 'error');
    }
  }

  patchState() {
    const authenticated = Boolean(this.state?.status?.upstreamAuthenticated);
    const auth = document.querySelector('#auth-badge');
    if (auth) {
      auth.className = `status-badge ${authenticated ? '' : 'status-badge--warn'}`;
      auth.innerHTML = '<span class="status-dot"></span>';
      auth.append(authenticated ? '上游已认证' : '需要网站登录');
    }
    document.querySelectorAll('.connection').forEach((node) => {
      node.textContent = '';
      const dot = document.createElement('span'); dot.className = `connection-dot ${authenticated ? 'is-live' : ''}`;
      node.append(dot, authenticated ? '上游会话已连接' : '等待上游会话');
    });
    const overviewAuth = document.querySelector('#overview-auth');
    if (overviewAuth) {
      overviewAuth.className = `status-badge ${authenticated ? '' : 'status-badge--warn'}`;
      overviewAuth.innerHTML = '<span class="status-dot"></span>';
      overviewAuth.append(authenticated ? '已认证' : '未认证');
    }
  }

  syncPlayCapabilities() {
    const model = document.querySelector('#play-model')?.value;
    const supportsReasoning = this.supports(model, ['reasoning', 'reasoning_effort']);
    const supportsThinking = this.supports(model, ['thinking', 'reasoning']);
    const reasoning = document.querySelector('#play-reasoning');
    const thinking = document.querySelector('#play-thinking');
    if (reasoning) {
      reasoning.disabled = !supportsReasoning;
      if (!supportsReasoning) reasoning.value = '';
      reasoning.title = supportsReasoning ? '' : '该模型未声明 reasoning_effort 能力。';
    }
    if (thinking) {
      thinking.disabled = !supportsThinking;
      if (!supportsThinking) thinking.checked = false;
      thinking.title = supportsThinking ? '' : '该模型未声明 thinking 能力。';
    }
  }

  supports(modelValue, names) {
    const model = this.models?.models?.find((item) => item.value === modelValue);
    const caps = model?.attr?.capabilities || {};
    return names.some(name => name === 'thinking' ? Boolean(caps.thinking) : Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0);
  }

  async playground(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const messageInput = form.elements.message;
    const error = form.querySelector('#play-error');
    const output = document.querySelector('#play-output');
    const reasoning = document.querySelector('#play-reasoning-output');
    const reasoningPanel = document.querySelector('#play-reasoning-panel');
    const status = document.querySelector('#play-status');
    const meta = document.querySelector('#play-meta');
    error.textContent = '';
    messageInput.removeAttribute('aria-invalid');
    if (!messageInput.value.trim()) return this.fieldError(messageInput, error, '请输入一条用户消息。');
    this.playUsage = null;
    const maxTokens = form.elements.max_tokens.value.trim();
    if (maxTokens && (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1)) return this.fieldError(form.elements.max_tokens, error, '输出上限必须是正整数，或保持留空。');
    const payload = { model: form.elements.model.value, messages: [{ role: 'user', content: messageInput.value }], stream: form.elements.stream.checked };
    if (form.elements.reasoning_effort.value) payload.reasoning_effort = form.elements.reasoning_effort.value;
    if (form.elements.thinking.checked) payload.thinking = true;
    if (maxTokens) payload.max_tokens = Number(maxTokens);
    if (payload.stream) payload.stream_options = { include_usage: true };
    output.textContent = '';
    reasoning.textContent = '';
    reasoningPanel.hidden = true;
    meta.textContent = '';
    status.textContent = payload.stream ? '流式输出中' : '请求中';
    status.className = 'chip chip--running';
    this.playAbort = new AbortController();
    this.setPlayControls(true);
    const started = performance.now();
    try {
      const result = await api.playground(payload, this.playAbort.signal, (data) => this.appendStream(data, output, reasoning, reasoningPanel));
      if (!result.stream) this.appendCompletion(result.body, output, reasoning, reasoningPanel);
      if (!output.textContent) output.textContent = '上游没有返回可显示的文本内容。';
      status.textContent = '已完成'; status.className = 'chip chip--done';
      meta.textContent = `${result.stream ? '流式响应' : 'JSON 响应'} · ${(performance.now() - started).toFixed(0)} ms${this.playUsage ? ` · 输入 ${this.playUsage.prompt_tokens} / 输出 ${this.playUsage.completion_tokens} tokens（平台报告）` : ''}`;
    } catch (failure) {
      if (failure.name === 'AbortError') { status.textContent = '已停止'; status.className = 'chip'; meta.textContent = '请求已由本地停止。'; }
      else { status.textContent = '失败'; status.className = 'chip chip--failed'; error.textContent = message(failure); output.textContent += `\n请求失败：${message(failure)}`; }
    } finally {
      this.playAbort = null;
      this.setPlayControls(false);
      this.refreshState(false);
    }
  }

  appendStream(data, output, reasoning, panel) {
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || '流式上游错误');
    if (chunk.usage) this.playUsage = chunk.usage;
    {
      const choice = chunk?.choices?.[0] || {};
      const delta = choice.delta || chunk?.delta || {};
      appendText(output, delta.content ?? choice.content ?? chunk?.content);
      if (delta.tool_calls) appendText(output, (output.textContent ? "\n" : "") + `[工具调用] ${JSON.stringify(delta.tool_calls, null, 2)}`);
      const reasoningContent = delta.reasoning_content ?? choice.reasoning_content ?? chunk?.reasoning_content;
      if (reasoningContent) { appendText(reasoning, reasoningContent); panel.hidden = false; }
    }
  }

  appendCompletion(body, output, reasoning, panel) {
    this.playUsage = body.usage;
    const message = body?.choices?.[0]?.message || body?.message || {};
    appendText(output, message.content ?? body?.content);
    if (message.reasoning_content || body?.reasoning_content) { appendText(reasoning, message.reasoning_content ?? body.reasoning_content); panel.hidden = false; }
  }

  stopPlayground() { this.playAbort?.abort(); }

  setPlayControls(active) {
    const submit = document.querySelector('#play-submit');
    const stop = document.querySelector('#play-stop');
    if (submit) submit.disabled = active;
    if (stop) stop.disabled = !active;
  }

  async startTest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const steps = parseSteps(form.elements.steps.value);
    const maxRequests = Number(form.elements.maxRequests.value);
    const maxOutputTokens = Number(form.elements.maxOutputTokens.value);
    const error = form.querySelector('#test-error');
    error.textContent = '';
    if (!steps.length) return this.fieldError(form.elements.steps, error, '请输入以逗号分隔的 512–100000 字符边界。');
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 6) return this.fieldError(form.elements.maxRequests, error, '最多请求必须是 1 到 6 的整数。');
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 2048) return this.fieldError(form.elements.maxOutputTokens, error, '输出探针上限必须为 16–2048。');
    const kind = form.querySelector('input[name="kind"]:checked').value;
    const accepted = await this.confirmTest({ model: form.elements.model.value, kind, requests: maxRequests, steps, maxOutputTokens });
    if (!accepted) return;
    const submit = form.querySelector('button[type="submit"]');
    this.setLoading(submit, true, '正在创建');
    try {
      const job = await api.post('/admin/tests', { model: form.elements.model.value, kind, steps, maxRequests, maxOutputTokens });
      this.tests = [job, ...this.tests.filter((item) => item.id !== job.id)];
      this.renderTests();
      this.updateTestPolling();
      this.notice('测试任务已创建，运行期间会自动刷新。');
    } catch (failure) {
      this.fieldError(form.elements.steps, error, message(failure));
    } finally { this.setLoading(submit, false, '开始测试'); }
  }

  confirmTest(details) {
    const dialog = document.querySelector('#confirm-dialog');
    const copy = dialog.querySelector('#confirm-copy');
    const submit = dialog.querySelector('#confirm-submit');
    copy.textContent = `将向模型 ${details.model || '未选择'} 发送最多 ${details.requests} 次${kindLabel(details.kind)}请求（边界：${details.steps.join(' / ')} 字符；输出探针上限：${details.maxOutputTokens}${details.kind === 'output' ? '，并额外试验 32' : details.kind === 'tools' ? '，包含原生 tools 参数与文本 JSON 桥接检测' : ''}）。这会消耗实际上游额度。`;
    submit.className = 'button button--danger';
    submit.textContent = '确认并开始';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  renderTests() {
    const target = document.querySelector('#tests-list');
    if (!target) return;
    target.replaceChildren();
    if (!this.tests.length) return target.append(this.htmlToNode(empty('tests', '还没有测试任务', '选择模型并确认成本后，即可创建首个兼容性测试。')));
    this.tests.forEach((job) => target.append(this.testNode(job)));
  }

  testNode(job) {
    const node = document.createElement('article'); node.className = 'job';
    const top = document.createElement('div'); top.className = 'job-top';
    const summary = document.createElement('div');
    const title = document.createElement('div'); title.className = 'job-name'; title.textContent = `${kindLabel(job.kind)} · ${job.model || '未指定模型'}`;
    const meta = document.createElement('div'); meta.className = 'job-meta';
    meta.append(textSpan(`创建：${time(job.createdAt)}`), textSpan(`任务 ID：${short(job.id)}`));
    summary.append(title, meta);
    const action = document.createElement('div'); action.className = 'job-actions';
    action.append(statusChip(job.status));
    if (isActive(job)) { const cancel = document.createElement('button'); cancel.className = 'button button--secondary button--small'; cancel.textContent = '取消'; cancel.addEventListener('click', () => this.cancelTest(job.id, cancel)); action.append(cancel); }
    top.append(summary, action); node.append(top);
    if (job.conclusion) { const conclusion = document.createElement('div'); conclusion.className = 'job-conclusion'; conclusion.textContent = job.conclusion; node.append(conclusion); }
    if (job.results?.length) {
      const results = document.createElement('div'); results.className = 'result-list';
      job.results.forEach((result) => {
        const row = document.createElement('div'); row.className = 'result-row';
        row.append(textSpan(`${result.inputChars ?? 0} 字符`, true), textSpan(result.status || '未知'), textSpan(conciseOutcome(result)), textSpan(result.elapsedMs != null ? `${result.elapsedMs} ms` : '—'));
        results.append(row);
      });
      node.append(results);
    }
    return node;
  }

  async cancelTest(id, button) {
    button.disabled = true;
    try { await api.post(`/admin/tests/${encodeURIComponent(id)}/cancel`, {}); await this.loadTests(false); this.notice('已请求取消测试任务。'); }
    catch (error) { button.disabled = false; this.notice(message(error), 'error'); }
  }

  updateTestPolling() {
    const active = this.tests.some(isActive);
    if (active && !this.testPoll) this.testPoll = window.setInterval(() => this.loadTests(false).catch(() => {}), 3000);
    if (!active) this.stopTestPolling();
  }

  stopTestPolling() { if (this.testPoll) window.clearInterval(this.testPoll); this.testPoll = null; }

  renderLogs() {
    const target = document.querySelector('#logs-list');
    if (!target) return;
    target.replaceChildren();
    if (!this.logs.length) return target.append(this.htmlToNode(empty('logs', '暂无运行日志', '服务端尚未返回近期运行事件。')));
    this.logs.forEach((entry) => {
      const row = document.createElement('article'); row.className = 'log-row';
      const at = document.createElement('time'); at.className = 'log-at'; at.textContent = time(entry.at);
      const level = document.createElement('span'); const normalized = String(entry.level || 'info').toLowerCase(); level.className = `level level--${['error','warn','info','success'].includes(normalized) ? normalized : 'info'}`; level.textContent = normalized;
      const event = document.createElement('span'); event.className = 'log-event'; event.textContent = entry.event || 'event';
      const message = document.createElement('div'); message.textContent = entry.message || '—';
      const detail = conciseDetails(entry.details); if (detail) { const details = document.createElement('code'); details.className = 'log-details'; details.textContent = detail; message.append(details); }
      row.append(at, level, event, message); target.append(row);
    });
  }

  async saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('#settings-error'); error.textContent = '';
    const start = Number(form.elements.scheduleStartHour.value), end = Number(form.elements.scheduleEndHour.value);
    if (![start, end].every(Number.isInteger) || start < 0 || end > 24 || start >= end) return this.fieldError(form.elements.scheduleStartHour, error, '签到窗口需要是 0–24 之间且开始小时小于结束小时。');
    const trustedHosts = form.elements.trustedHosts.value.split(/[\n,]/).map((host) => host.trim()).filter(Boolean);
    const payload = {
      publicUrl: form.elements.publicUrl.value.trim(), fixedOrigin: form.elements.fixedOrigin.value.trim(), trustedHosts,
      account: form.elements.account.value.trim(), defaultModel: form.elements.defaultModel.value,
      requestTimeoutMs: Number(form.elements.requestTimeoutMs.value), deleteTempSessions: form.elements.deleteTempSessions.checked,
      schedule: { enabled: form.elements.scheduleEnabled.checked, startHour: start, endHour: end, timeZone: form.elements.scheduleTimeZone.value.trim() || 'Asia/Shanghai' },
    };
    if (form.elements.password.value) payload.password = form.elements.password.value;
    const submit = form.querySelector('button[type="submit"]'); this.setLoading(submit, true, '正在保存');
    try {
      await api.put('/admin/settings', payload);
      form.elements.password.value = '';
      this.models = null;
      await this.loadState(); this.patchState(); this.notice('设置已保存。密码字段已清空；留空不会覆盖现有密码。');
    } catch (requestError) { this.fieldError(form.elements.publicUrl, error, message(requestError)); }
    finally { this.setLoading(submit, false, '保存设置'); }
  }

  async discover() {
    const button = document.querySelector('[data-action="discover"]'); this.setLoading(button, true, '正在发现');
    try {
      const result = await api.post('/admin/discover', {});
      const origin = result?.origin;
      if (!origin) throw new Error('服务端没有返回候选来源。');
      this.notice(`已发现候选来源：${origin}。请先将其主机明确加入“可信主机”，再保存设置或录入凭据。`, 'info');
    } catch (error) { this.notice(message(error), 'error'); }
    finally { this.setLoading(button, false, '发现候选来源'); }
  }
  async checkin() {
    const button = document.querySelector('[data-action="checkin"]'); this.setLoading(button, true, '正在签到');
    try { const result = await api.post('/admin/checkin', {}); this.notice(result?.message || '网站签到请求已完成。'); await this.refreshState(false); }
    catch (error) { this.notice(message(error), 'error'); }
    finally { this.setLoading(button, false, '执行一次网站签到'); }
  }

  notice(content, type = 'success') {
    const node = document.querySelector('#notice');
    if (!node) return;
    node.hidden = false; node.className = `notice${type === 'error' ? ' notice--error' : type === 'info' ? ' notice--info' : ''}`;
    node.textContent = ''; node.append(this.htmlToNode(icon(type === 'error' ? 'alert' : 'check')), document.createTextNode(content));
  }

  fieldError(input, target, content) {
    input?.setAttribute('aria-invalid', 'true'); target.textContent = content; input?.focus();
  }

  setLoading(button, loading, label) {
    if (!button) return;
    button.disabled = loading; button.setAttribute('aria-busy', String(loading)); button.textContent = '';
    if (loading) { const spin = document.createElement('span'); spin.className = 'button__spin'; button.append(spin, label); }
    else button.append(label);
  }

  htmlToNode(html) { const template = document.createElement('template'); template.innerHTML = html.trim(); return template.content.firstElementChild; }
}

function appendText(node, value) { if (value !== undefined && value !== null) node.textContent += String(value); }
function message(error) { return error?.message || '请求未完成，请稍后重试。'; }
function parseSteps(value) { return [...new Set(value.split(/[，,\s]+/).filter(Boolean).map(Number).filter((step) => Number.isInteger(step) && step >= 512 && step <= 100000))]; }
function kindLabel(kind) { return ({ context: '上下文', reasoning: '推理', output: '输出', tools: '工具能力' })[kind] || '兼容性'; }
function isActive(job) { return ['queued', 'pending', 'running', 'cancelling'].includes(String(job.status).toLowerCase()); }
function short(value) { const text = String(value || '—'); return text.length > 16 ? `${text.slice(0, 16)}…` : text; }
function conciseDetails(value) { if (!value) return ''; try { return JSON.stringify(value).slice(0, 480); } catch { return String(value).slice(0, 480); } }
function conciseOutcome(result) { const flags = []; if (result.inputBytes != null) flags.push(`${result.inputBytes} B`); if (result.requestedOutputTokens != null) flags.push(`请求输出：${result.requestedOutputTokens}`); if (result.thinking !== undefined) flags.push(`thinking：${result.thinking ? 'true' : 'false'}`); if (result.reasoningEffort) flags.push(`强度：${result.reasoningEffort}`); if (result.accepted !== undefined) flags.push(`接受：${result.accepted ? '是' : '否'}`); if (result.effective !== undefined) flags.push(`生效：${result.effective ? '是' : '否'}`); if (result.matchedMarkers != null || result.markerCount != null) flags.push(`标记：${result.matchedMarkers ?? 0}/${result.markerCount ?? '—'}`); if (result.hasThinkTag !== undefined) flags.push(`think：${result.hasThinkTag ? '有' : '无'}`); if (result.hasReasoningField !== undefined) flags.push(`reasoning：${result.hasReasoningField ? '有' : '无'}`); if (result.returnedPromptTokens != null) flags.push(`返回提示：${result.returnedPromptTokens}`); if (result.returnedCompletionTokens != null) flags.push(`返回输出：${result.returnedCompletionTokens}`); if (result.nativeToolsParameterSent) flags.push(`原生 tools 已发送：是`); if (result.toolMode === 'native') flags.push(`原生 tool_calls：${result.nativeToolCallsObserved ? '观察到' : '未观察到'}`); if (result.toolMode === 'bridge') flags.push(`文本桥接 JSON：${result.bridgeToolCallsParsed ? '可解析' : '不可解析'}`); if (result.platformDeclaresTools !== undefined) flags.push(`平台声明 tools：${result.platformDeclaresTools ? '是' : '否'}`); if (result.finishReason) flags.push(`结束：${result.finishReason}`); return [result.answerPreview || result.error, flags.join(' · ')].filter(Boolean).join(' · ') || '未返回预览。'; }
function textSpan(content, strong = false) { const span = document.createElement('span'); if (strong) span.className = 'table-main'; span.textContent = content; return span; }
function statusChip(status) { const normalized = String(status || '未知').toLowerCase(); const chip = document.createElement('span'); const failed = ['failed', 'cancelled', 'error', 'interrupted'].includes(normalized); chip.className = `chip ${isActive({ status: normalized }) ? 'chip--running' : normalized === 'completed' || normalized === 'done' ? 'chip--done' : failed ? `chip--${normalized}` : ''}`; chip.textContent = ({ queued: '排队中', pending: '等待中', running: '运行中', cancelling: '正在取消', completed: '已完成', done: '已完成', failed: '失败', error: '错误', interrupted: '已中断', cancelled: '已取消' })[normalized] || status || '未知'; return chip; }

new ConsoleApp().start();
