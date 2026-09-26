const SUPABASE_URL = 'https://yhzwkewubrllgmezxpcr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_sXOS0sc3hoddprV518CkSA_ksknzBqK';
const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const AVATARS = Array.from({length:12}, (_,i) => `https://api.dicebear.com/9.x/bottts/svg?seed=GuildPlay${i+1}`);
const GAMES = [
  { id: 'dotdome', name: 'Dot Dome', icon: '⚄', desc: 'Multiplayer territory capture.' },
  { id: 'ttt', name: 'Neon Tic Tac Toe', icon: '✕', desc: 'Two turns on one device.' },
  { id: 'snake', name: 'Neon Snake', icon: '🐍', desc: 'Classic local arcade challenge.' }
];

let player = JSON.parse(localStorage.getItem('gp_player') || 'null');
let selectedAvatar = 0;
let selectedFriend = null;
let requests = [];
let room = { id: 'GP-ROOM', members: [], isCreated: false, ownerUid: null };
let deferredInstall = null;

// Channels & WebRTC
let dmChannel = null;
let roomChannel = null;
let userChannel = null;
let friendshipChannel = null;
let inviteTimeout = null;

let localStream = null;
let isMicOn = false;
let isDeafened = false;
let audioContext = null;
let analyser = null;
let micAnimationId = null;
const peerConnections = {};
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)];

function uid(){ 
  return 'GP-' + Math.random().toString(36).slice(2,8).toUpperCase(); 
}

function save(){ 
  localStorage.setItem('gp_player', JSON.stringify(player)); 
}

function esc(s){ 
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); 
}

function setup(){
  try {
    const grid = $('#avatar-grid');
    if(grid){
      grid.innerHTML = '';
      AVATARS.forEach((src, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'avatar-choice' + (i === 0 ? ' selected' : '');
        b.innerHTML = `<img src="${src}" alt="Avatar ${i+1}">`;
        b.onclick = () => {
          $$('.avatar-choice').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
          selectedAvatar = i;
        };
        grid.appendChild(b);
      });
    }

    const enterBtn = $('#enter-btn');
    if(enterBtn){
      enterBtn.onclick = () => {
        const nameInput = $('#setup-name');         const name = nameInput ? nameInput.value.trim() : '';         if(!name){            nameInput?.focus();            return;          }         player = { name, uid: uid(), avatar: AVATARS[selectedAvatar] };         save();         enterApp();       };     }      if(player) {       enterApp();     }      $$('.nav-btn').forEach(b => {
      b.onclick = () => {
        if(b.classList.contains('nav-disabled')) return;
        switchTab(b.dataset.tab);
      };
    });

    $('#direct-form')?.addEventListener('submit', e => { 
      e.preventDefault(); 
      sendDirectMessage(); 
      $('#direct-input')?.blur(); 
    });

    $('#direct-input')?.addEventListener('keydown', e => {
      if(e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        sendDirectMessage();
        $('#direct-input')?.blur();
      }
    });

    $('#group-form')?.addEventListener('submit', e => { 
      e.preventDefault(); 
      sendGroup(); 
      $('#group-input')?.blur(); 
    });

    $('#game-group-form')?.addEventListener('submit', e => { 
      e.preventDefault(); 
      sendGameGroup(); 
      $('#game-group-input')?.blur(); 
    });
    
    $('#search-btn')?.addEventListener('click', () => { 
      searchFriend(); 
      $('#friend-search')?.blur(); 
    });

    $('#friend-search')?.addEventListener('keydown', e => { 
      if(e.key === 'Enter'){ 
        e.preventDefault(); 
        searchFriend(); 
        $('#friend-search')?.blur(); 
      } 
    });

    // Room Host Play Click (Synchronized game start for all players)
    $('#room-play')?.addEventListener('click', () => {
      if(room.ownerUid !== player.uid){
        alert('Only Room Owner can launch games.');
        return;
      }
      const gameId = $('#room-game-select')?.value;
      if(roomChannel){
        roomChannel.send({ type: 'broadcast', event: 'game_start', payload: { gameId } });
      }
      openGame(gameId, true);
    });

    $('#game-exit')?.addEventListener('click', closeGame);
    $('#game-chat-toggle')?.addEventListener('click', toggleGameChat);

    $('#mic-btn')?.addEventListener('click', toggleMic);
    $('#game-mic-btn')?.addEventListener('click', toggleMic);
    $('#speaker-btn')?.addEventListener('click', toggleSpeaker);
    $('#game-speaker-btn')?.addEventListener('click', toggleSpeaker);

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstall = e;
      const btn = $('#install-btn');
      if(btn) btn.classList.remove('hidden');
    });

    $('#install-btn')?.addEventListener('click', () => {
      if(deferredInstall){
        deferredInstall.prompt();
        deferredInstall = null;
        $('#install-btn').classList.add('hidden');
      }
    });

    renderGames();
  } catch(err){
    console.error('Setup error:', err);
  }
}

function enterApp(){
  try {
    const setupEl = $('#setup');
    if(setupEl) setupEl.classList.add('hidden');
    const appEl = $('#app');     if(appEl) appEl.classList.remove('hidden');      renderFriends();     renderRequests();     listenForInvites();     listenFriendshipChanges();      if(sb && player){       sb.from('profiles').upsert({         uid: player.uid,         name: player.name,         avatar: player.avatar,         online: true       }).then(() => {}).catch(err => console.warn('Profile sync background error:', err));     }   } catch(err){     console.error('enterApp error:', err);   } }  function switchTab(tab){   $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));$$('.tab-view').forEach(v => v.classList.remove('active-view'));$('#tab-' + tab)?.classList.add('active-view');
}

// ---------------- Realtime Friendship Listeners ---------------- //
function listenFriendshipChanges(){
  if(!sb || !player) return;
  try {
    if(friendshipChannel) sb.removeChannel(friendshipChannel);

    friendshipChannel = sb
      .channel('public:friendships_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        renderFriends();
        renderRequests();
      })
      .subscribe();
  } catch(err){
    console.error('Friendship sync error:', err);
  }
}

// ---------------- Room Lifecycle (Create & Exit) ---------------- //
function toggleRoomState(){
  if(!room.isCreated){
    // CREATE ROOM
    room.isCreated = true;
    room.ownerUid = player.uid;
    room.id = 'ROOM-' + Math.random().toString(36).slice(2,7).toUpperCase();
    room.members = [{ uid: player.uid, name: player.name, avatar: player.avatar }];

    const actBtn = $('#room-action-btn');
    if(actBtn){
      actBtn.textContent = 'Exit';
      actBtn.style.background = '#ef4444';
    }
    $('#room-content-wrapper')?.classList.remove('room-locked');      $$('.nav-btn').forEach(b => {
      if(b.dataset.tab !== 'room') b.classList.add('nav-disabled');
    });

    $('#room-game-select')?.removeAttribute('disabled');
    $('#room-play')?.removeAttribute('disabled');

    const codeEl = $('#room-code');
    if(codeEl) codeEl.textContent = room.id;

    joinRoomRealtime();
    renderRoomMembers();
    renderInviteList();
  } else {
    // EXIT ROOM
    exitRoomHandler(player.uid === room.ownerUid);
  }
}

function exitRoomHandler(isOwner = false){
  if(isOwner && roomChannel){
    roomChannel.send({ type: 'broadcast', event: 'room_closed', payload: {} });
  }

  if(roomChannel){
    sb?.removeChannel(roomChannel);
    roomChannel = null;
  }
  if(localStream){
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if(audioContext){
    audioContext.close();
    audioContext = null;
  }
  isMicOn = false;
  updateMicUI();

  room.isCreated = false;
  room.ownerUid = null;
  room.members = [];

  const actBtn = $('#room-action-btn');
  if(actBtn){
    actBtn.textContent = 'Create';
    actBtn.style.background = '';
  }
  $('#room-content-wrapper')?.classList.add('room-locked');

  const box1 = $('#group-messages');
  const box2 = $('#game-group-messages');   if(box1) box1.innerHTML = '';   if(box2) box2.innerHTML = '';    $$('.nav-btn').forEach(b => b.classList.remove('nav-disabled'));
  renderRoomMembers();
}

function kickMember(targetUid){
  if(room.ownerUid !== player.uid || !roomChannel) return;
  roomChannel.send({
    type: 'broadcast',
    event: 'kick_player',
    payload: { targetUid }
  });
  room.members = room.members.filter(m => m.uid !== targetUid);
  renderRoomMembers();
}

// ---------------- Realtime Room Presence & Broadcasts ---------------- //
function joinRoomRealtime(){
  if(!sb || !player) return;

  try {
    if(roomChannel) sb.removeChannel(roomChannel);

    roomChannel = sb.channel(`room:${room.id}`, {
      config: { presence: { key: player.uid } }
    });

    roomChannel
      .on('presence', { event: 'sync' }, () => {
        const state = roomChannel.presenceState();
        const activeMembers = [];
        Object.values(state).forEach(presences => {
          presences.forEach(p => {
            if(!activeMembers.some(m => m.uid === p.uid)) activeMembers.push(p);
          });
        });
        activeMembers.sort((a,b) => (a.uid === room.ownerUid ? -1 : 1));
        room.members = activeMembers;
        renderRoomMembers();
      })
      .on('broadcast', { event: 'group_message' }, payload => {
        const { senderName, text, senderUid } = payload.payload;
        if(senderUid !== player.uid) appendGroup(senderName, text, false);
      })
      .on('broadcast', { event: 'game_start' }, payload => {
        openGame(payload.payload.gameId, true);
      })
      .on('broadcast', { event: 'kick_player' }, payload => {
        if(payload.payload.targetUid === player.uid){
          alert('You were removed from the room by the host.');
          exitRoomHandler(false);
        }
      })
      .on('broadcast', { event: 'room_closed' }, () => {
        alert('Host has closed the room.');
        exitRoomHandler(false);
      })
      .on('broadcast', { event: 'speaking_status' }, payload => {
        const { senderUid, isSpeaking } = payload.payload;
        const avatarEl = $(`#member-avatar-${senderUid}`);
        if(avatarEl) avatarEl.classList.toggle('speaking', isSpeaking);
      })
      .on('broadcast', { event: 'rtc_signal' }, async payload => {
        const data = payload.payload;
        if(data.targetUid !== player.uid) return;
        const pc = getOrCreatePC(data.senderUid);
        if(data.offer){
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          if(localStream){
            localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          roomChannel.send({ type: 'broadcast', event: 'rtc_signal', payload: { targetUid: data.senderUid, senderUid: player.uid, answer } });
        } else if(data.answer){
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        } else if(data.candidate){
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
        }
      })
      // Dot Dome Game Events
    .on('broadcast', { event: 'dotdome_event' }, payload => {
      const frame = $('#dotdome-frame');
      if(frame && frame.contentWindow){
        frame.contentWindow.postMessage({
          type: 'DOTDOME_REMOTE_ACTION',
          payload: payload.payload
        }, '*');
      }
    })
      .subscribe(async (status) => {
        if(status === 'SUBSCRIBED'){
          await roomChannel.track({
            uid: player.uid,
            name: player.name,
            avatar: player.avatar,
            online: true
          });
        }
      });
  } catch(err){
    console.error('joinRoomRealtime error:', err);
  }
}

function renderRoomMembers(){
  const memberEl = $('#member-count');
  if(memberEl) memberEl.textContent = `${room.members.length}/8`;

  const roomMembers = $('#room-members');
  if(!roomMembers) return;

  const isOwner = player?.uid === room.ownerUid;

  if(!isOwner){
    $('#room-game-select')?.setAttribute('disabled', 'true');
    $('#room-play')?.setAttribute('disabled', 'true');
  } else {
    $('#room-game-select')?.removeAttribute('disabled');
    $('#room-play')?.removeAttribute('disabled');
  }

  roomMembers.innerHTML = room.members.map(m => `
    <div class="member-row" style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      <div id="member-avatar-${m.uid}" class="mini-avatar">
        <img src="${m.avatar}">
      </div>
      <strong>${esc(m.name)}</strong>
      ${isOwner && m.uid !== player.uid ? `<button type="button" class="kick-btn" onclick="kickMember('${m.uid}')">✕</button>` : ''}
    </div>
  `).join('');
}

// ---------------- Voice & Speaking Detection ---------------- //
function updateMicUI(){
  const icon = isMicOn ? '🎙' : '🎙❌';
  const mic1 = $('#mic-btn');
  const mic2 = $('#game-mic-btn');
  if(mic1) mic1.textContent = icon;
  if(mic2) mic2.textContent = icon;
}

function updateSpeakerUI(){
  const icon = isDeafened ? '🔊❌' : '🔊';
  const spk1 = $('#speaker-btn');
  const spk2 = $('#game-speaker-btn');   if(spk1) spk1.textContent = icon;   if(spk2) spk2.textContent = icon; }  async function toggleMic(){   if(!room.isCreated){     alert('Please create or join a room first!');     return;   }    isMicOn = !isMicOn;   updateMicUI();    if(isMicOn){     try {       localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });       setupSpeakingDetector(localStream);        Object.values(peerConnections).forEach(pc => {         localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));       });        room.members.forEach(m => {         if(m.uid !== player.uid) initiatePeerConnection(m.uid);       });     } catch(err){       alert('Microphone permission required.');       isMicOn = false;       updateMicUI();     }   } else {     if(localStream){       localStream.getTracks().forEach(t => t.stop());       localStream = null;     }     if(micAnimationId) cancelAnimationFrame(micAnimationId);     broadcastSpeaking(false);   } }  function toggleSpeaker(){   isDeafened = !isDeafened;   updateSpeakerUI();   $$('audio.remote-audio').forEach(audio => { audio.muted = isDeafened; });
}

function setupSpeakingDetector(stream){
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;

    function detect(){
      if(!isMicOn) return;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
      let avg = sum / dataArray.length;

      let isSpeaking = avg > 25;
      if(isSpeaking !== wasSpeaking){
        wasSpeaking = isSpeaking;
        broadcastSpeaking(isSpeaking);
      }
      micAnimationId = requestAnimationFrame(detect);
    }
    detect();
  } catch(e){
    console.error('Speaking detector error:', e);
  }
}

function broadcastSpeaking(isSpeaking){
  const avatarEl = $(`#member-avatar-${player.uid}`);
  if(avatarEl) avatarEl.classList.toggle('speaking', isSpeaking);

  if(roomChannel){
    roomChannel.send({
      type: 'broadcast',
      event: 'speaking_status',
      payload: { senderUid: player.uid, isSpeaking }
    });
  }
}

function getOrCreatePC(peerUid){
  if(peerConnections[peerUid]) return peerConnections[peerUid];
  const pc = new RTCPeerConnection(rtcConfig);
  pc.ontrack = (event) => {
    let audio = document.getElementById(`audio-${peerUid}`);
    if(!audio){
      audio = document.createElement('audio');
      audio.id = `audio-${peerUid}`;
      audio.className = 'remote-audio';
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.muted = isDeafened;
  };
  pc.onicecandidate = (event) => {
    if(event.candidate && roomChannel){
      roomChannel.send({
        type: 'broadcast',
        event: 'rtc_signal',
        payload: { targetUid: peerUid, senderUid: player.uid, candidate: event.candidate }
      });
    }
  };
  peerConnections[peerUid] = pc;
  return pc;
}

async function initiatePeerConnection(peerUid){
  const pc = getOrCreatePC(peerUid);
  if(localStream){
    localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if(roomChannel){
    roomChannel.send({
      type: 'broadcast',
      event: 'rtc_signal',
      payload: { targetUid: peerUid, senderUid: player.uid, offer }
    });
  }
}

// ---------------- Invite & Modal Handling ---------------- //
async function renderInviteList(){
  const inviteList = $('#invite-list');
  if(!inviteList || !sb || !player) return;

  try {
    const { data, error } = await sb
      .from('friendships')
      .select('user_uid, friend_uid')
      .eq('status', 'accepted')
      .or(`user_uid.eq.${player.uid},friend_uid.eq.${player.uid}`);

    if(error) throw error;
    const friendUids = (data || []).map(r => r.user_uid === player.uid ? r.friend_uid : r.user_uid);

    if(!friendUids.length){
      inviteList.innerHTML = '<div class="empty-chat">No friends yet.</div>';
      return;
    }

    const { data: onlineFriends } = await sb
      .from('profiles')
      .select('*')
      .in('uid', friendUids);

    const roomMemberUids = room.members.map(m => m.uid);
    const available = (onlineFriends || []).filter(f => !roomMemberUids.includes(f.uid));

    if(!available.length){
      inviteList.innerHTML = '<div class="empty-chat">No friends available to invite.</div>';
      return;
    }

    inviteList.innerHTML = available.map(f => `
      <div class="friend-row">
        <div class="mini-avatar">
          <img src="${f.avatar}">
        </div>
        <strong>${esc(f.name)}</strong>
        <button type="button" class="primary-btn" onclick="sendRoomInvite('${f.uid}', '${esc(f.name)}')">Invite</button>
      </div>
    `).join('');
  } catch(err){
    console.error('Invite list error:', err);
  }
}

function sendRoomInvite(targetUid, targetName){
  if(!sb || !player || !roomChannel) return;
  const targetChannel = sb.channel(`user:${targetUid}`);
  targetChannel.subscribe(status => {
    if(status === 'SUBSCRIBED'){
      targetChannel.send({
        type: 'broadcast',
        event: 'room_invite',
        payload: {
          roomId: room.id,
          hostName: player.name,
          hostUid: player.uid
        }
      });
      alert(`Invite sent to ${targetName}!`);
      setTimeout(() => sb.removeChannel(targetChannel), 2500);
    }
  });
}

function listenForInvites(){
  if(!sb || !player) return;
  try {
    if(userChannel) sb.removeChannel(userChannel);

    userChannel = sb.channel(`user:${player.uid}`);
    userChannel
      .on('broadcast', { event: 'room_invite' }, payload => {
        const { roomId, hostName, hostUid } = payload.payload;
        showInviteModal(roomId, hostName, hostUid);
      })
      .subscribe();
  } catch(err){
    console.error('listenForInvites error:', err);
  }
}

function showInviteModal(roomId, hostName, hostUid){
  const old = $('#invite-modal');
  if(old) old.remove();
  if(inviteTimeout) clearInterval(inviteTimeout);

  let timeLeft = 10;
  const modalHtml = document.createElement('div');
  modalHtml.id = 'invite-modal';
  modalHtml.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 99999;
    background: #121829; border: 2px solid #3b82f6; border-radius: 12px;
    padding: 16px; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    display: flex; flex-direction: column; gap: 10px; max-width: 300px;
  `;
  modalHtml.innerHTML = `
    <strong>🎮 Room Invite!</strong>
    <p style="margin:0; font-size:13px;"><strong>${esc(hostName)}</strong> invited you to join.</p>
    <div style="font-size:12px; color:#f59e0b;">Expiring in <span id="invite-timer">10</span>s...</div>
    <div style="display:flex; gap:8px;">
      <button id="accept-invite-btn" style="flex:1; background:#10b981; color:#fff; border:none; padding:8px; border-radius:6px; cursor:pointer; font-weight:bold;">Join</button>
      <button id="decline-invite-btn" style="flex:1; background:#ef4444; color:#fff; border:none; padding:8px; border-radius:6px; cursor:pointer;">Decline</button>
    </div>
  `;
  document.body.appendChild(modalHtml);

  inviteTimeout = setInterval(() => {
    timeLeft--;
    const t = $('#invite-timer');
    if(t) t.textContent = timeLeft;
    if(timeLeft <= 0){
      clearInterval(inviteTimeout);
      modalHtml.remove();
    }
  }, 1000);

  $('#accept-invite-btn').onclick = () => {
    clearInterval(inviteTimeout);
    modalHtml.remove();

    room.isCreated = true;
    room.id = roomId;
    room.ownerUid = hostUid;

    switchTab('room');
    const actBtn = $('#room-action-btn');
    if(actBtn){
      actBtn.textContent = 'Exit';
      actBtn.style.background = '#ef4444';
    }
    $('#room-content-wrapper')?.classList.remove('room-locked');      $$('.nav-btn').forEach(b => {
      if(b.dataset.tab !== 'room') b.classList.add('nav-disabled');
    });

    joinRoomRealtime();
  };

  $('#decline-invite-btn').onclick = () => {
    clearInterval(inviteTimeout);
    modalHtml.remove();
  };
}

// ---------------- Chat Handlers ---------------- //
function sendGroup(){
  const i = $('#group-input');
  if(!i) return;
  const t = i.value.trim();
  if(!t || !player) return;

  appendGroup(player.name, t, true);
  if(roomChannel){
    roomChannel.send({
      type: 'broadcast',
      event: 'group_message',
      payload: { senderName: player.name, text: t, senderUid: player.uid }
    });
  }
  i.value = '';
}

function sendGameGroup(){
  const i = $('#game-group-input');
  if(!i) return;
  const t = i.value.trim();
  if(!t || !player) return;

  appendGroup(player.name, t, true);
  if(roomChannel){
    roomChannel.send({
      type: 'broadcast',
      event: 'group_message',
      payload: { senderName: player.name, text: t, senderUid: player.uid }
    });
  }
  i.value = '';
}

function appendGroup(name, text, mine){
  const markup = `<div class="bubble ${mine?'mine':''}"><small>${esc(name)}</small>${esc(text)}</div>`;
  const box1 = $('#group-messages');
  const box2 = $('#game-group-messages');
  if(box1){ box1.innerHTML += markup; box1.scrollTop = box1.scrollHeight; }
  if(box2){ box2.innerHTML += markup; box2.scrollTop = box2.scrollHeight; }
}

async function renderFriends(){
  if(!sb || !player) return;
  const list = $('#friends-list');

  try {
    const { data } = await sb
      .from('friendships')
      .select('user_uid, friend_uid')
      .eq('status', 'accepted')
      .or(`user_uid.eq.${player.uid},friend_uid.eq.${player.uid}`);

    const friendUids = (data || []).map(r => r.user_uid === player.uid ? r.friend_uid : r.user_uid);
    const countEl = $('#friend-count');
    if(countEl) countEl.textContent = friendUids.length;

    if(!friendUids.length){
      if(list) list.innerHTML = '<div class="empty-chat">No friends yet.</div>';
      return;
    }

    const { data: profiles } = await sb.from('profiles').select('*').in('uid', friendUids);

    if(list){
      list.innerHTML = '';
      (profiles || []).forEach(f => {
        const row = document.createElement('div');
        row.className = 'friend-row';
        row.innerHTML = `
          <div class="mini-avatar ${f.online ? 'online' : 'offline'}">
            <img src="${f.avatar}">
          </div>
          <strong>${esc(f.name)}</strong>
        `;
        row.onclick = () => selectFriend(f);
        list.appendChild(row);
      });
    }
  } catch(err){
    console.error('renderFriends error:', err);
  }
}

function selectFriend(f){
  selectedFriend = f;
  const title = $('#chat-title');
  if(title) title.textContent = f.name;
  const status = $('#chat-status');
  if(status) status.textContent = f.online ? 'Online' : 'Offline';
  renderDirectMessages();
  listenDirectMessages();
}

async function renderDirectMessages(){
  const box = $('#direct-messages');
  if(!box || !selectedFriend || !sb) return;

  try {
    const { data } = await sb
      .from('direct_messages')
      .select('*')
      .or(`and(sender_uid.eq.${player.uid},receiver_uid.eq.${selectedFriend.uid}),and(sender_uid.eq.${selectedFriend.uid},receiver_uid.eq.${player.uid})`)
      .order('created_at', { ascending: true });

    if(!data || !data.length){
      box.innerHTML = `<div class="empty-chat">No messages yet with <strong>${esc(selectedFriend.name)}</strong>.</div>`;
      return;
    }

    box.innerHTML = data.map(m => {
      const isMine = m.sender_uid === player.uid;
      return `<div class="bubble ${isMine ? 'mine' : ''}"><small>${esc(isMine ? player.name : selectedFriend.name)}</small>${esc(m.text)}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  } catch(err){
    console.error('renderDirectMessages error:', err);
  }
}

async function sendDirectMessage(){
  if(!selectedFriend || !sb || !player) return;
  const input = $('#direct-input');
  const text = input ? input.value.trim() : '';
  if(!text) return;
  input.value = '';

  await sb.from('direct_messages').insert({ sender_uid: player.uid, receiver_uid: selectedFriend.uid, text });
  renderDirectMessages();
}

function listenDirectMessages(){
  if(!sb || !selectedFriend || !player) return;
  try {
    if(dmChannel) sb.removeChannel(dmChannel);

    dmChannel = sb
      .channel('public:direct_messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, payload => {
        const msg = payload.new;
        if((msg.sender_uid === player.uid && msg.receiver_uid === selectedFriend.uid) ||
           (msg.sender_uid === selectedFriend.uid && msg.receiver_uid === player.uid)){
          renderDirectMessages();
        }
      })
      .subscribe();
  } catch(err){
    console.error('listenDirectMessages error:', err);
  }
}

async function searchFriend(){
  const q = $('#friend-search')?.value.trim();
  const box = $('#search-result');
  if(!box || !q) return;

  try {
    const { data } = await sb.from('profiles').select('*').or(`uid.ilike.%${q}%,name.ilike.%${q}%`).neq('uid', player.uid).limit(5);
    if(!data || !data.length){
      box.innerHTML = '<div class="result-card"><div class="request-row"><strong>No players found</strong></div></div>';
      return;
    }

    box.innerHTML = data.map(u => `
      <div class="result-card">
        <div class="request-row" style="display:flex; align-items:center; gap:10px;">
          <div class="mini-avatar"><img src="${u.avatar}"></div>
          <strong>${esc(u.name)}</strong>
          <button onclick="sendFriendRequest('${u.uid}')" style="margin-left:auto;">Add</button>
        </div>
      </div>
    `).join('');
  } catch(err){
    console.error('searchFriend error:', err);
  }
}

async function sendFriendRequest(targetUid){
  if(!sb || !player) return;
  await sb.from('friendships').insert({ user_uid: player.uid, friend_uid: targetUid, status: 'pending' });
  alert('Friend request sent!');
}

async function renderRequests(){
  if(!sb || !player) return;
  const list = $('#requests-list');
  try {
    const { data } = await sb.from('friendships').select('id, user_uid, profiles!friendships_user_uid_fkey(name, avatar)').eq('friend_uid', player.uid).eq('status', 'pending');

    requests = data || [];
    const countEl = $('#request-count');
    if(countEl) countEl.textContent = requests.length;

    if(!requests.length){
      if(list) list.innerHTML = '<div class="empty-chat">No pending requests.</div>';
      return;
    }

    if(list){
      list.innerHTML = requests.map(r => `
        <div class="request-row" style="display:flex; align-items:center; gap:10px;">
          <div class="mini-avatar"><img src="${r.profiles?.avatar}"></div>
          <strong>${esc(r.profiles?.name || 'Player')}</strong>
          <button onclick="acceptReq(${r.id})" style="margin-left:auto;">Accept</button>
          <button onclick="denyReq(${r.id})">Deny</button>
        </div>
      `).join('');
    }
  } catch(err){
    console.error('renderRequests error:', err);
  }
}

async function acceptReq(id){
  await sb.from('friendships').update({ status: 'accepted' }).eq('id', id);
  renderRequests();
  renderFriends();
}

async function denyReq(id){
  await sb.from('friendships').delete().eq('id', id);
  renderRequests();
}

// ---------------- Games & Exit ---------------- //
function renderGames(){
  const g = $('#game-grid');
  if(g){
    g.innerHTML = GAMES.map(x => `
      <button class="game-card" onclick="openGame('${x.id}', false)">
        <div class="game-thumb">${x.icon}</div>
        <div class="game-info"><strong>${x.name}</strong><span>${x.desc}</span></div>
      </button>
    `).join('');
  }
  const sel = $('#room-game-select');
  if(sel) sel.innerHTML = GAMES.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
}

function openGame(id, isRoom = false){
  $('#game-modal')?.classList.remove('hidden');
  $('#game-group-chat')?.classList.add('hidden');
  const chatWrapper = $('#game-chat-wrapper');
  if(chatWrapper){
    if(isRoom) chatWrapper.classList.remove('hidden');
    else chatWrapper.classList.add('hidden');
  }
  const stage = $('#game-stage');
  if(!stage) return;

  if(id === 'dotdome'){
    // Dot Dome ko responsive iframe ke roop me load karein
    stage.innerHTML = `
      <iframe id="dotdome-frame" src="dotdome.html" 
        style="width:100%; height:100%; border:none; background:transparent;" 
        allow="autoplay"></iframe>
    `;
    const frame = $('#dotdome-frame');
    frame.onload = () => {
      frame.contentWindow.postMessage({
        type: 'INIT_ROOM_PLAYERS',
        payload: {
          players: room.members,
          myUid: player.uid,
          isHost: player.uid === room.ownerUid
        }
      }, '*');
    };
  } else if(id === 'ttt'){
    renderTTT(stage);
  } else {
    renderSnake(stage);
  }
}
function closeGame(){
  document.exitFullscreen?.().catch(()=>{});
  $('#game-modal')?.classList.add('hidden');
  $('#game-group-chat')?.classList.add('hidden');
  const stage = $('#game-stage');
  if(stage) stage.innerHTML = '';
}

function toggleGameChat(){
  $('#game-group-chat')?.classList.toggle('hidden');
}

function renderTTT(stage){
  let turn = 'X', cells = Array(9).fill('');
  stage.innerHTML = `
    <div class="game-screen">
      <h2>Neon Tic Tac Toe</h2>
      <div class="ttt">
        <div class="ttt-grid">${cells.map((_, i) => `<button class="ttt-cell" data-i="${i}"></button>`).join('')}</div>
      </div>
      <p id="ttt-msg">Turn: X</p>
    </div>
  `;
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  $$('.ttt-cell').forEach(b => b.onclick = () => {
    const i = +b.dataset.i;
    if(cells[i]) return;
    cells[i] = turn;
    b.textContent = turn;
    if(wins.some(w => w.every(j => cells[j] === turn))){
      $('#ttt-msg').textContent = `${turn} wins!`;
      $$('.ttt-cell').forEach(x => x.disabled = true);
      return;
    }
    if(cells.every(Boolean)){ $('#ttt-msg').textContent = 'Draw!'; return; }
    turn = turn === 'X' ? 'O' : 'X';
    $('#ttt-msg').textContent = `Turn: ${turn}`;
  });
}
function renderSnake(stage){
  stage.innerHTML = `
    <div class="game-screen">
      <h2>Neon Snake</h2>
      <div style="font-size:80px">🐍</div>
    </div>
  `;
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setup);
} else {
  setup();
}
window.addEventListener('message', e => {
  if(e.data && e.data.type === 'DOTDOME_LOCAL_ACTION'){
    if(roomChannel){
      roomChannel.send({
        type: 'broadcast',
        event: 'dotdome_event',
        payload: e.data.payload
      });
    }
  }
});
