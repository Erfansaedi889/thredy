(() => {
  const AVATAR_COLORS = ['#F2B84B', '#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#7289DA', '#43B581'];

  const state = {
    token: localStorage.getItem('thredy_token') || null,
    user: null,
    mode: 'home', // 'home' | 'server'
    servers: [],
    currentServerId: null,
    currentChannelId: null,
    channels: [],
    members: [],
    onlineIds: new Set(),
    socket: null,
    typingTimeout: null,
    friends: [],
    dms: [],
    currentDmId: null,
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

  function showToast(text, ms = 4000) {
    const toast = el('invite-toast');
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
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
        body: JSON.stringify({
          username: el('login-username').value.trim(),
          password: el('login-password').value,
        }),
      });
      onAuthSuccess(data);
    } catch (err) {
      el('login-error').textContent = err.message;
      if (err.data && err.data.needsVerification) {
        el('resend-verification-btn').classList.remove('hidden');
      }
    }
  });

  el('resend-verification-btn').addEventListener('click', async () => {
    const email = prompt('Enter the email you registered with:');
    if (!email) return;
    try {
      const data = await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      showToast(data.message);
      if (data.devVerifyUrl) console.log('[Thredy dev] verification link:', data.devVerifyUrl);
    } catch (err) {
      showToast(err.message);
    }
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('register-error').textContent = '';
    const password = el('register-password').value;
    const confirmPassword = el('register-confirm-password').value;

    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          fullName: el('register-fullname').value.trim(),
          username: el('register-username').value.trim(),
          email: el('register-email').value.trim(),
          phone: el('register-phone').value.trim() || null,
          birthDate: el('register-birthdate').value,
          password,
          confirmPassword,
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
    } catch (err) {
      el('register-error').textContent = err.message;
    }
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
    renderMe();
    connectSocket();
    await Promise.all([loadServers(), loadFriends(), loadFriendRequests(), loadDms()]);
    if (state.user.isAdmin) el('admin-btn').classList.remove('hidden');
    showHomeView();
  }

  function renderMe() {
    [['me-avatar', 'me-username'], ['me-avatar-2', 'me-username-2']].forEach(([avatarId, nameId]) => {
      const avatar = el(avatarId);
      avatar.style.background = state.user.avatarColor;
      avatar.textContent = initials(state.user.username);
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', `${state.user.username}'s avatar`);
      el(nameId).textContent = state.user.username;
    });
    el('me-loom-badge').textContent = state.user.loomActive ? '🧵 Loom active' : 'Online';
  }
  el('me-username').addEventListener('click', openProfileModal);
  el('me-username-2').addEventListener('click', openProfileModal);

  // =========================================================
  // SOCKET
  // =========================================================
  function connectSocket() {
    state.socket = io({ auth: { token: state.token } });

    state.socket.on('message:new', (msg) => {
      if (state.mode === 'server' && msg.channel_id === state.currentChannelId) {
        appendMessage(msg);
        scrollToBottom();
      }
    });

    state.socket.on('dm:new', (msg) => {
      if (state.mode === 'home' && msg.dm_channel_id === state.currentDmId) {
        appendMessage(msg);
        scrollToBottom();
      } else {
        showToast(`New message from ${msg.username}`);
      }
    });

    state.socket.on('presence:update', ({ userId, online }) => {
      if (online) state.onlineIds.add(userId); else state.onlineIds.delete(userId);
      renderMembers();
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

    state.socket.on('server:boosted', ({ serverId, boostCount, boostLevel, boostedBy }) => {
      const server = state.servers.find((s) => s.id === serverId);
      if (server) { server.boost_count = boostCount; server.boost_level = boostLevel; }
      if (state.currentServerId === serverId) renderBoostButton();
      showToast(`${boostedBy} boosted the server! (Level ${boostLevel})`);
    });

    state.socket.on('friend:request', ({ fromUsername }) => {
      showToast(`${fromUsername} sent you a friend request`);
      loadFriendRequests();
    });

    state.socket.on('friend:accepted', ({ byUsername }) => {
      showToast(`${byUsername} accepted your friend request`);
      loadFriends();
    });
  }

  // =========================================================
  // VIEW SWITCHING: home vs server
  // =========================================================
  function showHomeView() {
    state.mode = 'home';
    state.currentChannelId = null;
    el('home-sidebar').classList.remove('hidden');
    el('server-sidebar').classList.add('hidden');
    el('home-btn').classList.add('active');
    renderServerList();
    el('chat-header-icon').textContent = '@';
    el('boost-btn').classList.add('hidden');
    el('member-list-label').innerHTML = 'Participants — <span id="member-count">0</span>';
    if (!state.currentDmId) {
      el('current-channel-name').textContent = 'Select a friend or DM';
      el('message-form').classList.add('hidden');
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

  // =========================================================
  // SERVERS
  // =========================================================
  async function loadServers() {
    state.servers = await api('/servers');
    renderServerList();
  }

  function renderServerList() {
    const list = el('server-list');
    list.innerHTML = '';
    state.servers.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'server-icon' + (state.mode === 'server' && s.id === state.currentServerId ? ' active' : '');
      btn.textContent = initials(s.name);
      btn.title = s.name;
      btn.addEventListener('click', () => selectServer(s.id));
      list.appendChild(btn);
    });
  }

  async function selectServer(serverId) {
    if (state.mode === 'server' && state.currentChannelId) {
      state.socket.emit('channel:leave', state.currentChannelId);
    }

    state.currentServerId = serverId;
    state.currentChannelId = null;
    showServerView();
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
    renderBoostButton();

    const isOwner = server && server.owner_id === state.user.id;
    el('add-channel-btn').classList.toggle('hidden', !isOwner);
    if (isOwner) showToast(`Invite code for this server: ${server.invite_code}`);

    if (channels.length) selectChannel(channels[0].id);
  }

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
    } catch (err) {
      showToast(err.message);
    }
  });

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
    if (state.mode !== 'server') return;
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
      avatarWrap.style.position = 'relative';
      const dot = document.createElement('span');
      dot.className = 'status-dot' + (online ? ' online' : '');
      avatarWrap.appendChild(dot);
      div.appendChild(avatarWrap);
      const name = document.createElement('span');
      name.textContent = m.username;
      div.appendChild(name);
      list.appendChild(div);
    });
  }

  async function selectChannel(channelId) {
    if (state.currentChannelId) state.socket.emit('channel:leave', state.currentChannelId);
    state.currentChannelId = channelId;
    renderChannelList();

    const channel = state.channels.find((c) => c.id === channelId);
    el('current-channel-name').textContent = channel ? channel.name : '';
    el('message-input').placeholder = `Message #${channel ? channel.name : ''}`;
    el('message-form').classList.remove('hidden');

    state.socket.emit('channel:join', channelId);

    const messages = await api(`/messages/${channelId}`);
    const list = el('message-list');
    list.innerHTML = '';
    messages.forEach(appendMessage);
    scrollToBottom();
  }

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

  // =========================================================
  // FRIENDS
  // =========================================================
  async function loadFriends() {
    state.friends = await api('/friends');
    renderFriendsList();
  }

  async function loadFriendRequests() {
    const { incoming, outgoing } = await api('/friends/requests');
    renderFriendRequests(incoming, outgoing);
  }

  function renderFriendRequests(incoming, outgoing) {
    const section = el('friend-requests-section');
    const list = el('friend-requests-list');
    list.innerHTML = '';

    if (!incoming.length && !outgoing.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    incoming.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'friend-request-item';
      row.appendChild(avatarEl(r.username, r.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = r.username;
      row.appendChild(name);
      const accept = document.createElement('button');
      accept.className = 'mini-btn';
      accept.textContent = 'Accept';
      accept.addEventListener('click', async () => {
        await api(`/friends/requests/${r.id}/accept`, { method: 'POST' });
        loadFriendRequests(); loadFriends();
      });
      const decline = document.createElement('button');
      decline.className = 'mini-btn danger';
      decline.textContent = 'Decline';
      decline.addEventListener('click', async () => {
        await api(`/friends/requests/${r.id}/decline`, { method: 'POST' });
        loadFriendRequests();
      });
      row.appendChild(accept);
      row.appendChild(decline);
      list.appendChild(row);
    });

    outgoing.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'friend-request-item';
      row.appendChild(avatarEl(r.username, r.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = `${r.username} (pending)`;
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
      row.appendChild(avatarEl(f.username, f.avatar_color, 24));
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = f.username;
      row.appendChild(name);
      row.addEventListener('click', () => startDm([f.username]));

      const blockBtn = document.createElement('button');
      blockBtn.className = 'mini-btn danger';
      blockBtn.textContent = 'Block';
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
    } catch (err) {
      el('add-friend-error').textContent = err.message;
    }
  });

  // ---------- Blocked users ----------
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
      name.className = 'item-name';
      name.textContent = u.username;
      row.appendChild(name);
      const unblockBtn = document.createElement('button');
      unblockBtn.className = 'mini-btn';
      unblockBtn.textContent = 'Unblock';
      unblockBtn.addEventListener('click', async () => {
        await api(`/blocks/${u.username}`, { method: 'DELETE' });
        el('show-blocked-btn').click();
      });
      row.appendChild(unblockBtn);
      list.appendChild(row);
    });
    el('blocked-modal-overlay').classList.remove('hidden');
  });
  el('close-blocked-modal-btn').addEventListener('click', () => el('blocked-modal-overlay').classList.add('hidden'));

  // =========================================================
  // DIRECT MESSAGES
  // =========================================================
  async function loadDms() {
    state.dms = await api('/dms');
    renderDmList();
  }

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
      if (dm.is_group) {
        row.innerHTML = `<span class="hash">#</span>`;
      } else {
        const other = dm.participants.find((p) => p.id !== state.user.id);
        row.appendChild(avatarEl(other ? other.username : '?', other ? other.avatar_color : null, 22));
      }
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = dmDisplayName(dm);
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
      div.appendChild(avatarEl(p.username, p.avatar_color, 26));
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
      el('dm-usernames').value = '';
      el('dm-group-name').value = '';
      el('dm-modal-overlay').classList.add('hidden');
    } catch (err) {
      el('create-dm-error').textContent = err.message;
    }
  });

  // =========================================================
  // MESSAGES (shared between channels and DMs)
  // =========================================================
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
    if (!content.trim()) return;

    if (state.mode === 'server' && state.currentChannelId) {
      state.socket.emit('message:send', { channelId: state.currentChannelId, content }, (res) => {
        if (res && res.error) showToast(res.error);
      });
      state.socket.emit('typing', { channelId: state.currentChannelId, isTyping: false });
    } else if (state.mode === 'home' && state.currentDmId) {
      state.socket.emit('dm:send', { dmChannelId: state.currentDmId, content }, (res) => {
        if (res && res.error) showToast(res.error);
      });
      state.socket.emit('dm:typing', { dmChannelId: state.currentDmId, isTyping: false });
    } else {
      return;
    }
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
      sw.addEventListener('click', () => {
        swatchWrap.querySelectorAll('.avatar-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
      });
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
    } catch (err) {
      el('profile-error').textContent = err.message;
    }
  });

  // =========================================================
  // LOOM
  // =========================================================
  el('loom-btn').addEventListener('click', async () => {
    const status = await api('/premium/me');
    el('loom-status-text').innerHTML = status.loomActive
      ? `✅ Loom is <strong>active</strong> on your account. Boosts available: <strong>${status.boostsAvailable}</strong>.`
      : `You don't have Loom yet. Boosts available: <strong>${status.boostsAvailable}</strong>.`;
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
      loomBtn.className = 'mini-btn';
      loomBtn.textContent = u.loom_active ? 'Revoke Loom' : 'Grant Loom (+3 boosts)';
      loomBtn.addEventListener('click', async () => {
        await api(`/admin/users/${u.id}/loom`, { method: 'POST', body: JSON.stringify({ active: !u.loom_active }) });
        el('admin-btn').click();
      });
      actions.appendChild(loomBtn);

      const addBoostBtn = document.createElement('button');
      addBoostBtn.className = 'mini-btn';
      addBoostBtn.textContent = '+1 Boost';
      addBoostBtn.addEventListener('click', async () => {
        await api(`/admin/users/${u.id}/boosts`, { method: 'POST', body: JSON.stringify({ amount: 1 }) });
        el('admin-btn').click();
      });
      actions.appendChild(addBoostBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
    el('admin-modal-overlay').classList.remove('hidden');
  });
  el('close-admin-modal-btn').addEventListener('click', () => el('admin-modal-overlay').classList.add('hidden'));

  boot();
})();
