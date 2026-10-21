/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ui-option-state.test.ts: Tests for the webUI feature option counts shown in each category header.
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface Option {

  default: boolean;
  description: string;
  name: string;
}

interface Scope {

  device: null;
  id: string | null;
  type: string;
}

interface Stats {

  enabled: number;
  fraction: number;
  modified: number;
  total: number;
}

interface OptionStateModule {

  categoryStats: (categoryName: string, options: Option[], scope: Scope) => Stats;
}

interface StateModule {

  state: { pluginConfig: { options?: string[] }[] };
}

// The webUI modules are plain JavaScript without type declarations: import them through variable specifiers so the test typecheck does not need them.
const OPTION_STATE_MODULE = '../homebridge-ui/public/modules/feature-options/option-state.js';
const STATE_MODULE = '../homebridge-ui/public/modules/state.js';

let optionState: OptionStateModule;
let stateModule: StateModule;

beforeAll(async () => {

  optionState = await import(OPTION_STATE_MODULE) as OptionStateModule;
  stateModule = await import(STATE_MODULE) as StateModule;
});

const option = (name: string, enabled: boolean): Option => ({ default: enabled, description: name + ' option.', name });
const globalScope: Scope = { device: null, id: null, type: 'global' };

describe('categoryStats', () => {

  it('counts enabled and modified options against the options it is given', () => {

    stateModule.state.pluginConfig = [{ options: [ 'Enable.Video.Two', 'Disable.Video.Three' ] }];

    // The category has five options; the device and search leave three of them listed.
    const listed = [ option('One', true), option('Two', false), option('Three', true) ];
    const stats = optionState.categoryStats('Video', listed, globalScope);

    expect(stats).toEqual({ enabled: 2, fraction: 2 / 3, modified: 2, total: 3 });
  });

  it('reports an empty fraction when no option is listed', () => {

    stateModule.state.pluginConfig = [{ options: [] }];

    expect(optionState.categoryStats('Video', [], globalScope)).toEqual({ enabled: 0, fraction: 0, modified: 0, total: 0 });
  });
});
