// ==========================================================================
// CACHE DE EXTENSIONES DE IMÁGENES
// ==========================================================================
window.imageExtensionCache = {};
try {
  const savedCache = localStorage.getItem('panini_image_ext_cache');
  if (savedCache) {
    window.imageExtensionCache = JSON.parse(savedCache);
  }
} catch(e) {}

function getStickerImgSrc(teamId, i) {
  const key = `${teamId}_${i}`;
  const ext = window.imageExtensionCache[key] || '.png';
  return `${ALBUM_CONFIG.basePath}/${teamId}/${i}${ext}`;
}

// ==========================================================================
// FIREBASE - INICIALIZACIÓN Y AUTENTICACIÓN
// ==========================================================================
let _fbAuth = null;
let _fbDb = null;
let _currentUser = null;
let _saveDebounceTimer = null;
let _isAuthMode = 'login'; // 'login' | 'register'

function initFirebase() {
  if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
    console.warn('[Album] Firebase no configurado. Modo local activado.');
    return;
  }
  try {
    firebase.initializeApp(window.firebaseConfig);
    _fbAuth = firebase.auth();
    _fbDb   = firebase.firestore();
    _fbAuth.onAuthStateChanged(handleAuthStateChanged);
    console.log('[Album] Firebase inicializado correctamente.');
  } catch(e) {
    console.error('[Album] Error al inicializar Firebase:', e);
  }
}

async function handleAuthStateChanged(user) {
  _currentUser = user;
  renderUserTopbar();
  // Mostrar tab de admin solo para el administrador
  const adminBtn = document.getElementById('admin-tab-btn');
  if (adminBtn) {
    if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
      adminBtn.classList.remove('hidden');
    } else if (user && user.email === 'olanoagus@gmail.com') {
      adminBtn.classList.remove('hidden');
    } else {
      adminBtn.classList.add('hidden');
    }
  }
  if (user) {
    // Cargamos el progreso desde la nube al iniciar sesión
    await loadStateFromCloud(user.uid);
    renderAlbumPage();
    updateTopBar();
  }
}

function renderUserTopbar() {
  const container = document.getElementById('topbar-user');
  if (!container) return;

  if (_currentUser) {
    const name = _currentUser.displayName || _currentUser.email.split('@')[0];
    const photoURL = _currentUser.photoURL;
    const initial = name.charAt(0).toUpperCase();
    const avatarHtml = photoURL
      ? `<img src="${photoURL}" alt="${name}" class="topbar-user-avatar" referrerpolicy="no-referrer">`
      : `<div class="topbar-user-avatar-placeholder">${initial}</div>`;
    container.innerHTML = `
      <div class="topbar-user-profile" tabindex="0">
        ${avatarHtml}
        <span class="topbar-user-name">${name}</span>
      </div>
      <div class="user-dropdown-menu">
        <button class="dropdown-item signout-item" onclick="signOutUser()">🚪 Cerrar Sesión</button>
      </div>`;
  } else {
    container.innerHTML = `
      <button class="topbar-login-btn" onclick="toggleAuthModal(true)">
        🔑 INGRESAR
      </button>`;
  }
}

// Guardar en Firestore con debounce de 1.5s para no saturar
function saveToCloud(uid) {
  if (!_fbDb || !uid) return;
  clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    _fbDb.collection('albums').doc(uid).set(state)
      .then(() => console.log('[Album] Progreso sincronizado en la nube.'))
      .catch(e => console.error('[Album] Error al guardar en Firestore:', e));
  }, 1500);
}

async function loadStateFromCloud(uid) {
  if (!_fbDb || !uid) return;
  try {
    const doc = await _fbDb.collection('albums').doc(uid).get();
    if (doc.exists) {
      state = { ...state, ...doc.data() };
      console.log('[Album] Progreso cargado desde la nube.');
    } else {
      console.log('[Album] Usuario nuevo: empezando desde cero.');
      // Guardar estado inicial en la nube
      await _fbDb.collection('albums').doc(uid).set(state);
    }
  } catch(e) {
    console.error('[Album] Error al cargar desde Firestore:', e);
  }
}

// ==========================================================================
// ESTADO Y VARIABLES GLOBALES
// ==========================================================================
let state = {
  coins: 500,
  pasted: {},      // "equipoId_numero": true
  inventory: {},   // "equipoId_numero": cantidad
  openedPacksCount: 0,
  dailyCooldown: null,
  usedCodes: {},    // "codigo": true
  tradesToday: 0,   // intercambios realizados hoy
  tradeDate: null   // fecha del último reset de tradesToday
};

let currentTeamIndex = 0;
let _tradeMode = 'single'; // 'single' | 'multi'
let _selectedOffer = [];   // keys de figuritas ofrecidas
let _selectedWant = [];    // keys de figuritas pedidas
let _tradesUnsubscribe = null; // para limpiar listener de Firestore

// Manejador global para probar múltiples extensiones si la primera falla (.png -> .jpg -> .jpeg etc)
window.handleImageError = function(img, basePath) {
    if (!img.fallbackIdx) img.fallbackIdx = 0;
    const exts = ['.jpg', '.jpeg', '.jpg.jpeg', '.PNG', '.JPG', '.JPEG'];
    if (img.fallbackIdx < exts.length) {
        img.src = basePath + exts[img.fallbackIdx++];
    } else {
        // Todos los formatos fallaron: ocultar la imagen rota y marcar el slot
        img.onerror = null;
        img.style.display = 'none';
        const parent = img.closest('.sticker-card') || img.parentElement;
        if (parent) parent.classList.add('slot-img-missing');
    }
};

window.handleImageSuccess = function(img, basePath) {
  // Extraer extensión del src final exitoso
  const src = img.src;
  const dotIdx = src.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = src.substring(dotIdx);
    const match = basePath.match(/\/([^\/]+)\/([^\/]+)$/);
    if (match) {
      const teamId = match[1];
      const i = match[2];
      const key = `${teamId}_${i}`;
      if (window.imageExtensionCache[key] !== ext) {
        window.imageExtensionCache[key] = ext;
        localStorage.setItem('panini_image_ext_cache', JSON.stringify(window.imageExtensionCache));
      }
    }
  }
};

// ==========================================================================
// PRECARGA DE IMÁGENES (PRELOAD SYSTEM)
// ==========================================================================
function preloadAllStickers() {
  const teams = ALBUM_CONFIG.teams;
  const queue = [];

  // 1. Añadir el equipo actual al frente de la cola
  const currentTeam = teams[currentTeamIndex];
  addTeamToPreloadQueue(currentTeam, queue);

  // 2. Añadir los demás equipos
  teams.forEach((team, idx) => {
    if (idx !== currentTeamIndex) {
      addTeamToPreloadQueue(team, queue);
    }
  });

  // Procesar la cola concurrentemente pero sin saturar la red (máx 4 descargas paralelas)
  processPreloadQueue(queue);
}

function addTeamToPreloadQueue(team, queue) {
  const max = team.id === 'extrastickers' ? 6 : 11;
  // Bandera del equipo
  if (team.id !== 'extrastickers') {
    queue.push(`${ALBUM_CONFIG.basePath}/${team.id}/bandera.png`);
  }
  // Figuritas
  for (let i = 1; i <= max; i++) {
    const key = `${team.id}_${i}`;
    const ext = window.imageExtensionCache[key] || '.png';
    queue.push(`${ALBUM_CONFIG.basePath}/${team.id}/${i}${ext}`);
    
    // Si no sabemos la extensión aún, también encolamos alternativas comunes
    if (!window.imageExtensionCache[key]) {
      queue.push(`${ALBUM_CONFIG.basePath}/${team.id}/${i}.jpg`);
      queue.push(`${ALBUM_CONFIG.basePath}/${team.id}/${i}.jpeg`);
    }
  }
}

let preloadActiveCount = 0;
const MAX_CONCURRENT_PRELOADS = 4;

function processPreloadQueue(queue) {
  if (queue.length === 0) return;
  
  while (preloadActiveCount < MAX_CONCURRENT_PRELOADS && queue.length > 0) {
    const src = queue.shift();
    preloadActiveCount++;
    
    const img = new Image();
    img.onload = () => {
      preloadActiveCount--;
      processPreloadQueue(queue);
    };
    img.onerror = () => {
      preloadActiveCount--;
      processPreloadQueue(queue);
    };
    img.src = src;
  }
}

// ==========================================================================
// INICIALIZACIÓN
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();     // Arrancar Firebase (con fallback offline)
  renderUserTopbar(); // Mostrar botón de login mientras carga
  loadState();
  updateTopBar();
  renderAlbumPage();
  renderTeamIndicators();
  updateTimer();
  
  // Si Firebase está desactivado localmente, mostrar la pestaña de admin de una vez
  if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
    const adminBtn = document.getElementById('admin-tab-btn');
    if (adminBtn) adminBtn.classList.remove('hidden');
  }
  
  // Iniciar la precarga en segundo plano tras inicializar la app
  preloadAllStickers();
});

function loadState() {
  const saved = localStorage.getItem("panini_static_state");
  if (saved) {
    try { 
      state = JSON.parse(saved); 
      
      // Auto-corregir cooldowns viejos de 24 horas
      const now = Date.now();
      if (state.dailyCooldown && (state.dailyCooldown - now > 2 * 60 * 60 * 1000)) {
        state.dailyCooldown = null; // Resetear para que esté disponible ya
      }
    } catch(e){}
  }
  // Asegurar que exista el objeto de códigos usados
  state.usedCodes = state.usedCodes || {};
  state.tradesToday = state.tradesToday || 0;
  state.tradeDate = state.tradeDate || null;
  // Reset diario de trades
  const todayStr = new Date().toISOString().slice(0, 10);
  if (state.tradeDate !== todayStr) {
    state.tradesToday = 0;
    state.tradeDate = todayStr;
  }
}

function saveState() {
  localStorage.setItem("panini_static_state", JSON.stringify(state));
  updateTopBar();
  // Si hay usuario logueado, sincronizar en la nube también
  if (_currentUser) {
    saveToCloud(_currentUser.uid);
  }
}

function showToast(msg, type = 'success') {
  const stack = document.getElementById('toast-stack');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.style.backgroundColor = type === 'error' ? '#dc3545' : '#28a745';
  t.style.color = 'white';
  t.style.padding = '15px';
  t.style.borderRadius = '5px';
  t.style.marginBottom = '10px';
  t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ==========================================================================
// NAVEGACIÓN
// ==========================================================================
function switchTab(tabId) {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
  
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');
  
  if (tabId === 'album') renderAlbumPage();
  if (tabId === 'duplicates') renderDuplicates();
  if (tabId === 'trade') renderTradePage();
  if (tabId === 'admin') adminLoadCodes();
}

function updateTopBar() {
  document.getElementById('coins-display').textContent = state.coins;
  
  let totalStickers = 0;
  ALBUM_CONFIG.teams.forEach(t => {
    totalStickers += t.id === 'extrastickers' ? 6 : 11;
  });
  let pastedCount = Object.keys(state.pasted).length;
  
  document.getElementById('main-progress-text').textContent = `${pastedCount} / ${totalStickers}`;
  let pct = totalStickers > 0 ? (pastedCount / totalStickers) * 100 : 0;
  document.getElementById('main-progress-bar').style.width = `${pct}%`;
  
  let dupCount = countTotalDuplicates();
  const badge = document.getElementById('dup-badge');
  badge.textContent = dupCount;
  badge.style.display = dupCount > 0 ? 'inline-block' : 'none';
}

function countTotalDuplicates() {
  let count = 0;
  for (const key in state.inventory) {
    let q = state.inventory[key];
    if (state.pasted[key]) count += q;
    else count += Math.max(0, q - 1);
  }
  return count;
}

// ==========================================================================
// RENDERIZADO DEL ÁLBUM PANINI
// ==========================================================================
function prevTeam() {
    if (currentTeamIndex > 0) {
        currentTeamIndex--;
        renderAlbumPage();
        renderTeamIndicators();
    }
}

function nextTeam() {
    if (currentTeamIndex < ALBUM_CONFIG.teams.length - 1) {
        currentTeamIndex++;
        renderAlbumPage();
        renderTeamIndicators();
    }
}

function goToTeam(index) {
    currentTeamIndex = index;
    renderAlbumPage();
    renderTeamIndicators();
}

function renderTeamIndicators() {
    const container = document.getElementById('team-indicator');
    container.innerHTML = '';
    ALBUM_CONFIG.teams.forEach((team, idx) => {
        const dot = document.createElement('div');
        dot.className = `indicator-dot ${idx === currentTeamIndex ? 'active' : ''}`;
        dot.onclick = () => goToTeam(idx);
        container.appendChild(dot);
    });
}

function renderAlbumPage(justPastedKey = null) {
  const team = ALBUM_CONFIG.teams[currentTeamIndex];
  
  let bgStyle, bgStyleRight;
  if (team.id === 'extrastickers') {
    bgStyle = `radial-gradient(circle at top left, #ffd700 0%, #151515 100%)`;
    bgStyleRight = `radial-gradient(circle at bottom right, #252525 0%, #101010 100%)`;
  } else {
    bgStyle = `radial-gradient(circle at top left, ${team.color1} 0%, rgba(255,255,255,0.8) 100%)`;
    bgStyleRight = `radial-gradient(circle at bottom right, ${team.color2} 0%, rgba(255,255,255,0.8) 100%)`;
  }
  
  document.getElementById('page-bg-left').style.background = bgStyle;
  document.getElementById('page-bg-right').style.background = bgStyleRight;
  
  // Inyectar imagen de bandera como watermark decorativo si no es la página de Extra Stickers
  if (team.id !== 'extrastickers') {
    const flagPath = `${ALBUM_CONFIG.basePath}/${team.id}/bandera.png`;
    document.getElementById('page-bg-left').innerHTML = `
      <img src="${flagPath}" class="flag-watermark-img flag-top-left" onerror="this.style.display='none'" />
      <img src="${flagPath}" class="flag-watermark-img" onerror="this.style.display='none'" />
    `;
  } else {
    document.getElementById('page-bg-left').innerHTML = '';
  }
  
  if (team.id === 'extrastickers') {
    document.getElementById('team-header').innerHTML = `
      <div class="we-are-text" style="color: #ffd700; text-shadow: 3px 3px 0px #000000; font-family: var(--font-title);">EXTRA<br/>STICKERS</div>
      <div class="federation-text" style="color: #ccc;">${team.federation}</div>
    `;
  } else {
    document.getElementById('team-header').innerHTML = `
      <img src="${ALBUM_CONFIG.basePath}/${team.id}/bandera.png" class="team-flag-img" onerror="this.style.display='none'" />
      <div class="we-are-text" style="color: ${team.color1}; text-shadow: 3px 3px 0px ${team.color2}">WE ARE<br/>${team.name}</div>
      <div class="federation-text">${team.federation}</div>
    `;
  }
  
  const gridL = document.getElementById('grid-left');
  const gridR = document.getElementById('grid-right');
  gridL.innerHTML = '';
  gridR.innerHTML = '';
  
  // Si es sección extra, ocultamos la grilla derecha y mostramos un banner especial
  if (team.id === 'extrastickers') {
    gridR.classList.add('hidden');
    document.getElementById('group-info').innerHTML = `
      <div class="legendary-banner" style="text-align: center; color: #ffd700; padding: 20px; font-family: var(--font-title); border: 2px solid #ffd700; background: rgba(0,0,0,0.5); border-radius: 10px; margin-top: 15px;">
        <div style="font-size: 2.5rem; margin-bottom: 10px; filter: drop-shadow(0 0 10px #ffd700);">👑</div>
        <div style="font-size: 1.3rem; font-weight: bold; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 1px;">Colección de Leyendas</div>
        <p style="font-size: 0.85rem; color: #ccc; line-height: 1.4; max-width: 250px; margin: 0 auto;">
          Las 6 leyendas más exclusivas de la historia del fútbol. Conseguilas abriendo sobres para completar tu colección premium al 100%.
        </p>
      </div>
    `;
  } else {
    gridR.classList.remove('hidden');
    let flagsHtml = team.flags.map(f => `<span class="group-flag" style="border-bottom: 3px solid ${team.color1}">${f}</span>`).join('');
    document.getElementById('group-info').innerHTML = `
      <div class="group-title">${team.group}</div>
      <div class="group-flags">${flagsHtml}</div>
    `;
  }
  
  const totalStickers = team.id === 'extrastickers' ? 6 : 11;
  for(let i=1; i<=totalStickers; i++) {
    const cardKey = `${team.id}_${i}`;
    const isPasted = !!state.pasted[cardKey];
    const owned = state.inventory[cardKey] || 0;
    const canPaste = !isPasted && owned > 0;
    const isJustPasted = cardKey === justPastedKey;
    
    const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${i}`;
    const imgSrc = getStickerImgSrc(team.id, i);
    
    const slot = document.createElement('div');
    slot.className = 'sticker-slot';
    
    if (isPasted) {
      // La clase `just-pasted` se agrega directamente si acabamos de pegar esta carta
      const animClass = isJustPasted ? ' just-pasted' : '';
      slot.innerHTML = `
        <div class="sticker-card${animClass}" onclick="viewCard('${basePath}')">
          <img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')" onload="window.handleImageSuccess(this, '${basePath}')" />
        </div>
      `;
    } else if (canPaste) {
      slot.innerHTML = `
        <div class="slot-number">${i}</div>
        <button class="slot-paste-btn" onclick="pasteSticker('${cardKey}')">¡PEGAR!</button>
      `;
    } else {
      slot.innerHTML = `<div class="slot-number">${i}</div>`;
      slot.onclick = () => showToast(`Buscá la figurita ${i} en los sobres`);
    }
    
    if (team.id === 'extrastickers' || i <= 5) gridL.appendChild(slot);
    else gridR.appendChild(slot);
  }
}

function pasteSticker(cardKey) {
  if (state.pasted[cardKey]) return;
  if ((state.inventory[cardKey] || 0) <= 0) return;
  
  state.inventory[cardKey]--;
  state.pasted[cardKey] = true;
  saveState();

  // Pasar la key recién pegada para que renderAlbumPage aplique la animación directamente
  renderAlbumPage(cardKey);
  showToast('⚡ ¡Figurita pegada!');
}

function viewCard(basePath) {
  const match = basePath.match(/\/([^\/]+)\/([^\/]+)$/);
  let src = `${basePath}.png`;
  if (match) {
    const teamId = match[1];
    const i = match[2];
    src = getStickerImgSrc(teamId, i);
  }
  const modal = document.getElementById('sticker-modal');
  const inner = document.getElementById('modal-inner');
  inner.innerHTML = `<div class="sticker-card"><img src="${src}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')" onload="window.handleImageSuccess(this, '${basePath}')"/></div>`;
  modal.classList.remove('hidden');
}

function closeModal(e) {
  if (e.target.id === 'sticker-modal') {
    e.target.classList.add('hidden');
  }
}

// ==========================================================================
// APERTURA DE SOBRES
// ==========================================================================
function updateTimer() {
  const btn = document.getElementById('free-pack-btn');
  const sub = document.getElementById('free-pack-sub');
  if (!btn || !sub) return;

  if (!state.dailyCooldown) {
    btn.disabled = false;
    sub.textContent = '¡Disponible ahora!';
    return;
  }

  const now = Date.now();
  if (now >= state.dailyCooldown) {
    btn.disabled = false;
    sub.textContent = '¡Disponible ahora!';
    state.dailyCooldown = null; // reset
    saveState();
  } else {
    btn.disabled = true;
    const diff = state.dailyCooldown - now;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((diff % (1000 * 60)) / 1000);
    
    sub.innerHTML = `⏳ Espera: <b>${hours}h ${mins}m ${secs}s</b>`;
  }
}
setInterval(updateTimer, 1000);

function claimFreePack() {
  const now = Date.now();
  if (state.dailyCooldown && now < state.dailyCooldown) {
    showToast("El sobre gratis no está listo aún.", "error");
    return;
  }
  
  // Establecer el tiempo de espera en 2 horas desde ahora
  state.dailyCooldown = now + (2 * 60 * 60 * 1000);
  saveState();
  
  // En lugar de dar dinero, damos un sobre directo
  triggerPackOpening();
  showToast("¡Sobre gratis reclamado!");
  updateTimer(); // Forzar actualización visual inmediata
}

function openPack() {
  if (state.coins < 100) {
    showToast("No tenés monedas suficientes.", "error");
    return;
  }
  
  state.coins -= 100;
  saveState();
  
  triggerPackOpening();
}

function triggerPackOpening() {
  state.openedPacksCount++;
  saveState();
  
  // Mostrar sobre
  document.getElementById('pack-idle-hint').classList.add('hidden');
  const env = document.getElementById('pack-envelope');
  env.classList.remove('hidden', 'tearing', 'torn');
  document.getElementById('revealed-cards').classList.add('hidden');
  document.getElementById('revealed-cards').innerHTML = '';
}

function tearPack() {
  const env = document.getElementById('pack-envelope');
  if (env.classList.contains('tearing') || env.classList.contains('torn')) return;
  
  env.classList.add('tearing');
  
  setTimeout(() => {
    env.classList.remove('tearing');
    env.classList.add('torn');
    
    setTimeout(revealCards, 500);
  }, 500);
}

function revealCards() {
  document.getElementById('pack-envelope').classList.add('hidden'); // Ocultar sobre viejo para no ocupar espacio
  
  const container = document.getElementById('revealed-cards');
  container.innerHTML = '';
  container.classList.remove('hidden');
  
  const cardsInPack = new Set();
  let cardsGenerated = 0;
  
  while(cardsGenerated < 5) {
    // 1% de probabilidad de que cada carta sea Extra Sticker (promedia 1 de cada 20 sobres de 5 cartas: 5 * 1% = 5%)
    let team;
    if (Math.random() < 0.01) {
      team = ALBUM_CONFIG.teams.find(t => t.id === 'extrastickers');
    }
    if (!team) {
      const standardTeams = ALBUM_CONFIG.teams.filter(t => t.id !== 'extrastickers');
      team = standardTeams[Math.floor(Math.random() * standardTeams.length)];
    }
    const maxStickers = team.id === 'extrastickers' ? 6 : 11;
    const num = Math.floor(Math.random() * maxStickers) + 1;
    const cardKey = `${team.id}_${num}`;
    
    if (cardsInPack.has(cardKey)) {
        continue; // Si ya salió en este sobre, intentamos de nuevo
    }
    cardsInPack.add(cardKey);
    
    // Determinar si la figurita es NUEVA (no la tiene pegada ni en el inventario)
    const isNew = !state.pasted[cardKey] && (state.inventory[cardKey] || 0) === 0;
    
    state.inventory[cardKey] = (state.inventory[cardKey] || 0) + 1;
    
    const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${num}`;
    const imgSrc = getStickerImgSrc(team.id, num);
    
    const newBadgeHtml = isNew ? `<div class="new-sticker-badge">⭐ NUEVA</div>` : '';
    
    const div = document.createElement('div');
    div.style.animationDelay = `${cardsGenerated * 0.2}s`;
    div.innerHTML = `
      <div class="sticker-card revealed-card">
        ${newBadgeHtml}
        <img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')" onload="window.handleImageSuccess(this, '${basePath}')"/>
      </div>
    `;
    container.appendChild(div);
    
    cardsGenerated++;
  }
  
  saveState();
}

// ==========================================================================
// REPETIDAS
// ==========================================================================
function renderDuplicates() {
  const grid = document.getElementById('dup-grid');
  grid.innerHTML = '';
  
  let hasDups = false;
  
  ALBUM_CONFIG.teams.forEach(team => {
    const maxStickers = team.id === 'extrastickers' ? 6 : 11;
    for(let i=1; i<=maxStickers; i++){
      const key = `${team.id}_${i}`;
      const pasted = !!state.pasted[key];
      const inv = state.inventory[key] || 0;
      
      let repetidas = pasted ? inv : Math.max(0, inv - 1);
      
      if(repetidas > 0) {
        hasDups = true;
        const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${i}`;
        const imgSrc = getStickerImgSrc(team.id, i);
        
        const item = document.createElement('div');
        item.style.position = 'relative';
        item.innerHTML = `
          <div style="position:absolute; top:-10px; right:-10px; background:#e2001a; color:white; width:25px; height:25px; border-radius:50%; display:flex; justify-content:center; align-items:center; z-index:5; font-weight:bold;">${repetidas}</div>
          <div class="sticker-card"><img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')" onload="window.handleImageSuccess(this, '${basePath}')"/></div>
        `;
        grid.appendChild(item);
      }
    }
  });
  
  if (!hasDups) {
    grid.innerHTML = '<p>No tenés repetidas.</p>';
  }
}

function sellAllDuplicates() {
  let sold = 0;
  for(const key in state.inventory) {
    const pasted = !!state.pasted[key];
    const inv = state.inventory[key] || 0;
    
    let repetidas = pasted ? inv : Math.max(0, inv - 1);
    
    if(repetidas > 0) {
      sold += repetidas;
      state.inventory[key] -= repetidas;
    }
  }
  
  if (sold > 0) {
    state.coins += (sold * 15);
    saveState();
    showToast(`Vendiste ${sold} repetidas.`);
    renderDuplicates();
  } else {
    showToast("No tenés repetidas.", "error");
  }
}

// ==========================================================================
// CÓDIGOS PROMOCIONALES
// ==========================================================================
async function redeemCode() {
  const val = document.getElementById('code-input').value.trim().toUpperCase();
  const msg = document.getElementById('code-msg');
  msg.innerHTML = '';
  if (!val) return;

  state.usedCodes = state.usedCodes || {};

  // Verificar si el código ya fue usado localmente
  if (state.usedCodes[val]) {
    msg.innerHTML = "<span style='color:#dc3545'>⚠️ Este código ya fue utilizado.</span>";
    showToast("Código ya utilizado.", "error");
    return;
  }

  // --- Códigos hardcodeados ---
  const hardcoded = {
    'INFINITOPLATA': { coins: 999999, label: '🤑 ¡CHEAT ACTIVADO! +999,999 🪙' },
    'MUNDIAL2026':   { coins: 1000,   label: '+1000 🪙' },
    'LEGEND':        { coins: 150,    label: '+150 🪙' },
  };

  if (hardcoded[val]) {
    const { coins, label } = hardcoded[val];
    state.coins += coins;
    state.usedCodes[val] = true;
    msg.innerHTML = `<span style='color:#28a745'>${label}</span>`;
    showToast(`¡Código canjeado! +${coins} 🪙`, 'success');
    document.getElementById('code-input').value = '';
    saveState();
    return;
  }

  // --- Códigos dinámicos de Firestore ---
  if (_fbDb) {
    msg.innerHTML = "<span style='color:#aaa'>🔍 Verificando código...</span>";
    try {
      const snap = await _fbDb.collection('promoCodes').doc(val).get();
      if (snap.exists) {
        const data = snap.data();
        if (data.used) {
          msg.innerHTML = "<span style='color:#dc3545'>⚠️ Este código ya fue utilizado.</span>";
          showToast("Código ya utilizado.", "error");
          return;
        }
        // Marcar como usado en Firestore
        await _fbDb.collection('promoCodes').doc(val).update({ used: true, usedBy: _currentUser ? _currentUser.email : 'guest', usedAt: Date.now() });
        state.coins += data.coins;
        state.usedCodes[val] = true;
        msg.innerHTML = `<span style='color:#28a745'>+${data.coins} 🪙</span>`;
        showToast(`¡Código canjeado! +${data.coins} 🪙`, 'success');
        document.getElementById('code-input').value = '';
        saveState();
        return;
      }
    } catch(e) {
      console.error('[Admin] Error verificando código:', e);
    }
  }

  msg.innerHTML = "<span style='color:#dc3545'>Código inválido o caducado.</span>";
}

// ==========================================================================
// PANEL DE ADMIN
// ==========================================================================
const ADMIN_EMAIL = 'olanoagus@gmail.com';

function _isAdmin() {
  if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
    return true; // Acceso total si Firebase está desactivado localmente
  }
  return _currentUser && _currentUser.email === ADMIN_EMAIL;
}

function setAdminAmount(amount) {
  document.getElementById('admin-amount-input').value = amount;
  // Highlight del botón seleccionado
  document.querySelectorAll('.admin-amount-btn').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function _randomCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function adminGenerateCode() {
  if (!_isAdmin()) { showToast('No autorizado.', 'error'); return; }
  const coinsRaw = document.getElementById('admin-amount-input').value;
  const coins = parseInt(coinsRaw, 10);
  if (!coins || coins < 1) {
    showToast('Eligí un monto de monedas primero.', 'error');
    return;
  }

  const code = _randomCode();
  const resultEl = document.getElementById('admin-result');
  const displayEl = document.getElementById('admin-code-display');
  const coinsEl   = document.getElementById('admin-code-coins');

  // Guardar en Firestore
  if (_fbDb) {
    try {
      await _fbDb.collection('promoCodes').doc(code).set({
        coins,
        used: false,
        createdBy: ADMIN_EMAIL,
        createdAt: Date.now()
      });
      displayEl.textContent = code;
      coinsEl.textContent = `🪙 ${coins} monedas`;
      resultEl.classList.remove('hidden');
      showToast('¡Código creado y guardado!', 'success');
      adminLoadCodes();
    } catch(e) {
      showToast('Error al guardar en Firestore.', 'error');
      console.error(e);
    }
  } else {
    // Sin Firebase: solo mostrar en pantalla
    displayEl.textContent = code;
    coinsEl.textContent = `🪙 ${coins} monedas (solo local, sin Firebase)`;
    resultEl.classList.remove('hidden');
  }
}

function adminCopyCode() {
  const code = document.getElementById('admin-code-display').textContent;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => showToast('¡Código copiado!'));
}

async function adminLoadCodes() {
  if (!_isAdmin() || !_fbDb) return;
  const listEl = document.getElementById('admin-codes-list');
  listEl.innerHTML = '<p style="color:#555; font-size:0.85rem;">Cargando...</p>';
  try {
    const snap = await _fbDb.collection('promoCodes').orderBy('createdAt', 'desc').limit(30).get();
    if (snap.empty) {
      listEl.innerHTML = '<p style="color:#555; font-size:0.85rem;">No hay códigos todavía.</p>';
      return;
    }
    listEl.innerHTML = '';
    snap.forEach(doc => {
      const d = doc.data();
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.06); padding:10px 14px; border-radius:8px; font-size:0.9rem;';
      row.innerHTML = `
        <div>
          <span style="font-family:'Orbitron',sans-serif; color:${d.used ? '#666' : '#ffd700'}; letter-spacing:2px; font-size:0.95rem;">${doc.id}</span>
          <span style="color:#aaa; margin-left:10px;">${d.used ? '✓ Usado' : '● Activo'}</span>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="color:#ffd700; font-weight:bold;">🪙${d.coins}</span>
          ${!d.used ? `<button onclick="adminDeleteCode('${doc.id}')" style="background:rgba(220,53,69,0.2); border:1px solid #dc3545; color:#dc3545; padding:3px 9px; border-radius:5px; cursor:pointer; font-size:0.75rem;">❌</button>` : ''}
        </div>
      `;
      listEl.appendChild(row);
    });
  } catch(e) {
    listEl.innerHTML = '<p style="color:#dc3545; font-size:0.85rem;">Error cargando códigos.</p>';
    console.error(e);
  }
}

async function adminDeleteCode(code) {
  if (!_isAdmin() || !_fbDb) return;
  if (!confirm(`¿Eliminar el código "${code}"?`)) return;
  try {
    await _fbDb.collection('promoCodes').doc(code).delete();
    showToast('Código eliminado.');
    adminLoadCodes();
  } catch(e) {
    showToast('Error al eliminar.', 'error');
  }
}

// ==========================================================================
// AUTH UI – Funciones para el Modal de Login
// ==========================================================================
function toggleAuthModal(show) {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  if (show) {
    modal.classList.remove('hidden');
    // Mostrar aviso si Firebase no está configurado
    const warn = document.getElementById('firebase-warn-banner');
    if (warn) {
      warn.classList.toggle('hidden', !!(window.isFirebaseConfigured && window.isFirebaseConfigured()));
    }
    // Resetear modo a login
    _isAuthMode = 'login';
    _updateAuthModalUI();
    document.getElementById('auth-email').value = '';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-error-msg').textContent = '';
  } else {
    modal.classList.add('hidden');
  }
}

function _updateAuthModalUI() {
  const isLogin = _isAuthMode === 'login';
  document.getElementById('auth-title').textContent    = isLogin ? 'INICIAR SESIÓN' : 'CREAR CUENTA';
  document.getElementById('auth-subtitle').textContent = isLogin ? 'Sincronizá tu progreso en la nube' : 'Empezá tu colección ahora';
  document.getElementById('auth-submit-btn').textContent = isLogin ? 'INGRESAR' : 'REGISTRARME';
  document.getElementById('auth-toggle-text').textContent = isLogin ? '¿No tenés cuenta? ' : '¿Ya tenés cuenta? ';
  document.getElementById('auth-toggle-link').textContent = isLogin ? 'Registrate aquí' : 'Iniciá sesión';
  document.getElementById('auth-password').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
}

function toggleAuthMode(e) {
  e.preventDefault();
  _isAuthMode = _isAuthMode === 'login' ? 'register' : 'login';
  _updateAuthModalUI();
  document.getElementById('auth-error-msg').textContent = '';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!_fbAuth) {
    document.getElementById('auth-error-msg').textContent = '⚠️ Firebase no está configurado. Editá firebase-config.js con tus credenciales.';
    return;
  }
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl    = document.getElementById('auth-error-msg');
  const submitBtn = document.getElementById('auth-submit-btn');

  errEl.textContent = '';
  submitBtn.textContent = '...';
  submitBtn.disabled = true;

  try {
    if (_isAuthMode === 'login') {
      await _fbAuth.signInWithEmailAndPassword(email, password);
    } else {
      await _fbAuth.createUserWithEmailAndPassword(email, password);
    }
    toggleAuthModal(false);
    showToast('✅ ¡Sesión iniciada correctamente!', 'success');
  } catch(err) {
    errEl.textContent = _translateFirebaseError(err.code);
  } finally {
    submitBtn.textContent = _isAuthMode === 'login' ? 'INGRESAR' : 'REGISTRARME';
    submitBtn.disabled = false;
  }
}

async function signInWithGoogle() {
  if (!_fbAuth) {
    document.getElementById('auth-error-msg').textContent = '⚠️ Firebase no está configurado. Editá firebase-config.js con tus credenciales.';
    return;
  }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await _fbAuth.signInWithPopup(provider);
    toggleAuthModal(false);
    showToast('✅ ¡Sesión iniciada con Google!', 'success');
  } catch(err) {
    document.getElementById('auth-error-msg').textContent = _translateFirebaseError(err.code);
  }
}

async function signOutUser() {
  if (!_fbAuth) return;
  try {
    await _fbAuth.signOut();
    _currentUser = null;
    renderUserTopbar();
    // Recargar estado local
    state = { coins: 500, pasted: {}, inventory: {}, openedPacksCount: 0, dailyCooldown: null, usedCodes: {} };
    loadState();
    updateTopBar();
    renderAlbumPage();
    showToast('👋 Sesión cerrada. Tu progreso local sigue guardado.', 'success');
  } catch(err) {
    console.error(err);
  }
}

function _translateFirebaseError(code) {
  const errors = {
    'auth/user-not-found':       '❌ No existe una cuenta con ese email.',
    'auth/wrong-password':       '❌ Contraseña incorrecta.',
    'auth/invalid-email':        '❌ Email inválido.',
    'auth/email-already-in-use': '❌ Ese email ya está registrado.',
    'auth/weak-password':        '❌ La contraseña debe tener al menos 6 caracteres.',
    'auth/too-many-requests':    '⚠️ Demasiados intentos. Intentá más tarde.',
    'auth/popup-closed-by-user': '⚠️ Se cerró el popup antes de completar el inicio de sesión.',
    'auth/network-request-failed': '⚠️ Error de red. Verificá tu conexión a internet.',
  };
  return errors[code] || `❌ Error: ${code}`;
}

// ==========================================================================
// MÚSICA DE FONDO
// ==========================================================================
let _musicEnabled = false;

function toggleMusic() {
  const audio = document.getElementById('bg-music');
  const btn   = document.getElementById('music-toggle');
  if (!audio) return;

  if (_musicEnabled) {
    audio.pause();
    _musicEnabled = false;
    if (btn) btn.textContent = '🔇';
  } else {
    audio.volume = 0.35;
    const p = audio.play();
    if (p !== undefined) {
      p.then(() => {
        _musicEnabled = true;
        if (btn) btn.textContent = '🔊';
      }).catch(err => {
        console.warn('[Music] play() blocked:', err);
      });
    }
  }
}

// ==========================================================================
// INTERCAMBIO DE FIGURITAS
// ==========================================================================
const MAX_TRADES_PER_DAY = 3;

function renderTradePage() {
  const loginPrompt = document.getElementById('trade-login-prompt');
  const mainContent = document.getElementById('trade-main-content');
  if (!loginPrompt || !mainContent) return;

  if (!_currentUser) {
    loginPrompt.classList.remove('hidden');
    mainContent.classList.add('hidden');
    return;
  }

  loginPrompt.classList.add('hidden');
  mainContent.classList.remove('hidden');

  _selectedOffer = [];
  _selectedWant = [];
  _tradeMode = 'single';

  // Reset mode toggle UI
  document.getElementById('trade-mode-single').classList.add('active');
  document.getElementById('trade-mode-multi').classList.remove('active');

  updateTradeDailyLimit();
  populateTradeSelectors();
  updateTradePublishBtn();
  loadOpenTrades();
  loadMyTrades();
}

function updateTradeDailyLimit() {
  // Reset diario si cambió el día
  const todayStr = new Date().toISOString().slice(0, 10);
  if (state.tradeDate !== todayStr) {
    state.tradesToday = 0;
    state.tradeDate = todayStr;
    saveState();
  }
  const el = document.getElementById('trade-daily-limit');
  if (!el) return;
  el.textContent = `${state.tradesToday}/${MAX_TRADES_PER_DAY} intercambios hoy`;
  if (state.tradesToday >= MAX_TRADES_PER_DAY) {
    el.style.color = '#dc3545';
  } else if (state.tradesToday >= 2) {
    el.style.color = '#ffa500';
  } else {
    el.style.color = '#28a745';
  }
}

function setTradeMode(mode) {
  _tradeMode = mode;
  _selectedOffer = [];
  _selectedWant = [];
  document.getElementById('trade-mode-single').classList.toggle('active', mode === 'single');
  document.getElementById('trade-mode-multi').classList.toggle('active', mode === 'multi');
  populateTradeSelectors();
  updateTradePublishBtn();
}

function _getStickerLabel(key) {
  const parts = key.split('_');
  const teamId = parts[0];
  const num = parts[1];
  const team = ALBUM_CONFIG.teams.find(t => t.id === teamId);
  return team ? `${team.flag} ${team.name} #${num}` : key;
}

function _getDuplicateCount(key) {
  const inv = state.inventory[key] || 0;
  if (state.pasted[key]) return inv;
  return Math.max(0, inv - 1);
}

function populateTradeSelectors() {
  const offerContainer = document.getElementById('trade-offer-selector');
  const wantContainer = document.getElementById('trade-want-selector');
  if (!offerContainer || !wantContainer) return;

  offerContainer.innerHTML = '';
  wantContainer.innerHTML = '';

  // --- OFREZCO: figuritas repetidas ---
  let hasOffer = false;
  ALBUM_CONFIG.teams.forEach(team => {
    const max = team.id === 'extrastickers' ? 6 : 11;
    for (let i = 1; i <= max; i++) {
      const key = `${team.id}_${i}`;
      const dupCount = _getDuplicateCount(key);
      if (dupCount > 0) {
        hasOffer = true;
        const chip = _createTradeChip(key, team, i, dupCount, 'offer');
        offerContainer.appendChild(chip);
      }
    }
  });
  if (!hasOffer) {
    offerContainer.innerHTML = '<p style="color:#666; font-size:0.85rem; text-align:center; padding:20px;">No ten\u00e9s figuritas repetidas para ofrecer.</p>';
  }

  // --- PIDO: figuritas que NO tengo ---
  let hasWant = false;
  ALBUM_CONFIG.teams.forEach(team => {
    const max = team.id === 'extrastickers' ? 6 : 11;
    for (let i = 1; i <= max; i++) {
      const key = `${team.id}_${i}`;
      const hasPasted = !!state.pasted[key];
      const hasInInventory = (state.inventory[key] || 0) > 0;
      if (!hasPasted && !hasInInventory) {
        hasWant = true;
        const chip = _createTradeChip(key, team, i, 0, 'want');
        wantContainer.appendChild(chip);
      }
    }
  });
  if (!hasWant) {
    wantContainer.innerHTML = '<p style="color:#666; font-size:0.85rem; text-align:center; padding:20px;">\u00a1Ten\u00e9s todas las figuritas!</p>';
  }
}

function _createTradeChip(key, team, num, count, side) {
  const chip = document.createElement('div');
  chip.className = 'trade-chip';
  chip.dataset.key = key;
  chip.dataset.side = side;

  const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${num}`;
  const imgSrc = getStickerImgSrc(team.id, num);

  chip.innerHTML = `
    ${count > 0 ? `<div class="trade-sticker-count">${count}</div>` : ''}
    <img src="${imgSrc}" onerror="window.handleImageError(this, '${basePath}')" onload="window.handleImageSuccess(this, '${basePath}')" />
    <div class="chip-label">${team.flag} #${num}</div>
  `;

  chip.onclick = () => toggleTradeChip(key, side);
  return chip;
}

function toggleTradeChip(key, side) {
  const arr = side === 'offer' ? _selectedOffer : _selectedWant;
  const idx = arr.indexOf(key);

  if (idx >= 0) {
    // Deseleccionar
    arr.splice(idx, 1);
  } else {
    if (_tradeMode === 'single') {
      // En modo single, solo 1 seleccionada
      arr.length = 0;
      arr.push(key);
    } else {
      // En modo multi, limitar a 5 máximo por lado
      if (arr.length >= 5) {
        showToast('Máximo 5 figuritas por lado.', 'error');
        return;
      }
      arr.push(key);
    }
  }

  // Actualizar UI de chips
  const containerId = side === 'offer' ? 'trade-offer-selector' : 'trade-want-selector';
  document.querySelectorAll(`#${containerId} .trade-chip`).forEach(chip => {
    const isSelected = arr.includes(chip.dataset.key);
    chip.classList.toggle('selected', isSelected);
  });

  updateTradePublishBtn();
}

function updateTradePublishBtn() {
  const btn = document.getElementById('trade-publish-btn');
  if (!btn) return;
  const canPublish = _selectedOffer.length > 0 && _selectedWant.length > 0 && state.tradesToday < MAX_TRADES_PER_DAY;
  btn.disabled = !canPublish;
}

async function publishTrade() {
  if (!_currentUser || !_fbDb) {
    showToast('Necesitás iniciar sesión.', 'error');
    return;
  }
  if (_selectedOffer.length === 0 || _selectedWant.length === 0) {
    showToast('Seleccioná al menos una figurita de cada lado.', 'error');
    return;
  }
  if (state.tradesToday >= MAX_TRADES_PER_DAY) {
    showToast('Alcanzaste el límite diario de intercambios.', 'error');
    return;
  }

  // Verificar que todavía tenemos las repetidas
  for (const key of _selectedOffer) {
    if (_getDuplicateCount(key) <= 0) {
      showToast(`Ya no tenés repetidas de ${_getStickerLabel(key)}.`, 'error');
      return;
    }
  }

  const tradeData = {
    creatorUid: _currentUser.uid,
    creatorEmail: _currentUser.email,
    creatorName: _currentUser.displayName || _currentUser.email.split('@')[0],
    offerStickers: _selectedOffer,
    wantStickers: _selectedWant,
    status: 'open',
    createdAt: Date.now()
  };

  try {
    await _fbDb.collection('trades').add(tradeData);
    showToast('\u00a1Oferta publicada en el mercado!', 'success');
    _selectedOffer = [];
    _selectedWant = [];
    populateTradeSelectors();
    updateTradePublishBtn();
    loadMyTrades();
  } catch (e) {
    console.error('[Trade] Error al publicar:', e);
    showToast('Error al publicar la oferta.', 'error');
  }
}

async function loadOpenTrades() {
  if (!_fbDb || !_currentUser) return;
  const grid = document.getElementById('trade-market-grid');
  const emptyEl = document.getElementById('trade-market-empty');
  if (!grid) return;

  // Limpiar listener anterior
  if (_tradesUnsubscribe) {
    _tradesUnsubscribe();
    _tradesUnsubscribe = null;
  }

  try {
    const query = _fbDb.collection('trades')
      .where('status', '==', 'open')
      .orderBy('createdAt', 'desc')
      .limit(50);

    _tradesUnsubscribe = query.onSnapshot(snap => {
      grid.innerHTML = '';
      let hasCards = false;

      snap.forEach(doc => {
        const data = doc.data();
        // No mostrar mis propias ofertas aquí
        if (data.creatorUid === _currentUser.uid) return;

        hasCards = true;
        const card = _createTradeOfferCard(doc.id, data, false);
        grid.appendChild(card);
      });

      if (!hasCards) {
        grid.innerHTML = `<div class="trade-empty-state"><div style="font-size:3rem;">\ud83c\udfdc\ufe0f</div><p>No hay ofertas de otros jugadores en este momento.</p></div>`;
      }

      // Actualizar badge
      _updateTradeBadge(snap);
    });
  } catch (e) {
    console.error('[Trade] Error cargando trades:', e);
    grid.innerHTML = '<p style="color:#dc3545;">Error al cargar el mercado.</p>';
  }
}

function _updateTradeBadge(snap) {
  const badge = document.getElementById('trade-badge');
  if (!badge) return;
  let count = 0;
  snap.forEach(doc => {
    const data = doc.data();
    if (data.creatorUid !== _currentUser.uid) {
      // Contar solo si el usuario tiene la figurita solicitada
      const canAccept = data.wantStickers.some(key => _getDuplicateCount(key) > 0);
      if (canAccept) count++;
    }
  });
  badge.textContent = count > 0 ? count : '';
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

async function loadMyTrades() {
  if (!_fbDb || !_currentUser) return;
  const container = document.getElementById('trade-my-offers');
  if (!container) return;

  try {
    const snap = await _fbDb.collection('trades')
      .where('creatorUid', '==', _currentUser.uid)
      .where('status', '==', 'open')
      .orderBy('createdAt', 'desc')
      .get();

    container.innerHTML = '';
    if (snap.empty) {
      container.innerHTML = `<div class="trade-empty-state"><div style="font-size:3rem;">\ud83d\udced</div><p>No ten\u00e9s ofertas pendientes.</p></div>`;
      return;
    }

    snap.forEach(doc => {
      const card = _createTradeOfferCard(doc.id, doc.data(), true);
      container.appendChild(card);
    });
  } catch (e) {
    console.error('[Trade] Error cargando mis ofertas:', e);
  }
}

function _createTradeOfferCard(tradeId, data, isMine) {
  const card = document.createElement('div');
  card.className = 'trade-offer-card';

  // Generar thumbnails de figuritas ofrecidas
  const offerThumbs = data.offerStickers.map(key => {
    const parts = key.split('_');
    const imgSrc = getStickerImgSrc(parts[0], parts[1]);
    const label = _getStickerLabel(key);
    return `<div class="offer-sticker-thumb" title="${label}"><img src="${imgSrc}" onerror="this.style.display='none'" /></div>`;
  }).join('');

  // Generar thumbnails de figuritas pedidas
  const wantThumbs = data.wantStickers.map(key => {
    const parts = key.split('_');
    const imgSrc = getStickerImgSrc(parts[0], parts[1]);
    const label = _getStickerLabel(key);
    return `<div class="offer-sticker-thumb" title="${label}"><img src="${imgSrc}" onerror="this.style.display='none'" /></div>`;
  }).join('');

  // Verificar si el usuario puede aceptar (tiene las figuritas pedidas)
  const canAccept = !isMine && data.wantStickers.every(key => _getDuplicateCount(key) > 0);

  const creatorDisplay = data.creatorName || data.creatorEmail.split('@')[0];
  const timeAgo = _timeAgo(data.createdAt);

  let actionBtn = '';
  if (isMine) {
    actionBtn = `<button class="trade-cancel-btn" onclick="cancelTrade('${tradeId}')">\u274c Cancelar</button>`;
  } else if (canAccept) {
    actionBtn = `<button class="trade-accept-btn" onclick="acceptTrade('${tradeId}')">\u2705 Aceptar Intercambio</button>`;
  } else {
    actionBtn = `<button class="trade-accept-btn" disabled title="No ten\u00e9s las figuritas que pide">\ud83d\udeab No ten\u00e9s lo que pide</button>`;
  }

  card.innerHTML = `
    <div class="offer-creator">
      <span>${isMine ? '\ud83d\udccc T\u00fa' : '\ud83d\udc64 ' + creatorDisplay}</span>
      <span class="offer-time">${timeAgo}</span>
    </div>
    <div class="offer-stickers">
      <div class="offer-side offer-give">
        <div class="offer-side-label">Ofrece</div>
        <div class="offer-thumbs">${offerThumbs}</div>
      </div>
      <div class="offer-arrow">\u27a1\ufe0f</div>
      <div class="offer-side offer-receive">
        <div class="offer-side-label">Pide</div>
        <div class="offer-thumbs">${wantThumbs}</div>
      </div>
    </div>
    <div class="offer-actions">${actionBtn}</div>
  `;

  return card;
}

function _timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `Hace ${days}d`;
}

async function acceptTrade(tradeId) {
  if (!_currentUser || !_fbDb) {
    showToast('Necesit\u00e1s iniciar sesi\u00f3n.', 'error');
    return;
  }
  if (state.tradesToday >= MAX_TRADES_PER_DAY) {
    showToast('Alcanzaste el l\u00edmite diario de intercambios.', 'error');
    return;
  }

  try {
    const tradeDoc = await _fbDb.collection('trades').doc(tradeId).get();
    if (!tradeDoc.exists) {
      showToast('La oferta ya no existe.', 'error');
      return;
    }
    const trade = tradeDoc.data();
    if (trade.status !== 'open') {
      showToast('La oferta ya no est\u00e1 disponible.', 'error');
      return;
    }
    if (trade.creatorUid === _currentUser.uid) {
      showToast('No pod\u00e9s aceptar tu propia oferta.', 'error');
      return;
    }

    // Verificar que el aceptante tiene las figuritas pedidas
    for (const key of trade.wantStickers) {
      if (_getDuplicateCount(key) <= 0) {
        showToast(`No ten\u00e9s repetidas de ${_getStickerLabel(key)}.`, 'error');
        return;
      }
    }

    // === EJECUTAR INTERCAMBIO ===
    // 1. Actualizar inventario del ACEPTANTE (usuario actual)
    //    - Pierde las figuritas que el creador pidió
    //    - Gana las figuritas que el creador ofreció
    for (const key of trade.wantStickers) {
      state.inventory[key] = (state.inventory[key] || 0) - 1;
      if (state.inventory[key] <= 0) delete state.inventory[key];
    }
    for (const key of trade.offerStickers) {
      state.inventory[key] = (state.inventory[key] || 0) + 1;
    }

    // 2. Incrementar contador diario
    state.tradesToday++;
    saveState();

    // 3. Actualizar el inventario del CREADOR en Firestore
    const creatorAlbumDoc = await _fbDb.collection('albums').doc(trade.creatorUid).get();
    if (creatorAlbumDoc.exists) {
      const creatorState = creatorAlbumDoc.data();
      const creatorInv = creatorState.inventory || {};

      // El creador pierde lo que ofreció
      for (const key of trade.offerStickers) {
        creatorInv[key] = (creatorInv[key] || 0) - 1;
        if (creatorInv[key] <= 0) delete creatorInv[key];
      }
      // El creador gana lo que el aceptante le dio
      for (const key of trade.wantStickers) {
        creatorInv[key] = (creatorInv[key] || 0) + 1;
      }

      // Incrementar trades del creador
      const creatorTradesToday = (creatorState.tradesToday || 0) + 1;

      await _fbDb.collection('albums').doc(trade.creatorUid).update({
        inventory: creatorInv,
        tradesToday: creatorTradesToday
      });
    }

    // 4. Marcar trade como completado
    await _fbDb.collection('trades').doc(tradeId).update({
      status: 'completed',
      acceptedBy: _currentUser.uid,
      acceptedByEmail: _currentUser.email,
      completedAt: Date.now()
    });

    showToast('\u00a1Intercambio realizado con \u00e9xito! \ud83c\udf89', 'success');
    updateTradeDailyLimit();
    populateTradeSelectors();
    updateTopBar();
    loadMyTrades();

  } catch (e) {
    console.error('[Trade] Error al aceptar intercambio:', e);
    showToast('Error al procesar el intercambio.', 'error');
  }
}

async function cancelTrade(tradeId) {
  if (!_currentUser || !_fbDb) return;
  if (!confirm('\u00bfCancel\u00e1s esta oferta de intercambio?')) return;

  try {
    await _fbDb.collection('trades').doc(tradeId).update({
      status: 'cancelled',
      cancelledAt: Date.now()
    });
    showToast('Oferta cancelada.', 'success');
    loadMyTrades();
  } catch (e) {
    console.error('[Trade] Error al cancelar:', e);
    showToast('Error al cancelar la oferta.', 'error');
  }
}


