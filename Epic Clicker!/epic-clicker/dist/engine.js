(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EpicEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRODUCTS = Object.freeze([
    { id: "half", title: "0,5× нажатие", cost: 10, type: "УСИЛЕНИЕ КЛИКА", icon: "◈", badge: "+0,5 за клик",
      desc: "Добавляет 0,5 к доходу одного нажатия: базовый 1 + 0,5 = 1,5 клика." },
    { id: "autoSlow", title: "Авто-клик", cost: 100, type: "АВТОМАТИЗАЦИЯ", icon: "◷", badge: "+1 / 5 сек",
      desc: "Начисляет +1 клик каждые 5 секунд.", interval: 5000, amount: 1 },
    { id: "power", title: "КЛИК СТЕПЕНИ!!!", cost: 500, type: "ЭПИЧЕСКАЯ СИЛА", icon: "ϟ", badge: "+5 за клик",
      desc: "Ещё +5 кликов за нажатие и пять маленьких +1 возле курсора." },
    { id: "multiplier", title: "1,5× нажатие", cost: 1000, type: "УСИЛЕНИЕ КЛИКА", icon: "✧", badge: "+1,5 за клик",
      desc: "Добавляет ещё 1,5 к каждому нажатию. Складывается с другими усилениями." },
    { id: "autoFast", title: "Авто-кликер PRO", cost: 1500, type: "АВТОМАТИЗАЦИЯ", icon: "»", badge: "+5 / 2 сек",
      desc: "Начисляет +5 каждые 2 секунды. Работает вместе с другими автокликерами.", interval: 2000, amount: 5 },
    { id: "extra", title: "ЭКСТРА КЛИК +1", cost: 2000, type: "БОНУС К КЛИКУ", icon: "+", badge: "+1 за клик",
      desc: "Прибавляет ещё один клик к каждому ручному нажатию." },
    { id: "attack", title: "ЭПИЧЕСКАЯ АТАКА", cost: 3000, type: "ЭПИЧЕСКАЯ СИЛА", icon: "✹", badge: "Атака: 50% / 10 кликов",
      desc: "Каждое десятое нажатие: 50% шанс атаки на 3 секунды. До +600 кликов!" },
    { id: "double", title: "2× нажатие", cost: 4000, type: "УСИЛЕНИЕ КЛИКА", icon: "×", badge: "+2 за клик",
      desc: "Добавляет ещё 2 клика к каждому нажатию. Складывается с другими усилениями." },
    { id: "events", title: "События", cost: 5000, type: "СЛУЧАЙНЫЕ СОБЫТИЯ", icon: "✦", badge: "События включены",
      desc: "Каждые 35–55 секунд: удвоения, золотой дождь, задания, удача и неудача." },
    { id: "ultra", title: "УЛЬТРА АВТОКЛИК", cost: 6000, type: "АВТОМАТИЗАЦИЯ", icon: "»", badge: "+100 / 3 сек",
      desc: "Начисляет +100 кликов каждые 3 секунды.", interval: 3000, amount: 100 }
  ].map(Object.freeze));

  const AUTO_PRODUCTS = PRODUCTS.filter(product => product.interval);
  const EVENTS = Object.freeze({
    doubleDay: Object.freeze({ durationMs: 8000, target: 0 }),
    goldenRain: Object.freeze({ durationMs: 8000, target: 0 }),
    marathon: Object.freeze({ durationMs: 15000, target: 25 }),
    overload: Object.freeze({ durationMs: 10000, target: 10 }),
    luckyPulse: Object.freeze({ durationMs: 6000, target: 0 })
  });
  const EVENT_IDS = Object.keys(EVENTS);
  // BigInt quarter-clicks keep even old, exponentially grown saves exact.
  // A fixed Number cap used to make every source of income stop at +0.
  const EPSILON = 0.000001;
  const MAX_ADVANCE_MS = 86400000;

  function createGame(saved, options = {}) {
    const data = saved && typeof saved === "object" ? saved : {};
    const randomSource = typeof options.random === "function" ? options.random : Math.random;
    function random() {
      const value = randomSource();
      return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0.5;
    }
    const validNumber = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
    function toUnits(value) {
      if (!Number.isFinite(value) || value < 0) return 0n;
      // Multiplying a huge finite legacy Number by four can overflow first.
      const whole = Math.trunc(value);
      return BigInt(whole) * 4n + BigInt(Math.round((value - whole) * 4));
    }
    function readUnits(exact, legacy) {
      return typeof exact === "string" && /^\d+$/.test(exact) ? BigInt(exact) : toUnits(legacy);
    }
    function unitsToNumber(units) {
      const negative = units < 0n;
      const magnitude = negative ? -units : units;
      const whole = Number(magnitude / 4n);
      const amount = Number.isFinite(whole)
        ? Math.min(Number.MAX_VALUE, whole + Number(magnitude % 4n) / 4) : Number.MAX_VALUE;
      return negative ? -amount : amount;
    }
    let balanceUnits = readUnits(data.balanceUnits, data.balance);
    let earnedUnits = readUnits(data.earnedUnits, data.earned ?? data.lifetimeEarned);
    if (earnedUnits < balanceUnits) earnedUnits = balanceUnits;
    let manualClicks = Number.isSafeInteger(data.manualClicks) && data.manualClicks >= 0 ? data.manualClicks : 0;
    const owned = new Set(Array.isArray(data.owned)
      ? data.owned.filter(id => PRODUCTS.some(product => product.id === id)) : []);
    const timers = { autoSlow: 0, autoFast: 0, ultra: 0 };
    const notices = [];
    for (const product of AUTO_PRODUCTS) {
      const elapsed = data.autoProgress && data.autoProgress[product.id];
      if (owned.has(product.id) && validNumber(elapsed, 0, product.interval - EPSILON)) timers[product.id] = elapsed;
    }

    const savedAttack = data.attack && typeof data.attack === "object" ? data.attack : {};
    const attackState = {
      elapsedMs: owned.has("attack") && validNumber(savedAttack.elapsedMs, 0, 3000) ? savedAttack.elapsedMs : 0,
      remainingMs: 0,
      cycleClicks: owned.has("attack") && Number.isInteger(savedAttack.cycleClicks)
        ? Math.max(0, Math.min(9, savedAttack.cycleClicks)) : 0
    };
    if (owned.has("attack") && savedAttack.active === true && attackState.elapsedMs < 3000) {
      attackState.remainingMs = 3000 - attackState.elapsedMs;
    } else attackState.elapsedMs = 0;
    let attackPaidTicks = Math.floor((attackState.elapsedMs + EPSILON) / 100);

    const nextDelay = () => 35000 + Math.floor(random() * 20001);
    let eventCountdown = owned.has("events")
      ? validNumber(data.eventCountdown, 0, 55000) ? data.eventCountdown : nextDelay() : 0;
    let eventState = null;
    const savedEvent = data.event;
    if (owned.has("events") && savedEvent && Object.prototype.hasOwnProperty.call(EVENTS, savedEvent.id)) {
      const definition = EVENTS[savedEvent.id];
      if (validNumber(savedEvent.remainingMs, EPSILON, definition.durationMs)) {
        eventState = {
          id: savedEvent.id,
          remainingMs: savedEvent.remainingMs,
          durationMs: definition.durationMs,
          progress: Number.isInteger(savedEvent.progress)
            ? Math.max(0, Math.min(definition.target, savedEvent.progress)) : 0,
          target: definition.target,
          outcome: ["success", "failure", "neutral"].includes(savedEvent.outcome) ? savedEvent.outcome : null,
          amount: Number.isFinite(savedEvent.amount) ? savedEvent.amount : 0,
          rainElapsedMs: validNumber(savedEvent.rainElapsedMs, 0, 500 - EPSILON) ? savedEvent.rainElapsedMs : 0
        };
        if (definition.target) eventState.outcome = null;
      }
    }

    function clickBoost() {
      return (owned.has("half") ? 0.5 : 0) + (owned.has("multiplier") ? 1.5 : 0) + (owned.has("double") ? 2 : 0);
    }

    function base() {
      return 1 + clickBoost();
    }

    function perClick() {
      const bonus = (owned.has("power") ? 5 : 0) + (owned.has("extra") ? 1 : 0);
      return base() + bonus;
    }

    function credit(units) {
      const requested = typeof units === "bigint" ? units : BigInt(Math.round(units));
      const actual = requested > 0n ? requested : 0n;
      balanceUnits += actual;
      earnedUnits += actual;
      return unitsToNumber(actual);
    }

    function debitUnits(units) {
      const actual = balanceUnits < units ? balanceUnits : units;
      balanceUnits -= actual;
      return -unitsToNumber(actual);
    }

    function isUnlocked(id) {
      const index = PRODUCTS.findIndex(product => product.id === id);
      return index >= 0 && (owned.has(id) || PRODUCTS.slice(0, index).every(product => owned.has(product.id)));
    }

    function finishEvent(outcome) {
      if (!eventState) return;
      const state = eventState;
      if (state.target) {
        if (outcome === "success") state.amount = credit((state.id === "marathon" ? 250 : 150) * 4);
        else {
          const tenth = (balanceUnits + 5n) / 10n;
          state.amount = debitUnits(state.id === "marathon" ? 400n : tenth < 800n ? tenth : 800n);
        }
      }
      state.outcome = outcome || state.outcome || "neutral";
      notices.push({ kind: "event-end", eventId: state.id, outcome: state.outcome, amount: state.amount });
      eventState = null;
      eventCountdown = nextDelay();
    }

    function startEvent() {
      const id = EVENT_IDS[Math.floor(random() * EVENT_IDS.length)];
      const definition = EVENTS[id];
      eventState = {
        id, remainingMs: definition.durationMs, durationMs: definition.durationMs,
        progress: 0, target: definition.target, outcome: null, amount: 0, rainElapsedMs: 0
      };
      if (id === "doubleDay") {
        eventState.amount = credit(balanceUnits);
        eventState.outcome = "success";
      } else if (id === "luckyPulse") {
        const lucky = random() < 0.5;
        eventState.amount = lucky ? credit(300 * 4) : debitUnits(400n);
        eventState.outcome = lucky ? "success" : "failure";
      }
      notices.push({ kind: "event-start", eventId: id, outcome: eventState.outcome, amount: eventState.amount });
    }

    function advanceAutos(elapsedMs) {
      for (const product of AUTO_PRODUCTS) {
        if (!owned.has(product.id)) continue;
        timers[product.id] += elapsedMs;
        const ticks = Math.floor((timers[product.id] + EPSILON) / product.interval);
        if (ticks) {
          timers[product.id] = Math.max(0, timers[product.id] - ticks * product.interval);
          credit(ticks * product.amount * 4);
        }
      }
    }

    function advance(elapsedMs, settings = {}) {
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
      const before = balanceUnits;
      let remaining = Math.min(elapsedMs, MAX_ADVANCE_MS);
      if (settings.eventsActive === false) {
        advanceAutos(remaining);
        return unitsToNumber(balanceUnits - before);
      }

      // Process boundaries chronologically: doubleDay must not multiply future income.
      while (remaining > EPSILON) {
        if (owned.has("events") && !eventState && eventCountdown <= EPSILON) startEvent();
        let step = remaining;
        for (const product of AUTO_PRODUCTS) {
          if (owned.has(product.id)) step = Math.min(step, product.interval - timers[product.id]);
        }
        if (attackState.remainingMs > 0) {
          step = Math.min(step, attackState.remainingMs, (attackPaidTicks + 1) * 100 - attackState.elapsedMs);
        }
        if (eventState) {
          step = Math.min(step, eventState.remainingMs);
          if (eventState.id === "goldenRain") step = Math.min(step, 500 - eventState.rainElapsedMs);
        } else if (owned.has("events")) step = Math.min(step, eventCountdown);
        step = Math.max(EPSILON, step);
        const attackWasActive = attackState.remainingMs > 0;
        advanceAutos(step);
        if (attackWasActive) {
          attackState.elapsedMs = Math.min(3000, attackState.elapsedMs + step);
          attackState.remainingMs = Math.max(0, 3000 - attackState.elapsedMs);
          const completedTicks = Math.floor((attackState.elapsedMs + EPSILON) / 100);
          while (attackPaidTicks < completedTicks) {
            attackPaidTicks++;
            const amount = credit(20 * 4);
            if (amount) notices.push({ kind: "attack-tick", amount });
          }
          if (attackState.remainingMs <= EPSILON) {
            attackState.remainingMs = 0;
            notices.push({ kind: "attack-end" });
          }
        }
        if (eventState) {
          eventState.remainingMs = Math.max(0, eventState.remainingMs - step);
          if (eventState.id === "goldenRain") {
            eventState.rainElapsedMs += step;
            if (eventState.rainElapsedMs >= 500 - EPSILON) {
              eventState.rainElapsedMs = Math.max(0, eventState.rainElapsedMs - 500);
              const amount = credit(10 * 4);
              eventState.amount += amount;
              if (amount) notices.push({ kind: "event-income", eventId: eventState.id, amount });
            }
          }
          if (eventState.remainingMs <= EPSILON) finishEvent(eventState.target ? "failure" : eventState.outcome || "success");
        } else if (owned.has("events")) eventCountdown = Math.max(0, eventCountdown - step);
        remaining = Math.max(0, remaining - step);
        if (owned.has("events") && !eventState && eventCountdown <= EPSILON) startEvent();
      }
      return unitsToNumber(balanceUnits - before);
    }

    return {
      // Numeric getters remain convenient for affordability and progress ratios.
      // Render the exact unit getters when displaying large balances.
      get balance() { return unitsToNumber(balanceUnits); },
      get earned() { return unitsToNumber(earnedUnits); },
      get balanceUnits() { return balanceUnits; },
      get earnedUnits() { return earnedUnits; },
      get manualClicks() { return manualClicks; },
      get owned() { return Array.from(owned); },
      get attack() {
        return { active: attackState.remainingMs > 0, remainingMs: attackState.remainingMs,
          elapsedMs: attackState.elapsedMs, clicksUntilRoll: 10 - attackState.cycleClicks };
      },
      get event() {
        if (!eventState) return null;
        const { rainElapsedMs, ...state } = eventState;
        return state;
      },
      get eventCountdown() { return eventCountdown; },
      has(id) { return owned.has(id); },
      isUnlocked,
      base,
      perClick,
      clickBoost,

      click() {
        const before = balanceUnits;
        manualClicks = Math.min(Number.MAX_SAFE_INTEGER, manualClicks + 1);
        credit(perClick() * 4);
        if (eventState && eventState.target) {
          eventState.progress++;
          if (eventState.progress >= eventState.target) finishEvent("success");
        }
        if (owned.has("attack")) {
          attackState.cycleClicks = (attackState.cycleClicks + 1) % 10;
          if (attackState.cycleClicks === 0 && !attackState.remainingMs && random() < 0.5) {
            attackState.elapsedMs = 0;
            attackState.remainingMs = 3000;
            attackPaidTicks = 0;
            notices.push({ kind: "attack-start" });
          }
        }
        return unitsToNumber(balanceUnits - before);
      },

      buy(id) {
        const product = PRODUCTS.find(candidate => candidate.id === id);
        if (!product || owned.has(id) || !isUnlocked(id) || balanceUnits < toUnits(product.cost)) return false;
        balanceUnits -= toUnits(product.cost);
        owned.add(id);
        if (Object.prototype.hasOwnProperty.call(timers, id)) timers[id] = 0;
        if (id === "attack") {
          attackState.cycleClicks = 0;
          attackState.elapsedMs = 0;
          attackState.remainingMs = 0;
          attackPaidTicks = 0;
        }
        if (id === "events") eventCountdown = nextDelay();
        return true;
      },

      advance,

      autoProgress(id) {
        const product = AUTO_PRODUCTS.find(candidate => candidate.id === id);
        return product && owned.has(id) ? timers[id] / product.interval : 0;
      },

      drainNotices() { return notices.splice(0); },

      snapshot() {
        return {
          version: 3,
          balance: unitsToNumber(balanceUnits),
          earned: unitsToNumber(earnedUnits),
          balanceUnits: balanceUnits.toString(),
          earnedUnits: earnedUnits.toString(),
          manualClicks,
          owned: Array.from(owned),
          autoProgress: { ...timers },
          attack: { ...attackState, active: attackState.remainingMs > 0 },
          event: eventState ? { ...eventState } : null,
          eventCountdown
        };
      }
    };
  }

  return Object.freeze({ PRODUCTS, EVENTS, createGame });
});
