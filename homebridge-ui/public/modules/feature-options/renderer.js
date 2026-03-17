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
