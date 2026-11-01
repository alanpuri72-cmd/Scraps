(() => {
  const DATABASE_NAME = "Scraps";
  const DATABASE_VERSION = 1;
  const PROJECTS_STORE = "projects";
  const LEGACY_STORAGE_KEY = "Scraps-projects-v1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const galleryView = $("#gallery-view");
  const editorView = $("#editor-view");
  const projectsGrid = $("#projects-grid");
  const emptyState = $("#empty-state");
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
    $("#project-count").textContent = projects.length;
    emptyState.classList.toggle("hidden", projects.length > 0);
    projectsGrid.innerHTML = projects.map(project => {
      const firstImage = project.pages.flatMap(page => page.items || []).find(item => item.type === "image");
      const firstText = project.pages.flatMap(page => page.items || []).find(item => item.type === "text");
      const title = escapeHtml(project.title || "Untitled scrapbook");
      const cover = firstImage
        ? `<img src="${photoSource(project, firstImage)}" alt="">`
        : `<div class="cover-placeholder"><span>✿</span></div>`;
      const caption = firstText ? escapeHtml(firstText.text).slice(0, 40) : "little moments";
      return `<article class="project-card" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="button" aria-label="Open ${title}">
        <div class="project-cover"><span class="cover-tape"></span><div class="project-cover-inner">${cover}<span class="cover-caption">${caption}</span></div></div>
        <div class="project-meta"><div><h3>${title}</h3><p>${project.pages.length} ${project.pages.length === 1 ? "page" : "pages"} · edited ${relativeDate(project.updatedAt)}</p></div><span class="project-arrow">↗</span></div>
      </article>`;
    }).join("");
    $$(".project-card").forEach(card => {
      card.addEventListener("click", () => openProject(card.dataset.projectId));
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openProject(card.dataset.projectId); }
      });
    });
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
      <h2>A new little story.</h2><p>Give your scrapbook a name. You can always change it later.</p>
      <label for="project-name">SCRAPBOOK NAME</label><input id="project-name" name="title" type="text" maxlength="60" placeholder="A summer to remember" autocomplete="off" required>
      <div class="modal-actions"><button type="button" class="modal-cancel" id="cancel-create">Maybe later</button><button type="submit" class="button button-dark">Create scrapbook <span>↗</span></button></div>
    </form></div>`;
    const form = $("#create-project-form");
    $("#project-name").focus();
    $("#cancel-create").addEventListener("click", () => modalRoot.innerHTML = "");
    $(".modal-backdrop").addEventListener("click", event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ""; });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = $("#project-name").value.trim();
      if (!title) return;
      const project = { id: makeId(), title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pages: [{ id: makeId(), items: [] }] };
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
        submit.textContent = "Create scrapbook";
        console.error("Could not create scrapbook.", error);
        showToast("Could not create a scrapbook in the local database.");
      });
    });
  }

  function openProject(projectId) {
    currentProject = projects.find(project => project.id === projectId);
    if (!currentProject) return;
    if (!currentProject.pages.length) currentProject.pages.push({ id: makeId(), items: [] });
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

  function currentPage() { return currentProject.pages[currentPageIndex]; }

  function photoSource(project, item) {
    if (item.photoId) return project.photos?.find(photo => photo.id === item.photoId)?.src || "";
    return item.src || "";
  }

  function renderEditor() {
    if (!currentProject) return;
    pageItems.innerHTML = "";
    const items = currentPage().items || (currentPage().items = []);
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
        text.className = "page-item-text";
        text.textContent = item.text;
        text.style.fontFamily = fontStack(item.font);
        text.style.fontSize = `${item.fontSize}px`;
        text.style.color = item.color;
        text.style.textAlign = item.align || "left";
        element.append(text);
      }
      const handle = document.createElement("span");
      handle.className = "item-resize-handle";
      element.append(handle);
      element.addEventListener("pointerdown", onItemPointerDown);
      element.addEventListener("click", event => { event.stopPropagation(); selectItem(item.id); });
      pageItems.append(element);
    });
    $("#page-empty-hint").classList.toggle("hidden", items.length > 0);
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
    return currentPage()?.items.find(item => item.id === selectedItemId);
  }

  function updateInspector() {
    const item = selectedItem();
    $("#inspector-empty").classList.toggle("hidden", Boolean(item));
    $("#text-controls").classList.toggle("hidden", !item || item.type !== "text");
    $("#image-controls").classList.toggle("hidden", !item || item.type !== "image");
    $("#inspector-title").textContent = item ? (item.type === "text" ? "A little note" : "Your photo") : "A little note";
    $("#inspector-description").textContent = item ? (item.type === "text" ? "Say it just the way you like." : "Adjust, crop, or move your photo.") : "Pick something on your page to make it your own.";
    if (!item) return;
    if (item.type === "text") {
      $("#text-content").value = item.text;
      $("#font-family").value = item.font || "serif";
      $("#font-size").value = item.fontSize || 24;
      $("#font-size-value").textContent = `${item.fontSize || 24} px`;
      $$(".color-swatch").forEach(swatch => swatch.classList.toggle("selected", swatch.dataset.color === item.color));
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

  function addText() {
    const item = { id: makeId(), type: "text", text: "A little note to remember…", x: 9, y: 13, width: 34, height: 18, font: "serif", fontSize: 24, color: "#303b2e", align: "left" };
    currentPage().items.push(item);
    selectedItemId = item.id;
    renderEditor();
    scheduleSave();
    $("#text-content").focus();
    $("#text-content").select();
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
    element.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const dx = (moveEvent.clientX - startX) / pageBounds.width * 100;
      const dy = (moveEvent.clientY - startY) / pageBounds.height * 100;
      if (resizing) {
        item.width = Math.max(10, Math.min(90, startWidth + dx));
        item.height = Math.max(10, Math.min(90, startHeight + dy));
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

  $("#new-project-button").addEventListener("click", openCreateModal);
  $("#empty-create-button").addEventListener("click", openCreateModal);
  $("#add-photo-button").addEventListener("click", openPhotoLibrary);
  $("#empty-add-photo").addEventListener("click", openPhotoLibrary);
  $("#add-text-button").addEventListener("click", addText);
  $("#empty-add-text").addEventListener("click", addText);
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
    if (!item || item.type !== "text") return;
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
  $("#empty-create-button").disabled = true;
  loadProjects().then(loadedProjects => {
    projects = loadedProjects;
    renderGallery();
    $("#new-project-button").disabled = false;
    $("#empty-create-button").disabled = false;
  }).catch(error => {
    console.error("Could not load scrapbooks from the local database.", error);
    $("#new-project-button").disabled = false;
    $("#empty-create-button").disabled = false;
    showToast("Could not open the local scrapbook database.");
  });
})();
