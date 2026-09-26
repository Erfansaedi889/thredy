(() => {
  const AVATAR_COLORS = ['#F2B84B', '#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#7289DA', '#43B581'];
  const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
  const COMPOSE_EMOJIS = ['😀', '😂', '😍', '🥳', '😎', '🤔', '😢', '😡', '👍', '👎', '❤️', '🔥', '🎉', '👀', '🙏', '💯', '😴', '🤯'];
  const STATUS_LABELS = { online: '🟢 Online', idle: '🌙 Idle', dnd: '⛔ Do Not Disturb', invisible: '⚪ Invisible', offline: '⚪ Offline' };

  const state = {
    token: localStorage.getItem('thredy_token') || null,
    user: null,
    mode: 'home', // 'home' | 'server'
    servers: [],
    currentServerId: null,
    currentServerRole: null,
    currentChannelId: null,
    currentChannelType: null, // 'text' | 'voice'
    channels: [],
    members: [],
    statuses: new Map(), // userId -> { status, customStatus }
    socket: null,
    typingTimeout: null,
    friends: [],
    dms: [],
    currentDmId: null,
    voiceParticipants: new Map(), // channelId -> [{ id, username, avatarColor }]
  };

  const el = (id) => document.getElementById(id);

  // ---------- API helper ----------
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }

  function avatarEl(username, color, size, statusKey) {
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-block';
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = color || '#5865F2';
    if (size) { div.style.width = size + 'px'; div.style.height = size + 'px'; }
    div.textContent = initials(username);
    div.setAttribute('role', 'img');
    div.setAttribute('aria-label', `${username}'s avatar`);
    wrap.appendChild(div);
    if (statusKey) {
      const dot = document.createElement('span');
      dot.className = `status-dot status-${statusKey}`;
      wrap.appendChild(dot);
    }
    return wrap;
  }

  function showToast(text, ms = 4000) {
    const toast = el('invite-toast');
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderContentHtml(content) {
    const escaped = escapeHtml(content);
    return escaped.replace(/@([a-zA-Z0-9_]{3,24})/g, '<span class="mention">@$1</span>');
  }

  function loomBadgeHtml(isLoom) {
    return isLoom ? '<span class="loom-badge">🧵 LOOM</span>' : '';
  }

  function statusFor(userId) {
    const s = state.statuses.get(userId);
    return s ? s.status : 'offline';
  }

  // Positions and removes any open emoji picker popup
  let openPicker = null;
  function closeEmojiPicker() {
    if (openPicker) { openPicker.remove(); openPicker = null; }
  }
  function openEmojiPicker(anchorEl, emojis, onSelect) {
    closeEmojiPicker();
    const rect = anchorEl.getBoundingClientRect();
    const popup = document.createElement('div');
    popup.className = 'emoji-picker-popup';
    popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popup.style.left = `${Math.max(8, rect.left + window.scrollX - 100)}px`;
    emojis.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(emoji);
        closeEmojiPicker();
      });
      popup.appendChild(btn);
    });
    document.body.appendChild(popup);
    openPicker = popup;
    setTimeout(() => document.addEventListener('click', closeEmojiPicker, { once: true }), 0);
  }

  // =========================================================
  // AUTH SCREEN
  // =========================================================
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      el('login-form').classList.toggle('hidden', target !== 'login');
      el('register-form').classList.toggle('hidden', target !== 'register');
      el('verify-pending').classList.add('hidden');
    });
  });

  el('open-terms-btn').addEventListener('click', () => el('terms-modal-overlay').classList.remove('hidden'));
  el('close-terms-btn').addEventListener('click', () => el('terms-modal-overlay').classList.add('hidden'));

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-error').textContent = '';
    el('resend-verification-btn').classList.add('hidden');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: el('login-username').value.trim(), password: el('login-password').value }),
      });
      onAuthSuccess(data);
    } catch (err) {
      el('login-error').textContent = err.message;
      if (err.data && err.data.needsVerification) el('resend-verification-btn').classList.remove('hidden');
    }
  });

  el('resend-verification-btn').addEventListener('click', async () => {
    const email = prompt('Enter the email you registered with:');
    if (!email) return;
    try {
      const data = await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      showToast(data.message);
      if (data.devVerifyUrl) console.log('[Thredy dev] verification link:', data.devVerifyUrl);
    } catch (err) { showToast(err.message); }
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('register-error').textContent = '';
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          fullName: el('register-fullname').value.trim(),
          username: el('register-username').value.trim(),
          email: el('register-email').value.trim(),
          phone: el('register-phone').value.trim() || null,
          birthDate: el('register-birthdate').value,
          password: el('register-password').value,
          confirmPassword: el('register-confirm-password').value,
          agreedToTerms: el('register-terms').checked,
        }),
      });
      el('register-form').classList.add('hidden');
      el('verify-pending').classList.remove('hidden');
      el('verify-pending-email').textContent = el('register-email').value.trim();
      if (data.devVerifyUrl) {
        const note = el('verify-dev-note');
        note.classList.remove('hidden');
        note.innerHTML = `No SMTP configured on this server yet — dev link: <a href="${data.devVerifyUrl}" target="_blank">${data.devVerifyUrl}</a>`;
      }
    } catch (err) { el('register-error').textContent = err.message; }
  });

  el('verify-back-to-login-btn').addEventListener('click', () => {
    el('verify-pending').classList.add('hidden');
    el('register-form').reset();
    document.querySelector('.auth-tab[data-tab="login"]').click();
  });

  function onAuthSuccess({ token, user }) {
    state.token = token;
    state.user = user;
    localStorage.setItem('thredy_token', token);
    startApp();
  }

  function logout() {
    localStorage.removeItem('thredy_token');
    if (state.socket) state.socket.disconnect();
    window.location.reload();
  }
  el('logout-btn').addEventListener('click', logout);
  el('logout-btn-2').addEventListener('click', logout);

  // =========================================================
  // BOOT
  // =========================================================
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
    state.statuses.set(state.user.id, { status: state.user.status, customStatus: state.user.customStatus });
    renderMe();
    connectSocket();
    await Promise.all([loadServers(), loadFriends(), loadFriendRequests(), loadDms()]);
    if (state.user.isAdmin) el('admin-btn').classList.remove('hidden');
    showHomeView();
  }

  function renderMe() {
    const st = state.statuses.get(state.user.id) || { status: state.user.status, customStatus: state.user.customStatus };
    [['me-avatar', 'me-username', 'me-loom-badge'], ['me-avatar-2', 'me-username-2', 'me-loom-badge-2']].forEach(([avatarId, nameId, statusId]) => {
      const old = el(avatarId);
      const fresh = avatarEl(state.user.username, state.user.avatarColor, null, st.status === 'invisible' ? 'offline' : st.status);
      fresh.id = avatarId;
      fresh.querySelector('.avatar').id = '';
      old.replaceWith(fresh);
      el(nameId).innerHTML = escapeHtml(state.user.username) + loomBadgeHtml(state.user.loomActive);
      el(statusId).textContent = st.customStatus ? `${STATUS_LABELS[st.status] || ''} — ${st.customStatus}` : (STATUS_LABELS[st.status] || 'Online');
    });
  }
  el('me-username').addEventListener('click', openProfileModal);
  el('me-username-2').addEventListener('click', openProfileModal);
  el('me-loom-badge').addEventListener('click', openStatusModal);
  el('me-loom-badge-2').addEventListener('click', openStatusModal);

  // =========================================================
  // STATUS / PRESENCE
  // =========================================================
  function openStatusModal() {
    const st = state.statuses.get(state.user.id) || { status: 'online', customStatus: '' };
    document.querySelector(`input[name="status-choice"][value="${st.status}"]`).checked = true;
    el('custom-status-input').value = st.customStatus || '';
    el('status-modal-overlay').classList.remove('hidden');
  }
  el('close-status-modal-btn').addEventListener('click', () => el('status-modal-overlay').classList.add('hidden'));

  el('status-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const status = document.querySelector('input[name="status-choice"]:checked').value;
    const customStatus = el('custom-status-input').value.trim();
    state.socket.emit('status:update', { status, customStatus });
    state.statuses.set(state.user.id, { status, customStatus });
    renderMe();
    renderMembers();
    el('status-modal-overlay').classList.add('hidden');
  });

  // =========================================================
  // SOCKET
  // =========================================================
  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });

    state.socket.on('message:new', (msg) => {
      if (state.mode === 'server' && msg.channel_id === state.currentChannelId) { appendMessage(msg); scrollToBottom(); }
    });
    state.socket.on('message:edited', ({ channelId, messageId, content, editedAt }) => {
      if (state.currentChannelId !== channelId) return;
      updateMessageContent(messageId, content, editedAt);
    });
    state.socket.on('message:deleted', ({ channelId, messageId }) => {
      if (state.currentChannelId !== channelId) return;
      removeMessageEl(messageId);
    });
    state.socket.on('message:reactions', ({ channelId, messageId, reactions }) => {
      if (state.currentChannelId !== channelId) return;
      updateMessageReactions(messageId, reactions);
    });
    state.socket.on('message:pinned', ({ channelId, messageId, pinned, byUsername }) => {
      if (state.currentChannelId === channelId) markMessagePinned(messageId, pinned);
      showToast(pinned ? `${byUsername} pinned a message` : `${byUsername} unpinned a message`);
    });

    state.socket.on('dm:new', (msg) => {
      if (state.mode === 'home' && msg.dm_channel_id === state.currentDmId) { appendMessage(msg); scrollToBottom(); }
      else showToast(`New message from ${msg.username}`);
    });
    state.socket.on('dm:edited', ({ dmChannelId, messageId, content, editedAt }) => {
      if (state.currentDmId !== dmChannelId) return;
      updateMessageContent(messageId, content, editedAt);
    });
    state.socket.on('dm:deleted', ({ dmChannelId, messageId }) => {
      if (state.currentDmId !== dmChannelId) return;
      removeMessageEl(messageId);
    });

    state.socket.on('presence:update', ({ userId, status, customStatus }) => {
      state.statuses.set(userId, { status, customStatus });
      renderMembers();
      renderFriendsList();
    });

    state.socket.on('typing', ({ channelId, username, isTyping }) => {
      if (state.mode !== 'server' || channelId !== state.currentChannelId) return;
      el('typing-indicator').textContent = isTyping ? `${username} is typing…` : '';
    });
    state.socket.on('dm:typing', ({ dmChannelId, username, isTyping }) => {
      if (state.mode !== 'home' || dmChannelId !== state.currentDmId) return;
      el('typing-indicator').textContent = isTyping ? `${username} is typing…` : '';
    });

    state.socket.on('member:join', ({ serverId, member }) => {
      if (serverId !== state.currentServerId) return;
      if (state.members.some((m) => m.id === member.id)) return;
      state.members.push(member);
      renderMembers();
    });
    state.socket.on('member:kick', ({ serverId, userId }) => {
      if (serverId === state.currentServerId) {
        state.members = state.members.filter((m) => m.id !== userId);
        renderMembers();
        if (userId === state.user.id) {
          showToast('You were removed from this server');
          state.servers = state.servers.filter((s) => s.id !== serverId);
          showHomeView();
        }
      }
    });
    state.socket.on('member:role-changed', ({ serverId, userId, role }) => {
      if (serverId !== state.currentServerId) return;
      const m = state.members.find((x) => x.id === userId);
      if (m) m.role = role;
      if (userId === state.user.id) state.currentServerRole = role;
      renderMembers();
      renderServerHeaderActions();
    });

    state.socket.on('server:updated', (server) => {
      const idx = state.servers.findIndex((s) => s.id === server.id);
      if (idx !== -1) state.servers[idx] = { ...state.servers[idx], ...server };
      if (state.currentServerId === server.id) el('current-server-name').textContent = server.name;
      renderServerList();
    });

    state.socket.on('channel:created', ({ serverId, channel }) => {
      if (serverId !== state.currentServerId) return;
      if (!state.channels.some((c) => c.id === channel.id)) state.channels.push(channel);
      renderChannelList();
    });
    state.socket.on('channel:deleted', ({ serverId, channelId }) => {
      if (serverId !== state.currentServerId) return;
      state.channels = state.channels.filter((c) => c.id !== channelId);
      renderChannelList();
      if (state.currentChannelId === channelId && state.channels.length) selectChannel(state.channels[0].id);
    });

    state.socket.on('voice:participants', ({ channelId, participants }) => {
      state.voiceParticipants.set(channelId, participants);
      renderChannelList();
      if (state.currentChannelType === 'voice' && state.currentChannelId === channelId) renderVoiceView();
    });

    state.socket.on('server:boosted', ({ serverId, boostCount, boostLevel, boostedBy }) => {
      const server = state.servers.find((s) => s.id === serverId);
      if (server) { server.boost_count = boostCount; server.boost_level = boostLevel; }
      if (state.currentServerId === serverId) renderBoostButton();
      showToast(`${boostedBy} boosted the server! (Level ${boostLevel})`);
    });

    state.socket.on('friend:request', ({ fromUsername }) => { showToast(`${fromUsername} sent you a friend request`); loadFriendRequests(); });
    state.socket.on('friend:accepted', ({ byUsername }) => { showToast(`${byUsername} accepted your friend request`); loadFriends(); });
    state.socket.on('mention', ({ fromUsername }) => showToast(`💬 ${fromUsername} mentioned you`));
  }

  // =========================================================
  // VIEW SWITCHING
  // =========================================================
  function showHomeView() {
    state.mode = 'home';
    state.currentChannelId = null;
    state.currentChannelType = null;
    el('home-sidebar').classList.remove('hidden');
    el('server-sidebar').classList.add('hidden');
    el('home-btn').classList.add('active');
    renderServerList();
    el('chat-header-icon').textContent = '@';
    el('boost-btn').classList.add('hidden');
    el('pin-messages-btn').classList.add('hidden');
    el('voice-view').classList.add('hidden');
    el('member-list-label').innerHTML = 'Participants — <span id="member-count">0</span>';
    if (!state.currentDmId) {
      el('current-channel-name').textContent = 'Select a friend or DM';
      el('message-form').classList.add('hidden');
      el('message-list').classList.remove('hidden');
      el('message-list').innerHTML = '<div class="empty-state"><p>Pick a friend or a DM on the left to start chatting.</p></div>';
      el('member-list').innerHTML = '';
    }
  }

  function showServerView() {
    state.mode = 'server';
    state.currentDmId = null;
    el('home-sidebar').classList.add('hidden');
    el('server-sidebar').classList.remove('hidden');
    el('home-btn').classList.remove('active');
    el('chat-header-icon').textContent = '#';
    el('member-list-label').innerHTML = 'Members — <span id="member-count">0</span>';
  }

  el('home-btn').addEventListener('click', showHomeView);
  el('discover-btn').addEventListener('click', openDiscoverModal);

  // =========================================================
  // SERVERS
  // =========================================================
  async function loadServers() { state.servers = await api('/servers'); renderServerList(); }

  function renderServerList() {
    const list = el('server-list');
    list.innerHTML = '';
    state.servers.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'server-icon' + (state.mode === 'server' && s.id === state.currentServerId ? ' active' : '');
      btn.textContent = s.icon_emoji || initials(s.name);
      btn.title = s.name;
      btn.addEventListener('click', () => selectServer(s.id));
      list.appendChild(btn);
    });
  }

  async function selectServer(serverId) {
    if (state.mode === 'server' && state.currentChannelType === 'text' && state.currentChannelId) {
      state.socket.emit('channel:leave', state.currentChannelId);
    }
    if (state.currentChannelType === 'voice' && state.currentChannelId) {
      state.socket.emit('voice:leave', state.currentChannelId);
    }

    state.currentServerId = serverId;
    state.currentChannelId = null;
    state.currentChannelType = null;
    showServerView();
    renderServerList();

    const server = state.servers.find((s) => s.id === serverId);
    el('current-server-name').textContent = server ? server.name : '';
    state.currentServerRole = server ? server.role : null;
    renderServerHeaderActions();

    const [channels, members] = await Promise.all([
      api(`/servers/${serverId}/channels`),
      api(`/servers/${serverId}/members`),
    ]);
    state.channels = channels;
    state.members = members;
    members.forEach((m) => state.statuses.set(m.id, { status: m.status, customStatus: m.custom_status }));
    renderChannelList();
    renderMembers();
    renderBoostButton();

    const isModerator = state.currentServerRole === 'owner' || state.currentServerRole === 'admin';
    el('add-channel-btn').classList.toggle('hidden', !isModerator);
    if (state.currentServerRole === 'owner') showToast(`Invite code for this server: ${server.invite_code}`);

    const textChannels = channels.filter((c) => c.type === 'text');
    if (textChannels.length) selectChannel(textChannels[0].id);
    else { el('message-form').classList.add('hidden'); el('message-list').innerHTML = '<div class="empty-state"><p>No text channels yet.</p></div>'; }
  }

  function renderServerHeaderActions() {
    const isOwner = state.currentServerRole === 'owner';
    const isMemberNotOwner = state.currentServerRole && state.currentServerRole !== 'owner';
    el('server-settings-btn').classList.toggle('hidden', !isOwner);
    el('leave-server-btn').classList.toggle('hidden', !isMemberNotOwner);
  }

  el('leave-server-btn').addEventListener('click', async () => {
    if (!state.currentServerId) return;
    if (!confirm('Leave this server?')) return;
    try {
      await api(`/servers/${state.currentServerId}/leave`, { method: 'POST' });
      state.servers = state.servers.filter((s) => s.id !== state.currentServerId);
      showHomeView();
    } catch (err) { showToast(err.message); }
  });

  function renderBoostButton() {
    const server = state.servers.find((s) => s.id === state.currentServerId);
    const btn = el('boost-btn');
    if (state.mode !== 'server' || !server) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    el('boost-count').textContent = server.boost_count || 0;
  }

  el('boost-btn').addEventListener('click', async () => {
    if (!state.currentServerId) return;
    try {
      const result = await api(`/servers/${state.currentServerId}/boost`, { method: 'POST' });
      const server = state.servers.find((s) => s.id === state.currentServerId);
      if (server) { server.boost_count = result.boostCount; server.boost_level = result.boostLevel; }
      renderBoostButton();
      showToast(`Boosted! This server is now level ${result.boostLevel}.`);
    } catch (err) { showToast(err.message); }
  });

  function renderChannelList() {
    const list = el('channel-list');
    list.innerHTML = '';
    state.channels.forEach((c) => {
      const div = document.createElement('div');
      div.className = `channel-item ${c.type === 'voice' ? 'voice' : ''}` + (c.id === state.currentChannelId ? ' active' : '');
      const nameSpan = document.createElement('span');
      if (c.type === 'text') {
        div.innerHTML = `<span class="hash">#</span>`;
      }
      nameSpan.textContent = c.name;
      div.appendChild(nameSpan);

      if (c.type === 'voice') {
        const participants = state.voiceParticipants.get(c.id) || [];
        if (participants.length) {
          const mini = document.createElement('span');
          mini.className = 'voice-mini-participants';
          mini.textContent = ` (${participants.length})`;
          div.appendChild(mini);
        }
      }

      div.addEventListener('click', () => (c.type === 'voice' ? selectVoiceChannel(c.id) : selectChannel(c.id)));
      list.appendChild(div);
    });
  }

  function renderMembers() {
    if (state.mode !== 'server') return;
    const list = el('member-list');
    list.innerHTML = '';
    el('member-count').textContent = state.members.length;

    const sorted = [...state.members].sort((a, b) => {
      const rank = (s) => (s === 'offline' || s === 'invisible' ? 1 : 0);
      const aOn = rank(statusFor(a.id)); const bOn = rank(statusFor(b.id));
      return aOn - bOn || a.username.localeCompare(b.username);
    });

    sorted.forEach((m) => {
      const status = statusFor(m.id);
      const div = document.createElement('div');
      div.className = 'member-item' + (status === 'offline' ? ' offline' : '');
      div.appendChild(avatarEl(m.username, m.avatar_color, 26, status));
      const name = document.createElement('span');
      name.innerHTML = escapeHtml(m.username)
        + (m.role === 'owner' ? '<span class="role-badge owner">OWNER</span>' : m.role === 'admin' ? '<span class="role-badge admin">ADMIN</span>' : '')
        + (m.loom_active ? loomBadgeHtml(true) : '');
      div.appendChild(name);

      const iAmMod = state.currentServerRole === 'owner' || state.currentServerRole === 'admin';
      if (iAmMod && m.id !== state.user.id && m.role !== 'owner') {
        const actions = document.createElement('div');
        actions.className = 'member-actions';

        if (state.currentServerRole === 'owner') {
          const roleBtn = document.createElement('button');
          roleBtn.className = 'mini-btn';
          roleBtn.textContent = m.role === 'admin' ? 'Demote' : 'Promote';
          roleBtn.title = m.role === 'admin' ? 'Demote to member' : 'Promote to admin';
          roleBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await api(`/servers/${state.currentServerId}/members/${m.id}/role`, { method: 'POST', body: JSON.stringify({ role: m.role === 'admin' ? 'member' : 'admin' }) });
          });
          actions.appendChild(roleBtn);
        }

        if (!(m.role === 'admin' && state.currentServerRole !== 'owner')) {
          const kickBtn = document.createElement('button');
          kickBtn.className = 'mini-btn danger';
          kickBtn.textContent = 'Kick';
          kickBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Kick ${m.username} from this server?`)) return;
            await api(`/servers/${state.currentServerId}/members/${m.id}`, { method: 'DELETE' });
          });
          actions.appendChild(kickBtn);
        }
        div.appendChild(actions);
      }
      list.appendChild(div);
    });
  }

  async function selectChannel(channelId) {
    if (state.currentChannelType === 'voice' && state.currentChannelId) state.socket.emit('voice:leave', state.currentChannelId);
    if (state.currentChannelType === 'text' && state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);

    state.currentChannelId = channelId;
    state.currentChannelType = 'text';
    renderChannelList();

    const channel = state.channels.find((c) => c.id === channelId);
    el('current-channel-name').textContent = channel ? channel.name : '';
    el('message-input').placeholder = `Message #${channel ? channel.name : ''}`;
    el('message-form').classList.remove('hidden');
    el('message-list').classList.remove('hidden');
    el('voice-view').classList.add('hidden');
    el('pin-messages-btn').classList.remove('hidden');

    state.socket.emit('channel:join', channelId);

    const messages = await api(`/messages/${channelId}`);
    const list = el('message-list');
    list.innerHTML = '';
    messages.forEach(appendMessage);
    scrollToBottom();
  }

  function selectVoiceChannel(channelId) {
    if (state.currentChannelType === 'voice' && state.currentChannelId && state.currentChannelId !== channelId) {
      state.socket.emit('voice:leave', state.currentChannelId);
    }
    if (state.currentChannelType === 'text' && state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);

    state.currentChannelId = channelId;
    state.currentChannelType = 'voice';
    renderChannelList();

    const channel = state.channels.find((c) => c.id === channelId);
    el('current-channel-name').textContent = channel ? channel.name : '';
    el('message-form').classList.add('hidden');
    el('message-list').classList.add('hidden');
    el('pin-messages-btn').classList.add('hidden');
    el('voice-view').classList.remove('hidden');
    el('voice-channel-title').textContent = `🔊 ${channel ? channel.name : ''}`;
    renderVoiceView();
  }

  function renderVoiceView() {
    const participants = state.voiceParticipants.get(state.currentChannelId) || [];
    const grid = el('voice-participants-grid');
    grid.innerHTML = '';
    participants.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'voice-participant';
      item.appendChild(avatarEl(p.username, p.avatarColor));
      const name = document.createElement('span');
      name.textContent = p.username;
      item.appendChild(name);
      grid.appendChild(item);
    });
    const amIn = participants.some((p) => p.id === state.user.id);
    const btn = el('voice-toggle-btn');
    btn.textContent = amIn ? 'Leave Voice' : '🔊 Join Voice';
    btn.className = 'btn-voice-toggle' + (amIn ? ' joined' : '');
  }

  el('voice-toggle-btn').addEventListener('click', () => {
    if (!state.currentChannelId) return;
    const participants = state.voiceParticipants.get(state.currentChannelId) || [];
    const amIn = participants.some((p) => p.id === state.user.id);
    state.socket.emit(amIn ? 'voice:leave' : 'voice:join', state.currentChannelId);
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
      const server = await api('/servers', { method: 'POST', body: JSON.stringify({ name: el('create-server-name').value.trim() }) });
      el('create-server-name').value = '';
      el('modal-overlay').classList.add('hidden');
      await loadServers();
      selectServer(server.id);
    } catch (err) { el('create-server-error').textContent = err.message; }
  });

  el('join-server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('join-server-error').textContent = '';
    try {
      const server = await api('/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: el('join-invite-code').value.trim() }) });
      el('join-invite-code').value = '';
      el('modal-overlay').classList.add('hidden');
      await loadServers();
      selectServer(server.id);
    } catch (err) { el('join-server-error').textContent = err.message; }
  });

  el('add-channel-btn').addEventListener('click', () => { if (state.currentServerId) el('channel-modal-overlay').classList.remove('hidden'); });
  el('close-channel-modal-btn').addEventListener('click', () => el('channel-modal-overlay').classList.add('hidden'));

  el('create-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('create-channel-error').textContent = '';
    const type = document.querySelector('input[name="channel-type"]:checked').value;
    try {
      const channel = await api(`/servers/${state.currentServerId}/channels`, { method: 'POST', body: JSON.stringify({ name: el('create-channel-name').value.trim(), type }) });
      el('create-channel-name').value = '';
      el('channel-modal-overlay').classList.add('hidden');
      if (!state.channels.some((c) => c.id === channel.id)) state.channels.push(channel);
      renderChannelList();
      if (channel.type === 'voice') selectVoiceChannel(channel.id); else selectChannel(channel.id);
    } catch (err) { el('create-channel-error').textContent = err.message; }
  });

  // ---------- Server settings ----------
  el('server-settings-btn').addEventListener('click', () => {
    const server = state.servers.find((s) => s.id === state.currentServerId);
    if (!server) return;
    el('settings-server-name').value = server.name;
    el('settings-server-description').value = server.description || '';
    el('settings-server-icon').value = server.icon_emoji || '';
    el('settings-server-public').checked = !!server.is_public;
    el('server-settings-error').textContent = '';
    el('server-settings-modal-overlay').classList.remove('hidden');
  });
  el('close-server-settings-btn').addEventListener('click', () => el('server-settings-modal-overlay').classList.add('hidden'));

  el('server-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('server-settings-error').textContent = '';
    try {
      const updated = await api(`/servers/${state.currentServerId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: el('settings-server-name').value.trim(),
          description: el('settings-server-description').value,
          iconEmoji: el('settings-server-icon').value.trim(),
          isPublic: el('settings-server-public').checked,
        }),
      });
      const idx = state.servers.findIndex((s) => s.id === state.currentServerId);
      if (idx !== -1) state.servers[idx] = { ...state.servers[idx], ...updated };
      el('current-server-name').textContent = updated.name;
      renderServerList();
      el('server-settings-modal-overlay').classList.add('hidden');
      showToast('Server settings saved');
    } catch (err) { el('server-settings-error').textContent = err.message; }
  });

  // ---------- Discover ----------
  async function openDiscoverModal() {
    const servers = await api('/servers/discover');
    const list = el('discover-list');
    list.innerHTML = '';
    el('discover-empty-hint').classList.toggle('hidden', servers.length > 0);
    servers.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'discover-card';
      card.innerHTML = `
        <div class="discover-icon">${s.icon_emoji || '💬'}</div>
        <div class="discover-info">
          <h4>${escapeHtml(s.name)}</h4>
          <p>${escapeHtml(s.description || 'No description yet.')}</p>
          <div class="discover-meta">${s.member_count} member${s.member_count === 1 ? '' : 's'}</div>
        </div>
      `;
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn-primary';
      joinBtn.style.flexShrink = '0';
      joinBtn.textContent = 'Join';
      joinBtn.addEventListener('click', async () => {
        try {
          await api(`/servers/${s.id}/join-public`, { method: 'POST' });
          el('discover-modal-overlay').classList.add('hidden');
          await loadServers();
          selectServer(s.id);
        } catch (err) { showToast(err.message); }
      });
      card.appendChild(joinBtn);
      list.appendChild(card);
    });
    el('discover-modal-overlay').classList.remove('hidden');
  }
  el('close-discover-modal-btn').addEventListener('click', () => el('discover-modal-overlay').classList.add('hidden'));

  // ---------- Pinned messages ----------
  el('pin-messages-btn').addEventListener('click', async () => {
    if (!state.currentChannelId) return;
    const pinned = await api(`/messages/${state.currentChannelId}/pinned`);
    const list = el('pinned-list');
    list.innerHTML = '';
    el('pinned-empty-hint').classList.toggle('hidden', pinned.length > 0);
    pinned.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'message-row';
      row.style.animation = 'none';
      row.appendChild(avatarEl(m.username, m.avatar_color, 32));
      const body = document.createElement('div');
      body.className = 'message-body';
      body.innerHTML = `<div class="message-meta"><span class="message-author">${escapeHtml(m.username)}</span></div><div class="message-content">${renderContentHtml(m.content)}</div>`;
      row.appendChild(body);
      list.appendChild(row);
    });
    el('pinned-modal-overlay').classList.remove('hidden');
  });
  el('close-pinned-modal-btn').addEventListener('click', () => el('pinned-modal-overlay').classList.add('hidden'));

  // =========================================================
  // FRIENDS
  // =========================================================
  async function loadFriends() {
    state.friends = await api('/friends');
    state.friends.forEach((f) => state.statuses.set(f.id, { status: f.status, customStatus: f.custom_status }));
    renderFriendsList();
  }
  async function loadFriendRequests() { const { incoming, outgoing } = await api('/friends/requests'); renderFriendRequests(incoming, outgoing); }

  function renderFriendRequests(incoming, outgoing) {
    const section = el('friend-requests-section');
    const list = el('friend-requests-list');
    list.innerHTML = '';
    if (!incoming.length && !outgoing.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    incoming.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'friend-request-item';
      row.appendChild(avatarEl(r.username, r.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name'; name.textContent = r.username;
      row.appendChild(name);
      const accept = document.createElement('button');
      accept.className = 'mini-btn'; accept.textContent = 'Accept';
      accept.addEventListener('click', async () => { await api(`/friends/requests/${r.id}/accept`, { method: 'POST' }); loadFriendRequests(); loadFriends(); });
      const decline = document.createElement('button');
      decline.className = 'mini-btn danger'; decline.textContent = 'Decline';
      decline.addEventListener('click', async () => { await api(`/friends/requests/${r.id}/decline`, { method: 'POST' }); loadFriendRequests(); });
      row.appendChild(accept); row.appendChild(decline);
      list.appendChild(row);
    });
    outgoing.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'friend-request-item';
      row.appendChild(avatarEl(r.username, r.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name'; name.textContent = `${r.username} (pending)`;
      row.appendChild(name);
      list.appendChild(row);
    });
  }

  function renderFriendsList() {
    el('friends-count').textContent = state.friends.length;
    const list = el('friends-list');
    list.innerHTML = '';
    state.friends.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'friend-item';
      row.appendChild(avatarEl(f.username, f.avatar_color, 24, statusFor(f.id)));
      const name = document.createElement('span');
      name.className = 'item-name'; name.textContent = f.username;
      row.appendChild(name);
      row.addEventListener('click', () => startDm([f.username]));
      const blockBtn = document.createElement('button');
      blockBtn.className = 'mini-btn danger'; blockBtn.textContent = 'Block';
      blockBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Block ${f.username}? This also removes the friendship.`)) return;
        await api('/blocks', { method: 'POST', body: JSON.stringify({ username: f.username }) });
        loadFriends();
      });
      row.appendChild(blockBtn);
      list.appendChild(row);
    });
  }

  el('add-friend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('add-friend-error').textContent = '';
    const username = el('add-friend-username').value.trim();
    if (!username) return;
    try {
      const data = await api('/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
      el('add-friend-username').value = '';
      showToast(data.message);
      loadFriendRequests();
    } catch (err) { el('add-friend-error').textContent = err.message; }
  });

  el('show-blocked-btn').addEventListener('click', async () => {
    const blocked = await api('/blocks');
    const list = el('blocked-list');
    list.innerHTML = '';
    el('blocked-empty-hint').classList.toggle('hidden', blocked.length > 0);
    blocked.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'blocked-item';
      row.appendChild(avatarEl(u.username, u.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name'; name.textContent = u.username;
      row.appendChild(name);
      const unblockBtn = document.createElement('button');
      unblockBtn.className = 'mini-btn'; unblockBtn.textContent = 'Unblock';
      unblockBtn.addEventListener('click', async () => { await api(`/blocks/${u.username}`, { method: 'DELETE' }); el('show-blocked-btn').click(); });
      row.appendChild(unblockBtn);
      list.appendChild(row);
    });
    el('blocked-modal-overlay').classList.remove('hidden');
  });
  el('close-blocked-modal-btn').addEventListener('click', () => el('blocked-modal-overlay').classList.add('hidden'));

  // =========================================================
  // DIRECT MESSAGES
  // =========================================================
  async function loadDms() { state.dms = await api('/dms'); renderDmList(); }

  function dmDisplayName(dm) {
    if (dm.is_group) return dm.name || dm.participants.filter((p) => p.id !== state.user.id).map((p) => p.username).join(', ');
    const other = dm.participants.find((p) => p.id !== state.user.id);
    return other ? other.username : 'Unknown';
  }

  function renderDmList() {
    const list = el('dm-list');
    list.innerHTML = '';
    state.dms.forEach((dm) => {
      const row = document.createElement('div');
      row.className = 'dm-item' + (dm.id === state.currentDmId ? ' active' : '');
      if (dm.is_group) row.innerHTML = `<span class="hash">#</span>`;
      else {
        const other = dm.participants.find((p) => p.id !== state.user.id);
        row.appendChild(avatarEl(other ? other.username : '?', other ? other.avatar_color : null, 22, other ? statusFor(other.id) : null));
      }
      const name = document.createElement('span');
      name.className = 'item-name'; name.textContent = dmDisplayName(dm);
      row.appendChild(name);
      row.addEventListener('click', () => selectDm(dm.id));
      list.appendChild(row);
    });
  }

  async function selectDm(dmId) {
    if (state.mode !== 'home') showHomeView();
    state.currentDmId = dmId;
    renderDmList();

    const dm = state.dms.find((d) => d.id === dmId);
    el('current-channel-name').textContent = dmDisplayName(dm);
    el('chat-header-icon').textContent = dm && dm.is_group ? '#' : '@';
    el('message-input').placeholder = `Message ${dmDisplayName(dm)}`;
    el('message-form').classList.remove('hidden');
    el('message-list').classList.remove('hidden');
    el('voice-view').classList.add('hidden');

    renderDmParticipants(dm);

    const messages = await api(`/dms/${dmId}/messages`);
    const list = el('message-list');
    list.innerHTML = '';
    messages.forEach((m) => appendMessage({ ...m, dm_channel_id: dmId }));
    scrollToBottom();
  }

  function renderDmParticipants(dm) {
    const list = el('member-list');
    list.innerHTML = '';
    if (!dm) return;
    el('member-count').textContent = dm.participants.length;
    dm.participants.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'member-item';
      div.appendChild(avatarEl(p.username, p.avatar_color, 26, statusFor(p.id)));
      const name = document.createElement('span');
      name.textContent = p.username + (p.id === state.user.id ? ' (you)' : '');
      div.appendChild(name);
      list.appendChild(div);
    });
  }

  async function startDm(usernames, groupName) {
    const dm = await api('/dms', { method: 'POST', body: JSON.stringify({ usernames, name: groupName }) });
    if (!state.dms.some((d) => d.id === dm.id)) state.dms.push(dm);
    renderDmList();
    selectDm(dm.id);
    return dm;
  }

  el('new-dm-btn').addEventListener('click', () => el('dm-modal-overlay').classList.remove('hidden'));
  el('close-dm-modal-btn').addEventListener('click', () => el('dm-modal-overlay').classList.add('hidden'));

  el('create-dm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('create-dm-error').textContent = '';
    const usernames = el('dm-usernames').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!usernames.length) { el('create-dm-error').textContent = 'Enter at least one username'; return; }
    try {
      await startDm(usernames, el('dm-group-name').value.trim() || undefined);
      el('dm-usernames').value = ''; el('dm-group-name').value = '';
      el('dm-modal-overlay').classList.add('hidden');
    } catch (err) { el('create-dm-error').textContent = err.message; }
  });

  // =========================================================
  // MESSAGES (shared between channels and DMs)
  // =========================================================
  function appendMessage(msg) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.dataset.messageId = msg.id;
    row.appendChild(avatarEl(msg.username, msg.avatar_color, 36));

    const body = document.createElement('div');
    body.className = 'message-body';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = `<span class="message-author">${escapeHtml(msg.username)}${loomBadgeHtml(msg.loom_active)}</span>`
      + `<span class="message-time">${new Date(msg.created_at).toLocaleString()}</span>`
      + (msg.edited_at ? '<span class="edited-tag">(edited)</span>' : '');
    body.appendChild(meta);

    if (msg.pinned) {
      const banner = document.createElement('div');
      banner.className = 'pinned-banner';
      banner.textContent = '📌 Pinned';
      body.appendChild(banner);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderContentHtml(msg.content);
    body.appendChild(content);

    const reactionsWrap = document.createElement('div');
    reactionsWrap.className = 'message-reactions';
    renderReactionPills(reactionsWrap, msg.id, msg.reactions || []);
    body.appendChild(reactionsWrap);

    row.appendChild(body);
    row.appendChild(buildMessageActions(msg));
    el('message-list').appendChild(row);
  }

  function renderReactionPills(wrap, messageId, reactions) {
    wrap.innerHTML = '';
    reactions.forEach((r) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'reaction-pill' + (r.userIds.includes(state.user.id) ? ' mine' : '');
      pill.innerHTML = `${r.emoji} <span>${r.count}</span>`;
      pill.addEventListener('click', () => toggleReaction(messageId, r.emoji));
      wrap.appendChild(pill);
    });
  }

  function toggleReaction(messageId, emoji) {
    if (state.mode !== 'server') return; // reactions are channel-only for now
    state.socket.emit('message:react', { channelId: state.currentChannelId, messageId, emoji }, (res) => {
      if (res && res.error) showToast(res.error);
    });
  }

  function buildMessageActions(msg) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const isChannel = state.mode === 'server';
    const isMine = msg.user_id === state.user.id;
    const isMod = isChannel && (state.currentServerRole === 'owner' || state.currentServerRole === 'admin');

    if (isChannel) {
      const reactBtn = document.createElement('button');
      reactBtn.className = 'message-action-btn'; reactBtn.title = 'React'; reactBtn.textContent = '😀';
      reactBtn.addEventListener('click', () => openEmojiPicker(reactBtn, REACTION_EMOJIS, (emoji) => toggleReaction(msg.id, emoji)));
      actions.appendChild(reactBtn);
    }

    if (isMine) {
      const editBtn = document.createElement('button');
      editBtn.className = 'message-action-btn'; editBtn.title = 'Edit'; editBtn.textContent = '✏️';
      editBtn.addEventListener('click', () => startEditingMessage(msg));
      actions.appendChild(editBtn);
    }

    if (isChannel && isMod && !isMine) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'message-action-btn'; pinBtn.title = 'Pin/unpin'; pinBtn.textContent = '📌';
      pinBtn.addEventListener('click', () => {
        const row = document.querySelector(`[data-message-id="${msg.id}"]`);
        const alreadyPinned = !!row.querySelector('.pinned-banner');
        state.socket.emit('message:pin', { channelId: state.currentChannelId, messageId: msg.id, pinned: !alreadyPinned });
      });
      actions.appendChild(pinBtn);
    }

    if (isMine || isMod) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'message-action-btn'; deleteBtn.title = 'Delete'; deleteBtn.textContent = '🗑️';
      deleteBtn.addEventListener('click', () => {
        if (!confirm('Delete this message?')) return;
        if (isChannel) state.socket.emit('message:delete', { channelId: state.currentChannelId, messageId: msg.id });
        else state.socket.emit('dm:delete', { dmChannelId: state.currentDmId, messageId: msg.id });
      });
      actions.appendChild(deleteBtn);
    }
    return actions;
  }

  function startEditingMessage(msg) {
    const row = document.querySelector(`[data-message-id="${msg.id}"]`);
    if (!row) return;
    const contentEl = row.querySelector('.message-content');
    const original = contentEl.textContent;
    contentEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.style.cssText = 'width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text-primary);font-size:14px;';
    contentEl.appendChild(input);
    input.focus();

    function save() {
      const newContent = input.value.trim();
      if (!newContent || newContent === original) { contentEl.innerHTML = renderContentHtml(original); return; }
      if (state.mode === 'server') {
        state.socket.emit('message:edit', { channelId: state.currentChannelId, messageId: msg.id, content: newContent });
      } else {
        state.socket.emit('dm:edit', { dmChannelId: state.currentDmId, messageId: msg.id, content: newContent });
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') contentEl.innerHTML = renderContentHtml(original);
    });
    input.addEventListener('blur', save);
  }

  function updateMessageContent(messageId, content, editedAt) {
    const row = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) return;
    row.querySelector('.message-content').innerHTML = renderContentHtml(content);
    if (editedAt && !row.querySelector('.edited-tag')) {
      const tag = document.createElement('span');
      tag.className = 'edited-tag';
      tag.textContent = '(edited)';
      row.querySelector('.message-meta').appendChild(tag);
    }
  }

  function removeMessageEl(messageId) {
    const row = document.querySelector(`[data-message-id="${messageId}"]`);
    if (row) row.remove();
  }

  function updateMessageReactions(messageId, reactions) {
    const row = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) return;
    renderReactionPills(row.querySelector('.message-reactions'), messageId, reactions);
  }

  function markMessagePinned(messageId, pinned) {
    const row = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) return;
    const body = row.querySelector('.message-body');
    let banner = body.querySelector('.pinned-banner');
    if (pinned && !banner) {
      banner = document.createElement('div');
      banner.className = 'pinned-banner';
      banner.textContent = '📌 Pinned';
      body.insertBefore(banner, body.querySelector('.message-content'));
    } else if (!pinned && banner) {
      banner.remove();
    }
  }

  function scrollToBottom() { const list = el('message-list'); list.scrollTop = list.scrollHeight; }

  el('message-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('message-input');
    const content = input.value;
    if (!content.trim()) return;

    if (state.mode === 'server' && state.currentChannelId) {
      state.socket.emit('message:send', { channelId: state.currentChannelId, content }, (res) => { if (res && res.error) showToast(res.error); });
      state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
    } else if (state.mode === 'home' && state.currentDmId) {
      state.socket.emit('dm:send', { dmChannelId: state.currentDmId, content }, (res) => { if (res && res.error) showToast(res.error); });
      state.socket.emit('dm:typing', { dmChannelId: state.currentDmId, isTyping: false });
    } else return;
    input.value = '';
  });

  el('message-input').addEventListener('input', () => {
    if (state.mode === 'server' && state.currentChannelId) {
      state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: true });
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false }), 1500);
    } else if (state.mode === 'home' && state.currentDmId) {
      state.socket.emit('dm:typing', { dmChannelId: state.currentDmId, isTyping: true });
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => state.socket.emit('dm:typing', { dmChannelId: state.currentDmId, isTyping: false }), 1500);
    }
  });

  el('emoji-btn').addEventListener('click', () => {
    openEmojiPicker(el('emoji-btn'), COMPOSE_EMOJIS, (emoji) => {
      const input = el('message-input');
      input.value += emoji;
      input.focus();
    });
  });

  // =========================================================
  // PROFILE
  // =========================================================
  function openProfileModal() {
    el('profile-fullname').value = state.user.fullName || '';
    el('profile-bio').value = state.user.bio || '';
    const swatchWrap = el('avatar-color-swatches');
    swatchWrap.innerHTML = '';
    AVATAR_COLORS.forEach((color) => {
      const sw = document.createElement('div');
      sw.className = 'avatar-swatch' + (color === state.user.avatarColor ? ' selected' : '');
      sw.style.background = color;
      sw.dataset.color = color;
      sw.addEventListener('click', () => { swatchWrap.querySelectorAll('.avatar-swatch').forEach((s) => s.classList.remove('selected')); sw.classList.add('selected'); });
      swatchWrap.appendChild(sw);
    });
    el('profile-error').textContent = '';
    el('profile-modal-overlay').classList.remove('hidden');
  }
  el('close-profile-modal-btn').addEventListener('click', () => el('profile-modal-overlay').classList.add('hidden'));

  el('edit-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('profile-error').textContent = '';
    const selectedSwatch = document.querySelector('.avatar-swatch.selected');
    try {
      const updated = await api('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: el('profile-fullname').value.trim(),
          bio: el('profile-bio').value,
          avatarColor: selectedSwatch ? selectedSwatch.dataset.color : state.user.avatarColor,
        }),
      });
      state.user.fullName = updated.fullName;
      state.user.bio = updated.bio;
      state.user.avatarColor = updated.avatarColor;
      renderMe();
      el('profile-modal-overlay').classList.add('hidden');
      showToast('Profile updated');
    } catch (err) { el('profile-error').textContent = err.message; }
  });

  // =========================================================
  // LOOM
  // =========================================================
  el('loom-btn').addEventListener('click', async () => {
    const status = await api('/premium/me');
    el('loom-status-text').innerHTML = (status.loomActive
      ? `✅ Loom is <strong>active</strong> on your account. Boosts available: <strong>${status.boostsAvailable}</strong>.`
      : `You don't have Loom yet. Boosts available: <strong>${status.boostsAvailable}</strong>.`)
      + `<ul style="margin-top:10px;padding-left:18px;">${status.perks.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
    el('loom-modal-overlay').classList.remove('hidden');
  });
  el('close-loom-modal-btn').addEventListener('click', () => el('loom-modal-overlay').classList.add('hidden'));

  // =========================================================
  // ADMIN
  // =========================================================
  el('admin-btn').addEventListener('click', async () => {
    const users = await api('/admin/users');
    const list = el('admin-user-list');
    list.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      const name = document.createElement('div');
      name.className = 'item-name';
      name.innerHTML = `<strong>${escapeHtml(u.username)}</strong><small>${escapeHtml(u.email)} — ${u.email_verified ? 'verified' : 'unverified'}${u.is_admin ? ' — admin' : ''}</small>`;
      row.appendChild(name);
      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      const loomBtn = document.createElement('button');
      loomBtn.className = 'mini-btn'; loomBtn.textContent = u.loom_active ? 'Revoke Loom' : 'Grant Loom (+3 boosts)';
      loomBtn.addEventListener('click', async () => { await api(`/admin/users/${u.id}/loom`, { method: 'POST', body: JSON.stringify({ active: !u.loom_active }) }); el('admin-btn').click(); });
      actions.appendChild(loomBtn);
      const addBoostBtn = document.createElement('button');
      addBoostBtn.className = 'mini-btn'; addBoostBtn.textContent = '+1 Boost';
      addBoostBtn.addEventListener('click', async () => { await api(`/admin/users/${u.id}/boosts`, { method: 'POST', body: JSON.stringify({ amount: 1 }) }); el('admin-btn').click(); });
      actions.appendChild(addBoostBtn);
      row.appendChild(actions);
      list.appendChild(row);
    });
    el('admin-modal-overlay').classList.remove('hidden');
  });
  el('close-admin-modal-btn').addEventListener('click', () => el('admin-modal-overlay').classList.add('hidden'));

  boot();
})();
