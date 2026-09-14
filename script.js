(function(){
  let entries = [];
  let credentials = { clientId: "", clientSecret: "" };
  let spotifyToken = null;
  let spotifyTokenExpiry = 0;
  let selectedSong = null;
  let searchDebounce = null;
  let pendingConfirm = false;

  const $ = (id) => document.getElementById(id);

  function todayLocal(){
    const d = new Date();
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off*60000);
    return local.toISOString().slice(0,10);
  }

  function fmtDate(iso){
    const [y,m,d] = iso.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    return dt.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }

  function monthLabel(iso){
    const [y,m] = iso.split('-').map(Number);
    const dt = new Date(y, m-1, 1);
    return dt.toLocaleDateString(undefined, { year:'numeric', month:'long' });
  }

  async function loadEntries(){
    try{
      const raw = localStorage.getItem('diary-entries');
      entries = raw ? JSON.parse(raw) : [];
    }catch(e){
      entries = [];
    }
    renderEntries();
  }

  async function saveEntries(){
    try{
      localStorage.setItem('diary-entries', JSON.stringify(entries));
    }catch(e){
      console.error('Could not save entries', e);
    }
  }

  async function loadCredentials(){
    try{
      const raw = localStorage.getItem('spotify-credentials');
      if(raw){
        credentials = JSON.parse(raw);
        $('clientIdInput').value = credentials.clientId || "";
        $('clientSecretInput').value = credentials.clientSecret || "";
      }
    }catch(e){ /* none saved yet */ }
    updateSearchHint();
  }

  async function saveCredentials(){
    credentials.clientId = $('clientIdInput').value.trim();
    credentials.clientSecret = $('clientSecretInput').value.trim();
    try{
      localStorage.setItem('spotify-credentials', JSON.stringify(credentials));
      spotifyToken = null;
      $('settingsStatus').textContent = 'Saved.';
      $('settingsStatus').className = 'status-line ok';
      updateSearchHint();
    }catch(e){
      $('settingsStatus').textContent = 'Could not save. Try again.';
      $('settingsStatus').className = 'status-line err';
    }
  }

  function updateSearchHint(){
    const hint = $('searchHint');
    if(!credentials.clientId || !credentials.clientSecret){
      hint.innerHTML = 'No Spotify keys yet. <button type="button" id="openFromHint">Add them in settings</button>';
      const btn = $('openFromHint');
      if(btn) btn.addEventListener('click', openSettings);
    }else{
      hint.textContent = '';
    }
  }

  async function getSpotifyToken(){
    if(spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
    if(!credentials.clientId || !credentials.clientSecret){
      throw new Error('missing-credentials');
    }
    const basic = btoa(credentials.clientId + ':' + credentials.clientSecret);
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + basic
      },
      body: 'grant_type=client_credentials'
    });
    if(!res.ok) throw new Error('token-failed');
    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return spotifyToken;
  }

  async function searchTracks(query){
    const resultsBox = $('searchResults');
    if(!query.trim()){
      resultsBox.style.display = 'none';
      resultsBox.innerHTML = '';
      return;
    }
    let token;
    try{
      token = await getSpotifyToken();
    }catch(e){
      resultsBox.style.display = 'none';
      if(e.message === 'missing-credentials'){
        updateSearchHint();
      }else{
        $('searchHint').textContent = 'Could not connect to Spotify. Check your keys in settings.';
      }
      return;
    }
    try{
      const res = await fetch('https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=track&limit=8', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(!res.ok) throw new Error('search-failed');
      const data = await res.json();
      const tracks = (data.tracks && data.tracks.items) || [];
      if(tracks.length === 0){
        resultsBox.innerHTML = '<div class="row" style="cursor:default;color:var(--ink-faint);">No tracks found</div>';
        resultsBox.style.display = 'block';
        return;
      }
      resultsBox.innerHTML = '';
      tracks.forEach(track => {
        const row = document.createElement('div');
        row.className = 'row';
        const img = (track.album.images && track.album.images.length) ? track.album.images[track.album.images.length-1].url : '';
        row.innerHTML = `
          <img src="${img}" alt="">
          <div class="meta">
            <div class="t">${escapeHtml(track.name)}</div>
            <div class="a">${escapeHtml(track.artists.map(a=>a.name).join(', '))}</div>
          </div>`;
        row.addEventListener('click', () => selectSong(track));
        resultsBox.appendChild(row);
      });
      resultsBox.style.display = 'block';
    }catch(e){
      $('searchHint').textContent = 'Search failed. Try again in a moment.';
    }
  }

  function escapeHtml(str){
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function selectSong(track){
    selectedSong = {
      id: track.id,
      name: track.name,
      artist: track.artists.map(a=>a.name).join(', '),
      album: track.album.name,
      image: (track.album.images && track.album.images.length) ? track.album.images[track.album.images.length-1].url : '',
      url: track.external_urls ? track.external_urls.spotify : ''
    };
    $('searchResults').style.display = 'none';
    $('searchResults').innerHTML = '';
    $('songInput').value = '';
    renderSelectedSong();
    checkDuplicates();
  }

  function renderSelectedSong(){
    const box = $('selectedSong');
    if(!selectedSong){ box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="selected-song">
        <img src="${selectedSong.image}" alt="">
        <div class="meta">
          <div class="t">${escapeHtml(selectedSong.name)}</div>
          <div class="a">${escapeHtml(selectedSong.artist)}</div>
        </div>
        <button type="button" id="clearSong">change</button>
      </div>`;
    $('clearSong').addEventListener('click', () => {
      selectedSong = null;
      renderSelectedSong();
      checkDuplicates();
    });
  }

  function handleNoSongToggle(){
    const noSong = $('noSongToggle').checked;
    $('songInput').disabled = noSong;
    $('songInput').value = '';
    $('searchResults').style.display = 'none';
    $('searchResults').innerHTML = '';
    $('searchHint').textContent = '';
    if(noSong){
      selectedSong = null;
      renderSelectedSong();
    }else{
      updateSearchHint();
    }
    checkDuplicates();
  }

  function normalize(text){
    return text.trim().replace(/\s+/g, ' ');
  }

  function checkDuplicates(){
    awaitingConfirm = false;
    const warnBox = $('warnings');
    warnBox.innerHTML = '';
    pendingConfirm = false;
    let messages = [];

    if(selectedSong){
      const match = entries.find(e => e.song && e.song.id === selectedSong.id);
      if(match) messages.push(`This song was already logged on ${fmtDate(match.date)}.`);
    }
    const goodbyeText = normalize($('goodbyeInput').value);
    if(goodbyeText){
      const match = entries.find(e => normalize(e.goodbye) === goodbyeText);
      if(match) messages.push(`This goodbye was already used on ${fmtDate(match.date)}.`);
    }

    if(messages.length){
      pendingConfirm = true;
      messages.forEach(m => {
        const div = document.createElement('div');
        div.className = 'warning';
        div.textContent = m;
        warnBox.appendChild(div);
      });
      $('saveBtn').textContent = 'Save anyway';
      $('saveBtn').classList.add('confirm');
    }else{
      $('saveBtn').textContent = 'Save entry';
      $('saveBtn').classList.remove('confirm');
    }
  }

  let awaitingConfirm = false;

  async function handleSave(){
    const date = $('dateInput').value;
    const goodbye = $('goodbyeInput').value.trim();
    const noSong = $('noSongToggle').checked;

    if(!date){ flashError($('dateInput')); return; }
    if(!noSong && !selectedSong){ flashError($('songInput')); return; }
    if(!goodbye){ flashError($('goodbyeInput')); return; }

    checkDuplicates();
    if(pendingConfirm && !awaitingConfirm){
      awaitingConfirm = true;
      return;
    }
    awaitingConfirm = false;

    entries.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,7),
      date, song: noSong ? null : selectedSong, goodbye, createdAt: Date.now()
    });
    entries.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    await saveEntries();

    selectedSong = null;
    $('goodbyeInput').value = '';
    $('songInput').value = '';
    $('songInput').disabled = false;
    $('noSongToggle').checked = false;
    renderSelectedSong();
    $('warnings').innerHTML = '';
    $('saveBtn').textContent = 'Save entry';
    $('saveBtn').classList.remove('confirm');

    renderEntries();
  }

  function flashError(el){
    el.style.borderColor = '#A5392C';
    setTimeout(() => { el.style.borderColor = ''; }, 900);
  }

  function exportEntries(){
    const payload = { exportedAt: new Date().toISOString(), entries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `song-goodbye-diary-${todayLocal()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $('backupStatus').textContent = `Downloaded ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}.`;
    $('backupStatus').className = 'status-line ok';
  }

  function importEntriesFile(file){
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try{
        const parsed = JSON.parse(ev.target.result);
        const incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : null);
        if(!incoming) throw new Error('bad-format');

        const existingIds = new Set(entries.map(e => e.id));
        let added = 0;
        incoming.forEach(raw => {
          if(!raw || typeof raw.date !== 'string' || typeof raw.goodbye !== 'string') return;
          const entry = {
            id: (raw.id && !existingIds.has(raw.id)) ? raw.id : (Date.now().toString(36) + Math.random().toString(36).slice(2,7)),
            date: raw.date,
            goodbye: raw.goodbye,
            song: raw.song || null,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
          };
          existingIds.add(entry.id);
          entries.push(entry);
          added++;
        });

        if(added === 0) throw new Error('nothing-valid');

        entries.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
        await saveEntries();
        renderEntries();
        $('backupStatus').textContent = `Imported ${added} ${added === 1 ? 'entry' : 'entries'}.`;
        $('backupStatus').className = 'status-line ok';
      }catch(err){
        $('backupStatus').textContent = "Could not read that file. Make sure it's a backup exported from this diary.";
        $('backupStatus').className = 'status-line err';
      }
    };
    reader.readAsText(file);
  }

  function songUseCount(id){
    return entries.filter(e => e.song && e.song.id === id).length;
  }
  function goodbyeUseCount(text){
    const n = normalize(text);
    return entries.filter(e => normalize(e.goodbye) === n).length;
  }

  function renderEntries(){
    const list = $('entryList');
    if(entries.length === 0){
      list.innerHTML = '<div class="empty">Your notebook is empty. Add today\u2019s song and goodbye to begin.</div>';
      return;
    }
    let html = '';
    let lastMonth = '';
    entries.forEach(entry => {
      const mLabel = monthLabel(entry.date);
      if(mLabel !== lastMonth){
        html += `<div class="month-label">${mLabel}</div>`;
        lastMonth = mLabel;
      }
      const hasSong = !!entry.song;
      const gCount = goodbyeUseCount(entry.goodbye);
      const goodbyeBadge = gCount > 1 ? `<span class="badge">\u00d7${gCount}</span>` : '';
      const artHtml = hasSong
        ? `<img class="art" src="${entry.song.image}" alt="">`
        : `<div class="art-none" aria-hidden="true">\u2014</div>`;
      let songLineHtml;
      if(hasSong){
        const sCount = songUseCount(entry.song.id);
        const songBadge = sCount > 1 ? `<span class="badge">\u00d7${sCount}</span>` : '';
        songLineHtml = `<span class="song-title">${escapeHtml(entry.song.name)}</span><span class="song-artist">${escapeHtml(entry.song.artist)}</span>${songBadge}`;
      }else{
        songLineHtml = `<span class="song-title none">No song</span>`;
      }
      html += `
        <div class="entry" data-id="${entry.id}">
          <div class="date">${fmtDate(entry.date)}</div>
          ${artHtml}
          <div class="content">
            <div class="song-line">
              ${songLineHtml}
            </div>
            <div class="goodbye">${escapeHtml(entry.goodbye)} ${goodbyeBadge}</div>
          </div>
          <button class="del" title="Delete entry" aria-label="Delete entry">\u00d7</button>
        </div>`;
    });
    list.innerHTML = html;
    list.querySelectorAll('.entry .del').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        const row = ev.target.closest('.entry');
        const id = row.dataset.id;
        entries = entries.filter(e => e.id !== id);
        await saveEntries();
        renderEntries();
      });
    });
  }

  function openSettings(){
    $('settingsModal').classList.remove('hidden');
    $('settingsStatus').textContent = '';
    $('backupStatus').textContent = '';
  }
  function closeSettings(){
    $('settingsModal').classList.add('hidden');
  }

  // wire up
  $('dateInput').value = todayLocal();
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', (e) => { if(e.target.id === 'settingsModal') closeSettings(); });
  $('saveSettings').addEventListener('click', saveCredentials);
  $('toggleSecret').addEventListener('click', () => {
    const inp = $('clientSecretInput');
    const btn = $('toggleSecret');
    if(inp.type === 'password'){ inp.type = 'text'; btn.textContent = 'hide'; }
    else{ inp.type = 'password'; btn.textContent = 'show'; }
  });

  $('songInput').addEventListener('input', (e) => {
    const val = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => searchTracks(val), 350);
  });
  $('noSongToggle').addEventListener('change', handleNoSongToggle);
  $('exportBtn').addEventListener('click', exportEntries);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(file) importEntriesFile(file);
    e.target.value = '';
  });
  document.addEventListener('click', (e) => {
    if(!e.target.closest('.song-search')){
      $('searchResults').style.display = 'none';
    }
  });

  $('goodbyeInput').addEventListener('input', checkDuplicates);
  $('saveBtn').addEventListener('click', handleSave);

  loadEntries();
  loadCredentials();
})();