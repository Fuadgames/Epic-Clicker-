(() => {
  "use strict";
  const { PRODUCTS, createGame } = window.EpicEngine;
  const dictionaries = window.EpicI18n;
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = "epic-clicker-v1";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* Start normally if storage is unavailable. */ }
  let game = createGame(saved);
  let language = saved?.language === "en" ? "en" : "ru";
  let soundEnabled = saved?.sound === true;
  let storageAvailable = true;
  let dirty = true;
  let scoreAnimation, toastTimer, comboTimer, audio;
  let burstTimes = [];
  let previousTime = performance.now();
  let lastInteractive = !document.hidden;
  const shop = $("shop"), settings = $("settings"), score = $("score"), effects = $("effects");
  const cards = new Map();
  const autoIds = ["autoSlow", "autoFast", "ultra"];
  const autoBars = ["auto-slow-progress", "auto-fast-progress", "auto-ultra-progress"];
  const controls = "button, a, input, select, textarea, label, summary, [role='button'], [data-ui], [contenteditable='true']";
  const format = number => number.toLocaleString(language === "en" ? "en-US" : "ru-RU", { maximumFractionDigits: 2 });
  // Keep even the last quarter-click visible after migrating very large old saves.
  const formatUnits = units => {
    const fraction = ["", "25", "5", "75"][Number(units % 4n)];
    return format(units / 4n) + (fraction ? (language === "en" ? "." : ",") + fraction : "");
  };
  const signed = number => (number < 0 ? "−" : "+") + format(Math.abs(number));
  const interpolate = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
  const t = (key, values) => interpolate(dictionaries[language].ui[key] ?? key, values);
  const productText = id => dictionaries[language].products[id];
  const anyModal = () => shop.open || settings.open;
  let recentEventResult = null;
  let recentEventUntil = 0;

  for (const product of PRODUCTS) {
    const card = document.createElement("article");
    card.className = "product" + (["power", "attack", "events"].includes(product.id) ? " epic" : "");
    card.dataset.product = product.id;
    card.innerHTML = '<div class="product-icon" aria-hidden="true"></div><div><div class="product-type"></div><h3></h3><p class="product-description"></p><p class="lock-note" hidden></p></div><button class="buy-btn" data-buy="' + product.id + '"></button>';
    card.querySelector(".product-icon").textContent = product.icon;
    const button = card.querySelector("button");
    button.addEventListener("click", () => {
      updateTimers();
      if (!game.buy(product.id)) return;
      dirty = true;
      renderState();
      renderUpgrades();
      save();
      notify(t("purchased", { title: productText(product.id).title }));
      playTone(550, 0.08);
      setTimeout(() => playTone(830, 0.1), 65);
      if (!reducedMotion.matches) card.animate([{ transform: "scale(1)" }, { transform: "scale(1.025)", background: "#d4ff6312" }, { transform: "scale(1)" }], { duration: 250 });
    });
    cards.set(product.id, { card, button, lockNote: card.querySelector(".lock-note") });
    $("products").append(card);
  }

  function renderLanguage() {
    document.documentElement.lang = language;
    document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    for (const product of PRODUCTS) {
      const { card } = cards.get(product.id), copy = productText(product.id);
      card.querySelector(".product-type").textContent = copy.type;
      card.querySelector("h3").textContent = copy.title;
      card.querySelector(".product-description").textContent = copy.desc;
    }
    document.querySelectorAll("[data-language]").forEach(button => {
      const selected = button.dataset.language === language;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-selected", selected);
    });
    $("combo-title").textContent = t("go");
    $("shop-notice").textContent = "";
    $("toast").classList.remove("show");
    renderSound();
    renderState();
    renderUpgrades();
    renderSaveStatus();
  }

  function renderState() {
    const value = formatUnits(game.balanceUnits);
    score.textContent = value;
    score.classList.toggle("medium", value.length > 6 && value.length <= 10);
    score.classList.toggle("small", value.length > 10);
    score.classList.toggle("massive", value.length > 24);
    score.setAttribute("aria-label", t("balance", { value }));
    $("shop-balance").textContent = value;
    $("lifetime").replaceChildren(document.createTextNode(formatUnits(game.earnedUnits) + " "), Object.assign(document.createElement("small"), { textContent: t("clicks") }));
    $("click-gain").textContent = signed(game.perClick());
    const autoRate = PRODUCTS.filter(p => p.interval && game.has(p.id)).reduce((sum, p) => sum + p.amount * 1000 / p.interval, 0);
    $("auto-gain").textContent = format(autoRate);
    $("auto-count").textContent = autoIds.filter(id => game.has(id)).length;
    const bonus = (game.has("power") ? 5 : 0) + (game.has("extra") ? 1 : 0);
    $("click-formula").textContent = (game.clickBoost() > 0
      ? t("boostFormula", { amount: format(game.clickBoost()) }) : t("baseFormula"))
      + (bonus ? t("flatBonus", { amount: format(bonus) }) : "");

    let affordable = 0;
    const next = PRODUCTS.find(p => !game.has(p.id));
    for (const product of PRODUCTS) {
      const { card, button, lockNote } = cards.get(product.id);
      const owned = game.has(product.id), unlocked = game.isUnlocked(product.id);
      const available = game.balance >= product.cost;
      const copy = productText(product.id);
      card.classList.toggle("owned", owned);
      card.classList.toggle("locked", !unlocked);
      lockNote.hidden = unlocked;
      lockNote.textContent = !unlocked && next ? t("unlockAfter", { title: productText(next.id).title }) : "";
      button.disabled = owned || !unlocked || !available;
      if (owned) {
        button.textContent = t("owned");
        button.setAttribute("aria-label", copy.title + ": " + t("owned"));
      } else if (!unlocked) {
        button.replaceChildren(document.createTextNode("🔒 " + t("locked")), Object.assign(document.createElement("small"), { textContent: format(product.cost) + " " + t("clicks") }));
        button.setAttribute("aria-label", copy.title + ": " + t("locked") + ". " + lockNote.textContent);
      } else {
        button.replaceChildren(document.createTextNode(format(product.cost)), Object.assign(document.createElement("small"), { textContent: t("clicks") }));
        button.setAttribute("aria-label", t("buy", { title: copy.title, cost: format(product.cost) }) + (available ? "" : ". " + t("notEnough")));
        if (available) affordable++;
      }
    }
    $("shop-count").textContent = affordable ? String(affordable) : "";
    if (next) {
      $("next-name").textContent = productText(next.id).title;
      $("next-price").textContent = value + " / " + format(next.cost);
      $("next-progress").style.width = Math.min(100, game.balance / next.cost * 100) + "%";
      $("next-description").textContent = game.balance >= next.cost ? t("ready") : t("remaining", { amount: format(next.cost - game.balance) });
    } else {
      $("next-name").textContent = t("allUpgraded");
      $("next-price").textContent = PRODUCTS.length + " / " + PRODUCTS.length;
      $("next-progress").style.width = "100%";
      $("next-description").textContent = t("allUpgradedHint");
    }
    renderTimedState();
  }

  function renderUpgrades() {
    const container = $("active-upgrades");
    container.replaceChildren();
    for (const product of PRODUCTS) {
      if (!game.has(product.id)) continue;
      const tag = document.createElement("span");
      tag.className = "upgrade-tag";
      tag.textContent = productText(product.id).badge;
      if (product.id === "attack") tag.id = "attack-badge";
      container.append(tag);
    }
    if (!container.childElementCount) container.append(Object.assign(document.createElement("span"), { className: "empty-upgrades", textContent: t("empty") }));
    renderTimedState();
  }

  function renderTimedState() {
    autoIds.forEach((id, index) => { $(autoBars[index]).style.transform = "scaleX(" + game.autoProgress(id) + ")"; });
    const attack = game.attack;
    document.body.classList.toggle("attack-active", attack.active && !anyModal() && !document.hidden);
    $("attack-overlay").hidden = !attack.active || anyModal() || document.hidden;
    $("attack-status").hidden = !attack.active || anyModal() || document.hidden;
    $("attack-time").textContent = t("seconds", { value: format(Math.ceil(attack.remainingMs / 100) / 10) });
    const badge = $("attack-badge");
    if (badge) badge.textContent = t("attackBadge", { count: attack.clicksUntilRoll });
    const banner = $("event-banner");
    banner.hidden = !game.has("events");
    if (banner.hidden) return;
    const event = game.event;
    banner.dataset.state = event?.outcome || "active";
    if (event) {
      const copy = dictionaries[language].events[event.id];
      $("event-title").textContent = copy.title;
      $("event-timer").textContent = anyModal() || document.hidden ? t("paused") : t("seconds", { value: Math.ceil(event.remainingMs / 1000) });
      $("event-description").textContent = interpolate(copy.desc, {
        amount: signed(event.amount),
        progress: t("questProgress", { done: event.progress, target: event.target })
      });
      $("event-progress").hidden = false;
      $("event-progress-fill").style.width = (event.target ? event.progress / event.target : 1 - event.remainingMs / event.durationMs) * 100 + "%";
    } else if (recentEventResult && performance.now() < recentEventUntil) {
      const result = recentEventResult;
      banner.dataset.state = result.outcome;
      $("event-title").textContent = dictionaries[language].events[result.eventId].title;
      $("event-timer").textContent = signed(result.amount);
      $("event-description").textContent = t(result.outcome === "failure" ? "eventFailure" : result.outcome === "success" ? "eventSuccess" : "eventFinished");
      $("event-progress").hidden = true;
    } else {
      $("event-title").textContent = t("nextEvent");
      $("event-timer").textContent = anyModal() || document.hidden ? t("paused") : t("seconds", { value: Math.ceil(game.eventCountdown / 1000) });
      $("event-description").textContent = t("nextEventHint");
      $("event-progress").hidden = true;
    }
  }

  function bump(autoClick = false) {
    if (reducedMotion.matches) return;
    scoreAnimation?.cancel();
    const angle = autoClick ? 1.5 : Math.random() > 0.5 ? 3 : -3;
    scoreAnimation = $("score-wrap").animate([
      { transform: "scale(1) rotate(0deg)" },
      { transform: "scale(" + (autoClick ? 1.035 : 1.1) + ") rotate(" + angle + "deg)", offset: 0.35 },
      { transform: "scale(1) rotate(0deg)" }
    ], { duration: 140, easing: "ease-out" });
  }

  function effect(className, x, y, text) {
    while (effects.childElementCount >= 200) effects.firstElementChild.remove();
    const el = document.createElement("span");
    el.className = className;
    el.style.left = x + "px";
    el.style.top = y + "px";
    if (text) el.textContent = text;
    effects.append(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 1200);
    return el;
  }

  function floatAtScore(amount, label = "", red = false) {
    if (reducedMotion.matches || document.hidden || anyModal() || !amount) return;
    const rect = score.getBoundingClientRect();
    const el = effect("float-number bonus", Math.min(innerWidth - 45, rect.right + 10), Math.max(75, rect.top + 20), signed(amount) + (label ? " " + label : ""));
    if (red) el.style.color = "#ffb5aa";
  }

  function clickEffects(x, y, baseAmount, flatBonus) {
    if (reducedMotion.matches) return;
    effect("ripple", x, y);
    const labelX = Math.max(35, Math.min(innerWidth - 35, x));
    const labelY = Math.max(84, y - 16);
    effect("float-number", labelX, labelY, signed(baseAmount));
    for (let i = 0; i < 6; i++) {
      const angle = i / 6 * Math.PI * 2 + Math.random() * 0.4;
      const el = effect("spark", x, y);
      el.style.setProperty("--dx", Math.cos(angle) * (30 + Math.random() * 35) + "px");
      el.style.setProperty("--dy", Math.sin(angle) * (30 + Math.random() * 35) + "px");
      if (i % 2) el.style.background = "var(--purple)";
    }
    for (let i = 0; i < Math.min(6, flatBonus); i++) {
      const offset = (i - (flatBonus - 1) / 2) * 18;
      const el = effect("float-number bonus", Math.max(12, Math.min(innerWidth - 12, x + offset)), labelY + 20 + Math.abs(offset) / 3, "+1");
      el.style.setProperty("--drift", offset * 0.65 + "px");
      el.style.animationDelay = i * 18 + "ms";
    }
  }

  function handleNotices() {
    const notices = game.drainNotices();
    let attackParticles = 0;
    for (const notice of notices) {
      if (notice.kind === "attack-start") {
        notify(t("attackStarted"));
        playTone(120, 0.2);
      } else if (notice.kind === "attack-tick") {
        attackParticles += notice.amount;
      } else if (notice.kind === "attack-end") {
        playTone(440, 0.08);
      } else if (notice.kind === "event-income") {
        floatAtScore(notice.amount);
      } else if (notice.kind === "event-start") {
        recentEventResult = null;
        notify(dictionaries[language].events[notice.eventId].title);
        floatAtScore(notice.amount);
        playTone(690, 0.12);
      } else if (notice.kind === "event-end") {
        recentEventResult = notice;
        recentEventUntil = performance.now() + 4500;
        notify(t("eventResult", {
          title: dictionaries[language].events[notice.eventId].title,
          result: t(notice.outcome === "failure" ? "eventFailure" : notice.outcome === "success" ? "eventSuccess" : "eventFinished"),
          amount: signed(notice.amount)
        }));
        // Timed quests pay at completion; rain and instant events paid earlier.
        if (["marathon", "overload"].includes(notice.eventId)) floatAtScore(notice.amount);
      }
    }
    if (attackParticles && !reducedMotion.matches && !document.hidden && !anyModal()) {
      const rect = score.getBoundingClientRect();
      for (let i = 0; i < Math.min(40, attackParticles); i++) {
        const el = effect("float-number bonus", rect.x + rect.width / 2 + (Math.random() - 0.5) * 180, Math.max(90, rect.y + rect.height / 2 + (Math.random() - 0.5) * 100), "+1");
        el.style.color = "#ff998e";
        el.style.setProperty("--drift", (Math.random() - 0.5) * 90 + "px");
      }
      bump(true);
      playTone(140 + Math.random() * 70, 0.035);
    }
    return notices.length;
  }

  function manualClick(x, y) {
    updateTimers();
    const baseAmount = game.base(), manualAmount = game.perClick();
    game.click();
    dirty = true;
    renderState();
    bump();
    clickEffects(x, y, baseAmount, Math.max(0, manualAmount - baseAmount));
    playTone(330 + Math.random() * 90, 0.035);
    handleNotices();
    renderTimedState();
    const now = performance.now();
    burstTimes = burstTimes.filter(time => now - time < 1100);
    burstTimes.push(now);
    if (burstTimes.length >= 4) {
      $("combo").classList.add("active");
      $("combo-title").textContent = t(burstTimes.length >= 9 ? "epicCombo" : "go");
      clearTimeout(comboTimer);
      comboTimer = setTimeout(() => $("combo").classList.remove("active"), 850);
    }
  }

  document.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || anyModal()) return;
    if (!(event.target instanceof Element) || event.target.closest(controls)) return;
    manualClick(event.clientX, event.clientY);
  });
  document.addEventListener("keydown", event => {
    if (event.code !== "Space" || event.repeat || anyModal() || !(event.target instanceof Element) || event.target.closest(controls)) return;
    event.preventDefault();
    const rect = score.getBoundingClientRect();
    manualClick(rect.x + rect.width / 2, rect.y + rect.height / 2);
  });

  function openModal(modal) {
    if (anyModal()) return;
    updateTimers();
    renderState();
    modal.classList.remove("closing");
    modal.showModal();
    lastInteractive = false;
    renderTimedState();
    playTone(460, 0.06);
  }
  function closeModal(modal) {
    if (!modal.open || modal.classList.contains("closing")) return;
    const finish = () => {
      updateTimers();
      modal.close();
      modal.classList.remove("closing");
      if (modal === settings) setResetConfirmation(false);
      lastInteractive = !document.hidden;
      renderTimedState();
    };
    if (reducedMotion.matches) finish();
    else {
      modal.classList.add("closing");
      setTimeout(finish, 130);
    }
  }
  $("shop-btn").addEventListener("click", () => openModal(shop));
  $("next-upgrade").addEventListener("click", () => openModal(shop));
  $("settings-btn").addEventListener("click", () => openModal(settings));
  $("close-shop").addEventListener("click", () => closeModal(shop));
  $("close-settings").addEventListener("click", () => closeModal(settings));
  for (const modal of [shop, settings]) {
    modal.addEventListener("cancel", event => { event.preventDefault(); closeModal(modal); });
    modal.addEventListener("click", event => {
      if (event.target !== modal) return;
      const rect = modal.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(modal);
    });
  }

  document.querySelectorAll("[data-language]").forEach(button => button.addEventListener("click", () => {
    language = button.dataset.language === "en" ? "en" : "ru";
    dirty = true;
    renderLanguage();
    save();
  }));
  $("sound-toggle").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    dirty = true;
    renderSound();
    playTone(640, 0.06);
    save();
  });

  function setResetConfirmation(visible) {
    $("reset-confirmation").hidden = !visible;
    $("reset-data").hidden = visible;
    if (visible) $("cancel-reset").focus();
  }
  $("reset-data").addEventListener("click", () => setResetConfirmation(true));
  $("cancel-reset").addEventListener("click", () => {
    setResetConfirmation(false);
    $("reset-data").focus();
  });
  $("confirm-reset").addEventListener("click", () => {
    const fresh = createGame();
    // Replace only this game's save; never clear other data on the origin.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...fresh.snapshot(), language: "ru", sound: false }));
    } catch {
      $("reset-error").textContent = t("resetFailed");
      return;
    }
    game = fresh;
    saved = null;
    language = "ru";
    soundEnabled = false;
    storageAvailable = true;
    dirty = false;
    previousTime = performance.now();
    lastInteractive = false;
    burstTimes = [];
    recentEventResult = null;
    recentEventUntil = 0;
    clearTimeout(comboTimer);
    clearTimeout(toastTimer);
    scoreAnimation?.cancel();
    effects.replaceChildren();
    $("combo").classList.remove("active");
    $("reset-error").textContent = "";
    setResetConfirmation(false);
    renderLanguage();
    $("reset-data").focus();
    notify(t("resetDone"));
  });

  function notify(message) {
    clearTimeout(toastTimer);
    if (shop.open) {
      $("shop-notice").textContent = message;
      toastTimer = setTimeout(() => { $("shop-notice").textContent = ""; }, 2300);
    } else {
      $("toast").textContent = message;
      $("toast").classList.add("show");
      toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2300);
    }
  }
  function playTone(frequency, duration) {
    if (!soundEnabled || document.hidden) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      if (!audio) audio = new Audio();
      if (audio.state === "suspended") void audio.resume().catch(() => {});
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 0.7), audio.currentTime + duration);
      gain.gain.setValueAtTime(0.025, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
      osc.connect(gain); gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    } catch { /* Audio is optional. */ }
  }
  function renderSound() {
    $("sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
    $("sound-toggle").textContent = t(soundEnabled ? "soundOn" : "soundOff");
    $("sound-toggle").setAttribute("aria-label", t("sound") + ": " + t(soundEnabled ? "soundOn" : "soundOff"));
  }
  function renderSaveStatus() {
    $("save-status").replaceChildren(document.createElement("i"), document.createTextNode(t(storageAvailable ? "saved" : "saveUnavailable")));
    if (!storageAvailable) $("save-status").firstChild.style.background = "#bc8e64";
  }
  function save() {
    if (!dirty) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...game.snapshot(), sound: soundEnabled, language }));
      dirty = false;
      storageAvailable = true;
    } catch { storageAvailable = false; }
    renderSaveStatus();
  }

  function updateTimers() {
    const now = performance.now();
    const delta = now - previousTime;
    previousTime = now;
    const income = game.advance(delta, { eventsActive: lastInteractive });
    lastInteractive = !document.hidden && !anyModal();
    const noticeCount = handleNotices();
    if (income || noticeCount) {
      dirty = true;
      renderState();
      if (income && !noticeCount && !anyModal() && !document.hidden) {
        bump(true);
        floatAtScore(income, t("auto"));
      }
    }
    renderTimedState();
  }

  setInterval(updateTimers, 50);
  setInterval(() => { dirty = true; save(); }, 1500);
  window.addEventListener("pagehide", () => { updateTimers(); dirty = true; save(); });
  document.addEventListener("visibilitychange", () => {
    updateTimers();
    lastInteractive = !document.hidden && !anyModal();
    dirty = true;
    save();
  });
  renderLanguage();
  save();
})();

