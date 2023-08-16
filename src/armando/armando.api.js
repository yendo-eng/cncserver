/*
 * @file Holds all Remote Paint API extensions and related functions. Runs in
 * persistent global above modes in Armando proper whether the mode is enabled
 * or not! Be kind in this space, you can control almost everything, and the
 * APIs are undocumented wild-west territory.
 */

/* globals $, armando, cncserver, appMode, window */

// All Armando API state vars should be stored here
if (!armando.api) armando.api = {};

// Global remote print state and storage variables
armando.api.print = {
  enabled: true, // This allows for queueing without having the mode open
  ready: false, // We still require operator interaction to enable readiness.
  queue: [], // Array of Objects for actual queue
  requestOptions: {}, // Requested print settings for a new print queue item
  settingsOverrideWhitelist: [
    'autostrokeenabled',
    'strokeprecision',
    'strokeovershoot',
    'strokefills',
    'strokeinvisible',
    'autostrokeiteration',
    'autostrokeocclusion',
    'strokeocclusionfills',
    'strokeocclusionstoke',
    'strokeocclusioncolor',
    'strokeocclusionwater',
    'autostrokewidth',
    'strokeclosefilled',

    'autofillenabled',
    'filltype',
    'fillangle',
    'fillspacing',
    'fillprecision',
    'fillgroupingthresh',
    'fillhatch',
    'fillrandomize',
    'fillspiralalign',
    'autofilliteration',
    'autofillwidth',
    'fillocclusionfills'
  ],

  // Should be run any time a queue item is done. Clears the update interval and
  // sets the time taken.
  queueItemComplete: function(item) {
    // Clear the repeat interval that was (possibly) updating
    clearInterval(item.completionInterval);

    // Set endTime and elapsed with cancel OR completion.
    var d = new Date();
    item.endTime = d.toISOString();
    item.secondsTaken = (new Date(item.endTime) - new Date(item.startTime)) / 1e3;
  }
};

// When the subwindow has been (re)created.
$(armando).on('subwindowReady', function(){

  // Bind for client messages
  window.$subwindow[0].addEventListener('ipc-message', function(event){
    if (event.channel === 'remoteprint') {
      armando.api.print.fromMode.apply(undefined, event.args);
    }
  });
});


// Wrapper functions for managing mode level events/communication.
armando.api.print.fromMode = function(type, data){
  var queue = armando.api.print.queue;

  switch (type) {
    case "enable":
    case "disable":
      armando.api.print.enabled = (type === "enable");
      break;
    case "ready":
    case "notReady":
      armando.api.print.ready = (type === "ready");
      break;
    case "printingItem":
      // TODO: What else happens here?
      queue[data].status = 'printing';
      break;
    case "checkPercentageStart":
      // Happens after the item has actually started printing (autoPaintBegin);
      queue[data].percentComplete = 1;
      queue[data].completionInterval = setInterval(function(){
        queue[data].percentComplete = parseInt((parseInt($('progress').val()) / parseInt($('progress').attr('max'))) * 100);
        queue[data].printingStatus = $('#statusmessage').text();
      }, 1500);

      break;
    case "cancelledItem": // Operator cancelled queue Item (not from the API)
      queue[data].status = 'cancelled';
      armando.api.print.queueItemComplete(queue[data]);
      break;
    case "finishedItem":
      // TODO: What else happens here?
      queue[data].percentComplete = 100;
      queue[data].status = 'complete';

      armando.api.print.queueItemComplete(queue[data]);
      break;
    case "fullQueue":
      armando.api.print.pushToMode('fullQueue', queue);
      break;
  }
};

armando.api.print.pushToMode = function() {
  // Send to the mode, only if we're on remote print mode.
  if (appMode === 'remote') {
    window.$subwindow[0].send('remoteprint', arguments);
  }
};


// Function to bind the endpoints. Run right after this as mode loading of
// persistent scripts happens at the right time.
armando.api.print.endpointsBound = false
armando.api.print.bindCreateEndpoints = function(){
  if (armando.api.print.endpointsBound) return; // Only bind endpoints ONCE
  armando.api.print.endpointsBound = true;

  // Establish high-level print endpoints ======================================

  /**
   * `armando/v1/print` endpoint
   * GET - List print queue and current status
   * POST - Create new queue items to print
   */
  cncserver.createServerEndpoint('/armando/v1/print', function(req, res) {
    var queue = armando.api.print.queue;

    // Forbid change commands until printMode is enabled
    if (!armando.api.print.enabled && req.route.method != 'get') {
      return [403, armando.t('modes.remote.api.disabled')];
    }

    // Are we busy? Fill a quick var for reuse...
    var busy = false;
    if (queue.length) {
      busy = queue[queue.length-1].status == 'printing';
    }

    if (req.route.method == 'get') { // GET list of print queue items and status
      return {code: 200, body: {
        status: armando.api.print.enabled,
        ready: armando.api.print.ready,
        items: armando.api.print.queue.length,
        queue: (function(){
          var items = [];
          $.each(armando.api.print.queue, function(id, item){
            items.push({
              uri: '/armando/v1/print/' + id,
              name: item.options.name,
              status: item.status,
              percentComplete: item.percentComplete
            });
          });
          return items;
        })()
      }};
    } else if (req.route.method == 'post') { // POST new print item
      var options = req.body.options;

      // Allow for the ready state to be forced (only works if the mode opened)
      if (!options && typeof req.body.ready !== 'undefined') {
        if (appMode === 'remote') {
          armando.api.print.pushToMode('forceReady', !!req.body.ready);
          return [200, armando.t('modes.remote.api.readyset', {state: !!req.body.ready})];
        } else {
          return [503, armando.t('modes.remote.api.readyfail')];
        }
      }

      var msg = '';

      // Basic sanity check incoming content
      if (!req.body.svg) msg = "body content node required: svg";
      if (!req.body.options) {
        msg = 'body content node required: options';
      } else {
        if (!req.body.options.name) msg = 'name option required: options.name';
      }

      if (msg) return [406, msg];

      // TODO: Add back some kind of SVG verification?

      // Actually add item to queue
      var d = new Date();
      queue.push({
        status: 'waiting',
        options: options,
        pathCount: -1,
        percentComplete: 0,
        startTime: d.toISOString(),
        endTime: null,
        secondsTaken: null,
        svg: req.body.svg,
        printingStatus: armando.t('modes.remote.api.queued'),
        qid: queue.length,
        completionInterval: -1
      });

      // Alert the mode of the new queue item
      armando.api.print.pushToMode('itemAdded', queue[queue.length-1]);

      // Return response to client application
      return {
        code: 201,
        body: {
          status: 'verified and added to queue',
          id: (queue.length - 1),
          uri: '/armando/v1/print/' + (queue.length - 1),
          item: queue[queue.length - 1]
        }
      };
    } else {
      return false; // 405 - Method Not Supported
    }
  });

  /**
   * `armando/v1/print/[QID]` endpoint
   * GET - Return print queue item
   * DELETE - Cancel print queue item
   */
  cncserver.createServerEndpoint('/armando/v1/print/:qid', function(req, res) {
    var qid = req.params.qid;
    var item = armando.api.print.queue[qid];

    // Forbid change commands until printMode is enabled
    if (!armando.api.print.enabled && req.route.method != 'get') {
      return [403, armando.t('modes.remote.api.disabled')];
    }

    if (!item){
      return [404, 'Queue ID ' + qid + ' not found'];
    }

    if (req.route.method == 'get') { // Is this a GET request?
      return {code: 200, body: item};
    } else if (req.route.method == 'delete'){
      if (item.status == "waiting" || item.status == "printing") {
        item.status = 'cancelled';
        armando.api.print.queueItemComplete(item);
        armando.api.print.pushToMode('itemCancelled', qid);
        return {code: 200, body: armando.api.print.queue[qid]};
      } else {
        return [406, "Queue item in state '" + item.status + "' cannot be cancelled"];
      }
    } else {
      return false; // 405 - Method Not Supported
    }
  });

  /**
   * `/armando/remote/`
   * Static HTML endpoint for resources/api/
   */
  cncserver.createStaticEndpoint(
    '/armando/remote/',
    path.dirname(require.resolve('armando-mode-remote')) + '/api'
  );
};
armando.api.print.bindCreateEndpoints();
