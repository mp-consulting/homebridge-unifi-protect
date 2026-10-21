/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * renderer.js: Feature options rendering and mutation.
 */
import { $, escapeAttr, escapeHtml, showScreen } from '../dom-helpers.js';
import { CATEGORY_COLORS, CATEGORY_ICONS } from '../constants.js';
import { buildScopeSelector, getCurrentScope, updateCascade } from './scope.js';
import { categoryStats, countModified, getOptionState, isOptionModified } from './option-state.js';
import { assistant, assistantController, assistantDevice, deviceProblem, renderExplain, scrubText } from '../assistant.js';
import { getControllers, saveConfigSilent, state } from '../state.js';
import { renderThirdPartyOverridesPanel } from './third-party-overrides.js';

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

// Show a controller connection error above the options, with an "Explain" button when the Assistant is on.
const showOptionsProblem = (ctrl, message) => {

  const container = $('optionsProblem');
  const alert = document.createElement('div');
  const text = document.createElement('div');
  const slot = document.createElement('div');

  alert.className = 'alert alert-danger mb-0';
  text.textContent = message;
  slot.className = 'mt-2';
  alert.append(text, slot);
  container.replaceChildren(alert);
  container.style.display = 'block';

  renderExplain(slot, {

    context: 'Loading the devices of a configured UniFi Protect controller for the feature options screen of the plugin webUI failed.',
    device: assistantController(ctrl),
    error: scrubText(message, [ ctrl?.address ]),
    title: 'Why can the devices not be loaded?',
  });
};

// Show why the selected device needs attention above the options, with an "Explain" button. Lives in the main column rather than the narrow scope
// sidebar so an opened answer gets the full width. Renders nothing when the Assistant is off: the sidebar already shows the device status.
const showDeviceProblem = (device, problem) => {

  const container = $('infoAssistant');

  if(!problem || !assistant.enabled) {

    container.style.display = 'none';
    container.replaceChildren();

    return;
  }

  const alert = document.createElement('div');
  const text = document.createElement('div');
  const slot = document.createElement('div');

  alert.className = 'alert alert-warning mb-0';
  text.textContent = (device.name || 'This device') + ': ' + problem;
  slot.className = 'mt-2';
  alert.append(text, slot);
  container.replaceChildren(alert);
  container.style.display = 'block';

  renderExplain(slot, {

    context: 'The user is looking at the feature options of a UniFi Protect device in the plugin webUI.',
    device: assistantDevice(device),
    error: problem,
    title: 'Why is ' + (device.name || 'this device') + ' not connected?',
  });
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
  $('optionsProblem').style.display = 'none';
  $('optionsProblem').replaceChildren();
  showDeviceProblem(null, null);

  try {


    // Tagged so /getErrorMessage hands back this request's error even if another validation is in flight.
    const requestId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const [ optionsData, devices ] = await Promise.all([
      homebridge.request('/getOptions'),
      homebridge.request('/getDevices', {
        address: ctrl.address, password: ctrl.password, requestId, username: ctrl.username, verifyTls: ctrl.verifyTls === true,
      }),
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

    if(!devices?.length) {

      const errorDetail = await homebridge.request('/getErrorMessage', { requestId });

      showOptionsProblem(ctrl, 'Unable to load the devices of this controller. ' + (errorDetail || 'Check its address and credentials.'));
    }

    buildScopeSelector(ctrl);
    renderOptions();
  } catch(e) {


    homebridge.toast.error('Failed to load: ' + e.message);
    showOptionsProblem(ctrl, 'Failed to load: ' + e.message);
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

    if(typeof scope.device.state === 'string') {

      statusEl.textContent = scope.device.state.charAt(0).toUpperCase() + scope.device.state.slice(1).toLowerCase();
      statusEl.className = scope.device.state === 'CONNECTED' ? 'text-success' : 'text-danger';
    } else {

      statusEl.textContent = 'Connected';
      statusEl.className = 'text-success';
    }

    showDeviceProblem(scope.device, deviceProblem(scope.device));
  } else {


    $('deviceInfoPanel').style.display = 'none';
    showDeviceProblem(null, null);
  }

  // Third-party camera URL overrides panel.
  renderThirdPartyOverridesPanel(scope);

  let totalModified = 0;

  // Remember the filters of this render: the in-place updates after an option change count the same options the cards show, even while a search edit is
  // still waiting on its debounce.
  renderedView.modifiedOnly = modifiedOnly;
  renderedView.searchTerm = searchTerm;

  // Render each category as a card.
  state.categories.forEach((category) => {


    // Options valid for this device and matching the search, before the "modified only" filter.
    let validOptions = getCategoryOptions(category, scope, searchTerm);

    if(!validOptions?.length) {
      return;
    }

    // Count stats before filtering for "modified only".
    const stats = categoryStats(category.name, validOptions, scope);

    totalModified += stats.modified;

    // Apply "modified only" filter.
    if(modifiedOnly) {


      validOptions = validOptions.filter(opt => isOptionModified(getOptionKey(category, opt), scope.id));

      if(!validOptions.length) {
        return;
      }
    }

    const icon = CATEGORY_ICONS[category.name] || 'gear';
    const color = CATEGORY_COLORS[category.name] || '#6c757d';
    const isOpen = state.openCategories.has(category.name) || ((stats.modified > 0) && !state.openCategories.size) || !!searchTerm;

    // Build card.
    const card = document.createElement('div');

    card.className = 'card mb-3 category-card';
    card.style.setProperty('--category-color', color);
    card.dataset.category = category.name;

    const header = document.createElement('div');

    header.className = 'card-header bg-transparent d-flex justify-content-between align-items-center';
    header.style.cursor = 'pointer';


    // The counts, progress and modified badge are filled by updateCategoryHeader(), which also refreshes them in place after an option change.
    header.innerHTML = `
      <div class="d-flex align-items-center">
        <span class="category-icon" style="background-color: ${escapeAttr(color)}"><i class="bi bi-${escapeAttr(icon)}"></i></span>
        <span class="ms-2">${escapeHtml(category.description.replace(/ feature options\.?/i, ''))}</span>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="category-summary d-none d-sm-flex align-items-center gap-2">
          <span class="category-count"></span>
          <span class="category-progress"><span class="category-progress-fill"></span></span>
        </span>
        <span class="badge bg-warning text-dark category-modified"></span>
        <i class="bi bi-chevron-down toggle-icon"></i>
      </div>
    `;

    updateCategoryHeader(header, stats);

    const body = document.createElement('div');

    body.className = 'category-body' + (isOpen ? ' open' : '');

    const optList = document.createElement('div');

    optList.className = 'list-group list-group-flush';

    validOptions.forEach(opt => {


      const optEl = createOptionItem(getOptionKey(category, opt), opt, scope, category);

      optList.appendChild(optEl);
    });

    body.appendChild(optList);
    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    // Toggle collapse and persist state. The chevron rotates in CSS from the body's open class.
    header.addEventListener('click', () => {


      const wasOpen = body.classList.contains('open');

      body.classList.toggle('open');

      if(wasOpen) {


        state.openCategories.delete(category.name);
      } else {


        state.openCategories.add(category.name);
      }
    });
  });

  // Nothing to show: say why instead of leaving a blank area.
  if(!container.childElementCount) {

    const empty = document.createElement('p');

    empty.className = 'text-muted text-center my-4';
    empty.textContent = modifiedOnly ? 'No modified options' : (searchTerm ? 'No options match your search' : 'No options available');
    container.appendChild(empty);
  }

  updateModifiedSummary(totalModified);
};

// Filters used by the last full render, reused by the in-place updates after an option change.
const renderedView = { modifiedOnly: false, searchTerm: '' };

const getOptionKey = (category, opt) => category.name + (opt.name ? '.' + opt.name : '');

// The options of a category that apply to the scope's device and match the search, before the "modified only" filter. Null when the whole category does
// not apply to the device.
const getCategoryOptions = (category, scope, searchTerm) => {

  if(!validOptionCategory(scope.device, category)) {

    return null;
  }

  return (state.options[category.name] || []).filter(opt => {

    if(scope.device && (scope.device.modelKey !== 'nvr') && !validOption(scope.device, opt)) {

      return false;
    }

    return !searchTerm || (opt.name + ' ' + opt.description).toLowerCase().includes(searchTerm);
  });
};

// Fill a category header's "x/y on" count, progress bar and modified badge.
const updateCategoryHeader = (header, stats) => {

  const badge = header.querySelector('.category-modified');

  header.querySelector('.category-count').textContent = stats.enabled + '/' + stats.total + ' on';
  header.querySelector('.category-progress-fill').style.setProperty('--progress', String(stats.fraction));
  badge.textContent = String(stats.modified);
  badge.classList.toggle('d-none', !stats.modified);
};

const updateModifiedSummary = (totalModified) => {

  const summaryEl = $('modifiedSummary');

  summaryEl.textContent = totalModified ? `(${totalModified})` : '';
  summaryEl.className = totalModified ? 'text-warning' : '';
};

// Refresh the screen after one option changed. An option's state only depends on its own config entries, so only its row, its category header and the
// modified total can change: update those in place rather than rebuilding every card, which would drop focus and cut the switch and row transitions short.
const refreshAfterOptionChange = (optEl, optionKey, opt, scope, category) => {

  // The "modified only" view lists modified options only: one that is no longer modified has to drop out, so rebuild the list.
  if(renderedView.modifiedOnly && !isOptionModified(optionKey, scope.id)) {

    renderOptions();

    return;
  }

  updateOptionItem(optEl, optionKey, opt, scope);

  const header = optEl.closest('.category-card')?.querySelector(':scope > .card-header');

  if(header) {

    updateCategoryHeader(header, categoryStats(category.name, getCategoryOptions(category, scope, renderedView.searchTerm) || [], scope));
  }

  updateModifiedSummary(state.categories.reduce((total, cat) => {

    const options = getCategoryOptions(cat, scope, renderedView.searchTerm);

    return total + (options ? countModified(cat.name, options, scope) : 0);
  }, 0));
};

const createOptionItem = (optionKey, opt, scope, category) => {


  const optEl = document.createElement('div');
  const switchId = 'sw-' + optionKey.replace(/[^a-zA-Z0-9]/g, '-');

  // Display name: use option name or category name for the unnamed device option.
  const displayName = opt.name || category.description.replace(/ feature options\.?/i, '');

  // Default value indicator.

  const defaultIndicator =
    `<span class="default-indicator ${opt.default ? 'default-on' : 'default-off'} ms-2">default: ${opt.default ? 'on' : 'off'}</span>`;

  // Value input for options with configurable numeric values. Its value is set by updateOptionItem().
  let valueRow = '';

  if(opt.defaultValue !== undefined) {

    const unitMatch = opt.description.match(/\bin (seconds?|minutes?|hours?|milliseconds?|decibels?|Hertz|kilobits per second|percentage)\b/i);
    const unit = unitMatch ? unitMatch[1] : '';

    valueRow = `
        <div class="option-value ms-4 mt-1">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <input type="number" class="form-control form-control-sm option-value-input" min="0" step="1">
            ${unit ? `<span class="option-value-unit text-muted">${escapeHtml(unit)}</span>` : ''}
            <span class="option-value-default text-muted">(default: ${escapeHtml(String(opt.defaultValue))})</span>
          </div>
        </div>`;
  }

  // The reset button is always present and only hidden while the option has no explicit value at this scope, so updates never rebuild the row.
  optEl.innerHTML = `
    <div class="d-flex justify-content-between align-items-start">
      <div class="me-3 flex-grow-1 min-w-0">
        <div class="form-check form-switch mb-1">
          <input class="form-check-input" type="checkbox" id="${switchId}">
          <label class="form-check-label d-flex align-items-center flex-wrap" for="${switchId}">
            <span class="option-name">${escapeHtml(displayName)}</span>
            ${defaultIndicator}
          </label>
        </div>
        <div class="option-description text-muted ms-4">${escapeHtml(opt.description)}</div>
        ${valueRow}
      </div>
      <button type="button" class="btn btn-outline-secondary btn-sm reset-option-btn flex-shrink-0 mt-1" title="Reset to inherited value"
        aria-label="Reset to inherited value"><i class="bi bi-arrow-counterclockwise"></i></button>
    </div>
  `;

  updateOptionItem(optEl, optionKey, opt, scope);

  optEl.querySelector('#' + switchId).addEventListener('change', function() {

    setOption(optionKey, this.checked, scope, opt);
    refreshAfterOptionChange(optEl, optionKey, opt, scope, category);
  });

  const valueInput = optEl.querySelector('.option-value-input');

  if(valueInput) {


    valueInput.addEventListener('change', function() {


      const val = parseInt(this.value, 10);

      if(!isNaN(val) && (val >= 0)) {

        setOption(optionKey, true, scope, opt, val);
        refreshAfterOptionChange(optEl, optionKey, opt, scope, category);
      }
    });
  }

  optEl.querySelector('.reset-option-btn').addEventListener('click', (e) => {


    e.stopPropagation();
    removeOption(optionKey, scope);
    refreshAfterOptionChange(optEl, optionKey, opt, scope, category);
  });

  return optEl;
};

// Sync an option row with its current state: switch, scope styling and badge, reset button and value input. Used when the row is built and after a change.
const updateOptionItem = (optEl, optionKey, opt, scope) => {


  const optState = getOptionState(optionKey, opt, scope);
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


    scopeIndicator = `<span class="badge bg-${scopeColor} ms-1 option-scope-badge">${scopeLabel}</span>`;
  } else if(optState.scope === 'controller') {


    scopeIndicator = '<span class="badge bg-success bg-opacity-50 ms-1 option-scope-badge">' +
      '<i class="bi bi-arrow-down" style="font-size:0.55rem"></i> controller</span>';
  } else if((optState.scope === 'global') && (scope.type !== 'global')) {


    scopeIndicator = '<span class="badge bg-secondary bg-opacity-50 ms-1 option-scope-badge">' +
      '<i class="bi bi-arrow-down" style="font-size:0.55rem"></i> global</span>';
  }

  optEl.querySelector('.option-scope-badge')?.remove();

  if(scopeIndicator) {

    optEl.querySelector('.form-check-label').insertAdjacentHTML('beforeend', scopeIndicator);
  }

  const checkbox = optEl.querySelector('.form-check-input');
  const resetBtn = optEl.querySelector('.reset-option-btn');

  checkbox.checked = optState.enabled;

  // Hiding the focused reset button would drop focus to the page: hand it to the option's switch first.
  if(!optState.explicit && (document.activeElement === resetBtn)) {

    checkbox.focus();
  }

  resetBtn.classList.toggle('d-none', !optState.explicit);

  const valueRow = optEl.querySelector('.option-value');

  if(valueRow) {

    const valueInput = valueRow.querySelector('.option-value-input');
    const currentValue = String(optState.value ?? opt.defaultValue);

    valueRow.style.display = optState.enabled ? '' : 'none';

    if(valueInput.value !== currentValue) {

      valueInput.value = currentValue;
    }
  }
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
};
