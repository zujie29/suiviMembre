
"use strict";

/* =========================================
   1. CONFIGURATION ET VARIABLES
========================================= */

const DB_NAME = "suiviClientsDB";
const DB_VERSION = 1;

let db = null;
let map = null;

let clientMarkers = new Map();
let locationEditOriginals = new Map();
let markerDragHandlers = new Map();

let userMarker = null;
let userPositionCircle = null;
let userWatchId = null;

let selectedClientId = null;
let currentClientPhotoId = null;
let currentHomePhotoId = null;
let currentVisitPhotoIds = [];
let clientGps = null;
let visitGps = null;
let mapExitTarget = "dashboard";

const $ = id => document.getElementById(id);

const today = () => {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000)
    .toISOString()
    .split("T")[0];
};

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "Date inconnue";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function getInitials(firstName, lastName) {
  return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase();
}

function getClientName(client) {
  return `${client.firstName || ""} ${client.lastName || ""}`.trim();
}

function getStatusClass(status) {
  if (status === "Actif") return "active";
  if (status === "Inactif") return "inactive";
  return "pending";
}

/* =========================================
   2. NOTIFICATIONS
========================================= */

function showMessage(message, type = "success") {
  const container = $("toastContainer");

  if (!container) {
    console.log(message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3500);
}

/* =========================================
   3. BASE DE DONNÉES INDEXEDDB
========================================= */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains("clients")) {
        database.createObjectStore("clients", {
          keyPath: "id"
        });
      }

      if (!database.objectStoreNames.contains("photos")) {
        database.createObjectStore("photos", {
          keyPath: "id"
        });
      }

      if (!database.objectStoreNames.contains("visits")) {
        database.createObjectStore("visits", {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = () => {
      db = request.result;

      db.onversionchange = () => {
        db.close();
        showMessage(
          "La base de données a changé. Rechargez l'application.",
          "info"
        );
      };

      resolve(db);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

function dbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Base de données non disponible."));
      return;
    }

    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);

    let request;

    try {
      request = action(store);
    } catch (error) {
      reject(error);
      return;
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);

    transaction.onabort = () => {
      reject(transaction.error || new Error("Transaction annulée."));
    };
  });
}

function getAll(storeName) {
  return dbRequest(storeName, "readonly", store => store.getAll());
}

function getById(storeName, id) {
  return dbRequest(storeName, "readonly", store => store.get(id));
}

function saveRecord(storeName, record) {
  if (!record.id) {
    record.id = createId();
  }

  return dbRequest(storeName, "readwrite", store => store.put(record));
}

function deleteRecord(storeName, id) {
  return dbRequest(storeName, "readwrite", store => store.delete(id));
}

/* =========================================
   4. GESTION DES PHOTOS
========================================= */

async function compressImage(file, maxWidth = 1600, quality = 0.72) {
  if (!file || !file.type || !file.type.startsWith("image/")) {
    return file;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const image = new Image();

      image.onload = () => {
        const scale = Math.min(1, maxWidth / image.width);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        const mimeType = file.type === "image/png" ? "image/jpeg" : file.type;

        canvas.toBlob(blob => {
          if (!blob) {
            resolve(file);
            return;
          }

          resolve(blob.size < file.size ? blob : file);
        }, mimeType, quality);
      };

      image.onerror = () => reject(new Error("Impossible de lire l'image pour la compresser."));
      image.src = reader.result;
    };

    reader.onerror = () => reject(new Error("Lecture de l'image impossible."));
    reader.readAsDataURL(file);
  });
}

async function savePhoto(file) {
  if (!file) return null;

  const compressedFile = await compressImage(file, 1600, 0.72);
  const id = createId();

  await saveRecord("photos", {
    id,
    blob: compressedFile,
    name: file.name || "photo",
    type: compressedFile.type || file.type || "image/jpeg",
    createdAt: new Date().toISOString()
  });

  return id;
}

async function getPhoto(id) {
  if (!id) return null;

  const record = await getById("photos", id);
  return record?.blob || null;
}

async function photoURL(id) {
  const blob = await getPhoto(id);

  if (!blob) return null;

  return URL.createObjectURL(blob);
}

async function deletePhoto(id) {
  if (!id) return;

  await deleteRecord("photos", id);
}

function createPhotoPreviewItem(src, altText, onRemove) {
  const item = document.createElement("div");
  item.className = "photo-preview-item";

  const image = document.createElement("img");
  image.src = src;
  image.alt = altText;

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "photo-remove";
  removeButton.textContent = "×";
  removeButton.title = "Supprimer cette photo";
  removeButton.setAttribute("aria-label", "Supprimer cette photo");
  removeButton.addEventListener("click", onRemove);

  item.appendChild(image);
  item.appendChild(removeButton);

  return item;
}

async function displayPhotoPreview(photoId, containerId, photoKey) {
  const container = $(containerId);

  if (!container) return;

  container.innerHTML = "";

  if (!photoId) return;

  const url = await photoURL(photoId);

  if (!url) return;

  const item = createPhotoPreviewItem(url, "Aperçu de la photo", () => {
    if (photoKey === "client") {
      currentClientPhotoId = null;
      $("clientPhoto").value = "";
    }

    if (photoKey === "home") {
      currentHomePhotoId = null;
      $("homePhoto").value = "";
    }

    displayPhotoPreview(null, containerId, photoKey);
  });

  imageOnLoadRevoke(item.querySelector("img"), url);
  container.appendChild(item);
}

function imageOnLoadRevoke(image, url) {
  image.onload = () => URL.revokeObjectURL(url);
}

function previewSelectedFiles(input, containerId, photoKey) {
  const container = $(containerId);

  if (!container) return;

  container.innerHTML = "";

  Array.from(input.files || []).forEach(file => {
    const url = URL.createObjectURL(file);
    const item = createPhotoPreviewItem(url, "Nouvelle photo", () => {
      input.value = "";
      container.innerHTML = "";
    });

    imageOnLoadRevoke(item.querySelector("img"), url);
    container.appendChild(item);
  });
}

/* =========================================
   5. NAVIGATION
========================================= */

const pageTitles = {
  dashboard: "Tableau de bord",
  clients: "Gestion des clients",
  map: "Carte géographique",
  visits: "Historique des visites"
};

function navigate(pageName) {
  const activePage = document.querySelector(".page.active");

  if (pageName === "map" && activePage && activePage.id !== "map") {
    mapExitTarget = activePage.id || "dashboard";
  } else if (pageName !== "map") {
    mapExitTarget = pageName;
  }

  const page = $(pageName);

  if (!page) return;

  document.querySelectorAll(".page").forEach(element => {
    element.classList.remove("active");
  });

  page.classList.add("active");

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === pageName
    );
  });

  $("pageTitle").textContent = pageTitles[pageName] || pageName;

  $("sidebar")?.classList.remove("open");

  if (pageName === "dashboard") {
    renderDashboard();
  }

  if (pageName === "clients") {
    renderClients();
  }

  if (pageName === "map") {
    initializeMap();

    setTimeout(() => {
      map?.invalidateSize();
      renderMap();
    }, 150);
  }

  if (pageName === "visits") {
    renderVisits();
  }
}

/* =========================================
   6. GÉOLOCALISATION
========================================= */

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("La géolocalisation n'est pas disponible."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      }),
      error => {
        let message = "Impossible de récupérer votre position.";

        if (error.code === error.PERMISSION_DENIED) {
          message = "Autorisation GPS refusée. Vérifiez les permissions du navigateur.";
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          message = "Position GPS indisponible.";
        } else if (error.code === error.TIMEOUT) {
          message = "Délai de récupération GPS dépassé.";
        }

        reject(new Error(message));
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000
      }
    );
  });
}

async function getClientGPS() {
  const button = $("clientGpsButton");

  try {
    button.disabled = true;
    button.textContent = "Localisation...";

    clientGps = await getCurrentPosition();

    $("clientGpsStatus").textContent =
      `${clientGps.lat.toFixed(6)}, ${clientGps.lng.toFixed(6)} (±${Math.round(clientGps.accuracy)} m)`;

    showMessage("Position du client récupérée.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "◎ Obtenir GPS";
  }
}

async function getVisitGPS() {
  const button = $("visitGpsButton");

  try {
    button.disabled = true;
    button.textContent = "Localisation...";

    visitGps = await getCurrentPosition();

    $("visitGpsStatus").textContent =
      `${visitGps.lat.toFixed(6)}, ${visitGps.lng.toFixed(6)} (±${Math.round(visitGps.accuracy)} m)`;

    showMessage("Position de la visite récupérée.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "◎ Obtenir GPS";
  }
}

/* =========================================
   7. POSITION ACTUELLE DE L'UTILISATEUR
========================================= */

function displayUserPosition(position) {
  if (!map) return;

  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  const accuracy = position.coords.accuracy;

  const userLatLng = [lat, lng];

  const userIcon = L.divIcon({
    className: "user-location-marker",
    html: `
      <div class="user-location-dot">
        <div class="user-location-pulse"></div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  if (!userMarker) {
    userMarker = L.marker(userLatLng, {
      icon: userIcon,
      zIndexOffset: 1000
    }).addTo(map);

    userMarker.bindPopup("📍 Vous êtes ici");
  } else {
    userMarker.setLatLng(userLatLng);
  }

  if (!userPositionCircle) {
    userPositionCircle = L.circle(userLatLng, {
      radius: accuracy,
      color: "#2563eb",
      fillColor: "#3b82f6",
      fillOpacity: 0.12,
      weight: 1
    }).addTo(map);
  } else {
    userPositionCircle.setLatLng(userLatLng);
    userPositionCircle.setRadius(accuracy);
  }
}

function startUserLocationTracking() {
  if (!navigator.geolocation) {
    showMessage("La géolocalisation n'est pas disponible.", "error");
    return;
  }

  if (userWatchId !== null) {
    navigator.geolocation.clearWatch(userWatchId);
  }

  userWatchId = navigator.geolocation.watchPosition(
    displayUserPosition,
    error => {
      console.error("Erreur GPS utilisateur :", error);

      if (error.code === error.PERMISSION_DENIED) {
        showMessage("Autorisez la géolocalisation pour afficher votre position.", "error");
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000
    }
  );
}

function centerOnUserPosition() {
  if (!map || !userMarker) {
    showMessage(
      "Votre position GPS n'est pas encore disponible. Vérifiez les permissions GPS.",
      "info"
    );
    return;
  }

  map.setView(userMarker.getLatLng(), 18);
  userMarker.openPopup();
}

/* =========================================
   8. FORMULAIRE CLIENT
========================================= */

function resetClientForm() {
  $("clientForm").reset();

  $("clientId").value = "";
  currentClientPhotoId = null;
  currentHomePhotoId = null;
  clientGps = null;

  $("clientPhotoPreview").innerHTML = "";
  $("homePhotoPreview").innerHTML = "";

  $("clientGpsStatus").textContent = "Aucune position enregistrée.";
  $("clientDialogTitle").textContent = "Nouveau client";
  $("deleteClientButtonForm").hidden = true;
  $("deleteClientButtonDetail").hidden = true;
}

function openNewClient() {
  resetClientForm();
  $("clientDialog").showModal();
}

async function deleteClient(clientId) {
  const client = await getById("clients", clientId);

  if (!client) {
    showMessage("Client introuvable.", "error");
    return;
  }

  const confirmed = confirm(
    `Voulez-vous vraiment supprimer le client ${getClientName(client)} ?\nCette action supprimera aussi ses photos et ses visites.`
  );

  if (!confirmed) return;

  const [visits, allPhotos] = await Promise.all([
    getAll("visits"),
    getAll("photos")
  ]);

  const clientVisits = visits.filter(visit => visit.clientId === clientId);

  for (const visit of clientVisits) {
    for (const photoId of visit.photoIds || []) {
      await deletePhoto(photoId);
    }

    await deleteRecord("visits", visit.id);
  }

  for (const photoId of [client.photoId, client.homePhotoId]) {
    if (photoId) {
      await deletePhoto(photoId);
    }
  }

  await deleteRecord("clients", clientId);

  $("detailDialog")?.close();
  $("clientDialog")?.close();

  showMessage("Client supprimé avec succès.", "info");
  selectedClientId = null;

  await refreshApplication();
}

async function openEditClient(clientId) {
  const client = await getById("clients", clientId);

  if (!client) {
    showMessage("Client introuvable.", "error");
    return;
  }

  resetClientForm();

  $("clientId").value = client.id;
  $("memberNumber").value = client.memberNumber || "";
  $("firstName").value = client.firstName || "";
  $("lastName").value = client.lastName || "";
  $("phone").value = client.phone || "";
  $("address").value = client.address || "";
  $("clientStatus").value = client.status || "Actif";
  $("collaborator").value = client.collaborator || "";

  currentClientPhotoId = client.photoId || null;
  currentHomePhotoId = client.homePhotoId || null;
  clientGps = client.gps || null;

  $("deleteClientButtonForm").hidden = false;

  if (clientGps) {
    $("clientGpsStatus").textContent =
      `${clientGps.lat.toFixed(6)}, ${clientGps.lng.toFixed(6)}`;
  }

  await displayPhotoPreview(currentClientPhotoId, "clientPhotoPreview", "client");
  await displayPhotoPreview(currentHomePhotoId, "homePhotoPreview", "home");

  $("clientDialogTitle").textContent = "Modifier le client";
  $("clientDialog").showModal();
}

async function submitClientForm(event) {
  event.preventDefault();

  const id = $("clientId").value || createId();

  const oldClient = await getById("clients", id);

  try {
    const newClientPhoto = $("clientPhoto").files[0];
    const newHomePhoto = $("homePhoto").files[0];

    if (newClientPhoto) {
      currentClientPhotoId = await savePhoto(newClientPhoto);
    }

    if (newHomePhoto) {
      currentHomePhotoId = await savePhoto(newHomePhoto);
    }

    const client = {
      id,
      memberNumber: $("memberNumber").value.trim(),
      firstName: $("firstName").value.trim(),
      lastName: $("lastName").value.trim(),
      phone: $("phone").value.trim(),
      address: $("address").value.trim(),
      status: $("clientStatus").value,
      collaborator: $("collaborator").value.trim(),
      photoId: currentClientPhotoId,
      homePhotoId: currentHomePhotoId,
      gps: clientGps,
      createdAt: oldClient?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!client.firstName || !client.lastName) {
      showMessage("Le prénom et le nom sont obligatoires.", "error");
      return;
    }

    await saveRecord("clients", client);

    if (oldClient?.photoId && oldClient.photoId !== client.photoId) {
      await deletePhoto(oldClient.photoId);
    }

    if (oldClient?.homePhotoId && oldClient.homePhotoId !== client.homePhotoId) {
      await deletePhoto(oldClient.homePhotoId);
    }

    $("clientDialog").close();

    showMessage(oldClient ? "Client modifié avec succès." : "Client ajouté avec succès.");

    await refreshApplication();
  } catch (error) {
    console.error(error);
    showMessage("Erreur lors de l'enregistrement du client.", "error");
  }
}

/* =========================================
   9. AFFICHAGE DES CLIENTS
========================================= */

async function renderClients() {
  const container = $("clientsList");
  if (!container) return;

  const [clients] = await Promise.all([
    getAll("clients")
  ]);

  const search = $("clientSearch").value.trim().toLowerCase();
  const status = $("statusFilter").value;

  const filtered = clients.filter(client => {
    const searchable = [
      client.memberNumber,
      client.firstName,
      client.lastName,
      client.phone,
      client.address
    ].join(" ").toLowerCase();

    return searchable.includes(search) &&
      (!status || client.status === status);
  });

  filtered.sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        Aucun client ne correspond à votre recherche.
      </div>
    `;
    return;
  }

  container.innerHTML = "";

  for (const client of filtered) {
    const card = document.createElement("article");
    card.className = "client-card";

    const photo = await photoURL(client.photoId);
    const name = getClientName(client);

    card.innerHTML = `
      <div class="client-card-header">
        <div class="client-avatar">
          ${
            photo
              ? `<img src="${photo}" alt="Photo client">`
              : escapeHtml(getInitials(client.firstName, client.lastName))
          }
        </div>

        <div class="client-main-info">
          <h3>${escapeHtml(name)}</h3>
          <p>Membre : ${escapeHtml(client.memberNumber || "Non renseigné")}</p>
        </div>
      </div>

      <div class="client-card-body">
        <div class="client-meta">
          <div class="client-meta-item">
            <span>☎</span>
            ${escapeHtml(client.phone || "Téléphone non renseigné")}
          </div>

          <div class="client-meta-item">
            <span>⌖</span>
            ${escapeHtml(client.address || "Adresse non renseignée")}
          </div>

          <div class="client-meta-item">
            <span>◎</span>
            ${client.gps ? "Position GPS disponible" : "Pas de position GPS"}
          </div>
        </div>
      </div>

      <div class="client-card-footer">
        <span class="status-badge ${getStatusClass(client.status)}">
          ${escapeHtml(client.status || "En attente")}
        </span>

        <button type="button" class="view-client">
          Voir le dossier →
        </button>
      </div>
    `;

    card.querySelector(".view-client").addEventListener("click", () => {
      openClient(client.id);
    });

    container.appendChild(card);
  }
}

/* =========================================
   10. TABLEAU DE BORD
========================================= */

async function renderDashboard() {
  const [clients, visits] = await Promise.all([
    getAll("clients"),
    getAll("visits")
  ]);

  $("totalClients").textContent = clients.length;

  $("activeClients").textContent = clients.filter(
    client => client.status === "Actif"
  ).length;

  $("totalVisits").textContent = visits.length;

  $("locatedClients").textContent = clients.filter(
    client => client.gps?.lat != null && client.gps?.lng != null
  ).length;

  const recentClients = [...clients].sort((a, b) =>
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  ).slice(0, 5);

  const recentVisits = [...visits].sort((a, b) =>
    new Date(b.date || 0) - new Date(a.date || 0)
  ).slice(0, 5);

  $("recentClients").innerHTML = recentClients.length
    ? ""
    : `<div class="empty-state">Aucun client enregistré.</div>`;

  for (const client of recentClients) {
    const item = document.createElement("div");
    item.className = "recent-item";

    const photo = await photoURL(client.photoId);

    item.innerHTML = `
      <div class="recent-avatar">
        ${
          photo
            ? `<img src="${photo}" alt="">`
            : escapeHtml(getInitials(client.firstName, client.lastName))
        }
      </div>

      <div class="recent-info">
        <strong>${escapeHtml(getClientName(client))}</strong>
        <small>${escapeHtml(client.memberNumber || "Sans numéro membre")}</small>
      </div>
    `;

    item.addEventListener("click", () => openClient(client.id));
    item.style.cursor = "pointer";

    $("recentClients").appendChild(item);
  }

  $("recentVisits").innerHTML = recentVisits.length
    ? ""
    : `<div class="empty-state">Aucune visite enregistrée.</div>`;

  for (const visit of recentVisits) {
    const client = clients.find(item => item.id === visit.clientId);

    const item = document.createElement("div");
    item.className = "recent-item";

    item.innerHTML = `
      <div class="recent-avatar">▤</div>

      <div class="recent-info">
        <strong>${escapeHtml(client ? getClientName(client) : "Client supprimé")}</strong>
        <small>${escapeHtml(formatDate(visit.date))} · ${escapeHtml(visit.result || "")}</small>
      </div>
    `;

    $("recentVisits").appendChild(item);
  }
}

/* =========================================
   11. DOSSIER CLIENT
========================================= */

async function openClient(clientId) {
  const client = await getById("clients", clientId);

  if (!client) {
    showMessage("Client introuvable.", "error");
    return;
  }

  selectedClientId = clientId;

  const [photo, homePhoto, visits] = await Promise.all([
    photoURL(client.photoId),
    photoURL(client.homePhotoId),
    getAll("visits")
  ]);

  const clientVisits = visits
    .filter(visit => visit.clientId === clientId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  $("clientDetails").innerHTML = `
    <div class="client-detail-header">
      <div class="client-detail-avatar">
        ${
          photo
            ? `<img src="${photo}" alt="Photo client">`
            : escapeHtml(getInitials(client.firstName, client.lastName))
        }
      </div>

      <div>
        <h3>${escapeHtml(getClientName(client))}</h3>
        <p>Membre : ${escapeHtml(client.memberNumber || "Non renseigné")}</p>
        <span class="status-badge ${getStatusClass(client.status)}">
          ${escapeHtml(client.status || "En attente")}
        </span>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-item">
        <span>Téléphone</span>
        <strong>${escapeHtml(client.phone || "Non renseigné")}</strong>
      </div>

      <div class="detail-item">
        <span>Collaborateur</span>
        <strong>${escapeHtml(client.collaborator || "Non renseigné")}</strong>
      </div>

      <div class="detail-item">
        <span>Adresse</span>
        <strong>${escapeHtml(client.address || "Non renseignée")}</strong>
      </div>

      <div class="detail-item">
        <span>Coordonnées GPS</span>
        <strong>
          ${
            client.gps
              ? `${client.gps.lat.toFixed(6)}, ${client.gps.lng.toFixed(6)}`
              : "Non disponibles"
          }
        </strong>
      </div>

      <div class="detail-item">
        <span>Nombre de visites</span>
        <strong>${clientVisits.length}</strong>
      </div>

      <div class="detail-item">
        <span>Date d'inscription</span>
        <strong>${escapeHtml(formatDate(client.createdAt?.split("T")[0]))}</strong>
      </div>
    </div>

    <div class="detail-photos">
      ${photo ? `<img src="${photo}" alt="Photo client">` : ""}
      ${homePhoto ? `<img src="${homePhoto}" alt="Domicile client">` : ""}
    </div>

    <div class="form-section" style="margin-top:25px">
      <h3>Historique des visites</h3>

      ${
        clientVisits.length
          ? clientVisits.map(visit => `
            <div class="detail-item" style="margin-bottom:8px">
              <span>${escapeHtml(formatDate(visit.date))}</span>
              <strong>${escapeHtml(visit.result || "Visite")}</strong>
              <p style="margin-top:7px;color:var(--text-secondary);font-size:11px">
                ${escapeHtml(visit.observations || "Aucune observation")}
              </p>
            </div>
          `).join("")
          : `<div class="empty-state">Aucune visite pour ce client.</div>`
      }
    </div>
  `;

  $("detailDialog").showModal();
  $("deleteClientButtonDetail").hidden = false;
}

/* =========================================
   12. CARTE LEAFLET
========================================= */

function initializeMap() {
  if (map) return;

  map = L.map("map").setView([-18.8792, 47.5079], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);

  startUserLocationTracking();
}

async function createClientMarkerIcon(client) {
  const photo = await photoURL(client.photoId);

  const content = photo
    ? `<img src="${photo}" alt="">`
    : `<span class="marker-number">${escapeHtml(client.memberNumber || "?")}</span>`;

  return L.divIcon({
    className: "client-map-marker",
    html: `<div class="marker-content">${content}</div>`,
    iconSize: [39, 39],
    iconAnchor: [19, 39],
    popupAnchor: [0, -38]
  });
}

async function renderMap() {
  if (!map) return;

  clientMarkers.forEach(marker => {
    map.removeLayer(marker);
  });

  clientMarkers.clear();
  locationEditOriginals.clear();
  markerDragHandlers.clear();

  const clients = await getAll("clients");

  const locatedClients = clients.filter(client =>
    client.gps &&
    Number.isFinite(Number(client.gps.lat)) &&
    Number.isFinite(Number(client.gps.lng))
  );

  for (const client of locatedClients) {
    const icon = await createClientMarkerIcon(client);

    const marker = L.marker(
      [Number(client.gps.lat), Number(client.gps.lng)],
      {
        icon,
        draggable: false
      }
    ).addTo(map);

    marker.bindPopup(`
      <div class="map-popup">
        <h3>${escapeHtml(getClientName(client))}</h3>

        <p>
          Membre : ${escapeHtml(client.memberNumber || "Non renseigné")}
        </p>

        <p>
          ${escapeHtml(client.address || "Adresse non renseignée")}
        </p>

        <div class="map-popup-actions">
          <button onclick="openClient('${client.id}')">
            Voir le dossier client
          </button>

          <button onclick="startClientLocationEdit('${client.id}')">
            Déplacer ce marqueur
          </button>
        </div>
      </div>
    `);

    clientMarkers.set(client.id, marker);
  }

  if (locatedClients.length && !userMarker) {
    const bounds = L.latLngBounds(
      locatedClients.map(client => [
        Number(client.gps.lat),
        Number(client.gps.lng)
      ])
    );

    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}

async function focusClientOnMap(clientId) {
  $("detailDialog").close();
  navigate("map");

  setTimeout(async () => {
    map?.invalidateSize();
    await renderMap();

    const marker = clientMarkers.get(clientId);

    if (!marker) {
      showMessage("Ce client ne possède pas de position GPS.", "info");
      return;
    }

    map.setView(marker.getLatLng(), 18);
    marker.openPopup();
  }, 250);
}

/* =========================================
   13. DÉPLACEMENT MANUEL DES MARQUEURS
========================================= */

function startClientLocationEdit(clientId) {
  const marker = clientMarkers.get(clientId);

  if (!marker) {
    showMessage("Marqueur introuvable.", "error");
    return;
  }

  if (marker.dragging) {
    marker.dragging.enable();
  }

  locationEditOriginals.set(clientId, marker.getLatLng());

  marker.closePopup();

  marker.bindPopup(`
    <div class="map-popup">
      <h3>Modification de position</h3>
      <p>Déplacez le marqueur vers le bon emplacement.</p>

      <div class="map-popup-actions">
        <button onclick="saveClientLocation('${clientId}')">
          ✓ Enregistrer la position
        </button>

        <button class="danger" onclick="cancelClientLocationEdit('${clientId}')">
          Annuler le déplacement
        </button>
      </div>
    </div>
  `).openPopup();

  markerDragHandlers.set(clientId, true);

  showMessage("Déplacez le marqueur puis enregistrez.");
}

async function saveClientLocation(clientId) {
  const marker = clientMarkers.get(clientId);

  if (!marker) return;

  const position = marker.getLatLng();
  const client = await getById("clients", clientId);

  if (!client) {
    showMessage("Client introuvable.", "error");
    return;
  }

  client.gps = {
    lat: position.lat,
    lng: position.lng,
    accuracy: null
  };

  client.updatedAt = new Date().toISOString();

  try {
    await saveRecord("clients", client);

    if (marker.dragging) {
      marker.dragging.disable();
    }

    locationEditOriginals.delete(clientId);
    markerDragHandlers.delete(clientId);

    marker.closePopup();

    showMessage("Nouvelle position du client enregistrée.");

    await renderMap();
    await renderDashboard();
  } catch (error) {
    console.error(error);
    showMessage("Impossible d'enregistrer la position.", "error");
  }
}

function cancelClientLocationEdit(clientId) {
  const marker = clientMarkers.get(clientId);
  const original = locationEditOriginals.get(clientId);

  if (!marker || !original) return;

  marker.setLatLng(original);

  if (marker.dragging) {
    marker.dragging.disable();
  }

  locationEditOriginals.delete(clientId);
  markerDragHandlers.delete(clientId);

  marker.closePopup();

  showMessage("Déplacement annulé.", "info");
}

/* =========================================
   14. FORMULAIRE VISITE
========================================= */

function resetVisitForm() {
  $("visitForm").reset();

  $("visitId").value = "";
  $("visitDate").value = today();

  currentVisitPhotoIds = [];
  visitGps = null;

  $("visitPhotosPreview").innerHTML = "";
  $("visitGpsStatus").textContent = "Aucune position enregistrée.";
}

async function populateVisitClients() {
  const clients = await getAll("clients");
  const select = $("visitClient");

  select.innerHTML = `<option value="">Sélectionner un client</option>`;

  clients.sort((a, b) =>
    getClientName(a).localeCompare(getClientName(b), "fr")
  );

  clients.forEach(client => {
    const option = document.createElement("option");

    option.value = client.id;
    option.textContent =
      `${getClientName(client)} (${client.memberNumber || "Sans numéro"})`;

    select.appendChild(option);
  });
}

async function openNewVisit(clientId = null) {
  resetVisitForm();
  await populateVisitClients();

  if (clientId) {
    $("visitClient").value = clientId;
  }

  $("visitDialog").showModal();
}

async function submitVisitForm(event) {
  event.preventDefault();

  const id = $("visitId").value || createId();
  const oldVisit = await getById("visits", id);

  try {
    const files = Array.from($("visitPhotos").files || []);
    const newPhotoIds = [];

    for (const file of files) {
      const photoId = await savePhoto(file);
      if (photoId) newPhotoIds.push(photoId);
    }

    const visit = {
      id,
      clientId: $("visitClient").value,
      date: $("visitDate").value,
      result: $("visitResult").value,
      observations: $("visitObservations").value.trim(),
      gps: visitGps,
      photoIds: [
        ...(oldVisit?.photoIds || currentVisitPhotoIds),
        ...newPhotoIds
      ],
      createdAt: oldVisit?.createdAt || new Date().toISOString()
    };

    if (!visit.clientId) {
      showMessage("Veuillez sélectionner un client.", "error");
      return;
    }

    await saveRecord("visits", visit);

    $("visitDialog").close();

    showMessage("Visite enregistrée avec succès.");

    await refreshApplication();
  } catch (error) {
    console.error(error);
    showMessage("Erreur lors de l'enregistrement de la visite.", "error");
  }
}

/* =========================================
   15. AFFICHAGE DES VISITES
========================================= */

async function renderVisits() {
  const container = $("visitsList");
  if (!container) return;

  const [visits, clients] = await Promise.all([
    getAll("visits"),
    getAll("clients")
  ]);

  visits.sort((a, b) =>
    new Date(b.date || 0) - new Date(a.date || 0)
  );

  if (!visits.length) {
    container.innerHTML = `
      <div class="empty-state">
        Aucune visite enregistrée.
      </div>
    `;
    return;
  }

  container.innerHTML = "";

  for (const visit of visits) {
    const client = clients.find(item => item.id === visit.clientId);
    const date = visit.date || "";
    const day = date ? date.split("-")[2] : "--";
    const month = date
      ? new Date(`${date}T00:00:00`).toLocaleDateString("fr-FR", {
          month: "short"
        })
      : "--";

    const item = document.createElement("article");
    item.className = "visit-item";

    item.innerHTML = `
      <div class="visit-date">
        <strong>${escapeHtml(day)}</strong>
        <small>${escapeHtml(month)}</small>
      </div>

      <div class="visit-info">
        <h3>${escapeHtml(client ? getClientName(client) : "Client supprimé")}</h3>

        <p>
          ${escapeHtml(visit.result || "Visite")}
          · ${escapeHtml(formatDate(visit.date))}
        </p>

        <p>${escapeHtml(visit.observations || "Aucune observation")}</p>

        ${
          visit.photoIds?.length
            ? `<p>${visit.photoIds.length} photo(s) jointe(s)</p>`
            : ""
        }
      </div>

      <div class="visit-actions">
        <button type="button" class="delete-visit" title="Supprimer la visite">
          🗑
        </button>
      </div>
    `;

    item.querySelector(".delete-visit").addEventListener("click", async () => {
      const confirmed = confirm("Voulez-vous vraiment supprimer cette visite ?");

      if (!confirmed) return;

      for (const photoId of visit.photoIds || []) {
        await deletePhoto(photoId);
      }

      await deleteRecord("visits", visit.id);

      showMessage("Visite supprimée.", "info");
      await refreshApplication();
    });

    container.appendChild(item);
  }
}

/* =========================================
   16. EXPORTATION ZIP
========================================= */

async function exportBackup() {
  try {
    const zip = new JSZip();

    const [clients, visits, photos] = await Promise.all([
      getAll("clients"),
      getAll("visits"),
      getAll("photos")
    ]);

    const photoFolder = zip.folder("photos");

    for (const photo of photos) {
      if (photo.blob) {
        photoFolder.file(
          `${photo.id}`,
          photo.blob
        );
      }
    }

    const database = {
      application: "Suivi Clients",
      version: 1,
      exportedAt: new Date().toISOString(),
      clients,
      visits,
      photos: photos.map(photo => ({
        id: photo.id,
        name: photo.name || "photo",
        type: photo.type || photo.blob?.type || "image/jpeg",
        createdAt: photo.createdAt || null
      }))
    };

    zip.file("database.json", JSON.stringify(database, null, 2));

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `suivi-clients-${today()}.zip`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showMessage("Sauvegarde ZIP exportée avec succès.");
  } catch (error) {
    console.error(error);
    showMessage("Erreur lors de l'exportation.", "error");
  }
}

/* =========================================
   17. IMPORTATION ZIP AVEC FUSION
========================================= */

function getRecordTimestamp(record) {
  if (!record) return 0;

  const rawValue = record.updatedAt || record.createdAt || record.date || record.exportedAt || 0;
  const parsed = new Date(rawValue).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldReplaceImportedRecord(current, incoming) {
  if (!current) return true;

  const currentTime = getRecordTimestamp(current);
  const incomingTime = getRecordTimestamp(incoming);

  if (incomingTime > currentTime) return true;
  if (incomingTime === currentTime) {
    return JSON.stringify(incoming) !== JSON.stringify(current);
  }

  return false;
}

async function replaceDatabaseFromBackup(database, zip) {
  const clearStores = [
    dbRequest("photos", "readwrite", store => store.clear()),
    dbRequest("clients", "readwrite", store => store.clear()),
    dbRequest("visits", "readwrite", store => store.clear())
  ];

  await Promise.all(clearStores);

  const importedPhotos = database.photos || [];

  for (const photo of importedPhotos) {
    const photoFile = zip.file(`photos/${photo.id}`);

    if (!photoFile) continue;

    const blob = await photoFile.async("blob");

    await saveRecord("photos", {
      id: photo.id,
      blob,
      name: photo.name || "photo",
      type: photo.type || blob.type || "image/jpeg",
      createdAt: photo.createdAt || new Date().toISOString(),
      updatedAt: photo.updatedAt || photo.createdAt || new Date().toISOString()
    });
  }

  for (const client of database.clients || []) {
    await saveRecord("clients", {
      ...client,
      updatedAt: client.updatedAt || client.createdAt || new Date().toISOString()
    });
  }

  for (const visit of database.visits || []) {
    await saveRecord("visits", {
      ...visit,
      updatedAt: visit.updatedAt || visit.createdAt || new Date().toISOString()
    });
  }
}

async function mergeDatabaseFromBackup(database, zip) {
  const [existingClients, existingVisits, existingPhotos] = await Promise.all([
    getAll("clients"),
    getAll("visits"),
    getAll("photos")
  ]);

  const clientsMap = new Map(existingClients.map(item => [item.id, item]));
  const visitsMap = new Map(existingVisits.map(item => [item.id, item]));
  const photosMap = new Map(existingPhotos.map(item => [item.id, item]));

  const importedPhotos = database.photos || [];

  for (const photo of importedPhotos) {
    const current = photosMap.get(photo.id);
    const photoFile = zip.file(`photos/${photo.id}`);

    if (!photoFile) continue;

    const blob = await photoFile.async("blob");
    const importedPhoto = {
      id: photo.id,
      blob,
      name: photo.name || "photo",
      type: photo.type || blob.type || "image/jpeg",
      createdAt: photo.createdAt || new Date().toISOString(),
      updatedAt: photo.updatedAt || photo.createdAt || new Date().toISOString()
    };

    if (!current || shouldReplaceImportedRecord(current, importedPhoto)) {
      await saveRecord("photos", importedPhoto);
    }
  }

  for (const client of database.clients || []) {
    const current = clientsMap.get(client.id);
    const importedClient = {
      ...client,
      updatedAt: client.updatedAt || client.createdAt || new Date().toISOString()
    };

    if (!current || shouldReplaceImportedRecord(current, importedClient)) {
      await saveRecord("clients", importedClient);
    }
  }

  for (const visit of database.visits || []) {
    const current = visitsMap.get(visit.id);
    const importedVisit = {
      ...visit,
      updatedAt: visit.updatedAt || visit.createdAt || new Date().toISOString()
    };

    if (!current || shouldReplaceImportedRecord(current, importedVisit)) {
      await saveRecord("visits", importedVisit);
    }
  }
}

async function importBackup(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  try {
    const zip = await JSZip.loadAsync(file);
    const databaseFile = zip.file("database.json");

    if (!databaseFile) {
      throw new Error("Le fichier database.json est absent.");
    }

    const database = JSON.parse(await databaseFile.async("string"));

    if (!Array.isArray(database.clients) ||
        !Array.isArray(database.visits)) {
      throw new Error("Format de sauvegarde invalide.");
    }

    const existingClients = await getAll("clients");
    const existingVisits = await getAll("visits");
    const hasExistingData = existingClients.length || existingVisits.length;

    let shouldReplace = false;

    if (hasExistingData) {
     shouldReplace = !confirm(
        "Importer la base sélectionnée ?\n\n- OK = mettre à jour la base existante en comparant les changements\n- Annuler = remplacer entièrement la base locale"
      );
   }

   if (shouldReplace) {
     await replaceDatabaseFromBackup(database, zip);
     showMessage("Base locale remplacée par la sauvegarde importée.", "info");
   } else {
     await mergeDatabaseFromBackup(database, zip);
     showMessage("Base mise à jour avec les nouvelles données importées.", "success");
   }

   await refreshApplication();
 } catch (error) {
   console.error(error);
   showMessage(
     `Importation impossible : ${error.message}`,
     "error"
   );
 } finally {
   event.target.value = "";
 }
}

/* =========================================
   18. ACTUALISATION GÉNÉRALE
========================================= */

async function refreshApplication() {
 await Promise.all([
   renderDashboard(),
   renderClients(),
   renderVisits()
 ]);

 if (map) {
   await renderMap();
 }
}

/* =========================================
   19. ÉVÉNEMENTS
========================================= */

function initializeEvents() {

  /* Navigation */

  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      navigate(button.dataset.page);
    });
  });

  /* Menu mobile */

  $("menuToggle").addEventListener("click", () => {
    $("sidebar").classList.toggle("open");
  });

  /* Clients */

  $("newClientButton").addEventListener("click", openNewClient);
  $("clientsNewButton").addEventListener("click", openNewClient);

  $("clientForm").addEventListener("submit", submitClientForm);

  $("clientSearch").addEventListener("input", renderClients);
  $("statusFilter").addEventListener("change", renderClients);

  $("clearSearch").addEventListener("click", () => {
    $("clientSearch").value = "";
    renderClients();
  });

  $("clientGpsButton").addEventListener("click", getClientGPS);

  $("clientPhoto").addEventListener("change", () => {
    previewSelectedFiles($("clientPhoto"), "clientPhotoPreview", "client");
  });

  $("homePhoto").addEventListener("change", () => {
    previewSelectedFiles($("homePhoto"), "homePhotoPreview", "home");
  });

  /* Dossier client */

  $("deleteClientButtonForm").addEventListener("click", async () => {
    const id = $("clientId").value;

    if (!id) return;

    await deleteClient(id);
  });

  $("deleteClientButtonDetail").addEventListener("click", async () => {
    if (!selectedClientId) return;

    await deleteClient(selectedClientId);
  });

  $("editClientButton").addEventListener("click", async () => {
    const id = selectedClientId;

    if (!id) return;

    $("detailDialog").close();
    await openEditClient(id);
  });

  $("showClientOnMapButton").addEventListener("click", () => {
    if (selectedClientId) {
      focusClientOnMap(selectedClientId);
    }
  });

  $("addVisitForClientButton").addEventListener("click", async () => {
    const id = selectedClientId;

    if (!id) return;

    $("detailDialog").close();
    await openNewVisit(id);
  });

  /* Carte */

  $("refreshMapButton").addEventListener("click", async () => {
    await renderMap();
    showMessage("Carte actualisée.", "info");
  });

  $("exitMapButton").addEventListener("click", () => {
    navigate(mapExitTarget || "dashboard");
  });

  $("myLocationButton").addEventListener("click", centerOnUserPosition);

  /* Visites */

  $("newVisitButton").addEventListener("click", () => openNewVisit());

  $("visitForm").addEventListener("submit", submitVisitForm);

  $("visitGpsButton").addEventListener("click", getVisitGPS);

  $("visitPhotos").addEventListener("change", () => {
    previewSelectedFiles($("visitPhotos"), "visitPhotosPreview");
  });

  /* Sauvegardes */

  $("exportButton").addEventListener("click", exportBackup);

  $("importFile").addEventListener("change", importBackup);

  /* Fermeture des dialogues */

  document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => {
      const dialog = $(button.dataset.close);
      dialog?.close();
    });
  });

  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("click", event => {
      if (event.target === dialog) {
        dialog.close();
      }
    });
  });
}

/* =========================================
   20. INITIALISATION
========================================= */

async function initializeApplication() {
  try {
    await openDatabase();

    initializeEvents();

    await refreshApplication();

    $("visitDate").value = today();

    navigate("dashboard");

    console.log("Application Suivi Clients initialisée.");
  } catch (error) {
    console.error("Erreur d'initialisation :", error);

    showMessage(
      "Impossible d'initialiser l'application. Vérifiez la console.",
      "error"
    );
  }
}

document.addEventListener("DOMContentLoaded", initializeApplication);
