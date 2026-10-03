/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * third-party-overrides.js: Per-camera URL override panel for third-party (ONVIF) cameras - ONVIF discovery, profile selection, snapshot thumbnails, and
 * cameraOverrides config persistence.
 */
import { $ } from '../dom-helpers.js';
import { saveConfigSilent, state } from '../state.js';

// Match the MAC normalization used by findCameraOverride() in src/protect-options.ts.
const normalizeMac = (mac) => (mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();

// Discovery results live outside any single-render closure so the dropdown's change handler keeps working even if the renderer re-runs (e.g. after
// updateCameraOverride dispatches saveConfigSilent and some downstream listener triggers a re-render). Indexed by normalized camera MAC because the
// panel is reused across cameras as the user navigates the feature-options scope.
const onvifDiscoveryState = new Map();

// Named handler for the profile <select> change event. Reads the active camera MAC from the element's data attribute (set during render) so it works
// regardless of when it was attached vs. closed-over scope. Reused as a stable reference for addEventListener / removeEventListener.
const handleProfileSelectChange = (event) => {

  const target = event.currentTarget;
  const mac = target.dataset.cameraMac;
  const index = parseInt(target.value, 10);

  if(!mac || !Number.isFinite(index)) {

    return;
  }

  if(!onvifDiscoveryState.has(normalizeMac(mac))) {

    return;
  }

  applyOnvifProfile(mac, index);
};

// Render the per-camera URL override panel for ONVIF / third-party cameras.
export const renderThirdPartyOverridesPanel = (scope) => {

  const panel = $('thirdPartyOverridesPanel');
  const header = $('thirdPartyOverridesHeader');
  const body = $('thirdPartyOverridesBody');
  const toggle = $('thirdPartyOverridesToggle');
  const rtspInput = $('thirdPartyRtspUrl');
  const snapshotInput = $('thirdPartySnapshotUrl');
  const onvifHost = $('thirdPartyOnvifHost');
  const onvifPort = $('thirdPartyOnvifPort');
  const onvifUser = $('thirdPartyOnvifUser');
  const onvifPass = $('thirdPartyOnvifPass');
  const onvifPath = $('thirdPartyOnvifPath');
  const discoverBtn = $('thirdPartyDiscoverBtn');
  const status = $('thirdPartyDiscoverStatus');

  // The panel only applies to a specific third-party camera (device scope), not to global / controller scopes.
  if(!scope.device || (scope.device.modelKey !== 'camera') || !scope.device.isThirdPartyCamera) {

    panel.style.display = 'none';

    return;
  }

  const ctrl = state.pluginConfig[0]?.controllers?.[state.currentControllerIndex];

  if(!ctrl) {

    panel.style.display = 'none';

    return;
  }

  // Clean up any legacy duplicate cameraOverride rows for this controller before reading. The lookup below would only see the first match anyway, so
  // without this the user would see one entry's values in the UI while the trailing duplicates lurked invisibly in the JSON.
  if(dedupeCameraOverrides(ctrl)) {

    saveConfigSilent();
  }

  const target = normalizeMac(scope.device.mac);
  const existing = (ctrl.cameraOverrides || []).find(entry => normalizeMac(entry.mac) === target);

  rtspInput.value = existing?.rtspUrl || '';
  snapshotInput.value = existing?.snapshotUrl || '';

  // The host is always sourced from Protect. The UniFi controller is the authoritative owner of the camera's IP on the adopted device, so we display
  // its current value rather than a saved copy that could drift if the camera's address changes. The remaining ONVIF fields are pre-filled from the
  // persisted override entry so the user does not have to re-enter credentials on every visit.
  onvifHost.value = scope.device.host || '';
  onvifPort.value = (existing?.onvifPort != null) ? String(existing.onvifPort) : '';
  onvifUser.value = existing?.onvifUsername || '';
  onvifPass.value = existing?.onvifPassword || '';
  onvifPath.value = existing?.onvifServicePath || '';
  status.textContent = '';
  status.className = 'small flex-grow-1';

  // Hide the profile selector until a discovery surfaces profiles. Reset its selection state and thumbnail so values from a previous camera don't bleed
  // in. If the user already discovered profiles for this camera in this session, restore them so navigating away and back doesn't lose the picker.
  const profileSelectorWrap = $('thirdPartyProfileSelectorWrap');
  const profileSelect = $('thirdPartyProfileSelect');
  const profileThumb = $('thirdPartyProfileThumb');
  const profileThumbPlaceholder = $('thirdPartyProfileThumbPlaceholder');

  profileSelectorWrap.style.display = 'none';
  profileSelect.innerHTML = '';
  profileThumb.removeAttribute('src');
  profileThumb.style.display = 'none';
  profileThumbPlaceholder.style.display = '';

  // Bind the change listener fresh on every render. The active MAC rides on the element via a data attribute so the handler can't get out of sync with
  // a closure-captured value, and we use addEventListener after explicitly clearing onchange so any stale property-style listener from an earlier code
  // path is gone too. We listen on both 'change' and 'input' because some embedded WebViews fire one but not the other on <select> elements.
  profileSelect.dataset.cameraMac = scope.device.mac;
  profileSelect.onchange = null;
  profileSelect.oninput = null;
  profileSelect.removeEventListener('change', handleProfileSelectChange);
  profileSelect.removeEventListener('input', handleProfileSelectChange);
  profileSelect.addEventListener('change', handleProfileSelectChange);
  profileSelect.addEventListener('input', handleProfileSelectChange);

  // Restore a prior discovery for this camera if one exists.
  const previousDiscovery = onvifDiscoveryState.get(normalizeMac(scope.device.mac));

  if(previousDiscovery) {

    renderProfileSelector(scope.device.mac);
  }

  panel.style.display = 'block';

  // Apply persisted open/closed state. Default closed to match the category cards below.
  applyThirdPartyPanelOpenState(body, toggle);

  // Re-bind handlers on each render. Setting onX handlers (rather than addEventListener) automatically replaces any prior listener.
  header.onclick = () => {

    state.thirdPartyPanelOpen = !state.thirdPartyPanelOpen;
    applyThirdPartyPanelOpenState(body, toggle);
  };

  rtspInput.oninput = () => updateCameraOverride(scope.device.mac, 'rtspUrl', rtspInput.value);
  snapshotInput.oninput = () => updateCameraOverride(scope.device.mac, 'snapshotUrl', snapshotInput.value);
  onvifPort.oninput = () => updateCameraOverride(scope.device.mac, 'onvifPort', onvifPort.value);
  onvifUser.oninput = () => updateCameraOverride(scope.device.mac, 'onvifUsername', onvifUser.value);
  onvifPass.oninput = () => updateCameraOverride(scope.device.mac, 'onvifPassword', onvifPass.value);
  onvifPath.oninput = () => updateCameraOverride(scope.device.mac, 'onvifServicePath', onvifPath.value);
  discoverBtn.onclick = () => discoverOnvifAndPopulate(scope.device.mac);
};

// Sync the body's `.open` class and the chevron direction with state.thirdPartyPanelOpen.
const applyThirdPartyPanelOpenState = (body, toggle) => {

  body.classList.toggle('open', state.thirdPartyPanelOpen);
  toggle.className = 'bi bi-chevron-' + (state.thirdPartyPanelOpen ? 'up' : 'down') + ' toggle-icon';
};

// Call the backend ONVIF discovery endpoint and, on success, populate the URL fields and persist them.
const discoverOnvifAndPopulate = async (mac) => {

  const onvifHost = $('thirdPartyOnvifHost');
  const onvifPort = $('thirdPartyOnvifPort');
  const onvifUser = $('thirdPartyOnvifUser');
  const onvifPass = $('thirdPartyOnvifPass');
  const onvifPath = $('thirdPartyOnvifPath');
  const discoverBtn = $('thirdPartyDiscoverBtn');
  const status = $('thirdPartyDiscoverStatus');
  const rtspInput = $('thirdPartyRtspUrl');
  const snapshotInput = $('thirdPartySnapshotUrl');

  const host = onvifHost.value.trim();
  const username = onvifUser.value.trim();
  const password = onvifPass.value;
  const servicePath = onvifPath.value.trim();

  if(!host || !username) {

    status.textContent = 'IP address and username are required.';
    status.className = 'small flex-grow-1 text-danger';

    return;
  }

  // Persist whatever the user entered (or accepted from the pre-fill) before talking to the camera. Programmatic .value assignments during render do not
  // fire `oninput`, so without this any field that was left at its default would never make it into config.json on its own. The host is intentionally
  // not saved - it is always sourced live from Protect on render.
  updateCameraOverride(mac, 'onvifPort', onvifPort.value);
  updateCameraOverride(mac, 'onvifUsername', username);
  updateCameraOverride(mac, 'onvifPassword', password);
  updateCameraOverride(mac, 'onvifServicePath', servicePath);

  discoverBtn.disabled = true;
  status.textContent = 'Discovering…';
  status.className = 'small flex-grow-1 text-muted';

  try {

    const result = await homebridge.request('/discoverOnvif', {

      host,
      password,
      port: onvifPort.value ? parseInt(onvifPort.value, 10) : undefined,
      servicePath: servicePath || undefined,
      username,
    });

    if(!result?.ok) {

      status.textContent = 'Discovery failed: ' + (result?.error || 'unknown error');
      status.className = 'small flex-grow-1 text-danger';

      return;
    }

    const rawProfiles = (result.profiles || []).filter(p => p.rtspUrl || p.snapshotUrl);

    if(!rawProfiles.length) {

      status.textContent = 'Camera did not return any URLs.';
      status.className = 'small flex-grow-1 text-warning';

      return;
    }

    // Some cameras (notably Tapo) advertise multiple ONVIF profiles that all map to the same RTSP/snapshot URL. Picking between identical entries is
    // confusing, so collapse duplicates by URL pair while keeping the richest metadata - we prefer the entry with the larger declared resolution so the
    // remaining profile still labels the stream meaningfully.
    const profiles = dedupeProfilesByUrl(rawProfiles);

    // Stash the discovery result on the module so the change listener bound during render can keep using it across re-renders.
    onvifDiscoveryState.set(normalizeMac(mac), {

      collapsedFrom: rawProfiles.length,
      host,
      port: result.port,
      profiles,
      thumbnails: new Map(),
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    });

    renderProfileSelector(mac);
  } catch(err) {

    status.textContent = 'Discovery failed: ' + (err?.message || err);
    status.className = 'small flex-grow-1 text-danger';
  } finally {

    discoverBtn.disabled = false;
  }
};

// Collapse profiles whose RTSP and snapshot URLs are identical down to a single entry. Keeps the entry with the largest advertised resolution so the
// surviving profile is the most informative. Cameras like Tapo expose multiple "profiles" (MainStream / SubStream) that all point at the same physical
// stream - showing both as separate options just confuses the user since picking either does the same thing.
const dedupeProfilesByUrl = (profiles) => {

  const byKey = new Map();

  for(const profile of profiles) {

    const key = (profile.rtspUrl || '') + '|' + (profile.snapshotUrl || '');
    const existing = byKey.get(key);

    if(!existing) {

      byKey.set(key, profile);

      continue;
    }

    const existingPixels = (existing.resolution?.width ?? 0) * (existing.resolution?.height ?? 0);
    const candidatePixels = (profile.resolution?.width ?? 0) * (profile.resolution?.height ?? 0);

    if(candidatePixels > existingPixels) {

      byKey.set(key, profile);
    }
  }

  return [...byKey.values()];
};

// Build a human-readable label for a single ONVIF profile, e.g. "Main Stream — 3840×2160 H264".
const formatProfileLabel = (profile, index) => {

  const parts = [];

  parts.push(profile.name || ('Profile ' + (index + 1)));

  if(profile.resolution?.width && profile.resolution?.height) {

    parts.push(profile.resolution.width + '×' + profile.resolution.height);
  }

  if(profile.encoding) {

    parts.push(profile.encoding);
  }

  return parts.join(' — ');
};

// Render the profile dropdown from whatever is in onvifDiscoveryState for this camera. Safe to call repeatedly - re-renders are idempotent and the
// dropdown's change listener (bound once during panel render) keeps reading the same module state, so user input continues to flow even if some other
// path triggers a re-render.
const renderProfileSelector = (mac) => {

  const entry = onvifDiscoveryState.get(normalizeMac(mac));

  if(!entry?.profiles?.length) {

    return;
  }

  const { profiles, port } = entry;
  const profileSelectorWrap = $('thirdPartyProfileSelectorWrap');
  const profileSelect = $('thirdPartyProfileSelect');
  const status = $('thirdPartyDiscoverStatus');
  const rtspInput = $('thirdPartyRtspUrl');

  // Try to keep the user's current selection sticky: if one of the profiles' rtspUrl matches what's already saved, default to it.
  const currentRtsp = rtspInput.value;
  let defaultIndex = profiles.findIndex(p => p.rtspUrl && (p.rtspUrl === currentRtsp));

  if(defaultIndex < 0) {

    defaultIndex = 0;
  }

  profileSelect.innerHTML = '';

  profiles.forEach((profile, index) => {

    const opt = document.createElement('option');

    opt.value = String(index);
    opt.textContent = formatProfileLabel(profile, index);
    profileSelect.appendChild(opt);
  });

  profileSelect.value = String(defaultIndex);
  profileSelectorWrap.style.display = 'block';
  profileSelect.disabled = (profiles.length <= 1);

  applyOnvifProfile(mac, defaultIndex);

  // Eagerly prefetch the remaining profiles' thumbnails so switching the dropdown is instant. Run sequentially to avoid hammering the camera with N
  // concurrent snapshot requests, which several budget cameras don't tolerate well.
  (async () => {

    for(let i = 0; i < profiles.length; i++) {

      if(i === defaultIndex) {

        continue;
      }

      await loadOnvifThumbnail(mac, i);
    }
  })();

  if(profiles.length > 1) {

    status.textContent = 'Found ' + profiles.length + ' profiles on port ' + port + '. Pick the one to use.';
  } else if(entry.collapsedFrom && (entry.collapsedFrom > 1)) {

    status.textContent = 'Camera reports ' + entry.collapsedFrom + ' profiles but they all map to the same stream. Discovered URLs on port ' + port + '.';
  } else {

    status.textContent = 'Discovered URLs on port ' + port + '.';
  }

  status.className = 'small flex-grow-1 text-success';

  // Surface anything the server flagged during discovery - e.g. URLs on a foreign host that we deliberately left without credentials.
  if(entry.warnings?.length) {

    status.textContent += ' ' + entry.warnings.join(' ');
    status.className = 'small flex-grow-1 text-warning';
  }
};

// Show whatever thumbnail (if any) is cached for the given profile index. Falls back to the placeholder when the fetch failed or hasn't happened yet.
const showOnvifThumbnail = (mac, index) => {

  const profileThumb = $('thirdPartyProfileThumb');
  const profileThumbPlaceholder = $('thirdPartyProfileThumbPlaceholder');
  const entry = onvifDiscoveryState.get(normalizeMac(mac));
  const cached = entry?.thumbnails.get(index);

  if(cached) {

    profileThumb.src = cached;
    profileThumb.style.display = '';
    profileThumbPlaceholder.style.display = 'none';
  } else {

    profileThumb.removeAttribute('src');
    profileThumb.style.display = 'none';
    profileThumbPlaceholder.style.display = '';
  }
};

// Fetch (and cache) a single profile's snapshot via the homebridge UI server proxy. Refreshes the visible thumbnail if the user is still on this index.
// All fetches for a given camera are serialized through a per-camera queue so the camera never receives parallel snapshot requests across profiles -
// several budget cameras (Tapo included) abort the second connection mid-stream when two snapshot fetches arrive at once. Calls for an already-cached
// or already-in-flight index resolve immediately to the existing result.
const loadOnvifThumbnail = (mac, index) => {

  const entry = onvifDiscoveryState.get(normalizeMac(mac));

  if(!entry) {

    return Promise.resolve();
  }

  if(entry.thumbnails.has(index)) {

    return Promise.resolve();
  }

  if(entry.inflight?.has(index)) {

    return entry.inflight.get(index);
  }

  const profile = entry.profiles[index];

  if(!profile?.snapshotUrl) {

    entry.thumbnails.set(index, null);

    return Promise.resolve();
  }

  entry.inflight ||= new Map();

  // Chain this fetch onto the camera's queue tail. Each promise in the chain swallows errors so a single failed fetch doesn't break the queue.
  const previousTail = entry.queueTail || Promise.resolve();

  const promise = previousTail.then(async () => {

    // It is possible another caller (e.g. the user switching profiles during prefetch) populated the cache while we were waiting in the queue. If so,
    // skip the actual fetch.
    if(entry.thumbnails.has(index)) {

      return;
    }

    try {

      const result = await homebridge.request('/fetchSnapshot', { host: entry.host, url: profile.snapshotUrl });

      if(result?.ok && result.data) {

        entry.thumbnails.set(index, 'data:' + (result.contentType || 'image/jpeg') + ';base64,' + result.data);
      } else {

        entry.thumbnails.set(index, null);
      }
    } catch {

      entry.thumbnails.set(index, null);
    } finally {

      entry.inflight.delete(index);
    }

    const profileSelect = $('thirdPartyProfileSelect');
    const currentSelect = parseInt(profileSelect.value, 10);

    if(currentSelect === index) {

      showOnvifThumbnail(mac, index);
    }
  });

  entry.inflight.set(index, promise);
  entry.queueTail = promise.catch(() => {});

  return promise;
};

// Apply a profile selection: write its URLs to the inputs and config, refresh the thumbnail, and kick off a thumbnail fetch if needed.
const applyOnvifProfile = (mac, index) => {

  const entry = onvifDiscoveryState.get(normalizeMac(mac));
  const profile = entry?.profiles[index];

  if(!profile) {

    return;
  }

  const rtspInput = $('thirdPartyRtspUrl');
  const snapshotInput = $('thirdPartySnapshotUrl');

  rtspInput.value = profile.rtspUrl || '';
  snapshotInput.value = profile.snapshotUrl || '';
  updateCameraOverride(mac, 'rtspUrl', profile.rtspUrl || '');
  updateCameraOverride(mac, 'snapshotUrl', profile.snapshotUrl || '');
  showOnvifThumbnail(mac, index);
  loadOnvifThumbnail(mac, index);
};

// Fields tracked on a cameraOverride entry. If none of these are set, the entry has no purpose and is dropped to keep the config clean.
const CAMERA_OVERRIDE_FIELDS = [ 'rtspUrl', 'snapshotUrl', 'onvifPort', 'onvifUsername', 'onvifPassword', 'onvifServicePath' ];

// Fields that should be coerced to a number before being stored (so the JSON config has a numeric value, matching the schema).
const CAMERA_OVERRIDE_NUMERIC_FIELDS = new Set([ 'onvifPort' ]);

// Collapse multiple cameraOverride entries that resolve to the same camera MAC into a single entry. The lookup path already normalizes MACs when finding
// an existing entry, so duplicates should not arise from this UI - but legacy configs, manual edits, or controllers being removed and re-added can leave
// the array with several rows for the same camera. Without dedup, only the first match wins at runtime and the trailing rows are dead weight that
// confuses anyone reading the JSON. Later entries win on a per-field basis (they reflect the most recent intent) but earlier entries' fields are kept if
// the later row left them empty, so we never silently lose data the user once entered. Returns true if anything changed.
export const dedupeCameraOverrides = (ctrl) => {

  if(!ctrl?.cameraOverrides?.length) {

    return false;
  }

  const merged = new Map();
  const original = ctrl.cameraOverrides;

  for(const entry of original) {

    const key = normalizeMac(entry?.mac || '');

    // Drop entries that don't identify a camera - they can't be matched at runtime anyway.
    if(!key) {

      continue;
    }

    const existing = merged.get(key);

    if(!existing) {

      merged.set(key, { ...entry });

      continue;
    }

    // Merge field-by-field. A non-empty value on the later entry overrides; otherwise we keep what was already there.
    for(const field of CAMERA_OVERRIDE_FIELDS) {

      const value = entry[field];

      if((value !== undefined) && (value !== '')) {

        existing[field] = value;
      }
    }
  }

  // Drop merged entries that no longer carry any tracked fields.
  const cleaned = [...merged.values()].filter(entry => CAMERA_OVERRIDE_FIELDS.some(f => entry[f] !== undefined));
  const changed = (cleaned.length !== original.length) || cleaned.some((entry, i) => entry !== original[i]);

  if(!changed) {

    return false;
  }

  if(cleaned.length) {

    ctrl.cameraOverrides = cleaned;
  } else {

    delete ctrl.cameraOverrides;
  }

  return true;
};

// Update a single field on the per-camera override entry, creating or removing the entry as needed.
const updateCameraOverride = (mac, field, rawValue) => {

  const ctrl = state.pluginConfig[0]?.controllers?.[state.currentControllerIndex];

  if(!ctrl) {

    return;
  }

  // Collapse any pre-existing duplicates before we look up or mutate the entry, so subsequent logic operates on a clean array.
  dedupeCameraOverrides(ctrl);

  const trimmed = (rawValue == null ? '' : String(rawValue)).trim();
  const target = normalizeMac(mac);

  // Coerce numeric fields. An invalid number is treated as empty (i.e. clears the field).
  let value;

  if(CAMERA_OVERRIDE_NUMERIC_FIELDS.has(field)) {

    const parsed = trimmed === '' ? NaN : Number(trimmed);

    value = Number.isFinite(parsed) ? parsed : '';
  } else {

    value = trimmed;
  }

  ctrl.cameraOverrides ||= [];

  let entry = ctrl.cameraOverrides.find(e => normalizeMac(e.mac) === target);

  if(!entry) {

    // No existing entry. If the new value is empty, there's nothing to do.
    if(value === '') {

      return;
    }

    entry = { mac };
    ctrl.cameraOverrides.push(entry);
  }

  if(value === '') {

    delete entry[field];
  } else {

    entry[field] = value;
  }

  // If the entry no longer carries any tracked fields, drop it to keep the config clean.
  if(!CAMERA_OVERRIDE_FIELDS.some(f => entry[f] !== undefined)) {

    ctrl.cameraOverrides = ctrl.cameraOverrides.filter(e => e !== entry);
  }

  // If the array is now empty, drop it entirely.
  if(!ctrl.cameraOverrides.length) {

    delete ctrl.cameraOverrides;
  }

  saveConfigSilent();
  $('unsavedChanges').style.display = 'block';
};
