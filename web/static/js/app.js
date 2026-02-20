const $ = id => document.getElementById(id);
let ws, roomCode, isHost = false, audioInfo = null, pausedPosition = 0;
let roomUsers = [], myClientID = null;
let playlist = null, playlistItems = [], currentTrackIndex = -1, playMode = 'sequential';
let trackLoading = false, pendingPlay = null;
let deviceKicked = false;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderAudiencePanel() {
    const list = $('audienceList');
    if (!list) return;
    list.innerHTML = roomUsers.map(u => {
        const hostBadge = u.isHost ? '<span class="host-badge">👑</span>' : '';
        const kickBtn = (isHost && !u.isHost) ? `<button class="btn-kick" data-cid="${escapeHtml(u.clientID)}">踢出</button>` : '';
        return `<div class="audience-row"><span class="audience-info">${hostBadge}${escapeHtml(u.username)} <span class="audience-uid">(UID:${String(u.uid).padStart(5,'0')})</span></span>${kickBtn}</div>`;
    }).join('');
    list.querySelectorAll('.btn-kick').forEach(btn => {
        btn.onclick = () => {
            if (confirm('确定踢出该用户？')) ws.send(JSON.stringify({ type: 'kick', targetClientID: btn.dataset.cid }));
        };
    });
    renderAvatarBar();
}

function renderAvatarBar() {
    const bar = $('avatarBar');
    if (!bar) return;
    const maxShow = 5;
    const show = roomUsers.slice(0, maxShow);
    const overflow = roomUsers.length - maxShow;
    bar.innerHTML = show.map(u => {
        const initial = (u.username || '?')[0].toUpperCase();
        const cls = u.isHost ? 'avatar-bubble owner' : 'avatar-bubble';
        return `<div class="${cls}"><span>${escapeHtml(initial)}</span><span class="avatar-tooltip">${u.isHost ? '👑 ' : ''}${escapeHtml(u.username)}</span></div>`;
    }).join('');
    if (overflow > 0) bar.innerHTML += `<div class="avatar-bubble overflow">+${overflow}</div>`;
    bar.onclick = () => { $('audiencePanel').classList.toggle('hidden'); renderAudiencePanel(); };
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
}

function formatTime(s) {
    if (!s || isNaN(s) || !isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function connect(onOpen) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onopen = () => { console.log('WS connected'); if (onOpen) onOpen(); };
    ws.onmessage = e => handleMessage(JSON.parse(e.data));
    ws.onclose = (ev) => {
        if (deviceKicked) return;
        // 1006 = abnormal close (server rejected, e.g. 401)
        // Check if session is still valid before reconnecting
        fetch('/api/auth/me', {credentials:'include'}).then(r => {
            if (!r.ok) {
                // JWT invalid — kicked by new login on another device
                sessionExpired();
            } else {
                setTimeout(() => connect(() => {
                    // Rejoin room after reconnect
                    if (roomCode) {
                        ws.send(JSON.stringify({ type: 'join', roomCode }));
                    }
                }), 3000);
            }
        }).catch(() => setTimeout(() => connect(() => {
            if (roomCode) ws.send(JSON.stringify({ type: 'join', roomCode }));
        }), 3000));
    };
    ws.onerror = e => console.error('WS error', e);
}

function sessionExpired() {
    deviceKicked = true;
    if (window.audioPlayer) window.audioPlayer.stop();
    stopUIUpdate();
    if (window.clockSync) window.clockSync.stop();
    location.hash = '';
    roomCode = null; isHost = false; audioInfo = null; roomUsers = [];
    alert('你的账号已在其他设备登录，当前会话已失效');
    location.reload();
}

async function handleMessage(msg) {
    console.log('WS:', msg.type, msg);
    switch (msg.type) {
        case 'created':
            // Clean slate for new room
            if (window.audioPlayer) window.audioPlayer.stop();
            stopUIUpdate();
            audioInfo = null; pausedPosition = 0;
            playlist = null; playlistItems = []; currentTrackIndex = -1;
            trackLoading = false; pendingPlay = null;
            $('trackName').textContent = '未选择歌曲';
            $('currentTime').textContent = '0:00';
            $('totalTime').textContent = '0:00';
            $('progressBar').value = 0; $('progressBar').max = 0;
            updatePlayButton(false);
            // fall through to shared logic
        case 'joined':
            roomCode = msg.roomCode; isHost = msg.isHost;
            if (msg.users) { roomUsers = msg.users; renderAudiencePanel(); }
            location.hash = roomCode;
            $('displayCode').textContent = roomCode;
            $('userCount').textContent = msg.clientCount || 1;
            showScreen('room');
            window.clockSync.start(ws);
            if (msg.audio) { audioInfo = msg.audio; await setupAudio(); }
            loadPlaylist();
            $('playlistPanel').classList.remove('hidden');
            break;
        case 'userJoined': case 'userLeft':
            $('userCount').textContent = msg.clientCount;
            if (msg.users) { roomUsers = msg.users; renderAudiencePanel(); }
            break;
        case 'kicked':
            alert('你已被房主移出房间');
            if (window.audioPlayer) window.audioPlayer.stop();
            stopUIUpdate();
            location.hash = '';
            roomCode = null; isHost = false; audioInfo = null; roomUsers = [];
            $('audiencePanel').classList.add('hidden');
            showScreen('home');
            break;
        case 'audioReady':
            audioInfo = msg.audio; await setupAudio(); break;
        case 'play':
            // If play carries trackAudio and we don't have audio loaded, load it first
            if (msg.trackAudio && !audioInfo) {
                await handleTrackChange(msg, true); // join restore, don't re-broadcast play
                if (!pendingPlay) await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
            } else {
                await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
            }
            break;
        case 'pause':
            doPause(); break;
        case 'seek':
            if (window.audioPlayer.isPlaying) {
                await doPlay(msg.position, msg.serverTime, msg.scheduledAt);
            } else {
                pausedPosition = msg.position;
                window.audioPlayer.lastPosition = msg.position;
                window.audioPlayer.startOffset = msg.position;
                $('currentTime').textContent = formatTime(msg.position);
                $('progressBar').value = msg.position;
            }
            break;
        case 'hostTransfer':
            isHost = true;
            $('userCount').textContent = msg.clientCount;
            $('syncStatus').textContent = 'You are now the host';
            if (msg.users) { roomUsers = msg.users; renderAudiencePanel(); }
            break;
        case 'roleChanged':
            // Role was changed by owner
            Auth.updateUIForRole(msg.role);
            if (msg.role === 'user') {
                // If in a room as host, the room will be closed server-side
                // Just update UI
            }
            break;
        case 'roomClosed':
            // Room was closed (e.g. owner demoted)
            alert(msg.error || '房间已关闭');
            if (window.audioPlayer) window.audioPlayer.stop();
            stopUIUpdate();
            location.hash = '';
            roomCode = null; isHost = false; audioInfo = null; roomUsers = [];
            $('audiencePanel').classList.add('hidden');
            showScreen('home');
            break;
        case 'pong': window.clockSync.handlePong(msg); break;
        case 'syncTick':
            // Server-authoritative position sync — bypasses per-client offset differences
            if (window.audioPlayer.isPlaying && msg.position != null) {
                window.audioPlayer.serverPlayTime = msg.serverTime;
                window.audioPlayer.serverPlayPosition = msg.position;
                // Immediate drift check after anchor update (skip debounce)
                const drift = window.audioPlayer.correctDrift(true);
                if (drift) console.log('syncTick drift corrected:', drift, 'ms');
            }
            break;
        case 'deviceKick':
            deviceKicked = true;
            if (window.audioPlayer) window.audioPlayer.stop();
            stopUIUpdate();
            window.clockSync.stop();
            location.hash = '';
            roomCode = null; isHost = false; audioInfo = null; roomUsers = [];
            $('audiencePanel').classList.add('hidden');
            showScreen('home');
            alert(msg.error || '你的账号已在其他设备连接');
            break;
        case 'error': alert(msg.error); break;
        case 'playlistUpdate':
            if (msg.playlistData) {
                const oldItems = playlistItems;
                const oldTrackId = (oldItems && oldItems[currentTrackIndex]) ? oldItems[currentTrackIndex].audio_id : null;
                playlist = msg.playlistData.playlist;
                playlistItems = msg.playlistData.items || [];
                if (playlist) playMode = playlist.play_mode || 'sequential';
                // Adjust currentTrackIndex to follow the same track
                if (oldTrackId != null) {
                    const newIdx = playlistItems.findIndex(it => it.audio_id === oldTrackId);
                    currentTrackIndex = newIdx >= 0 ? newIdx : -1;
                }
                renderPlaylist();
            }
            break;
        case 'trackChange':
            // Server sends full audio metadata — use it directly
            await handleTrackChange(msg);
            break;
    }
}

async function setupAudio() {
    $('trackName').textContent = audioInfo.filename;
    $('totalTime').textContent = formatTime(audioInfo.duration);
    $('progressBar').max = audioInfo.duration;
    $('progressBar').value = 0;
    $('currentTime').textContent = '0:00';
    $('playPauseBtn').disabled = true;
    $('syncStatus').textContent = 'Loading audio...';
    window.audioPlayer.init();
    window.audioPlayer.onBuffering = (buffering) => {
        $('syncStatus').textContent = buffering ? 'Buffering...' : (window.clockSync.synced ? `RTT: ${Math.round(window.clockSync.rtt)}ms | Offset: ${window.clockSync.offset >= 0 ? '+' : ''}${Math.round(window.clockSync.offset)}ms` : 'Ready');
    };
    await window.audioPlayer.loadAudio(audioInfo, roomCode);
    $('playPauseBtn').disabled = false;
    $('syncStatus').textContent = 'Ready';
}

async function doPlay(position, serverTime, scheduledAt) {
    if (trackLoading) {
        // Track still loading from nextTrack — queue this play for when it's ready
        pendingPlay = { position, serverTime, scheduledAt };
        return;
    }
    if (!audioInfo) return;
    pendingPlay = null;
    updatePlayButton(true);
    startUIUpdate();
    window.audioPlayer.init();
    await window.audioPlayer.playAtPosition(position || 0, serverTime, scheduledAt);
}

function doPause() {
    pausedPosition = window.audioPlayer.getCurrentTime() || 0;
    window.audioPlayer.stop();
    updatePlayButton(false);
    stopUIUpdate();
}

let uiInterval = null, driftInterval = null;
function startUIUpdate() {
    stopUIUpdate();
    uiInterval = setInterval(() => {
        if (!window.audioPlayer.isPlaying) return;
        const t = window.audioPlayer.getCurrentTime();
        if (t >= (audioInfo?.duration || Infinity)) { doPause(); onTrackEnd(); return; }
        $('currentTime').textContent = formatTime(t);
        if (!seeking) $('progressBar').value = t;
    }, 250);
    // Aggressive initial sync: check every 200ms for first 5s, then every 1s
    let driftChecks = 0;
    const driftCheck = () => {
        if (!window.audioPlayer.isPlaying) return;
        const drift = window.audioPlayer.correctDrift();
        if (drift) console.log('Drift corrected:', drift, 'ms');
        driftChecks++;
    };
    // Fast phase: 200ms interval for first 25 checks (~5s)
    driftInterval = setInterval(() => {
        driftCheck();
        if (driftChecks >= 25 && driftInterval) {
            clearInterval(driftInterval);
            // Switch to steady-state 1s interval
            driftInterval = setInterval(driftCheck, 1000);
        }
    }, 200);
}
function stopUIUpdate() {
    if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
    if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
}

function updatePlayButton(playing) {
    $('playPauseBtn').textContent = playing ? '⏸' : '▶';
}

// --- Events ---
// Auto-connect on page load for single-device enforcement
window.addEventListener('load', () => {
    const hash = location.hash.replace('#', '').trim();
    if (hash.length === 8) {
        const checkAuth = setInterval(() => {
            if (window.Auth && window.Auth.user) {
                clearInterval(checkAuth);
                connect(() => ws.send(JSON.stringify({ type: 'join', roomCode: hash.toUpperCase() })));
            }
        }, 200);
        setTimeout(() => clearInterval(checkAuth), 5000);
    } else {
        // Connect immediately so server can enforce single-device
        const checkAuth = setInterval(() => {
            if (window.Auth && window.Auth.user) {
                clearInterval(checkAuth);
                connect();
            }
        }, 200);
        setTimeout(() => clearInterval(checkAuth), 5000);
    }
});

function ensureWS(cb) {
    if (ws && ws.readyState === 1) { cb(); return; }
    connect(cb);
}

$('createBtn').onclick = () => ensureWS(() => ws.send(JSON.stringify({ type: 'create' })));
$('joinBtn').onclick = () => {
    const code = $('roomCodeInput').value.trim().toUpperCase();
    if (code.length !== 8) return alert('请输入8位房间码');
    ensureWS(() => ws.send(JSON.stringify({ type: 'join', roomCode: code })));
};
$('roomCodeInput').onkeypress = e => { if (e.key === 'Enter') $('joinBtn').click(); };
$('copyCode').onclick = () => { navigator.clipboard.writeText(roomCode); $('copyCode').textContent = '✓'; setTimeout(() => $('copyCode').textContent = '📋', 1500); };

$('leaveBtn').onclick = () => {
    if (window.audioPlayer) window.audioPlayer.stop();
    stopUIUpdate();
    if (window.clockSync) window.clockSync.stop();
    if (ws) { ws.close(); ws = null; }
    location.hash = '';
    roomCode = null; isHost = false; audioInfo = null; roomUsers = [];
    pausedPosition = 0; playlist = null; playlistItems = []; currentTrackIndex = -1;
    trackLoading = false; pendingPlay = null;
    $('audiencePanel').classList.add('hidden');
    showScreen('home');
};

$('playPauseBtn').onclick = () => {
    if (!isHost || !audioInfo) return;
    if (window.audioPlayer.isPlaying) {
        ws.send(JSON.stringify({ type: 'pause' }));
    } else {
        const pos = window.audioPlayer.getCurrentTime() || 0;
        ws.send(JSON.stringify({ type: 'play', position: pos }));
    }
};

let seeking = false;
$('progressBar').oninput = () => {
    seeking = true;
    const val = parseFloat($('progressBar').value);
    $('currentTime').textContent = formatTime(val);
    $('seekTooltip').textContent = formatTime(val);
    $('seekTooltip').classList.remove('hidden');
};
$('progressBar').onchange = e => {
    seeking = false;
    $('seekTooltip').classList.add('hidden');
    if (!isHost) return;
    const pos = parseFloat(e.target.value) || 0;
    ws.send(JSON.stringify({ type: 'seek', position: pos }));
};

$('volumeSlider').oninput = e => window.audioPlayer.setVolume(e.target.value / 100);

$('audiencePanelClose').onclick = () => $('audiencePanel').classList.add('hidden');
$('copyInviteLink').onclick = () => {
    const link = location.origin + '/#' + roomCode;
    navigator.clipboard.writeText(link);
    $('copyInviteLink').textContent = '✅ 已复制';
    setTimeout(() => $('copyInviteLink').textContent = '📎 复制邀请链接', 1500);
};

// --- Playlist Functions ---

async function loadPlaylist() {
    if (!roomCode) return;
    try {
        const res = await fetch(`/api/room/${roomCode}/playlist`, { method: 'POST', credentials:'include' });
        const data = await res.json();
        playlist = data.playlist;
        playlistItems = data.items || [];
        if (playlist) playMode = playlist.play_mode || 'sequential';
        renderPlaylist();
    } catch (e) { console.error('loadPlaylist:', e); }
}

function renderPlaylist() {
    const container = $('playlistItems');
    const empty = $('playlistEmpty');
    if (!playlistItems || !playlistItems.length) {
        container.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    container.innerHTML = playlistItems.map((item, i) => {
        const active = i === currentTrackIndex ? ' active' : '';
        const delBtn = isHost ? `<button class="pi-del" data-id="${item.id}">✕</button>` : '';
        return `<div class="playlist-item${active}" data-idx="${i}"><div class="pi-info"><div class="pi-title">${escapeHtml(item.title || item.original_name)}</div><div class="pi-meta">${escapeHtml(item.artist || '')} · ${formatTime(item.duration)}</div></div>${delBtn}</div>`;
    }).join('');
    container.querySelectorAll('.pi-del').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            await fetch(`/api/room/${roomCode}/playlist/${id}`, { method: 'DELETE', credentials:'include' });
        };
    });
    container.querySelectorAll('.playlist-item').forEach(el => {
        el.onclick = () => {
            if (!isHost) return;
            const idx = parseInt(el.dataset.idx);
            ws.send(JSON.stringify({ type: 'nextTrack', trackIndex: idx }));
        };
    });
    updatePlayModeBtn();
}

function updatePlayModeBtn() {
    const btn = $('playModeBtn');
    if (playMode === 'shuffle') btn.textContent = '🔀';
    else if (playMode === 'repeat_one') btn.textContent = '🔂';
    else btn.textContent = '🔁';
}

$('playModeBtn').onclick = async () => {
    if (!isHost || !roomCode) return;
    const modes = ['sequential', 'shuffle', 'repeat_one'];
    const next = modes[(modes.indexOf(playMode) + 1) % modes.length];
    await fetch(`/api/room/${roomCode}/playlist/mode`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
        credentials: 'include'
    });
    playMode = next;
    updatePlayModeBtn();
};

// handleTrackChange: server sends full audio metadata via trackChange
async function handleTrackChange(msg, isJoinRestore) {
    const ta = msg.trackAudio;
    if (!ta) return;

    // Stop current playback
    if (window.audioPlayer) window.audioPlayer.stop();
    stopUIUpdate();
    updatePlayButton(false);
    trackLoading = true;
    currentTrackIndex = msg.trackIndex;
    renderPlaylist();

    const qualities = ta.qualities || [];
    const preferredQ = localStorage.getItem('lt_quality') || 'medium';
    // Use user's preferred quality if available, otherwise fallback to medium
    const initialQ = qualities.includes(preferredQ) ? preferredQ
        : qualities.includes('medium') ? 'medium'
        : (qualities[qualities.length - 1] || 'medium');

    try {
        const res = await fetch(`/api/library/files/${ta.audio_id}/segments/${initialQ}/`, {credentials:'include'});
        if (!res.ok) throw new Error('segments fetch failed: ' + res.status);
        const data = await res.json();
        audioInfo = {
            filename: ta.filename,
            duration: data.duration || ta.duration,
            segmentCount: (data.segments || []).length,
            segmentTime: data.segment_time || 5,
            segments: data.segments || [],
            qualities: qualities,
            ownerID: data.owner_id || ta.owner_id,
            audioID: ta.audio_id,
            audioUUID: data.audio_uuid || ta.audio_uuid
        };
        window.audioPlayer._trackSegBase = null;
        await setupAudio();
        updateQualitySelector();
        trackLoading = false;

        // If there's a pending play (non-host received play before track loaded), execute it
        if (pendingPlay) {
            const pp = pendingPlay; pendingPlay = null;
            await doPlay(pp.position, pp.serverTime, pp.scheduledAt);
        } else if (isHost && ws && !isJoinRestore) {
            // Host: track loaded, send play to server (only for active track change, not join restore)
            ws.send(JSON.stringify({ type: 'play', position: 0 }));
        }

        // Phase 2: background quality upgrade temporarily disabled for sync debugging
        // if (preferredQ !== initialQ && qualities.includes(preferredQ)) {
        //     window.audioPlayer._upgradeQuality(preferredQ);
        // }
    } catch (e) {
        console.error('handleTrackChange:', e);
        trackLoading = false;
    }
}

// Legacy fallback: playTrackByIndex still used for pendingTrackIndex from old nextTrack
async function playTrackByIndex(idx) {
    if (!playlistItems || idx < 0 || idx >= playlistItems.length) return;
    // This path is only for backward compat; new flow uses handleTrackChange
    ws.send(JSON.stringify({ type: 'nextTrack', trackIndex: idx }));
}

function updateQualitySelector() {
    const sel = $('qualitySelector');
    if (!sel) return;
    const qualities = window.audioPlayer.getQualities();
    if (!qualities || !qualities.length) { sel.classList.add('hidden'); return; }
    sel.classList.remove('hidden');
    const current = window.audioPlayer.getQuality();
    const actual = window.audioPlayer.getActualQuality();
    const upgrading = window.audioPlayer._upgrading;
    const labels = { lossless: 'Lossless', high: 'High (256k)', medium: 'Medium (128k)', low: 'Low (64k)' };
    sel.innerHTML = qualities.map(q => {
        let label = labels[q] || q;
        if (q === current && upgrading && actual !== current) {
            label = `${labels[actual] || actual} → ${labels[q] || q}`;
        }
        return `<option value="${q}" ${q === current ? 'selected' : ''}>${label}</option>`;
    }).join('');

    // Wire up quality change callback to refresh selector display
    window.audioPlayer.onQualityChange = (actualQ, isUpgrading) => {
        updateQualitySelector();
    };

    sel.onchange = async () => {
        await window.audioPlayer.setQuality(sel.value);
    };
}

function onTrackEnd() {
    if (!isHost || !playlistItems || !playlistItems.length) return;
    let nextIdx = -1;
    if (playMode === 'repeat_one') {
        nextIdx = currentTrackIndex;
    } else if (playMode === 'shuffle') {
        nextIdx = Math.floor(Math.random() * playlistItems.length);
    } else {
        nextIdx = currentTrackIndex + 1;
        if (nextIdx >= playlistItems.length) nextIdx = 0;
    }
    if (nextIdx >= 0 && ws) {
        ws.send(JSON.stringify({ type: 'nextTrack', trackIndex: nextIdx }));
    }
}

// Library modal
$('addFromLibBtn').onclick = async () => {
    if (!isHost) return;
    const modal = $('libraryModal');
    modal.classList.remove('hidden');
    const list = $('libraryList');
    const empty = $('libraryEmpty');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">加载中...</div>';
    empty.style.display = 'none';
    try {
        const res = await fetch('/api/library/files?accessible=true', {credentials:'include'});
        const files = await res.json();
        if (!files || !files.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
        list.innerHTML = files.map(f => `<div class="library-item"><div class="li-info"><div class="li-title">${escapeHtml(f.title)}</div><div class="li-meta">${escapeHtml(f.artist || '')} · ${formatTime(f.duration)}${f.owner_name ? ' · ' + escapeHtml(f.owner_name) : ''}</div></div><button class="btn-add" data-id="${f.id}">添加</button></div>`).join('');
        list.querySelectorAll('.btn-add').forEach(btn => {
            btn.onclick = async () => {
                btn.disabled = true; btn.textContent = '...';
                try {
                    await fetch(`/api/room/${roomCode}/playlist/add`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ audio_id: parseInt(btn.dataset.id) }),
                        credentials: 'include'
                    });
                    btn.textContent = '✓';
                } catch { btn.textContent = '✗'; }
            };
        });
    } catch (e) { list.innerHTML = ''; empty.style.display = 'block'; }
};
$('libraryModalClose').onclick = () => $('libraryModal').classList.add('hidden');
$('libraryModal').onclick = e => { if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden'); };

// === Visibility change: re-sync when page becomes visible ===
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.clockSync && window.audioPlayer.isPlaying) {
        console.log('[sync] page visible, triggering burst re-sync');
        window.clockSync.burst();
        // Immediately catch up on segment scheduling that was throttled in background
        if (window.audioPlayer._scheduleAhead) window.audioPlayer._scheduleAhead();
        setTimeout(() => {
            if (window.audioPlayer.isPlaying) {
                const drift = window.audioPlayer.correctDrift();
                if (drift) console.log('[sync] post-visibility drift corrected:', drift, 'ms');
            }
        }, 500);
    }
});
