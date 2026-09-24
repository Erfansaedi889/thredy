(() => {
  const state = {
    token: localStorage.getItem('thredy_token') || null,
    user: null,
    servers: [],
    currentServerId: null,
    currentChannelId: null,
    channels: [],
    members: [],
    onlineIds: new Set(),
    socket: null,
    typingTimeout: null,
  };

  const el = (id) => document.getElementById(id);

  // ---------- API helper ----------
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function initials(name) {
    return (name || '?').slice(0, 2).toUpperCase();
  }

  function avatarEl(username, color, size) {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = color || '#5865F2';
    if (size) { div.style.width = size + 'px'; div.style.height = size + 'px'; }
    div.textContent = initials(username);
    div.setAttribute('role', 'img');
    div.setAttribute('aria-label', `${username}'s avatar`);
    return div;
  }

  // ---------- Auth screen ----------
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      el('login-form').classList.toggle('hidden', target !== 'login');
      el('register-form').classList.toggle('hidden', target !== 'register');
    });
  });

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-error').textContent = '';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: el('login-username').value.trim(),
          password: el('login-password').value,
        }),
      });
      onAuthSuccess(data);
    } catch (err) {
      el('login-error').textContent = err.message;
    }
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('register-error').textContent = '';
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: el('register-username').value.trim(),
          password: el('register-password').value,
        }),
      });
      onAuthSuccess(data);
    } catch (err) {
      el('register-error').textContent = err.message;
    }
  });

  function onAuthSuccess({ token, user }) {
    state.token = token;
    state.user = user;
    localStorage.setItem('thredy_token', token);
    startApp();
  }

  el('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('thredy_token');
    if (state.socket) state.socket.disconnect();
    window.location.reload();
  });

  // ---------- Boot ----------
  async function boot() {
    if (!state.token) return showAuthScreen();
    try {
      state.user = await api('/auth/me');
      startApp();
    } catch (err) {
      localStorage.removeItem('thredy_token');
      showAuthScreen();
    }
  }

  function showAuthScreen() {
    el('auth-screen').classList.remove('hidden');
    el('app').classList.add('hidden');
  }

  async function startApp() {
    el('auth-screen').classList.add('hidden');
    el('app').classList.remove('hidden');
    el('me-username').textContent = state.user.username;
    const meAvatar = el('me-avatar');
    meAvatar.style.background = state.user.avatarColor;
    meAvatar.textContent = initials(state.user.username);
    meAvatar.setAttribute('role', 'img');
    meAvatar.setAttribute('aria-label', `${state.user.username}'s avatar`);

    connectSocket();
    await loadServers();
  }

  // ---------- Socket ----------
  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });

    state.socket.on('message:new', (msg) => {
      if (msg.channel_id === state.currentChannelId) {
        appendMessage(msg);
        scrollToBottom();
      }
    });

    state.socket.on('presence:update', ({ userId, online }) => {
      if (online) state.onlineIds.add(userId); else state.onlineIds.delete(userId);
      renderMembers();
    });

    state.socket.on('typing', ({ channelId, username, isTyping }) => {
      if (channelId !== state.currentChannelId) return;
      el('typing-indicator').textContent = isTyping ? `${username} is typing…` : '';
    });

    state.socket.on('member:join', ({ serverId, member }) => {
      if (serverId !== state.currentServerId) return;
      if (state.members.some((m) => m.id === member.id)) return;
      state.members.push(member);
      renderMembers();
    });
  }

  // ---------- Servers ----------
  async function loadServers() {
    state.servers = await api('/servers');
    renderServerList();
    if (state.servers.length && !state.currentServerId) {
      selectServer(state.servers[0].id);
    }
  }

  function renderServerList() {
    const list = el('server-list');
    list.innerHTML = '';
    state.servers.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'server-icon' + (s.id === state.currentServerId ? ' active' : '');
      btn.textContent = initials(s.name);
      btn.title = s.name;
      btn.addEventListener('click', () => selectServer(s.id));
      list.appendChild(btn);
    });
  }

  async function selectServer(serverId) {
    if (state.currentChannelId) {
      state.socket.emit('channel:leave', state.currentChannelId);
    }
    state.currentServerId = serverId;
    state.currentChannelId = null;
    renderServerList();

    const server = state.servers.find((s) => s.id === serverId);
    el('current-server-name').textContent = server ? server.name : '';

    const [channels, members] = await Promise.all([
      api(`/servers/${serverId}/channels`),
      api(`/servers/${serverId}/members`),
    ]);
    state.channels = channels;
    state.members = members;
    renderChannelList();
    renderMembers();

    const isOwner = server && server.owner_id === state.user.id;
    el('add-channel-btn').classList.toggle('hidden', !isOwner);
    if (isOwner) {
      showInviteHint(server.invite_code);
    }

    if (channels.length) selectChannel(channels[0].id);
  }

  function showInviteHint(code) {
    const toast = el('invite-toast');
    toast.textContent = `Invite code for this server: ${code}`;
    toast.classList.remove('hidden');
    clearTimeout(showInviteHint._t);
    showInviteHint._t = setTimeout(() => toast.classList.add('hidden'), 5000);
  }

  function renderChannelList() {
    const list = el('channel-list');
    list.innerHTML = '';
    state.channels.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (c.id === state.currentChannelId ? ' active' : '');
      div.innerHTML = `<span class="hash">#</span><span>${escapeHtml(c.name)}</span>`;
      div.addEventListener('click', () => selectChannel(c.id));
      list.appendChild(div);
    });
  }

  function renderMembers() {
    const list = el('member-list');
    list.innerHTML = '';
    el('member-count').textContent = state.members.length;

    const sorted = [...state.members].sort((a, b) => {
      const aOn = state.onlineIds.has(a.id) ? 0 : 1;
      const bOn = state.onlineIds.has(b.id) ? 0 : 1;
      return aOn - bOn || a.username.localeCompare(b.username);
    });

    sorted.forEach((m) => {
      const online = state.onlineIds.has(m.id);
      const div = document.createElement('div');
      div.className = 'member-item' + (online ? '' : ' offline');
      const avatarWrap = avatarEl(m.username, m.avatar_color, 26);
      const dot = document.createElement('span');
      dot.className = 'status-dot' + (online ? ' online' : '');
      avatarWrap.style.position = 'relative';
      avatarWrap.appendChild(dot);
      div.appendChild(avatarWrap);
      const name = document.createElement('span');
      name.textContent = m.username;
      div.appendChild(name);
      list.appendChild(div);
    });
  }

  // ---------- Channels / messages ----------
  async function selectChannel(channelId) {
    if (state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);
    state.currentChannelId = channelId;
    renderChannelList();

    const channel = state.channels.find((c) => c.id === channelId);
    el('current-channel-name').textContent = channel ? channel.name : '';
    el('message-input').placeholder = `Message #${channel ? channel.name : ''}`;
    el('message-form').classList.remove('hidden');
    el('empty-state')?.remove();

    state.socket.emit('channel:join', channelId);

    const messages = await api(`/messages/${channelId}`);
    const list = el('message-list');
    list.innerHTML = '';
    messages.forEach(appendMessage);
    scrollToBottom();
  }

  function appendMessage(msg) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.appendChild(avatarEl(msg.username, msg.avatar_color, 36));

    const body = document.createElement('div');
    body.className = 'message-body';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = msg.username;
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = new Date(msg.created_at).toLocaleString();
    meta.appendChild(author);
    meta.appendChild(time);

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = msg.content;

    body.appendChild(meta);
    body.appendChild(content);
    row.appendChild(body);
    el('message-list').appendChild(row);
  }

  function scrollToBottom() {
    const list = el('message-list');
    list.scrollTop = list.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  el('message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('message-input');
    const content = input.value;
    if (!content.trim() || !state.currentChannelId) return;
    state.socket.emit('message:send', { channelId: state.currentChannelId, content }, (res) => {
      if (res && res.error) console.error(res.error);
    });
    input.value = '';
    state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
  });

  el('message-input').addEventListener('input', () => {
    if (!state.currentChannelId) return;
    state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: true });
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
      state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
    }, 1500);
  });

  // ---------- Modals: create/join server ----------
  el('add-server-btn').addEventListener('click', () => el('modal-overlay').classList.remove('hidden'));
  el('close-modal-btn').addEventListener('click', () => el('modal-overlay').classList.add('hidden'));

  document.querySelectorAll('.modal-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.modalTab;
      el('create-server-form').classList.toggle('hidden', target !== 'create');
      el('join-server-form').classList.toggle('hidden', target !== 'join');
    });
  });

  el('create-server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('create-server-error').textContent = '';
    try {
      const server = await api('/servers', {
        method: 'POST',
        body: JSON.stringify({ name: el('create-server-name').value.trim() }),
      });
      el('create-server-name').value = '';
      el('modal-overlay').classList.add('hidden');
      await loadServers();
      selectServer(server.id);
    } catch (err) {
      el('create-server-error').textContent = err.message;
    }
  });

  el('join-server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('join-server-error').textContent = '';
    try {
      const server = await api('/servers/join', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: el('join-invite-code').value.trim() }),
      });
      el('join-invite-code').value = '';
      el('modal-overlay').classList.add('hidden');
      await loadServers();
      selectServer(server.id);
    } catch (err) {
      el('join-server-error').textContent = err.message;
    }
  });

  // ---------- Modal: create channel ----------
  el('add-channel-btn').addEventListener('click', () => {
    if (!state.currentServerId) return;
    el('channel-modal-overlay').classList.remove('hidden');
  });
  el('close-channel-modal-btn').addEventListener('click', () => el('channel-modal-overlay').classList.add('hidden'));

  el('create-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('create-channel-error').textContent = '';
    try {
      const channel = await api(`/servers/${state.currentServerId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ name: el('create-channel-name').value.trim() }),
      });
      el('create-channel-name').value = '';
      el('channel-modal-overlay').classList.add('hidden');
      state.channels.push(channel);
      renderChannelList();
      selectChannel(channel.id);
    } catch (err) {
      el('create-channel-error').textContent = err.message;
    }
  });

  boot();
})();
