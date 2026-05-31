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
  usedCodes: {}    // "codigo": true
};

let currentTeamIndex = 0;

// Manejador global para probar múltiples extensiones si la primera falla (.png -> .jpg -> .jpeg etc)
window.handleImageError = function(img, basePath) {
    if (!img.fallbackIdx) img.fallbackIdx = 0;
    const exts = ['.jpg', '.jpeg', '.jpg.jpeg', '.PNG', '.JPG', '.JPEG'];
    if (img.fallbackIdx < exts.length) {
        img.src = basePath + exts[img.fallbackIdx++];
    } else {
        img.onerror = null; // Evitar loop infinito
        img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="168"><rect width="100%" height="100%" fill="%23ddd"/><text x="50%" y="50%" font-family="sans-serif" font-size="14" fill="%23666" text-anchor="middle" dy=".3em">Falta Imagen</text></svg>';
    }
};

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
}

function updateTopBar() {
  document.getElementById('coins-display').textContent = state.coins;
  
  let totalStickers = 0;
  ALBUM_CONFIG.teams.forEach(t => {
    totalStickers += t.id === 'extrastickers' ? 5 : 11;
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
  
  // Inyectar imagen de bandera como watermark decorativo (arriba-izquierda + abajo-derecha)
  const flagPath = `${ALBUM_CONFIG.basePath}/${team.id}/bandera.png`;
  document.getElementById('page-bg-left').innerHTML = `
    <img src="${flagPath}" class="flag-watermark-img flag-top-left" onerror="this.style.display='none'" />
    <img src="${flagPath}" class="flag-watermark-img" onerror="this.style.display='none'" />
  `;
  
  if (team.id === 'extrastickers') {
    document.getElementById('team-header').innerHTML = `
      <img src="${ALBUM_CONFIG.basePath}/${team.id}/bandera.png" class="team-flag-img" onerror="this.style.display='none'" />
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
          Las 5 leyendas más exclusivas de la historia del fútbol. Conseguilas abriendo sobres para completar tu colección premium al 100%.
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
  
  const totalStickers = team.id === 'extrastickers' ? 5 : 11;
  for(let i=1; i<=totalStickers; i++) {
    const cardKey = `${team.id}_${i}`;
    const isPasted = !!state.pasted[cardKey];
    const owned = state.inventory[cardKey] || 0;
    const canPaste = !isPasted && owned > 0;
    const isJustPasted = cardKey === justPastedKey;
    
    const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${i}`;
    const imgSrc = `${basePath}.png`;
    
    const slot = document.createElement('div');
    slot.className = 'sticker-slot';
    
    if (isPasted) {
      // La clase `just-pasted` se agrega directamente si acabamos de pegar esta carta
      const animClass = isJustPasted ? ' just-pasted' : '';
      slot.innerHTML = `
        <div class="sticker-card${animClass}" onclick="viewCard('${basePath}')">
          <img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')" />
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
    
    if (i <= 5) gridL.appendChild(slot);
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
  const modal = document.getElementById('sticker-modal');
  const inner = document.getElementById('modal-inner');
  inner.innerHTML = `<div class="sticker-card"><img src="${basePath}.png" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')"/></div>`;
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
    const team = ALBUM_CONFIG.teams[Math.floor(Math.random() * ALBUM_CONFIG.teams.length)];
    const maxStickers = team.id === 'extrastickers' ? 5 : 11;
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
    const imgSrc = `${basePath}.png`;
    
    const newBadgeHtml = isNew ? `<div class="new-sticker-badge">⭐ NUEVA</div>` : '';
    
    const div = document.createElement('div');
    div.style.animationDelay = `${cardsGenerated * 0.2}s`;
    div.innerHTML = `
      <div class="sticker-card revealed-card">
        ${newBadgeHtml}
        <img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')"/>
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
    const maxStickers = team.id === 'extrastickers' ? 5 : 11;
    for(let i=1; i<=maxStickers; i++){
      const key = `${team.id}_${i}`;
      const pasted = !!state.pasted[key];
      const inv = state.inventory[key] || 0;
      
      let repetidas = pasted ? inv : Math.max(0, inv - 1);
      
      if(repetidas > 0) {
        hasDups = true;
        const basePath = `${ALBUM_CONFIG.basePath}/${team.id}/${i}`;
        const imgSrc = `${basePath}.png`;
        
        const item = document.createElement('div');
        item.style.position = 'relative';
        item.innerHTML = `
          <div style="position:absolute; top:-10px; right:-10px; background:#e2001a; color:white; width:25px; height:25px; border-radius:50%; display:flex; justify-content:center; align-items:center; z-index:5; font-weight:bold;">${repetidas}</div>
          <div class="sticker-card"><img src="${imgSrc}" class="sticker-img" onerror="window.handleImageError(this, '${basePath}')"/></div>
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
function redeemCode() {
  const val = document.getElementById('code-input').value.trim().toUpperCase();
  const msg = document.getElementById('code-msg');
  
  // Limpiar mensaje previo
  msg.innerHTML = '';

  if (!val) return;

  // Inicializar por seguridad
  state.usedCodes = state.usedCodes || {};

  // Verificar si el código ya fue usado
  if (state.usedCodes[val]) {
    msg.innerHTML = "<span style='color:#dc3545'>⚠️ Este código ya fue utilizado.</span>";
    showToast("Código ya utilizado.", "error");
    return;
  }
  
  if (val === 'INFINITOPLATA') { 
    state.coins += 999999; 
    state.usedCodes[val] = true;
    msg.innerHTML = "<span style='color:#ffd700'>🤑 ¡CHEAT ACTIVADO! +999,999 🪙</span>";
    showToast("Plata infinita activada.", "success");
  }
  else if (val === 'MUNDIAL2026') { 
    state.coins += 1000; 
    state.usedCodes[val] = true;
    msg.innerHTML = "<span style='color:#28a745'>+1000 🪙</span>"; 
    showToast("¡Código canjeado! +1000 🪙", "success");
  }
  else if (val === 'LEGEND') { 
    state.coins += 150; 
    state.usedCodes[val] = true;
    msg.innerHTML = "<span style='color:#28a745'>+150 🪙</span>"; 
    showToast("¡Código canjeado! +150 🪙", "success");
  }
  else { 
    msg.innerHTML = "<span style='color:#dc3545'>Código inválido o caducado.</span>"; 
    return;
  }
  
  document.getElementById('code-input').value = '';
  saveState();
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


