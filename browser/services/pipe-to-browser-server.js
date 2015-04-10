// Copyright 2015 The Vanadium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

/*
 * Implements and publishes a Veyron service which accepts streaming RPC
 * requests and delegates the stream back to the provided pipeRequestHandler.
 * It also exposes the state of the service.
 * @fileoverview
 */
import { Logger } from 'libs/logs/logger'
import { ByteObjectStreamAdapter } from 'libs/utils/byte-object-stream-adapter'
import { StreamByteCounter } from 'libs/utils/stream-byte-counter'
import { StreamCopy } from 'libs/utils/stream-copy'
import vanadium from 'vanadium'
import vdl from 'services/p2b/vdl/index'

var log = new Logger('services/p2b-server');
var server;

// State of p2b service
export var state = {
  init() {
    this.published = false;
    this.publishing = false;
    this.stopping = false;
    this.fullServiceName = null;
    this.date = null;
    this.numPipes = 0;
    this.numBytes = 0;
  },
  reset() {
    state.init();
  }
};
state.init();

/*
 * Publishes the p2b service under users/jane@google.com/chrome/p2b/{name} e.g. If
 * name is "john-tablet", p2b service will be accessible under name:
 * 'users/jane@google.com/chrome/p2b/john-tablet'
 *
 * pipe() method can be invoked on any
 * 'users/jane@google.com/chrome/p2b/{name}/suffix' name where suffix identifies the
 * viewer that can format and display the stream data e.g.
 * 'users/jane@google.com/chrome/p2b/john-tablet/console'.pipe() will display the
 * incoming data in a data table. See /app/viewer/ for a list of available
 * viewers.
 * @param {string} name Name to publish the service under
 * @param {function} pipeRequestHandler A function that will be called when
 * a request to handle a pipe stream comes in.
 * @return {Promise} Promise that will resolve or reject when publish completes
 */
export function publish(name, pipeRequestHandler) {
  log.debug('publishing under name:', name);

  /*
   * Veyron pipe to browser service implementation.
   * Implements the p2b VDL.
   */
  class Service extends vdl.Viewer {
    constructor() {
      super();
    }

    pipe(ctx, $stream) {
      return new Promise(function(resolve, reject) {
        log.debug('received pipe request for:', ctx.suffix);
        var numBytesForThisCall = 0;

        var bufferStream = new ByteObjectStreamAdapter();
        var streamByteCounter = new StreamByteCounter((numBytesRead) => {
          // increment total number of bytes received and total for this call
          numBytesForThisCall += numBytesRead;
          state.numBytes += numBytesRead;
        });

        var streamCopier = $stream.pipe(new StreamCopy());
        var stream = streamCopier.pipe(bufferStream).pipe(streamByteCounter);
        stream.copier = streamCopier;

        streamByteCounter.on('end', () => {
          log.debug('end of stream');
          // send total number of bytes received for this call as final result
          resolve();
        });

        stream.on('error', (e) => {
          log.debug('stream error', e);
          // TODO(aghassemi) envyor issue #50
          // we want to reject but because of #50 we can't
          // reject('Browser P2B threw an exception. Please see browser console for details.');
          // reject(e);
          resolve();
        });

        state.numPipes++;
        try {
          pipeRequestHandler(ctx.suffix, stream);
        } catch(e) {
          // TODO(aghassemi) envyor issue #50
          // we want to reject but because of #50 we can't
          // reject('Browser P2B threw an exception. Please see browser console for details.');
          log.debug('pipeRequestHandler error', e);
          resolve();
        }
      });
    }
  }

  var p2b = new Service();

  state.publishing = true;

  return vanadium.init().then((runtime) => {
    server = runtime.newServer();
    // we want to publish under users/email/ so we remove the dev dev.v.io/root/
    // from the account name.
    var nsPrefix = runtime.accountName.replace('dev.v.io/root/', '');
    var serviceName = vanadium.naming.join(nsPrefix, 'p2b', name);

    // TODO(aghassemi) For now we only allow p2b to talk to instances running
    // under the default authorizer
    var defaultAuthorizer = null;
    var options = {authorizer: defaultAuthorizer};

    return server.serve(serviceName, p2b, options).then(() => {
      log.debug('published!');

      state.published = true;
      state.publishing = false;
      state.fullServiceName = serviceName;
      state.date = new Date();

      return;
    });
  }).catch((err) => { state.reset(); throw err; });
}

/*
 * Stops the service and unpublishes it, effectively destroying the service.
 * @return {Promise} Promise that will resolve or reject when stopping completes
 */
export function stopPublishing() {
  log.debug('stopping service');
  state.stopping = true;
  return server.stop().then(function() {
    log.debug('service stopped');
    state.reset();
    return;
  });
}
