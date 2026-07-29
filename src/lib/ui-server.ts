/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ui-server.ts: Homebridge custom plugin UI server base class, compatible with the Homebridge UI IPC protocol.
 */
import process from 'node:process';

// An inbound IPC request from the Homebridge UI.
interface UiServerRequest {

  action: string;
  body?: unknown;
  path: string;
  requestId: number;
}

// A request handler error carrying an additional payload for the UI.
export class RequestError extends Error {

  public requestError: unknown;

  constructor(message: string, requestError?: unknown) {

    super(message);
    this.requestError = requestError;
  }
}

/**
 * Homebridge custom plugin UI server base class. This provides the API to facilitate two-way communication between a plugin's custom UI HTML code and the
 * server, implementing the same IPC protocol as the Homebridge UI expects from @homebridge/plugin-ui-utils. This is a base class and is intended to be
 * extended.
 */
export class HomebridgePluginUiServer {

  private handlers: { [path: string]: (payload: never) => unknown | Promise<unknown> };

  constructor() {

    this.handlers = {};

    // We can only operate as a child process of the Homebridge UI.
    if(!process.send) {

       
      console.error('This script can only run as a child process.');
      process.exit(1);
    }

    process.addListener('message', (request: UiServerRequest) => {

      switch(request.action) {

        case 'request':

          void this.processRequest(request);

          break;

        default:

          break;
      }
    });
  }

  // Return the Homebridge storage path.
  public get homebridgeStoragePath(): string | undefined {

    return process.env.HOMEBRIDGE_STORAGE_PATH;
  }

  // Return the path to the Homebridge config.json.
  public get homebridgeConfigPath(): string | undefined {

    return process.env.HOMEBRIDGE_CONFIG_PATH;
  }

  // Return the version of the Homebridge UI that spawned us.
  public get homebridgeUiVersion(): string | undefined {

    return process.env.HOMEBRIDGE_UI_VERSION;
  }

  // Send a response to a request back to the Homebridge UI.
  private sendResponse(request: UiServerRequest, data: unknown, success = true): void {

    process.send?.({

      action: 'response',
      payload: {

        data: data,
        requestId: request.requestId,
        success: success,
      },
    });
  }

  // Process an inbound request from the Homebridge UI, dispatching it to the registered handler for the request path.
  private async processRequest(request: UiServerRequest): Promise<void> {

    // No handler for this path - we're done.
    if(!this.handlers[request.path]) {

       
      console.error('No Registered Handler:', request.path);

      this.sendResponse(request, { message: 'Not Found', path: request.path }, false);

      return;
    }

    try {

       
      console.log('Incoming Request:', request.path);

      const response = await this.handlers[request.path]((request.body ?? {}) as never);

      this.sendResponse(request, response, true);
    } catch(error) {

      if(error instanceof RequestError) {

        this.sendResponse(request, { error: error.requestError, message: error.message }, false);

        return;
      }

       
      console.error(error);

      this.sendResponse(request, { message: error instanceof Error ? error.message : String(error) }, false);
    }
  }

  // Let the Homebridge UI know we're ready to receive requests. This must be called once your handlers are registered.
  public ready(): void {

    process.send?.({

      action: 'ready',
      payload: {

        server: true,
      },
    });
  }

  // Register a new request handler for a given route.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public onRequest(path: string, fn: (payload: any) => unknown | Promise<unknown>): void {

    this.handlers[path] = fn;
  }
}
