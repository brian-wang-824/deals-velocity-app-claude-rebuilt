const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/notifications.js"), "utf8");
const thresholdValues = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element(properties = {}) {
  const listeners = {};
  return Object.assign({
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    addEventListener(type, listener) {
      (listeners[type] || (listeners[type] = [])).push(listener);
    },
    async emit(type, event = {}) {
      const payload = Object.assign({ target: this }, event);
      for (const listener of listeners[type] || []) await listener(payload);
    },
    close() {},
    setAttribute() {},
    showModal() {},
  }, properties);
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function createHarness(options = {}) {
  const storage = new Map();
  const calls = [];
  const counters = { subscribe: 0, unsubscribe: 0 };
  if (options.installation) {
    storage.set("deal-alert-installation-v1", JSON.stringify(options.installation));
  }

  function makeSubscription(endpoint) {
    return {
      endpoint,
      toJSON() {
        return {
          endpoint,
          expirationTime: null,
          keys: { p256dh: "p256dh", auth: "auth" },
        };
      },
      async unsubscribe() {
        counters.unsubscribe += 1;
        currentSubscription = null;
        return true;
      },
    };
  }

  let currentSubscription = options.hasSubscription === false
    ? null : makeSubscription("https://push.test/original");
  const pushManager = {
    async getSubscription() {
      if (options.getSubscription) return await options.getSubscription(() => currentSubscription);
      return currentSubscription;
    },
    async subscribe() {
      counters.subscribe += 1;
      currentSubscription = makeSubscription("https://push.test/replacement-" + counters.subscribe);
      return currentSubscription;
    },
  };
  const registration = { pushManager };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    async getRegistration() { return registration; },
    async register() { return registration; },
  };

  const inputs = thresholdValues.map((value) => element({ value }));
  const elements = {
    "notification-settings": element(),
    "notification-settings-button": element(),
    "notification-enable": element(),
    "notification-disable": element({ hidden: true }),
    "notification-status": element(),
    "notification-platform-note": element({ hidden: true }),
  };
  const notification = {
    permission: options.permission || "granted",
    async requestPermission() { return this.permission; },
  };
  const navigator = {
    maxTouchPoints: 0,
    platform: "test",
    serviceWorker,
    userAgent: "test browser",
  };
  const window = {
    NOTIFICATION_CONFIG: {
      edgeFunctionUrl: "https://api.test/notifications",
      vapidPublicKey: "AQIDBA",
    },
    Notification: notification,
    PushManager: function PushManager() {},
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    matchMedia() { return { matches: false }; },
    navigator,
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    removeItem(key) { storage.delete(key); },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const fetch = async (url, request) => {
    const call = { url, body: JSON.parse(request.body) };
    calls.push(call);
    return options.fetch ? await options.fetch(call, calls.length) : response(200, { ok: true });
  };

  vm.runInNewContext(source, {
    Buffer,
    Error,
    Notification: notification,
    Promise,
    Uint8Array,
    document: {
      getElementById(id) { return elements[id]; },
      querySelectorAll() { return inputs; },
    },
    fetch,
    localStorage,
    navigator,
    window,
  }, { filename: "notifications.js" });

  return {
    calls,
    counters,
    elements,
    inputs,
    storage,
    currentSubscription: () => currentSubscription,
    input(value) { return inputs.find((candidate) => candidate.value === value); },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function testStaleInstallationRecovers() {
  const harness = createHarness({
    installation: {
      installationId: "old-installation",
      managementSecret: "old-secret",
      thresholds: ["warming"],
    },
    async fetch(_call, number) {
      if (number === 1) {
        return response(401, { error: "This notification installation is no longer registered.", code: "stale_installation" });
      }
      return response(200, { installationId: "new-installation", managementSecret: "new-secret" });
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  assert.equal(harness.input("warming").checked, true);

  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].body.installationId, "old-installation");
  assert.equal(harness.calls[1].body.installationId, null);
  assert.deepEqual(harness.calls[1].body.thresholds, ["hot"]);
  assert.equal(harness.counters.unsubscribe, 1);
  assert.equal(harness.counters.subscribe, 1);
  const saved = JSON.parse(harness.storage.get("deal-alert-installation-v1"));
  assert.deepEqual(saved, {
    installationId: "new-installation",
    managementSecret: "new-secret",
    thresholds: ["hot"],
  });
  assert.equal(harness.elements["notification-status"].textContent, "Notifications enabled for 1 heat level.");
}

async function testDisableAlwaysCleansUpLocally() {
  const harness = createHarness({
    installation: {
      installationId: "stale-installation",
      managementSecret: "stale-secret",
      thresholds: ["inferno"],
    },
    async fetch() { return response(401, { error: "Invalid installation credentials." }); },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  assert.equal(harness.elements["notification-disable"].hidden, false);
  await harness.elements["notification-disable"].emit("click");
  await flush();

  assert.equal(harness.counters.unsubscribe, 1);
  assert.equal(harness.currentSubscription(), null);
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false);
  assert.equal(harness.inputs.every((input) => !input.checked), true);
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are off.");
  assert.equal(harness.elements["notification-disable"].hidden, true);
}

async function testGenericAuthErrorDoesNotReplaceSubscription() {
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    async fetch() { return response(401, { error: "Invalid JWT." }); },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  harness.input("warming").checked = false;
  harness.input("hot").checked = true;
  await harness.input("hot").emit("change");
  await harness.elements["notification-enable"].emit("click");
  await flush();

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.counters.unsubscribe, 0);
  assert.equal(harness.counters.subscribe, 0);
  assert.equal(harness.input("hot").checked, true, "failed save keeps the user's pending edit");
  assert.equal(harness.elements["notification-status"].textContent, "Invalid JWT.");
}

async function testSlowRemoteDisableDoesNotBlockLocalCleanup() {
  const pendingDisable = deferred();
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["hot"],
    },
    fetch() { return pendingDisable.promise; },
  });

  await harness.elements["notification-settings-button"].emit("click");
  await flush();
  await Promise.race([
    harness.elements["notification-disable"].emit("click"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("local disable waited for the remote API")), 100)),
  ]);

  assert.equal(harness.currentSubscription(), null);
  assert.equal(harness.storage.has("deal-alert-installation-v1"), false);
  assert.equal(harness.elements["notification-status"].textContent, "Notifications are off.");
  pendingDisable.resolve(response(200, { ok: true }));
  await flush();
}

async function testSlowRefreshDoesNotOverwriteEdits() {
  const pendingSubscription = deferred();
  let firstLookup = true;
  const harness = createHarness({
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["warming"],
    },
    getSubscription(current) {
      if (firstLookup) {
        firstLookup = false;
        return pendingSubscription.promise;
      }
      return current();
    },
  });

  await harness.elements["notification-settings-button"].emit("click");
  assert.equal(harness.input("warming").checked, true, "stored state hydrates before the slow lookup");
  harness.input("warming").checked = false;
  harness.input("surging").checked = true;
  await harness.input("surging").emit("change");
  pendingSubscription.resolve(harness.currentSubscription());
  await flush();

  assert.equal(harness.input("warming").checked, false);
  assert.equal(harness.input("surging").checked, true);
}

async function testOrphanedInstallationCanBeDisabled() {
  const harness = createHarness({
    hasSubscription: false,
    installation: {
      installationId: "installation",
      managementSecret: "secret",
      thresholds: ["blazing"],
    },
  });
  await harness.elements["notification-settings-button"].emit("click");
  assert.equal(harness.elements["notification-disable"].hidden, false);
  await flush();
  assert.equal(harness.elements["notification-status"].textContent, "Alert settings need to be re-enabled on this device.");
}

(async function run() {
  await testStaleInstallationRecovers();
  await testDisableAlwaysCleansUpLocally();
  await testGenericAuthErrorDoesNotReplaceSubscription();
  await testSlowRemoteDisableDoesNotBlockLocalCleanup();
  await testSlowRefreshDoesNotOverwriteEdits();
  await testOrphanedInstallationCanBeDisabled();
  console.log("notification client tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
