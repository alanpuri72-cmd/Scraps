(() => {
  const DATABASE_NAME = "Scraps";
  const DATABASE_VERSION = 1;
  const PROJECTS_STORE = "projects";
  const LEGACY_STORAGE_KEY = "Scraps-projects-v1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const appRoot = $("#app");
  const authView = $("#auth-view");
  const galleryView = $("#gallery-view");
  const editorView = $("#editor-view");
  const projectsGrid = $("#projects-grid");
  const pageItems = $("#page-items");
  const pageElement = $("#scrapbook-page");
  const photoInput = $("#photo-input");
  const modalRoot = $("#modal-root");
  const toast = $("#toast");
  let projects = [];
  let databasePromise;
  let currentProject = null;
  let currentPageIndex = 0;
  let selectedItemId = null;
  let zoom = 1;
  let toastTimer;
  let saveTimer;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(PROJECTS_STORE)) {
            request.result.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open the scrapbook database."));
        request.onblocked = () => reject(new Error("The scrapbook database is blocked by another open tab."));
      });
    }
    return databasePromise;
  }

  function runTransaction(mode, operation) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(PROJECTS_STORE, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("The scrapbook database transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("The scrapbook database transaction was aborted."));
      try {
        result = operation(transaction.objectStore(PROJECTS_STORE));
        if (result && typeof result === "object" && "onsuccess" in result) {
          const request = result;
          request.onsuccess = () => { result = request.result; };
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    }));
  }

  async function loadProjects() {
    const saved = await runTransaction("readonly", store => store.getAll());
    const validProjects = saved.filter(project => project && typeof project.id === "string" && Array.isArray(project.pages));
    if (validProjects.length) return validProjects;

    let legacy;
    try {
      legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      console.error("Could not check for older saved scrapbooks.", error);
      return [];
    }
    if (!legacy) return [];
    let imported;
    try {
      const parsed = JSON.parse(legacy);
      imported = Array.isArray(parsed) ? parsed.filter(project => project && typeof project.id === "string" && Array.isArray(project.pages)) : [];
    } catch (error) {
      console.error("Could not import older saved scrapbooks.", error);
      return [];
    }
    if (imported.length) {
      await runTransaction("readwrite", store => imported.forEach(project => store.put(project)));
    }
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      console.error("Could not remove the migrated scrapbook data.", error);
    }
    return imported;
  }

  function saveProject(project) {
    return runTransaction("readwrite", store => store.put(project));
  }

  function scheduleSave() {
    $("#save-status").textContent = "Saving…";
    clearTimeout(saveTimer);
    const project = currentProject;
    saveTimer = setTimeout(async () => {
      if (!project) return;
      try {
        await saveProject(project);
        $("#save-status").innerHTML = "<i></i> Saved privately";
      } catch (error) {
        console.error("Could not save scrapbook data.", error);
        $("#save-status").textContent = "Could not save";
        showToast("Could not save this scrapbook to the local database.");
      }
    }, 250);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function renderGallery() {
    projects.sort((first, second) => new Date(second.updatedAt || second.createdAt || 0) - new Date(first.updatedAt || first.createdAt || 0));
    $("#project-count").textContent = projects.length;
    projectsGrid.innerHTML = projects.map(project => {
      const firstImage = project.pages.flatMap(page => page.items || []).find(item => item.type === "image");
      const firstText = project.pages.flatMap(page => page.items || []).find(item => item.type === "text");
      const title = escapeHtml(project.title || "Untitled scrapbook");
      const cover = firstImage
        ? `<img src="${photoSource(project, firstImage)}" alt="">`
        : `<div class="cover-placeholder"><span>✿</span></div>`;
      const caption = firstText ? escapeHtml(firstText.text).slice(0, 40) : "little moments";
      return `<article class="project-card" data-project-id="${escapeHtml(project.id)}">
        <button class="project-open-button" type="button" aria-label="Open ${title}">
          <div class="project-cover"><span class="cover-tape"></span><div class="project-cover-inner">${cover}<span class="cover-caption">${caption}</span></div></div>
          <div class="project-meta"><div><h3>${title}</h3><p>${project.pages.length} ${project.pages.length === 1 ? "page" : "pages"} · edited ${relativeDate(project.updatedAt)}</p></div><span class="project-arrow">↗</span></div>
        </button>
        <div class="project-actions">
          <button class="project-action-button" type="button" data-project-action="rename" aria-label="Rename ${title}">Rename</button>
          <button class="project-action-button project-delete-button" type="button" data-project-action="delete" aria-label="Delete ${title}">Delete</button>
        </div>
      </article>`;
    }).join("");
    $$(".project-open-button").forEach(button => {
      button.addEventListener("click", () => openProject(button.closest(".project-card").dataset.projectId));
    });
    $$(".project-action-button").forEach(button => {
      button.addEventListener("click", () => {
        const projectId = button.closest(".project-card").dataset.projectId;
        if (button.dataset.projectAction === "rename") openRenameModal(projectId);
        else deleteProject(projectId);
      });
    });
  }

  function openRenameModal(projectId) {
    const project = projects.find(entry => entry.id === projectId);
    if (!project) return;
    modalRoot.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="rename-project-form">
      <h2>Rename project.</h2><p>Choose a new name for this project.</p>
      <label for="rename-project-title">PROJECT NAME</label><input id="rename-project-title" name="title" type="text" maxlength="60" autocomplete="off" required value="${escapeHtml(project.title || "")}">
      <div class="modal-actions"><button type="button" class="modal-cancel" id="cancel-rename">Cancel</button><button type="submit" class="button button-dark">Save name</button></div>
    </form></div>`;
    const form = $("#rename-project-form");
    const titleInput = $("#rename-project-title");
    titleInput.focus();
    titleInput.select();
    $("#cancel-rename").addEventListener("click", () => modalRoot.innerHTML = "");
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      const previousTitle = project.title;
      const previousUpdatedAt = project.updatedAt;
      project.title = title;
      project.updatedAt = new Date().toISOString();
      const saveButton = $("button[type='submit']", form);
      saveButton.disabled = true;
      try {
        await saveProject(project);
        modalRoot.innerHTML = "";
        renderGallery();
      } catch (error) {
        project.title = previousTitle;
        project.updatedAt = previousUpdatedAt;
        saveButton.disabled = false;
        console.error("Could not rename scrapbook.", error);
        showToast("Could not save the new project name.");
      }
    });
  }

  async function deleteProject(projectId) {
    const project = projects.find(entry => entry.id === projectId);
    if (!project || !confirm(`Delete "${project.title || "Untitled scrapbook"}" and all of its pages and photos? This cannot be undone.`)) return;
    try {
      await runTransaction("readwrite", store => store.delete(projectId));
      projects = projects.filter(entry => entry.id !== projectId);
      renderGallery();
    } catch (error) {
      console.error("Could not delete scrapbook.", error);
      showToast("Could not delete this project from the local database.");
    }
  }

  function setAuthMode(mode) {
    const isSignup = mode === "signup";
    $("#signup-tab").classList.toggle("active", isSignup);
    $("#signup-tab").setAttribute("aria-selected", String(isSignup));
    $("#signup-tab").tabIndex = isSignup ? 0 : -1;
    $("#login-tab").classList.toggle("active", !isSignup);
    $("#login-tab").setAttribute("aria-selected", String(!isSignup));
    $("#login-tab").tabIndex = isSignup ? -1 : 0;
    $("#auth-form").setAttribute("aria-labelledby", isSignup ? "signup-tab" : "login-tab");
    $("#auth-title").innerHTML = isSignup ? "Welcome to<br><em>little folio.</em>" : "Welcome<br><em>back.</em>";
    $("#auth-password").setAttribute("placeholder", isSignup ? "At least 8 characters" : "Your password");
    $("#auth-password").minLength = isSignup ? 8 : 1;
    $("#auth-submit").textContent = isSignup ? "Sign up (demo)" : "Log in (demo)";
  }

  function enterDemoGallery() {
    $("#auth-form").reset();
    appRoot.classList.remove("auth-screen");
    authView.classList.add("hidden");
    galleryView.classList.remove("hidden");
    renderGallery();
    showToast("Demo only: no account was created; projects are stored in this browser.");
  }

  function relativeDate(timestamp) {
    const date = new Date(timestamp || Date.now());
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days < 1) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function openCreateModal() {
    modalRoot.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="create-project-form">
      <h2>Start a new project.</h2><p>Give it a name to get started.</p>
      <label for="project-name">PROJECT NAME</label><input id="project-name" name="title" type="text" maxlength="60" placeholder="A summer to remember" autocomplete="off" required>
      <div class="modal-actions"><button type="button" class="modal-cancel" id="cancel-create">Maybe later</button><button type="submit" class="button button-dark">Start project <span>↗</span></button></div>
    </form></div>`;
    const form = $("#create-project-form");
    $("#project-name").focus();
    $("#cancel-create").addEventListener("click", () => modalRoot.innerHTML = "");
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = $("#project-name").value.trim();
      if (!title) return;
      const project = { id: makeId(), title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pages: [{ id: makeId(), items: [], backgroundColor: "#fcfaf4" }] };
      projects.unshift(project);
      const submit = $("button[type='submit']", form);
      submit.disabled = true;
      submit.textContent = "Creating…";
      saveProject(project).then(() => {
        modalRoot.innerHTML = "";
        openProject(project.id);
      }).catch(error => {
        projects = projects.filter(entry => entry.id !== project.id);
        submit.disabled = false;
        submit.textContent = "Start project";
        console.error("Could not create scrapbook.", error);
        showToast("Could not create a scrapbook in the local database.");
      });
    });
  }

  function openProject(projectId) {
    currentProject = projects.find(project => project.id === projectId);
    if (!currentProject) return;
    if (!currentProject.pages.length) currentProject.pages.push({ id: makeId(), items: [], backgroundColor: "#fcfaf4" });
    currentProject.pages.forEach(page => {
      if (!page.backgroundColor) page.backgroundColor = "#fcfaf4";
    });
    if (!Array.isArray(currentProject.photos)) currentProject.photos = [];
    currentPageIndex = 0;
    selectedItemId = null;
    galleryView.classList.add("hidden");
    editorView.classList.remove("hidden");
    $("#editor-title").textContent = currentProject.title;
    zoom = 1;
    updateZoom();
    renderEditor();
  }

  function currentPage() { return currentProject?.pages?.[currentPageIndex] || null; }

  function photoSource(project, item) {
    if (item.photoId) return project.photos?.find(photo => photo.id === item.photoId)?.src || "";
    return item.src || "";
  }

  function renderEditor() {
    if (!currentProject) return;
    pageItems.innerHTML = "";
    const page = currentPage();
    if (page && !page.backgroundColor) page.backgroundColor = "#fcfaf4";
    pageElement.style.background = page.backgroundColor || "#fcfaf4";
    const swatches = $$(".page-color-swatch");
    swatches.forEach(swatch => swatch.classList.toggle("selected", swatch.dataset.pageColor === page.backgroundColor));
    const items = page.items || (page.items = []);
    items.forEach(item => {
      const element = document.createElement("div");
      element.className = `page-item${item.id === selectedItemId ? " selected" : ""}`;
      element.dataset.itemId = item.id;
      element.style.left = `${item.x}%`;
      element.style.top = `${item.y}%`;
      element.style.width = `${item.width}%`;
      element.style.height = `${item.height}%`;
      if (item.type === "image") {
        const image = document.createElement("img");
        image.src = photoSource(currentProject, item);
        image.alt = "Scrapbook photo";
        element.append(image);
      } else {
        const text = document.createElement("div");
        text.className = `page-item-text${item.type === "sticker" ? " page-item-sticker" : ""}`;
        text.textContent = item.text;
        text.style.fontFamily = fontStack(item.font);
        text.style.fontSize = `${item.fontSize || 28}px`;
        text.style.color = item.color || "#303b2e";
        text.style.textAlign = item.align || "center";
        text.style.lineHeight = item.type === "sticker" ? "1" : "1.2";
        text.style.fontWeight = item.type === "sticker" ? "700" : "400";
        element.append(text);
      }
      const handle = document.createElement("span");
      handle.className = "item-resize-handle";
      element.append(handle);
      element.addEventListener("pointerdown", onItemPointerDown);
      element.addEventListener("click", event => { event.stopPropagation(); selectItem(item.id); });
      pageItems.append(element);
    });
    $("#page-empty-hint").classList.add("hidden");
    $("#page-title-label").textContent = `PAGE ${String(currentPageIndex + 1).padStart(2, "0")}`;
    $("#page-count-label").textContent = `${currentProject.pages.length} ${currentProject.pages.length === 1 ? "page" : "pages"}`;
    renderPageStrip();
    updateInspector();
  }

  function fontStack(font) {
    return font === "hand" ? '"Comic Sans MS", "Segoe Print", cursive' : font === "sans" ? '"Segoe UI", Arial, sans-serif' : 'Georgia, "Times New Roman", serif';
  }

  function renderPageStrip() {
    $("#page-strip").innerHTML = currentProject.pages.map((page, index) => {
      const image = page.items.find(item => item.type === "image");
      const text = page.items.find(item => item.type === "text");
      return `<button class="page-thumb${index === currentPageIndex ? " active" : ""}" data-page-index="${index}" aria-label="Go to page ${index + 1}">
        ${image ? `<img class="thumb-image" src="${photoSource(currentProject, image)}" alt="">` : ""}
        ${text ? `<span class="thumb-text">${escapeHtml(text.text).slice(0, 9)}</span>` : ""}
        <span>${String(index + 1).padStart(2, "0")}</span>
      </button>`;
    }).join("");
    $$(".page-thumb").forEach(button => button.addEventListener("click", () => {
      currentPageIndex = Number(button.dataset.pageIndex);
      selectedItemId = null;
      renderEditor();
    }));
  }

  function selectItem(itemId) {
    selectedItemId = itemId;
    renderEditor();
  }

  function selectedItem() {
    return currentPage()?.items?.find(item => item.id === selectedItemId) || null;
  }

  function updateInspector() {
    const item = selectedItem();
    const isTextLike = item && (item.type === "text" || item.type === "sticker");
    $("#inspector-empty").classList.toggle("hidden", Boolean(item));
    $("#text-controls").classList.toggle("hidden", !isTextLike);
    $("#image-controls").classList.toggle("hidden", !item || item.type !== "image");
    $("#sticker-size-controls").classList.toggle("hidden", !item || item.type !== "sticker");
    $("#inspector-title").textContent = item ? (item.type === "image" ? "Your photo" : item.type === "sticker" ? "A sticker" : "A little note") : "A little note";
    $("#inspector-description").textContent = item ? (item.type === "image" ? "Adjust, crop, or move your photo." : item.type === "sticker" ? "A tiny bit of personality for the page." : "Say it just the way you like.") : "Pick something on your page to make it your own.";
    if (!item) return;
    if (isTextLike) {
      $("#text-content").value = item.text;
      $("#font-family").value = item.font || "serif";
      $("#font-size").value = item.fontSize || 24;
      $("#font-size-value").textContent = `${item.fontSize || 24} px`;
      $$(".color-swatch").forEach(swatch => swatch.classList.toggle("selected", swatch.dataset.color === item.color));
      if (item.type === "sticker") {
        $("#sticker-width").value = Math.max(8, Math.min(80, item.width));
        $("#sticker-height").value = Math.max(8, Math.min(80, item.height));
        $("#sticker-width-value").textContent = `${Math.round(item.width)}%`;
        $("#sticker-height-value").textContent = `${Math.round(item.height)}%`;
      }
      $("#delete-element-button").textContent = item.type === "sticker" ? "⌫ Delete sticker" : "⌫ Delete text";
    } else {
      $("#selected-image-preview").src = photoSource(currentProject, item);
      const width = Math.round(item.width / 100 * pageElement.clientWidth);
      const height = Math.round(item.height / 100 * pageElement.clientHeight);
      $("#image-width").value = Math.max(80, Math.min(520, width));
      $("#image-height").value = Math.max(70, Math.min(440, height));
      $("#image-width-value").textContent = `${width} px`;
      $("#image-height-value").textContent = `${height} px`;
    }
  }

  function updateSelected(change) {
    const item = selectedItem();
    if (!item) return;
    Object.assign(item, change);
    currentProject.updatedAt = new Date().toISOString();
    renderEditor();
    scheduleSave();
  }

  function stickerFontSize(width, height) {
    const scale = Math.sqrt((width / 16) * (height / 14));
    return Math.max(12, Math.min(144, Math.round(26 * scale)));
  }

  function updateStickerDimensions(change) {
    const item = selectedItem();
    if (!item || item.type !== "sticker") return;
    Object.assign(item, change);
    item.fontSize = stickerFontSize(item.width, item.height);
    const element = $(`.page-item[data-item-id="${item.id}"]`);
    if (element) {
      element.style.width = `${item.width}%`;
      element.style.height = `${item.height}%`;
      element.querySelector(".page-item-sticker").style.fontSize = `${item.fontSize}px`;
    }
    currentProject.updatedAt = new Date().toISOString();
    scheduleSave();
  }

  function addText() {
    const item = { id: makeId(), type: "text", text: "A little note to remember…", x: 9, y: 13, width: 34, height: 18, font: "serif", fontSize: 24, color: "#303b2e", align: "left" };
    currentPage().items.push(item);
    selectedItemId = item.id;
    renderEditor();
    scheduleSave();
    $("#text-content").focus();
    $("#text-content").select();
  }

  function openStickerPicker() {
    const stickerOptions = ["✦", "✿", "✳", "❋", "♡", "☼", "✧", "❀", "★", "☆", "☁", "❀", "☺", "☕", "🌿", "🌼"];
    const shapeOptions = ["■", "●", "▲", "◆", "▣", "◐", "⬢", "✦"];
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal-card sticker-modal">
      <div class="photo-library-heading"><div><h2>Sticker tray.</h2><p>Pick a little mark for your page.</p></div><button type="button" class="modal-close" id="close-sticker-picker" aria-label="Close">×</button></div>
      <div class="sticker-section">
        <h3>Emojis</h3>
        <div class="sticker-grid">${stickerOptions.map(sticker => `<button type="button" class="sticker-item" data-sticker="${escapeHtml(sticker)}" aria-label="Add sticker ${escapeHtml(sticker)}">${sticker}</button>`).join("")}</div>
      </div>
      <div class="sticker-section">
        <h3>Shapes</h3>
        <div class="sticker-grid shape-grid">${shapeOptions.map(shape => `<button type="button" class="sticker-item shape-item" data-sticker="${escapeHtml(shape)}" aria-label="Add shape ${escapeHtml(shape)}">${shape}</button>`).join("")}</div>
      </div>
    </div></div>`;
    $("#close-sticker-picker").addEventListener("click", () => modalRoot.innerHTML = "");
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    $$(".sticker-item").forEach(button => button.addEventListener("click", () => {
      const text = button.dataset.sticker;
      const item = {
        id: makeId(),
        type: "sticker",
        text,
        x: 14 + Math.random() * 10,
        y: 12 + Math.random() * 12,
        width: 16,
        height: 14,
        font: "hand",
        fontSize: 26,
        color: ["#c57d63", "#7d8f6b", "#9a8bb4", "#d0a762", "#6f8ab3", "#b86e75"][Math.floor(Math.random() * 6)],
        align: "center"
      };
      currentPage().items.push(item);
      selectedItemId = item.id;
      modalRoot.innerHTML = "";
      renderEditor();
      scheduleSave();
    }));
  }

  function addSticker() {
    openStickerPicker();
  }

  function addImage(photoId) {
    const item = { id: makeId(), type: "image", photoId, x: 12 + Math.random() * 8, y: 14 + Math.random() * 8, width: 36, height: 48 };
    currentPage().items.push(item);
    selectedItemId = item.id;
    renderEditor();
    scheduleSave();
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error(`${file.name} is not a supported image.`));
        image.onload = () => {
          const maxDimension = 1800;
          const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(image.naturalWidth * scale);
          canvas.height = Math.round(image.naturalHeight * scale);
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", .84));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function openPhotoLibrary() {
    const photos = currentProject.photos || (currentProject.photos = []);
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal-card photo-library-modal">
      <div class="photo-library-heading"><div><h2>Your photo pile.</h2><p>Private to this scrapbook. Pick a photo to add it to this page.</p></div><button type="button" class="modal-close" id="close-photo-library" aria-label="Close">×</button></div>
      <div class="photo-library-grid">${photos.map(photo => `<button type="button" class="library-photo" data-photo-id="${escapeHtml(photo.id)}" aria-label="Add ${escapeHtml(photo.name || "photo")} to page"><img src="${photo.src}" alt=""><span>＋ Add to page</span></button>`).join("")}${photos.length ? "" : `<div class="photo-library-empty"><span>▧</span><p>Your photo pile is waiting.<br>Add a few favorites to get started.</p></div>`}</div>
      <div class="modal-actions"><button type="button" class="button button-light" id="upload-photo-button">＋&nbsp; Upload photos</button><button type="button" class="modal-cancel" id="done-photo-library">Done</button></div>
    </div></div>`;
    $("#close-photo-library").addEventListener("click", () => modalRoot.innerHTML = "");
    $("#done-photo-library").addEventListener("click", () => modalRoot.innerHTML = "");
    $("#upload-photo-button").addEventListener("click", () => photoInput.click());
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    $$(".library-photo").forEach(button => button.addEventListener("click", () => {
      addImage(button.dataset.photoId);
      modalRoot.innerHTML = "";
    }));
  }

  async function handlePhotoFiles(files) {
    if (!currentProject) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) { showToast(`${file.name} is not an image.`); continue; }
      try {
        const data = await readImageFile(file);
        currentProject.photos.push({ id: makeId(), name: file.name, src: data });
        currentProject.updatedAt = new Date().toISOString();
        scheduleSave();
      } catch (error) {
        console.error(error);
        showToast(error.message);
      }
    }
    photoInput.value = "";
    openPhotoLibrary();
  }

  function onItemPointerDown(event) {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    const item = currentPage().items.find(entry => entry.id === element.dataset.itemId);
    if (!item) return;
    event.stopPropagation();
    if (selectedItemId !== item.id) {
      $$(".page-item").forEach(candidate => candidate.classList.toggle("selected", candidate === element));
      selectedItemId = item.id;
      updateInspector();
    }
    const resizing = event.target.classList.contains("item-resize-handle");
    const startX = event.clientX, startY = event.clientY;
    const startLeft = item.x, startTop = item.y, startWidth = item.width, startHeight = item.height;
    const pageBounds = pageElement.getBoundingClientRect();
    const stickerText = element.querySelector(".page-item-sticker");
    element.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const dx = (moveEvent.clientX - startX) / pageBounds.width * 100;
      const dy = (moveEvent.clientY - startY) / pageBounds.height * 100;
      if (resizing) {
        item.width = Math.max(10, Math.min(90, startWidth + dx));
        item.height = Math.max(10, Math.min(90, startHeight + dy));
        if (stickerText) {
          item.fontSize = stickerFontSize(item.width, item.height);
          stickerText.style.fontSize = `${item.fontSize}px`;
        }
      } else {
        item.x = Math.max(0, Math.min(100 - item.width, startLeft + dx));
        item.y = Math.max(0, Math.min(100 - item.height, startTop + dy));
      }
      element.style.left = `${item.x}%`;
      element.style.top = `${item.y}%`;
      element.style.width = `${item.width}%`;
      element.style.height = `${item.height}%`;
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      currentProject.updatedAt = new Date().toISOString();
      scheduleSave();
      updateInspector();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }

  function addPage() {
    currentProject.pages.splice(currentPageIndex + 1, 0, { id: makeId(), items: [] });
    currentPageIndex++;
    selectedItemId = null;
    renderEditor();
    scheduleSave();
  }

  function deletePage() {
    if (currentProject.pages.length === 1) {
      if (!currentPage().items.length) { showToast("Your scrapbook needs at least one page."); return; }
      if (!confirm("Delete everything on this page? Your scrapbook will keep one blank page.")) return;
      currentPage().items = [];
    } else {
      if (!confirm("Delete this page and everything on it?")) return;
      currentProject.pages.splice(currentPageIndex, 1);
      currentPageIndex = Math.min(currentPageIndex, currentProject.pages.length - 1);
    }
    selectedItemId = null;
    renderEditor();
    scheduleSave();
  }

  function deleteSelected() {
    const item = selectedItem();
    if (!item) return;
    currentPage().items = currentPage().items.filter(entry => entry.id !== item.id);
    selectedItemId = null;
    renderEditor();
    scheduleSave();
  }

  function openCropModal() {
    const item = selectedItem();
    if (!item || item.type !== "image") return;
    const image = new Image();
    image.src = photoSource(currentProject, item);
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal-card crop-modal">
      <h2>Trim the moment.</h2><p>Adjust the crop edges to frame your photo just right.</p>
      <div class="crop-preview-box"><img id="crop-preview" alt="Crop preview"></div>
      <div class="crop-controls">
        <div class="control-row"><label for="crop-left">Left edge</label><input type="range" id="crop-left" min="0" max="45" value="0"></div>
        <div class="control-row"><label for="crop-top">Top edge</label><input type="range" id="crop-top" min="0" max="45" value="0"></div>
        <div class="control-row"><label for="crop-right">Right edge</label><input type="range" id="crop-right" min="0" max="45" value="0"></div>
        <div class="control-row"><label for="crop-bottom">Bottom edge</label><input type="range" id="crop-bottom" min="0" max="45" value="0"></div>
      </div>
      <div class="modal-actions"><button type="button" class="modal-cancel" id="cancel-crop">Cancel</button><button type="button" class="button button-dark" id="apply-crop">Apply crop</button></div>
    </div></div>`;
    $("#crop-preview").src = photoSource(currentProject, item);
    const updatePreview = () => {
      const left = Number($("#crop-left").value), top = Number($("#crop-top").value);
      const right = Number($("#crop-right").value), bottom = Number($("#crop-bottom").value);
      $("#crop-preview").style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`;
    };
    $$(".crop-controls input").forEach(input => input.addEventListener("input", updatePreview));
    $("#cancel-crop").addEventListener("click", () => modalRoot.innerHTML = "");
    $(".crop-modal").addEventListener("click", event => event.stopPropagation());
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    $("#apply-crop").addEventListener("click", () => {
      const left = Number($("#crop-left").value), top = Number($("#crop-top").value);
      const right = Number($("#crop-right").value), bottom = Number($("#crop-bottom").value);
      image.onload = () => {
        const sx = image.naturalWidth * left / 100;
        const sy = image.naturalHeight * top / 100;
        const sw = image.naturalWidth * (1 - (left + right) / 100);
        const sh = image.naturalHeight * (1 - (top + bottom) / 100);
        if (sw < 1 || sh < 1) { showToast("Keep some of the photo inside the crop."); return; }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(sw);
        canvas.height = Math.round(sh);
        canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const photo = { id: makeId(), name: "Cropped photo", src: canvas.toDataURL("image/jpeg", .9) };
        currentProject.photos.push(photo);
        updateSelected({ photoId: photo.id, src: undefined });
        modalRoot.innerHTML = "";
        showToast("Photo cropped.");
      };
      if (image.complete) image.onload();
    });
  }

  function updateZoom() {
    pageElement.style.transform = `scale(${zoom})`;
    $("#zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  }

  $$("#auth-view [data-auth-mode]").forEach(button => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  $("#auth-form").addEventListener("submit", event => {
    event.preventDefault();
    enterDemoGallery();
  });
  setAuthMode("signup");

  $("#new-project-button").addEventListener("click", openCreateModal);
  $("#add-photo-button").addEventListener("click", openPhotoLibrary);
  $("#empty-add-photo").addEventListener("click", openPhotoLibrary);
  $("#add-sticker-button").addEventListener("click", addSticker);
  $("#add-text-button").addEventListener("click", addText);
  $("#empty-add-text").addEventListener("click", addText);
  $("#page-color-picker").addEventListener("click", event => {
    const swatch = event.target.closest(".page-color-swatch");
    if (!swatch) return;
    const page = currentPage();
    if (!page) return;
    page.backgroundColor = swatch.dataset.pageColor;
    currentProject.updatedAt = new Date().toISOString();
    renderEditor();
    scheduleSave();
  });
  $("#add-page-button").addEventListener("click", addPage);
  $("#add-page-top").addEventListener("click", addPage);
  $("#add-page-tile").addEventListener("click", addPage);
  $("#delete-page-button").addEventListener("click", deletePage);
  $("#back-to-gallery").addEventListener("click", async () => {
    clearTimeout(saveTimer);
    currentProject.updatedAt = new Date().toISOString();
    try {
      await saveProject(currentProject);
      $("#save-status").innerHTML = "<i></i> Saved privately";
    } catch (error) {
      console.error("Could not save scrapbook data.", error);
      showToast("Could not save this scrapbook to the local database.");
    }
    currentProject = null;
    editorView.classList.add("hidden");
    galleryView.classList.remove("hidden");
    renderGallery();
  });
  $("#home-link").addEventListener("click", event => {
    event.preventDefault();
    if (!editorView.classList.contains("hidden")) $("#back-to-gallery").click();
  });
  photoInput.addEventListener("change", () => handlePhotoFiles([...photoInput.files]));
  $("#text-content").addEventListener("input", event => {
    const item = selectedItem();
    if (!item || (item.type !== "text" && item.type !== "sticker")) return;
    item.text = event.target.value;
    const textElement = $(`.page-item[data-item-id="${item.id}"] .page-item-text`);
    if (textElement) textElement.textContent = item.text;
    currentProject.updatedAt = new Date().toISOString();
    renderPageStrip();
    scheduleSave();
  });
  $("#font-family").addEventListener("change", event => updateSelected({ font: event.target.value }));
  $("#font-size").addEventListener("input", event => {
    $("#font-size-value").textContent = `${event.target.value} px`;
    updateSelected({ fontSize: Number(event.target.value) });
  });
  $("#sticker-width").addEventListener("input", event => {
    $("#sticker-width-value").textContent = `${event.target.value}%`;
    updateStickerDimensions({ width: Number(event.target.value) });
  });
  $("#sticker-height").addEventListener("input", event => {
    $("#sticker-height-value").textContent = `${event.target.value}%`;
    updateStickerDimensions({ height: Number(event.target.value) });
  });
  $("#text-colors").addEventListener("click", event => {
    const swatch = event.target.closest(".color-swatch");
    if (!swatch) return;
    $$(".color-swatch").forEach(button => button.classList.toggle("selected", button === swatch));
    updateSelected({ color: swatch.dataset.color });
  });
  $("#custom-text-color").addEventListener("input", event => updateSelected({ color: event.target.value }));
  $("#delete-element-button").addEventListener("click", deleteSelected);
  $("#delete-image-button").addEventListener("click", deleteSelected);
  $("#crop-image-button").addEventListener("click", openCropModal);
  $("#image-width").addEventListener("input", event => {
    $("#image-width-value").textContent = `${event.target.value} px`;
    updateSelected({ width: Number(event.target.value) / pageElement.clientWidth * 100 });
  });
  $("#image-height").addEventListener("input", event => {
    $("#image-height-value").textContent = `${event.target.value} px`;
    updateSelected({ height: Number(event.target.value) / pageElement.clientHeight * 100 });
  });
  $("#zoom-out-button").addEventListener("click", () => { zoom = Math.max(.65, zoom - .1); updateZoom(); });
  $("#zoom-in-button").addEventListener("click", () => { zoom = Math.min(1.3, zoom + .1); updateZoom(); });
  pageElement.addEventListener("click", event => {
    if (event.target === pageElement || event.target.classList.contains("paper-grain") || event.target === pageItems) {
      selectedItemId = null;
      renderEditor();
    }
  });
  document.addEventListener("keydown", event => {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedItem() && !["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) deleteSelected();
    if (event.key === "Escape" && modalRoot.firstChild) modalRoot.innerHTML = "";
  });
  $("#new-project-button").disabled = true;
  loadProjects().then(loadedProjects => {
    projects = loadedProjects.sort((first, second) => new Date(second.updatedAt || second.createdAt || 0) - new Date(first.updatedAt || first.createdAt || 0));
    renderGallery();
    $("#new-project-button").disabled = false;
  }).catch(error => {
    console.error("Could not load scrapbooks from the local database.", error);
    $("#new-project-button").disabled = false;
    showToast("Could not load saved projects from the local database.");
  });
})();
