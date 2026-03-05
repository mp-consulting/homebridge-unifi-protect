/* @mp-consulting/homebridge-unifi-protect Custom UI. */
import { $, showScreen } from './modules/dom-helpers.js';
import { getControllers, state } from './modules/state.js';
import { handleSetupSubmit, openAddController, renderControllers } from './modules/controllers.js';
import { PLUGIN_NAME } from './modules/constants.js';
import { handleDiscover } from './modules/discovery.js';
import { renderOptions } from './modules/feature-options.js';

// Bind event listeners for the discovery screen.
const bindDiscoveryScreen = () => {


  $('discoverBtn').addEventListener('click', handleDiscover);
  $('manualEntryBtn').addEventListener('click', () => openAddController());
  $('cancelDiscoveryBtn').addEventListener('click', () => {


    showScreen('controllersScreen');
    renderControllers();
  });
};

// Bind event listeners for the setup (add/edit controller) screen.
const bindSetupScreen = () => {


  $('setupForm').addEventListener('submit', handleSetupSubmit);
  $('cancelSetupBtn').addEventListener('click', () => {


    if(getControllers().length) {


      showScreen('controllersScreen');
      renderControllers();
    } else {


      showScreen('discoveryScreen');
    }
  });
};

// Bind event listeners for the controllers list screen.
const bindControllersScreen = () => {


  $('addControllerBtn').addEventListener('click', () => {


    if(getControllers().length) {


      showScreen('discoveryScreen');
      $('cancelDiscoveryBtn').style.display = 'inline-block';
    } else {


      showScreen('discoveryScreen');
    }
  });

  $('supportBtn').addEventListener('click', () => showScreen('supportScreen'));
};

// Bind event listeners for the feature options screen.
const bindFeatureOptionsScreen = () => {


  let searchTimeout = null;

  $('optionsSearch').addEventListener('input', () => {


    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => renderOptions(), 300);
  });

  $('clearSearchBtn').addEventListener('click', () => {


    $('optionsSearch').value = '';
    renderOptions();
  });

  $('scopeSelect').addEventListener('change', () => renderOptions());
  $('modifiedOnlyToggle').addEventListener('change', () => renderOptions());
  $('backFromOptionsBtn').addEventListener('click', () => {


    showScreen('controllersScreen');
    renderControllers();
  });
};

// Bind event listeners for the support screen.
const bindSupportScreen = () => {


  $('backFromSupportBtn').addEventListener('click', () => {


    showScreen('controllersScreen');
    renderControllers();
  });
};

// Initialize the plugin UI.
const init = async () => {

  // Confirm theme from Homebridge settings (overrides the early OS-preference detection)
  try {
    const settings = await homebridge.getUserSettings();
    const scheme = settings.colorScheme;
    if (scheme === 'dark' || scheme === 'light') {
      document.documentElement.dataset.bsTheme = scheme;
    } else if (scheme === 'auto') {
      document.documentElement.dataset.bsTheme =
        window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    // getUserSettings not available in older versions — keep the early-detected theme
  }

  bindDiscoveryScreen();
  bindSetupScreen();
  bindControllersScreen();
  bindFeatureOptionsScreen();
  bindSupportScreen();

  // Load plugin configuration.
  state.pluginConfig = await homebridge.getPluginConfig();

  if(!state.pluginConfig.length) {


    state.pluginConfig = [{ name: PLUGIN_NAME }];
    await homebridge.updatePluginConfig(state.pluginConfig);
  }

  state.pluginConfig[0].name ||= PLUGIN_NAME;

  // Show the right screen.
  if(getControllers().length) {


    showScreen('controllersScreen');
    renderControllers();
  } else {


    showScreen('discoveryScreen');
    $('cancelDiscoveryBtn').style.display = 'none';
  }
};

init();
