/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * state.js: Application state management.
 */
export const state = {


  categories: [],
  currentControllerIndex: null,
  devices: [],
  editingIndex: null,
  openCategories: new Set(),
  options: {},
  pluginConfig: [],
  thirdPartyPanelOpen: false,
};

export const getControllers = () => state.pluginConfig[0]?.controllers || [];

export const saveConfig = async () => {


  await homebridge.updatePluginConfig(state.pluginConfig);
  await homebridge.savePluginConfig();
};

export const saveConfigSilent = async () => {


  await homebridge.updatePluginConfig(state.pluginConfig);
};
