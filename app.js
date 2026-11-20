const $ = id => document.getElementById(id);
const clock = seconds => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};
const download = (name, value) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

async function boot() {
  const response = await fetch(new URL('catalogue.json', import.meta.url));
  if (!response.ok) throw new Error('The rotation could not load. Please refresh to try again.');
  const catalogue = await response.json();
  if (!Array.isArray(catalogue.channels) || !Array.isArray(catalogue.tracks) || !catalogue.tracks.length) throw new Error('The rotation is unavailable.');
  const channels = catalogue.channels;
  const trackMap = new Map(catalogue.tracks.map(track => [track.id, track]));
  const remembered = read('side-lyd-player-v1', {});
  const query = new URLSearchParams(location.search);
  let channel = channels.find(item => item.id === query.get('channel')) || channels.find(item => item.id === remembered.channel) || channels[0];
  let track = trackMap.get(remembered.track);
  if (!track || !channel.ids.includes(track.id)) track = trackMap.get(channel.ids[0]);
  let active = $('audio');
  let standby = $('preload-audio');
  let generation = 0;
  let desiredPlaying = false;
  let failed = new Set();
  let sleepAt = 0;
  let frame = 0;
  let lastSavedAt = 0;
  let stallTimer = 0;
  let briefReference = null;
  let quiet = remembered.quiet === true;
  let volume = Math.max(0, Math.min(1, Number.isFinite(remembered.volume) ? remembered.volume : 0.7));
  let muted = false;
  let moments = read('side-lyd-moments-v1', []);
  moments = Array.isArray(moments) ? moments.filter(item => item && typeof item.id === 'string' && typeof item.channel === 'string' && channels.some(c => c.id === item.channel && c.ids.includes(item.track)) && Number.isFinite(item.seconds)).slice(-100) : [];

  function message(value) { $('player-message').textContent = value; }
  function persist() {
    write('side-lyd-player-v1', {channel: channel.id, track: track.id, seconds: active.currentTime || 0, volume, quiet});
  }
  function nextTrack(direction = 1) {
    const index = channel.ids.indexOf(track.id);
    for (let step = 1; step <= channel.ids.length; step++) {
      const id = channel.ids[(index + direction * step + channel.ids.length * 2) % channel.ids.length];
      if (!failed.has(id)) return trackMap.get(id);
    }
    return null;
  }
  function setPlaying(playing, label) {
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('play-glyph').textContent = playing ? 'Ⅱ' : '▶';
    $('play-state').textContent = label || (playing ? 'IN ROTATION' : 'PAUSED');
    $('signal-status').textContent = playing ? 'SIGNAL FOUND' : 'STANDING BY';
    $('status-led').classList.toggle('active', playing);
    document.title = playing ? `${track.title} / SIDE LYD` : 'SIDE LYD / Independent frequencies';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    draw();
    if (playing && !frame) frame = requestAnimationFrame(animate);
  }
  function draw() {
    const canvas = $('waveform');
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const progress = Math.min(1, (active.currentTime || 0) / track.duration);
    const count = Math.max(1, Math.floor(box.width / 3));
    for (let index = 0; index < count; index++) {
      const level = track.waveform[Math.floor(index * track.waveform.length / count)] || 0;
      const barHeight = Math.max(2 * ratio, level * height * 0.88);
      ctx.fillStyle = index / count <= progress ? channel.color : '#607154';
      ctx.globalAlpha = index / count <= progress ? 0.95 : 0.75;
      ctx.fillRect(index * width / count, (height - barHeight) / 2, Math.max(1, ratio * 1.3), barHeight);
    }
    ctx.globalAlpha = 1;
  }
  function animate() {
    frame = 0;
    draw();
    if (!active.paused) frame = requestAnimationFrame(animate);
  }
  function updateTime() {
    const duration = Number.isFinite(active.duration) ? active.duration : track.duration;
    const current = active.currentTime || 0;
    $('seek').max = duration;
    $('seek').value = current;
    $('seek').style.setProperty('--progress', `${100 * current / Math.max(duration, 1)}%`);
    $('seek').setAttribute('aria-valuetext', `${clock(current)} of ${clock(duration)}`);
    $('elapsed').textContent = clock(current);
    $('duration').textContent = clock(duration);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0) {
      try { navigator.mediaSession.setPositionState({duration, playbackRate: 1, position: Math.min(current, duration)}); } catch {}
    }
    if (Date.now() - lastSavedAt > 5000) { persist(); lastSavedAt = Date.now(); }
    checkSleep();
    if (active.paused) draw();
  }
  function prepareNext() {
    const next = nextTrack();
    if (!next || standby.dataset.track === next.id) return;
    standby.dataset.track = next.id;
    standby.src = next.src;
    standby.load();
  }
  function updateMedia() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: 'SIDE LYD', album: channel.name, artwork: [{src: new URL('icon.svg', location.href).href, sizes: 'any', type: 'image/svg+xml'}]});
  }
  function renderChannel() {
    const number = channels.indexOf(channel);
    document.documentElement.style.setProperty('--accent', channel.color);
    $('receiver').style.setProperty('--accent', channel.color);
    $('frequency').textContent = channel.frequency.toFixed(1);
    $('channel-counter').textContent = `${String(number + 1).padStart(2, '0')} / 04`;
    $('channel-name').textContent = channel.name;
    $('channel-character').textContent = channel.character;
    $('tune').value = number;
    $('tune').setAttribute('aria-valuetext', channel.name);
    $('dial-needle').style.left = `${100 * (channel.frequency - 88) / 20}%`;
    document.querySelectorAll('[data-channel]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.channel === channel.id)));
    $('rotation-eyebrow').textContent = `ON THE ${channel.name.toUpperCase()} ROTATION`;
    $('rotation-count').textContent = `${String(channel.ids.length).padStart(2, '0')} ${channel.ids.length === 1 ? 'STUDY' : 'STUDIES'}`;
    const list = $('track-list');
    list.replaceChildren();
    channel.ids.forEach((id, index) => {
      const item = trackMap.get(id);
      const row = text('div', '', 'track-row');
      row.dataset.track = id;
      const info = text('div', '', 'track-info');
      const title = text('button', item.title);
      title.type = 'button';
      title.addEventListener('click', () => select(item, true));
      info.append(title, text('small', item.description));
      const play = text('button', '▶', 'row-play');
      play.type = 'button';
      play.setAttribute('aria-label', `Play ${item.title}`);
      play.addEventListener('click', () => select(item, true));
      row.append(text('span', String(index + 1).padStart(2, '0'), 'track-index'), text('span', '', 'track-mini'), info, text('span', `${item.bpm} BPM`, 'track-tempo'), text('span', clock(item.duration), 'track-duration'), play);
      list.append(row);
    });
    const url = new URL(location.href);
    url.searchParams.set('channel', channel.id);
    history.replaceState(null, '', url);
  }
  function renderTrack() {
    $('track-title').textContent = track.title;
    $('track-description').textContent = track.description;
    $('track-position').textContent = `${String(channel.ids.indexOf(track.id) + 1).padStart(2, '0')} / ${String(channel.ids.length).padStart(2, '0')}`;
    $('bpm').textContent = `${track.bpm} BPM`;
    $('download-track').href = track.src;
    $('download-track').download = `SIDE-LYD-${track.id}.mp3`;
    document.querySelectorAll('.track-row').forEach(row => row.classList.toggle('current', row.dataset.track === track.id));
    updateMedia();
    updateTime();
  }
  async function select(item, play = false, seconds = 0) {
    if (!item) return;
    const token = ++generation;
    clearTimeout(stallTimer);
    desiredPlaying = play;
    active.pause();
    if (standby.dataset.track === item.id) {
      [active, standby] = [standby, active];
    } else if (active.dataset.track !== item.id) {
      active.dataset.track = item.id;
      active.src = item.src;
      active.load();
    }
    track = item;
    if (active.error) active.load();
    active.volume = volume;
    active.muted = muted;
    const seekTo = () => {
      if (token !== generation) return;
      active.currentTime = Math.min(Math.max(0, seconds), Math.max(0, track.duration - 0.25));
      updateTime();
    };
    if (active.readyState >= 1) seekTo();
    else active.addEventListener('loadedmetadata', seekTo, {once: true});
    renderTrack();
    setPlaying(false, play ? 'TUNING IN' : 'READY WHEN YOU ARE');
    message(play ? 'Finding the frequency…' : 'Press play. Stay a while.');
    prepareNext();
    persist();
    if (!play) return;
    try {
      await active.play();
      if (token !== generation) return;
      setPlaying(true);
      message(channel.label);
    } catch (error) {
      if (token !== generation || error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        desiredPlaying = false;
        setPlaying(false, 'PRESS PLAY TO TUNE IN');
        message('Tap play to allow audio in this browser.');
      } else {
        failed.add(item.id);
        const next = nextTrack();
        if (next) { message('That study is unavailable. Trying the next one.'); select(next, true); }
        else { desiredPlaying = false; setPlaying(false, 'SIGNAL UNAVAILABLE'); message('The audio could not load. Check your connection, then press play to retry.'); }
      }
    }
  }
  function tune(id, forcePlay = false) {
    const selected = channels.find(item => item.id === id);
    if (!selected) return;
    const wasPlaying = desiredPlaying || forcePlay;
    channel = selected;
    failed.clear();
    renderChannel();
    select(trackMap.get(channel.ids[0]), wasPlaying);
  }
  function recover(token) {
    if (token !== generation || !desiredPlaying) return;
    clearTimeout(stallTimer);
    failed.add(track.id);
    const next = nextTrack();
    if (next) select(next, true);
    else {
      desiredPlaying = false;
      active.pause();
      setPlaying(false, 'SIGNAL UNAVAILABLE');
      message('The audio could not load. Check your connection, then press play to retry.');
    }
  }
  function toggle() {
    if (!active.paused) {
      desiredPlaying = false;
      active.pause();
      persist();
    } else {
      failed.clear();
      select(track, true, active.currentTime || 0);
    }
  }
  function renderMoments() {
    $('saved-count').textContent = moments.length;
    const list = $('saved-list');
    list.replaceChildren();
    if (!moments.length) list.append(text('p', 'Something catch your ear? Press Save moment on the receiver. Your collection will be waiting here.', 'empty-state'));
    [...moments].reverse().forEach(moment => {
      const item = trackMap.get(moment.track);
      const savedChannel = channels.find(c => c.id === moment.channel);
      const row = text('div', '', 'saved-item');
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.append(text('strong', `${item.title} ↗`), text('small', `${savedChannel.name} / ${clock(moment.seconds)}`));
      replay.addEventListener('click', () => {
        channel = savedChannel;
        failed.clear();
        renderChannel();
        select(item, true, moment.seconds);
        $('saved-dialog').close();
        $('receiver').scrollIntoView({behavior: 'smooth', block: 'start'});
      });
      const remove = text('button', '×', 'remove-saved');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove saved moment from ${item.title}`);
      remove.addEventListener('click', () => { moments = moments.filter(m => m.id !== moment.id); write('side-lyd-moments-v1', moments); renderMoments(); });
      row.append(replay, remove);
      list.append(row);
    });
    $('export-saved').disabled = moments.length === 0;
  }
  function checkSleep() {
    if (!sleepAt) return;
    const remaining = sleepAt - Date.now();
    if (remaining <= 0) {
      sleepAt = 0;
      desiredPlaying = false;
      active.pause();
      $('sleep-label').textContent = 'OFF';
      message('Sleep timer finished. Rest easy.');
    } else $('sleep-label').textContent = `${Math.ceil(remaining / 60000)} MIN`;
  }

  channels.forEach((item, index) => {
    const button = text('button', String(index + 1).padStart(2, '0'));
    button.type = 'button';
    button.dataset.channel = item.id;
    button.setAttribute('aria-label', `Tune to ${item.name}`);
    button.addEventListener('click', () => tune(item.id));
    $('station-buttons').append(button);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'channel-card';
    card.dataset.channel = item.id;
    const top = text('span', '', 'channel-card-top');
    top.append(text('span', `${String(index + 1).padStart(2, '0')} / ${item.frequency.toFixed(1)}`), text('span', '↗', 'channel-arrow'));
    const art = text('span', '', 'channel-art');
    art.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) art.append(document.createElement('i'));
    const bottom = text('span', '', 'channel-card-bottom');
    bottom.append(document.createElement('i'), text('span', `${item.ids.length} ${item.ids.length === 1 ? 'STUDY' : 'STUDIES'} IN ROTATION`));
    card.append(top, art, text('h3', item.name), text('p', item.description), bottom);
    card.addEventListener('click', () => { tune(item.id, true); $('receiver').scrollIntoView({behavior: 'smooth', block: 'start'}); });
    $('channel-cards').append(card);
  });
  [active, standby].forEach(element => {
    element.addEventListener('timeupdate', () => { if (element === active) updateTime(); });
    element.addEventListener('loadedmetadata', () => { if (element === active) updateTime(); });
    element.addEventListener('play', () => { if (element === active) setPlaying(true); });
    element.addEventListener('pause', () => { if (element === active && element.paused) { clearTimeout(stallTimer); setPlaying(false, element.error ? 'SIGNAL UNAVAILABLE' : undefined); } });
    element.addEventListener('ended', () => { if (element === active && desiredPlaying) { checkSleep(); if (desiredPlaying) select(nextTrack(), true); } });
    element.addEventListener('waiting', () => {
      if (element !== active || !desiredPlaying) return;
      $('play-state').textContent = 'BUFFERING';
      message('Waiting for audio. Playback will continue when it is ready.');
      const token = generation, position = element.currentTime;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { if (element === active && Math.abs(element.currentTime - position) < 0.05) recover(token); }, 12000);
    });
    element.addEventListener('error', () => {
      if (element !== active || !desiredPlaying) return;
      const token = generation;
      setTimeout(() => { if (element === active && element.error) recover(token); }, 100);
    });
    element.addEventListener('playing', () => { if (element === active) { clearTimeout(stallTimer); setPlaying(true); message(channel.label); } });
  });
  $('play').addEventListener('click', toggle);
  $('next').addEventListener('click', () => { failed.clear(); select(nextTrack(), true); });
  $('previous').addEventListener('click', () => {
    failed.clear();
    if (active.currentTime > 3) select(track, true, 0);
    else select(nextTrack(-1), true);
  });
  $('tune').addEventListener('input', event => tune(channels[Number(event.target.value)].id));
  $('seek').addEventListener('input', event => {
    if (active.readyState >= 1) { active.currentTime = Number(event.target.value); updateTime(); draw(); }
  });
  $('volume').value = volume;
  $('volume').addEventListener('input', event => {
    volume = Number(event.target.value);
    active.volume = volume;
    standby.volume = volume;
    persist();
  });
  $('mute').addEventListener('click', () => {
    muted = !muted;
    active.muted = muted;
    $('mute').setAttribute('aria-pressed', String(muted));
    $('mute').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  });
  function applyQuiet() {
    document.body.classList.toggle('quiet', quiet);
    $('quiet-button').setAttribute('aria-pressed', String(quiet));
    $('quiet-button').firstChild.textContent = quiet ? 'Full view ' : 'Quiet view ';
    draw();
  }
  $('quiet-button').addEventListener('click', () => { quiet = !quiet; applyQuiet(); persist(); });
  $('bookmark').addEventListener('click', () => {
    const seconds = Math.min(active.currentTime || 0, track.duration);
    moments.push({id: crypto.randomUUID(), channel: channel.id, track: track.id, seconds: Math.round(seconds * 10) / 10, edition: catalogue.edition, catalogueVersion: catalogue.version, audioSha256: track.sha256, savedAt: new Date().toISOString(), mode: catalogue.mode});
    moments = moments.slice(-100);
    const stored = write('side-lyd-moments-v1', moments);
    renderMoments();
    message(stored ? `Saved ${track.title} at ${clock(seconds)}. Find it in Saved moments.` : 'Saved for this visit. Export your collection to keep it; browser storage is unavailable.');
  });
  $('open-saved').addEventListener('click', () => { renderMoments(); $('saved-dialog').showModal(); });
  $('export-saved').addEventListener('click', () => download('SIDE-LYD-saved-moments.json', {schema: 'side-lyd-moments/v1', exportedAt: new Date().toISOString(), moments}));
  $('open-brief').addEventListener('click', () => {
    briefReference = {edition: catalogue.edition, channel: channel.id, track: track.id, seconds: Math.round((active.currentTime || 0) * 10) / 10, audioSha256: track.sha256};
    $('brief-reference').replaceChildren(text('strong', `Reference: ${track.title}`), text('span', `${channel.name} / ${track.bpm} BPM / ${clock(active.currentTime)}`));
    $('brief-dialog').showModal();
  });
  $('brief-form').addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(event.target);
    const brief = {schema: 'side-lyd-project-brief/v1', createdAt: new Date().toISOString(), project: values.get('project').trim(), durationSeconds: Number(values.get('duration')), durationPolicy: 'total-including-tail', use: values.get('voice'), notes: values.get('notes').trim(), candidatesRequested: 3, reference: briefReference, requestedOutputs: ['wav-master', 'mp3-preview', 'aligned-stems', 'score', 'recipe'], status: 'brief-only'};
    if (!brief.project || !Number.isFinite(brief.durationSeconds) || brief.durationSeconds < 5 || brief.durationSeconds > 3600) return;
    download(`SIDE-LYD-${brief.project.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0,60) || 'project'}-brief.json`, brief);
    $('brief-dialog').close();
    message('Project brief saved. Bring it into the GENLYD production workflow.');
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  }));
  $('sleep-button').addEventListener('click', () => $('sleep-dialog').showModal());
  document.querySelectorAll('[data-sleep]').forEach(button => button.addEventListener('click', () => {
    const minutes = Number(button.dataset.sleep);
    sleepAt = minutes ? Date.now() + minutes * 60000 : 0;
    $('sleep-label').textContent = minutes ? `${minutes} MIN` : 'OFF';
    $('sleep-dialog').close();
    message(minutes ? `Playback will stop in ${minutes} minutes.` : 'Sleep timer switched off.');
  }));
  setInterval(checkSleep, 1000);
  document.addEventListener('visibilitychange', () => { checkSleep(); updateTime(); });
  window.addEventListener('pagehide', persist);
  window.addEventListener('resize', draw);
  if ('ResizeObserver' in window) new ResizeObserver(draw).observe($('waveform'));
  document.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,button,a,dialog')) return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
  });
  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => { if (active.paused) toggle(); }, pause: () => { desiredPlaying = false; active.pause(); },
      nexttrack: () => select(nextTrack(), true), previoustrack: () => select(nextTrack(-1), true),
      seekto: details => { if (Number.isFinite(details.seekTime)) { active.currentTime = Math.max(0, Math.min(details.seekTime, track.duration)); updateTime(); } },
      seekbackward: details => { active.currentTime = Math.max(0, active.currentTime - (details.seekOffset || 10)); },
      seekforward: details => { active.currentTime = Math.min(track.duration, active.currentTime + (details.seekOffset || 10)); }
    };
    for (const [action, handler] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} }
  }
  renderChannel();
  renderMoments();
  applyQuiet();
  const initial = track;
  await select(initial, false, remembered.track === initial.id && Number.isFinite(remembered.seconds) ? remembered.seconds : 0);
}

boot().catch(error => {
  $('player-message').textContent = error.message || 'The receiver could not start. Please refresh to try again.';
  $('play-state').textContent = 'ROTATION UNAVAILABLE';
  $('play').disabled = true;
});
