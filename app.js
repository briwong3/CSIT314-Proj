import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const must = ({ data, error }) => { if (error) throw error; return data; };

// ---------- Entity ----------
class User { constructor(r) { Object.assign(this, r); } get isSuspended() { return this.status === 'suspended'; } }

// ---------- Control ----------
class Permissions { // access matrix: which tabs each role may open
  static #tabs = {
    customer: ['projects', 'designers'],
    designer: ['projects', 'designers'],
    platform: ['dashboard', 'categories'],
    admin: ['dashboard', 'accounts', 'profiles', 'logs']
  };
  static tabs(role) { return Permissions.#tabs[role] ?? []; }
}
class AuthController {
  async current() {
    const { data: { user } } = await db.auth.getUser(); if (!user) return null;
    return new User({ ...must(await db.from('profiles').select('*').eq('id', user.id).single()), email: user.email });
  }
  async login(email, password) {
    must(await db.auth.signInWithPassword({ email, password }));
    const u = await this.current();
    if (u.isSuspended) { await this.logout(); throw new Error('This account is suspended. Contact an administrator.'); }
    return u;
  }
  register(name, email, password, role, companyName) {
    return db.auth.signUp({ email, password, options: { data: { name, role, company_name: companyName } } }).then(r => must(r));
  }
  logout() { return db.auth.signOut(); }
  logoutLocal() { return db.auth.signOut({ scope: 'local' }); }
}
class AccountController {
  updateName(id, name) { return db.from('profiles').update({ name }).eq('id', id).then(must); }
  updateEmail(id, email) {
    return db.auth.updateUser({ email }).then(must).then(async result => {
      if (result.user?.email === email) must(await db.from('profiles').update({ email }).eq('id', id));
      return result;
    });
  }
  async changePassword(email, currentPassword, password) {
    must(await db.auth.signInWithPassword({ email, password: currentPassword }));
    return must(await db.auth.updateUser({ password }));
  }
  async deleteSelf(email, password) {
    const { error: signInError } = await db.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(signInError.message === 'Invalid login credentials' ? 'The password is incorrect.' : signInError.message);
    const { data, error } = await db.functions.invoke('admin-users', { body: { action: 'self-delete' } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  }
}
class FeedbackController {
  async list() {
    return must(await db.from('feedback').select('*').order('created_at', { ascending: false }));
  }
  updateStatus(id, status) {
    return db.from('feedback').update({
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null
    }).eq('id', id).then(must);
  }
}
class DesignerController { // "find a designer": search, filter, sort, details
  async categories() { return must(await db.from('categories').select('*').order('name')); }
  async categoryStats() {
    const [categories, projects] = await Promise.all([
      db.from('categories').select('*').order('name'),
      db.from('projects').select('category_id,views')
    ]);
    const projectRows = must(projects);
    const stats = new Map();
    for (const project of projectRows) {
      const current = stats.get(project.category_id) ?? { projects: 0, views: 0 };
      current.projects += 1;
      current.views += project.views ?? 0;
      stats.set(project.category_id, current);
    }
    return must(categories).map(category => ({
      ...category,
      projects: stats.get(category.id)?.projects ?? 0,
      views: stats.get(category.id)?.views ?? 0
    }));
  }
  createCategory(fields) {
    return db.from('categories').insert(fields).then(must);
  }
  updateCategory(id, fields) {
    return db.from('categories').update(fields).eq('id', id).then(must);
  }
  async createProject(fields, imageFile = null) {
    let imageUrl = null;
    if (imageFile) {
      const safeName = imageFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `projects/${fields.designer_id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await db.storage.from('project-images').upload(path, imageFile, {
        cacheControl: '3600',
        upsert: false,
        contentType: imageFile.type || 'application/octet-stream'
      });
      if (uploadError) throw uploadError;
      imageUrl = db.storage.from('project-images').getPublicUrl(path).data.publicUrl;
    }

    return must(await db.from('projects').insert({
      designer_id: fields.designer_id,
      title: fields.title,
      description: fields.description || null,
      category_id: fields.category_id || null,
      budget: fields.budget === '' || fields.budget == null ? null : Number(fields.budget),
      image_url: imageUrl
    }));
  }
  async designerVerificationQueue() {
    const [profiles, companies] = await Promise.all([
      db.from('profiles').select('id,name,email,created_at').eq('role', 'designer').order('created_at', { ascending: false }),
      db.from('companies').select('designer_id,name,verification_status,rejection_reason')
    ]);
    const companiesByDesigner = new Map(must(companies).map(company => [company.designer_id, company]));
    return must(profiles).map(profile => {
      const company = companiesByDesigner.get(profile.id);
      return {
        ...profile,
        company: company?.name ?? profile.name,
        verification_status: company?.verification_status ?? 'pending',
        rejection_reason: company?.rejection_reason ?? ''
      };
    });
  }
  async setDesignerVerification(designerId, status, reason = '') {
    const company = must(await db.from('companies').select('id').eq('designer_id', designerId));
    const values = { verification_status: status, rejection_reason: reason || null };
    if (company.length) {
      return must(await db.from('companies').update(values).eq('designer_id', designerId));
    }
    const profile = must(await db.from('profiles').select('name').eq('id', designerId).single());
    return must(await db.from('companies').insert({
      designer_id: designerId,
      name: profile.name,
      ...values
    }));
  }
  async search({ q, cat, min, max, sort }) {
    let r = db.from('projects').select('*, categories(name), profiles(id,name)');
    if (q) r = r.ilike('title', `%${q}%`);
    if (cat) r = r.eq('category_id', cat);
    if (min) r = r.gte('budget', min);
    if (max) r = r.lte('budget', max);
    return must(await r.order(sort === 'popular' ? 'views' : 'created_at', { ascending: false }));
  }
  async findDesigners({ q, cat, sort }) {
    const [profiles, companies, projects] = await Promise.all([
      db.from('profiles').select('id,name').eq('role', 'designer').order('name'),
      db.from('companies').select('designer_id,name,bio'),
      db.from('projects').select('designer_id,views,category_id,categories(name)')
    ]);
    const designerProfiles = must(profiles);
    const designerCompanies = must(companies);
    const designerProjects = must(projects);
    const term = q.trim().toLowerCase();
    const rows = designerProfiles.map(profile => {
      const company = designerCompanies.find(item => item.designer_id === profile.id);
      const projectsForDesigner = designerProjects.filter(item => item.designer_id === profile.id);
      const specialties = [...new Map(projectsForDesigner.filter(item => item.categories?.name)
        .map(item => [item.category_id, item.categories.name])).values()];
      return {
        ...profile,
        company,
        projects: projectsForDesigner,
        specialties,
        totalViews: projectsForDesigner.reduce((total, item) => total + (item.views ?? 0), 0)
      };
    }).filter(designer => {
      const matchesName = !term || `${designer.name} ${designer.company?.name ?? ''}`.toLowerCase().includes(term);
      const matchesCategory = !cat || designer.projects.some(project => String(project.category_id) === cat);
      return matchesName && matchesCategory;
    });
    if (sort === 'projects') rows.sort((a, b) => b.projects.length - a.projects.length);
    else if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else rows.sort((a, b) => b.totalViews - a.totalViews);
    return rows;
  }
  async project(id) {
    await db.rpc('increment_views', { pid: id });
    const p = must(await db.from('projects').select('*, categories(name), profiles(id,name)').eq('id', id).single());
    const [comments, company] = await Promise.all([
      db.from('comments').select('*').eq('project_id', id).order('created_at'),
      db.from('companies').select('name').eq('designer_id', p.designer_id).limit(1)
    ]);
    return { p, comments: must(comments), company: must(company)[0] };
  }
  async designer(id) {
    const profile = must(await db.from('profiles').select('id,name').eq('id', id).single());
    const company = (must(await db.from('companies').select('*').eq('designer_id', id)))[0];
    const projects = must(await db.from('projects').select('*, categories(name)').eq('designer_id', id).order('created_at', { ascending: false }));
    return { profile, company, projects };
  }
  addComment(project_id, body) { return db.from('comments').insert({ project_id, body }).then(must); }
}
class AdminController {
  async users({ q, role, status, from = 0, pageSize = 5 }) {
    let r = db.from('profiles').select('*', { count: 'exact' });
    const term = q.trim().replace(/[^a-zA-Z0-9 @.+-]/g, '');
    if (term) r = r.or(`name.ilike.%${term}%,email.ilike.%${term}%`);
    if (role) r = r.eq('role', role);
    if (status) r = r.eq('status', status);
    const result = await r.order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    return { rows: must(result), total: result.count ?? 0 };
  }
  update(id, fields) { return db.from('profiles').update(fields).eq('id', id).then(must); }
  async #fn(body) { const { data, error } = await db.functions.invoke('admin-users', { body }); if (error) throw error; if (data?.error) throw new Error(data.error); }
  create(f) { return this.#fn({ action: 'create', ...f }); }
  editAccount(id, fields) { return this.#fn({ action: 'edit', id, ...fields }); }
  setAccountStatus(id, status, reason = '') { return this.#fn({ action: 'status', id, status, reason }); }
  remove(id) { return this.#fn({ action: 'delete', id }); }
  resetPassword(id, password) { return this.#fn({ action: 'reset', id, password }); }
  async logs() {
    const loadAuditRows = async () => {
      const rows = [];
      let from = 0;
      while (true) {
        const result = await db.from('audit_logs').select('id,actor,action,detail,created_at')
          .order('created_at', { ascending: false }).range(from, from + 999);
        const batch = must(result);
        rows.push(...batch);
        if (batch.length < 1000) return rows;
        from += batch.length;
      }
    };
    const [rows, profiles] = await Promise.all([
      loadAuditRows(),
      db.from('profiles').select('id,name,email,role')
    ]);
    return { rows, profiles: must(profiles) };
  }
  async dashboard() {
    const [profiles, logs] = await Promise.all([
      db.from('profiles').select('id,name,email,role,status,created_at').order('created_at', { ascending: false }),
      db.from('audit_logs').select('actor,action,detail,created_at').order('created_at', { ascending: false }).limit(5)
    ]);
    return { profiles: must(profiles), logs: must(logs) };
  }
  async profileDefinitions() {
    return must(await db.from('profile_definitions').select('*').order('is_builtin', { ascending: false }).order('name'));
  }
  createProfileDefinition(definition) {
    return db.from('profile_definitions').insert(definition).then(must);
  }
  updateProfileDefinition(id, definition) {
    return db.from('profile_definitions').update(definition).eq('id', id).then(must);
  }
  async profileAccountCounts() {
    const users = must(await db.from('profiles').select('role'));
    return Object.fromEntries(['admin', 'designer', 'customer', 'platform'].map(role => [
      role, users.filter(user => user.role === role).length
    ]));
  }
  async notifications() {
    const [notices, profiles, companies] = await Promise.all([
      db.from('notifications').select('id,message,kind,created_at,read_at').order('created_at', { ascending: false }),
      db.from('profiles').select('id,name,email,role'),
      db.from('companies').select('designer_id,name')
    ]);
    const profileRows = must(profiles);
    const companyByDesigner = new Map(must(companies).map(company => [company.designer_id, company]));
    return must(notices).map(notice => {
      const message = String(notice.message ?? '');
      const emailMatch = message.match(/:\s*(.+)$/);
      const profile = emailMatch
        ? profileRows.find(item => item.email?.toLowerCase() === emailMatch[1].trim().toLowerCase())
        : null;
      return {
        ...notice,
        message,
        profile,
        company: profile ? companyByDesigner.get(profile.id) : null,
        kind: message.toLowerCase().includes('designer registered') ? 'designer_signup' : notice.kind || 'platform'
      };
    });
  }
  markNotificationRead(id) {
    return db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null).then(must);
  }
  async markAllNotificationsRead() {
    return db.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null).then(must);
  }
}
class InboxController {
  user = null;
  async conversations() {
    return must(await db.from('conversations')
      .select('id,customer_id,designer_id,project_id,created_at,customer:profiles!conversations_customer_id_fkey(id,name),designer:profiles!conversations_designer_id_fkey(id,name),project:projects(title)')
      .order('created_at', { ascending: false }));
  }
  async messages(conversationId) {
    return must(await db.from('messages').select('*').eq('conversation_id', conversationId).order('created_at'));
  }
  async recentMessages(conversationIds) {
    if (!conversationIds.length) return [];
    return must(await db.from('messages').select('id,conversation_id,sender_id,body,created_at,read_at')
      .in('conversation_id', conversationIds).order('created_at', { ascending: false }));
  }
  async unreadNotifications() {
    const conversations = await this.conversations();
    const recent = await this.recentMessages(conversations.map(conversation => conversation.id));
    const participants = new Map(conversations.map(conversation => [conversation.id,
      this.user.id === conversation.customer_id ? conversation.designer : conversation.customer]));
    return recent
      .filter(message => message.sender_id !== this.user.id && !message.read_at)
      .map(message => ({
        ...message,
        sender: participants.get(message.conversation_id)?.name ?? 'New message',
        conversation: conversations.find(item => item.id === message.conversation_id)
      }));
  }
  async startWithDesigner(designerId, projectId = null) {
    if (!this.user || this.user.role !== 'customer') throw new Error('Only customer accounts can start a conversation with a designer.');
    if (designerId === this.user.id) throw new Error('You cannot message yourself.');
    let query = db.from('conversations').select('id').eq('customer_id', this.user.id).eq('designer_id', designerId);
    query = projectId === null ? query.is('project_id', null) : query.eq('project_id', projectId);
    const existing = must(await query.maybeSingle());
    if (existing) return existing.id;
    const conversation = must(await db.from('conversations').insert({
      customer_id: this.user.id, designer_id: designerId, project_id: projectId
    }).select('id').single());
    return conversation.id;
  }
  async send(conversationId, body) {
    return must(await db.from('messages').insert({
      conversation_id: conversationId, sender_id: this.user.id, body: body.trim()
    }));
  }
  async markRead(conversationId) {
    return must(await db.rpc('mark_conversation_read', { p_conversation_id: conversationId }));
  }
}

// ---------- Boundary ----------
class App {
  auth = new AuthController(); account = new AccountController();
  designers = new DesignerController(); feedback = new FeedbackController(); admin = new AdminController(); inbox = new InboxController();
  user = null; tab = null; activeConversation = null; viewAs = null;
  $ = s => document.querySelector(s);
  $$ = s => document.querySelectorAll(s);
  labels = { dashboard: 'Dashboard', categories: 'IDP categories', accounts: 'Accounts', profiles: 'User profiles', projects: 'Browse projects', designers: 'Find a designer', favorites: 'Favourites', messages: 'Direct messages', account: 'My account', users: 'Users', logs: 'Audit log', notifications: 'Notifications' };
  get isReadOnlyPreview() { return this.user?.role === 'admin' && this.viewAs !== null; }
  get canUseDirectMessages() { return ['customer', 'designer'].includes(this.user?.role) && !this.isReadOnlyPreview; }

  async start() {
    this.user = await this.auth.current().catch(() => null);
    if (this.user?.role !== 'admin') this.viewAs = null;
    if (this.user?.isSuspended) { await this.auth.logout(); this.user = null; }
    this.shell();
    this.user ? this.open(Permissions.tabs(this.user.role)[0] ?? 'account') : this.homeView();
  }
  shell() {
    this.inbox.user = this.user;
    const tabs = this.isReadOnlyPreview
      ? ['projects', 'designers', 'favorites']
      : this.user?.role === 'admin'
      ? Permissions.tabs('admin')
      : this.user?.role === 'platform'
        ? Permissions.tabs('platform')
        : ['projects', 'designers', 'favorites'];
    const brand = this.$('header b');
    brand.setAttribute('role', 'link');
    brand.setAttribute('tabindex', '0');
    brand.setAttribute('aria-label', 'CPU homepage');
    brand.title = 'Go to homepage';
    brand.onclick = () => this.goHome();
    brand.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.goHome();
      }
    };
    this.$('header').classList.remove('auth-header');
    this.$('header').classList.toggle('landing-header', !this.user);
    this.$('header').classList.toggle('signed-in-header', Boolean(this.user));
    this.$('header').hidden = false;
    this.$('#nav').innerHTML = this.user?.role === 'platform'
      ? ''
      : this.user
        ? tabs.map(t => `<button data-t="${t}" class="${t === this.tab ? 'on' : ''}"${t === 'favorites' ? ' disabled title="Favourites page coming soon"' : ''}>${this.labels[t]}</button>`).join('')
        : '<a href="#featured">Browse projects</a><a href="#designers">Find a designer</a><span class="nav-coming-soon" aria-disabled="true" title="Favourites page coming soon">Favourites</span>';
    this.$('#nav').onclick = e => e.target.dataset.t && this.open(e.target.dataset.t);
    this.$('#who').innerHTML = this.user
      ? `<div class="notification-control"><button type="button" class="notification-bell" id="notification-bell" aria-label="Notifications" aria-expanded="false" title="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="notification-count" id="notification-count" hidden></span></button></div>${this.user.role === 'admin' ? `<label class="view-as-control"><span>View as</span><select id="view-as" aria-label="View as role"><option value="admin" ${this.viewAs === null ? 'selected' : ''}>User Admin</option><option value="customer" ${this.viewAs === 'customer' ? 'selected' : ''}>Customer</option><option value="designer" ${this.viewAs === 'designer' ? 'selected' : ''}>Interior Designer</option></select></label>` : ''}<button class="account-link" id="account-link" title="${this.isReadOnlyPreview ? 'Signed in as User Admin' : 'My account'}" ${this.isReadOnlyPreview ? 'disabled' : ''}>${esc(this.user.name)}${this.isReadOnlyPreview ? ' (User Admin)' : ''}</button><button class="logout-link" id="out">Log out</button>`
      : '<button class="btn" data-m="login">Log in</button><button class="btn" data-m="register">Sign up</button>';
    this.$('#message-fab').hidden = !this.canUseDirectMessages;
    this.$('#message-fab').onclick = () => this.user ? this.open('messages') : this.loginView('login');
    const previewBanner = this.$('#preview-banner');
    previewBanner.hidden = !this.isReadOnlyPreview;
    previewBanner.innerHTML = this.isReadOnlyPreview
      ? `<div><strong>Previewing as ${this.viewAs === 'customer' ? 'Customer' : 'Interior Designer'}.</strong> Read-only: you are still signed in as ${esc(this.user.name)} (User Admin). Posting, booking and messaging are switched off.</div><button type="button" class="btn" id="back-to-admin">Back to admin view</button>`
      : '';
    if (this.user) {
      this.$('#out').onclick = async () => { await this.auth.logout(); this.user = null; this.viewAs = null; this.start(); };
      this.$('#account-link').onclick = () => { if (!this.isReadOnlyPreview) this.open('account'); };
      this.$('#notification-bell').onclick = () => this.toggleNotifications();
      this.refreshNotificationCount();
      const viewAsSelect = this.$('#view-as');
      if (viewAsSelect) viewAsSelect.onchange = () => {
        this.viewAs = ['customer', 'designer'].includes(viewAsSelect.value) ? viewAsSelect.value : null;
        this.open(this.viewAs === 'customer' ? 'designers' : this.viewAs === 'designer' ? 'projects' : 'dashboard');
      };
      this.$('#back-to-admin')?.addEventListener('click', () => {
        this.viewAs = null;
        this.open('dashboard');
      });
    }
    else this.$('#who').onclick = e => e.target.dataset.m && this.loginView(e.target.dataset.m);
  }
  goHome() {
    if (this.isReadOnlyPreview) {
      this.open('projects');
      return;
    }
    this.shell();
    this.homeView();
  }
  async open(t, ...args) {
    if (this.isReadOnlyPreview && !['projects', 'designers'].includes(t)) return;
    if (t === 'messages' && !this.canUseDirectMessages) return;
    if (['categories', 'verification', 'feedback', 'dailyReport', 'weeklyReport', 'monthlyReport'].includes(t) && this.user?.role !== 'platform') return;
    this.tab = t;
    this.shell();
    await this[t + 'View'](...args);
  }
  async refreshNotificationCount() {
    if (!this.user) return;
    const userId = this.user.id;
    try {
      const [unread, adminNotices] = await Promise.all([
        ['admin', 'platform'].includes(this.user.role) ? Promise.resolve([]) : this.inbox.unreadNotifications(),
        ['admin', 'platform'].includes(this.user.role) ? this.admin.notifications() : Promise.resolve([])
      ]);
      const badge = this.$('#notification-count');
      if (!badge || this.user?.id !== userId) return;
      const unreadCount = unread.length + adminNotices.filter(notice => !notice.read_at).length;
      badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      badge.hidden = unreadCount === 0;
      this.$('#notification-bell').setAttribute('aria-label', unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications');
    } catch (error) {
      const bell = this.$('#notification-bell');
      if (bell) bell.title = `Could not load unread messages: ${error.message}`;
    }
  }
  async toggleNotifications() {
    const current = this.$('#notification-popover');
    if (current) {
      current.remove();
      this.$('#notification-bell').setAttribute('aria-expanded', 'false');
      return;
    }
    const popover = document.createElement('section');
    popover.id = 'notification-popover';
    popover.className = 'notification-popover';
    popover.setAttribute('aria-label', 'Notifications');
    popover.innerHTML = '<div class="notification-popover-heading"><strong>Notifications</strong><span>Loading…</span></div><div class="notification-preview-list"></div>';
    this.$('#who').querySelector('.notification-control').append(popover);
    this.$('#notification-bell').setAttribute('aria-expanded', 'true');
    try {
      const isPlatform = this.user.role === 'platform';
      const unread = ['admin', 'platform'].includes(this.user.role) ? [] : await this.inbox.unreadNotifications();
      const previewList = popover.querySelector('.notification-preview-list');
      let adminNotices = [];
      if (['admin', 'platform'].includes(this.user.role)) {
        adminNotices = await this.admin.notifications();
        const adminPreview = adminNotices.filter(notice => !notice.read_at).slice(0, 3).map(notice => {
          const title = notice.kind === 'designer_signup' ? 'Designer awaiting verification'
            : notice.kind === 'feedback' ? 'New user feedback'
              : notice.kind === 'verification_completed' ? 'Verification completed' : 'Account activity';
          const description = notice.kind === 'designer_signup'
            ? `${notice.company?.name ?? notice.profile?.name ?? 'A designer'} registered and needs verification.`
            : notice.message;
          return `
          <button type="button" class="notification-preview-item" data-admin-notification="${notice.id}" data-notice-kind="${esc(notice.kind)}">
            <strong>${title}</strong>
            <span>${esc(description)}</span><small>${new Date(notice.created_at).toLocaleString()}</small>
          </button>`;
        }).join('');
        previewList.insertAdjacentHTML('beforeend', adminPreview);
      }
      const messagePreview = unread.slice(0, 5).map(message => `
        <button type="button" class="notification-preview-item" data-open-conversation="${message.conversation_id}">
          <strong>New message</strong><span>${esc(message.sender)} sent you a message.</span><small>${new Date(message.created_at).toLocaleString()}</small>
        </button>`).join('');
      previewList.insertAdjacentHTML('afterbegin', messagePreview);
      const unreadCount = unread.length + adminNotices.filter(notice => !notice.read_at).length;
      popover.querySelector('.notification-popover-heading span').textContent = unreadCount ? `${unreadCount} new` : 'Up to date';
      if (!previewList.children.length) {
        previewList.innerHTML = '<p class="notification-empty">You have no new notifications.</p>';
      }
      popover.insertAdjacentHTML('beforeend', '<button type="button" class="notification-view-all">View all notifications →</button>');
      popover.onclick = e => {
        const conversation = e.target.closest('[data-open-conversation]');
        if (conversation) this.open('messages', Number(conversation.dataset.openConversation));
        else if (e.target.closest('[data-admin-notification]')) {
          const item = e.target.closest('[data-admin-notification]');
          if (isPlatform && item.dataset.noticeKind === 'designer_signup') this.open('verification');
          else if (isPlatform && item.dataset.noticeKind === 'feedback') this.open('feedback');
          else this.open('notifications');
        }
        else if (e.target.closest('.notification-view-all')) this.open('notifications');
      };
    } catch (error) {
      popover.querySelector('.notification-popover-heading span').textContent = 'Could not load';
      popover.querySelector('.notification-preview-list').innerHTML = `<p class="notification-empty err">${esc(error.message)}</p>`;
    }
  }
  show(html) {
    this.$('#main').innerHTML = html;
    this.$('#main').classList.toggle('home-main', Boolean(this.$('#main').querySelector('.homepage')));
    this.$('#main').classList.toggle('auth-main', Boolean(this.$('#main').querySelector('.auth-page')));
    this.$('#main').classList.toggle('messages-main', Boolean(this.$('#main').querySelector('.messages-page')));
    this.$('#main').classList.toggle('project-detail-main', Boolean(this.$('#main').querySelector('.project-detail')));
  }
  guard(fn) { return async e => { e?.preventDefault?.(); const target = e?.currentTarget; try { await fn(e); } catch (x) { const el = target?.querySelector?.('.err[role="alert"]') || this.$('#msg'); if (el) { el.className = 'err'; el.textContent = x.message; } else throw x; } }; }
  ok(m) { const el = this.$('#msg'); if (el) { el.className = ''; el.textContent = m; } }

  homeView() {
    this.show(`<div class="homepage">
      <section class="home-wrap home-hero">
        <div class="home-hero-copy">
          <p class="eyebrow">A better space starts here</p>
          <h1>Find the interior designer for your renovation</h1>
          <p>Browse real projects from interior designers, save the ones you like, and shortlist your favourites in one place.</p>
          <form class="home-search" id="home-search">
            <label>Keyword<input name="keyword" placeholder="e.g. Scandinavian, kitchen"></label>
            <label>Category<select name="category"><option value="">All categories</option><option>Living room</option><option>Kitchen</option><option>Bedroom</option><option>Bathroom</option><option>Office</option></select></label>
            <button class="btn" type="submit">Search</button>
          </form>
          <div class="popular-topics"><span>Popular:</span><button type="button" data-topic="Residential">Residential</button><button type="button" data-topic="Commercial">Commercial</button><button type="button" data-topic="Small space">Small space</button><button type="button" data-topic="Luxury">Luxury</button></div>
        </div>
        <div class="home-gallery" aria-label="Interior design project photo placeholders">
          <div class="photo-placeholder"><span>Photo placeholder</span></div><div class="photo-placeholder"><span>Photo placeholder</span></div><div class="photo-placeholder"><span>Photo placeholder</span></div>
        </div>
      </section>
      <section class="home-section"><div class="home-wrap">
        <h2>Browse by category</h2><p class="section-subtitle">Find projects that match the kind of space you’re renovating.</p>
        <div class="category-grid">
          <a class="category-card" href="#featured"><div class="photo-placeholder"><span>Photo placeholder</span></div><strong>Residential</strong></a>
          <a class="category-card" href="#featured"><div class="photo-placeholder"><span>Photo placeholder</span></div><strong>Commercial</strong></a>
          <a class="category-card" href="#featured"><div class="photo-placeholder"><span>Photo placeholder</span></div><strong>Small space</strong></a>
          <a class="category-card" href="#featured"><div class="photo-placeholder"><span>Photo placeholder</span></div><strong>Luxury</strong></a>
        </div>
      </div></section>
      <section class="home-section" id="featured"><div class="home-wrap">
        <div class="section-heading"><div><h2>Featured projects</h2><p class="section-subtitle">Recently popular with customers.</p></div><a class="text-link" href="#home-search">View all →</a></div>
        <div class="project-grid">
          <article class="project-card"><div class="photo-placeholder"><span>Photo placeholder</span></div><div class="project-info"><p class="project-tag">Residential</p><h3>Scandinavian 4-room flat</h3><p>by Oakline Studio</p><div class="project-meta"><span>1,240 views</span><button class="save-btn" type="button" data-action="save">Save</button></div></div></article>
          <article class="project-card"><div class="photo-placeholder"><span>Photo placeholder</span></div><div class="project-info"><p class="project-tag">Commercial</p><h3>Industrial loft conversion</h3><p>by Brickhaus Interiors</p><div class="project-meta"><span>760 views</span><button class="save-btn" type="button" data-action="save">Save</button></div></div></article>
          <article class="project-card"><div class="photo-placeholder"><span>Photo placeholder</span></div><div class="project-info"><p class="project-tag">Residential</p><h3>Japandi landed home</h3><p>by Kin Design</p><div class="project-meta"><span>1,510 views</span><button class="save-btn" type="button" data-action="save">Save</button></div></div></article>
          <article class="project-card"><div class="photo-placeholder"><span>Photo placeholder</span></div><div class="project-info"><p class="project-tag">Small space</p><h3>Compact studio makeover</h3><p>by Tiny Nest Studio</p><div class="project-meta"><span>640 views</span><button class="save-btn" type="button" data-action="save">Save</button></div></div></article>
        </div>
      </div></section>
      <section class="home-section" id="how"><div class="home-wrap">
        <h2>How it works</h2><p class="section-subtitle">Three simple steps from idea to shortlist.</p>
        <div class="steps-grid">
          <article class="step-card"><span class="step-number">1</span><h3>Search</h3><p>Filter projects by keyword and category to match your style.</p></article>
          <article class="step-card"><span class="step-number">2</span><h3>View</h3><p>Open a project to see its photos, details and the designer behind it.</p></article>
          <article class="step-card"><span class="step-number">3</span><h3>Save</h3><p>Add projects to your favourites and compare them later.</p></article>
        </div>
      </div></section>
      <section class="home-section" id="designers"><div class="home-wrap">
        <div class="section-heading"><div><h2>Featured interior designers</h2><p class="section-subtitle">Meet the companies behind the projects.</p></div><a class="text-link" href="#home-search">View all →</a></div>
        <div class="designer-grid">
          <article class="designer-card"><span class="designer-avatar"></span><div><h3><a href="#home-search">Oakline Studio</a></h3><p>Scandinavian · residential<br>3 projects</p></div></article>
          <article class="designer-card"><span class="designer-avatar"></span><div><h3><a href="#home-search">Brickhaus Interiors</a></h3><p>Industrial · commercial<br>4 projects</p></div></article>
          <article class="designer-card"><span class="designer-avatar"></span><div><h3><a href="#home-search">Kin Design</a></h3><p>Japandi · landed homes<br>5 projects</p></div></article>
        </div>
      </div></section>
      <section class="designer-cta"><div class="home-wrap"><div><h2>Are you an interior designer?</h2><p>Showcase your company and past projects, and see how many customers view and shortlist them.</p></div><button class="btn" type="button" data-action="designer-signup">Register as a designer</button></div></section>
      <footer class="site-footer"><span class="footer-brand">▣ CPU</span><span>About　 Contact　 Privacy</span><span>CSIT314 group project</span></footer>
    </div>`);
    this.$('#home-search').onsubmit = e => { e.preventDefault(); this.loginView('login'); };
    this.$('#main').onclick = e => {
      const mode = e.target.dataset.m;
      if (mode) { this.loginView(mode); return; }
      const action = e.target.dataset.action;
      if (action === 'save') this.loginView('login');
      if (action === 'designer-signup') {
        this.loginView('register');
        const designerRole = this.$('#f').querySelector('input[name=role][value=designer]');
        designerRole.checked = true;
        designerRole.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const topic = e.target.dataset.topic;
      if (topic) { this.$('[name=keyword]').value = topic; this.$('[name=keyword]').focus(); }
    };
  }

  loginView(mode = 'login') {
    this.$('header').classList.remove('landing-header');
    this.$('header').classList.add('auth-header');
    this.$('#nav').innerHTML = '';
    this.$('#who').innerHTML = '<a class="auth-home-link" data-home href="#">Back to homepage</a>';
    this.$('#who').onclick = e => {
      if (!e.target.closest('[data-home]')) return;
      e.preventDefault();
      this.$('header').classList.remove('auth-header');
      this.shell();
      this.homeView();
    };
    const rememberedEmail = localStorage.getItem('cpu-remembered-email') ?? '';
    const forms = {
      login: {
        title: 'Log in',
        intro: 'Welcome back. You will be taken to the page for your account type.',
        fields: `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(rememberedEmail)}" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <div class="auth-options"><label class="remember-option"><input type="checkbox" name="remember" ${rememberedEmail ? 'checked' : ''}> Remember me</label></div>`,
        button: 'Log in'
      },
      register: {
        title: 'Create your account',
        intro: '',
        fields: `<fieldset class="role-field"><legend>I am a</legend>
            <label class="role-option selected"><input type="radio" name="role" value="customer" checked><span><strong>Customer</strong><small>I want to find a designer and save projects</small></span></label>
            <label class="role-option"><input type="radio" name="role" value="designer"><span><strong>Interior Designer</strong><small>I want to showcase my company and projects</small></span></label>
          </fieldset>
          <div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" required></div>
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
          <div class="field designer-company-field" hidden><label for="company">Company name (interior designers only)</label><input id="company" name="company" autocomplete="organization"></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="6" required></div>
          <div class="field"><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required></div>
          <label class="terms-option"><input name="terms" type="checkbox"><span>I agree to the <a href="#terms" data-terms>terms</a> and <a href="#privacy" data-terms>privacy policy</a></span></label>`,
        button: 'Create account'
      }
    };
    const form = forms[mode] ?? forms.login;
    const accountLinks = mode === 'login'
      ? '<p class="auth-switch">New here? <a data-m="register">Create an account</a></p>'
      : '<p class="auth-switch">Already have an account? <a data-m="login">Log in</a></p>';
    this.show(`<section class="auth-page"><div class="auth-card ${mode === 'register' ? 'register-card' : ''}"><h2>${form.title}</h2><p class="auth-intro">${form.intro}</p>
      <div id="msg" class="auth-message" role="alert" aria-live="polite"></div>
      <form class="stack auth-form" id="f">${form.fields}<button class="btn auth-submit">${form.button}</button></form>
      ${accountLinks}${mode === 'login' ? '<p class="auth-notice">If your account is suspended, please contact the platform administrator.</p>' : '<p class="auth-notice">Admin and Platform Management accounts are created by an administrator, not through this form.</p>'}</div></section>`);
    this.bindAuthHeader();
    this.$('#main').onclick = e => {
      if (e.target.closest('[data-m]')) { this.loginView(e.target.closest('[data-m]').dataset.m); return; }
      if (e.target.closest('[data-terms]')) { e.preventDefault(); this.$('#msg').textContent = 'Please contact the platform administrator for the current terms and privacy policy.'; this.$('#msg').className = 'auth-message'; }
    };
    if (mode === 'register') {
      const roleOptions = [...this.$('#f').querySelectorAll('.role-option')];
      const companyField = this.$('.designer-company-field');
      this.$('#f').querySelectorAll('.role-option input').forEach(input => input.onchange = () => {
        roleOptions.forEach(option => option.classList.toggle('selected', option.querySelector('input').checked));
        companyField.hidden = input.value !== 'designer';
      });
    }
    this.$('#f').onsubmit = this.guard(async () => {
      const d = Object.fromEntries(new FormData(this.$('#f')));
      if (mode === 'login') {
        if (d.remember) localStorage.setItem('cpu-remembered-email', d.email);
        else localStorage.removeItem('cpu-remembered-email');
        try { this.user = await this.auth.login(d.email, d.password); }
        catch (error) {
          if (error.message === 'Invalid login credentials') throw new Error('Incorrect email or password. Check your details and try again.');
          throw error;
        }
        this.start();
      }
      else if (mode === 'register') {
        if (d.password !== d.confirmPassword) throw new Error('Passwords do not match.');
        if (!d.terms) throw new Error('Please agree to the terms and privacy policy to continue.');
        const result = await this.auth.register(d.name, d.email, d.password, d.role, d.company);
        if (result.user?.identities?.length === 0) throw new Error('This email is already registered. Log in instead.');
        this.$('#msg').className = 'auth-success';
        this.$('#msg').textContent = 'Account created. Check your email to confirm, then log in.';
      }
    });
  }

  bindAuthHeader() {
    const brand = this.$('header b');
    brand.setAttribute('role', 'link');
    brand.setAttribute('tabindex', '0');
    brand.setAttribute('aria-label', 'CPU homepage');
    brand.title = 'Go to homepage';
    brand.onclick = () => this.goHome();
    brand.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.goHome(); }
    };
    this.$('#who').innerHTML = '<a class="auth-home-link" data-home href="#">Back to homepage</a>';
    this.$('#who').onclick = e => {
      if (!e.target.closest('[data-home]')) return;
      e.preventDefault();
      this.goHome();
    };
  }

  accountView() {
    this.show(`<section class="account-page">
      <div class="account-page-heading"><h1>My account</h1><p>Manage your details and password.</p></div>
      <section class="account-card">
        <h2>Your details</h2>
        <form id="account-details-form">
          <label for="account-name">Full name</label><input id="account-name" name="name" value="${esc(this.user.name)}" autocomplete="name" required>
          <label for="account-email">Email</label><input id="account-email" name="email" type="email" value="${esc(this.user.email)}" autocomplete="email" required>
          <p class="err account-form-error" role="alert"></p>
          <p class="account-form-message" id="account-details-message" role="status"></p>
          <button class="btn" type="submit">Save changes</button>
        </form>
      </section>
      <section class="account-card">
        <h2>Change password</h2>
        <form id="account-password-form">
          <label for="account-current-password">Current password</label><input id="account-current-password" name="currentPassword" type="password" autocomplete="current-password" required>
          <label for="account-new-password">New password</label><input id="account-new-password" name="password" type="password" autocomplete="new-password" minlength="6" required>
          <label for="account-confirm-password">Confirm new password</label><input id="account-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required>
          <p class="err account-form-error" role="alert"></p>
          <p class="account-form-message" id="account-password-message" role="status"></p>
          <button class="btn" type="submit">Update password</button>
        </form>
      </section>
      ${['customer', 'designer'].includes(this.user.role) ? `<section class="account-card account-delete-card">
        <h2>Delete account</h2>
        <p>This permanently deletes your account, favourites, comments and messages. This cannot be undone.</p>
        <button class="btn danger-btn" id="show-self-delete" type="button">Delete my account</button>
      </section>
      <dialog class="account-edit-dialog account-self-delete-dialog" id="self-delete-dialog" aria-labelledby="self-delete-title">
        <form id="self-delete-form">
          <h2 id="self-delete-title">Delete your account?</h2>
          <p>This permanently deletes your account, favourites, comments and messages. This cannot be undone.</p>
          <label for="self-delete-password">Confirm your current password</label>
          <input id="self-delete-password" name="password" type="password" autocomplete="current-password" required>
          <label class="account-delete-confirm"><input name="confirm" type="checkbox" required><span>I understand this action cannot be undone.</span></label>
          <p class="err account-form-error" role="alert"></p>
          <div class="account-edit-actions">
            <button type="button" class="btn secondary-btn" id="cancel-self-delete">Cancel</button>
            <button type="submit" class="btn danger-btn" id="confirm-self-delete">Delete my account</button>
          </div>
        </form>
      </dialog>` : ''}
    </section>`);
    this.$('#account-details-form').onsubmit = this.guard(async e => {
      const form = e.currentTarget;
      const values = new FormData(form);
      const name = values.get('name').toString().trim();
      const email = values.get('email').toString().trim();
      if (!name || !email) throw new Error('Enter your name and email address.');
      await this.account.updateName(this.user.id, name);
      const emailChanged = email.toLowerCase() !== (this.user.email ?? '').toLowerCase();
      const result = emailChanged ? await this.account.updateEmail(this.user.id, email) : null;
      this.user.name = name;
      if (!result || result.user?.email === email) this.user.email = email;
      this.$('#account-details-message').textContent = emailChanged && result?.user?.email !== email
        ? 'Your name was saved. Check your new email inbox to confirm the email change.'
        : 'Your details have been saved.';
    });
    this.$('#account-password-form').onsubmit = this.guard(async e => {
      const form = e.currentTarget;
      const values = new FormData(form);
      const currentPassword = values.get('currentPassword').toString();
      const password = values.get('password').toString();
      if (password !== values.get('confirmPassword').toString()) throw new Error('New passwords do not match.');
      if (!this.user.email) throw new Error('Your account email is unavailable. Sign out and sign in again before changing your password.');
      await this.account.changePassword(this.user.email, currentPassword, password);
      form.reset();
      this.$('#account-password-message').textContent = 'Your password has been updated.';
    });
    const deleteDialog = this.$('#self-delete-dialog');
    this.$('#show-self-delete')?.addEventListener('click', () => deleteDialog.showModal());
    this.$('#cancel-self-delete')?.addEventListener('click', () => deleteDialog.close());
    deleteDialog?.addEventListener('click', e => {
      if (e.target === deleteDialog) deleteDialog.close();
    });
    this.$('#self-delete-form')?.addEventListener('submit', this.guard(async e => {
      e.preventDefault();
      const submit = this.$('#confirm-self-delete');
      submit.disabled = true;
      try {
        const password = new FormData(e.currentTarget).get('password').toString();
        await this.account.deleteSelf(this.user.email, password);
        await this.auth.logoutLocal();
        this.user = null;
        this.viewAs = null;
        this.start();
      } finally {
        submit.disabled = false;
      }
    }));
  }

  async projectsView() {
    const cats = await this.designers.categories();
    const createProjectButton = this.user?.role === 'designer'
      ? `<button class="btn secondary-btn" id="new-project" type="button">Create project</button>`
      : '';
    this.show(`<section class="project-browser"><h1>Browse projects</h1><p class="finder-intro">Explore interior projects and open one to see its details and comments.</p>
      <div class="finder-filters project-filters"><label>Keyword<input id="q" placeholder="e.g. Scandinavian, kitchen"></label><label>Category<select id="cat"><option value="">All categories</option>${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Budget<select id="budget"><option value="">Any budget</option><option value="0-10000">Under $10,000</option><option value="10000-30000">$10,000–$30,000</option><option value="30000-50000">$30,000–$50,000</option><option value="50000+">$50,000+</option></select></label><button class="btn" id="go">Search</button>${createProjectButton}</div>
      <p class="results-count" id="count"></p><div id="res" class="project-browser-grid"></div><p id="msg" class="err" role="alert"></p></section>
      <dialog class="account-edit-dialog project-dialog" id="project-dialog" aria-labelledby="project-dialog-title">
        <form id="project-form">
          <div class="account-edit-heading"><h2 id="project-dialog-title">Create a project</h2><button type="button" class="account-modal-close" id="close-project-dialog" aria-label="Close dialog">×</button></div>
          <label>Project title<input name="title" maxlength="120" required></label>
          <label>Category<select name="category_id"><option value="">Select a category</option>${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label>Budget (optional)<input name="budget" type="number" min="0" step="100" placeholder="e.g. 12000"></label>
          <label>Project image (optional)<input name="image" type="file" accept="image/*"></label>
          <label>Description<textarea name="description" rows="5" maxlength="2000" placeholder="Describe the design style, room type and key details."></textarea></label>
          <p class="err project-dialog-error" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" id="cancel-project-dialog">Cancel</button><button type="submit" class="btn">Save project</button></div>
        </form>
      </dialog>`);
    const dialog = this.$('#project-dialog');
    const form = this.$('#project-form');
    const openDialog = () => {
      form.reset();
      this.$('.project-dialog-error').textContent = '';
      dialog.showModal();
      form.elements.namedItem('title').focus();
    };
    const run = this.guard(async () => {
      const budget = this.$('#budget').value;
      const [min, max] = budget.endsWith('+') ? [budget.slice(0, -1), ''] : budget ? budget.split('-') : ['', ''];
      const rows = await this.designers.search({ q: this.$('#q').value, cat: this.$('#cat').value, min, max, sort: 'popular' });
      this.$('#count').textContent = `${rows.length} ${rows.length === 1 ? 'project' : 'projects'} found`;
      this.$('#res').innerHTML = rows.map((project, index) => {
        const cover = project.image_url
          ? `<button type="button" class="browse-project-cover" data-p="${project.id}" aria-label="View ${esc(project.title)} details" style="background-image:url('${project.image_url}'); background-size:cover; background-position:center;"><span>Project photo</span></button>`
          : `<button type="button" class="browse-project-cover cover-${index % 4}" data-p="${project.id}" aria-label="View ${esc(project.title)} details"><span>Project photo</span></button>`;
        return `<article class="browse-project-card">${cover}
        <div class="browse-project-info"><p class="project-tag">${esc(project.categories?.name ?? 'Interior design')}</p><h2><a href="#" data-p="${project.id}">${esc(project.title)}</a></h2>
          <p class="browse-project-designer">by <a href="#" data-d="${project.profiles?.id}">${esc(project.profiles?.name ?? 'Designer')}</a></p>
          <div class="browse-project-meta"><span>${Number(project.views ?? 0).toLocaleString()} views</span><span>${project.budget == null ? 'Budget on request' : `$${Number(project.budget).toLocaleString()}`}</span></div>
        </div></article>`;
      }).join('') || `<div class="project-empty-state"><h2>No projects match your search</h2><p>${this.$('#q').value || this.$('#cat').value || budget ? 'Try removing a filter or searching a different keyword.' : 'There are no projects to display yet.'}</p>${this.$('#q').value || this.$('#cat').value || budget ? '<button class="btn" type="button" id="clear-project-filters">Clear filters</button>' : ''}</div>`;
    });
    this.$('#go').onclick = run;
    this.$('#q').onkeydown = e => { if (e.key === 'Enter') run(e); };
    this.$('#new-project')?.addEventListener('click', openDialog);
    this.$('#close-project-dialog')?.addEventListener('click', () => dialog.close());
    this.$('#cancel-project-dialog')?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    form?.addEventListener('submit', this.guard(async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const title = String(data.title ?? '').trim();
      const description = String(data.description ?? '').trim();
      const categoryId = data.category_id ? Number(data.category_id) : null;
      const budget = data.budget === '' ? null : Number(data.budget);
      const imageFile = form.elements.namedItem('image').files?.[0] ?? null;
      if (!title) throw new Error('Project title is required.');
      if (budget !== null && Number.isNaN(budget)) throw new Error('Budget must be a valid number.');
      await this.designers.createProject({
        designer_id: this.user.id,
        title,
        description,
        category_id: categoryId,
        budget
      }, imageFile);
      dialog.close();
      await this.projectsView();
    }));
    this.$('#res').onclick = e => {
      if (e.target.closest('#clear-project-filters')) {
        this.$('#q').value = '';
        this.$('#cat').value = '';
        this.$('#budget').value = '';
        run();
        return;
      }
      const project = e.target.closest('[data-p]');
      const designer = e.target.closest('[data-d]');
      if (project) { e.preventDefault(); this.projectView(project.dataset.p, 'projects'); }
      else if (designer) { e.preventDefault(); this.designerView(designer.dataset.d); }
    };
    run();
  }
  async designersView() {
    const cats = await this.designers.categories();
    this.show(`<section class="finder-page"><h1>Find an interior designer</h1><p class="finder-intro">Browse designers and companies, then view their projects or send a message.</p>
      <div class="finder-filters"><label>Company name<input id="q" placeholder="e.g. Oakline Studio"></label><label>Specialty<select id="cat"><option value="">All categories</option>${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Sort by<select id="sort"><option value="popular">Most viewed</option><option value="projects">Most projects</option><option value="name">Name A–Z</option></select></label><button class="btn" id="go">Search</button></div>
      <p class="results-count" id="count"></p><div id="res" class="designer-results"></div><p id="msg" class="err" role="alert"></p></section>`);
    const run = this.guard(async () => {
      const rows = await this.designers.findDesigners({ q: this.$('#q').value, cat: this.$('#cat').value, sort: this.$('#sort').value });
      this.$('#count').textContent = `${rows.length} ${rows.length === 1 ? 'designer' : 'designers'} found`;
      this.$('#res').innerHTML = rows.map((designer, index) => `<article class="finder-designer-card">
        <div class="designer-cover cover-${index % 4}"><span>Cover placeholder</span><i aria-hidden="true"></i></div>
        <div class="finder-designer-info"><h2>${esc(designer.company?.name ?? designer.name)}</h2>
          <div class="designer-specialties">${designer.specialties.map(specialty => `<span>${esc(specialty)}</span>`).join('') || '<span>Interior design</span>'}</div>
          <p>${designer.projects.length} ${designer.projects.length === 1 ? 'project' : 'projects'} · ${designer.totalViews.toLocaleString()} total views</p>
          <div class="designer-card-actions"><button type="button" class="btn" data-d="${designer.id}">View profile</button>
            ${this.user.role === 'customer' ? `<button type="button" class="btn secondary-btn" data-message-designer="${designer.id}">Message</button>` : ''}</div>
        </div></article>`).join('') || '<p class="empty-state">No designers found. Try another company name or specialty.</p>';
    });
    this.$('#go').onclick = run;
    this.$('#q').onkeydown = e => { if (e.key === 'Enter') run(e); };
    this.$('#res').onclick = e => {
      const message = e.target.closest('[data-message-designer]');
      const profile = e.target.closest('[data-d]');
      if (message) this.startConversation(message.dataset.messageDesigner);
      else if (profile) { e.preventDefault(); this.designerView(profile.dataset.d); }
    };
    run();
  }
  async projectView(id, backView = 'projects', backId = null) {
    const { p, comments, company } = await this.designers.project(id);
    const designerName = p.profiles?.name ?? 'Interior designer';
    const companyName = company?.name ?? designerName;
    const projectCover = p.image_url
      ? `<div class="project-main-photo" style="background-image:url('${p.image_url}'); background-size:cover; background-position:center;"><span>Project photo</span></div>`
      : `<div class="project-main-photo"><span>Main photo placeholder</span></div>`;
    this.show(`<section class="project-detail">
      <nav class="project-breadcrumb" aria-label="Breadcrumb"><a href="#" id="back">Browse projects</a><span aria-hidden="true">/</span><a href="#" id="project-category">${esc(p.categories?.name ?? 'Interior design')}</a><span aria-hidden="true">/</span><span>${esc(p.title)}</span></nav>
      <div class="project-detail-layout"><div class="project-gallery">${projectCover}
        <div class="project-photo-thumbnails"><div class="cover-1"><span>Photo 2</span></div><div class="cover-2"><span>Photo 3</span></div><div class="cover-3"><span>Photo 4</span></div></div></div>
        <aside class="project-summary"><p class="project-tag">${esc(p.categories?.name ?? 'Interior design')}</p><h1>${esc(p.title)}</h1>
          <p class="project-byline">by <a href="#" id="d">${esc(companyName)}</a></p>
          <dl><div><dt>Budget</dt><dd>${p.budget == null ? 'On request' : `$${Number(p.budget).toLocaleString()}`}</dd></div>
            <div><dt>Completed</dt><dd>${p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '—'}</dd></div>
            <div><dt>Views</dt><dd>${Number(p.views ?? 0).toLocaleString()}</dd></div>
            <div><dt>Saved by</dt><dd>${Number(p.shortlists ?? 0).toLocaleString()} customers</dd></div></dl>
          ${this.user.role === 'customer' ? `<button class="btn project-message" id="message-designer" type="button">Contact designer</button>` : ''}
        </aside></div>
      <section class="project-about"><h2>About this project</h2><p>${esc(p.description || 'The designer has not added a project description yet.')}</p></section>
      ${this.user.role === 'customer' ? `<section class="project-enquiry"><h2>Send an enquiry to ${esc(companyName)}</h2><form id="enquiry-form"><label for="enquiry-message">Your message</label><textarea id="enquiry-message" required maxlength="2000" placeholder="Write here"></textarea><button class="btn" type="submit">Send message</button><p class="muted">Only you and the designer can read this message.</p><p id="enquiry-error" class="err" role="alert"></p></form></section>` : ''}
      <section class="project-comments"><h2>Comments (${comments.length})</h2>
        ${this.user.role === 'customer' ? `<form id="comment-form"><label for="comment-body">Add a comment</label><textarea id="comment-body" required maxlength="2000" placeholder="Write here"></textarea><button class="btn" type="submit">Post comment</button><p id="comment-error" class="err" role="alert"></p></form>` : '<p class="muted">Sign in as a customer to add a comment.</p>'}
        <div class="comment-list">${comments.map(comment => `<article class="project-comment"><div><strong>${esc(comment.author_name || 'Customer')}</strong><time>${comment.created_at ? new Date(comment.created_at).toLocaleDateString() : ''}</time></div><p>${esc(comment.body)}</p></article>`).join('') || '<p class="empty-state">No comments yet. Be the first to share your thoughts.</p>'}</div>
      </section></section>`);
    this.$('#back').onclick = e => { e.preventDefault(); this.open(backView, ...(backId === null ? [] : [backId])); };
    this.$('#d').onclick = e => { e.preventDefault(); this.designerView(p.profiles.id); };
    this.$('#project-category').onclick = e => { e.preventDefault(); this.open('projects'); };
    this.$('#message-designer')?.addEventListener('click', () => this.startConversation(p.profiles.id, p.id));
    this.$('#comment-form')?.addEventListener('submit', this.guard(async () => {
      const body = this.$('#comment-body').value.trim();
      if (!body) throw new Error('Please write a comment before posting.');
      await this.designers.addComment(id, body);
      await this.projectView(id, backView, backId);
    }));
    this.$('#enquiry-form')?.addEventListener('submit', this.guard(async () => {
      const body = this.$('#enquiry-message').value.trim();
      if (!body) throw new Error('Please write a message before sending.');
      const conversationId = await this.inbox.startWithDesigner(p.profiles.id, p.id);
      await this.inbox.send(conversationId, body);
      await this.open('messages', conversationId);
    }));
  }
  async designerView(id) {
    const { profile, company, projects } = await this.designers.designer(id);
    const specialties = [...new Set(projects.map(project => project.categories?.name).filter(Boolean))];
    const totalViews = projects.reduce((total, project) => total + Number(project.views ?? 0), 0);
    const companyName = company?.name ?? profile.name;
    this.show(`<section class="designer-profile">
      <p class="designer-profile-back-link"><a id="back" href="#">← Back to designers</a></p>
      <div class="designer-profile-hero">
        <div class="designer-profile-cover"><span>Cover photo placeholder</span></div>
        <div class="designer-profile-heading">
          <div class="designer-profile-avatar" aria-hidden="true">${esc(companyName.slice(0, 1).toUpperCase())}</div>
          <div class="designer-profile-identity"><h1>${esc(companyName)}</h1><p>${esc(company?.bio || 'Interior design studio')}</p></div>
          <div class="designer-profile-actions">
            ${this.user.role === 'customer' ? `<button class="btn" id="message-designer" type="button">Contact designer</button>` : ''}
            ${this.user.role === 'customer' ? `<button class="btn secondary-btn" id="book-appointment" type="button">Book an appointment</button>` : ''}
          </div>
          <div class="designer-profile-stats"><div><strong>${projects.length}</strong><span>Projects</span></div><div><strong>${totalViews.toLocaleString()}</strong><span>Total views</span></div><div class="designer-profile-specialties"><strong>${specialties.length ? esc(specialties.join(', ')) : 'Interior design'}</strong><span>Specialties</span></div></div>
        </div>
      </div>
      <div class="designer-profile-content">
        <aside class="designer-profile-sidebar">
          <section class="designer-info-card"><h2>About the company</h2><p>${esc(company?.bio || `${companyName} creates thoughtful interior spaces tailored to each client.`)}</p>
            <dl><div><dt>Designer</dt><dd>${esc(profile.name)}</dd></div><div><dt>Projects</dt><dd>${projects.length}</dd></div><div><dt>Specialties</dt><dd>${specialties.length ? esc(specialties.join(', ')) : 'Interior design'}</dd></div></dl>
          </section>
          ${specialties.length ? `<section class="designer-info-card"><h2>Services and areas of design</h2><div class="designer-service-chips">${specialties.map(specialty => `<span>${esc(specialty)}</span>`).join('')}</div></section>` : ''}
        </aside>
        <div class="designer-portfolio">
          <div class="designer-portfolio-heading"><div><h2>Projects by ${esc(companyName)}</h2><p>${projects.length} ${projects.length === 1 ? 'project' : 'projects'} · ${totalViews.toLocaleString()} total views</p></div></div>
          <div class="project-browser-grid">${projects.map((p, index) => `<article class="browse-project-card"><button type="button" class="browse-project-cover cover-${index % 4}" data-p="${p.id}" aria-label="View ${esc(p.title)} details"><span>Photo placeholder</span></button><div class="browse-project-info"><p class="project-tag">${esc(p.categories?.name ?? 'Interior design')}</p><h3><a href="#" data-p="${p.id}">${esc(p.title)}</a></h3><div class="browse-project-meta"><span>${Number(p.views ?? 0).toLocaleString()} views</span><span>${p.budget == null ? 'Budget on request' : `$${Number(p.budget).toLocaleString()}`}</span></div></div></article>`).join('') || '<p class="empty-state">This designer has not published any projects yet.</p>'}</div>
        </div>
      </div>
      <section class="designer-profile-section designer-services-section">
        <h2>Services and areas of design</h2>
        <div class="designer-service-groups">
          <div><h3>Services</h3><div class="designer-service-chips"><span>Service details available on request</span></div></div>
          <div><h3>Areas of design</h3><div class="designer-service-chips">${specialties.map(specialty => `<span>${esc(specialty)}</span>`).join('') || '<span>Ask the designer about their areas of expertise</span>'}</div></div>
        </div>
      </section>
      <section class="designer-profile-section designer-process-section">
        <h2>Our process</h2>
        <p class="designer-section-intro">A typical project journey. Confirm the scope and timing directly with the designer.</p>
        <ol class="designer-process-list">
          <li><span class="designer-process-number">1</span><h3>Initial consultation</h3><p>Discuss your space, needs, goals and budget with the designer.</p><span class="designer-process-meta">Timing agreed together</span></li>
          <li><span class="designer-process-number">2</span><h3>Concept and mood board</h3><p>Explore the design direction, colours and materials for your project.</p><span class="designer-process-meta">Scope confirmed together</span></li>
          <li><span class="designer-process-number">3</span><h3>Design and 3D layout</h3><p>Review the proposed layout and design details for your space.</p><span class="designer-process-meta">Revisions agreed together</span></li>
          <li><span class="designer-process-number">4</span><h3>Quotation and agreement</h3><p>Review the quotation, timeline and project agreement before work begins.</p><span class="designer-process-meta">Approval required</span></li>
          <li><span class="designer-process-number">5</span><h3>Renovation and handover</h3><p>Coordinate the work and review the completed space with the designer.</p><span class="designer-process-meta">Timeline varies by project</span></li>
        </ol>
      </section>
      <section class="designer-profile-section designer-testimonials-section">
        <div class="designer-testimonials-heading"><div><h2>Client testimonials</h2><p class="designer-section-intro">Feedback from clients who have worked with this designer.</p></div></div>
        <p class="designer-testimonials-empty">There are no client testimonials yet.</p>
      </section>
      ${this.user.role === 'customer' ? `<dialog class="account-edit-dialog appointment-dialog" id="appointment-dialog" aria-labelledby="appointment-title">
        <form id="appointment-form">
          <h2 id="appointment-title">Book an appointment with ${esc(companyName)}</h2>
          <div class="appointment-fields">
            <label for="appointment-date">Preferred date<input id="appointment-date" name="date" type="date" min="${(() => { const today = new Date(); return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; })()}" required></label>
            <label for="appointment-time">Preferred time<select id="appointment-time" name="time" required><option value="">Select a time</option>${['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'].map(time => `<option>${time}</option>`).join('')}</select></label>
          </div>
          <label for="appointment-project">Project you are interested in<select id="appointment-project" name="project"><option value="">Select a project</option>${projects.map(project => `<option value="${project.id}">${esc(project.title)}</option>`).join('')}</select></label>
          <label for="appointment-message">Message (optional)<textarea id="appointment-message" name="message" maxlength="2000"></textarea></label>
          <p class="appointment-note">The designer is notified and can accept or suggest another time.</p>
          <p id="appointment-error" class="err appointment-error" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" id="cancel-appointment">Cancel</button><button type="submit" class="btn" id="request-appointment">Request appointment</button></div>
        </form>
      </dialog>` : ''}
    </section>`);
    this.$('#back').onclick = e => { e.preventDefault(); this.open('designers'); };
    this.$('#message-designer')?.addEventListener('click', () => this.startConversation(profile.id));
    const appointmentDialog = this.$('#appointment-dialog');
    this.$('#book-appointment')?.addEventListener('click', () => appointmentDialog.showModal());
    this.$('#cancel-appointment')?.addEventListener('click', () => {
      appointmentDialog.close();
      this.$('#appointment-error').textContent = '';
    });
    appointmentDialog?.addEventListener('click', e => {
      if (e.target === appointmentDialog) appointmentDialog.close();
    });
    this.$('#appointment-form')?.addEventListener('submit', this.guard(async () => {
      const form = this.$('#appointment-form');
      const values = new FormData(form);
      const date = values.get('date').toString();
      const time = values.get('time').toString();
      const projectId = values.get('project').toString();
      const projectTitle = projectId ? projects.find(project => String(project.id) === projectId)?.title : '';
      const message = values.get('message').toString().trim();
      const request = [
        `Appointment request for ${companyName}`,
        `Preferred date: ${date}`,
        `Preferred time: ${time}`,
        projectTitle ? `Project: ${projectTitle}` : '',
        message ? `Message: ${message}` : ''
      ].filter(Boolean).join('\n');
      const submit = this.$('#request-appointment');
      submit.disabled = true;
      let conversationId;
      try {
        conversationId = await this.inbox.startWithDesigner(profile.id, projectId ? Number(projectId) : null);
        await this.inbox.send(conversationId, request);
      } finally {
        submit.disabled = false;
      }
      appointmentDialog.close();
      await this.open('messages', conversationId);
    }));
    this.$('#main').onclick = e => {
      const project = e.target.closest('[data-p]');
      if (project) { e.preventDefault(); this.projectView(project.dataset.p, 'designer', profile.id); }
    };
  }

  async startConversation(designerId, projectId) {
    if (!this.canUseDirectMessages || this.user.role !== 'customer') return;
    try {
      this.activeConversation = await this.inbox.startWithDesigner(designerId, projectId ? Number(projectId) : null);
      await this.open('messages', this.activeConversation);
    } catch (error) {
      const message = this.$('#msg');
      if (message) { message.className = 'err'; message.textContent = error.message; }
      else window.alert(error.message);
    }
  }

  async messagesView(conversationId = this.activeConversation) {
    if (!this.canUseDirectMessages) return;
    this.activeConversation = conversationId;
    this.show(`<section class="messages-page"><h2>Messages</h2><div class="messages-layout">
      <aside class="conversation-panel"><label class="conversation-search">Search conversations<input id="conversation-search" placeholder="Designer or project"></label><div id="conversation-list" class="conversation-list"></div></aside>
      <section id="message-thread" class="message-thread"><p id="msg" class="messages-empty">Loading conversations…</p></section>
    </div><p class="messages-privacy">Private: only you and the designer can read these messages.</p></section>`);
    let conversations;
    try {
      conversations = await this.inbox.conversations();
      const ids = conversations.map(conversation => conversation.id);
      if (!conversations.some(conversation => conversation.id === this.activeConversation)) {
        this.activeConversation = conversations[0]?.id ?? null;
      }
      let messages = [];
      const selected = conversations.find(conversation => conversation.id === this.activeConversation);
      if (selected) {
        messages = await this.inbox.messages(selected.id);
        await this.inbox.markRead(selected.id);
        this.refreshNotificationCount();
      }
      const recent = await this.inbox.recentMessages(ids);
      const latestByConversation = new Map();
      const unreadByConversation = new Map();
      for (const message of recent) {
        if (!latestByConversation.has(message.conversation_id)) latestByConversation.set(message.conversation_id, message);
        if (message.sender_id !== this.user.id && !message.read_at) {
          unreadByConversation.set(message.conversation_id, (unreadByConversation.get(message.conversation_id) ?? 0) + 1);
        }
      }
      const list = this.$('#conversation-list');
      list.innerHTML = conversations.map(conversation => {
        const counterpart = this.user.id === conversation.customer_id ? conversation.designer : conversation.customer;
        const latest = latestByConversation.get(conversation.id);
        const unread = unreadByConversation.get(conversation.id) ?? 0;
        const search = `${counterpart?.name ?? 'Conversation'} ${conversation.project?.title ?? ''} ${latest?.body ?? ''}`.toLowerCase();
        return `<button type="button" class="conversation-row ${conversation.id === this.activeConversation ? 'active' : ''}" data-conversation="${conversation.id}" data-search="${esc(search)}">
          <span class="conversation-avatar">${esc((counterpart?.name ?? '?').slice(0, 1).toUpperCase())}</span>
          <span class="conversation-preview"><strong>${esc(counterpart?.name ?? 'Conversation')}</strong><small>${esc(latest?.body ?? conversation.project?.title ?? 'No messages yet')}</small></span>
          <span class="conversation-meta">${latest ? new Date(latest.created_at).toLocaleDateString() : ''}${unread ? `<b>${unread}</b>` : ''}</span>
        </button>`;
      }).join('') || '<p class="messages-empty">Your conversations will appear here when you message a designer.</p>';
      if (!selected) {
        this.$('#message-thread').innerHTML = '<div class="thread-placeholder"><h3>Choose a conversation</h3><p>Message a designer from a project or designer profile to start a conversation.</p></div>';
      } else {
        const counterpart = this.user.id === selected.customer_id ? selected.designer : selected.customer;
        this.$('#message-thread').innerHTML = `<header class="thread-header"><div><strong>${esc(counterpart?.name ?? 'Conversation')}</strong>${selected.project?.title ? `<small>About: ${esc(selected.project.title)}</small>` : ''}</div></header>
          <div id="thread-messages" class="thread-messages">${messages.map(message => `<div class="message-row ${message.sender_id === this.user.id ? 'outgoing' : 'incoming'}"><div class="message-bubble">${esc(message.body)}</div><small>${new Date(message.created_at).toLocaleString()}${message.sender_id === this.user.id && message.read_at ? ' · Read' : ''}</small></div>`).join('') || '<p class="messages-empty">Send a message to start the conversation.</p>'}</div>
          <form id="send-message" class="send-message"><label for="message-body">Message</label><div><textarea id="message-body" name="body" placeholder="Write your message" rows="2" required></textarea><button class="btn" type="submit">Send</button></div><p id="msg" class="err"></p></form>`;
        const thread = this.$('#thread-messages');
        thread.scrollTop = thread.scrollHeight;
        this.$('#send-message').onsubmit = this.guard(async e => {
          const body = new FormData(e.currentTarget).get('body').toString().trim();
          if (!body) throw new Error('Write a message before sending.');
          await this.inbox.send(selected.id, body);
          await this.messagesView(selected.id);
          this.$('#message-body')?.focus();
        });
      }
      list.onclick = e => {
        const row = e.target.closest('[data-conversation]');
        if (row) this.messagesView(Number(row.dataset.conversation));
      };
      this.$('#conversation-search').oninput = e => {
        const query = e.target.value.trim().toLowerCase();
        list.querySelectorAll('[data-search]').forEach(row => { row.hidden = !row.dataset.search.includes(query); });
      };
    } catch (error) {
      const message = this.$('#msg');
      if (message) {
        message.className = 'err';
        message.textContent = `Could not load messages: ${error.message}. Apply the messaging SQL section in schema.sql in Supabase if the messaging tables are not set up yet.`;
      }
    }
  }

  async categoriesView() {
    const rows = await this.designers.categoryStats();
    const topCategory = [...rows].sort((a, b) => b.views - a.views)[0];
    const projectCount = rows.reduce((total, row) => total + row.projects, 0);
    this.show(`<section class="idp-shell">
      <aside class="idp-sidebar">
        <div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item active" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item" data-nav="feedback">User feedback</button>
        </div>
        <div class="idp-nav-group">
          <span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack">
            <button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button>
            <button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>
      </aside>
      <div class="idp-main">
        <div class="idp-header">
          <div>
            <h1>IDP categories</h1>
            <p>Customers use these categories to search for projects.</p>
          </div>
          <button type="button" class="idp-primary-button" id="add-category">+ Add category</button>
        </div>
        <div class="idp-metrics">
          <article class="idp-metric"><span class="idp-metric-label">Categories</span><strong>${rows.length}</strong></article>
          <article class="idp-metric"><span class="idp-metric-label">Projects categorised</span><strong>${projectCount.toLocaleString()}</strong></article>
          <article class="idp-most-viewed"><div><strong>${esc(topCategory?.name ?? '—')}</strong><span>${Number(topCategory?.views ?? 0).toLocaleString()} views</span></div><div class="meta">Most viewed</div></article>
        </div>
        <section class="idp-table-card">
          <h2>All categories</h2>
          <table class="idp-table">
            <thead><tr><th>Name</th><th>Description</th><th>Projects</th><th>Views (all time)</th><th style="width:180px;">Actions</th></tr></thead>
            <tbody>${rows.map(row => `<tr><td>${esc(row.name)}</td><td>${esc(row.description ?? '') || '—'}</td><td>${row.projects}</td><td>${Number(row.views).toLocaleString()}</td><td><div class="idp-actions"><button type="button" class="idp-action-btn" data-edit-category="${row.id}">Edit</button><button type="button" class="idp-action-btn danger">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5">No categories yet.</td></tr>'}</tbody>
          </table>
        </section>
      </div>
      <dialog class="account-edit-dialog category-dialog" id="category-dialog" aria-labelledby="category-dialog-title">
        <form id="category-form">
          <div class="account-edit-heading">
            <h2 id="category-dialog-title">Add category</h2>
            <button type="button" class="account-modal-close" id="close-category-dialog" aria-label="Close dialog">×</button>
          </div>
          <input type="hidden" name="id">
          <label>Category name<input name="name" maxlength="80" required></label>
          <label>Description (optional)<textarea name="description" rows="3" maxlength="500"></textarea></label>
          <p class="category-modal-note" id="category-modal-note"></p>
          <p class="err category-modal-error" role="alert"></p>
          <div class="account-edit-actions">
            <button type="button" class="btn secondary-btn" id="cancel-category-dialog">Cancel</button>
            <button type="submit" class="btn" id="save-category">Save changes</button>
          </div>
        </form>
      </dialog>
    </section>`);
    this.bindPlatformNavigation();
    const dialog = this.$('#category-dialog');
    const form = this.$('#category-form');
    const openDialog = category => {
      form.reset();
      form.elements.namedItem('id').value = category?.id ?? '';
      form.elements.namedItem('name').value = category?.name ?? '';
      form.elements.namedItem('description').value = category?.description ?? '';
      this.$('#category-dialog-title').textContent = category ? 'Edit category' : 'Add category';
      this.$('#save-category').textContent = category ? 'Save changes' : 'Add category';
      this.$('#category-modal-note').textContent = category
        ? `Renaming updates this category on all ${category.projects} projects.`
        : 'This category will be available when customers search for projects.';
      dialog.showModal();
      form.elements.namedItem('name').focus();
    };
    this.$('#add-category').onclick = () => openDialog(null);
    this.$('#close-category-dialog').onclick = () => dialog.close();
    this.$('#cancel-category-dialog').onclick = () => dialog.close();
    this.$('.idp-table').onclick = e => {
      const edit = e.target.closest('[data-edit-category]');
      if (edit) openDialog(rows.find(row => String(row.id) === edit.dataset.editCategory));
    };
    dialog.onclick = e => {
      if (e.target === dialog) dialog.close();
    };
    form.onsubmit = this.guard(async () => {
      const id = form.elements.namedItem('id').value;
      const fields = {
        name: form.elements.namedItem('name').value.trim(),
        description: form.elements.namedItem('description').value.trim() || null
      };
      if (!fields.name) throw new Error('Enter a category name.');
      if (id) await this.designers.updateCategory(id, fields);
      else await this.designers.createCategory(fields);
      dialog.close();
      await this.categoriesView();
    });
  }

  async verificationView() {
    let designers;
    try {
      designers = await this.designers.designerVerificationQueue();
    } catch (error) {
      this.show(`<section class="idp-shell">
        <aside class="idp-sidebar"><div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item active" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item" data-nav="feedback">User feedback</button>
        </div><div class="idp-nav-group"><span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack"><button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button><button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button><button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button></div>
        </div></aside>
        <div class="idp-main"><div class="idp-header"><div><h1>Designer verification</h1><p>Confirm that interior designers are legitimate before their projects appear on the platform.</p></div></div>
          <p class="err" role="alert">Could not load designer verification: ${esc(error.message)}. Apply the designer verification SQL updates in schema.sql.</p>
        </div></section>`);
      this.bindPlatformNavigation();
      return;
    }

    this.show(`<section class="idp-shell">
      <aside class="idp-sidebar">
        <div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item active" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item" data-nav="feedback">User feedback</button>
        </div>
        <div class="idp-nav-group"><span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack">
            <button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button>
            <button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>
      </aside>
      <div class="idp-main verification-page">
        <div class="idp-header">
          <div><h1>Designer verification</h1><p>Confirm that interior designers are legitimate before their projects appear on the platform.</p></div>
        </div>
        <div class="verification-tabs" id="verification-tabs" role="tablist" aria-label="Verification status">
          <button type="button" class="verification-tab active" data-filter="pending">Pending (${designers.filter(item => item.verification_status === 'pending').length})</button>
          <button type="button" class="verification-tab" data-filter="verified">Verified</button>
          <button type="button" class="verification-tab" data-filter="rejected">Rejected</button>
        </div>
        <p class="err verification-error" id="verification-error" role="alert"></p>
        <div class="verification-table-wrap">
          <table class="verification-table">
            <thead><tr><th>Company</th><th>Email</th><th>Registered</th><th>Documents</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody id="verification-rows"></tbody>
          </table>
        </div>
        <p class="verification-footnote">Approving a designer marks their profile as verified. Rejection reasons are saved for reference.</p>
      </div>
      <dialog class="account-edit-dialog verification-dialog" id="verification-dialog" aria-labelledby="verification-dialog-title">
        <form id="verification-form">
          <div class="account-edit-heading"><h2 id="verification-dialog-title"></h2><button type="button" class="account-modal-close" id="verification-close" aria-label="Close dialog">×</button></div>
          <div id="verification-detail"></div>
          <label id="rejection-reason-field" hidden>Reason for rejection<textarea name="reason" rows="3" maxlength="500" required></textarea></label>
          <p class="err verification-dialog-error" role="alert"></p>
          <div class="account-edit-actions">
            <button type="button" class="btn secondary-btn" id="verification-cancel">Cancel</button>
            <button type="submit" class="btn" id="verification-submit">Save</button>
          </div>
        </form>
      </dialog>
    </section>`);
    this.bindPlatformNavigation();

    let activeFilter = 'pending';
    let currentDesigner = null;
    let dialogAction = 'review';
    const body = this.$('#verification-rows');
    const renderRows = () => {
      const visible = designers.filter(item => item.verification_status === activeFilter);
      body.innerHTML = visible.map(item => {
        const status = item.verification_status;
        const actionButtons = status === 'pending'
          ? `<button type="button" class="verification-action approve" data-action="approve" data-id="${esc(item.id)}">Approve</button><button type="button" class="verification-action" data-action="reject" data-id="${esc(item.id)}">Reject</button>`
          : `<button type="button" class="verification-action" data-action="review" data-id="${esc(item.id)}">Review</button>`;
        return `<tr>
          <td><strong>${esc(item.company)}</strong></td>
          <td>${esc(item.email ?? '—')}</td>
          <td>${item.created_at ? new Date(item.created_at).toLocaleDateString() : '—'}</td>
          <td><button type="button" class="verification-doc-link" data-action="documents" data-id="${esc(item.id)}">View documents</button></td>
          <td><span class="verification-status ${status}">${status[0].toUpperCase() + status.slice(1)}</span></td>
          <td><div class="verification-actions">${actionButtons}</div></td>
        </tr>`;
      }).join('') || `<tr><td class="verification-empty" colspan="6">No ${activeFilter} designer applications.</td></tr>`;
    };
    const setTabCounts = () => {
      this.$('[data-filter="pending"]').textContent = `Pending (${designers.filter(item => item.verification_status === 'pending').length})`;
      this.$('[data-filter="verified"]').textContent = `Verified (${designers.filter(item => item.verification_status === 'verified').length})`;
      this.$('[data-filter="rejected"]').textContent = `Rejected (${designers.filter(item => item.verification_status === 'rejected').length})`;
    };
    const openReview = (designer, action) => {
      currentDesigner = designer;
      dialogAction = action;
      const isRejecting = action === 'reject';
      this.$('#verification-dialog-title').textContent = action === 'documents'
        ? 'Verification documents'
        : isRejecting ? 'Reject designer' : 'Designer details';
      this.$('#verification-detail').innerHTML = `<dl class="verification-details">
        <div><dt>Company</dt><dd>${esc(designer.company)}</dd></div>
        <div><dt>Designer</dt><dd>${esc(designer.name)}</dd></div>
        <div><dt>Email</dt><dd>${esc(designer.email ?? '—')}</dd></div>
        <div><dt>Registered</dt><dd>${designer.created_at ? new Date(designer.created_at).toLocaleString() : '—'}</dd></div>
        ${designer.rejection_reason ? `<div><dt>Rejection reason</dt><dd>${esc(designer.rejection_reason)}</dd></div>` : ''}
        ${action === 'documents' ? '<p class="verification-no-documents">No verification documents have been uploaded.</p>' : ''}
      </dl>`;
      this.$('#rejection-reason-field').hidden = !isRejecting;
      this.$('#verification-form').elements.namedItem('reason').value = '';
      this.$('#verification-submit').hidden = action === 'review' || action === 'documents';
      this.$('#verification-submit').textContent = isRejecting ? 'Reject application' : 'Approve designer';
      this.$('.verification-dialog-error').textContent = '';
      dialog.showModal();
    };

    this.$('#verification-tabs').onclick = e => {
      const tab = e.target.closest('[data-filter]');
      if (!tab) return;
      activeFilter = tab.dataset.filter;
      this.$$('#verification-tabs .verification-tab').forEach(button => button.classList.toggle('active', button === tab));
      renderRows();
    };
    body.onclick = e => {
      const button = e.target.closest('[data-action]');
      if (!button) return;
      const designer = designers.find(item => item.id === button.dataset.id);
      if (!designer) return;
      if (button.dataset.action === 'approve') {
        this.designers.setDesignerVerification(designer.id, 'verified').then(() => {
          designer.verification_status = 'verified';
          designer.rejection_reason = '';
          setTabCounts();
          renderRows();
        }).catch(error => { this.$('#verification-error').textContent = `Could not approve designer: ${error.message}`; });
      } else {
        openReview(designer, button.dataset.action);
      }
    };
    this.$('#verification-close').onclick = () => this.$('#verification-dialog').close();
    this.$('#verification-cancel').onclick = () => this.$('#verification-dialog').close();
    this.$('#verification-dialog').onclick = e => {
      if (e.target === this.$('#verification-dialog')) this.$('#verification-dialog').close();
    };
    this.$('#verification-form').onsubmit = this.guard(async e => {
      e.preventDefault();
      if (dialogAction === 'review' || dialogAction === 'documents') return;
      const reason = this.$('#verification-form').elements.namedItem('reason').value.trim();
      if (dialogAction === 'reject' && !reason) throw new Error('Provide a reason for rejection.');
      const status = dialogAction === 'reject' ? 'rejected' : 'verified';
      await this.designers.setDesignerVerification(currentDesigner.id, status, reason);
      currentDesigner.verification_status = status;
      currentDesigner.rejection_reason = reason;
      this.$('#verification-dialog').close();
      setTabCounts();
      renderRows();
    });
    setTabCounts();
    renderRows();
  }

  bindPlatformNavigation() {
    const shell = this.$('.idp-shell');
    shell.onclick = e => {
      const trigger = e.target.closest('[data-nav]');
      if (!trigger) return;
      const target = trigger.dataset.nav;
      if (['dashboard', 'categories', 'verification', 'feedback', 'dailyReport', 'weeklyReport', 'monthlyReport'].includes(target)) this.open(target);
    };
  }

  async feedbackView() {
    let rows;
    try {
      rows = await this.feedback.list();
    } catch (error) {
      this.show(`<section class="idp-shell">
        <aside class="idp-sidebar"><div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item active" data-nav="feedback">User feedback</button>
        </div><div class="idp-nav-group"><span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack"><button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button><button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button><button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button></div>
        </div></aside>
        <div class="idp-main"><div class="idp-header"><div><h1>User feedback</h1><p>Feedback from customers and designers, to help you improve the platform.</p></div></div>
          <p class="err" role="alert">Could not load feedback: ${esc(error.message)}. Apply the feedback SQL updates in schema.sql.</p>
        </div></section>`);
      this.bindPlatformNavigation();
      return;
    }

    this.show(`<section class="idp-shell">
      <aside class="idp-sidebar">
        <div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item active" data-nav="feedback">User feedback</button>
        </div>
        <div class="idp-nav-group"><span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack">
            <button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button>
            <button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>
      </aside>
      <div class="idp-main feedback-page">
        <div class="idp-header"><div>
          <h1>User feedback</h1>
          <p>Feedback from customers and designers, to help you improve the platform.</p>
        </div></div>
        <div class="feedback-stat-grid">
          <article class="feedback-stat"><span>Open</span><strong id="feedback-open-count"></strong></article>
          <article class="feedback-stat"><span>In review</span><strong id="feedback-review-count"></strong></article>
          <article class="feedback-stat"><span>Resolved</span><strong id="feedback-resolved-count"></strong></article>
        </div>
        <section class="feedback-panel">
          <div class="feedback-filters">
            <label>Status<select id="feedback-status"><option value="">All</option><option value="open">Open</option><option value="in_review">In review</option><option value="resolved">Resolved</option></select></label>
            <label>Type<select id="feedback-type"><option value="">All types</option><option value="suggestion">Suggestion</option><option value="bug">Bug</option><option value="complaint">Complaint</option><option value="other">Other</option></select></label>
            <label>From<select id="feedback-from"><option value="">Everyone</option><option value="customer">Customer</option><option value="designer">Interior Designer</option></select></label>
          </div>
          <div class="feedback-table-wrap">
            <table class="feedback-table">
              <thead><tr><th>Date</th><th>From</th><th>Type</th><th>Message</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody id="feedback-rows"></tbody>
            </table>
          </div>
          <p class="err feedback-error" id="feedback-error" role="alert"></p>
        </section>
      </div>
      <dialog class="account-edit-dialog feedback-dialog" id="feedback-dialog" aria-labelledby="feedback-dialog-title">
        <div class="feedback-dialog-content">
          <div class="account-edit-heading"><h2 id="feedback-dialog-title">Feedback</h2><button type="button" class="account-modal-close" id="feedback-close" aria-label="Close dialog">×</button></div>
          <dl class="verification-details" id="feedback-details"></dl>
          <p class="feedback-full-message" id="feedback-full-message"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" id="feedback-done">Close</button></div>
        </div>
      </dialog>
    </section>`);
    this.bindPlatformNavigation();

    const showCount = (selector, status) => {
      this.$(selector).textContent = rows.filter(row => row.status === status).length.toLocaleString();
    };
    showCount('#feedback-open-count', 'open');
    showCount('#feedback-review-count', 'in_review');
    showCount('#feedback-resolved-count', 'resolved');

    const renderRows = () => {
      const status = this.$('#feedback-status').value;
      const type = this.$('#feedback-type').value;
      const from = this.$('#feedback-from').value;
      const visible = rows.filter(row =>
        (!status || row.status === status) &&
        (!type || row.feedback_type === type) &&
        (!from || row.submitted_by_role === from)
      );
      this.$('#feedback-rows').innerHTML = visible.map(row => {
        const label = { customer: 'Customer', designer: 'Interior Designer' }[row.submitted_by_role] ?? 'Unknown';
        const state = { open: 'Open', in_review: 'In review', resolved: 'Resolved' }[row.status] ?? 'Unknown';
        const typeLabel = row.feedback_type ? row.feedback_type[0].toUpperCase() + row.feedback_type.slice(1) : 'Other';
        const statusActions = row.status === 'open'
          ? `<button type="button" class="feedback-action" data-feedback-action="status" data-status="in_review" data-id="${row.id}">Start review</button><button type="button" class="feedback-action" data-feedback-action="status" data-status="resolved" data-id="${row.id}">Mark resolved</button>`
          : row.status === 'in_review'
            ? `<button type="button" class="feedback-action" data-feedback-action="status" data-status="resolved" data-id="${row.id}">Mark resolved</button>`
            : row.status === 'resolved'
              ? `<button type="button" class="feedback-action" data-feedback-action="status" data-status="open" data-id="${row.id}">Reopen</button>`
              : '';
        return `<tr>
          <td><strong>${new Date(row.created_at).toLocaleDateString()}</strong></td>
          <td>${label}</td>
          <td>${esc(typeLabel)}</td>
          <td class="feedback-preview">${esc(row.message)}</td>
          <td><span class="feedback-status ${esc(row.status)}">${state}</span></td>
          <td><div class="feedback-actions">
            <button type="button" class="feedback-action" data-feedback-action="view" data-id="${row.id}">View</button>
            ${statusActions}
          </div></td>
        </tr>`;
      }).join('') || `<tr><td class="feedback-empty" colspan="6">${rows.length ? 'No feedback matches these filters.' : 'No feedback has been submitted yet.'}</td></tr>`;
    };
    ['#feedback-status', '#feedback-type', '#feedback-from'].forEach(selector => {
      this.$(selector).onchange = renderRows;
    });
    this.$('#feedback-rows').onclick = async e => {
      const button = e.target.closest('[data-feedback-action]');
      if (!button) return;
      const row = rows.find(item => String(item.id) === button.dataset.id);
      if (!row) return;
      if (button.dataset.feedbackAction === 'view') {
        const role = row.submitted_by_role === 'designer' ? 'Interior Designer' : 'Customer';
        this.$('#feedback-details').innerHTML = `<div><dt>From</dt><dd>${role}</dd></div>
          <div><dt>Type</dt><dd>${esc(row.feedback_type)}</dd></div>
          <div><dt>Date</dt><dd>${new Date(row.created_at).toLocaleString()}</dd></div>
          <div><dt>Status</dt><dd>${esc(row.status.replace('_', ' '))}</dd></div>`;
        this.$('#feedback-full-message').textContent = row.message;
        this.$('#feedback-dialog').showModal();
        return;
      }
      if (button.dataset.feedbackAction !== 'status') return;
      const nextStatus = button.dataset.status;
      if (!['open', 'in_review', 'resolved'].includes(nextStatus)) return;
      button.disabled = true;
      this.$('#feedback-error').textContent = '';
      try {
        await this.feedback.updateStatus(row.id, nextStatus);
        row.status = nextStatus;
        showCount('#feedback-open-count', 'open');
        showCount('#feedback-review-count', 'in_review');
        showCount('#feedback-resolved-count', 'resolved');
        renderRows();
      } catch (error) {
        button.disabled = false;
        this.$('#feedback-error').textContent = `Could not update feedback status: ${error.message}`;
      }
    };
    const dialog = this.$('#feedback-dialog');
    this.$('#feedback-close').onclick = () => dialog.close();
    this.$('#feedback-done').onclick = () => dialog.close();
    dialog.onclick = e => { if (e.target === dialog) dialog.close(); };
    renderRows();
  }

  dailyReportView() { return this.reportView('daily'); }
  weeklyReportView() { return this.reportView('weekly'); }
  monthlyReportView() { return this.reportView('monthly'); }

  reportView(period) {
    const reports = {
      daily: {
        title: 'Daily report', dateLabel: 'Date', inputType: 'date',
        metrics: [{ label: 'New IDPs', value: 5, delta: '+1 vs yesterday' }, { label: 'Total views', value: 125, delta: '+8% vs yesterday' }, { label: 'Total shortlists', value: 28, delta: '+3 vs yesterday' }],
        chartTitle: 'Views by time of day',
        chart: [{ label: '00–04', value: 8 }, { label: '04–08', value: 5 }, { label: '08–12', value: 22 }, { label: '12–16', value: 38 }, { label: '16–20', value: 31 }, { label: '20–24', value: 21 }],
        categories: [{ name: 'Residential', views: 58, share: 46, shortlists: 14, newIds: 3 }, { name: 'Commercial', views: 31, share: 25, shortlists: 7, newIds: 1 }, { name: 'Small space', views: 22, share: 18, shortlists: 5, newIds: 1 }, { name: 'Luxury', views: 14, share: 11, shortlists: 2, newIds: 0 }],
        projects: [{ title: 'Japandi landed home', company: 'Kiln Design', views: 21, shortlists: 5 }, { title: 'Scandinavian 4-room flat', company: 'Oakline Studio', views: 17, shortlists: 4 }, { title: 'Warm minimalist condo', company: 'Mira & Co', views: 12, shortlists: 3 }]
      },
      weekly: {
        title: 'Weekly report', dateLabel: 'Week starting', inputType: 'date',
        metrics: [{ label: 'New IDPs', value: 67, delta: '+9 vs last week' }, { label: 'Total views', value: 991, delta: '+5% vs last week' }, { label: 'Total shortlists', value: 213, delta: '+12 vs last week' }],
        chartTitle: 'Views per day',
        chart: [{ label: 'Mon', value: 120 }, { label: 'Tue', value: 135 }, { label: 'Wed', value: 150 }, { label: 'Thu', value: 140 }, { label: 'Fri', value: 160 }, { label: 'Sat', value: 155 }, { label: 'Sun', value: 131 }],
        categories: [{ name: 'Residential', views: 412, share: 42, shortlists: 97, newIds: 28 }, { name: 'Commercial', views: 268, share: 27, shortlists: 53, newIds: 14 }, { name: 'Small space', views: 190, share: 19, shortlists: 41, newIds: 19 }, { name: 'Luxury', views: 121, share: 12, shortlists: 22, newIds: 6 }],
        projects: [{ title: 'Japandi landed home', company: 'Kiln Design', views: 112, shortlists: 26 }, { title: 'Scandinavian 4-room flat', company: 'Oakline Studio', views: 98, shortlists: 22 }, { title: 'Warm minimalist condo', company: 'Mira & Co', views: 85, shortlists: 19 }]
      },
      monthly: {
        title: 'Monthly report', dateLabel: 'Month', inputType: 'month',
        metrics: [{ label: 'New IDPs', value: 265, delta: '+31 vs last month' }, { label: 'Total views', value: 4280, delta: '+11% vs last month' }, { label: 'Total shortlists', value: 906, delta: '+74 vs last month' }],
        chartTitle: 'Views per week',
        chart: [{ label: 'Week 1', value: 980 }, { label: 'Week 2', value: 1090 }, { label: 'Week 3', value: 1150 }, { label: 'Week 4', value: 1060 }],
        categories: [{ name: 'Residential', views: 1780, share: 42, shortlists: 410, newIds: 112 }, { name: 'Commercial', views: 1150, share: 27, shortlists: 226, newIds: 58 }, { name: 'Small space', views: 820, share: 19, shortlists: 174, newIds: 71 }, { name: 'Luxury', views: 530, share: 12, shortlists: 96, newIds: 24 }],
        projects: [{ title: 'Japandi landed home', company: 'Kiln Design', views: 480, shortlists: 104 }, { title: 'Scandinavian 4-room flat', company: 'Oakline Studio', views: 410, shortlists: 92 }, { title: 'Warm minimalist condo', company: 'Mira & Co', views: 365, shortlists: 81 }]
      }
    };
    const report = reports[period];
    const now = new Date();
    const toDateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const initialDate = period === 'monthly' ? toDateValue(now).slice(0, 7) : toDateValue(now);
    this.show(`<section class="idp-shell">
      <aside class="idp-sidebar">
        <div class="idp-nav-stack">
          <button type="button" class="idp-nav-item" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item" data-nav="feedback">User feedback</button>
        </div>
        <div class="idp-nav-group"><span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack">
            <button type="button" class="idp-nav-item ${period === 'daily' ? 'active' : ''}" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-nav-item ${period === 'weekly' ? 'active' : ''}" data-nav="weeklyReport">Weekly report</button>
            <button type="button" class="idp-nav-item ${period === 'monthly' ? 'active' : ''}" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>
      </aside>
      <div class="idp-main report-page">
        <div class="report-heading"><h1>${report.title}</h1><p>Customer interest and new projects across the platform for the selected ${period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month'}.</p></div>
        <div class="report-datebar">
          <div class="report-date-controls"><label for="report-date">${report.dateLabel}</label>
            <div class="report-date-inputs"><button type="button" class="report-outline-button" id="report-previous">‹ Previous</button><input id="report-date" type="${report.inputType}" value="${initialDate}"><button type="button" class="report-outline-button" id="report-next">Next ›</button></div>
          </div>
          <button type="button" class="report-outline-button" id="report-export">Export CSV</button>
        </div>
        <div class="report-stat-grid">${report.metrics.map((metric, i) => `<article class="report-stat"><span>${metric.label}</span><strong>${metric.value.toLocaleString()}</strong><small>${metric.delta}</small></article>`).join('')}</div>
        <section class="report-panel">
          <h2>${report.chartTitle}</h2>
          <div class="report-chart">${report.chart.map(item => `<div class="report-bar-wrap"><strong>${item.value.toLocaleString()}</strong><div class="report-bar" style="height:${Math.max(14, item.value / Math.max(...report.chart.map(point => point.value)) * 118)}px"></div><span>${item.label}</span></div>`).join('')}</div>
        </section>
        <section class="report-panel">
          <h2>By category</h2>
          <div class="report-table-wrap"><table class="report-table">
            <thead><tr><th>Category</th><th>Views</th><th>Share of views</th><th>Shortlists</th><th>New IDPs</th></tr></thead>
            <tbody>${report.categories.map(category => `<tr><td><strong>${category.name}</strong></td><td>${category.views.toLocaleString()}</td><td><div class="report-share"><span><i style="width:${category.share}%"></i></span>${category.share}%</div></td><td>${category.shortlists.toLocaleString()}</td><td>${category.newIds.toLocaleString()}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>
        <section class="report-panel">
          <h2>Top projects</h2>
          <div class="report-table-wrap"><table class="report-table">
            <thead><tr><th>Project</th><th>Company</th><th>Views</th><th>Shortlists</th></tr></thead>
            <tbody>${report.projects.map(project => `<tr><td><strong>${project.title}</strong></td><td>${project.company}</td><td>${project.views.toLocaleString()}</td><td>${project.shortlists.toLocaleString()}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>
        <p class="report-note">Sample figures. Calculated from project views, favourites and new projects. Change vs ${period === 'daily' ? 'yesterday' : period === 'weekly' ? 'last week' : 'last month'} is shown on each card.</p>
      </div>
    </section>`);
    this.bindPlatformNavigation();

    const dateInput = this.$('#report-date');
    const stepDate = direction => {
      const date = period === 'monthly'
        ? new Date(`${dateInput.value}-01T12:00:00`)
        : new Date(`${dateInput.value}T12:00:00`);
      if (period === 'daily') date.setDate(date.getDate() + direction);
      else if (period === 'weekly') date.setDate(date.getDate() + direction * 7);
      else date.setMonth(date.getMonth() + direction);
      dateInput.value = period === 'monthly' ? toDateValue(date).slice(0, 7) : toDateValue(date);
    };
    this.$('#report-previous').onclick = () => stepDate(-1);
    this.$('#report-next').onclick = () => stepDate(1);
    this.$('#report-export').onclick = () => {
      const csvRows = [
        ['Report', report.title],
        [report.dateLabel, dateInput.value],
        [],
        ['Metric', 'Value', 'Change'],
        ...report.metrics.map(metric => [metric.label, metric.value, metric.delta]),
        [],
        ['Category', 'Views', 'Share of views', 'Shortlists', 'New IDPs'],
        ...report.categories.map(category => [category.name, category.views, `${category.share}%`, category.shortlists, category.newIds]),
        [],
        ['Project', 'Company', 'Views', 'Shortlists'],
        ...report.projects.map(project => [project.title, project.company, project.views, project.shortlists])
      ];
      const csv = csvRows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${period}-report-${dateInput.value}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    };
  }

  async dashboardView() {
    if (this.user?.role === 'admin' && !this.isReadOnlyPreview) return this.dashboardView_old();

    const statData = [
      { label: 'New IDs today', value: 5, delta: '+1 vs yesterday' },
      { label: 'Views today', value: 125, delta: '+8% vs yesterday' },
      { label: 'Shortlists today', value: 28, delta: '+3 vs yesterday' },
      { label: 'Categories', value: 4, delta: '340 projects' }
    ];
    const weekly = [120, 135, 150, 140, 160, 155, 131];
    const categories = [
      { name: 'Residential', count: 412 },
      { name: 'Commercial', count: 268 },
      { name: 'Small space', count: 190 },
      { name: 'Luxury', count: 121 }
    ];
    const projects = [
      { title: 'Japandi landed home', company: 'Kiln Design', views: 112, shortlists: 26 },
      { title: 'Scandinavian 4-room flat', company: 'Oakline Studio', views: 98, shortlists: 22 },
      { title: 'Warm minimalist condo', company: 'Mira & Co', views: 85, shortlists: 19 }
    ];
    this.show(`<section class="idp-shell">
      <aside class="idp-sidebar">
        <div class="idp-nav-stack">
          <button type="button" class="idp-nav-item active" data-nav="dashboard">Dashboard</button>
          <button type="button" class="idp-nav-item" data-nav="categories">IDP categories</button>
          <button type="button" class="idp-nav-item" data-nav="verification">Designer verification</button>
          <button type="button" class="idp-nav-item" data-nav="feedback">User feedback</button>
        </div>
        <div class="idp-nav-group">
          <span class="idp-nav-group-title">Reports</span>
          <div class="idp-nav-stack">
            <button type="button" class="idp-nav-item" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-nav-item" data-nav="weeklyReport">Weekly report</button>
            <button type="button" class="idp-nav-item" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>
      </aside>
      <div class="idp-main">
        <div class="idp-header">
          <div>
            <h1>Dashboard</h1>
            <p>Platform activity at a glance · <span>today's date</span></p>
          </div>
          <div class="idp-header-actions">
            <button type="button" class="idp-primary-button" data-nav="categories">+ Add category</button>
            <button type="button" class="idp-secondary-button" data-nav="dailyReport">Daily report</button>
            <button type="button" class="idp-secondary-button" data-nav="monthlyReport">Monthly report</button>
          </div>
        </div>

        <div class="idp-metrics">
          ${statData.map((stat, index) => `<article class="idp-metric" ${index === 3 ? 'style="display:flex;align-items:center;justify-content:center;"' : ''}>
            <span class="idp-metric-label">${stat.label}</span>
            <strong>${stat.value}</strong>
            <small>${stat.delta}</small>
          </article>`).join('')}
        </div>

        <div class="idp-content-grid">
          <section class="idp-panel idp-graph-panel">
            <h2>Views, last 7 days</h2>
            <div class="idp-chart" aria-label="Weekly views chart">
              ${weekly.map((value, i) => `<div class="idp-bar-wrap"><div class="idp-bar" style="height:${value}px"></div><span>${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i]}</span></div>`).join('')}
            </div>
            <button type="button" class="idp-link-button" data-nav="weeklyReport">View weekly report</button>
          </section>

          <aside class="idp-panel idp-side-panel">
            <h2>Top categories this week</h2>
            <div class="idp-category-list">
              ${categories.map(category => `<div class="idp-category-row"><span>${category.name}</span><div class="idp-category-track"><i></i></div><strong>${category.count}</strong></div>`).join('')}
            </div>
            <button type="button" class="idp-manage-button" data-nav="categories">Manage categories</button>
          </aside>
        </div>

        <section class="idp-panel idp-table-panel">
          <h2>Top projects this week</h2>
          <table class="idp-project-table">
            <thead>
              <tr><th>Project</th><th>Company</th><th>Views</th><th>Shortlists</th></tr>
            </thead>
            <tbody>
              ${projects.map(project => `<tr><td>${project.title}</td><td>${project.company}</td><td>${project.views}</td><td>${project.shortlists}</td></tr>`).join('')}
            </tbody>
          </table>
        </section>

        <div class="idp-note">Sample figures that match the weekly report.</div>
        <div class="idp-alert-card">
          <div class="idp-alert-head">
            <strong>Designer awaiting verification</strong>
            <button type="button" aria-label="Close notification">×</button>
          </div>
          <p>[Company name] registered and needs verification.</p>
          <button type="button" class="idp-alert-link" data-nav="verification">Review designer →</button>
        </div>
      </div>
    </section>`);

    this.bindPlatformNavigation();

    const fab = this.$('#message-fab');
    if (fab) {
      fab.onclick = () => this.user ? this.open('messages') : this.loginView('login');
    }
  }

  async dashboardView_old() {
    this.show(`<section class="admin-dashboard">
      <div class="admin-dashboard-heading"><div><h1>Dashboard</h1><p>Accounts and profiles at a glance · <span id="dashboard-date"></span></p></div>
        <div class="admin-dashboard-actions"><button class="btn" data-admin-view="accounts">+ Create account</button><button class="btn secondary-btn" data-admin-view="profiles">+ New profile</button><button class="btn secondary-btn" data-admin-view="logs">Audit log</button></div>
      </div><p id="dashboard-error" class="err" role="alert"></p>
      <div class="admin-stat-grid" id="admin-stats"></div>
      <div class="admin-dashboard-middle">
        <section class="admin-panel"><h2>Accounts by profile</h2><div id="admin-role-breakdown"></div><button type="button" class="btn secondary-btn" data-admin-view="profiles">Manage profiles</button></section>
        <section class="admin-panel"><h2>Recent sign-ups</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Name</th><th>Profile</th><th>Joined</th></tr></thead><tbody id="admin-recent-signups"></tbody></table></div><button type="button" class="btn secondary-btn" data-admin-view="profiles">View all accounts</button></section>
      </div>
      <section class="admin-panel admin-activity-panel"><h2>Recent admin activity</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>When</th><th>Done by</th><th>Action</th><th>Target</th></tr></thead><tbody id="admin-recent-activity"></tbody></table></div></section>
    </section>`);
    this.$('#dashboard-date').textContent = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    this.$('.admin-dashboard').onclick = e => {
      const button = e.target.closest('[data-admin-view]');
      if (button) this.open(button.dataset.adminView);
    };
    try {
      const { profiles, logs } = await this.admin.dashboard();
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const counts = Object.fromEntries(['customer', 'designer', 'platform', 'admin'].map(role => [
        role, profiles.filter(profile => profile.role === role).length
      ]));
      const recent = profiles.slice(0, 4);
      const profileLabels = { customer: 'Customer', designer: 'Interior Designer', platform: 'Platform Management', admin: 'User Admin' };
      this.$('#admin-stats').innerHTML = `
        <article class="admin-stat-card"><span>Total users</span><strong>${profiles.length.toLocaleString()}</strong></article>
        <article class="admin-stat-card"><span>New this week</span><strong>${profiles.filter(profile => new Date(profile.created_at).getTime() >= weekAgo).length.toLocaleString()}</strong><small>Last 7 days</small></article>
        <article class="admin-stat-card"><span>Suspended accounts</span><strong>${profiles.filter(profile => profile.status === 'suspended').length.toLocaleString()}</strong><small>Review in User profiles</small></article>
        <article class="admin-stat-card"><span>Profiles</span><strong>4</strong><small>All built-in</small></article>`;
      const maxCount = Math.max(...Object.values(counts), 1);
      this.$('#admin-role-breakdown').innerHTML = Object.entries(profileLabels).map(([role, label]) => `
        <div class="admin-role-row"><strong>${label}</strong><span class="admin-role-track"><i style="width:${Math.max(counts[role] / maxCount * 100, counts[role] ? 2 : 0)}%"></i></span><span>${counts[role].toLocaleString()}</span></div>`).join('');
      this.$('#admin-recent-signups').innerHTML = recent.map(profile => `<tr><td><strong>${esc(profile.name)}</strong></td><td>${profileLabels[profile.role] ?? esc(profile.role)}</td><td>${new Date(profile.created_at).toLocaleDateString()}</td></tr>`).join('') || '<tr><td colspan="3">No accounts yet.</td></tr>';
      const profileById = new Map(profiles.map(profile => [profile.id, profile]));
      const actionLabels = { REGISTER: 'Created account', CREATE_USER: 'Created account', UPDATE_USER: 'Edited profile', SUSPEND_USER: 'Suspended account', REACTIVATE_USER: 'Reactivated account', DELETE_USER: 'Deleted account', CREATE_PROFILE: 'Created profile' };
      this.$('#admin-recent-activity').innerHTML = logs.map(log => {
        const target = log.detail?.split(':')[0] || log.detail || '—';
        return `<tr><td>${new Date(log.created_at).toLocaleString()}</td><td>${esc(profileById.get(log.actor)?.name ?? (log.actor === this.user.id ? this.user.name : 'System'))}</td><td>${esc(actionLabels[log.action] ?? log.action)}</td><td>${esc(target)}</td></tr>`;
      }).join('') || '<tr><td colspan="4">No admin activity recorded yet.</td></tr>';
    } catch (error) {
      this.$('#dashboard-error').textContent = `Could not load dashboard: ${error.message}`;
    }
  }
  async accountsView() {
    const pageSize = 5;
    let page = 0;
    const profileLabels = { customer: 'Customer', designer: 'Interior Designer', platform: 'Platform Management', admin: 'User Admin' };
    this.show(`<section class="admin-content accounts-page">
      <div class="accounts-heading"><div><h1>User accounts</h1><p>Create, edit, suspend and delete accounts for all four profiles.</p></div><button class="btn" id="show-create-account">+ Create account</button></div>
      <p id="msg" class="err" role="alert"></p>
      <div class="accounts-filter-bar">
        <label>Search<input id="accounts-search" placeholder="Name or email"></label>
        <label>Profile<select id="accounts-role"><option value="">All profiles</option><option value="customer">Customer</option><option value="designer">Interior Designer</option><option value="platform">Platform Management</option><option value="admin">User Admin</option></select></label>
        <label>Status<select id="accounts-status"><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
      </div>
      <div class="accounts-table-wrap"><table class="accounts-table"><thead><tr><th>Name</th><th>Email</th><th>Profile</th><th>Status</th><th>Actions</th></tr></thead><tbody id="accounts-rows"></tbody></table></div>
      <div class="accounts-pagination"><span id="accounts-range"></span><div><button class="btn secondary-btn" id="accounts-prev">Previous</button><button class="btn secondary-btn" id="accounts-next">Next</button></div></div>
      <dialog class="account-edit-dialog" id="create-account-dialog" aria-labelledby="create-account-title">
        <form id="create-account-form"><div class="account-edit-heading"><h2 id="create-account-title">Create account</h2><button type="button" class="account-modal-close" data-close-dialog="create-account-dialog" aria-label="Close">×</button></div>
          <label>Full name<input name="name" required maxlength="120"></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Profile<select name="role" required><option value="" selected disabled>Select a profile</option><option value="customer">Customer</option><option value="designer">Interior Designer</option><option value="platform">Platform Management</option><option value="admin">User Admin</option></select></label>
          <label class="account-checkbox"><input name="invite" type="checkbox" checked><span>Send an email invite to set a password</span></label>
          <label id="new-account-password-label" hidden>Temporary password<input name="password" type="password" minlength="6" autocomplete="new-password"></label>
          <label class="account-checkbox"><input name="active" type="checkbox" checked><span>Account active</span></label>
          <p class="account-edit-error err" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" data-close-dialog="create-account-dialog">Cancel</button><button type="submit" class="btn">Create account</button></div>
        </form>
      </dialog>
      <dialog class="account-edit-dialog" id="edit-account-dialog" aria-labelledby="edit-account-title">
        <form id="edit-account-form"><div class="account-edit-heading"><h2 id="edit-account-title">Edit account</h2><button type="button" class="account-modal-close" id="close-edit-account" aria-label="Close">×</button></div>
          <input type="hidden" name="id">
          <label>Full name<input name="name" required maxlength="120"></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Profile<select name="role"><option value="customer">Customer</option><option value="designer">Interior Designer</option><option value="platform">Platform Management</option><option value="admin">User Admin</option></select></label>
          <label>Status<select name="status"><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
          <p class="account-edit-error err" id="edit-account-error" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" id="cancel-edit-account">Cancel</button><button type="submit" class="btn">Save changes</button></div>
        </form>
      </dialog>
      <dialog class="account-edit-dialog account-confirm-dialog" id="suspend-account-dialog" aria-labelledby="suspend-account-title">
        <form id="suspend-account-form"><div class="account-edit-heading"><h2 id="suspend-account-title">Suspend account</h2><button type="button" class="account-modal-close" data-close-dialog="suspend-account-dialog" aria-label="Close">×</button></div>
          <p class="account-confirm-copy" id="suspend-account-copy"></p>
          <label>Reason (saved in the audit log)<textarea name="reason" rows="3" maxlength="500"></textarea></label>
          <p class="account-edit-error err" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" data-close-dialog="suspend-account-dialog">Cancel</button><button type="submit" class="btn danger-btn">Suspend account</button></div>
        </form>
      </dialog>
      <dialog class="account-edit-dialog account-confirm-dialog" id="delete-account-dialog" aria-labelledby="delete-account-title">
        <form id="delete-account-form"><div class="account-edit-heading"><h2 id="delete-account-title">Delete account</h2><button type="button" class="account-modal-close" data-close-dialog="delete-account-dialog" aria-label="Close">×</button></div>
          <p class="account-confirm-copy" id="delete-account-copy"></p>
          <label>Type the account name to confirm<input name="confirmName" required autocomplete="off"></label>
          <p class="account-edit-error err" role="alert"></p>
          <div class="account-edit-actions account-delete-actions"><button type="button" class="btn secondary-btn" data-close-dialog="delete-account-dialog">Cancel</button><button type="button" class="btn secondary-btn" id="suspend-instead">Suspend instead</button><button type="submit" class="btn danger-btn">Delete account</button></div>
        </form>
      </dialog>
    </section>`);
    const createDialog = this.$('#create-account-dialog');
    const createForm = this.$('#create-account-form');
    const editDialog = this.$('#edit-account-dialog');
    const editForm = this.$('#edit-account-form');
    const suspendDialog = this.$('#suspend-account-dialog');
    const suspendForm = this.$('#suspend-account-form');
    const deleteDialog = this.$('#delete-account-dialog');
    const deleteForm = this.$('#delete-account-form');
    let selectedAccount = null;
    const render = async () => {
      const { rows, total } = await this.admin.users({
        q: this.$('#accounts-search').value,
        role: this.$('#accounts-role').value,
        status: this.$('#accounts-status').value,
        from: page * pageSize,
        pageSize
      });
      if (rows.length === 0 && page > 0) {
        page -= 1;
        return render();
      }
      this.$('#accounts-rows').innerHTML = rows.map(user => `<tr>
        <td><strong>${esc(user.name)}</strong></td><td>${esc(user.email || '—')}</td><td>${profileLabels[user.role] ?? esc(user.role)}</td>
        <td><span class="account-status ${user.status === 'suspended' ? 'suspended' : 'active'}">${user.status === 'suspended' ? 'Suspended' : 'Active'}</span></td>
        <td><div class="account-row-actions"><button class="btn secondary-btn" data-a="edit" data-id="${user.id}" data-n="${esc(user.name)}" data-email="${esc(user.email)}" data-role="${esc(user.role)}" data-s="${esc(user.status)}">Edit</button>
          <button class="btn secondary-btn" data-a="sus" data-id="${user.id}" data-s="${user.status}">${user.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
          <button class="btn secondary-btn" data-a="del" data-id="${user.id}" data-n="${esc(user.name)}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="accounts-empty">No accounts match your filters.</td></tr>';
      const start = total ? page * pageSize + 1 : 0;
      const end = Math.min((page + 1) * pageSize, total);
      this.$('#accounts-range').textContent = `Showing ${start}–${end} of ${total}`;
      this.$('#accounts-prev').disabled = page === 0;
      this.$('#accounts-next').disabled = end >= total;
    };
    const run = this.guard(async () => { page = 0; await render(); });
    this.$('#accounts-search').oninput = run;
    this.$('#accounts-role').onchange = run;
    this.$('#accounts-status').onchange = run;
    this.$('#accounts-prev').onclick = this.guard(async () => { if (page > 0) page -= 1; await render(); });
    this.$('#accounts-next').onclick = this.guard(async () => { page += 1; await render(); });
    this.$('#show-create-account').onclick = () => createDialog.showModal();
    createForm.elements.invite.onchange = () => {
      const passwordLabel = this.$('#new-account-password-label');
      passwordLabel.hidden = createForm.elements.invite.checked;
      createForm.elements.password.required = !createForm.elements.invite.checked;
    };
    createForm.onsubmit = this.guard(async () => {
      const fields = Object.fromEntries(new FormData(createForm));
      const submit = createForm.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await this.admin.create({
          name: fields.name.trim(),
          email: fields.email.trim(),
          role: fields.role,
          invite: createForm.elements.invite.checked,
          password: fields.password,
          status: createForm.elements.active.checked ? 'active' : 'suspended'
        });
      } finally {
        submit.disabled = false;
      }
      createForm.reset();
      createForm.elements.invite.onchange();
      createDialog.close();
      await render();
      this.ok('Account created successfully.');
    });
    const closeDialog = dialog => {
      dialog.close();
      dialog.querySelector('.account-edit-error').textContent = '';
    };
    this.$$('.account-modal-close,[data-close-dialog]').forEach(button => {
      button.onclick = () => closeDialog(this.$(`#${button.dataset.closeDialog ?? button.closest('dialog').id}`));
    });
    createDialog.addEventListener('close', () => {
      createForm.reset();
      createForm.elements.invite.onchange();
    });
    [createDialog, editDialog, suspendDialog, deleteDialog].forEach(dialog => {
      dialog.onclick = e => { if (e.target === dialog) closeDialog(dialog); };
    });
    const closeEditDialog = () => closeDialog(editDialog);
    editForm.onsubmit = this.guard(async e => {
      const fields = Object.fromEntries(new FormData(e.currentTarget));
      const saveButton = editForm.querySelector('[type="submit"]');
      saveButton.disabled = true;
      try {
        await this.admin.editAccount(fields.id, {
          name: fields.name.trim(),
          email: fields.email.trim(),
          role: fields.role,
          status: fields.status
        });
        closeEditDialog();
        await render();
      } finally {
        saveButton.disabled = false;
      }
    });
    this.$('#accounts-rows').onclick = this.guard(async e => {
      const actionButton = e.target.closest('[data-a]');
      const { a, id, n, email, role, s } = actionButton?.dataset ?? {};
      if (!a) return;
      if (a === 'edit') {
        editForm.elements.id.value = id;
        editForm.elements.name.value = n;
        editForm.elements.email.value = email;
        editForm.elements.role.value = role;
        editForm.elements.status.value = s;
        editDialog.showModal();
        return;
      }
      selectedAccount = { id, name: n };
      if (a === 'sus' && s === 'active') {
        this.$('#suspend-account-title').textContent = `Suspend “${n}”?`;
        this.$('#suspend-account-copy').textContent = 'They will not be able to log in. Their favourites, comments and messages are kept, and you can reactivate the account later.';
        suspendForm.elements.reason.value = '';
        suspendDialog.showModal();
        return;
      }
      if (a === 'sus') {
        await this.admin.setAccountStatus(id, 'active');
        await render();
        return;
      }
      if (a === 'del') {
        this.$('#delete-account-title').textContent = `Delete “${n}”?`;
        this.$('#delete-account-copy').textContent = 'This permanently deletes the account and its favourites, comments and messages. This cannot be undone. To block access but keep the data, suspend the account instead.';
        deleteForm.elements.confirmName.value = '';
        this.$('#suspend-instead').hidden = s === 'suspended';
        deleteDialog.showModal();
      }
    });
    suspendForm.onsubmit = this.guard(async e => {
      const submit = suspendForm.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await this.admin.setAccountStatus(selectedAccount.id, 'suspended', suspendForm.elements.reason.value.trim());
        closeDialog(suspendDialog);
        await render();
      } finally {
        submit.disabled = false;
      }
    });
    deleteForm.onsubmit = this.guard(async e => {
      if (deleteForm.elements.confirmName.value.trim() !== selectedAccount.name) {
        throw new Error('Enter the account name exactly as shown to confirm deletion.');
      }
      await this.admin.remove(selectedAccount.id);
      closeDialog(deleteDialog);
      await render();
    });
    this.$('#suspend-instead').onclick = this.guard(async () => {
      await this.admin.setAccountStatus(selectedAccount.id, 'suspended', 'Suspended instead of deleting the account.');
      closeDialog(deleteDialog);
      await render();
    });
    await this.guard(render)();
  }
  async usersView() {
    this.show(`<section class="admin-content"><h1>User profiles</h1><div class="bar"><input id="q" placeholder="Search by name"><select id="role"><option value="">All roles</option><option>admin</option><option>designer</option><option>customer</option><option>platform</option></select><button class="btn" id="go">Search</button></div><p id="msg"></p><div id="res"></div></section>`);
    const run = this.guard(async () => {
      const { rows } = await this.admin.users({ q: this.$('#q').value, role: this.$('#role').value, pageSize: 1000 });
      this.$('#res').innerHTML = `<table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${rows.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.status}</td><td>
        <button class="btn" data-a="edit" data-id="${u.id}" data-n="${esc(u.name)}">Edit</button><button class="btn" data-a="sus" data-id="${u.id}" data-s="${u.status}">${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="btn" data-a="pw" data-id="${u.id}">Reset password</button><button class="btn danger" data-a="del" data-id="${u.id}">Delete</button></td></tr>`).join('')}</table>`;
    });
    this.$('#go').onclick = run; run();
    this.$('#res').onclick = this.guard(async e => {
      const { a, id, n, s } = e.target.dataset; if (!a) return;
      if (a === 'edit') { const name = prompt('New name', n); if (name) await this.admin.update(id, { name }); }
      if (a === 'sus') await this.admin.update(id, { status: s === 'active' ? 'suspended' : 'active' });
      if (a === 'pw') { const pw = prompt('New password (min 6)'); if (pw) await this.admin.resetPassword(id, pw); }
      if (a === 'del' && confirm('Delete this user permanently?')) await this.admin.remove(id);
      run();
    });
  }
  async profilesView() {
    const permissions = [
      ['manage_accounts', 'Manage accounts'],
      ['manage_profiles', 'Manage profiles'],
      ['manage_company', 'Manage company info'],
      ['manage_portfolio', 'Manage portfolio'],
      ['search_favorites', 'Search projects and save favourites'],
      ['view_insights', 'View interest insights'],
      ['manage_categories', 'Manage categories'],
      ['view_reports', 'View reports'],
      ['view_audit_log', 'View audit log'],
      ['send_messages', 'Send messages'],
      ['comment_projects', 'Comment']
    ];
    const permissionLabels = new Map(permissions);
    const presets = [
      { role_key: 'admin', name: 'User Admin', description: 'Manages accounts and profiles', permissions: ['manage_accounts', 'manage_profiles', 'view_audit_log'] },
      { role_key: 'designer', name: 'Interior Designer', description: 'Showcases a company and its projects', permissions: ['manage_company', 'manage_portfolio', 'view_insights', 'send_messages'] },
      { role_key: 'customer', name: 'Customer', description: 'Finds and saves projects', permissions: ['search_favorites', 'comment_projects', 'send_messages'] },
      { role_key: 'platform', name: 'Platform Management', description: 'Maintains categories and reports', permissions: ['manage_categories', 'view_reports'] }
    ];
    this.show(`<section class="admin-content profile-definitions-page">
      <div class="accounts-heading"><div><h1>User profiles</h1><p>A profile describes a group of accounts and its permission definition.</p></div><button class="btn" id="new-profile">+ New profile</button></div>
      <p class="profile-definitions-note">Custom profiles are definitions only and cannot be assigned to accounts. Account access continues to use the four built-in profiles.</p>
      <p id="msg" class="err" role="alert"></p>
      <div class="profile-definitions-table-wrap"><table class="profile-definitions-table"><thead><tr><th>Profile</th><th>Permissions</th><th>Users</th><th>Type</th><th>Actions</th></tr></thead><tbody id="profile-definitions-rows"></tbody></table></div>
      <dialog class="account-edit-dialog profile-edit-dialog" id="profile-definition-dialog" aria-labelledby="profile-dialog-title">
        <form id="profile-definition-form"><div class="account-edit-heading"><h2 id="profile-dialog-title">New profile</h2><button type="button" class="account-modal-close" id="close-profile-dialog" aria-label="Close">×</button></div>
          <input type="hidden" name="id"><label>Profile name<input name="name" maxlength="80" placeholder="e.g. Content moderator" required></label>
          <label>Description<textarea name="description" rows="2" maxlength="240" required></textarea></label>
          <fieldset class="profile-permission-list"><legend>Permissions</legend>${permissions.map(([key, label]) => `<label class="profile-permission-option"><input type="checkbox" name="permissions" value="${key}"><span>${label}</span></label>`).join('')}</fieldset>
          <p class="profile-definition-footnote" id="profile-definition-footnote" hidden></p><p class="account-edit-error err" role="alert"></p>
          <div class="account-edit-actions"><button type="button" class="btn secondary-btn" id="cancel-profile-dialog">Cancel</button><button type="submit" class="btn">Create profile</button></div>
        </form>
      </dialog>
    </section>`);
    const dialog = this.$('#profile-definition-dialog');
    const form = this.$('#profile-definition-form');
    let profileCounts = {};
    const render = async () => {
      const [definitions, counts] = await Promise.all([
        this.admin.profileDefinitions(),
        this.admin.profileAccountCounts()
      ]);
      profileCounts = counts;
      const rows = new Map(definitions.map(definition => [definition.role_key, definition]));
      const merged = [
        ...presets.map(preset => ({ ...preset, ...rows.get(preset.role_key), role_key: preset.role_key, is_builtin: true })),
        ...definitions.filter(definition => !definition.role_key)
      ];
      this.$('#profile-definitions-rows').innerHTML = merged.map(profile => {
        const labels = (profile.permissions ?? []).map(key => permissionLabels.get(key)).filter(Boolean);
        const count = profile.role_key ? counts[profile.role_key] ?? 0 : 0;
        return `<tr><td><strong>${esc(profile.name)}</strong><small>${esc(profile.description)}</small></td>
          <td><div class="profile-permission-chips">${labels.map(label => `<span>${esc(label)}</span>`).join('') || '<span class="muted">No permissions selected</span>'}</div></td>
          <td>${count.toLocaleString()}</td><td><span class="account-status">${profile.is_builtin ? 'Built-in' : 'Custom'}</span></td>
          <td><button class="btn secondary-btn" data-edit-profile="${esc(profile.id ?? '')}" data-role-key="${esc(profile.role_key ?? '')}">Edit</button></td></tr>`;
      }).join('');
    };
    const closeDialog = () => {
      dialog.close();
      form.querySelector('.account-edit-error').textContent = '';
    };
    this.$('#new-profile').onclick = () => {
      form.reset();
      form.elements.id.value = '';
      form.elements.name.disabled = false;
      this.$('#profile-dialog-title').textContent = 'New profile';
      this.$('#profile-definition-footnote').hidden = true;
      form.querySelector('[type="submit"]').textContent = 'Create profile';
      dialog.showModal();
    };
    this.$('#close-profile-dialog').onclick = closeDialog;
    this.$('#cancel-profile-dialog').onclick = closeDialog;
    dialog.onclick = e => { if (e.target === dialog) closeDialog(); };
    this.$('#profile-definitions-rows').onclick = async e => {
      const button = e.target.closest('[data-edit-profile]');
      if (!button) return;
      try {
        const definitions = await this.admin.profileDefinitions();
        const profile = definitions.find(item => String(item.id) === button.dataset.editProfile)
          ?? presets.find(item => item.role_key === button.dataset.roleKey);
        if (!profile) throw new Error('Profile definition not found.');
        form.reset();
        form.elements.id.value = profile.id ?? '';
        form.elements.name.value = profile.name;
        form.elements.name.disabled = false;
        form.elements.description.value = profile.description;
        form.querySelectorAll('[name="permissions"]').forEach(input => {
          input.checked = profile.permissions.includes(input.value);
        });
        this.$('#profile-dialog-title').textContent = 'Edit profile';
        const footnote = this.$('#profile-definition-footnote');
        footnote.textContent = `Built-in profile · applies to ${profileCounts[profile.role_key] ?? 0} account(s).`;
        footnote.hidden = !profile.role_key;
        form.querySelector('[type="submit"]').textContent = 'Save changes';
        dialog.showModal();
      } catch (error) {
        this.$('#msg').textContent = `Could not open profile: ${error.message}`;
      }
    };
    form.onsubmit = this.guard(async e => {
      const values = new FormData(e.currentTarget);
      const name = form.elements.name.value.trim();
      const description = form.elements.description.value.trim();
      const selectedPermissions = values.getAll('permissions');
      if (!selectedPermissions.length) throw new Error('Select at least one permission.');
      const id = values.get('id');
      const payload = { name, description, permissions: selectedPermissions };
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        if (id) await this.admin.updateProfileDefinition(id, payload);
        else await this.admin.createProfileDefinition({ ...payload, role_key: null, is_builtin: false });
        closeDialog();
        await render();
      } finally {
        submit.disabled = false;
      }
    });
    await this.guard(render)();
  }
  async logsView() {
    const pageSize = 7;
    let page = 0;
    this.show(`<section class="admin-content audit-page">
      <div class="audit-heading"><div><h1>Audit log</h1><p>A record of changes made to accounts and profiles. Entries cannot be edited or deleted.</p></div><button class="btn secondary-btn" id="export-audit">Export CSV</button></div>
      <p id="audit-error" class="err" role="alert"></p>
      <section class="audit-panel">
        <div class="audit-filters"><label>Search<input id="audit-search" placeholder="User or admin name"></label><label>Action<select id="audit-action"><option value="">All actions</option></select></label><label>From<input id="audit-from" type="date"></label><label>To<input id="audit-to" type="date"></label></div>
        <div class="audit-table-wrap"><table class="audit-table"><thead><tr><th>When</th><th>Done by</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody id="audit-rows"></tbody></table></div>
        <div class="accounts-pagination"><span id="audit-range"></span><div><button class="btn secondary-btn" id="audit-prev">Previous</button><button class="btn secondary-btn" id="audit-next">Next</button></div></div>
      </section>
    </section>`);
    let rows;
    let profiles;
    try {
      ({ rows, profiles } = await this.admin.logs());
    } catch (error) {
      this.$('#audit-error').textContent = `Could not load audit log: ${error.message}`;
      return;
    }
    const profileById = new Map(profiles.map(profile => [profile.id, profile]));
    const profileByEmail = new Map(profiles.filter(profile => profile.email).map(profile => [profile.email.toLowerCase(), profile]));
    const displayTarget = value => {
      const email = value?.toLowerCase();
      return profileByEmail.get(email)?.name ?? value ?? '—';
    };
    const actionLabels = {
      REGISTER: 'Created account',
      CREATE_USER: 'Created account',
      UPDATE_USER: 'Edited profile',
      SUSPEND_USER: 'Suspended account',
      REACTIVATE_USER: 'Reactivated account',
      DELETE_USER: 'Deleted account',
      RESET_PASSWORD: 'Reset password',
      CREATE_PROFILE: 'Created profile'
    };
    const parseEntry = entry => {
      const detail = entry.detail ?? '';
      const parts = detail.split(';').map(part => part.trim());
      const target = displayTarget(parts[0]?.split(' as ')[0]?.replace(/: role=.*$/, '') || '—');
      const extras = parts.slice(1);
      if (entry.action === 'CREATE_USER') {
        const role = parts.find(part => part.startsWith('as '))?.slice(3)
          ?? parts[0]?.split(' as ')[1]?.split(';')[0];
        return { target, details: role ? `Profile: ${role}` : 'Account created' };
      }
      if (entry.action === 'SUSPEND_USER') {
        return { target, details: extras.find(part => part.startsWith('reason='))?.slice(7) || '—' };
      }
      if (entry.action === 'REACTIVATE_USER' || entry.action === 'DELETE_USER') return { target, details: '—' };
      if (entry.action === 'RESET_PASSWORD') {
        return { target: profileById.get(detail)?.name ?? displayTarget(detail), details: 'Password reset' };
      }
      if (entry.action === 'REGISTER') {
        const [name, role] = detail.split(' as ');
        return { target: displayTarget(name), details: role ? `Profile: ${role}` : 'Account created' };
      }
      return { target, details: detail || '—' };
    };
    const getFiltered = () => {
      const query = this.$('#audit-search').value.trim().toLowerCase();
      const action = this.$('#audit-action').value;
      const from = this.$('#audit-from').value;
      const to = this.$('#audit-to').value;
      return rows.filter(entry => {
        if (action && entry.action !== action) return false;
        const date = new Date(entry.created_at);
        if (from && date < new Date(`${from}T00:00:00`)) return false;
        if (to) {
          const end = new Date(`${to}T00:00:00`);
          end.setDate(end.getDate() + 1);
          if (date >= end) return false;
        }
        if (query) {
          const actor = profileById.get(entry.actor);
          const parsed = parseEntry(entry);
          const targetProfile = profileByEmail.get(parsed.target.toLowerCase());
          const haystack = `${actor?.name ?? ''} ${actor?.email ?? ''} ${parsed.target} ${targetProfile?.name ?? ''} ${entry.detail ?? ''}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
    };
    [...new Set(rows.map(entry => entry.action))].sort().forEach(action => {
      const option = document.createElement('option');
      option.value = action;
      option.textContent = actionLabels[action] ?? action;
      this.$('#audit-action').append(option);
    });
    const render = () => {
      const filtered = getFiltered();
      const start = page * pageSize;
      const visible = filtered.slice(start, start + pageSize);
      this.$('#audit-rows').innerHTML = visible.map(entry => {
        const actor = profileById.get(entry.actor);
        const parsed = parseEntry(entry);
        return `<tr><td><strong>${new Date(entry.created_at).toLocaleString()}</strong></td>
          <td>${esc(actor ? `${actor.name}${actor.role === 'admin' ? ' (User Admin)' : ''}` : 'System')}</td>
          <td>${esc(actionLabels[entry.action] ?? entry.action)}</td><td>${esc(parsed.target)}</td><td>${esc(parsed.details)}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="audit-empty">No audit entries match these filters.</td></tr>';
      const first = filtered.length ? start + 1 : 0;
      const last = Math.min(start + pageSize, filtered.length);
      this.$('#audit-range').textContent = `Showing ${first}–${last} of ${filtered.length}`;
      this.$('#audit-prev').disabled = page === 0;
      this.$('#audit-next').disabled = last >= filtered.length;
    };
    const filterChanged = () => { page = 0; render(); };
    ['#audit-search', '#audit-action', '#audit-from', '#audit-to'].forEach(selector => {
      this.$(selector).addEventListener(selector === '#audit-search' ? 'input' : 'change', filterChanged);
    });
    this.$('#audit-prev').onclick = () => { if (page > 0) page -= 1; render(); };
    this.$('#audit-next').onclick = () => { if ((page + 1) * pageSize < getFiltered().length) page += 1; render(); };
    this.$('#export-audit').onclick = () => {
      const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [
        ['When', 'Done by', 'Action', 'Target', 'Details'],
        ...getFiltered().map(entry => {
          const actor = profileById.get(entry.actor);
          const parsed = parseEntry(entry);
          return [
            new Date(entry.created_at).toISOString(),
            actor ? `${actor.name}${actor.role === 'admin' ? ' (User Admin)' : ''}` : 'System',
            actionLabels[entry.action] ?? entry.action,
            parsed.target,
            parsed.details
          ];
        })
      ].map(row => row.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'audit-log.csv';
      link.click();
      URL.revokeObjectURL(url);
    };
    render();
  }
  async notificationsView() {
    const isAdmin = this.user.role === 'admin';
    const isPlatform = this.user.role === 'platform';
    const isManager = isAdmin || isPlatform;
    this.show(`<section class="notifications-page ${isManager ? 'admin-notifications-page' : ''} ${isPlatform ? 'platform-notifications-page' : ''}">
      <div class="notifications-heading"><div><h2>Notifications</h2><p>${isPlatform ? 'Items that need the attention of Platform Management.' : isAdmin ? 'Activity that needs the attention of a User Admin.' : 'Updates about your messages and account.'}</p></div><button class="btn notification-mark-all" id="mark-all-read">${isManager ? 'Mark all as read' : 'Mark messages as read'}</button></div>
      <div class="notification-filters">${isPlatform
        ? '<button class="on" data-filter="all">All</button><button data-filter="unread">Unread</button><button data-filter="verification">Verification</button><button data-filter="feedback">Feedback</button>'
        : isAdmin
        ? '<button class="on" data-filter="all">All</button><button data-filter="unread">Unread</button><button data-filter="designer_signup">Designer sign-ups</button>'
        : '<button class="on" data-filter="all">All</button><button data-filter="unread">Unread</button><button data-filter="messages">Messages</button>'}</div>
      <div id="notifications-list"></div><p id="msg" class="err" role="alert"></p></section>`);
    try {
      const unread = isManager ? [] : await this.inbox.unreadNotifications();
      const adminNotices = isManager ? await this.admin.notifications() : [];
      const list = this.$('#notifications-list');
      let activeFilter = 'all';
      const render = filter => {
        const messages = isManager || filter === 'designer_signup' ? [] : unread;
        const notices = filter === 'messages' ? [] : adminNotices.filter(notice => {
          if (filter === 'verification') return ['designer_signup', 'verification_completed'].includes(notice.kind);
          if (filter === 'feedback') return notice.kind === 'feedback';
          if (filter === 'designer_signup') return notice.kind === 'designer_signup';
          if (filter === 'unread') return !notice.read_at;
          return true;
        });
        const messageCards = messages.map(message => `<article class="notification-card is-unread" data-kind="messages"><span class="notification-dot"></span><div><strong>New message</strong><p>${esc(message.sender)} sent you a message${message.conversation?.project?.title ? ` about ${esc(message.conversation.project.title)}` : ''}.</p><button class="btn" data-open-conversation="${message.conversation_id}">Open messages</button></div><time>${new Date(message.created_at).toLocaleString()}</time></article>`).join('');
        const noticeCards = notices.map(notice => {
          const designer = notice.kind === 'designer_signup';
          const feedback = notice.kind === 'feedback';
          const completed = notice.kind === 'verification_completed';
          const title = designer ? (isPlatform ? 'Designer awaiting verification' : 'New interior designer registered')
            : feedback ? 'New user feedback'
              : completed ? 'Verification completed' : 'Account activity';
          const description = designer
            ? isPlatform
              ? `${notice.company?.name ?? notice.profile?.name ?? 'A designer'} registered and needs verification.`
              : `${notice.company?.name ?? notice.profile?.name ?? 'A new designer'} signed up as an Interior Designer. Review the account and check their details.`
            : notice.message;
          return `<article class="notification-card ${notice.read_at ? 'is-read' : 'is-unread'}" data-kind="${esc(notice.kind)}">
            <span class="notification-dot" ${notice.read_at ? 'hidden' : ''}></span><div><strong>${title}</strong><p>${esc(description)}</p>
              ${isPlatform && designer ? '<button type="button" class="btn" data-review-verification>Review designer</button>' : ''}
              ${isPlatform && feedback ? '<button type="button" class="btn" data-review-feedback>Read feedback</button>' : ''}
              ${!isPlatform && designer && notice.profile ? '<button type="button" class="btn" data-review-account>Review account</button>' : ''}
              ${completed ? '<button type="button" class="btn secondary-btn" data-view-designers>View designers</button>' : ''}
              ${!notice.read_at ? `<button type="button" class="btn secondary-btn" data-mark-notice="${notice.id}">Mark as read</button>` : ''}
            </div><time>${new Date(notice.created_at).toLocaleString()}</time></article>`;
        }).join('');
        list.innerHTML = messageCards + noticeCards || '<p class="notification-empty">You’re all caught up.</p>';
        const unreadNoticeCount = adminNotices.filter(notice => !notice.read_at).length;
        if (isPlatform) {
          this.$('[data-filter="unread"]').textContent = `Unread (${unreadNoticeCount})`;
        }
        this.$('#mark-all-read').hidden = messages.length === 0 && unreadNoticeCount === 0;
      };
      render('all');
      this.$('.notification-filters').onclick = e => {
        const button = e.target.closest('[data-filter]');
        if (!button) return;
        activeFilter = button.dataset.filter;
        this.$$('.notification-filters button').forEach(item => item.classList.toggle('on', item === button));
        render(activeFilter);
      };
      list.onclick = this.guard(async e => {
        const conversation = e.target.closest('[data-open-conversation]');
        const markNotice = e.target.closest('[data-mark-notice]');
        if (conversation) {
          await this.open('messages', Number(conversation.dataset.openConversation));
          return;
        }
        if (markNotice) {
          await this.admin.markNotificationRead(Number(markNotice.dataset.markNotice));
          const notice = adminNotices.find(item => item.id === Number(markNotice.dataset.markNotice));
          if (notice) notice.read_at = new Date().toISOString();
          render(this.$('.notification-filters button.on')?.dataset.filter ?? 'all');
          this.refreshNotificationCount();
          return;
        }
        if (e.target.closest('[data-review-account]')) {
          await this.open('accounts');
          return;
        }
        if (e.target.closest('[data-review-verification]')) { await this.open('verification'); return; }
        if (e.target.closest('[data-review-feedback]')) { await this.open('feedback'); return; }
        if (e.target.closest('[data-view-designers]')) { await this.open('verification'); }
      });
      this.$('#mark-all-read').onclick = this.guard(async () => {
        const button = this.$('#mark-all-read');
        button.disabled = true;
        const label = button.textContent;
        button.textContent = 'Marking as read…';
        this.$('#msg').textContent = '';
        try {
          if (isManager) {
            await this.admin.markAllNotificationsRead();
            const readAt = new Date().toISOString();
            adminNotices.forEach(notice => { if (!notice.read_at) notice.read_at = readAt; });
            render(activeFilter);
            await this.refreshNotificationCount();
          } else {
            const conversationIds = [...new Set(unread.map(message => message.conversation_id))];
            await Promise.all(conversationIds.map(id => this.inbox.markRead(id)));
            await this.notificationsView();
            await this.refreshNotificationCount();
          }
        } catch (error) {
          button.disabled = false;
          button.textContent = label;
          throw new Error(`Could not mark notifications as read: ${error.message}`);
        }
      });
    } catch (error) {
      const message = this.$('#msg');
      message.textContent = `Could not load notifications: ${error.message}`;
    }
  }
}
new App().start();
