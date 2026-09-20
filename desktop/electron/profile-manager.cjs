const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_SCHEMA_VERSION = 2;
const RUNTIME_RISK_FIELDS = [
  'userAgent',
  'locale',
  'timezone',
  'platform',
  'arch',
  'webRTCPolicy',
];
const BINDING_FIELDS = [
  'platform',
  'accountKey',
  'windowId',
  'workspaceId',
  'ownerUserId',
  'proxyMode',
  'proxyId',
  'proxyType',
  'proxyHost',
  'proxyPort',
];

function cleanId(value, fallback = 'profile') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, 120) || fallback;
}

function cleanText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function normalizeProxyHost(value) {
  const normalized = cleanText(value);
  if (!normalized) return null;
  return normalized.replace(/^\[|\]$/g, '').toLowerCase();
}

function comparableRuntime(runtime = {}) {
  return {
    userAgent: String(runtime.userAgent || ''),
    locale: String(runtime.locale || ''),
    timezone: String(runtime.timezone || ''),
    platform: String(runtime.platform || ''),
    arch: String(runtime.arch || ''),
    electronVersion: String(runtime.electronVersion || ''),
    chromiumVersion: String(runtime.chromiumVersion || ''),
    webRTCPolicy: String(runtime.webRTCPolicy || ''),
  };
}

function changedFields(previous = {}, next = {}) {
  const left = comparableRuntime(previous);
  const right = comparableRuntime(next);
  return Object.keys(right).filter((key) => left[key] && right[key] && left[key] !== right[key]);
}

function runtimeRiskChangedFields(previous = {}, next = {}) {
  const changed = changedFields(previous, next);
  return changed.filter((field) => RUNTIME_RISK_FIELDS.includes(field));
}

function runtimeSignature(runtime = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(comparableRuntime(runtime)))
    .digest('hex');
}

function proxyBindingFromConfig(config = {}, previous = {}) {
  const previousBinding = previous?.proxyBinding || {};
  const hasMode = Object.prototype.hasOwnProperty.call(config, 'mode');
  const mode = hasMode
    ? (config.mode === 'proxy' ? 'proxy' : 'direct')
    : (previousBinding.mode === 'proxy' ? 'proxy' : 'direct');
  const proxy = config.proxy && typeof config.proxy === 'object' ? config.proxy : {};

  if (mode !== 'proxy') {
    return {
      mode: 'direct',
      proxyId: null,
      type: null,
      host: null,
      port: null,
    };
  }

  const port = Number(proxy.port ?? previousBinding.port);
  return {
    mode: 'proxy',
    proxyId: cleanText(config.proxyId ?? previousBinding.proxyId) || null,
    type: cleanText(proxy.type ?? previousBinding.type).toLowerCase() || null,
    host: normalizeProxyHost(proxy.host ?? previousBinding.host),
    port: Number.isFinite(port) ? port : null,
  };
}

function profileBindingFromConfig(config = {}, previous, id) {
  const platform = cleanText(config.platform ?? previous?.platform);
  const accountKey = cleanText(
    config.accountId ?? config.account ?? config.title ?? previous?.accountKey,
    id,
  );
  const windowId = cleanText(config.id ?? previous?.windowId, id);
  const workspaceId = cleanText(config.workspaceId ?? previous?.workspaceId);
  const ownerUserId = cleanText(config.ownerUserId ?? previous?.ownerUserId);
  const proxyBinding = proxyBindingFromConfig(config, previous);
  return {
    platform,
    accountKey,
    windowId,
    workspaceId,
    ownerUserId,
    proxyBinding,
    profileScope: [String(platform).toLowerCase(), workspaceId, ownerUserId, id]
      .filter(Boolean)
      .join(':'),
  };
}

function bindingValues(binding = {}) {
  const proxyBinding = binding.proxyBinding || {};
  return {
    platform: binding.platform || '',
    accountKey: binding.accountKey || '',
    windowId: binding.windowId || '',
    workspaceId: binding.workspaceId || '',
    ownerUserId: binding.ownerUserId || '',
    proxyMode: proxyBinding.mode || 'direct',
    proxyId: proxyBinding.proxyId || '',
    proxyType: String(proxyBinding.type || '').toLowerCase(),
    proxyHost: normalizeProxyHost(proxyBinding.host) || '',
    proxyPort: proxyBinding.port == null ? '' : String(proxyBinding.port),
  };
}

function bindingMismatchFields(previous, next) {
  if (!previous?.platform) return [];
  const left = bindingValues({
    platform: previous.platform,
    accountKey: previous.accountKey,
    windowId: previous.windowId,
    workspaceId: previous.workspaceId,
    ownerUserId: previous.ownerUserId,
    proxyBinding: previous.proxyBinding,
  });
  const right = bindingValues(next);
  return BINDING_FIELDS.filter((field) => left[field] !== right[field]);
}

function profilePartition(platform, id, workspaceId, ownerUserId) {
  const scope = [workspaceId, ownerUserId]
    .map((value) => cleanId(value, 'scope'))
    .join('-');
  return 'persist:seagrass-' + String(platform || 'platform').toLowerCase() + '-' + scope + '-' + id;
}

function createProfileManager({ userDataPath, runtime }) {
  const filePath = path.join(userDataPath, 'account-profiles.json');
  const profiles = new Map();

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...profiles.values()], null, 2), 'utf8');
  }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data)) return;
      for (const profile of data) {
        if (profile?.id && profile?.platform) profiles.set(profile.id, profile);
      }
    } catch {
      // The profile registry is created when the first platform window is opened.
    }
  }

  function ensure(config = {}) {
    const id = cleanId(
      config.profileId || config.id,
      'profile-' + String(config.platform || 'app').toLowerCase(),
    );
    const previous = profiles.get(id);
    const currentRuntime = comparableRuntime({
      ...runtime,
      ...(config.runtime || {}),
    });
    const binding = profileBindingFromConfig(config, previous, id);
    const bindingMismatches = bindingMismatchFields(previous, binding);

    // A profile is deliberately not silently rebound to another account,
    // platform, or proxy. Rebinding must be an explicit product operation.
    if (bindingMismatches.length && !config.allowProfileRebind) {
      return {
        ...previous,
        bindingConflict: true,
        bindingMismatchFields: bindingMismatches,
        runtimeChangedFields: changedFields(previous?.runtime, currentRuntime),
        runtimeRiskChangedFields: runtimeRiskChangedFields(previous?.runtime, currentRuntime),
      };
    }

    const runtimeChanged = changedFields(previous?.runtime, currentRuntime);
    const runtimeRiskChanged = runtimeRiskChangedFields(previous?.runtime, currentRuntime);
    const baselineRiskChanged = runtimeRiskChangedFields(previous?.runtimeBaseline, currentRuntime);
    const versionChanged = runtimeChanged.filter((field) => !RUNTIME_RISK_FIELDS.includes(field));
    const now = new Date().toISOString();
    const partition = previous?.isolation?.partition
      || profilePartition(binding.platform, id, binding.workspaceId, binding.ownerUserId);
    const profile = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id,
      platform: binding.platform,
      accountKey: binding.accountKey,
      windowId: binding.windowId,
      title: cleanText(config.title || config.account || previous?.title, id),
      workspaceId: binding.workspaceId,
      ownerMemberId: cleanText(config.ownerMemberId || previous?.ownerMemberId, ''),
      ownerUserId: binding.ownerUserId,
      profileScope: binding.profileScope,
      stable: true,
      runtime: currentRuntime,
      runtimeBaseline: previous?.runtimeBaseline || currentRuntime,
      runtimeSignature: runtimeSignature(currentRuntime),
      runtimeChangedFields: runtimeChanged,
      runtimeRiskChangedFields: runtimeRiskChanged,
      proxyBinding: binding.proxyBinding,
      isolation: {
        partition,
        storage: 'persistent',
        proxyMode: binding.proxyBinding.mode,
        fixedUserAgent: Boolean(currentRuntime.userAgent),
        webRTCPolicy: currentRuntime.webRTCPolicy,
      },
      consistency: baselineRiskChanged.length || runtimeRiskChanged.length
        ? 'changed'
        : (versionChanged.length ? 'app-updated' : 'stable'),
      mismatchFields: runtimeChanged,
      bindingMismatchFields: [],
      bindingConflict: false,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    if (config.allowProfileRebind && bindingMismatches.length) {
      profile.lastRebindAt = now;
      profile.lastRebindFields = bindingMismatches;
    } else {
      profile.lastRebindAt = previous?.lastRebindAt || null;
      profile.lastRebindFields = previous?.lastRebindFields || [];
    }
    profiles.set(id, profile);
    persist();
    return profile;
  }

  function rebind(id, config = {}) {
    return ensure({ ...config, profileId: id, allowProfileRebind: true });
  }

  function get(id) {
    return id ? profiles.get(cleanId(id)) || null : null;
  }

  function list() {
    return [...profiles.values()].map((profile) => ({ ...profile }));
  }

  function adoptLegacyScope({ workspaceId, userId } = {}) {
    const workspace = cleanText(workspaceId);
    const owner = cleanText(userId);
    if (!workspace || !owner) return false;
    let changed = false;
    for (const profile of profiles.values()) {
      if (
        !profile.ownerUserId
        && (!profile.workspaceId || profile.workspaceId === workspace)
      ) {
        profile.ownerUserId = owner;
        profile.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) persist();
    return changed;
  }

  return {
    load,
    ensure,
    rebind,
    get,
    list,
    adoptLegacyScope,
    persist,
    filePath,
  };
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  comparableRuntime,
  changedFields,
  runtimeRiskChangedFields,
  runtimeSignature,
  bindingMismatchFields,
  createProfileManager,
};
