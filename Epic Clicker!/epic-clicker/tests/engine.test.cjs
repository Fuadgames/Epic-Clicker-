"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PRODUCTS, createGame } = require("../dist/engine.js");
const allIds = PRODUCTS.map(p => p.id);
const randomSequence = (...values) => { let index = 0; return () => values[Math.min(index++, values.length - 1)]; };
const eventGame = (id, extra = {}) => createGame({
  balance: 1000, owned: ["events"], eventCountdown: 40000,
  event: { id, remainingMs: { marathon: 15000, overload: 10000, goldenRain: 8000, doubleDay: 8000, luckyPulse: 6000 }[id], progress: 0, amount: 0, ...extra }
}, { random: () => 0.5 });

test("a fresh game earns +1, with no multiplier or free upgrade", () => {
  const game = createGame();
  assert.equal(game.perClick(), 1);
  assert.equal(game.clickBoost(), 0);
  for (let i = 0; i < 10; i++) assert.equal(game.click(), 1);
  assert.equal(game.balance, 10);
  assert.deepEqual(game.owned, []);
  assert.equal(game.manualClicks, 10);
});

test("half adds 0.5 to one press, independently of the current balance", () => {
  const game = createGame({ balance: 100, owned: ["half"] });
  assert.equal(game.base(), 1.5);
  assert.equal(game.click(), 1.5);
  assert.equal(game.balance, 101.5);
  assert.equal(game.click(), 1.5);
  assert.equal(game.balance, 103);
  assert.equal(createGame({ balance: 100000, owned: ["half"] }).click(), 1.5);
});

test("buying half with the last ten clicks cannot trap the player at zero", () => {
  const game = createGame({ balance: 10 });
  assert.equal(game.buy("half"), true);
  assert.equal(game.balance, 0);
  assert.equal(game.click(), 1.5);
  assert.equal(game.balance, 1.5);
  assert.equal(game.click(), 1.5);
  assert.equal(game.balance, 3);
});

test("1.5x and 2x add per-press income and stack with every click bonus", () => {
  const one = createGame({ balance: 100, owned: ["multiplier"] });
  assert.equal(one.click(), 2.5);
  assert.equal(one.balance, 102.5);
  const two = createGame({ balance: 100, owned: ["double"] });
  assert.equal(two.click(), 3);
  assert.equal(two.balance, 103);
  const stacked = createGame({ balance: 100, owned: ["half", "multiplier", "double", "power", "extra"] });
  assert.equal(stacked.clickBoost(), 4);
  assert.equal(stacked.perClick(), 11);
  assert.equal(stacked.click(), 11);
  assert.equal(stacked.balance, 111);
  assert.equal(createGame({ owned: ["extra"] }).click(), 2);
});

test("preview and awarded income use the same quarter-click rounding", () => {
  const game = createGame({ balance: 11.25, owned: ["half", "extra"] });
  const before = game.balance, preview = game.perClick();
  assert.equal(game.click(), preview);
  assert.equal(game.balance - before, preview);
  assert.equal(game.balance * 4 % 1, 0);
});

test("only the next unowned upgrade unlocks, and owned upgrades stay available", () => {
  const game = createGame({ balance: 100000 });
  assert.equal(game.isUnlocked("half"), true);
  for (const p of PRODUCTS.slice(1)) {
    assert.equal(game.isUnlocked(p.id), false);
    assert.equal(game.buy(p.id), false);
  }
  let spent = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const product = PRODUCTS[i];
    assert.equal(game.isUnlocked(product.id), true);
    assert.equal(game.buy(product.id), true);
    spent += product.cost;
    assert.equal(game.buy(product.id), false);
    for (const previous of PRODUCTS.slice(0, i + 1)) assert.equal(game.isUnlocked(previous.id), true);
  }
  assert.equal(game.balance, 100000 - spent);
  assert.equal(game.earned, 100000);
});

test("legacy saves retain purchases, balance, sound-agnostic model and order gaps", () => {
  const game = createGame({ version: 1, balance: 12.75, earned: 100, manualClicks: 15, owned: ["autoFast"] });
  assert.equal(game.balance, 12.75);
  assert.equal(game.has("autoFast"), true);
  assert.equal(game.isUnlocked("autoFast"), true);
  assert.equal(game.isUnlocked("half"), true);
  assert.equal(game.isUnlocked("extra"), false);
  assert.equal(game.advance(2000), 5);
  assert.equal(game.snapshot().version, 3);
});

test("all auto-clickers accrue independently, including Ultra +100 per 3 seconds", () => {
  const game = createGame({ owned: ["autoSlow", "autoFast", "ultra"] });
  assert.equal(game.advance(1999), 0);
  assert.equal(game.advance(1), 5);
  assert.equal(game.advance(999), 0);
  assert.equal(game.advance(1), 100);
  assert.equal(game.advance(7000), 222); // 10 seconds: 2 + 25 + 300 = 327 total
  assert.equal(game.balance, 327);
});


test("newly purchased autos receive no time from before purchase", () => {
  const game = createGame({ balance: 100, owned: ["half"] });
  game.advance(60000);
  assert.equal(game.buy("autoSlow"), true);
  assert.equal(game.advance(4999), 0);
  assert.equal(game.advance(1), 1);
});

test("attack rolls every tenth press with the exact 50% boundary", () => {
  for (const [random, expected] of [[0.49999, true], [0.5, false]]) {
    const game = createGame({ manualClicks: 999, owned: ["attack"] }, { random: () => random });
    for (let i = 0; i < 9; i++) game.click();
    assert.equal(game.attack.active, false);
    assert.equal(game.attack.clicksUntilRoll, 1);
    game.click();
    assert.equal(game.attack.active, expected);
    assert.equal(game.attack.clicksUntilRoll, 10);
  }
});

test("attack lasts exactly 3 seconds, pays 600 and neither stacks nor restarts", () => {
  let rolls = 0;
  const game = createGame({ owned: ["attack"] }, { random: () => { rolls++; return 0; } });
  for (let i = 0; i < 10; i++) game.click();
  assert.equal(game.attack.remainingMs, 3000);
  for (let i = 0; i < 30; i++) game.click();
  assert.equal(rolls, 1);
  assert.equal(game.attack.remainingMs, 3000);
  assert.equal(game.advance(2999), 580);
  assert.equal(game.attack.active, true);
  assert.equal(game.advance(1), 20);
  assert.equal(game.attack.active, false);
  assert.equal(game.advance(500), 0);
  assert.equal(game.drainNotices().filter(n => n.kind === "attack-tick").reduce((sum, n) => sum + n.amount, 0), 600);
  assert.deepEqual(game.drainNotices(), []);
});

test("menus and hidden tabs pause attack and event clocks while autos keep working", () => {
  const game = createGame({ owned: ["attack", "events", "ultra"], eventCountdown: 45000 }, { random: () => 0 });
  for (let i = 0; i < 10; i++) game.click();
  assert.equal(game.advance(3000, { eventsActive: false }), 100);
  assert.equal(game.attack.remainingMs, 3000);
  assert.equal(game.eventCountdown, 45000);
  assert.equal(game.advance(3000), 700);
  assert.equal(game.eventCountdown, 42000);
});

test("attack reload resumes without paying previously awarded ticks again", () => {
  const game = createGame({ owned: ["attack"] }, { random: () => 0 });
  for (let i = 0; i < 10; i++) game.click();
  assert.equal(game.advance(1350), 260);
  const restored = createGame(game.snapshot(), { random: () => 0 });
  assert.equal(restored.attack.remainingMs, 1650);
  assert.equal(restored.advance(1650), 340);
  assert.equal(restored.balance, 610);
});

test("events start after 35-55 seconds and multiplier day doubles once", () => {
  const game = createGame({ balance: 100, owned: ["events"] }, { random: () => 0 });
  assert.equal(game.eventCountdown, 35000);
  game.advance(34999);
  assert.equal(game.event, null);
  assert.equal(game.advance(1), 100);
  assert.equal(game.event.id, "doubleDay");
  assert.equal(game.balance, 200);
  const restored = createGame(game.snapshot(), { random: () => 0 });
  assert.equal(restored.balance, 200);
  assert.equal(restored.advance(8000), 0);
  assert.equal(restored.event, null);
  assert.equal(restored.eventCountdown, 35000);
});

test("event scheduling is chronological relative to automatic income", () => {
  const game = createGame({ balance: 100, owned: ["events", "autoSlow"], eventCountdown: 5000 }, { random: () => 0 });
  game.advance(10000);
  assert.equal(game.balance, 203); // +1 at 5s, then double, then +1 at 10s
});

test("golden rain pays 160 over exactly eight seconds", () => {
  const game = eventGame("goldenRain");
  assert.equal(game.advance(499), 0);
  assert.equal(game.advance(1), 10);
  assert.equal(game.advance(7500), 150);
  assert.equal(game.event, null);
  assert.equal(game.balance, 1160);
});

test("marathon and overload quests have reachable success and explicit failure", () => {
  const marathon = eventGame("marathon");
  for (let i = 0; i < 25; i++) marathon.click();
  assert.equal(marathon.balance, 1275);
  assert.equal(marathon.event, null);
  assert.equal(marathon.drainNotices()[0].outcome, "success");
  const failed = eventGame("marathon");
  assert.equal(failed.advance(15000), -100);
  assert.equal(failed.balance, 900);
  const overload = eventGame("overload");
  for (let i = 0; i < 10; i++) overload.click();
  assert.equal(overload.balance, 1160);
  const failure = eventGame("overload");
  assert.equal(failure.advance(10000), -100);
  const capped = createGame({ balance: 10000, owned: ["events"], event: { id: "overload", remainingMs: 1 } });
  assert.equal(capped.advance(1), -200);
});

test("lucky pulse supports both outcomes and never makes the balance negative", () => {
  const lucky = createGame({ balance: 50, owned: ["events"], eventCountdown: 0 }, { random: randomSequence(0.99, 0.49) });
  assert.equal(lucky.advance(1), 300);
  assert.equal(lucky.event.outcome, "success");
  const unlucky = createGame({ balance: 50, owned: ["events"], eventCountdown: 0 }, { random: randomSequence(0.99, 0.5) });
  assert.equal(unlucky.advance(1), -50);
  assert.equal(unlucky.balance, 0);
  assert.equal(unlucky.event.outcome, "failure");
});

test("save roundtrip preserves partial autos, attack, quest and legacy balances", () => {
  const game = createGame({
    balance: 12.75, earned: 200, owned: ["autoSlow", "ultra", "events"],
    autoProgress: { autoSlow: 4000, ultra: 2500 }, eventCountdown: 50000,
    event: { id: "marathon", remainingMs: 8000, progress: 12 }
  });
  const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
  const restored = createGame(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(restored.advance(500, { eventsActive: false }), 100);
  assert.equal(restored.event.remainingMs, 8000);
  assert.equal(restored.event.progress, 12);
});

test("invalid inputs and extreme balances remain finite and nonnegative", () => {
  const game = createGame({ balance: Infinity, earned: -10, owned: ["half", "bad", "half"] });
  assert.equal(game.balance, 0);
  assert.deepEqual(game.owned, ["half"]);
  for (const delta of [NaN, Infinity, -1, "50"]) assert.equal(game.advance(delta), 0);
  const huge = createGame({ balance: Number.MAX_VALUE, owned: ["half", "double", "events"], eventCountdown: 0 }, { random: () => 0 });
  huge.click();
  huge.advance(1);
  assert.ok(Number.isFinite(huge.balance));
  assert.ok(Number.isFinite(huge.earned));
});

test("old saturated saves keep their balance and earn all eleven clicks per press", () => {
  const oldCap = (Number.MAX_SAFE_INTEGER - 3) / 4;
  const game = createGame({ version: 2, balance: oldCap, earned: oldCap, owned: allIds, eventCountdown: 50000 });
  const before = BigInt(Number.MAX_SAFE_INTEGER - 3);
  assert.equal(game.balanceUnits, before);
  assert.equal(game.perClick(), 11);
  assert.equal(game.click(), 11);
  assert.equal(game.balanceUnits, before + 44n);
  assert.equal(game.earnedUnits, before + 44n);
  assert.deepEqual(game.owned, allIds);
});

test("attack, golden rain and every auto-clicker pay beyond the former counter cap", () => {
  const balance = (Number.MAX_SAFE_INTEGER - 3) / 4;
  const attack = createGame({ balance, owned: ["attack"] }, { random: () => 0 });
  for (let i = 0; i < 10; i++) attack.click();
  const beforeAttack = attack.balanceUnits;
  assert.equal(attack.advance(3000), 600);
  assert.equal(attack.balanceUnits, beforeAttack + 2400n);
  assert.equal(attack.drainNotices().filter(n => n.kind === "attack-tick").reduce((sum, n) => sum + n.amount, 0), 600);

  const rain = createGame({ balance, owned: ["events"], eventCountdown: 50000,
    event: { id: "goldenRain", remainingMs: 8000, progress: 0 } });
  const beforeRain = rain.balanceUnits;
  assert.equal(rain.advance(8000), 160);
  assert.equal(rain.balanceUnits, beforeRain + 640n);

  const autos = createGame({ balance, owned: ["autoSlow", "autoFast", "ultra"] });
  const beforeAutos = autos.balanceUnits;
  assert.equal(autos.advance(10000), 327);
  assert.equal(autos.balanceUnits, beforeAutos + 1308n);
});

test("exact save strings retain quarter-clicks beyond Number precision after reload", () => {
  const startingUnits = BigInt("9".repeat(400));
  const game = createGame({ balanceUnits: startingUnits.toString(), earnedUnits: startingUnits.toString(), owned: ["half"] });
  assert.equal(game.balanceUnits, startingUnits);
  assert.equal(game.click(), 1.5);
  assert.equal(game.balanceUnits, startingUnits + 6n);
  assert.ok(Number.isFinite(game.balance));
  const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
  const restored = createGame(snapshot);
  assert.equal(snapshot.version, 3);
  assert.equal(restored.balanceUnits, startingUnits + 6n);
  assert.equal(restored.earnedUnits, startingUnits + 6n);
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(restored.click(), 1.5);
  assert.equal(restored.balanceUnits, startingUnits + 12n);
});

test("huge finite legacy values migrate without overflow, and events double or debit exact units", () => {
  const fractional = createGame({ balance: 2251799813685248.5 });
  assert.equal(fractional.balanceUnits, 9007199254740994n);
  const game = createGame({ balance: Number.MAX_VALUE, owned: ["events"], eventCountdown: 0 }, { random: () => 0 });
  const legacyUnits = BigInt(Number.MAX_VALUE) * 4n;
  assert.equal(game.balanceUnits, legacyUnits);
  game.advance(1);
  assert.equal(game.balanceUnits, legacyUnits * 2n);
  assert.ok(Number.isFinite(game.event.amount));
  const penalty = createGame({ ...game.snapshot(), event: { id: "overload", remainingMs: 1 } });
  assert.equal(penalty.advance(1), -200);
  assert.equal(penalty.balanceUnits, legacyUnits * 2n - 800n);
});

test("catalog and bilingual copy cover all ten products and every static UI label", () => {
  assert.deepEqual(PRODUCTS.map(p => p.cost), [10, 100, 500, 1000, 1500, 2000, 3000, 4000, 5000, 6000]);
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dist/i18n.js"), "utf8"), context);
  const dictionaries = context.window.EpicI18n;
  const html = fs.readFileSync(path.join(__dirname, "../dist/index.html"), "utf8");
  const gameJs = fs.readFileSync(path.join(__dirname, "../dist/game.js"), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map(m => m[1]);
  keys.push(...[...gameJs.matchAll(/\bt\("([^"]+)"/g)].map(m => m[1]));
  for (const language of ["ru", "en"]) {
    for (const key of keys) assert.ok(dictionaries[language].ui[key], language + ": missing " + key);
    for (const id of allIds) {
      for (const key of ["title", "type", "badge", "desc"]) assert.ok(dictionaries[language].products[id][key]);
    }
    for (const id of ["doubleDay", "goldenRain", "marathon", "overload", "luckyPulse"]) assert.ok(dictionaries[language].events[id].desc);
  }
  assert.deepEqual(Object.keys(dictionaries.ru.ui).sort(), Object.keys(dictionaries.en.ui).sort());
});

test("browser model export and UI element bindings are valid", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../dist/engine.js"), "utf8"), context);
  assert.equal(context.EpicEngine.createGame().click(), 1);
  const html = fs.readFileSync(path.join(__dirname, "../dist/index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../dist/game.js"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  ids.add("attack-badge"); // generated upgrade chip
  for (const match of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(match[1]), "Missing element " + match[1]);
});

