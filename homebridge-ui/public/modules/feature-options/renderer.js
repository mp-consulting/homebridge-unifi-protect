/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * renderer.js: Feature options rendering and mutation.
 */
import { $, escapeHtml, showScreen } from '../dom-helpers.js';
import { CATEGORY_COLORS, CATEGORY_ICONS } from '../constants.js';
import { buildScopeSelector, getCurrentScope, updateCascade } from './scope.js';
import { countEnabled, countModified, getOptionState, isOptionModified } from './option-state.js';
import { getControllers, saveConfigSilent, state } from '../state.js';

// Only show feature option categories that are valid for a particular device type.
const validOptionCategory = (device, category) => {

  // Always show all options at the global and controller level.
  if(!device || (device.modelKey === 'nvr')) {

    return true;
  }

  // Only show device categories we're explicitly interested in.
  if(!category.modelKey?.some(model => [ 'all', device.modelKey ].includes(model))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(category.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for the feature availability on a specific device type.
  const deviceFeatureKey = 'has' + device.modelKey.charAt(0).toUpperCase() + device.modelKey.slice(1) + 'Feature';

  if(category[deviceFeatureKey]?.some(x => !device.featureFlags?.[x])) {

    return false;
  }

  return true;
};

// Only show feature options that are valid for the capabilities of this device.
const validOption = (device, option) => {

  if(device && (device.modelKey !== 'nvr') && (
    (option.hasAccessFeature &&
      (!device.accessDeviceMetadata?.featureFlags || !option.hasAccessFeature.some(x => device.accessDeviceMetadata.featureFlags[x]))) ||
    (option.hasFeature && (!device.featureFlags || !option.hasFeature.some(x => device.featureFlags[x]))) ||
    (option.hasProperty && !option.hasProperty.some(x => x in device)) ||
    (option.modelKey && (option.modelKey !== 'all') && !option.modelKey.includes(device.modelKey)) ||
    (option.hasSmartObjectType && device.featureFlags?.smartDetectTypes &&
      !option.hasSmartObjectType.some(x => device.featureFlags.smartDetectTypes.includes(x))))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(device && option.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for device class-specific features and properties.
  switch(device?.modelKey) {

    case 'camera':

      if(option.hasCameraFeature && !option.hasCameraFeature.some(x => device.featureFlags[x])) {

        return false;
      }

      break;

    case 'light':

      if(option.hasLightProperty && !option.hasLightProperty.some(x => x in device)) {

        return false;
      }

      break;

    case 'sensor':

      if(option.hasSensorProperty && !option.hasSensorProperty.some(x => x in device)) {

        return false;
      }

      break;

    default:

      break;
  }

  return true;
};

export const openFeatureOptions = async (controllerIndex) => {


  state.currentControllerIndex = controllerIndex;
  const ctrl = getControllers()[controllerIndex];

  showScreen('featureOptionsScreen');
  $('optionsLoading').style.display = 'block';
  $('optionsContainer').innerHTML = '';
  $('deviceInfoPanel').style.display = 'none';
  $('thirdPartyOverridesPanel').style.display = 'none';
  $('unsavedChanges').style.display = 'none';
  $('optionsSearch').value = '';

  try {


    const [ optionsData, devices ] = await Promise.all([
      homebridge.request('/getOptions'),
      homebridge.request('/getDevices', { address: ctrl.address, password: ctrl.password, username: ctrl.username }),
    ]);

    state.categories = optionsData.categories;
    state.options = optionsData.options;

    // Process devices: the first entry is the NVR, followed by cameras, chimes, lights, sensors, viewers.
    state.devices = [];

    if(devices?.length) {

      for(const device of devices) {

        device.name ??= device.marketName;
        state.devices.push(device);
      }
    }

    buildScopeSelector(ctrl);
    renderOptions();
  } catch(e) {


    homebridge.toast.error('Failed to load: ' + e.message);
  } finally {


    $('optionsLoading').style.display = 'none';
  }
};

export const renderOptions = () => {


  const container = $('optionsContainer');

  container.innerHTML = '';

  const scope = getCurrentScope();

  // Update the visual cascade diagram.
  updateCascade(scope.type);
  const searchTerm = ($('optionsSearch').value || '').toLowerCase();
  const modifiedOnly = $('modifiedOnlyToggle')?.checked || false;

  // Device info panel.
  if(scope.device && (scope.device.modelKey !== 'nvr')) {


    $('deviceInfoPanel').style.display = 'block';
    $('infoModel').textContent = scope.device.marketName || scope.device.type;
    $('infoMac').textContent = scope.device.mac;
    $('infoIp').textContent = scope.device.host ||
      (scope.device.modelKey === 'sensor' ? ((scope.device.connectionType === 'lora' ? 'SuperLink' : 'Bluetooth') + ' Device') : 'N/A');
    const statusEl = $('infoStatus');

    if('state' in scope.device) {

      statusEl.textContent = scope.device.state.charAt(0).toUpperCase() + scope.device.state.slice(1).toLowerCase();
      statusEl.className = scope.device.state === 'CONNECTED' ? 'text-success' : 'text-danger';
    } else {

      statusEl.textContent = 'Connected';
      statusEl.className = 'text-success';
    }
  } else {


    $('deviceInfoPanel').style.display = 'none';
  }

  // Third-party camera URL overrides panel.
  renderThirdPartyOverridesPanel(scope);

  let totalModified = 0;

  // Render each category as a card.
  state.categories.forEach((category) => {


    // Filter categories based on device type.
    if(!validOptionCategory(scope.device, category)) {
      return;
    }

    const categoryOptions = state.options[category.name] || [];

    if(!categoryOptions.length) {
      return;
    }

    // Filter options for this device and search.
    let validOptions = categoryOptions.filter(opt => {

      if(scope.device && (scope.device.modelKey !== 'nvr')) {

        if(!validOption(scope.device, opt)) {
          return false;
        }
      }

      if(searchTerm) {


        const text = (opt.name + ' ' + opt.description).toLowerCase();

        if(!text.includes(searchTerm)) {
          return false;
        }
      }

      return true;
    });

    if(!validOptions.length) {
      return;
    }

    // Count stats before filtering for "modified only".
    const modifiedCount = countModified(category.name, validOptions, scope);
    const enabledCount = countEnabled(category.name, validOptions, scope);

    totalModified += modifiedCount;

    // Apply "modified only" filter.
    if(modifiedOnly) {


      validOptions = validOptions.filter(opt => {


        const optionKey = category.name + (opt.name ? '.' + opt.name : '');

        return isOptionModified(optionKey, scope.id);
      });

      if(!validOptions.length) {
        return;
      }
    }

    const icon = CATEGORY_ICONS[category.name] || 'gear';
    const color = CATEGORY_COLORS[category.name] || '#6c757d';
    const isOpen = state.openCategories.has(category.name) || ((modifiedCount > 0) && !state.openCategories.size) || !!searchTerm;

    // Build card.
    const card = document.createElement('div');

    card.className = 'card mb-3 category-card';
    card.style.setProperty('--category-color', color);
    card.dataset.category = category.name;

    const header = document.createElement('div');

    header.className = 'card-header bg-transparent d-flex justify-content-between align-items-center';
    header.style.cursor = 'pointer';

    const progressPct = validOptions.length ? Math.round((enabledCount / categoryOptions.length) * 100) : 0;


    header.innerHTML = `
      <div class="d-flex align-items-center">
        <span class="category-icon" style="background-color: ${color}"><i class="bi bi-${icon}"></i></span>
        <span class="ms-2">${escapeHtml(category.description.replace(/ feature options\.?/i, ''))}</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="category-summary d-none d-sm-flex align-items-center gap-2">
          <span>${enabledCount}/${categoryOptions.length} on</span>
          <span class="category-progress"><span class="category-progress-fill" style="width: ${progressPct}%"></span></span>
        </span>
        ${modifiedCount ? `<span class="badge bg-warning text-dark">${modifiedCount}</span>` : ''}
        <i class="bi bi-chevron-${isOpen ? 'up' : 'down'} toggle-icon"></i>
      </div>
    `;


    const body = document.createElement('div');

    body.className = 'category-body' + (isOpen ? ' open' : '');

    const optList = document.createElement('div');

    optList.className = 'list-group list-group-flush';

    validOptions.forEach(opt => {


      const optionKey = category.name + (opt.name ? '.' + opt.name : '');
      const optEl = createOptionItem(optionKey, opt, scope, category);

      optList.appendChild(optEl);
    });

    body.appendChild(optList);
    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    // Toggle collapse and persist state.
    header.addEventListener('click', () => {


      const wasOpen = body.classList.contains('open');

      body.classList.toggle('open');
      header.querySelector('.toggle-icon').className = 'bi bi-chevron-' + (wasOpen ? 'down' : 'up') + ' toggle-icon';

      if(wasOpen) {


        state.openCategories.delete(category.name);
      } else {


        state.openCategories.add(category.name);
      }
    });
  });

  // Update modified summary.
  const summaryEl = $('modifiedSummary');


  summaryEl.textContent = totalModified ? `(${totalModified})` : '';
  summaryEl.className = totalModified ? 'text-warning' : '';
};

const createOptionItem = (optionKey, opt, scope, category) => {


  const optEl = document.createElement('div');
  const optState = getOptionState(optionKey, opt, scope);
  const switchId = 'sw-' + optionKey.replace(/[^a-zA-Z0-9]/g, '-');
  const isGrouped = opt.group && (opt.name !== opt.group);

  // Build class list with scope-based styling.
  let scopeClass = '';

  if(optState.explicit) {


    scopeClass = 'scope-' + scope.type;
  } else if(optState.scope === 'controller') {


    scopeClass = 'scope-controller';
  } else if((optState.scope === 'global') && (scope.type !== 'global')) {


    scopeClass = 'scope-global';
  } else if(optState.enabled !== opt.default) {


    scopeClass = 'non-default';
  }

  optEl.className = 'list-group-item option-item ' + scopeClass + (isGrouped ? ' option-grouped' : '');

  // Scope indicator badge.
  let scopeIndicator = '';

  if(optState.explicit) {


    const scopeColor = scope.type === 'device' ? 'info' : scope.type === 'controller' ? 'success' : 'warning';
    const scopeLabel = scope.type === 'device' ? 'device' : scope.type === 'controller' ? 'controller' : 'global';


    scopeIndicator = `<span class="badge bg-${scopeColor} ms-1">${scopeLabel}</span>`;
  } else if(optState.scope === 'controller') {


    scopeIndicator = '<span class="badge bg-success bg-opacity-50 ms-1"><i class="bi bi-arrow-down" style="font-size:0.55rem"></i> controller</span>';
  } else if((optState.scope === 'global') && (scope.type !== 'global')) {


    scopeIndicator = '<span class="badge bg-secondary bg-opacity-50 ms-1"><i class="bi bi-arrow-down" style="font-size:0.55rem"></i> global</span>';
  }

  // Display name: use option name or category name for the unnamed device option.
  const displayName = opt.name || category.description.replace(/ feature options\.?/i, '');

  // Default value indicator.

  const defaultIndicator =
    `<span class="default-indicator ${opt.default ? 'default-on' : 'default-off'} ms-2">default: ${opt.default ? 'on' : 'off'}</span>`;

  const resetButton = optState.explicit ?
    '<button class="btn btn-outline-secondary btn-sm reset-option-btn flex-shrink-0 mt-1" title="Reset to inherited value">' +
      '<i class="bi bi-arrow-counterclockwise"></i></button>' :
    '';

  // Value input for options with configurable numeric values.
  let valueRow = '';

  if(opt.defaultValue !== undefined) {

    const currentValue = optState.value ?? opt.defaultValue;
    const unitMatch = opt.description.match(/\bin (seconds?|minutes?|hours?|milliseconds?|decibels?|Hertz|kilobits per second|percentage)\b/i);
    const unit = unitMatch ? unitMatch[1] : '';

    valueRow = `
        <div class="option-value ms-4 mt-1"${!optState.enabled ? ' style="display:none"' : ''}>
          <div class="d-flex align-items-center gap-2">
            <input type="number" class="form-control form-control-sm option-value-input" value="${currentValue}" min="0" step="1">
            ${unit ? `<span class="option-value-unit text-muted">${unit}</span>` : ''}
            <span class="option-value-default text-muted">(default: ${opt.defaultValue})</span>
          </div>
        </div>`;
  }

  optEl.innerHTML = `
    <div class="d-flex justify-content-between align-items-start">
      <div class="me-3 flex-grow-1">
        <div class="form-check form-switch mb-1">
          <input class="form-check-input" type="checkbox" id="${switchId}" ${optState.enabled ? 'checked' : ''}>
          <label class="form-check-label d-flex align-items-center flex-wrap" for="${switchId}">
            <span class="option-name">${escapeHtml(displayName)}</span>
            ${defaultIndicator}
            ${scopeIndicator}
          </label>
        </div>
        <div class="option-description text-muted ms-4">${escapeHtml(opt.description)}</div>
        ${valueRow}
      </div>
      ${resetButton}
    </div>
  `;

  optEl.querySelector('#' + switchId).addEventListener('change', function() {

    setOption(optionKey, this.checked, scope, opt);
  });

  const valueInput = optEl.querySelector('.option-value-input');

  if(valueInput) {


    valueInput.addEventListener('change', function() {


      const val = parseInt(this.value, 10);

      if(!isNaN(val) && (val >= 0)) {

        setOption(optionKey, true, scope, opt, val);
      }
    });
  }

  const resetBtn = optEl.querySelector('.reset-option-btn');

  if(resetBtn) {


    resetBtn.addEventListener('click', (e) => {


      e.stopPropagation();
      removeOption(optionKey, scope);
    });
  }

  return optEl;
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const setOption = (optionKey, enabled, scope, opt, value) => {


  state.pluginConfig[0].options ||= [];

  const scopeId = scope.id;
  const suffix = scopeId ? '.' + scopeId : '';

  // Remove existing entry at this scope (including any value suffix).
  const removeRegex = new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + (scopeId ? '\\.' + escapeRegex(scopeId) : '') + '(?:\\.\\d+)?$', 'i');

  state.pluginConfig[0].options = state.pluginConfig[0].options.filter(o => !removeRegex.test(o));

  // Only add an explicit entry if the state differs from inherited/default.
  const inherited = opt ? getOptionState(optionKey, opt, scope) : null;
  const valueDiffers = (value !== undefined) && (value !== opt?.defaultValue);

  if(!inherited || (inherited.enabled !== enabled) || valueDiffers) {

    const valueSuffix = (enabled && valueDiffers) ? '.' + value : '';

    state.pluginConfig[0].options.push((enabled ? 'Enable' : 'Disable') + '.' + optionKey + suffix + valueSuffix);
  }

  saveConfigSilent();
  $('unsavedChanges').style.display = 'block';
  renderOptions();
};

const removeOption = (optionKey, scope) => {


  if(!state.pluginConfig[0].options) {
    return;
  }

  const scopeId = scope.id;
  const removeRegex = new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + (scopeId ? '\\.' + escapeRegex(scopeId) : '') + '(?:\\.\\d+)?$', 'i');

  state.pluginConfig[0].options = state.pluginConfig[0].options.filter(o => !removeRegex.test(o));

  saveConfigSilent();
  $('unsavedChanges').style.display = 'block';
  renderOptions();
};

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
const renderThirdPartyOverridesPanel = (scope) => {

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
    onvifDiscoveryState.set(normalizeMac(mac), { collapsedFrom: rawProfiles.length, port: result.port, profiles, thumbnails: new Map() });

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

      const result = await homebridge.request('/fetchSnapshot', { url: profile.snapshotUrl });

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

// Update a single field on the per-camera override entry, creating or removing the entry as needed.
const updateCameraOverride = (mac, field, rawValue) => {

  const ctrl = state.pluginConfig[0]?.controllers?.[state.currentControllerIndex];

  if(!ctrl) {

    return;
  }

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
